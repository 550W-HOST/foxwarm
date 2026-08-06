import {
  defineRpcService,
  LocalRpcTransport,
  rpcMethod,
  RpcClient,
  RpcError,
  type RpcTransport,
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

function requirePlainRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(value: unknown, field: string, allowedFields: readonly string[]): Record<string, unknown> {
  const record = requirePlainRecord(value, field);
  const allowed = new Set(allowedFields);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} contains an unsupported field.`);
  }
  return record;
}

function requireDenseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be an array.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length) {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be a dense array without extra fields.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must be a dense array.`);
    }
  }
  for (const key of keys) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.length) {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} contains a non-index field.`);
    }
  }
  return value;
}

function requireJsonValue(value: unknown, field: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    const items = requireDenseArray(value, field);
    if (seen.has(value)) throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must not be cyclic.`);
    seen.add(value);
    items.forEach((item, index) => requireJsonValue(item, `${field}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  const record = requirePlainRecord(value, field);
  if (seen.has(record)) throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `${field} must not be cyclic.`);
  seen.add(record);
  for (const [key, item] of Object.entries(record)) requireJsonValue(item, `${field}.${key}`, seen);
  seen.delete(record);
}

function requireJsonArgs(value: unknown): Record<string, unknown> {
  const args = requirePlainRecord(value, 'args');
  requireJsonValue(args, 'args');
  return args;
}

function requireServerConfig(value: unknown): mcpClient.McpServerConfig {
  const config = requirePlainRecord(value, 'config');
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
  if (config.args !== undefined) {
    const args = requireDenseArray(config.args, 'config.args');
    if (args.some(value => typeof value !== 'string')) {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config.args must be an array of strings.');
    }
  }
  for (const field of ['env', 'headers'] as const) {
    if (config[field] !== undefined && Object.values(requirePlainRecord(config[field], `config.${field}`)).some(value => typeof value !== 'string')) {
      throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', `config.${field} values must be strings.`);
    }
  }
  return config as mcpClient.McpServerConfig;
}

function redactConfiguredSecrets(error: unknown, configs: mcpClient.McpServerConfig[]): Error {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const values = configs.flatMap(config => [
    config.token,
    ...(Array.isArray(config.args) ? config.args : []),
    ...Object.values(config.env || {}),
    ...Object.values(config.headers || {}),
  ]).filter((value): value is string => typeof value === 'string' && value.length > 0);
  const message = values.some(value => originalMessage.includes(value))
    ? 'MCP operation failed because the underlying error contained configured secret data.'
    : originalMessage;
  if (error instanceof RpcError) return new RpcError(error.code, message, error.retryable);
  if (error instanceof Error && message === originalMessage) return error;
  return new Error(message);
}

async function rethrowWithAllSecretsRedacted(error: unknown, incoming: mcpClient.McpServerConfig[] = []): Promise<never> {
  const servers: Record<string, mcpClient.McpServerConfig> = await mcpClient.getServers().catch(() => ({}));
  throw redactConfiguredSecrets(error, [...Object.values(servers), ...incoming]);
}

async function runWithAllSecretsRedacted<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return await rethrowWithAllSecretsRedacted(error);
  }
}

async function authorize(sourceSessionId: unknown, toolName: string, args: Record<string, unknown> = {}, expectedSourceSessionId?: string): Promise<string> {
  const source = requireString(sourceSessionId, 'sourceSessionId');
  if (expectedSourceSessionId && source !== expectedSourceSessionId) {
    throw new RpcError('MCP_EXTERNAL_SOURCE_MISMATCH', `MCP external reverse source must be \`${expectedSourceSessionId}\`.`);
  }
  if (!await sessionManager.getExistingSession(source)) {
    throw new RpcError('MCP_EXTERNAL_SOURCE_NOT_FOUND', `Source session \`${source}\` was not found.`);
  }
  await checkToolPermission(toolName, source, 'master', args);
  return source;
}

