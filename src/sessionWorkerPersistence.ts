import { RpcError } from './rpc';
import { captureSessionSemanticState, readSessionHistorySnapshot, restoreSessionSemanticState } from './session/metadataStore';
import { hydrateAuthoritativeSessionState } from './session/stateHydration';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { buildSessionRuntimeState, type SessionRuntimeState } from './sessionRuntimeState';
import { SessionWorkerMailboxIntent, SessionWorkerStore } from './sessionWorkerStore';
import type { Session, SessionStats } from './types';
import type { ModelEffort } from './config';

/** Small read-only DTO for a future main-owned delivery path. It owns no catalog write protocol. */
export type SessionWorkerProjection = {
  sessionId: string;
  lastAppliedMailboxId: number;
  busy: boolean;
  busyStartedAt: number | null;
  queueLength: number;
  runtimeState: SessionRuntimeState;
  messageCount: number;
  lastMessageTime: number;
  stats: SessionStats;
  currentNode: string;
  cwd: string | null;
  model: string | null;
  effort: ModelEffort | null;
  childModelDefault: string | null;
  childEffortDefault: ModelEffort | null;
  compactThresholdTokens: number | null;
  verbose?: boolean;
};

export type SessionWorkerPersistenceDependencies = {
  readState?: (sessionId: string) => Promise<Record<string, any> | null>;
  writeState?: (session: Session) => Promise<void>;
};

