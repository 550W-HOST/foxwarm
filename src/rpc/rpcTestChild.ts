import { ProcessRpcServer, RpcServiceRegistry } from './index';
import { rpcTestHandler, rpcTestService } from './rpcTestService';

const generation = Number(process.env.FOXWARM_RPC_TEST_GENERATION || 1);
const registry = new RpcServiceRegistry();
registry.register(rpcTestService, rpcTestHandler);
new ProcessRpcServer(registry, { generation, exitOnDrain: true }).start();
