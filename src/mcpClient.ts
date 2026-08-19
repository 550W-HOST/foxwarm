import { MCP_CONFIG_PATH } from './config';
import { logger } from './common';
import { DiskJsonData } from './utils/diskJsonData';

type McpSdkModules = {
  Client: any;
  StreamableHTTPClientTransport: any;
  SSEClientTransport: any;
  StdioClientTransport: any;
};

let cachedMcpSdk: McpSdkModules | null = null;

function loadMcpSdk(): McpSdkModules {
  if (cachedMcpSdk) {
    return cachedMcpSdk;
  }

  try {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

    cachedMcpSdk = {
      Client,
      StreamableHTTPClientTransport,
      SSEClientTransport,
      StdioClientTransport,
    };

    return cachedMcpSdk;
  } catch (e: any) {
    throw new Error(`MCP SDK is unavailable: ${e?.message || e}. Install @modelcontextprotocol/sdk to use MCP tools.`);
  }
}

export type McpTransport = 'streamable-http' | 'sse' | 'stdio' | 'auto';

export type McpServerConfig = {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: 'inherit' | 'pipe' | 'ignore';
  token?: string;
  headers?: Record<string, string>;
  description?: string;
  timeoutSeconds?: number;
  enable?: boolean;
  transport?: McpTransport;
  type?: string;
};

export type McpConfig = {
  servers: Record<string, McpServerConfig>;
};

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  description?: string;
  url?: string;
  command?: string;
  cwd?: string;
  stderr?: 'inherit' | 'pipe' | 'ignore';
  argsCount: number;
  envKeys: string[];
  headerKeys: string[];
  hasToken: boolean;
  timeoutSeconds: number | null;
};

type StandardTransportKind = 'streamable-http' | 'sse' | 'stdio';

type StandardConnection = {
  client: any;
  transport: {
    close: () => Promise<void>;
    onclose?: (() => void) | undefined;
  };
  transportKind: StandardTransportKind;
  pid?: number | null;
};

type PooledStdioConnection = StandardConnection & {
  poolKey: string;
  configSignature: string;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  invalidated?: boolean;
  connectPromise?: Promise<PooledStdioConnection>;
};

const VALID_TRANSPORTS = new Set<McpTransport>(['streamable-http', 'sse', 'stdio', 'auto']);
export const MIN_MCP_TOOL_TIMEOUT_SECONDS = 1;
export const MAX_MCP_TOOL_TIMEOUT_SECONDS = 3600;
const STDIO_POOL_IDLE_TTL_MS = 60_000;
const stdioConnectionPool = new Map<string, PooledStdioConnection>();

