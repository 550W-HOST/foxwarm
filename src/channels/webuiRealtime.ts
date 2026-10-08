import http from 'node:http';
import type { WebSocket } from 'ws';
import type { HttpAuthContext } from '../httpServer';
import { LOG_SOCKET_BUFFER_BYTES, type LogSubscription } from './webuiLogs';

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

export type WebUiRealtimeSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'ping' | 'on'> & { bufferedAmount?: number };

export type WebUiRealtimeDependencies = {
  checkToken: (req: http.IncomingMessage) => boolean;
  getAuthContext?: (req: http.IncomingMessage) => Promise<HttpAuthContext | null>;
  resolveIds: (ids: string[]) => ResolvedRealtimeIds;
  loadSessionState: (canonicalSessionId: string) => Promise<WebUiRealtimeEnvelope>;
  loadModelStreamSnapshot?: (canonicalSessionId: string) => Promise<WebUiRealtimeEnvelope>;
  loadSessionList: (requestedIds: string[]) => Promise<WebUiRealtimeEnvelope>;
  onSessionSubscriptionChanged?: (canonicalSessionId: string) => void | Promise<void>;
  subscribeLogs?: (request: LogSubscription, emit: (message: WebUiRealtimeEnvelope) => void, canSend: () => boolean) => () => void;
  keepaliveIntervalMs?: number;
};

type WebUiRealtimeClient = {
  socket: WebUiRealtimeSocket;
  auth: HttpAuthContext;
  request: http.IncomingMessage;
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
  logsId?: string;
  stopLogs?: () => void;
};

