import { logger } from './common';
import { executeMainManagementTool, initializeMainManagementTools, shutdownMainManagementTools, tool_create_child_session, tool_send_to_session } from './mainManagementTools';
import { callMcpTool, initializeMcpExternalService, listMcpServers, shutdownMcpExternalService } from './mcpExternalService';
import { copyBetweenNodes, executeRemoteNodeTool, initializeNodeExecution, listNodeTopology, shutdownNodeExecution, validateNodeSelection } from './nodeExecution';
import { deliverFile, initializeFileDelivery, shutdownFileDelivery } from './fileDelivery';
import { initializeSessionWorkerPublication, publishCommitted, shutdownSessionWorkerPublication } from './sessionWorkerPublication';
import { deliverCommittedFinal, initializeSessionTurnDelivery, shutdownSessionTurnDelivery } from './sessionTurnDelivery';
import * as llm from './llm';
import { initLlmRequestJournal } from './llmRequestJournal';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcServiceRegistry } from './rpc';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { initArchiveStore } from './session/archiveStore';
import { appendMessagesToArchive } from './session/archive';
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
  const failWrites = new Set(String(process.env.FOXWARM_TEST_FAIL_WRITE_AT || '').split(',').map(Number).filter(Boolean));
  const failReads = new Set(String(process.env.FOXWARM_TEST_FAIL_READ_AT || '').split(',').map(Number).filter(Boolean));
  let writeCount = 0; let readCount = 0; let initializeCount = 0; let chatCount = 0; let failedGoal = false; let backgroundExecStarted = false;
  (llm as any).chat = async (parts: any, session: any, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    if (process.env.FOXWARM_TEST_BACKGROUND_EXEC === '1' && !backgroundExecStarted && options?.purpose !== 'compact-plan') {
      backgroundExecStarted = true;
      const entry = await options.currentSessionEffects.execRuntime.startPersistentExec({
        command: 'sleep 3', sessionId: session.id, agentName: session.agent,
      });
      await options.currentSessionEffects.execRuntime.markExecForBackgroundNotification(entry.id);
    }
    // Cross-session hooks key on chatCount/session shape because the canonical
    // queue processor appends the user message itself; llm.chat receives no parts.
    const crossSession = String(process.env.FOXWARM_TEST_CROSS_SESSION || '');
    if (crossSession.includes('create-child') && chatCount === 1 && !session.id.endsWith('_mp-child')) {
      const result: any = await tool_create_child_session({ suffix: 'mp-child', message: 'hello child' }, { sessionId: session.id });
      await options.appendMessage({ role: 'model', parts: [{ text: `create-child-result: ${typeof result === 'string' ? result : result?.output}` }] });
    }
    if (crossSession.includes('reply') && chatCount === 1 && session.id.endsWith('_mp-child') && !session.id.endsWith('_mp-child_mp-child')) {
      const parentId = session.id.slice(0, -'_mp-child'.length);
      const result: any = await tool_send_to_session({ sessionId: parentId, message: 'child reply to parent' }, { sessionId: session.id });
      await options.appendMessage({ role: 'model', parts: [{ text: `reply-result: ${typeof result === 'string' ? result : result?.output}` }] });
    }
    if (crossSession.includes('query') && chatCount === 2 && !session.id.endsWith('_mp-child')) {
      const listOut = await executeMainManagementTool('session_list', {}, { sessionId: session.id });
      const childId = `${session.id}_mp-child`;
      const msgsOut = await executeMainManagementTool('get_session_messages', { sessionId: childId, count: 20 }, { sessionId: session.id });
      await options.appendMessage({ role: 'model', parts: [{ text: `list-output: ${listOut}\nmessages-output: ${msgsOut}` }] });
    }
    if (options?.purpose === 'compact-plan' && process.env.FOXWARM_TEST_COMPACT_PLAN) {
      return { toolCalls: [{ name: COMPACT_PLAN_TOOL_NAME, args: JSON.parse(process.env.FOXWARM_TEST_COMPACT_PLAN) }] };
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
    await options.appendMessage({ role: 'model', parts: [{ text: 'deterministic child answer' }] });
    return { text: 'deterministic child answer' };
  };

  const store = new SessionWorkerStore(storePath); store.open();
  const identity = { sessionId, generation, incarnationId, pid: process.pid, processIdentity };
  const gate = new SessionWorkerActivationGate();
  const reverseTransport = new ProcessRpcClientTransport(process, { generation, direction: 'reverse' });
  await reverseTransport.waitUntilReady();
  await initializeMainManagementTools({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeNodeExecution({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeFileDelivery({ transport: reverseTransport, placement: 'child-reverse' });
  await initializeSessionTurnDelivery(reverseTransport);
  await initializeSessionWorkerPublication({ transport: reverseTransport, identity });
  await initializeMcpExternalService({ transport: reverseTransport, placement: 'child-reverse' });
  await vector.init({ transport: reverseTransport, placement: 'child-reverse' });
  const host = new SessionWorkerHost(identity, store, {
    publishCommitted: projection => publishCommitted(identity, projection),
    deliverCommittedFinal: (source, text, outcome) => deliverCommittedFinal({ sourceSessionId: sessionId, source, text, outcome }).then(() => {}),
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
        if (seed?.history?.length) { seed.id = sessionId; seed.agent ||= 'main'; await appendMessagesToArchive(seed as any, seed.history); }
      }
    },
  });
  const registry = new RpcServiceRegistry();
  registry.register(sessionWorkerControlServiceDescriptor, createSessionWorkerControlServiceHandler(
    identity,
    () => { store.verifyActivatedIncarnation(sessionId, generation, incarnationId, process.pid, processIdentity); },
    gate,
  ));
  registry.register(sessionWorkerRuntimeServiceDescriptor, createSessionWorkerRuntimeServiceHandler(gate, host));
  new ProcessRpcServer(registry, { generation, exitOnDrain: true, onDrain: async () => {
    await Promise.allSettled([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownFileDelivery(), shutdownSessionTurnDelivery(), shutdownSessionWorkerPublication(), shutdownMcpExternalService(), vector.shutdown()]);
    await reverseTransport.drain(); reverseTransport.close(); store.close();
  } }).start();
}

void start().catch(error => {
  logger.error({ err: error }, 'Session worker runtime test child failed');
  process.exitCode = 1;
  process.disconnect?.();
});