export function buildSessionWorkerProjection(session: Session): SessionWorkerProjection {
  const lastMessage = session.history[session.history.length - 1];
  const runtimeState = buildSessionRuntimeState(session);
  return JSON.parse(JSON.stringify({
    sessionId: session.id,
    lastAppliedMailboxId: session.lastAppliedMailboxId || 0,
    busy: !!session.busy,
    busyStartedAt: typeof session.busyStartedAt === 'number' ? session.busyStartedAt : null,
    queueLength: session.queue.length,
    runtimeState: { ...runtimeState, busy: !!session.busy, queueLength: session.queue.length },
    messageCount: session.meta?.messageCount ?? session.history.length,
    lastMessageTime: session.meta?.lastMessageTime
      ?? (typeof lastMessage?.__meta?.timestamp === 'number' ? lastMessage.__meta.timestamp : 0),
    stats: session.stats || { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    currentNode: session.currentNode || 'master',
    cwd: session.cwd || null,
    model: session.model || null,
    effort: session.effort || null,
    childModelDefault: session.childModelDefault || null,
    childEffortDefault: session.childEffortDefault || null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
    verbose: !!session.verbose,
  }));
}

/** Authoritative per-session JSON save-before-ack coordinator. */
export class SessionWorkerPersistence {
  private readonly readState: (sessionId: string) => Promise<Record<string, any> | null>;
  private readonly writeState: (session: Session) => Promise<void>;

  constructor(
    private readonly store: SessionWorkerStore,
    dependencies: SessionWorkerPersistenceDependencies = {},
  ) {
    this.readState = dependencies.readState || readSessionHistorySnapshot;
    this.writeState = dependencies.writeState || writeAuthoritativeSessionState;
  }

  async loadActivated(
    baseSession: Session,
    generation: number,
    incarnationId: string,
  ): Promise<Session> {
    const target = this.detachCatalogStub(baseSession);
    const raw = await this.requireState(baseSession.id);
    const stateCursor = this.stateCursor(raw);
    this.store.reconcileActivatedMailboxCursor(baseSession.id, generation, incarnationId, stateCursor);
    const { session, imagesCanonicalized, upgradedLegacy } = await hydrateAuthoritativeSessionState(target, raw, {
      preserveCatalogFields: true, adoptAuthorityDisplayNameWhenMissing: true,
    });
    // Legacy image/version canonicalization is a same-cursor rewrite. Cursor
    // recovery above is justified by the already-durable raw JSON payload.
    if (imagesCanonicalized || upgradedLegacy) await this.writeState(session);
    return session;
  }

  async persistActivated(
    session: Session,
    generation: number,
    incarnationId: string,
  ): Promise<SessionWorkerProjection> {
    this.store.reconcileActivatedMailboxCursor(
      session.id,
      generation,
      incarnationId,
      session.lastAppliedMailboxId || 0,
    );
    await this.writeState(session);
    return buildSessionWorkerProjection(session);
  }

  async reloadActivated(
    session: Session,
    generation: number,
    incarnationId: string,
  ): Promise<SessionWorkerProjection> {
    const raw = await this.requireState(session.id);
    this.store.reconcileActivatedMailboxCursor(session.id, generation, incarnationId, this.stateCursor(raw));
    const hydrated = await hydrateAuthoritativeSessionState(session, raw, {
      preserveCatalogFields: true, adoptAuthorityDisplayNameWhenMissing: true,
    });
    if (hydrated.imagesCanonicalized || hydrated.upgradedLegacy) await this.writeState(session);
    return buildSessionWorkerProjection(session);
  }

  /**
   * Read and apply the next canonical pending prefix. Callers choose only a
   * bounded count; intent rows and payloads always come from SQLite.
   */
  async applyAndPersistPendingPrefix(
    session: Session,
    generation: number,
    incarnationId: string,
    limit: number,
    apply: (session: Session, intents: SessionWorkerMailboxIntent[]) => Promise<void> | void,
    upToId?: number,
  ): Promise<SessionWorkerProjection> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) {
      throw new RpcError('SESSION_WORKER_MAILBOX_LIMIT', 'Mailbox prefix limit must be an integer from 1 through 4096.');
    }
    const stateCursor = session.lastAppliedMailboxId || 0;
    const ownership = this.store.reconcileActivatedMailboxCursor(session.id, generation, incarnationId, stateCursor);
    const intents = this.store.listPendingIntents(session.id, ownership.mailboxCursor, limit, upToId);
    if (!intents.length) return buildSessionWorkerProjection(session);

    const beforeApply = captureSessionSemanticState(session);
    const nextCursor = intents[intents.length - 1].id;
    try {
      await apply(session, intents);
      session.lastAppliedMailboxId = nextCursor;
      // DiskJsonData resolves only after temp write, file fsync, rename, and
      // parent-directory fsync. SQLite acknowledgement is intentionally later.
      await this.writeState(session);
    } catch (error) {
      restoreSessionSemanticState(session, beforeApply);
      throw error;
    }
    try {
      this.store.acknowledgeMailboxPrefix({
        sessionId: session.id,
        generation,
        incarnationId,
        expectedCursor: ownership.mailboxCursor,
        upToId: nextCursor,
      });
    } catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_ACK_AFTER_STATE_FAILED',
        `Authoritative state for ${session.id} committed through mailbox ${nextCursor}, but SQLite acknowledgement failed: ${error?.message || error}`,
        true,
        { stateCommitted: true, lastAppliedMailboxId: nextCursor, causeCode: error?.code },
      );
    }
    return buildSessionWorkerProjection(session);
  }

  private detachCatalogStub(baseSession: Session): Session {
    return {
      id: baseSession.id,
      history: [],
      persistentMemorySnapshot: '',
      stats: structuredClone(baseSession.stats),
      busy: false,
      queue: [],
      meta: structuredClone(baseSession.meta),
      ...(baseSession.agent === undefined ? {} : { agent: baseSession.agent }),
      ...(baseSession.aliases === undefined ? {} : { aliases: structuredClone(baseSession.aliases) }),
      ...(baseSession.parentSessionId === undefined ? {} : { parentSessionId: baseSession.parentSessionId }),
      ...(baseSession.displayName === undefined ? {} : { displayName: baseSession.displayName }),
      ...(baseSession.vectorIndexPosition === undefined ? {} : { vectorIndexPosition: baseSession.vectorIndexPosition }),
      ...(baseSession.archived === undefined ? {} : { archived: baseSession.archived }),
      ...(baseSession.pinned === undefined ? {} : { pinned: baseSession.pinned }),
      ...(baseSession.sidebarOrder === undefined ? {} : { sidebarOrder: baseSession.sidebarOrder }),
      ...(baseSession.broadcast === undefined ? {} : { broadcast: baseSession.broadcast }),
    };
  }

  private async requireState(sessionId: string): Promise<Record<string, any>> {
    const state = await this.readState(sessionId);
    if (!state) throw new RpcError('SESSION_WORKER_STATE_MISSING', `Authoritative session state ${sessionId}.json is missing.`);
    return state;
  }

  private stateCursor(state: Record<string, any>): number {
    return Number.isSafeInteger(state.lastAppliedMailboxId) && state.lastAppliedMailboxId >= 0
      ? state.lastAppliedMailboxId
      : 0;
  }
}
