import { logger } from './common';

export const MCP_NOTIFICATION_CAPABILITY = 'foxwarm/session-notifications';
export const MCP_SESSION_MESSAGE_METHOD = 'notifications/foxwarm/session_message';
export const MAX_MCP_NOTIFICATION_BYTES = 1024 * 1024 - 4096;
const PING_INTERVAL_MS = 5 * 60_000;
const HTTP_IDLE_MS = 15 * 60_000;

export type McpConnectionOwner = { kind: 'session' | 'external'; id: string; isActive(): boolean };
export type McpNotificationStatus = { server: string; state: 'receiving' | 'disconnected' | 'unavailable' | 'stopped' };
export type McpConnectionOptions = {
  owner?: McpConnectionOwner;
  server: string;
  mode: 'streamable-http' | 'sse' | 'auto';
  url: string;
  headers?: Record<string, string>;
  sdk: { Client: any; StreamableHTTPClientTransport: any; SSEClientTransport: any };
};
type Reception = {
  assertActive(): Promise<void>;
  receive(message: string, endpoint: string, assertLive: () => void): Promise<void>;
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export type McpCallerConnection = {
  options: McpConnectionOptions;
  client?: any;
  transport?: any;
  transportKind?: 'streamable-http' | 'sse';
  setup?: Promise<void>;
  closing?: Promise<void>;
  closed: boolean;
  active: number;
  idle?: NodeJS.Timeout;
  ping?: NodeJS.Timeout;
  receiving: boolean;
  getReady: ReturnType<typeof deferred>;
  getError?: Error;
  reception?: Reception;
  enabling?: Promise<McpNotificationStatus>;
};
const connections = new Map<string, Map<string, McpCallerConnection>>();
function key(owner: McpConnectionOwner) { return `${owner.kind}:${owner.id}`; }
function current(entry: McpCallerConnection) {
  const owner = entry.options.owner;
  return !entry.closed && (!owner || (owner.isActive() && connections.get(key(owner))?.get(entry.options.server) === entry));
}
function assertLive(entry: McpCallerConnection) {
  if (!current(entry)) throw new Error('MCP caller connection is unavailable. A new connection does not retain the previous remote context.');
}
function notificationStatus(entry: McpCallerConnection): McpNotificationStatus {
  return { server: entry.options.server, state: !entry.reception && !entry.enabling ? 'stopped' : entry.closed ? 'unavailable' : entry.receiving ? 'receiving' : 'disconnected' };
}

async function dispose(entry: McpCallerConnection, terminate = true): Promise<void> {
  if (entry.closing) return entry.closing;
  entry.closed = true;
  entry.reception = undefined;
  if (entry.idle) clearTimeout(entry.idle);
  if (entry.ping) clearInterval(entry.ping);
  entry.getReady.reject(new Error('MCP caller connection is closed.'));
  const owner = entry.options.owner;
  if (owner) {
    const byServer = connections.get(key(owner));
    if (byServer?.get(entry.options.server) === entry) byServer.delete(entry.options.server);
    if (!byServer?.size) connections.delete(key(owner));
  }
  entry.closing = (async () => {
    // SSE has no Streamable HTTP session DELETE operation.
    if (terminate && entry.transportKind === 'streamable-http') {
      await entry.transport?.terminateSession?.().catch(() => {});
    }
    await entry.client?.close().catch(() => {});
  })();
  return entry.closing;
}
function scheduleIdle(entry: McpCallerConnection) {
  if (entry.closed || entry.active || entry.reception) return;
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => { void dispose(entry); }, HTTP_IDLE_MS);
  entry.idle.unref();
}

async function connect(entry: McpCallerConnection, kind: 'streamable-http' | 'sse') {
  const { sdk, url, headers, owner } = entry.options;
  entry.transportKind = kind;
  const disconnected = () => {
    if (entry.receiving) entry.getReady = deferred();
    entry.receiving = false;
  };
  const fetchConnection: typeof fetch = async (input, init) => {
    const get = init?.method === 'GET';
    try {
      const response = await fetch(input, init?.method === 'DELETE'
        ? { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) } : init);
      if (init?.method !== 'DELETE' && entry.transport?.sessionId && [401, 403, 404].includes(response.status)) void dispose(entry, false);
      if (!get) return response;
      if (!response.ok || !response.body) {
        disconnected();
        entry.getError = new Error('MCP notification stream is unavailable.');
        entry.getReady.reject(entry.getError);
        return response;
      }
      assertLive(entry);
      entry.receiving = true;
      entry.getError = undefined;
      entry.getReady.resolve();
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { disconnected(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { disconnected(); controller.error(error); }
        },
        cancel(reason) { disconnected(); return reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (get) disconnected();
      throw error;
    }
  };
  const transport = kind === 'streamable-http'
    ? new sdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: fetchConnection })
    : new sdk.SSEClientTransport(new URL(url), { eventSourceInit: headers ? { headers } : undefined, requestInit: headers ? { headers } : undefined });
  const client = new sdk.Client({ name: 'foxwarm-mcp-client', version: '1.0.0' }, {
    // Support is negotiated now; local delivery remains opt-in. External owners
    // have no internal receiving Session and do not claim this client capability.
    capabilities: owner?.kind === 'session' ? { experimental: { [MCP_NOTIFICATION_CAPABILITY]: { version: 1 } } } : {},
  });
  entry.client = client;
  entry.transport = transport;
  client.onerror = () => {}; // GET state is observed independently of POST/tool errors.
  client.fallbackNotificationHandler = async (notification: any) => {
    const reception = entry.reception;
    if (!reception || notification.method !== MCP_SESSION_MESSAGE_METHOD) return;
    const params = notification.params;
    if (!params || Object.keys(params).some(field => !['message', 'endpoint'].includes(field))
      || typeof params.message !== 'string' || !params.message.trim()
      || Buffer.byteLength(params.message, 'utf8') > MAX_MCP_NOTIFICATION_BYTES
      || typeof params.endpoint !== 'string' || params.endpoint.length > 256) return;
    const assertReception = () => {
      assertLive(entry);
      if (entry.reception !== reception) throw new Error('MCP notification reception is stopped.');
    };
    try { await reception.assertActive(); assertReception(); await reception.receive(params.message, params.endpoint, assertReception); }
    catch { logger.warn({ server: entry.options.server }, 'MCP notification was not admitted'); }
  };
  assertLive(entry);
  await client.connect(transport);
  assertLive(entry);
  client.onclose = () => { if (!entry.closed) void dispose(entry, false); };
}
async function setup(entry: McpCallerConnection) {
  const mode = entry.options.mode;
  if (mode !== 'auto') return connect(entry, mode);
  try { await connect(entry, 'streamable-http'); }
  catch (streamableError) {
    if (!current(entry)) throw streamableError;
    // Failed initialization may already have allocated a remote HTTP context.
    await entry.transport?.terminateSession?.().catch(() => {});
    await entry.client?.close().catch(() => {});
    assertLive(entry);
    await connect(entry, 'sse');
  }
}