function normalizeMcpConfigPayload(raw: any, filePath: string): McpConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid MCP config payload in ${filePath}`);
  }

  const servers = raw.servers && typeof raw.servers === 'object' ? raw.servers : {};
  const normalizedServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, sanitizeServerConfig(server as McpServerConfig)])
  );
  return { servers: normalizedServers };
}

export function createMcpConfigStore(filePath: string = MCP_CONFIG_PATH): DiskJsonData<McpConfig> {
  return new DiskJsonData<McpConfig>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeMcpConfigPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read MCP config candidate');
    },
  });
}

let mcpConfigStore = createMcpConfigStore();
let liveMcpConfig: McpConfig | null = null;
let liveMcpConfigLoad: Promise<McpConfig> | null = null;
let mcpConfigMutationQueue: Promise<void> = Promise.resolve();

export function setMcpConfigStoreForTests(store: DiskJsonData<McpConfig> | null): void {
  mcpConfigStore = store || createMcpConfigStore();
  liveMcpConfig = null;
  liveMcpConfigLoad = null;
  mcpConfigMutationQueue = Promise.resolve();
}

function normalizeTransport(server: McpServerConfig): McpTransport {
  const raw = typeof server.transport === 'string'
    ? server.transport
    : (typeof server.type === 'string' ? server.type : undefined);

  if (!raw) return 'auto';
  if (VALID_TRANSPORTS.has(raw as McpTransport)) {
    return raw as McpTransport;
  }

  if (raw === 'legacy-http-jsonrpc') {
    throw new Error('MCP transport legacy-http-jsonrpc is no longer supported. Use streamable-http, sse, or auto.');
  }

  throw new Error(`Unsupported MCP transport: ${raw}. Supported transports: streamable-http, sse, stdio, auto.`);
}

function sanitizeServerConfig(server: McpServerConfig): McpServerConfig {
  const next = { ...server };
  if (next.transport === undefined && typeof next.type === 'string') {
    next.transport = next.type as McpTransport;
  }
  if (next.transport !== undefined) {
    next.transport = normalizeTransport(next);
  }
  if (next.timeoutSeconds !== undefined) {
    if (typeof next.timeoutSeconds !== 'number' || !Number.isFinite(next.timeoutSeconds)) {
      throw new Error('MCP timeoutSeconds must be a finite number.');
    }
    if (next.timeoutSeconds === 0) {
      delete next.timeoutSeconds;
    } else if (next.timeoutSeconds < MIN_MCP_TOOL_TIMEOUT_SECONDS || next.timeoutSeconds > MAX_MCP_TOOL_TIMEOUT_SECONDS) {
      throw new Error(`MCP timeoutSeconds must be 0 to clear or between ${MIN_MCP_TOOL_TIMEOUT_SECONDS} and ${MAX_MCP_TOOL_TIMEOUT_SECONDS}.`);
    }
  }
  delete next.type;
  return next;
}

/** Canonical semantic validator for a fully merged managed configuration. */
export function normalizeManagedMcpServerConfig(server: McpServerConfig): McpServerConfig {
  const normalized = sanitizeServerConfig(server);
  const transport = normalizeTransport(normalized);
  if (transport === 'stdio') {
    if (!normalized.command) throw new Error('MCP transport stdio requires command.');
  } else if (!normalized.url) {
    throw new Error(`MCP transport ${transport} requires url.`);
  }
  return normalized;
}

export function summarizeServerConfig(name: string, server: McpServerConfig): McpServerSummary {
  const normalized = sanitizeServerConfig(server);
  return {
    name,
    enabled: normalized.enable !== false,
    transport: normalizeTransport(normalized),
    ...(normalized.description ? { description: normalized.description } : {}),
    ...(normalized.url ? { url: normalized.url } : {}),
    ...(normalized.command ? { command: normalized.command } : {}),
    ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
    ...(normalized.stderr ? { stderr: normalized.stderr } : {}),
    argsCount: Array.isArray(normalized.args) ? normalized.args.length : 0,
    envKeys: normalized.env && typeof normalized.env === 'object'
      ? Object.keys(normalized.env).sort()
      : [],
    headerKeys: normalized.headers && typeof normalized.headers === 'object'
      ? Object.keys(normalized.headers).sort()
      : [],
    hasToken: Boolean(normalized.token),
    timeoutSeconds: normalized.timeoutSeconds ?? null,
  };
}

export function summarizeServers(servers: Record<string, McpServerConfig> | undefined | null): McpServerSummary[] {
  const entries = Object.entries(servers || {});
  return entries
    .map(([name, server]) => summarizeServerConfig(name, server))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cloneMcpConfig(config: McpConfig): McpConfig {
  return {
    servers: Object.fromEntries(
      Object.entries(config.servers || {}).map(([name, server]) => [name, {
        ...sanitizeServerConfig(server),
        ...(Array.isArray(server.args) ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
        ...(server.headers ? { headers: { ...server.headers } } : {}),
      }]),
    ),
  };
}

async function loadConfigFromStore(store: DiskJsonData<McpConfig>): Promise<McpConfig> {
  try {
    const loaded = await store.loadFirstAvailable();
    if (!loaded) return { servers: {} };
    if (loaded.source !== store.filePath) {
      logger.warn({ source: loaded.source }, 'Recovering MCP config from fallback source');
      await store.write(loaded.data);
    }
    return cloneMcpConfig(loaded.data);
  } catch (e) {
    throw new Error(`Failed to load MCP config: ${e}`);
  }
}

async function loadConfig(): Promise<McpConfig> {
  if (liveMcpConfig) {
    return liveMcpConfig;
  }

  const store = mcpConfigStore;
  if (!liveMcpConfigLoad) {
    liveMcpConfigLoad = loadConfigFromStore(store);
  }
  const pendingLoad = liveMcpConfigLoad;

  try {
    const loaded = await pendingLoad;
    if (store !== mcpConfigStore) {
      return loadConfig();
    }
    liveMcpConfig = loaded;
    return liveMcpConfig;
  } finally {
    if (store === mcpConfigStore && liveMcpConfigLoad === pendingLoad) {
      liveMcpConfigLoad = null;
    }
  }
}

async function saveConfig(config: McpConfig): Promise<void> {
  const store = mcpConfigStore;
  const nextConfig = cloneMcpConfig(config);
  await store.write(nextConfig);
  if (store === mcpConfigStore) {
    liveMcpConfig = nextConfig;
    liveMcpConfigLoad = null;
  }
}

function mutateConfig(mutator: (config: McpConfig) => void): Promise<void> {
  const operation = mcpConfigMutationQueue.then(async () => {
    const nextConfig = cloneMcpConfig(await loadConfig());
    mutator(nextConfig);
    await saveConfig(nextConfig);
  });
  mcpConfigMutationQueue = operation.catch(() => {});
  return operation;
}

async function getServerConfig(name?: string): Promise<{ name: string; config: McpServerConfig }> {
  const cfg = await loadConfig();
  const servers = cfg.servers || {};
  const fallbackName = name || 'default';
  const serverName = servers[fallbackName] ? fallbackName : Object.keys(servers)[0];
  if (!serverName) {
    throw new Error('No MCP servers configured. Discover the hidden mcp_config builtin with search_tools and invoke it through call_tool.');
  }
  const server = sanitizeServerConfig(servers[serverName]);
  if (server.enable === false) {
    throw new Error(`MCP server \"${serverName}\" is disabled.`);
  }
  return { name: serverName, config: server };
}

