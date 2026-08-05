import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
} from './rpc';
import {
  createNodeExecutionServiceHandler,
  nodeExecutionServiceDescriptor,
  NodeExecutionRoutingSnapshot,
} from './nodeExecutionService';

let transport: LocalRpcTransport | undefined;
let client: RpcClient<typeof nodeExecutionServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let terminalShutdown = false;

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) {
    throw new RpcError('NODE_EXECUTION_SHUTDOWN', 'Node execution service is shutting down.', true);
  }
}

export async function initializeNodeExecution(): Promise<void> {
  assertNotTerminallyShutDown();
  if (client) return;
  if (!initializing) {
    initializing = Promise.resolve().then(() => {
      assertNotTerminallyShutDown();
      const registry = new RpcServiceRegistry();
      registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler());
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      client = new RpcClient(nodeExecutionServiceDescriptor, nextTransport);
    }).catch(error => {
      initializing = undefined;
      throw error;
    });
  }
  await initializing;
}

async function getClient(): Promise<RpcClient<typeof nodeExecutionServiceDescriptor>> {
  await initializeNodeExecution();
  if (!client) throw new RpcError('NODE_EXECUTION_UNAVAILABLE', 'Node execution service is unavailable.', true);
  return client;
}

export async function executeRemoteNodeTool(
  sourceSessionId: string,
  nodeId: string,
  toolName: string,
  args: Record<string, unknown>,
  routingSnapshot?: NodeExecutionRoutingSnapshot,
): Promise<any> {
  const response = await (await getClient()).call('execute', {
    sourceSessionId,
    nodeId,
    toolName,
    args,
    ...(routingSnapshot ? { routingSnapshot } : {}),
  });
  return response.result;
}

export function getNodeExecutionStatus(): { placement: 'local'; ready: boolean } {
  return { placement: 'local', ready: !!client };
}

export async function shutdownNodeExecution(timeoutMs = 10_000): Promise<void> {
  terminalShutdown = true;
  const pendingInitialization = initializing;
  if (pendingInitialization) await pendingInitialization.catch(() => {});
  const currentTransport = transport;
  if (!currentTransport) {
    client = undefined;
    initializing = undefined;
    return;
  }
  try {
    await currentTransport.drain(timeoutMs);
  } finally {
    currentTransport.close();
    client = undefined;
    transport = undefined;
    initializing = undefined;
  }
}

/** Test-only: ordinary production shutdown is terminal and cannot be reset. */
export function resetNodeExecutionForTests(): void {
  if (transport || client || initializing) {
    throw new RpcError('NODE_EXECUTION_TEST_RESET_ACTIVE', 'Shut down Node execution before resetting tests.');
  }
  terminalShutdown = false;
}

export type { NodeExecutionRoutingSnapshot } from './nodeExecutionService';
