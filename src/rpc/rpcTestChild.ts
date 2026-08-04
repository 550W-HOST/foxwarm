import { ProcessRpcServer, RpcServiceRegistry } from './index';
import { rpcTestHandler, rpcTestService } from './rpcTestService';

const generation = Number(process.env.FOXWARM_RPC_TEST_GENERATION || 1);
const registry = new RpcServiceRegistry();
registry.register(rpcTestService, rpcTestHandler);
const hangCleanup = process.env.FOXWARM_RPC_TEST_HANG_CLEANUP === '1';
new ProcessRpcServer(registry, {
  generation,
  exitOnDrain: true,
  disconnectCleanupTimeoutMs: 100,
  ...(hangCleanup ? { onDrain: () => new Promise<void>(() => {}) } : {}),
}).start();
