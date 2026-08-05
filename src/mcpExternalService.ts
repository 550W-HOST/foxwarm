import {
  defineRpcService,
  LocalRpcTransport,
  rpcMethod,
  RpcClient,
  RpcError,
  RpcServiceHandler,
  RpcServiceRegistry,
} from './rpc';
import * as mcpClient from './mcpClient';
import * as sessionManager from './sessionManager';
import { checkToolPermission } from './isolatedCheck';

export type McpExternalConfigureRequest =
  | { sourceSessionId: string; name: string; action: 'set-enabled'; enabled: boolean }
  | { sourceSessionId: string; name: string; action: 'upsert'; config: mcpClient.McpServerConfig };

export const mcpExternalServiceDescriptor = defineRpcService('mcp-external', 1, {
  listServers: rpcMethod<{ sourceSessionId: string }, { servers: mcpClient.McpServerSummary[] }>(),
  listTools: rpcMethod<{ sourceSessionId: string; server?: string }, { result: unknown }>(),
  callTool: rpcMethod<{ sourceSessionId: string; server?: string; name: string; args: Record<string, unknown> }, { result: unknown }>(),
  configure: rpcMethod<McpExternalConfigureRequest, { saved: true }>(),
});

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireServerConfig(value: unknown): mcpClient.McpServerConfig {
  const config = requireObject(value, 'config');
  const stringFields = ['url', 'command', 'cwd', 'token', 'description', 'transport', 'type'] as const;
  const allowedFields = new Set([...stringFields, 'args', 'env', 'headers', 'stderr', 'enable']);
  if (Object.keys(config).some(field => !allowedFields.has(field))) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config contains an unsupported field.');
  }
  for (const field of stringFields) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `config.${field} must be a string.`);
    }
  }
  if (config.enable !== undefined && typeof config.enable !== 'boolean') {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config.enable must be a boolean.');
  }
  if (config.stderr !== undefined && !['inherit', 'pipe', 'ignore'].includes(String(config.stderr))) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config.stderr must be inherit, pipe, or ignore.');
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config.args must be an array of strings.');
  }
  for (const field of ['env', 'headers'] as const) {
    if (config[field] !== undefined && Object.values(requireObject(config[field], `config.${field}`)).some(value => typeof value !== 'string')) {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `config.${field} values must be strings.`);
    }
  }
  return config as mcpClient.McpServerConfig;
}

function redactConfiguredSecrets(error: unknown, config: mcpClient.McpServerConfig | undefined): Error {
  let message = error instanceof Error ? error.message : String(error);
  const values = [
    config?.token,
    ...(Array.isArray(config?.args) ? config.args : []),
    ...Object.values(config?.env || {}),
    ...Object.values(config?.headers || {}),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const value of values) message = message.split(value).join('[redacted]');
  return new Error(message);
}

async function runWithServerSecretsRedacted<T>(server: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const servers: Record<string, mcpClient.McpServerConfig> = await mcpClient.getServers().catch(() => ({}));
    const selected = server || (servers.default ? 'default' : Object.keys(servers)[0]);
    throw redactConfiguredSecrets(error, selected ? servers[selected] : undefined);
  }
}

async function authorize(sourceSessionId: unknown, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  const source = requireString(sourceSessionId, 'sourceSessionId');
  if (!await sessionManager.getExistingSession(source)) {
    throw new RpcError('MCP_EXTERNAL_SOURCE_NOT_FOUND', `Source session \`${source}\` was not found.`);
  }
  await checkToolPermission(toolName, source, 'master', args);
  return source;
}

export function createMcpExternalServiceHandler(): RpcServiceHandler<typeof mcpExternalServiceDescriptor> {
  return {
    async listServers(input) {
      await authorize(input?.sourceSessionId, 'list_mcp_servers');
      return { servers: await mcpClient.listServers() };
    },
    async listTools(input) {
      await authorize(input?.sourceSessionId, 'search_mcp_tools', { server: input?.server });
      const server = optionalString(input?.server, 'server');
      return { result: await runWithServerSecretsRedacted(server, () => mcpClient.listTools(server)) };
    },
    async callTool(input) {
      await authorize(input?.sourceSessionId, 'call_mcp', { server: input?.server, tool: input?.name });
      const server = optionalString(input?.server, 'server');
      const name = requireString(input?.name, 'name');
      const args = requireObject(input?.args, 'args');
      return { result: await runWithServerSecretsRedacted(server, () => mcpClient.callTool(server, name, args)) };
    },
    async configure(input) {
      await authorize(input?.sourceSessionId, 'mcp_config', { name: input?.name, action: input?.action });
      const name = requireString(input?.name, 'name');
      if (input?.action === 'set-enabled') {
        if (typeof input.enabled !== 'boolean') {
          throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'enabled must be a boolean.');
        }
        try {
          await mcpClient.setServerEnabled(name, input.enabled);
        } catch (error) {
          throw redactConfiguredSecrets(error, undefined);
        }
      } else if (input?.action === 'upsert') {
        const config = requireServerConfig(input.config);
        try {
          await mcpClient.upsertServer(name, config);
        } catch (error) {
          throw redactConfiguredSecrets(error, config);
        }
      } else {
        throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'action must be set-enabled or upsert.');
      }
      return { saved: true };
    },
  };
}

let transport: LocalRpcTransport | undefined;
let client: RpcClient<typeof mcpExternalServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let terminalShutdown = false;

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) throw new RpcError('MCP_EXTERNAL_SHUTDOWN', 'MCP external service is shutting down.', true);
}

export async function initializeMcpExternalService(): Promise<void> {
  assertNotTerminallyShutDown();
  if (client) return;
  if (!initializing) {
    initializing = Promise.resolve().then(() => {
      assertNotTerminallyShutDown();
      const registry = new RpcServiceRegistry();
      registry.register(mcpExternalServiceDescriptor, createMcpExternalServiceHandler());
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      client = new RpcClient(mcpExternalServiceDescriptor, nextTransport);
    }).catch(error => {
      initializing = undefined;
      throw error;
    });
  }
  await initializing;
}

async function getClient(): Promise<RpcClient<typeof mcpExternalServiceDescriptor>> {
  await initializeMcpExternalService();
  if (!client) throw new RpcError('MCP_EXTERNAL_UNAVAILABLE', 'MCP external service is unavailable.', true);
  return client;
}

export async function listMcpServers(sourceSessionId: string): Promise<mcpClient.McpServerSummary[]> {
  return (await (await getClient()).call('listServers', { sourceSessionId })).servers;
}

export async function listMcpTools(sourceSessionId: string, server?: string): Promise<any> {
  return (await (await getClient()).call('listTools', { sourceSessionId, ...(server ? { server } : {}) })).result;
}

export async function callMcpTool(sourceSessionId: string, server: string | undefined, name: string, args: Record<string, unknown>): Promise<any> {
  return (await (await getClient()).call('callTool', { sourceSessionId, ...(server ? { server } : {}), name, args })).result;
}

export async function configureMcpServer(request: McpExternalConfigureRequest): Promise<void> {
  await (await getClient()).call('configure', request);
}

export async function shutdownMcpExternalService(timeoutMs = 10_000): Promise<void> {
  terminalShutdown = true;
  if (initializing) await initializing.catch(() => {});
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
export function resetMcpExternalServiceForTests(): void {
  if (transport || client || initializing) {
    throw new RpcError('MCP_EXTERNAL_TEST_RESET_ACTIVE', 'Shut down MCP external service before resetting tests.');
  }
  terminalShutdown = false;
}
