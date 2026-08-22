import http from 'node:http';
import type { WebSocket } from 'ws';

export const WEBUI_REALTIME_PATH = '/api/webui/stream';
export const WEBUI_REALTIME_KEEPALIVE_MS = 30_000;
export const WEBUI_REALTIME_MAX_SUBSCRIPTIONS = 5_000;
const WEBUI_REALTIME_MAX_PENDING_EVENTS = 1_000;

export type WebUiRealtimeEnvelope = {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
};

type ResolvedRealtimeIds = {
  canonicalIds: string[];
  missingIds: string[];
  requestedToCanonical: Record<string, string>;
};

export type WebUiRealtimeSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'ping' | 'on'>;

export type WebUiRealtimeDependencies = {
  checkToken: (req: http.IncomingMessage) => boolean;
  resolveIds: (ids: string[]) => ResolvedRealtimeIds;
  loadSessionState: (canonicalSessionId: string) => Promise<WebUiRealtimeEnvelope>;
  loadSessionList: (requestedIds: string[]) => Promise<WebUiRealtimeEnvelope>;
  onSessionSubscriptionChanged?: (canonicalSessionId: string) => void;
  keepaliveIntervalMs?: number;
};

type WebUiRealtimeClient = {
  socket: WebUiRealtimeSocket;
  closed: boolean;
  listActive: boolean;
  listIds: Set<string>;
  sessionIds: Set<string>;
  revision: number;
  requestedRevision: number;
  initializing: boolean;
  pending: WebUiRealtimeEnvelope[];
  applyTail: Promise<void>;
  stopKeepalive: () => void;
};

type SetSubscriptionsMessage = {
  type: 'set-subscriptions';
  revision: number;
  sessionListActive: boolean;
  sessionListIds: string[];
  sessionIds: string[];
};

function normalizeIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > WEBUI_REALTIME_MAX_SUBSCRIPTIONS) {
    throw new Error(`${label} must contain at most ${WEBUI_REALTIME_MAX_SUBSCRIPTIONS} session IDs.`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 512) {
      throw new Error(`${label} contains an invalid session ID.`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function parseSetSubscriptions(raw: unknown): SetSubscriptionsMessage {
  if (!raw || typeof raw !== 'object' || (raw as any).type !== 'set-subscriptions') {
    throw new Error('Unsupported WebUI realtime message type.');
  }
  const revision = Number((raw as any).revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Subscription revision must be a positive integer.');
  }
  return {
    type: 'set-subscriptions',
    revision,
    sessionListActive: (raw as any).sessionListActive === true,
    sessionListIds: normalizeIds((raw as any).sessionListIds, 'sessionListIds'),
    sessionIds: normalizeIds((raw as any).sessionIds, 'sessionIds'),
  };
}

function socketIsOpen(socket: WebUiRealtimeSocket): boolean {
  return socket.readyState === 1;
}

/**
 * Owns the single multiplexed WebUI realtime protocol on the server.
 * Legacy SSE routes remain separate compatibility surfaces while the current
 * browser client uses one WebSocket per page.
 */
export class WebUiRealtimeHub {
  private readonly clients = new Set<WebUiRealtimeClient>();
  private readonly dependencies: WebUiRealtimeDependencies;

  constructor(dependencies: WebUiRealtimeDependencies) {
    this.dependencies = dependencies;
  }

  hasSessionSubscribers(sessionId: string): boolean {
    for (const client of this.clients) {
      if (!client.closed && client.sessionIds.has(sessionId)) return true;
    }
    return false;
  }

  getConnectionCount(): number {
    return this.clients.size;
  }

  async handleConnection(socket: WebUiRealtimeSocket, req: http.IncomingMessage): Promise<void> {
    if (!this.dependencies.checkToken(req)) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    const client: WebUiRealtimeClient = {
      socket,
      closed: false,
      listActive: false,
      listIds: new Set(),
      sessionIds: new Set(),
      revision: 0,
      requestedRevision: 0,
      initializing: false,
      pending: [],
      applyTail: Promise.resolve(),
      stopKeepalive: () => {},
    };
    this.clients.add(client);
    client.stopKeepalive = this.startKeepalive(client);

    const cleanup = () => this.cleanupClient(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', (raw: any) => {
      if (client.closed) return;
      let message: SetSubscriptionsMessage;
      try {
        message = parseSetSubscriptions(JSON.parse(raw.toString()));
      } catch (error) {
        this.safeSend(client, { type: 'protocol-error', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (message.revision <= client.requestedRevision) return;
      client.requestedRevision = message.revision;
      client.applyTail = client.applyTail.then(() => this.applySubscriptions(client, message)).catch((error) => this.failClientApply(client, error));
    });

    this.safeSend(client, { type: 'connected' });
  }

  broadcastSession(sessionId: string, payload: WebUiRealtimeEnvelope, closeAfter = false): void {
    for (const client of [...this.clients]) {
      if (!client.sessionIds.has(sessionId)) continue;
      this.deliver(client, { ...payload, sessionId });
      if (closeAfter) this.removeSessionSubscription(client, sessionId);
    }
  }

  broadcastSessionListDelta(sessionId: string, payload: WebUiRealtimeEnvelope): void {
    for (const client of this.clients) {
      if (!client.listActive || !client.listIds.has(sessionId)) continue;
      this.deliver(client, payload);
    }
  }

  broadcastSessionListInvalidation(payload: WebUiRealtimeEnvelope): void {
    for (const client of this.clients) {
      if (client.listActive) this.deliver(client, payload);
    }
  }

  private async applySubscriptions(client: WebUiRealtimeClient, message: SetSubscriptionsMessage): Promise<void> {
    if (client.closed || message.revision < client.requestedRevision || message.revision <= client.revision) return;

    const resolvedList = this.dependencies.resolveIds(message.sessionListIds);
    const resolvedSessions = this.dependencies.resolveIds(message.sessionIds);
    const previousSessionIds = client.sessionIds;
    client.revision = message.revision;
    client.listActive = message.sessionListActive;
    client.listIds = new Set([...message.sessionListIds, ...resolvedList.canonicalIds]);
    client.sessionIds = new Set(resolvedSessions.canonicalIds);
    client.initializing = true;
    client.pending = [];
    this.notifyChangedSessionSubscriptions(previousSessionIds, client.sessionIds);
    this.safeSend(client, {
      type: 'subscriptions-accepted',
      revision: message.revision,
      sessionListResolutions: resolvedList.requestedToCanonical,
      sessionResolutions: resolvedSessions.requestedToCanonical,
    });

    const revision = message.revision;
    const [listSnapshot, sessionSnapshots] = await Promise.all([
      message.sessionListActive
        ? this.dependencies.loadSessionList(message.sessionListIds)
        : Promise.resolve<WebUiRealtimeEnvelope | null>(null),
      Promise.all(resolvedSessions.canonicalIds.map(sessionId => this.dependencies.loadSessionState(sessionId))),
    ]);
    if (client.closed || client.revision !== revision || client.requestedRevision !== revision) {
      if (!client.closed && client.revision === revision) {
        client.initializing = false;
        client.pending = [];
      }
      return;
    }

    if (listSnapshot) this.safeSend(client, listSnapshot);
    for (const missingId of resolvedSessions.missingIds) {
      this.safeSend(client, { type: 'session-deleted', sessionId: missingId });
    }
    for (const snapshot of sessionSnapshots) this.safeSend(client, snapshot);
    client.initializing = false;
    const pending = client.pending;
    client.pending = [];
    for (const payload of pending) this.safeSend(client, payload);
    this.safeSend(client, { type: 'subscriptions-applied', revision });
  }

  private deliver(client: WebUiRealtimeClient, payload: WebUiRealtimeEnvelope): void {
    if (client.closed) return;
    if (!client.initializing) {
      this.safeSend(client, payload);
      return;
    }
    if (client.pending.length >= WEBUI_REALTIME_MAX_PENDING_EVENTS) {
      client.socket.close(1013, 'Realtime initialization overflow');
      this.cleanupClient(client);
      return;
    }
    client.pending.push(payload);
  }

  private safeSend(client: WebUiRealtimeClient, payload: WebUiRealtimeEnvelope): void {
    if (client.closed || !socketIsOpen(client.socket)) return;
    try {
      client.socket.send(JSON.stringify(payload));
    } catch {
      try { client.socket.close(1011, 'Realtime send failed'); } catch {}
      this.cleanupClient(client);
    }
  }

  private failClientApply(client: WebUiRealtimeClient, error: unknown): void {
    if (client.closed) return;
    client.initializing = false;
    client.pending = [];
    this.safeSend(client, { type: 'protocol-error', message: error instanceof Error ? error.message : String(error) });
    try { client.socket.close(1011, 'Realtime subscription failed'); } catch {}
    this.cleanupClient(client);
  }

  private startKeepalive(client: WebUiRealtimeClient): () => void {
    const timer = setInterval(() => {
      if (client.closed || !socketIsOpen(client.socket)) return;
      try {
        client.socket.ping();
      } catch {
        this.cleanupClient(client);
      }
    }, this.dependencies.keepaliveIntervalMs ?? WEBUI_REALTIME_KEEPALIVE_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private cleanupClient(client: WebUiRealtimeClient): void {
    if (client.closed) return;
    client.closed = true;
    client.stopKeepalive();
    this.clients.delete(client);
    const previousSessionIds = client.sessionIds;
    client.sessionIds = new Set();
    this.notifyChangedSessionSubscriptions(previousSessionIds, client.sessionIds);
  }

  private removeSessionSubscription(client: WebUiRealtimeClient, sessionId: string): void {
    if (!client.sessionIds.delete(sessionId)) return;
    this.dependencies.onSessionSubscriptionChanged?.(sessionId);
  }

  private notifyChangedSessionSubscriptions(previous: Set<string>, next: Set<string>): void {
    const changed = new Set<string>();
    for (const sessionId of previous) if (!next.has(sessionId)) changed.add(sessionId);
    for (const sessionId of next) if (!previous.has(sessionId)) changed.add(sessionId);
    for (const sessionId of changed) this.dependencies.onSessionSubscriptionChanged?.(sessionId);
  }
}