export async function withMcpCallerConnection<T>(options: McpConnectionOptions, fn: (entry: McpCallerConnection) => Promise<T>): Promise<T> {
  const owner = options.owner;
  if (owner && !owner.isActive()) throw new Error('MCP connection owner is unavailable.');
  let byServer = owner ? connections.get(key(owner)) : undefined;
  let entry = byServer?.get(options.server);
  if (!entry) {
    entry = { options, closed: false, active: 0, receiving: false, getReady: deferred() };
    if (owner) {
      if (!byServer) connections.set(key(owner), byServer = new Map());
      byServer.set(options.server, entry);
    }
    const created = entry;
    entry.setup = setup(entry).catch(async error => { await dispose(created); throw error; });
  }
  if (entry.idle) clearTimeout(entry.idle);
  entry.active++;
  try {
    await entry.setup;
    assertLive(entry);
    return await fn(entry);
  } finally {
    entry.active--;
    if (!owner) await dispose(entry);
    else scheduleIdle(entry);
  }
}

export function getMcpNotificationStatus(owner: McpConnectionOwner, server: string): McpNotificationStatus {
  const entry = connections.get(key(owner))?.get(server);
  return entry ? notificationStatus(entry) : { server, state: 'stopped' };
}
export async function startMcpNotifications(options: McpConnectionOptions & Reception): Promise<McpNotificationStatus> {
  if (options.owner?.kind !== 'session' || options.mode !== 'streamable-http') throw new Error('Notifications require a Session-owned Streamable HTTP connection.');
  await options.assertActive();
  return withMcpCallerConnection(options, async entry => {
    if (entry.reception && entry.receiving) { await entry.reception.assertActive(); return notificationStatus(entry); }
    if (entry.enabling) return entry.enabling;
    entry.enabling = (async () => {
      let deadline: NodeJS.Timeout;
      try {
        if (entry.client.getServerCapabilities()?.experimental?.[MCP_NOTIFICATION_CAPABILITY]?.version !== 1) {
          throw new Error('MCP server does not support Foxwarm message notifications.');
        }
        if (!entry.receiving) {
          if (entry.getError) throw entry.getError;
          await Promise.race([entry.getReady.promise, new Promise<void>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('MCP notification stream did not become ready.')), 60_000);
          })]);
        }
        assertLive(entry);
        await options.assertActive();
        assertLive(entry);
        const reception: Reception = {
          async assertActive() {
            assertLive(entry);
            await options.assertActive();
            assertLive(entry);
            if (entry.reception !== reception) throw new Error('MCP notification reception is stopped.');
          },
          receive: options.receive,
        };
        entry.reception = reception;
        if (!entry.ping) {
          entry.ping = setInterval(() => {
            if (entry.closed || !entry.reception) return;
            if (!current(entry)) { void dispose(entry); return; }
            void entry.reception.assertActive().then(() => entry.client.ping().catch(() => {}), () => { void dispose(entry); });
          }, PING_INTERVAL_MS);
          entry.ping.unref();
        }
        return notificationStatus(entry);
      } finally { clearTimeout(deadline); }
    })();
    try { return await entry.enabling; }
    finally { entry.enabling = undefined; }
  });
}
export async function stopMcpNotifications(owner: McpConnectionOwner, server: string): Promise<McpNotificationStatus> {
  const entry = connections.get(key(owner))?.get(server);
  if (entry) await dispose(entry);
  return { server, state: 'stopped' };
}
export async function closeMcpCallerConnections(filter: { ownerKind?: McpConnectionOwner['kind']; ownerId?: string; server?: string; notificationsOnly?: boolean } = {}): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const byServer of connections.values()) {
    for (const entry of byServer.values()) {
      const owner = entry.options.owner!;
      if ((filter.ownerKind && owner.kind !== filter.ownerKind) || (filter.ownerId && owner.id !== filter.ownerId)
        || (filter.server && entry.options.server !== filter.server) || (filter.notificationsOnly && !entry.reception)) continue;
      pending.push(dispose(entry));
    }
  }
  await Promise.allSettled(pending);
}
