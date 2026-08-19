import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  type RpcTransport,
  RpcServiceRegistry,
} from './rpc';
import {
  createNodeExecutionServiceHandler,
  nodeExecutionServiceDescriptor,
  NodeExecutionRoutingSnapshot,
} from './nodeExecutionService';

let transport: RpcTransport | undefined;
let client: RpcClient<typeof nodeExecutionServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let initializingTransport: RpcTransport | null | undefined;
let terminalShutdown = false;
let ownsTransport = true;
let placement: 'local' | 'child-reverse' = 'local';

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) {
    throw new RpcError('NODE_EXECUTION_SHUTDOWN', 'Node execution service is shutting down.', true);
  }
}

export async function initializeNodeExecution(options: { transport?: RpcTransport; placement?: 'child-reverse' } = {}): Promise<void> {
  assertNotTerminallyShutDown();
  if (client) {
    if ((options.transport && transport !== options.transport) || (!options.transport && placement !== 'local')) {
      throw new RpcError('NODE_EXECUTION_PLACEMENT_LOCKED', 'Node execution placement is already initialized.');
    }
    return;
  }
  if (initializing) {
    if (initializingTransport !== (options.transport || null)) {
      throw new RpcError('NODE_EXECUTION_PLACEMENT_LOCKED', 'Node execution placement initialization is already in progress.');
    }
    await initializing; return;
  }
  if (!initializing) {
    initializingTransport = options.transport || null;
    initializing = Promise.resolve().then(() => {
      assertNotTerminallyShutDown();
      if (options.transport) {
        transport = options.transport; ownsTransport = false; placement = options.placement || 'child-reverse';
        client = new RpcClient(nodeExecutionServiceDescriptor, options.transport); return;
      }
      const registry = new RpcServiceRegistry();
      registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler());
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      client = new RpcClient(nodeExecutionServiceDescriptor, nextTransport);
    });
  }
  const pending = initializing;
  try { await pending; }
  finally { if (initializing === pending) { initializing = undefined; initializingTransport = undefined; } }
}

async function getClient(): Promise<RpcClient<typeof nodeExecutionServiceDescriptor>> {
  assertNotTerminallyShutDown();
  if (!client) await initializeNodeExecution();
  if (!client) throw new RpcError('NODE_EXECUTION_UNAVAILABLE', 'Node execution service is unavailable.', true);
  return client;
}

export async function executeNodeTool(
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

export async function listNodeTopology(sourceSessionId: string, nodeId?: string, currentNode?: string) {
  return (await (await getClient()).call('list', { sourceSessionId, ...(nodeId ? { nodeId } : {}), ...(currentNode ? { currentNode } : {}) })).nodes;
}

export async function validateNodeSelection(sourceSessionId: string, nodeId: string) {
  return await (await getClient()).call('select', { sourceSessionId, nodeId });
}

export async function copyBetweenNodes(sourceSessionId: string, request: {
  sourceNode: string; sourcePath: string; targetNode: string; targetPath: string; overwrite?: boolean;
}) {
  return await (await getClient()).call('copy', { sourceSessionId, ...request });
}

export function getNodeExecutionStatus(): { placement: 'local' | 'child-reverse'; ready: boolean } {
  return { placement, ready: !!client };
}

export async function shutdownNodeExecution(timeoutMs = 10_000): Promise<void> {
  terminalShutdown = true;
  const pendingInitialization = initializing;
  if (pendingInitialization) await pendingInitialization.catch(() => {});
  const currentTransport = transport;
  if (!currentTransport) {
    client = undefined;
    initializing = undefined;
    initializingTransport = undefined;
    return;
  }
  if (!ownsTransport) {
    client = undefined; transport = undefined; initializing = undefined; initializingTransport = undefined; return;
  }
  try {
    await currentTransport.drain(timeoutMs);
  } finally {
    currentTransport.close();
    client = undefined;
    transport = undefined;
    initializing = undefined;
    initializingTransport = undefined;
  }
}

/** Test-only: ordinary production shutdown is terminal and cannot be reset. */
export function resetNodeExecutionForTests(): void {
  if (transport || client || initializing) {
    throw new RpcError('NODE_EXECUTION_TEST_RESET_ACTIVE', 'Shut down Node execution before resetting tests.');
  }
  terminalShutdown = false;
  ownsTransport = true;
  placement = 'local';
  initializingTransport = undefined;
}

export type { NodeExecutionRoutingSnapshot } from './nodeExecutionService';
