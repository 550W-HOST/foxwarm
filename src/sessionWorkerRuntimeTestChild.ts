import { logger } from './common';
import * as llm from './llm';
import { ProcessRpcServer, RpcServiceRegistry } from './rpc';
import { writeAuthoritativeSessionState } from './session/stateFile';
import {
  createSessionWorkerControlServiceHandler,
  SessionWorkerActivationGate,
  sessionWorkerControlServiceDescriptor,
} from './sessionWorkerControlService';
import { SessionWorkerHost } from './sessionWorkerHost';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { createSessionWorkerRuntimeServiceHandler, sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { SessionWorkerStore } from './sessionWorkerStore';

async function start(): Promise<void> {
  const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID!;
  const incarnationId = process.env.FOXWARM_SESSION_WORKER_INCARNATION_ID!;
  const storePath = process.env.FOXWARM_SESSION_WORKER_STORE_PATH!;
  const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION);
  const processIdentity = readSessionWorkerProcessIdentity(process.pid)!;
  const failWriteAt = Number(process.env.FOXWARM_TEST_FAIL_WRITE_AT || 0);
  let writeCount = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'deterministic child answer' }] });
    return { text: 'deterministic child answer' };
  };

  const store = new SessionWorkerStore(storePath); store.open();
  const identity = { sessionId, generation, incarnationId, pid: process.pid, processIdentity };
  const gate = new SessionWorkerActivationGate();
  const host = new SessionWorkerHost(identity, store, {
    persistence: {
      writeState: async session => {
        writeCount += 1;
        if (writeCount === failWriteAt) throw new Error(`test write failure ${writeCount}`);
        await writeAuthoritativeSessionState(session);
      },
    },
  });
  const registry = new RpcServiceRegistry();
  registry.register(sessionWorkerControlServiceDescriptor, createSessionWorkerControlServiceHandler(
    identity,
    () => { store.verifyActivatedIncarnation(sessionId, generation, incarnationId, process.pid, processIdentity); },
    gate,
  ));
  registry.register(sessionWorkerRuntimeServiceDescriptor, createSessionWorkerRuntimeServiceHandler(gate, host));
  new ProcessRpcServer(registry, { generation, exitOnDrain: true, onDrain: () => store.close() }).start();
}

void start().catch(error => {
  logger.error({ err: error }, 'Session worker runtime test child failed');
  process.exitCode = 1;
  process.disconnect?.();
});