function getHeaders(config: McpServerConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  // The token supplies a default; an explicitly configured header wins.
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }

  if (config.headers && typeof config.headers === 'object') {
    for (const [key, value] of Object.entries(config.headers)) {
      if (config.token && key.toLowerCase() === 'authorization') {
        delete headers['Authorization'];
      }
      headers[key] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function buildMcpHttpHeadersForTests(config: McpServerConfig): Record<string, string> | undefined {
  return getHeaders(config);
}

export function setMcpSdkForTests(sdk: McpSdkModules | null): void {
  cachedMcpSdk = sdk;
}

export async function resetMcpConnectionsForTests(): Promise<void> {
  const entries = Array.from(stdioConnectionPool.values());
  stdioConnectionPool.clear();
  await Promise.all(entries.map(entry => closePooledStdioConnection(entry)));
  cachedMcpSdk = null;
}

function requireUrl(config: McpServerConfig, transport: McpTransport): string {
  if (!config.url) {
    throw new Error(`MCP transport ${transport} requires url.`);
  }
  return config.url;
}

function requireCommand(config: McpServerConfig): string {
  if (!config.command) {
    throw new Error('MCP transport stdio requires command.');
  }
  return config.command;
}

function buildStdioPoolKey(serverName: string, config: McpServerConfig): string {
  return `${serverName}::${JSON.stringify({
    command: config.command,
    args: config.args || [],
    env: config.env || {},
    cwd: config.cwd || '',
    stderr: config.stderr || 'inherit',
  })}`;
}

function clearStdioIdleTimer(entry: PooledStdioConnection) {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

async function closePooledStdioConnection(entry: PooledStdioConnection) {
  clearStdioIdleTimer(entry);
  entry.invalidated = true;
  stdioConnectionPool.delete(entry.poolKey);
  try {
    await entry.transport.close();
  } catch {
    // Ignore close errors during pool cleanup.
  }
}

function scheduleStdioIdleCleanup(entry: PooledStdioConnection) {
  clearStdioIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    closePooledStdioConnection(entry).catch(() => {
      // Ignore cleanup errors for idle pooled stdio connections.
    });
  }, STDIO_POOL_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
}

async function connectStreamableHttp(url: string, config: McpServerConfig): Promise<StandardConnection> {
  const { Client, StreamableHTTPClientTransport } = loadMcpSdk();
  const headers = getHeaders(config);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers,
    } as any,
  });
  const client = new Client({ name: 'foxwarm-mcp-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, transportKind: 'streamable-http' };
}

async function connectSse(url: string, config: McpServerConfig): Promise<StandardConnection> {
  const { Client, SSEClientTransport } = loadMcpSdk();
  const headers = getHeaders(config);
  const transport = new SSEClientTransport(new URL(url), {
    eventSourceInit: headers ? ({ headers } as any) : undefined,
    requestInit: headers ? ({ headers } as any) : undefined,
  });
  const client = new Client({ name: 'foxwarm-mcp-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, transportKind: 'sse' };
}

async function connectStdio(config: McpServerConfig): Promise<StandardConnection> {
  const { Client, StdioClientTransport } = loadMcpSdk();
  const transport = new StdioClientTransport({
    command: requireCommand(config),
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    stderr: config.stderr || 'inherit',
  });
  const client = new Client({ name: 'foxwarm-mcp-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, transportKind: 'stdio', pid: transport.pid };
}

async function getOrCreatePooledStdioConnection(serverName: string, config: McpServerConfig): Promise<PooledStdioConnection> {
  const poolKey = buildStdioPoolKey(serverName, config);
  const configSignature = poolKey;
  const existing = stdioConnectionPool.get(poolKey);

  if (existing && !existing.invalidated) {
    clearStdioIdleTimer(existing);
    existing.lastUsedAt = Date.now();
    if (existing.connectPromise) {
      const connected = await existing.connectPromise;
      connected.lastUsedAt = Date.now();
      return connected;
    }
    return existing;
  }

  const placeholder: PooledStdioConnection = {
    client: null,
    transport: { close: async () => {} },
    transportKind: 'stdio',
    poolKey,
    configSignature,
    lastUsedAt: Date.now(),
    invalidated: false,
  };

  placeholder.connectPromise = (async () => {
    const connection = await connectStdio(config);
    const pooled: PooledStdioConnection = {
      ...connection,
      poolKey,
      configSignature,
      lastUsedAt: Date.now(),
      invalidated: false,
    };

    connection.transport.onclose = () => {
      pooled.invalidated = true;
      clearStdioIdleTimer(pooled);
      if (stdioConnectionPool.get(poolKey) === pooled) {
        stdioConnectionPool.delete(poolKey);
      }
    };

    stdioConnectionPool.set(poolKey, pooled);
    return pooled;
  })();

  stdioConnectionPool.set(poolKey, placeholder);

  try {
    return await placeholder.connectPromise;
  } catch (error) {
    stdioConnectionPool.delete(poolKey);
    throw error;
  }
}

async function connectStandardTransport(config: McpServerConfig): Promise<StandardConnection> {
  const transport = normalizeTransport(config);

  if (transport === 'streamable-http') {
    return connectStreamableHttp(requireUrl(config, transport), config);
  }

  if (transport === 'sse') {
    return connectSse(requireUrl(config, transport), config);
  }

  if (transport === 'stdio') {
    return connectStdio(config);
  }

  if (transport === 'auto') {
    try {
      return await connectStreamableHttp(requireUrl(config, transport), config);
    } catch (streamableError: any) {
      try {
        return await connectSse(requireUrl(config, transport), config);
      } catch (sseError: any) {
        throw new Error(
          `Failed to connect MCP server using auto transport. Streamable HTTP error: ${streamableError?.message || streamableError}. SSE error: ${sseError?.message || sseError}`
        );
      }
    }
  }

  throw new Error(`Transport ${transport} is not a standard MCP transport.`);
}

async function withStandardConnection<T>(config: McpServerConfig, fn: (connection: StandardConnection) => Promise<T>): Promise<T> {
  const connection = await connectStandardTransport(config);
  try {
    return await fn(connection);
  } finally {
    try {
      await connection.transport.close();
    } catch {
      // Ignore close errors for short-lived MCP tool calls.
    }
  }
}

async function withServerConnection<T>(serverName: string, config: McpServerConfig, fn: (connection: StandardConnection) => Promise<T>): Promise<T> {
  if (normalizeTransport(config) !== 'stdio') {
    return withStandardConnection(config, fn);
  }

  const connection = await getOrCreatePooledStdioConnection(serverName, config);
  connection.lastUsedAt = Date.now();
  clearStdioIdleTimer(connection);
  try {
    return await fn(connection);
  } finally {
    connection.lastUsedAt = Date.now();
    if (!connection.invalidated) {
      scheduleStdioIdleCleanup(connection);
    }
  }
}

function tryParseJsonObjectOrArray(text: string): any | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const looksLikeJsonObjectOrArray = (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksLikeJsonObjectOrArray) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Keep non-JSON text as-is.
  }
  return undefined;
}

function isPlainTextContentBlock(content: any): content is { type: 'text'; text: string } {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return false;
  }
  const keys = Object.keys(content);
  return content.type === 'text'
    && typeof content.text === 'string'
    && keys.every(key => key === 'type' || key === 'text');
}

function hasPreservableMcpResultMetadata(result: Record<string, any>): boolean {
  for (const key of Object.keys(result)) {
    if (key === 'content') {
      continue;
    }
    if (key === 'isError' && result.isError !== true) {
      continue;
    }
    return true;
  }
  return false;
}

function normalizeMcpImageContent(result: Record<string, any>): Record<string, any> {
  if (!Array.isArray(result.content)) {
    return result;
  }

  const inlineDataItems: Array<Record<string, any>> = [];
  const remainingContent: any[] = [];
  for (const item of result.content) {
    const isImage = item
      && typeof item === 'object'
      && !Array.isArray(item)
      && item.type === 'image'
      && typeof item.data === 'string'
      && typeof item.mimeType === 'string'
      && item.mimeType.startsWith('image/');
    if (isImage) {
      const { type: _type, data, mimeType, ...metadata } = item;
      inlineDataItems.push({ ...metadata, data, mimeType });
    } else {
      remainingContent.push(item);
    }
  }

  if (inlineDataItems.length === 0) {
    return result;
  }

  const normalized = { ...result };
  if (remainingContent.length > 0) {
    normalized.content = remainingContent;
  } else {
    delete normalized.content;
  }
  normalized.inlineDataItems = [
    ...(Array.isArray(result.inlineDataItems) ? result.inlineDataItems : []),
    ...inlineDataItems,
  ];
  return normalized;
}

export function normalizeMcpToolResult(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  result = normalizeMcpImageContent(result);

  if (hasPreservableMcpResultMetadata(result)) {
    return result;
  }

  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1 || !isPlainTextContentBlock(content[0])) {
    return result;
  }

  const parsed = tryParseJsonObjectOrArray(content[0].text);
  return parsed !== undefined ? parsed : content[0].text;
}

export async function listTools(serverName?: string) {
  const { name, config } = await getServerConfig(serverName);
  return withServerConnection(name, config, async ({ client }) => {
    return await client.listTools();
  });
}

export async function callTool(serverName: string | undefined, tool: string, args?: Record<string, any>) {
  const { name, config } = await getServerConfig(serverName);
  return withServerConnection(name, config, async ({ client }) => {
    const params = { name: tool, arguments: args || {} };
    const result = config.timeoutSeconds === undefined
      ? await client.callTool(params)
      : await client.callTool(params, undefined, { timeout: config.timeoutSeconds * 1000 });
    return normalizeMcpToolResult(result);
  });
}

export async function upsertServer(name: string, server: McpServerConfig) {
  await mutateConfig((config) => {
    config.servers = config.servers || {};
    config.servers[name] = normalizeManagedMcpServerConfig({ ...config.servers[name], ...server });
  });
}

export async function setServerEnabled(name: string, enable: boolean) {
  await mutateConfig((config) => {
    config.servers = config.servers || {};
    if (!config.servers[name]) {
      throw new Error(`MCP server \"${name}\" not found.`);
    }
    config.servers[name].enable = enable;
  });
}

export async function getServers() {
  return cloneMcpConfig(await loadConfig()).servers;
}

export async function listServers() {
  const servers = await getServers();
  return summarizeServers(servers);
}
