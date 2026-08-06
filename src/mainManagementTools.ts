import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  type RpcTransport,
  RpcServiceRegistry,
} from './rpc';
import {
  createMainManagementToolServiceHandler,
  MainManagementToolOperation,
  ScheduleWaitTimeoutRequest,
  ScheduleWaitTimeoutResponse,
  mainManagementToolServiceDescriptor,
} from './mainManagementToolService';
import type { ToolArgs, ToolContext } from './tools/helpers';

let transport: RpcTransport | undefined;
let client: RpcClient<typeof mainManagementToolServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let initializingTransport: RpcTransport | null | undefined;
let initializingPlacement: 'local' | 'child-reverse' | undefined;
let terminalShutdown = false;
let placement: 'local' | 'child-reverse' = 'local';

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) {
    throw new RpcError('MAIN_MANAGEMENT_SHUTDOWN', 'Main management tool service is shutting down.', true);
  }
}

export async function initializeMainManagementTools(options: {
  transport?: RpcTransport;
  placement?: 'child-reverse';
} = {}): Promise<void> {
  assertNotTerminallyShutDown();
  const requestedPlacement = options.transport ? (options.placement || 'child-reverse') : 'local';
  if (client) {
    if (placement !== requestedPlacement || (options.transport && transport !== options.transport)) {
      throw new RpcError('MAIN_MANAGEMENT_PLACEMENT_LOCKED', 'Main management tool placement is already initialized.');
    }
    return;
  }
  if (initializing) {
    if (initializingPlacement !== requestedPlacement || initializingTransport !== (options.transport || null)) {
      throw new RpcError('MAIN_MANAGEMENT_PLACEMENT_LOCKED', 'Main management tool placement initialization is already in progress.');
    }
    await initializing;
    return;
  }
  if (!initializing) {
    initializingTransport = options.transport || null;
    initializingPlacement = requestedPlacement;
    initializing = Promise.resolve().then(() => {
      assertNotTerminallyShutDown();
      if (options.transport) {
        transport = options.transport;
        placement = options.placement || 'child-reverse';
        client = new RpcClient(mainManagementToolServiceDescriptor, options.transport);
        return;
      }
      const registry = new RpcServiceRegistry();
      registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler());
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      client = new RpcClient(mainManagementToolServiceDescriptor, nextTransport);
    });
  }
  const pending = initializing;
  try { await pending; }
  finally {
    if (initializing === pending) {
      initializing = undefined;
      initializingTransport = undefined;
      initializingPlacement = undefined;
    }
  }
}

async function getClient(): Promise<RpcClient<typeof mainManagementToolServiceDescriptor>> {
  assertNotTerminallyShutDown();
  if (!client) await initializeMainManagementTools();
  if (!client) throw new RpcError('MAIN_MANAGEMENT_UNAVAILABLE', 'Main management tool service is unavailable.', true);
  return client;
}

export async function executeMainManagementTool(
  operation: MainManagementToolOperation,
  args: ToolArgs,
  ctx?: ToolContext,
): Promise<any> {
  if (!ctx?.sessionId) {
    throw new RpcError('MAIN_MANAGEMENT_SOURCE_REQUIRED', 'Main management tools require an active source session.');
  }
  const response = await (await getClient()).call('execute', {
    sourceSessionId: ctx.sessionId,
    operation,
    args,
  });
  return response.result;
}

export async function scheduleMainWaitTimeout(request: ScheduleWaitTimeoutRequest): Promise<ScheduleWaitTimeoutResponse> {
  return await (await getClient()).call('scheduleWaitTimeout', request);
}

export const tool_send_to_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_session', args, ctx);
export const tool_send_to_channel = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_channel', args, ctx);
export const tool_list_agents = (args: ToolArgs = {}, ctx?: ToolContext) => executeMainManagementTool('list_agents', args, ctx);
export const tool_create_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('create_timer', args, ctx);
export const tool_list_timers = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('list_timers', args, ctx);
export const tool_update_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('update_timer', args, ctx);
export const tool_delete_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('delete_timer', args, ctx);

export function getMainManagementToolServiceStatus(): { placement: 'local' | 'child-reverse'; ready: boolean } {
  return { placement, ready: !!client };
}

export async function shutdownMainManagementTools(timeoutMs = 10_000): Promise<void> {
  terminalShutdown = true;
  const pendingInitialization = initializing;
  if (pendingInitialization) {
    await pendingInitialization.catch(() => {});
  }
  const currentTransport = transport;
  if (!currentTransport) {
    client = undefined;
    initializing = undefined;
    initializingTransport = undefined;
    initializingPlacement = undefined;
    return;
  }
  try {
    await currentTransport.drain(timeoutMs);
  } finally {
    currentTransport.close();
    client = undefined;
    transport = undefined;
    initializing = undefined;
    initializingTransport = undefined;
    initializingPlacement = undefined;
  }
}

/** Test-only: ordinary production shutdown is terminal and cannot be reset. */
export function resetMainManagementToolsForTests(): void {
  if (transport || client || initializing) {
    throw new RpcError('MAIN_MANAGEMENT_TEST_RESET_ACTIVE', 'Shut down the Main Management tool service before resetting tests.');
  }
  terminalShutdown = false;
  placement = 'local';
  initializingTransport = undefined;
  initializingPlacement = undefined;
}
