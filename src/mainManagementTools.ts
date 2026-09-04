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
  ValidateWaitSessionsRequest,
  ValidateWaitSessionsResponse,
  ArmWaitLivenessRequest,
  ArmWaitLivenessResponse,
  ValidateWaitExecIdsRequest,
  ValidateWaitExecIdsResponse,
  mainManagementToolServiceDescriptor,
} from './mainManagementToolService';
import type { SessionWorkerStore } from './sessionWorkerStore';
import type { SessionRuntimeHistoryDto } from './sessionRuntimeService';
import type { ToolArgs, ToolContext } from './tools/helpers';

let transport: RpcTransport | undefined;
let client: RpcClient<typeof mainManagementToolServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let initializingTransport: RpcTransport | null | undefined;
let initializingPlacement: 'local' | 'child-reverse' | undefined;
let terminalShutdown = false;
let placement: 'local' | 'child-reverse' = 'local';
let ownsTransport = true;

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) {
    throw new RpcError('MAIN_MANAGEMENT_SHUTDOWN', 'Main management tool service is shutting down.', true);
  }
}

export async function initializeMainManagementTools(options: {
  transport?: RpcTransport;
  placement?: 'child-reverse';
  workerStore?: SessionWorkerStore;
  readSessionHistory?: (sessionId: string) => Promise<SessionRuntimeHistoryDto | null>;
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
        ownsTransport = false;
        placement = options.placement || 'child-reverse';
        client = new RpcClient(mainManagementToolServiceDescriptor, options.transport);
        return;
      }
      const registry = new RpcServiceRegistry();
      registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({
        workerStore: options.workerStore,
        readSessionHistory: options.readSessionHistory,
      }));
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      ownsTransport = true;
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

export async function validateMainWaitSessions(request: ValidateWaitSessionsRequest): Promise<ValidateWaitSessionsResponse> {
  return await (await getClient()).call('validateWaitSessions', request);
}

export async function armMainWaitLiveness(request: ArmWaitLivenessRequest): Promise<ArmWaitLivenessResponse> {
  return await (await getClient()).call('armWaitLiveness', request);
}

export async function validateMainWaitExecIds(request: ValidateWaitExecIdsRequest): Promise<ValidateWaitExecIdsResponse> {
  return await (await getClient()).call('validateWaitExecIds', request);
}

export const tool_send_to_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_session', args, ctx);
export const tool_create_child_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('create_child_session', args, ctx);
export const tool_send_to_channel = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_channel', args, ctx);
export const tool_list_agents = (args: ToolArgs = {}, ctx?: ToolContext) => executeMainManagementTool('list_agents', args, ctx);
export const tool_create_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('create_timer', args, ctx);
export const tool_list_timers = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('list_timers', args, ctx);
export const tool_update_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('update_timer', args, ctx);
export const tool_delete_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('delete_timer', args, ctx);
export const tool_get_archived_messages = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('get_archived_messages', args, ctx);
export const tool_get_archived_blocks = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('get_archived_blocks', args, ctx);
export const tool_recall = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('recall', args, ctx);
export const tool_create_agent = (args: ToolArgs, ctx?: ToolContext) => {
  if (ctx?.sessionPlacement === 'session-worker' && args.convertSession === true) {
    throw new RpcError('SESSION_WORKER_TOOL_UNAVAILABLE', 'create_agent source conversion is unavailable in Session-worker placement.', true);
  }
  return executeMainManagementTool('create_agent', args, ctx);
};
export const tool_create_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('create_session', args, ctx);
export const tool_delete_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('delete_session', args, ctx);
export const tool_node_bootstrap_info = (args: ToolArgs = {}, ctx?: ToolContext) => executeMainManagementTool('node_bootstrap_info', args, ctx);
export const tool_node_pair_list = (args: ToolArgs = {}, ctx?: ToolContext) => executeMainManagementTool('node_pair_list', args, ctx);
export const tool_node_pair_approve = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('node_pair_approve', args, ctx);

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
  if (!ownsTransport) {
    client = undefined; transport = undefined; initializing = undefined;
    initializingTransport = undefined; initializingPlacement = undefined; return;
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
  ownsTransport = true;
  initializingTransport = undefined;
  initializingPlacement = undefined;
}
