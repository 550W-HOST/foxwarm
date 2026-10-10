import { logger } from './common';

export const MCP_NOTIFICATION_CAPABILITY = 'foxwarm/session-notifications';
export const MCP_SESSION_MESSAGE_METHOD = 'notifications/foxwarm/session_message';
export const MAX_MCP_NOTIFICATION_BYTES = 1024 * 1024 - 4096;
const PING_INTERVAL_MS = 5 * 60_000;

export type McpNotificationStatus = { server: string; state: 'receiving' | 'disconnected' | 'unavailable' | 'stopped' };
type Receiver = {
  sourceSessionId: string;
  server: string;
  state: McpNotificationStatus['state'];
  closed: boolean;
  enabled?: boolean;
  client?: any;
  transport?: any;
  ping?: NodeJS.Timeout;
  starting?: Promise<McpNotificationStatus>;
};
const receivers = new Map<string, Map<string, Receiver>>();

function find(sourceSessionId: string, server: string): Receiver | undefined {
  return receivers.get(sourceSessionId)?.get(server);
}
function status(entry: Receiver): McpNotificationStatus {
  return { server: entry.server, state: entry.state };
}
async function close(entry: Receiver, terminate = true): Promise<void> {
  entry.closed = true;
  entry.state = 'unavailable';
  if (entry.ping) clearInterval(entry.ping);
  if (terminate) await entry.transport?.terminateSession().catch(() => {});
  await entry.client?.close().catch(() => {});
}

export function getMcpNotificationStatus(sourceSessionId: string, server: string): McpNotificationStatus {
  const entry = find(sourceSessionId, server);
  return entry ? status(entry) : { server, state: 'stopped' };
}

/** Only the trusted Main facade chooses the source and supplies ordinary ingress. */
export async function startMcpNotifications(options: {
  sourceSessionId: string;
  server: string;
  url: string;
  headers?: Record<string, string>;
  assertActive: () => void;
  receive: (message: string, endpoint: string, assertLive: () => void) => Promise<void>;
}): Promise<McpNotificationStatus> {
  const existing = find(options.sourceSessionId, options.server);
  if (existing && !existing.closed) {
    if (existing.starting) return existing.starting;
    if (existing.state === 'receiving') return status(existing);
    await stopMcpNotifications(options.sourceSessionId, options.server);
    return startMcpNotifications(options);
  }
  const entry: Receiver = { sourceSessionId: options.sourceSessionId, server: options.server, state: 'disconnected', closed: false };
  let byServer = receivers.get(options.sourceSessionId);
  if (!byServer) receivers.set(options.sourceSessionId, byServer = new Map());
  byServer.set(options.server, entry);
  const assertLive = () => {
    if (entry.closed || find(entry.sourceSessionId, entry.server) !== entry) throw new Error('MCP notification receiver is unavailable.');
    options.assertActive();
  };
  entry.starting = (async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    let ready: () => void;
    let rejectReady: (error: Error) => void;
    const getReady = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    // The SDK launches GET asynchronously after initialized. Observe its real
    // response instead of treating connect() as proof of a receiving stream.
    const fetchReceiver: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET') {
        const response = await fetch(url, init?.method === 'DELETE'
          ? { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) } : init);
        if (init?.method !== 'DELETE' && [401, 403, 404].includes(response.status)) void close(entry, false);
        return response;
      }
      try {
        const response = await fetch(url, init);
        if (!response.ok || !response.body) {
          entry.state = 'disconnected';
          rejectReady(new Error('MCP notification stream is unavailable.'));
          if ([401, 403, 404, 405].includes(response.status)) void close(entry, false);
          return response;
        }
        assertLive();
        entry.state = 'receiving';
        ready();
        const reader = response.body.getReader();
        const disconnected = () => { if (!entry.closed) entry.state = 'disconnected'; };
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
        if (!entry.closed) entry.state = 'disconnected';
        rejectReady(new Error('MCP notification stream is unavailable.'));
        throw error;
      }
    };
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: options.headers }, fetch: fetchReceiver,
    });
    const client = new Client({ name: 'foxwarm-mcp-client', version: '1.0.0' }, {
      capabilities: { experimental: { [MCP_NOTIFICATION_CAPABILITY]: { version: 1 } } },
    });
    entry.client = client;
    entry.transport = transport;
    client.onerror = () => {}; // GET state is observed above; POST failures do not close the receiving stream.
    // The public fallback hook allows an application extension without replacing
    // the SDK's standard progress/cancellation handlers. Everything else is ignored.
    client.fallbackNotificationHandler = async (notification: any) => {
      if (!entry.enabled || notification.method !== MCP_SESSION_MESSAGE_METHOD) return;
      const params = notification.params;
      if (!params || Object.keys(params).some(key => !['message', 'endpoint'].includes(key))
        || typeof params.message !== 'string' || !params.message.trim()
        || Buffer.byteLength(params.message, 'utf8') > MAX_MCP_NOTIFICATION_BYTES
        || typeof params.endpoint !== 'string' || params.endpoint.length > 256) return;
      try {
        assertLive();
        await options.receive(params.message, params.endpoint, assertLive);
      } catch {
        logger.warn({ server: entry.server, sessionId: entry.sourceSessionId }, 'MCP notification was not admitted');
      }
    };
    const deadline = setTimeout(() => rejectReady(new Error('MCP notification stream did not become ready.')), 60_000);
    // Attach the handler before connect, since the asynchronous GET can fail first.
    getReady.catch(() => {});
    try {
      assertLive();
      await client.connect(transport);
      if (client.getServerCapabilities()?.experimental?.[MCP_NOTIFICATION_CAPABILITY]?.version !== 1) {
        throw new Error('MCP server does not support Foxwarm message notifications.');
      }
      await getReady;
      assertLive();
      entry.enabled = true;
      entry.ping = setInterval(() => {
        if (entry.closed) return;
        try { assertLive(); }
        catch { void close(entry); return; }
        void client.ping().catch(() => {});
      }, PING_INTERVAL_MS);
      entry.ping.unref();
      return status(entry);
    } catch (error) {
      await close(entry);
      throw error;
    } finally {
      clearTimeout(deadline);
      entry.starting = undefined;
    }
  })();
  return entry.starting;
}

export function getMcpReceivingClient(sourceSessionId: string | undefined, server: string): any | undefined {
  if (!sourceSessionId) return undefined;
  const entry = find(sourceSessionId, server);
  if (!entry) return undefined;
  if (entry.closed || entry.starting) throw new Error('MCP notification receiver is unavailable. Start it again before calling this server.');
  return entry.client;
}

export async function stopMcpNotifications(sourceSessionId: string, server: string): Promise<McpNotificationStatus> {
  const byServer = receivers.get(sourceSessionId);
  const entry = byServer?.get(server);
  if (entry) {
    // Fence first, before DELETE or any asynchronous close operation.
    entry.closed = true;
    byServer!.delete(server);
    if (!byServer!.size) receivers.delete(sourceSessionId);
    await close(entry);
  }
  return { server, state: 'stopped' };
}

export async function closeMcpNotificationReceivers(filter: { sourceSessionId?: string; server?: string } = {}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const [sourceSessionId, byServer] of receivers) {
    if (filter.sourceSessionId && filter.sourceSessionId !== sourceSessionId) continue;
    for (const server of byServer.keys()) {
      if (!filter.server || filter.server === server) pending.push(stopMcpNotifications(sourceSessionId, server));
    }
  }
  await Promise.allSettled(pending);
}
