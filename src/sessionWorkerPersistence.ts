import { RpcError } from './rpc';
import { captureSessionSemanticState, readSessionHistorySnapshot, restoreSessionSemanticState } from './session/metadataStore';
import { hydrateAuthoritativeSessionState } from './session/stateHydration';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { buildSessionRuntimeState, type SessionRuntimeState } from './sessionRuntimeState';
import { SessionWorkerMailboxIntent, SessionWorkerStore } from './sessionWorkerStore';
import type { SessionWorkerMainMutationClaim } from './sessionWorkerSupervisor';
import { applySessionWorkerMainOwnedCatalogPatch, type SessionWorkerCatalogCoordinator } from './sessionWorkerCatalog';
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
  mainOwned: {
    agent: string | null;
    aliases: string[] | null;
    parentSessionId: string | null;
    displayName: string | null;
    archived: boolean;
    pinned: boolean;
    sidebarOrder: number | null;
    lastChannel: Record<string, any> | null;
  };
};

export type SessionWorkerPersistenceDependencies = {
  readState?: (sessionId: string) => Promise<Record<string, any> | null>;
  writeState?: (session: Session, claim?: SessionWorkerMainMutationClaim) => Promise<void>;
  writeCatalogProjection?: (projection: SessionWorkerCatalogProjection, claim?: SessionWorkerMainMutationClaim) => Promise<void>;
  catalogCoordinator?: SessionWorkerCatalogCoordinator;
  catalogOwnerId?: string;
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
    mainOwned: {
      agent: session.agent || null,
      aliases: session.aliases || null,
      parentSessionId: session.parentSessionId || null,
      displayName: session.displayName || null,
      archived: !!session.archived,
      pinned: !!session.pinned,
      sidebarOrder: typeof session.sidebarOrder === 'number' ? session.sidebarOrder : null,
      lastChannel: session.meta?.lastChannel ? structuredClone(session.meta.lastChannel) : null,
    },
  });
}

/**
 * Save-before-ack coordinator for the authoritative per-session JSON.
 * It deliberately has no shared sessions.json writer; catalog updates are
 * bounded projections owned by main through the injected callback.
 */
export class SessionWorkerPersistence {
  private readonly readState: (sessionId: string) => Promise<Record<string, any> | null>;
  private readonly writeState: (session: Session, claim?: SessionWorkerMainMutationClaim) => Promise<void>;

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
    const target = this.detachCatalogStub(baseSession);
    const raw = await this.requireState(baseSession.id);
    const stateCursor = this.stateCursor(raw);
    this.store.reconcileActivatedMailboxCursor(baseSession.id, generation, incarnationId, stateCursor);
    const { session, imagesCanonicalized, upgradedLegacy } = await hydrateAuthoritativeSessionState(target, raw);
    // Legacy image/version canonicalization is a same-cursor rewrite. Cursor
    // recovery above is justified by the already-durable raw JSON payload.
    if (imagesCanonicalized || upgradedLegacy) await this.writeState(session);
    if (this.dependencies.catalogCoordinator && this.dependencies.catalogOwnerId) {
      this.dependencies.catalogCoordinator.registerWorker(
        session.id,
        this.dependencies.catalogOwnerId,
        buildSessionWorkerCatalogProjection(session),
      );
    }
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

