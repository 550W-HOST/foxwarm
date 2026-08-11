import { logger } from './common';
import { ProcessRpcServer, RpcServiceRegistry } from './rpc';
import { createVectorServiceHandler, vectorServiceDescriptor } from './vectorService';
import * as runtime from './vectorRuntime';

async function start(): Promise<void> {
  const generation = Number(process.env.FOXWARM_VECTOR_WORKER_GENERATION || 0);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Vector worker requires a positive FOXWARM_VECTOR_WORKER_GENERATION.');
  }

  // Readiness means the Lance table is open. Startup backfill remains
  // asynchronous, matching the in-process vector init contract.
  await runtime.init();
  const registry = new RpcServiceRegistry();
  registry.register(vectorServiceDescriptor, createVectorServiceHandler());
  new ProcessRpcServer(registry, {
    generation,
    exitOnDrain: true,
    onDrain: () => runtime.shutdown(),
  }).start();
}

void start().catch((error) => {
  logger.error({ err: error }, 'Vector worker failed to start');
  process.exitCode = 1;
  process.disconnect?.();
});
