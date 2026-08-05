import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
} from './rpc';
import {
  createMainManagementToolServiceHandler,
  MainManagementToolOperation,
  mainManagementToolServiceDescriptor,
} from './mainManagementToolService';
import type { ToolArgs, ToolContext } from './tools/helpers';

let transport: LocalRpcTransport | undefined;
let client: RpcClient<typeof mainManagementToolServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;

export async function initializeMainManagementTools(): Promise<void> {
  if (client) return;
  if (!initializing) {
    initializing = Promise.resolve().then(() => {
      const registry = new RpcServiceRegistry();
      registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler());
      transport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      client = new RpcClient(mainManagementToolServiceDescriptor, transport);
    }).catch(error => {
      initializing = undefined;
      throw error;
    });
  }
  await initializing;
}

async function getClient(): Promise<RpcClient<typeof mainManagementToolServiceDescriptor>> {
  await initializeMainManagementTools();
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

export const tool_send_to_session = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_session', args, ctx);
export const tool_send_to_channel = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('send_to_channel', args, ctx);
export const tool_list_agents = (args: ToolArgs = {}, ctx?: ToolContext) => executeMainManagementTool('list_agents', args, ctx);
export const tool_create_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('create_timer', args, ctx);
export const tool_list_timers = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('list_timers', args, ctx);
export const tool_update_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('update_timer', args, ctx);
export const tool_delete_timer = (args: ToolArgs, ctx?: ToolContext) => executeMainManagementTool('delete_timer', args, ctx);

export function getMainManagementToolServiceStatus(): { placement: 'local'; ready: boolean } {
  return { placement: 'local', ready: !!client };
}

export async function shutdownMainManagementTools(timeoutMs = 10_000): Promise<void> {
  const currentTransport = transport;
  if (!currentTransport) return;
  try {
    await currentTransport.drain(timeoutMs);
  } finally {
    currentTransport.close();
    client = undefined;
    transport = undefined;
    initializing = undefined;
  }
}
