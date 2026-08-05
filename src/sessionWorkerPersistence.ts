import { RpcError } from './rpc';
import { applySessionHistoryState, readSessionHistorySnapshot, serializeSessionHistoryPayload } from './session/metadataStore';
import { hydrateAuthoritativeSessionState } from './session/stateHydration';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { buildSessionRuntimeState, type SessionRuntimeState } from './sessionRuntimeState';
import { SessionWorkerMailboxIntent, SessionWorkerStore } from './sessionWorkerStore';
import type { Session, SessionStats } from './types';

export type SessionWorkerCatalogProjection = {
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
  childModelDefault: string | null;
  compactThresholdTokens: number | null;
};

export type SessionWorkerPersistenceDependencies = {
  readState?: (sessionId: string) => Promise<Record<string, any> | null>;
  writeState?: (session: Session) => Promise<void>;
  writeCatalogProjection?: (projection: SessionWorkerCatalogProjection) => Promise<void>;
};

export function buildSessionWorkerCatalogProjection(session: Session): SessionWorkerCatalogProjection {
  const lastMessage = session.history[session.history.length - 1];
  return structuredClone({
    sessionId: session.id,
    lastAppliedMailboxId: session.lastAppliedMailboxId || 0,
    busy: !!session.busy,
    busyStartedAt: typeof session.busyStartedAt === 'number' ? session.busyStartedAt : null,
    queueLength: session.queue.length,
    runtimeState: buildSessionRuntimeState(session),
    messageCount: session.meta?.messageCount ?? session.history.length,
    lastMessageTime: session.meta?.lastMessageTime
      ?? (typeof lastMessage?.__meta?.timestamp === 'number' ? lastMessage.__meta.timestamp : 0),
    stats: session.stats || { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    currentNode: session.currentNode || 'master',
    cwd: session.cwd || null,
    model: session.model || null,
    childModelDefault: session.childModelDefault || null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
  });
}

/**
 * Save-before-ack coordinator for the authoritative per-session JSON.
 * It deliberately has no shared sessions.json writer; catalog updates are
 * bounded projections owned by main through the injected callback.
 */
export class SessionWorkerPersistence {
  private readonly readState: (sessionId: string) => Promise<Record<string, any> | null>;
  private readonly writeState: (session: Session) => Promise<void>;

  constructor(
    private readonly store: SessionWorkerStore,
    private readonly dependencies: SessionWorkerPersistenceDependencies = {},
  ) {
    this.readState = dependencies.readState || readSessionHistorySnapshot;
    this.writeState = dependencies.writeState || writeAuthoritativeSessionState;
  }

  async loadActivated(
    baseSession: Session,
    generation: number,
    incarnationId: string,
  ): Promise<Session> {
    const raw = await this.requireState(baseSession.id);
    const stateCursor = this.stateCursor(raw);
    this.store.reconcileActivatedMailboxCursor(baseSession.id, generation, incarnationId, stateCursor);
    const { session, imagesCanonicalized } = await hydrateAuthoritativeSessionState(baseSession, raw);
    // A lazy image rewrite is itself authoritative state and must complete
    // before any lagging SQLite acknowledgement is advanced.
    if (imagesCanonicalized) await this.writeState(session);
    return session;
  }

  async applyAndPersistPrefix(
    session: Session,
    generation: number,
    incarnationId: string,
    intents: SessionWorkerMailboxIntent[],
    apply: (session: Session, intents: SessionWorkerMailboxIntent[]) => Promise<void> | void,
  ): Promise<SessionWorkerCatalogProjection> {
    const stateCursor = session.lastAppliedMailboxId || 0;
    const ownership = this.store.reconcileActivatedMailboxCursor(session.id, generation, incarnationId, stateCursor);
    if (!intents.length) return this.publishProjection(session);
    const expected = this.store.listPendingIntents(session.id, ownership.mailboxCursor, intents.length);
    if (expected.length !== intents.length
      || expected.some((intent, index) => intent.id !== intents[index].id)
      || intents.some(intent => intent.sessionId !== session.id)) {
      throw new RpcError('SESSION_WORKER_MAILBOX_CONFLICT', `Mailbox inputs for ${session.id} are not the exact ordered pending prefix.`);
    }

    const beforeApply = structuredClone(serializeSessionHistoryPayload(session));
    const previousCursor = session.lastAppliedMailboxId || 0;
    const nextCursor = intents[intents.length - 1].id;
    try {
      await apply(session, intents);
      session.lastAppliedMailboxId = nextCursor;
      // DiskJsonData resolves only after temp write, file fsync, rename, and
      // parent-directory fsync. SQLite acknowledgement is intentionally later.
      await this.writeState(session);
    } catch (error) {
      session.history = beforeApply.history;
      session.persistentMemorySnapshot = beforeApply.persistentMemorySnapshot || '';
      applySessionHistoryState(session, beforeApply);
      session.lastAppliedMailboxId = previousCursor;
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
    try { return await this.publishProjection(session); }
    catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_CATALOG_AFTER_ACK_FAILED',
        `Session ${session.id} state and mailbox ${nextCursor} acknowledgement committed, but catalog projection failed: ${error?.message || error}`,
        true,
        { stateCommitted: true, acknowledgementCommitted: true, lastAppliedMailboxId: nextCursor, causeCode: error?.code },
      );
    }
  }

  async quiesceAndReload(
    baseSession: Session,
    stopWorker: (sessionId: string) => Promise<unknown>,
  ): Promise<Session> {
    await stopWorker(baseSession.id);
    return this.reloadInactive(baseSession);
  }

  async runMainMutation<T>(
    baseSession: Session,
    withWorkerQuiesced: <R>(sessionId: string, operation: () => Promise<R>) => Promise<R>,
    mutate: (session: Session) => Promise<T>,
  ): Promise<{ result: T; session: Session; projection: SessionWorkerCatalogProjection }> {
    return withWorkerQuiesced(baseSession.id, async () => {
      const session = await this.reloadInactive(baseSession);
      const result = await mutate(session);
      const projection = await this.saveMainMutation(session);
      return { result, session, projection };
    });
  }

  private async reloadInactive(baseSession: Session): Promise<Session> {
    const ownership = this.store.getOwnership(baseSession.id);
    if (ownership.state !== 'inactive' || ownership.incarnationId !== undefined || ownership.workerPid !== undefined) {
      throw new RpcError('SESSION_WORKER_OWNED', `Session ${baseSession.id} did not quiesce before main reload.`, true);
    }
    const raw = await this.requireState(baseSession.id);
    this.store.reconcileInactiveMailboxCursor(baseSession.id, this.stateCursor(raw));
    const { session, imagesCanonicalized } = await hydrateAuthoritativeSessionState(baseSession, raw);
    if (imagesCanonicalized) await this.writeState(session);
    return session;
  }

  async saveMainMutation(session: Session): Promise<SessionWorkerCatalogProjection> {
    const ownership = this.store.getOwnership(session.id);
    if (ownership.state !== 'inactive' || ownership.incarnationId !== undefined || ownership.workerPid !== undefined) {
      throw new RpcError('SESSION_WORKER_OWNED', `Main cannot persist ${session.id} while a worker owns it.`, true);
    }
    await this.writeState(session);
    try { return await this.publishProjection(session); }
    catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_CATALOG_AFTER_STATE_FAILED',
        `Authoritative state for ${session.id} committed, but main catalog projection failed: ${error?.message || error}`,
        true,
        { stateCommitted: true, lastAppliedMailboxId: session.lastAppliedMailboxId || 0, causeCode: error?.code },
      );
    }
  }

  private async publishProjection(session: Session): Promise<SessionWorkerCatalogProjection> {
    const projection = buildSessionWorkerCatalogProjection(session);
    await this.dependencies.writeCatalogProjection?.(structuredClone(projection));
    return projection;
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
