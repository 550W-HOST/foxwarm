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
import { checkToolPermission, isToolVisibleForSession } from './isolatedCheck';
import type { ResolvedToolPermissionIdentity } from './permissions';
import type { Session } from './types';
import { requireVerifiedMcpInboundExternalId, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import { buildExternalToolAuthorizationRequest, evaluateToolAuthorization, isToolAuthorizationPotentiallyVisibleSync } from './toolAuthorization';

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
  const allowedFields = new Set([...stringFields, 'args', 'env', 'headers', 'stderr', 'enable', 'timeoutSeconds']);
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
  if (config.timeoutSeconds !== undefined && typeof config.timeoutSeconds !== 'number') {
    throw new RpcError('MCP_EXTERNAL_INVALID_REQUEST', 'config.timeoutSeconds must be a number.');
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

async function runWithAllSecretsRedacted<T>(run: () => Promise<T>, before: mcpClient.McpServerConfig[] = []): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return await rethrowWithAllSecretsRedacted(error, before);
  }
}

const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-auth-token']);

async function externalCredentials(before: mcpClient.McpServerConfig[], afterEffect: boolean): Promise<string[]> {
  let servers: Record<string, mcpClient.McpServerConfig>;
  try { servers = await mcpClient.getServers(); }
  catch {
    throw new RpcError(afterEffect ? 'MCP_EXTERNAL_OUTPUT_UNAVAILABLE' : 'MCP_EXTERNAL_CONFIG_UNAVAILABLE',
      afterEffect ? 'Tool may have completed; its output cannot be safely returned. Do not retry automatically.' : 'MCP configuration is unavailable; no tool call was sent.');
  }
  return Array.from(new Set([...before, ...Object.values(servers)].flatMap(config => [
    config.token,
    ...Object.entries(config.headers || {}).flatMap(([name, value]) => {
      if (!CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) return [];
      const bearer = /^Bearer\s+(\S+)$/i.exec(value);
      return bearer ? [value, bearer[1]] : [value];
    }),
  ]).filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

/** Refuse a credential-bearing remote item, without editing identifiers, schemas, or binary media. */
function echoesCredential(value: unknown, credentials: string[], depth = 0): boolean {
  if (!credentials.length) return false;
  if (typeof value === 'string') return credentials.some(credential => value.includes(credential));
  if (value === null || typeof value !== 'object') return false;
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some(item => echoesCredential(item, credentials, depth + 1));
  const record = value as Record<string, unknown>;
  const binary = record.type === 'image' || record.type === 'audio';
  return Object.entries(record).some(([key, item]) => {
    if (binary && (key === 'data' || key === 'blob')) return false;
    return credentials.some(credential => key.includes(credential)) || echoesCredential(item, credentials, depth + 1);
  });
}

async function externalConfigSnapshot(): Promise<mcpClient.McpServerConfig[]> {
  try { return Object.values(await mcpClient.getServers()); }
  catch { throw new RpcError('MCP_EXTERNAL_CONFIG_UNAVAILABLE', 'MCP configuration is unavailable; no tool call was sent.'); }
}

async function externalErrorDetail(error: unknown, before: mcpClient.McpServerConfig[]): Promise<string> {
  let current: mcpClient.McpServerConfig[];
  try { current = Object.values(await mcpClient.getServers()); }
  catch { return 'MCP error detail is unavailable.'; }
  const message = error instanceof Error ? error.message.slice(0, 400) : 'MCP operation failed.';
  const connectionFields = [...before, ...current].flatMap(config => [config.url, config.cwd, config.command])
    .filter((value): value is string => typeof value === 'string' && value.length >= 8);
  return connectionFields.some(value => message.includes(value)) ? 'MCP connection detail is unavailable.' : message;
}

/** The external path is Main-owned and never presents an invented internal sourceSessionId to the v1 RPC service. */
export async function listMcpServersForExternal(principal: VerifiedMcpInboundPrincipal): Promise<mcpClient.McpServerSummary[]> {
  requireVerifiedMcpInboundExternalId(principal);
  assertNotTerminallyShutDown();
  return mcpClient.listServers();
}

export async function listMcpToolsForExternal(
  principal: VerifiedMcpInboundPrincipal, externalSessionId: string, server: string, signal?: AbortSignal,
): Promise<any[]> {
  requireVerifiedMcpInboundExternalId(principal);
  assertNotTerminallyShutDown();
  const before = await externalConfigSnapshot();
  const listed = await runWithAllSecretsRedacted(() => mcpClient.listTools(server, signal), before);
  const credentials = await externalCredentials(before, false);
  const items = Array.isArray((listed as any)?.tools) ? (listed as any).tools : Array.isArray(listed) ? listed : [];
  return items.filter((tool: any) => typeof tool?.name === 'string' && !echoesCredential(tool, credentials) && isToolAuthorizationPotentiallyVisibleSync(
    buildExternalToolAuthorizationRequest({ principal, sessionId: externalSessionId, tool: { source: 'mcp', server, name: tool.name } }),
  ));
}

export async function callMcpToolForExternal(
  principal: VerifiedMcpInboundPrincipal, externalSessionId: string, server: string,
  name: string, args: Record<string, unknown>, signal?: AbortSignal,
): Promise<any> {
  requireVerifiedMcpInboundExternalId(principal);
  assertNotTerminallyShutDown();
  const normalizedArgs = requireJsonArgs(args);
  const request = buildExternalToolAuthorizationRequest({
    principal, sessionId: externalSessionId, tool: { source: 'mcp', server, name }, args: normalizedArgs,
  });
  if ((await evaluateToolAuthorization(request)).action !== 'allow') {
    throw new RpcError('MCP_EXTERNAL_DENIED', 'Tool is not permitted.');
  }
  const before = await externalConfigSnapshot();
  let listed: Awaited<ReturnType<typeof mcpClient.listTools>>;
  try { listed = await runWithAllSecretsRedacted(() => mcpClient.listTools(server, signal), before); }
  catch (error) {
    const message = await externalErrorDetail(error, before);
    throw new RpcError('MCP_EXTERNAL_CALL_NOT_SENT', `Tool lookup failed before invocation; no call was sent. ${message}`);
  }
  const items = Array.isArray((listed as any)?.tools) ? (listed as any).tools : Array.isArray(listed) ? listed : [];
  const credentials = await externalCredentials(before, false);
  if (!items.some((tool: any) => tool?.name === name && !echoesCredential(tool, credentials))) {
    throw new RpcError('MCP_EXTERNAL_TOOL_NOT_FOUND', 'Tool is not available on the configured server.');
  }
  let result: Awaited<ReturnType<typeof mcpClient.callTool>>;
  try { result = await runWithAllSecretsRedacted(() => mcpClient.callTool(server, name, normalizedArgs, { signal, rawResult: true }), before); }
  catch (error) { throw new RpcError('MCP_EXTERNAL_CALL_FAILED', await externalErrorDetail(error, before)); }
  if (echoesCredential(result, await externalCredentials(before, true))) {
    throw new RpcError('MCP_EXTERNAL_OUTPUT_WITHHELD', 'Tool may have completed; remote output echoed a configured credential and was withheld. Do not retry automatically.');
  }
  return result;
}

async function authorize(sourceSessionId: unknown, identity: ResolvedToolPermissionIdentity, args: Record<string, unknown> = {}, expectedSourceSessionId?: string): Promise<Session> {
  const source = requireString(sourceSessionId, 'sourceSessionId');
  if (expectedSourceSessionId && source !== expectedSourceSessionId) {
    throw new RpcError('MCP_EXTERNAL_SOURCE_MISMATCH', `MCP external reverse source must be \`${expectedSourceSessionId}\`.`);
  }
  const sourceSession = sessionManager.getSessionCatalog(source);
  if (!sourceSession) {
    throw new RpcError('MCP_EXTERNAL_SOURCE_NOT_FOUND', `Source session \`${source}\` was not found.`);
  }
  await checkToolPermission(identity, source, 'master', args);
  return sourceSession;
}

export function createMcpExternalServiceHandler(options: { expectedSourceSessionId?: string } = {}): RpcServiceHandler<typeof mcpExternalServiceDescriptor> {
  return {
    async listServers(input) {
      const request = requireExactRecord(input, 'listServers request', ['sourceSessionId']);
      await authorize(request.sourceSessionId, { source: 'builtin', tool: 'list_mcp_servers' }, {}, options.expectedSourceSessionId);
      return { servers: await mcpClient.listServers() };
    },
    async listTools(input) {
      const request = requireExactRecord(input, 'listTools request', ['sourceSessionId', 'server']);
      const server = optionalString(request.server, 'server');
      const source = requireString(request.sourceSessionId, 'sourceSessionId');
      if (options.expectedSourceSessionId && source !== options.expectedSourceSessionId) {
        throw new RpcError('MCP_EXTERNAL_SOURCE_MISMATCH', `MCP external reverse source must be \`${options.expectedSourceSessionId}\`.`);
      }
      const sourceSession = sessionManager.getSessionCatalog(source);
      if (!sourceSession) throw new RpcError('MCP_EXTERNAL_SOURCE_NOT_FOUND', `Source session \`${source}\` was not found.`);
      const normalizedServer = server || 'default';
      if (sessionManager.isSessionEffectivelyIsolated(sourceSession)) {
        const hasAllowedTool = sessionManager.getAgentToolRules(sourceSession.agent || 'main')
          .some(rule => rule.effect === 'allow' && rule.source === 'mcp' && rule.server === normalizedServer);
        if (!hasAllowedTool) throw new Error('No MCP tools are allowed for this isolated agent on the requested server.');
      }
      const listed = await runWithAllSecretsRedacted(() => mcpClient.listTools(server));
      const visible = (tool: any) => isToolVisibleForSession(sourceSession, {
        source: 'mcp', server: normalizedServer, tool: String(tool?.name || ''),
      });
      const result = Array.isArray(listed)
        ? listed.filter(visible)
        : listed && Array.isArray((listed as any).tools)
          ? { ...(listed as any), tools: (listed as any).tools.filter(visible) }
          : listed;
      return { result };
    },
    async callTool(input) {
      const request = requireExactRecord(input, 'callTool request', ['sourceSessionId', 'server', 'name', 'args']);
      const server = optionalString(request.server, 'server');
      const name = requireString(request.name, 'name');
      const args = requireJsonArgs(request.args);
      await authorize(request.sourceSessionId, { source: 'mcp', server: server || 'default', tool: name }, args, options.expectedSourceSessionId);
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
        await authorize(request.sourceSessionId, { source: 'builtin', tool: 'mcp_config' }, { name, action }, options.expectedSourceSessionId);
        try {
          await mcpClient.setServerEnabled(name, request.enabled);
        } catch (error) {
          await rethrowWithAllSecretsRedacted(error);
        }
      } else if (action === 'upsert') {
        requireExactRecord(request, 'configure upsert request', ['sourceSessionId', 'name', 'action', 'config']);
        const name = requireString(request.name, 'name');
        const config = requireServerConfig(request.config);
        await authorize(request.sourceSessionId, { source: 'builtin', tool: 'mcp_config' }, { name, action }, options.expectedSourceSessionId);
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