export function createMcpExternalServiceHandler(options: { expectedSourceSessionId?: string } = {}): RpcServiceHandler<typeof mcpExternalServiceDescriptor> {
  return {
    async listServers(input) {
      const request = requireExactRecord(input, 'listServers request', ['sourceSessionId']);
      await authorize(request.sourceSessionId, 'list_mcp_servers', {}, options.expectedSourceSessionId);
      return { servers: await mcpClient.listServers() };
    },
    async listTools(input) {
      const request = requireExactRecord(input, 'listTools request', ['sourceSessionId', 'server']);
      const server = optionalString(request.server, 'server');
      await authorize(request.sourceSessionId, 'search_mcp_tools', { server }, options.expectedSourceSessionId);
      return { result: await runWithAllSecretsRedacted(() => mcpClient.listTools(server)) };
    },
    async callTool(input) {
      const request = requireExactRecord(input, 'callTool request', ['sourceSessionId', 'server', 'name', 'args']);
      const server = optionalString(request.server, 'server');
      const name = requireString(request.name, 'name');
      const args = requireJsonArgs(request.args);
      await authorize(request.sourceSessionId, 'call_mcp', { server, tool: name, args }, options.expectedSourceSessionId);
      return { result: await runWithAllSecretsRedacted(() => mcpClient.callTool(server, name, args)) };
    },
    async configure(input) {
      const request = requirePlainRecord(input, 'configure request');
      const action = request.action;
      if (action === 'set-enabled') {
        requireExactRecord(request, 'configure set-enabled request', ['sourceSessionId', 'name', 'action', 'enabled']);
        const name = requireString(request.name, 'name');
        if (typeof request.enabled !== 'boolean') {
          throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'enabled must be a boolean.');
        }
        await authorize(request.sourceSessionId, 'mcp_config', { name, action }, options.expectedSourceSessionId);
        try {
          await mcpClient.setServerEnabled(name, request.enabled);
        } catch (error) {
          await rethrowWithAllSecretsRedacted(error);
        }
      } else if (action === 'upsert') {
        requireExactRecord(request, 'configure upsert request', ['sourceSessionId', 'name', 'action', 'config']);
        const name = requireString(request.name, 'name');
        const config = requireServerConfig(request.config);
        await authorize(request.sourceSessionId, 'mcp_config', { name, action }, options.expectedSourceSessionId);
        try {
          await mcpClient.upsertServer(name, config);
        } catch (error) {
          await rethrowWithAllSecretsRedacted(error, [config]);
        }
      } else {
        throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'action must be set-enabled or upsert.');
      }
      return { saved: true };
    },
  };
}

let transport: RpcTransport | undefined;
let client: RpcClient<typeof mcpExternalServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let initializingTransport: RpcTransport | null | undefined;
let terminalShutdown = false;
let ownsTransport = true;
let placement: 'local' | 'child-reverse' = 'local';

function assertNotTerminallyShutDown(): void {
  if (terminalShutdown) throw new RpcError('MCP_EXTERNAL_SHUTDOWN', 'MCP external service is shutting down.', true);
}

export async function initializeMcpExternalService(options: { transport?: RpcTransport; placement?: 'child-reverse' } = {}): Promise<void> {
  assertNotTerminallyShutDown();
  if (client) {
    if ((options.transport && transport !== options.transport) || (!options.transport && placement !== 'local')) {
      throw new RpcError('MCP_EXTERNAL_PLACEMENT_LOCKED', 'MCP external placement is already initialized.');
    }
    return;
  }
  if (initializing) {
    if (initializingTransport !== (options.transport || null)) {
      throw new RpcError('MCP_EXTERNAL_PLACEMENT_LOCKED', 'MCP external placement initialization is already in progress.');
    }
    await initializing; return;
  }
  if (!initializing) {
    initializingTransport = options.transport || null;
    initializing = Promise.resolve().then(() => {
      assertNotTerminallyShutDown();
      if (options.transport) {
        transport = options.transport; ownsTransport = false; placement = options.placement || 'child-reverse';
        client = new RpcClient(mcpExternalServiceDescriptor, options.transport); return;
      }
      const registry = new RpcServiceRegistry();
      registry.register(mcpExternalServiceDescriptor, createMcpExternalServiceHandler());
      const nextTransport = new LocalRpcTransport(registry, { maxPendingRequests: 128 });
      if (terminalShutdown) {
        nextTransport.close();
        assertNotTerminallyShutDown();
      }
      transport = nextTransport;
      client = new RpcClient(mcpExternalServiceDescriptor, nextTransport);
    });
  }
  const pending = initializing;
  try { await pending; }
  finally { if (initializing === pending) { initializing = undefined; initializingTransport = undefined; } }
}

async function getClient(): Promise<RpcClient<typeof mcpExternalServiceDescriptor>> {
  assertNotTerminallyShutDown();
  if (!client) await initializeMcpExternalService();
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
export function resetMcpExternalServiceForTests(): void {
  if (transport || client || initializing) {
    throw new RpcError('MCP_EXTERNAL_TEST_RESET_ACTIVE', 'Shut down MCP external service before resetting tests.');
  }
  terminalShutdown = false;
  ownsTransport = true;
  placement = 'local';
  initializingTransport = undefined;
}