    const beforeApply = captureSessionSemanticState(session);
    const nextCursor = intents[intents.length - 1].id;
    try {
      await apply(session, expected);
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

  async runMainMutation<T>(
    baseSession: Session,
    withWorkerQuiesced: <R>(sessionId: string, operation: (claim: SessionWorkerMainMutationClaim) => Promise<R>) => Promise<R>,
    mutate: (session: Session, signal: AbortSignal) => Promise<T>,
  ): Promise<{ result: T; session: Session; projection: SessionWorkerCatalogProjection }> {
    return withWorkerQuiesced(baseSession.id, async claim => {
      if (claim.sessionId !== baseSession.id) {
        throw new RpcError('SESSION_WORKER_STALE_MAIN_MUTATION', `Main mutation claim does not own ${baseSession.id}.`, true);
      }
      const coordinator = this.dependencies.catalogCoordinator;
      const ownerId = this.dependencies.catalogOwnerId;
      if (coordinator && ownerId) coordinator.beginMainMutation(baseSession.id, ownerId, claim.id);
      try {
        claim.assertActive('before authoritative reload');
        const session = await this.reloadInactive(baseSession, claim);
        claim.assertActive('after authoritative reload');
        const result = await mutate(session, claim.signal);
        claim.assertActive('after main mutation');
        const projection = await this.saveMainMutation(session, claim);
        claim.assertActive('before live catalog stub handoff');
        applySessionWorkerMainOwnedCatalogPatch(baseSession, projection);
        if (coordinator && ownerId) coordinator.finishMainMutation(baseSession.id, ownerId, claim.id, projection);
        return { result, session, projection };
      } catch (error) {
        if (coordinator && ownerId && coordinator.getOwnership(baseSession.id)?.mainClaimId === claim.id) {
          coordinator.cancelMainMutation(baseSession.id, ownerId, claim.id);
        }
        throw error;
      }
    });
  }

  private async reloadInactive(baseSession: Session, claim: SessionWorkerMainMutationClaim): Promise<Session> {
    const ownership = this.store.getOwnership(baseSession.id);
    if (ownership.state !== 'inactive' || ownership.incarnationId !== undefined || ownership.workerPid !== undefined) {
      throw new RpcError('SESSION_WORKER_OWNED', `Session ${baseSession.id} did not quiesce before main reload.`, true);
    }
    const target = this.detachCatalogStub(baseSession);
    const raw = await this.requireState(baseSession.id);
    this.store.reconcileInactiveMailboxCursor(baseSession.id, this.stateCursor(raw));
    const { session, imagesCanonicalized, upgradedLegacy } = await hydrateAuthoritativeSessionState(target, raw);
    claim.assertActive('after reload hydration');
    if (imagesCanonicalized || upgradedLegacy) {
      claim.assertActive('before upgraded state write');
      await this.writeState(session, claim);
    }
    return session;
  }

  private async saveMainMutation(session: Session, claim: SessionWorkerMainMutationClaim): Promise<SessionWorkerCatalogProjection> {
    claim.assertActive('before ownership validation');
    const ownership = this.store.getOwnership(session.id);
    if (ownership.state !== 'inactive' || ownership.incarnationId !== undefined || ownership.workerPid !== undefined) {
      throw new RpcError('SESSION_WORKER_OWNED', `Main cannot persist ${session.id} while a worker owns it.`, true);
    }
    claim.assertActive('before authoritative state write');
    await this.writeState(session, claim);
    claim.assertActive('before authoritative catalog write');
    try { return await this.publishProjection(session, claim); }
    catch (error: any) {
      throw new RpcError(
        'SESSION_WORKER_CATALOG_AFTER_STATE_FAILED',
        `Authoritative state for ${session.id} committed, but main catalog projection failed: ${error?.message || error}`,
        true,
        { stateCommitted: true, lastAppliedMailboxId: session.lastAppliedMailboxId || 0, causeCode: error?.code },
      );
    }
  }

  private async publishProjection(session: Session, claim?: SessionWorkerMainMutationClaim): Promise<SessionWorkerCatalogProjection> {
    const projection = buildSessionWorkerCatalogProjection(session);
    claim?.assertActive('before catalog projection callback');
    await this.dependencies.writeCatalogProjection?.(structuredClone(projection), claim);
    if (!claim && this.dependencies.catalogCoordinator && this.dependencies.catalogOwnerId) {
      this.dependencies.catalogCoordinator.updateWorker(session.id, this.dependencies.catalogOwnerId, projection);
    }
    return projection;
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
