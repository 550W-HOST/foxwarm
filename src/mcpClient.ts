import fs from 'fs-extra';
import { MCP_CONFIG_PATH, STATE_DIR } from './config';

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
  enable?: boolean;
  transport?: McpTransport;
  type?: string;
};

export type McpConfig = {
  servers: Record<string, McpServerConfig>;
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
const STDIO_POOL_IDLE_TTL_MS = 60_000;
const stdioConnectionPool = new Map<string, PooledStdioConnection>();

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
  delete next.type;
  return next;
}

async function loadConfig(): Promise<McpConfig> {
  try {
    const exists = await fs.pathExists(MCP_CONFIG_PATH);
    if (!exists) return { servers: {} };
    const raw = await fs.readFile(MCP_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed.servers || {};
    const normalizedServers = Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [name, sanitizeServerConfig(server as McpServerConfig)])
    );
    return { servers: normalizedServers };
  } catch (e) {
    throw new Error(`Failed to load MCP config: ${e}`);
  }
}

async function saveConfig(config: McpConfig) {
  await fs.ensureDir(STATE_DIR);
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getServerConfig(name?: string): Promise<{ name: string; config: McpServerConfig }> {
  const cfg = await loadConfig();
  const servers = cfg.servers || {};
  const fallbackName = name || 'default';
  const serverName = servers[fallbackName] ? fallbackName : Object.keys(servers)[0];
  if (!serverName) {
    throw new Error('No MCP servers configured. Use mcp_config to add one.');
  }
  const server = sanitizeServerConfig(servers[serverName]);
  if (server.enable === false) {
    throw new Error(`MCP server \"${serverName}\" is disabled.`);
  }
  return { name: serverName, config: server };
}

function getHeaders(config: McpServerConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  
  // Add custom headers first
  if (config.headers && typeof config.headers === 'object') {
    Object.assign(headers, config.headers);
  }
  
  // Add Authorization header from token (can be overridden by custom headers)
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }
  
  return Object.keys(headers).length > 0 ? headers : undefined;
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

export async function listTools(serverName?: string) {
  const { name, config } = await getServerConfig(serverName);
  return withServerConnection(name, config, async ({ client, transportKind }) => {
    const result = await client.listTools();
    return {
      ...result,
      _transport: transportKind,
    };
  });
}

export async function callTool(serverName: string | undefined, tool: string, args?: Record<string, any>) {
  const { name, config } = await getServerConfig(serverName);
  return withServerConnection(name, config, async ({ client, transportKind }) => {
    const result = await client.callTool({ name: tool, arguments: args || {} });
    return {
      ...result,
      _transport: transportKind,
    };
  });
}

export async function upsertServer(name: string, server: McpServerConfig) {
  const cfg = await loadConfig();
  cfg.servers = cfg.servers || {};
  cfg.servers[name] = sanitizeServerConfig({ ...cfg.servers[name], ...server });
  await saveConfig(cfg);
}

export async function setServerEnabled(name: string, enable: boolean) {
  const cfg = await loadConfig();
  cfg.servers = cfg.servers || {};
  if (!cfg.servers[name]) {
    throw new Error(`MCP server \"${name}\" not found.`);
  }
  cfg.servers[name].enable = enable;
  await saveConfig(cfg);
}

export async function getServers() {
  const cfg = await loadConfig();
  return cfg.servers || {};
}
