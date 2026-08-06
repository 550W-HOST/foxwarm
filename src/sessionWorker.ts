import { logger } from './common';
import { initializeMainManagementTools, shutdownMainManagementTools } from './mainManagementTools';
import { initializeMcpExternalService, shutdownMcpExternalService } from './mcpExternalService';
import { initializeNodeExecution, shutdownNodeExecution } from './nodeExecution';
import { initializeFileDelivery, shutdownFileDelivery } from './fileDelivery';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcServiceRegistry } from './rpc';
import {
  createSessionWorkerControlServiceHandler,
  SessionWorkerActivationGate,
  sessionWorkerControlServiceDescriptor,
} from './sessionWorkerControlService';
import { SessionWorkerHost } from './sessionWorkerHost';
import { createSessionWorkerRuntimeServiceHandler, sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerStore } from './sessionWorkerStore';
import * as vector from './vector';

async function start(): Promise<void> {
  const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID || '';
  const incarnationId = process.env.FOXWARM_SESSION_WORKER_INCARNATION_ID || '';
  const storePath = process.env.FOXWARM_SESSION_WORKER_STORE_PATH || '';
  const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION || 0);
  const processIdentity = readSessionWorkerProcessIdentity(process.pid);
  if (!sessionId || !incarnationId || !storePath || !processIdentity
    || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Session worker requires session, incarnation, store, and positive generation identity.');
  }

  const store = new SessionWorkerStore(storePath);
  store.open();
  const identity = { sessionId, generation, incarnationId, pid: process.pid, processIdentity };
  const gate = new SessionWorkerActivationGate();
  const host = new SessionWorkerHost(identity, store);
  const reverseTransport = new ProcessRpcClientTransport(process, { generation, direction: 'reverse' });
  await reverseTransport.waitUntilReady();
  try {
    await initializeMainManagementTools({ transport: reverseTransport, placement: 'child-reverse' });
    await initializeNodeExecution({ transport: reverseTransport, placement: 'child-reverse' });
    await initializeFileDelivery({ transport: reverseTransport, placement: 'child-reverse' });
    await initializeMcpExternalService({ transport: reverseTransport, placement: 'child-reverse' });
    await vector.init({ transport: reverseTransport, placement: 'child-reverse' });
  } catch (error) {
    await Promise.allSettled([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownFileDelivery(), shutdownMcpExternalService(), vector.shutdown()]);
    reverseTransport.close(); store.close(); throw error;
  }
  const registry = new RpcServiceRegistry();
  registry.register(
    sessionWorkerControlServiceDescriptor,
    createSessionWorkerControlServiceHandler(identity, () => {
      store.verifyActivatedIncarnation(sessionId, generation, incarnationId, process.pid, processIdentity);
    }, gate),
  );
  registry.register(sessionWorkerRuntimeServiceDescriptor, createSessionWorkerRuntimeServiceHandler(gate, host));
  new ProcessRpcServer(registry, {
    generation,
    exitOnDrain: true,
    onDrain: async () => {
      await Promise.allSettled([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownFileDelivery(), shutdownMcpExternalService(), vector.shutdown()]);
      await reverseTransport.drain(); reverseTransport.close(); store.close();
    },
  }).start();
}

void start().catch((error) => {
  logger.error({ err: error }, 'Session worker failed to start');
  process.exitCode = 1;
  process.disconnect?.();
});