type SetSubscriptionsMessage = {
  type: 'set-subscriptions';
  revision: number;
  sessionListActive: boolean;
  sessionListIds: string[];
  sessionIds: string[];
  logs?: LogSubscription;
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

function parseLogSubscription(raw: any): LogSubscription | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) throw new Error('Invalid logs subscription.');
  if (raw.cursor !== undefined && (!raw.cursor || typeof raw.cursor.fileId !== 'string' || !raw.cursor.fileId || raw.cursor.fileId.length > 256 || !Number.isSafeInteger(raw.cursor.offset) || raw.cursor.offset < 0)) throw new Error('Invalid logs cursor.');
  return { id: raw.id, ...(raw.cursor ? { cursor: { fileId: raw.cursor.fileId, offset: raw.cursor.offset } } : {}) };
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
    logs: parseLogSubscription((raw as any).logs),
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

  private resolvedWebUiBindings(auth: Extract<HttpAuthContext, { role: 'webui' }>): Set<string> {
    const canonical = new Set<string>();
    for (let index = 0; index < auth.sessionIds.length; index += 200) {
      for (const id of this.dependencies.resolveIds(auth.sessionIds.slice(index, index + 200)).canonicalIds) canonical.add(id);
    }
    return canonical;
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
    const auth = this.dependencies.getAuthContext
      ? await this.dependencies.getAuthContext(req)
      : this.dependencies.checkToken(req) ? { role: 'admin' as const } : null;
    if (!auth) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    const client: WebUiRealtimeClient = {
      socket,
      auth,
      request: req,
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

  dispose(): void {
    for (const client of [...this.clients]) {
      try { client.socket.close(1001, 'WebUI channel stopped'); } catch {}
      this.cleanupClient(client);
    }
  }

  private async applySubscriptions(client: WebUiRealtimeClient, message: SetSubscriptionsMessage): Promise<void> {
    if (client.closed || message.revision < client.requestedRevision || message.revision <= client.revision) return;

    if (this.dependencies.getAuthContext) {
      const fresh = await this.dependencies.getAuthContext(client.request);
      if (!fresh || (client.auth.role === 'webui' && (fresh.role !== 'webui' || fresh.identityId !== client.auth.identityId))) {
        throw new Error('Realtime credentials are no longer valid.');
      }
      client.auth = fresh;
    }
    if (message.logs && !this.dependencies.subscribeLogs) throw new Error('Logs are unavailable.');
    if (client.logsId !== message.logs?.id) { client.stopLogs?.(); client.stopLogs = undefined; client.logsId = undefined; }
    const resolvedList = this.dependencies.resolveIds(message.sessionListIds);
    const resolvedSessions = this.dependencies.resolveIds(message.sessionIds);
    if (client.auth.role === 'webui') {
      const allowed = this.resolvedWebUiBindings(client.auth);
      // The WebUI identity UI never subscribes to the catalog. Reject rather than
      // filtering to prevent list snapshots or invalidations leaking topology.
      if (message.sessionListActive || message.sessionListIds.length
        || message.sessionIds.some(id => !resolvedSessions.requestedToCanonical[id]
          || !allowed.has(resolvedSessions.requestedToCanonical[id]))) {
        throw new Error('WebUI subscription is not bound to this session.');
      }
    }
    const previousSessionIds = client.sessionIds;
    const carriesSupersededInitialization = client.initializing;
    client.revision = message.revision;
    client.listActive = message.sessionListActive;
    client.listIds = new Set([...message.sessionListIds, ...resolvedList.canonicalIds]);
    client.sessionIds = new Set(resolvedSessions.canonicalIds);
    client.initializing = true;
    if (!carriesSupersededInitialization) client.pending = [];
    await this.notifyChangedSessionSubscriptions(previousSessionIds, client.sessionIds);
    this.safeSend(client, {
      type: 'subscriptions-accepted',
      revision: message.revision,
      sessionListResolutions: resolvedList.requestedToCanonical,
      sessionResolutions: resolvedSessions.requestedToCanonical,
    });

    const revision = message.revision;
    const [listSnapshot, sessionSnapshots, streamSnapshots] = await Promise.all([
      message.sessionListActive
        ? this.dependencies.loadSessionList(message.sessionListIds)
        : Promise.resolve<WebUiRealtimeEnvelope | null>(null),
      Promise.all(resolvedSessions.canonicalIds.map(sessionId => this.dependencies.loadSessionState(sessionId))),
      this.dependencies.loadModelStreamSnapshot
        ? Promise.all(resolvedSessions.canonicalIds.map(sessionId => this.dependencies.loadModelStreamSnapshot!(sessionId)))
        : Promise.resolve([]),
    ]);
    if (client.closed || client.revision !== revision || client.requestedRevision !== revision) {
      return;
    }
    if (client.auth.role === 'webui') {
      const latest = this.dependencies.resolveIds(message.sessionIds);
      const allowed = this.resolvedWebUiBindings(client.auth);
      if (message.sessionIds.some(id => !latest.requestedToCanonical[id]
        || !allowed.has(latest.requestedToCanonical[id])
        || latest.requestedToCanonical[id] !== resolvedSessions.requestedToCanonical[id])
        || sessionSnapshots.some((snapshot, index) => snapshot.type === 'session-state'
          && (snapshot.session as { id?: string } | undefined)?.id !== resolvedSessions.canonicalIds[index])) {
        throw new Error('WebUI session binding changed during subscription.');
      }
    }

    if (listSnapshot) this.safeSend(client, listSnapshot);
    for (const missingId of resolvedSessions.missingIds) {
      this.safeSend(client, { type: 'session-deleted', sessionId: missingId });
    }
    for (const snapshot of sessionSnapshots) this.safeSend(client, snapshot);
    for (const snapshot of streamSnapshots) this.safeSend(client, snapshot);
    client.initializing = false;
    const pending = client.pending;
    client.pending = [];
    for (const payload of pending) this.safeSend(client, payload);
    this.safeSend(client, { type: 'subscriptions-applied', revision });
    if (message.logs && !client.logsId && !client.closed) {
      client.logsId = message.logs.id;
      client.stopLogs = this.dependencies.subscribeLogs!(message.logs, payload => {
        if (payload.logsId === client.logsId) this.safeSend(client, payload);
      }, () => !client.closed && socketIsOpen(client.socket) && (client.socket.bufferedAmount || 0) < LOG_SOCKET_BUFFER_BYTES);
    }
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
    let checking = false;
    const timer = setInterval(() => {
      if (client.closed || !socketIsOpen(client.socket)) return;
      const ping = () => {
        if (client.closed || !socketIsOpen(client.socket)) return;
        try { client.socket.ping(); } catch { this.cleanupClient(client); }
      };
      if (client.auth.role !== 'webui' || !this.dependencies.getAuthContext) return ping();
      const identityId = client.auth.identityId;
      if (checking) return;
      checking = true;
      void this.dependencies.getAuthContext(client.request).then(auth => {
        if (client.closed) return;
        if (auth?.role !== 'webui' || auth.identityId !== identityId) {
          try { client.socket.close(1008, 'Unauthorized'); } catch {}
          this.cleanupClient(client);
          return;
        }
        const bound = this.resolvedWebUiBindings(auth);
        if ([...client.sessionIds].some(id => {
          const current = this.dependencies.resolveIds([id]).requestedToCanonical[id];
          return !current || !bound.has(current) || current !== id;
        })) {
          // The old canonical stream has ended. Reconnect so its requested ID
          // can resolve through the committed alias to the new canonical ID.
          try { client.socket.close(1012, 'Session identity changed'); } catch {}
          this.cleanupClient(client);
          return;
        }
        client.auth = auth;
        ping();
      }).catch(() => {
        try { client.socket.close(1008, 'Unauthorized'); } catch {}
        this.cleanupClient(client);
      }).finally(() => { checking = false; });
    }, this.dependencies.keepaliveIntervalMs ?? WEBUI_REALTIME_KEEPALIVE_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private cleanupClient(client: WebUiRealtimeClient): void {
    if (client.closed) return;
    client.closed = true;
    client.stopKeepalive();
    client.stopLogs?.();
    client.stopLogs = undefined;
    client.logsId = undefined;
    this.clients.delete(client);
    const previousSessionIds = client.sessionIds;
    client.sessionIds = new Set();
    void this.notifyChangedSessionSubscriptions(previousSessionIds, client.sessionIds);
  }

  private removeSessionSubscription(client: WebUiRealtimeClient, sessionId: string): void {
    if (!client.sessionIds.delete(sessionId)) return;
    void this.dependencies.onSessionSubscriptionChanged?.(sessionId);
  }

  private async notifyChangedSessionSubscriptions(previous: Set<string>, next: Set<string>): Promise<void> {
    const changed = new Set<string>();
    for (const sessionId of previous) if (!next.has(sessionId)) changed.add(sessionId);
    for (const sessionId of next) if (!previous.has(sessionId)) changed.add(sessionId);
    await Promise.all([...changed].map(sessionId => this.dependencies.onSessionSubscriptionChanged?.(sessionId)));
  }
}
