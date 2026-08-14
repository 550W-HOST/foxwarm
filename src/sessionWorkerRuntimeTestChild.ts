import fs from 'fs-extra';
import path from 'node:path';
import axios from 'axios';
import { logger } from './common';
import { STATE_DIR } from './config';
import { executeMainManagementTool, initializeMainManagementTools, shutdownMainManagementTools } from './mainManagementTools';
import { callMcpTool, initializeMcpExternalService, listMcpServers, shutdownMcpExternalService } from './mcpExternalService';
import { copyBetweenNodes, executeRemoteNodeTool, initializeNodeExecution, listNodeTopology, shutdownNodeExecution, validateNodeSelection } from './nodeExecution';
import { deliverFile, initializeFileDelivery, shutdownFileDelivery } from './fileDelivery';
import { initializeSessionWorkerPresentation, publishPresentationMessage, publishPresentationModelStream } from './sessionWorkerPresentation';
import { initializeSessionWorkerPublication, publishCommitted, shutdownSessionWorkerPublication } from './sessionWorkerPublication';
import { deliverCommittedFinal, deliverIntermediateText, initializeSessionTurnDelivery, shutdownSessionTurnDelivery } from './sessionTurnDelivery';
import * as llm from './llm';
import { initLlmRequestJournal } from './llmRequestJournal';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcError, RpcServiceRegistry } from './rpc';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { initArchiveStore } from './session/archiveStore';
import { appendMessagesToArchive, readArchiveMessagesBySeqRange } from './session/archive';
import { COMPACT_PLAN_TOOL_NAME } from './session/compactPlan';
import {
  createSessionWorkerControlServiceHandler,
  SessionWorkerActivationGate,
  sessionWorkerControlServiceDescriptor,
} from './sessionWorkerControlService';
import { SessionWorkerHost } from './sessionWorkerHost';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { createSessionWorkerRuntimeServiceHandler, sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { SessionWorkerStore } from './sessionWorkerStore';
import { tool_set_goal } from './toolsSessionAgent/settings';
import { tool_wait } from './toolsSessionAgent/interSession';
import * as vector from './vector';
import { tool_call_tool } from './tools/unifiedSearch';
import { shutdownToolScriptRuntime } from './toolscript';

async function start(): Promise<void> {
  const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID!;
  const incarnationId = process.env.FOXWARM_SESSION_WORKER_INCARNATION_ID!;
  const storePath = process.env.FOXWARM_SESSION_WORKER_STORE_PATH!;
  const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION);
  // Simulate a child that dies inside the activation window, before it can
  // answer the candidate status RPC (ownership still 'candidate' in Main).
  if (process.env.FOXWARM_TEST_CRASH_GENERATION === String(generation)) {
    // Stay alive long enough for Main's process-identity read, then die before
    // the RPC server starts so the candidate status RPC is never answered.
    await new Promise(resolve => setTimeout(resolve, 150));
    process.exit(1);
  }
  const processIdentity = readSessionWorkerProcessIdentity(process.pid)!;
  // Mock-axios mode: keep the REAL llm.chat path (model resolution, request
  // plan, journal, request logging, HTTP dispatch, response parsing) and stub
  // only the network boundary, so tests cover the full pre-HTTP pipeline. Each
  // dispatch writes a marker file proving the request actually fired.
  if (process.env.FOXWARM_TEST_MOCK_AXIOS === '1') {
    let mockCalls = 0;
    (axios as any).post = async (url: string, _body: any, config: any) => {
      mockCalls += 1;
      await fs.writeFile(path.join(STATE_DIR, `axios-mock-${mockCalls}`), String(url));
      if (config?.responseType === 'stream') {
        const { Readable } = await import('node:stream');
        return {
          status: 200,
          data: Readable.from([
            'data: {"choices":[{"delta":{"role":"assistant","content":"mock axios answer"}}]}\n\n',
            'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
            'data: [DONE]\n\n',
          ]),
        };
      }
      return {
        status: 200,
        data: {
          choices: [{ message: { role: 'assistant', content: 'mock axios answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      };
    };
  }
  const failWrites = new Set(String(process.env.FOXWARM_TEST_FAIL_WRITE_AT || '').split(',').map(Number).filter(Boolean));
  const failReads = new Set(String(process.env.FOXWARM_TEST_FAIL_READ_AT || '').split(',').map(Number).filter(Boolean));
  let writeCount = 0; let readCount = 0; let initializeCount = 0; let chatCount = 0; let failedGoal = false; let backgroundExecStarted = false;
  if (process.env.FOXWARM_TEST_MOCK_AXIOS !== '1') (llm as any).chat = async (parts: any, session: any, _iteration: number, options: any) => {
    chatCount += 1;
    if (options?.purpose === 'btw') {
      const requestText = Array.isArray(parts) ? parts.map((part: any) => part?.text || '').join(' ') : '';
      const marker = requestText.includes('hold-busy') ? 'busy'
        : requestText.includes('hold-idle') ? 'idle'
          : requestText.includes('tool-deny') ? 'tool'
            : requestText.includes('provider-error') ? 'error'
              : 'normal';
      await fs.writeJson(path.join(STATE_DIR, `btw-started-${marker}-${session.id}.json`), {
        history: session.history,
        promptCacheKey: session.promptCacheKey,
        requestParts: parts,
        purpose: options.purpose,
        notifySessionEvents: options.notifySessionEvents,
        registerAbortController: options.registerAbortController,
        hasCurrentSessionEffects: !!options.currentSessionEffects,
      });
      if (marker === 'busy' || marker === 'idle') {
        const releasePath = path.join(STATE_DIR, `btw-release-${marker}-${session.id}`);
        while (!await fs.pathExists(releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (marker === 'error') throw new Error('deterministic BTW provider failure');
      if (parts) await options.appendMessage({ role: 'user', parts });
      if (marker === 'tool') {
        const call = { id: 'btw-tool-denied', name: 'exec', args: { command: 'false' } };
        await options.appendMessage({ role: 'model', parts: [{ functionCall: call }] });
        return { toolCalls: [call], allParts: [{ functionCall: call }] };
      }
      await options.appendMessage({ role: 'model', parts: [{ text: `deterministic BTW ${marker} answer` }] });
      return {
        text: `deterministic BTW ${marker} answer`,
        modelId: 'test/btw-model',
        virtualModelKey: 'test-btw-route',
        allParts: [{ text: `deterministic BTW ${marker} answer` }],
      };
    }
    if (parts) await options.appendMessage({ role: 'user', parts });
    if (process.env.FOXWARM_TEST_BACKGROUND_EXEC === '1' && !backgroundExecStarted && options?.purpose !== 'compact-plan') {
      backgroundExecStarted = true;
      const entry = await options.currentSessionEffects.execRuntime.startPersistentExec({
        command: 'sleep 3', sessionId: session.id, agentName: session.agent,
      });
      await options.currentSessionEffects.execRuntime.markExecForBackgroundNotification(entry.id);
    }
    // Cross-session hooks key on chatCount/session shape because the canonical
    // queue processor appends the user message itself; llm.chat receives no
    // parts. They emit real tool calls so the canonical tool loop exercises the
    // facade handoff-wait post-action path (waitAfterHandoff arms the wait).
    const crossSession = String(process.env.FOXWARM_TEST_CROSS_SESSION || '');
    const mainToolsBySession = process.env.FOXWARM_TEST_MAIN_TOOLS_BY_SESSION
      ? JSON.parse(process.env.FOXWARM_TEST_MAIN_TOOLS_BY_SESSION)
      : undefined;
    const configuredMainTools = mainToolsBySession?.[session.id]
      || (process.env.FOXWARM_TEST_MAIN_TOOLS
        && (!process.env.FOXWARM_TEST_MAIN_TOOLS_SESSION || session.id === process.env.FOXWARM_TEST_MAIN_TOOLS_SESSION)
        ? JSON.parse(process.env.FOXWARM_TEST_MAIN_TOOLS)
        : undefined);
    if (configuredMainTools && chatCount === 1) {
      return { toolCalls: configuredMainTools };
    }
    if (crossSession.includes('create-child') && chatCount === 1 && !session.id.endsWith('_mp-child')) {
      return { toolCalls: [{ name: 'create_child_session', args: { suffix: 'mp-child', message: 'hello child', waitAfterHandoff: true } }] };
    }
    if (crossSession.includes('reply') && chatCount === 1 && session.id.endsWith('_mp-child') && !session.id.endsWith('_mp-child_mp-child')) {
      const parentId = session.id.slice(0, -'_mp-child'.length);
      return { toolCalls: [{ name: 'send_to_session', args: { sessionId: parentId, message: 'child reply to parent' } }] };
    }
    if (crossSession.includes('query') && chatCount === 3 && !session.id.endsWith('_mp-child')) {
      const listOut = await executeMainManagementTool('session_list', {}, { sessionId: session.id });
      const childId = `${session.id}_mp-child`;
      const msgsOut = await executeMainManagementTool('get_session_messages', { sessionId: childId, count: 20 }, { sessionId: session.id });
      await options.appendMessage({ role: 'model', parts: [{ text: `list-output: ${listOut}\nmessages-output: ${msgsOut}` }] });
    }
    // Simulates a wedged/mid-turn incarnation: generation 1's first turn
    // registers an in-flight abort controller (like a real provider request)
    // and never returns.
    if (process.env.FOXWARM_TEST_HANG_TURN === '1' && session.id === String(process.env.FOXWARM_TEST_HANG_SESSION || '')
      && process.env.FOXWARM_SESSION_WORKER_GENERATION === '1' && chatCount === 1) {
      const controller = new AbortController();
      options.currentSessionEffects.registerAbortController(session.id, controller);
      try {
        await fs.writeFile(path.join(STATE_DIR, `hang-started-${process.env.FOXWARM_SESSION_WORKER_SESSION_ID}`), '1');
        await new Promise(() => {});
      } finally { options.currentSessionEffects.clearAbortController(session.id, controller); }
    }
    // Emits presentation model-stream deltas like a real streaming turn, for
    // coalesce/forward coverage (rapid frames should collapse per streamId).
    if (process.env.FOXWARM_TEST_STREAM_DELTAS === '1' && chatCount === Number(process.env.FOXWARM_TEST_STREAM_DELTAS_AT || '1')) {
      for (const text of ['partial-1', 'partial-2', 'partial-3']) {
        options.currentSessionEffects.notifySessionEvent(session.id, { type: 'model-stream-update', streamId: 'test-stream', iteration: 0, reasoning: '', text, toolCalls: [] } as any);
      }
      options.currentSessionEffects.notifySessionEvent(session.id, { type: 'model-stream-reset', streamId: 'test-stream', iteration: 0 } as any);
    }
    // Production-shaped ordering regression: requestLlmOnce flushes a final
    // cumulative OpenAI-completions-like frame immediately before chat()
    // commits the canonical model reasoning/function-call row. The Worker
    // presentation coalescer must not deliver that frame after the row.
    if (process.env.FOXWARM_TEST_STREAM_COMMITTED_TOOL === '1'
      && chatCount === Number(process.env.FOXWARM_TEST_STREAM_COMMITTED_TOOL_AT || '1')) {
      const call = { id: 'worker-stream-exec', name: 'exec', args: { command: 'printf worker-stream-order' } };
      options.currentSessionEffects.notifySessionEvent(session.id, {
        type: 'model-stream-update', streamId: 'committed-tool-stream', iteration: 0,
        reasoning: 'Starting the process', text: '', toolCalls: [{ index: 0, id: call.id, name: call.name }],
      } as any);
      await options.appendMessage({ role: 'model', parts: [{ thinking: 'Starting the process' }, { functionCall: call }] });
      return { toolCalls: [call], allParts: [{ thinking: 'Starting the process' }, { functionCall: call }] };
    }
    // Simulates a slow provider request that honors its abort signal, like the
    // real runner: the controller is registered for the in-flight request and
    // the request rejects AbortError when interrupted.
    if (process.env.FOXWARM_TEST_SLOW_PROVIDER === '1' && session.id === String(process.env.FOXWARM_TEST_SLOW_SESSION || '') && chatCount === 1) {
      const controller = new AbortController();
      options.currentSessionEffects.registerAbortController(session.id, controller);
      try {
        await fs.writeFile(path.join(STATE_DIR, `slow-started-${session.id}`), '1');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        });
      } finally { options.currentSessionEffects.clearAbortController(session.id, controller); }
    }
    if (process.env.FOXWARM_TEST_HOLD_PROVIDER === '1'
      && session.id === String(process.env.FOXWARM_TEST_HOLD_SESSION || '') && chatCount === 1) {
      const startedPath = path.join(STATE_DIR, `hold-started-${session.id}`);
      const releasePath = path.join(STATE_DIR, `hold-release-${session.id}`);
      await fs.writeFile(startedPath, '1');
      while (!await fs.pathExists(releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (options?.purpose === 'compact-plan' && process.env.FOXWARM_TEST_COMPACT_PLAN) {
      return { toolCalls: [{ name: COMPACT_PLAN_TOOL_NAME, args: JSON.parse(process.env.FOXWARM_TEST_COMPACT_PLAN) }] };
    }
    if (process.env.FOXWARM_TEST_CHILD_REMINDER_NO_ACTION === '1' && chatCount > 1) {
      await options.appendMessage({ role: 'model', parts: [{ text: '[NO_ACTION]' }] });
      return { text: '[NO_ACTION]' };
    }
    if (process.env.FOXWARM_TEST_ECHO_CATALOG_FIELDS === '1') {
      const text = `catalog parent=${session.parentSessionId || ''} display=${session.displayName || ''}`;
      await options.appendMessage({ role: 'model', parts: [{ text }] });
      return { text };
    }
    if (process.env.FOXWARM_TEST_FAIL_GOAL === '1' && chatCount === 2) {
      try {
        await tool_set_goal(
          { goal: 'must-not-commit', remindEvery: 2 },
          { sessionId: session.id, session, persistCurrentSession: () => options.currentSessionEffects.persistSession(session) } as any,
        );
      } catch (error: any) {
        await options.appendMessage({ role: 'model', parts: [{ text: `reported tool failure: ${error.message}` }] });
        return { text: 'reported tool failure' };
      }
    }
    if (process.env.FOXWARM_TEST_WAIT_TOOL === '1' && chatCount === 3) {
      await tool_wait(
        { reason: 'reverse wait', timeoutSeconds: 30 },
        { sessionId: session.id, session, persistCurrentSession: () => options.currentSessionEffects.persistSession(session) } as any,
      );
      if (process.env.FOXWARM_TEST_EXTERNAL_REVERSE === '1') {
        const fenceErrors: string[] = [];
        try { await executeRemoteNodeTool('wrong-source', 'reverse-node', 'read', {}); }
        catch (error: any) { fenceErrors.push(error?.code); }
        try { await listNodeTopology('wrong-source'); }
        catch (error: any) { fenceErrors.push(error?.code); }
        try { await deliverFile({ sourceSessionId: 'wrong-source', intent: { filePath: 'x' }, routing: { runtimeNodeId: 'master', currentNode: 'master' } }); }
        catch (error: any) { fenceErrors.push(error?.code); }
        try { await deliverCommittedFinal({ sourceSessionId: 'wrong-source', source: { platform: 'test', channelUserId: 'conversation' }, outcome: 'response', text: 'wrong' }); }
        catch (error: any) { fenceErrors.push(error?.code); }
        try { await listMcpServers('wrong-source'); }
        catch (error: any) { fenceErrors.push(error?.code); }
        const nodeResult = await tool_call_tool({ source: 'node', nodeId: 'reverse-node', name: 'read', args: { filePath: 'reverse.txt' } },
          { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: () => options.currentSessionEffects.persistSession(session) } as any);
        const topology = await listNodeTopology(session.id);
        const selected = await validateNodeSelection(session.id, 'reverse-node');
        const copied = await copyBetweenNodes(session.id, { sourceNode: 'master', sourcePath: 'from.txt', targetNode: 'reverse-node', targetPath: 'to.txt' });
        const workerCtx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: () => options.currentSessionEffects.persistSession(session) };
        const sendWebui = await tool_call_tool({ source: 'builtin', name: 'send_file', args: { filePath: 'worker-send.txt', channelTargetId: 'webui:room' } }, workerCtx);
        const sendSession = await tool_call_tool({ source: 'builtin', name: 'send_file', args: { filePath: 'remote.txt', node: 'reverse-node', sessionId: session.id } }, workerCtx);
        const sendChannel = await tool_call_tool({ source: 'builtin', name: 'send_file', args: { filePath: 'worker-send.txt', channelTargetId: 'telegram:room' } }, workerCtx);
        const selectedTool = await tool_call_tool({ source: 'builtin', name: 'node', args: { action: 'select', nodeId: 'reverse-node' } }, workerCtx);
        const servers = await listMcpServers(session.id);
        const mcpResult = await callMcpTool(session.id, 'reverse-mcp', 'echo', { value: 7 });
        const vectorResult = await vector.search('reverse vector query', 2, false, { sessionIds: [session.id] });
        const loadedLocalVectorOwner = Object.keys(require.cache).some(file => /vector(Runtime|ServiceManager)\.js$/.test(file));
        await options.appendMessage({ role: 'model', parts: [{ text: JSON.stringify({ fenceErrors, nodeResult, topology, selected, copied, sendWebui, sendSession, sendChannel, selectedTool, servers, mcpResult, vectorResult, loadedLocalVectorOwner }) }] });
        return { text: 'reverse external services complete' };
      }
      await options.appendMessage({ role: 'model', parts: [{ text: 'reverse wait scheduled' }] });
      return { text: 'reverse wait scheduled' };
    }
    if (process.env.FOXWARM_TEST_PUBLICATION_TOOL === '1' && chatCount === 4) {
      try {
        await tool_set_goal({ goal: 'committed-before-publication-loss', remindEvery: 2 },
          { sessionId: session.id, session, persistCurrentSession: () => options.currentSessionEffects.persistSession(session) } as any);
      } catch (error: any) {
        await options.appendMessage({ role: 'model', parts: [{ text: `folded publication failure: ${error.message}` }] });
      }
    }
    if (process.env.FOXWARM_TEST_NATIVE_TOOLSCRIPT === '1' && chatCount === 1) {
      const call = {
        id: 'native-worker-toolscript',
        name: 'run_script',
        args: { code: 'def main(args):\n    print("native worker lifecycle")\n    return {"ok": True}', mode: 'foreground' },
      };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: call }] });
      return { toolCalls: [call] };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'deterministic child answer' }] });
    return {
      text: 'deterministic child answer',
      ...(process.env.FOXWARM_TEST_FORCE_USAGE === '1'
        ? { usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 } }
        : {}),
    };
  };

  const store = new SessionWorkerStore(storePath); store.open();
  const identity = { sessionId, generation, incarnationId, pid: process.pid, processIdentity };
  let catalogStub: any;
  try { catalogStub = JSON.parse(process.env.FOXWARM_SESSION_WORKER_CATALOG_STUB || '{}'); }
  catch { throw new Error('Session worker catalog stub is invalid JSON.'); }
  const gate = new SessionWorkerActivationGate();
  const reverseTransport = new ProcessRpcClientTransport(process, { generation, direction: 'reverse' });
  await reverseTransport.waitUntilReady();
  await initializeMainManagementTools({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeNodeExecution({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeFileDelivery({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeSessionTurnDelivery(reverseTransport);
  await initializeSessionWorkerPublication({ transport: reverseTransport, identity });
  await initializeSessionWorkerPresentation({ transport: reverseTransport });
  await initializeMcpExternalService({ transport: reverseTransport, placement: 'child-reverse' });
  await vector.init({ transport: reverseTransport, placement: 'child-reverse' });
  const host = new SessionWorkerHost(identity, store, {
    catalogStub,
    publishCommitted: projection => publishCommitted(identity, projection),
    deliverIntermediateText: (source, text) => deliverIntermediateText({ sourceSessionId: sessionId, source, text }).then(() => {}),
    deliverCommittedFinal: (source, text, outcome) => deliverCommittedFinal({ sourceSessionId: sessionId, source, text, outcome }).then(() => {}),
    publishPresentationMessage: message => publishPresentationMessage(identity, message),
    publishPresentationStream: event => publishPresentationModelStream(identity, event),
    persistence: {
      readState: async id => {
        readCount += 1;
        if (failReads.delete(readCount)) throw new Error(`test read failure ${readCount}`);
        return readSessionHistorySnapshot(id);
      },
      writeState: async session => {
        writeCount += 1;
        if (process.env.FOXWARM_TEST_FAIL_GOAL === '1' && !failedGoal && session.goalState?.goal === 'must-not-commit') {
          failedGoal = true;
          throw new Error('test goal persistence failure');
        }
        if (failWrites.delete(writeCount)) throw new Error(`test write failure ${writeCount}`);
        await writeAuthoritativeSessionState(session);
      },
    },
    initialize: async () => {
      initializeCount += 1;
      if (process.env.FOXWARM_TEST_INIT_FAIL_ONCE === '1' && initializeCount === 1) throw new Error('test transient init failure');
      await Promise.all([initArchiveStore(), initLlmRequestJournal()]);
      if (process.env.FOXWARM_TEST_SEED_ARCHIVE === '1') {
        const seed = await readSessionHistorySnapshot(sessionId);
        if (seed?.history?.length) {
          seed.id = sessionId; seed.agent ||= 'main';
          const existing = await readArchiveMessagesBySeqRange(sessionId);
          if (existing.length === 0) await appendMessagesToArchive(seed as any, seed.history);
        }
      }
    },
  });
  const registry = new RpcServiceRegistry();
  registry.register(sessionWorkerControlServiceDescriptor, createSessionWorkerControlServiceHandler(
    identity,
    () => { store.verifyActivatedIncarnation(sessionId, generation, incarnationId, process.pid, processIdentity); },
    gate,
  ));
  registry.register(sessionWorkerRuntimeServiceDescriptor, createSessionWorkerRuntimeServiceHandler(gate, host, {
    ...(process.env.FOXWARM_TEST_REJECT_RETRY_CODE ? {
      beforeRetry: () => { throw new RpcError(process.env.FOXWARM_TEST_REJECT_RETRY_CODE!, 'injected retry handler rejection', true); },
    } : {}),
    ...(process.env.FOXWARM_TEST_DROP_RETRY_RESPONSE_AFTER_COMMIT === '1' ? {
      afterRetryBeforeResponse: async () => { process.disconnect?.(); await new Promise(resolve => setTimeout(resolve, 25)); },
    } : {}),
  }));
  new ProcessRpcServer(registry, { generation, exitOnDrain: true, onDrain: async () => {
    await shutdownToolScriptRuntime();
    await Promise.allSettled([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownFileDelivery(), shutdownSessionTurnDelivery(), shutdownSessionWorkerPublication(), shutdownMcpExternalService(), vector.shutdown()]);
    await reverseTransport.drain(); reverseTransport.close(); store.close();
  } }).start();
}

void start().catch(error => {
  logger.error({ err: error }, 'Session worker runtime test child failed');
  process.exitCode = 1;
  process.disconnect?.();
});
