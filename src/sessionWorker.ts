import { logger } from './common';
import { ProcessRpcServer, RpcServiceRegistry } from './rpc';
import {
  createSessionWorkerControlServiceHandler,
  sessionWorkerControlServiceDescriptor,
} from './sessionWorkerControlService';

async function start(): Promise<void> {
  const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID || '';
  const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION || 0);
  if (!sessionId || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Session worker requires a session ID and positive generation.');
  }

  const registry = new RpcServiceRegistry();
  registry.register(
    sessionWorkerControlServiceDescriptor,
    createSessionWorkerControlServiceHandler({ sessionId, generation, pid: process.pid }),
  );
  new ProcessRpcServer(registry, {
    generation,
    exitOnDrain: true,
  }).start();
}

void start().catch((error) => {
  logger.error({ err: error }, 'Session worker failed to start');
  process.exitCode = 1;
  process.disconnect?.();
});
