import { logger } from './common';
import { initializeMainManagementTools, shutdownMainManagementTools } from './mainManagementTools';
import { callMcpTool, initializeMcpExternalService, listMcpServers, shutdownMcpExternalService } from './mcpExternalService';
import { executeRemoteNodeTool, initializeNodeExecution, shutdownNodeExecution } from './nodeExecution';
import * as llm from './llm';
import { initLlmRequestJournal } from './llmRequestJournal';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcServiceRegistry } from './rpc';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { initArchiveStore } from './session/archiveStore';
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

async function start(): Promise<void> {
  const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID!;
  const incarnationId = process.env.FOXWARM_SESSION_WORKER_INCARNATION_ID!;
  const storePath = process.env.FOXWARM_SESSION_WORKER_STORE_PATH!;
  const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION);
  const processIdentity = readSessionWorkerProcessIdentity(process.pid)!;
  const failWrites = new Set(String(process.env.FOXWARM_TEST_FAIL_WRITE_AT || '').split(',').map(Number).filter(Boolean));
  const failReads = new Set(String(process.env.FOXWARM_TEST_FAIL_READ_AT || '').split(',').map(Number).filter(Boolean));
  let writeCount = 0; let readCount = 0; let initializeCount = 0; let chatCount = 0; let failedGoal = false;
  (llm as any).chat = async (parts: any, session: any, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
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
        try { await listMcpServers('wrong-source'); }
        catch (error: any) { fenceErrors.push(error?.code); }
        const nodeResult = await executeRemoteNodeTool(session.id, 'reverse-node', 'read', { filePath: 'reverse.txt' },
          { currentNode: 'reverse-node', cwd: '/worker-cwd' });
        const servers = await listMcpServers(session.id);
        const mcpResult = await callMcpTool(session.id, 'reverse-mcp', 'echo', { value: 7 });
        const vectorResult = await vector.search('reverse vector query', 2, false, { sessionIds: [session.id] });
        const loadedLocalVectorOwner = Object.keys(require.cache).some(file => /vector(Runtime|ServiceManager)\.js$/.test(file));
        await options.appendMessage({ role: 'model', parts: [{ text: JSON.stringify({ fenceErrors, nodeResult, servers, mcpResult, vectorResult, loadedLocalVectorOwner }) }] });
        return { text: 'reverse external services complete' };
      }
      await options.appendMessage({ role: 'model', parts: [{ text: 'reverse wait scheduled' }] });
      return { text: 'reverse wait scheduled' };
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
  await initializeMcpExternalService({ transport: reverseTransport, placement: 'child-reverse' });
  await vector.init({ transport: reverseTransport, placement: 'child-reverse' });
  const host = new SessionWorkerHost(identity, store, {
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
    await Promise.allSettled([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownMcpExternalService(), vector.shutdown()]);
    await reverseTransport.drain(); reverseTransport.close(); store.close();
  } }).start();
}

void start().catch(error => {
  logger.error({ err: error }, 'Session worker runtime test child failed');
  process.exitCode = 1;
  process.disconnect?.();
});
