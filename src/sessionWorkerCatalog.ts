import { isDeepStrictEqual } from 'node:util';
import { RpcError } from './rpc';
import { captureSessionSemanticState, loadSessionsMetadataSnapshot, replaceSessionSemanticState, withSessionsMetadataWriteLock, writeSessionsMetadataAtomically } from './session/metadataStore';
import type { SessionWorkerCatalogProjection } from './sessionWorkerPersistence';
import type { SessionWorkerMainMutationClaim } from './sessionWorkerSupervisor';
import { buildSessionRuntimeState } from './sessionRuntimeState';
import type { Session } from './types';

const MAIN_OWNED_CATALOG_FIELDS = [
  'id', 'agent', 'aliases', 'parentSessionId', 'displayName', 'archived', 'pinned', 'sidebarOrder',
] as const;

type WorkerCatalogOwnership = {
  ownerId: string;
  projection: SessionWorkerCatalogProjection;
  mainClaimId?: string;
};

export class SessionWorkerCatalogCoordinator {
  private readonly ownerships = new Map<string, WorkerCatalogOwnership>();

  registerWorker(sessionId: string, ownerId: string, projection: SessionWorkerCatalogProjection): void {
    const existing = this.ownerships.get(sessionId);
    if (existing && existing.ownerId !== ownerId) {
      throw new RpcError('SESSION_WORKER_CATALOG_OWNED', `Catalog projection for ${sessionId} is owned by another placement.`, true);
    }
    this.ownerships.set(sessionId, { ownerId, projection: structuredClone(projection) });
  }

  updateWorker(sessionId: string, ownerId: string, projection: SessionWorkerCatalogProjection): void {
    const existing = this.requireOwner(sessionId, ownerId);
    this.ownerships.set(sessionId, { ...existing, projection: structuredClone(projection) });
  }

  beginMainMutation(sessionId: string, ownerId: string, claimId: string): void {
    const existing = this.requireOwner(sessionId, ownerId);
    if (existing.mainClaimId && existing.mainClaimId !== claimId) {
      throw new RpcError('SESSION_WORKER_CATALOG_CLAIMED', `Catalog projection for ${sessionId} already has a main mutation claim.`, true);
    }
    existing.mainClaimId = claimId;
  }

  finishMainMutation(
    sessionId: string,
    ownerId: string,
    claimId: string,
    projection?: SessionWorkerCatalogProjection,
  ): void {
    const existing = this.requireOwner(sessionId, ownerId);
    if (existing.mainClaimId !== claimId) throw new RpcError('SESSION_WORKER_CATALOG_STALE_CLAIM', `Main catalog claim for ${sessionId} is stale.`, true);
    this.ownerships.set(sessionId, {
      ownerId,
      projection: structuredClone(projection || existing.projection),
    });
  }

  cancelMainMutation(sessionId: string, ownerId: string, claimId: string): void {
    const existing = this.requireOwner(sessionId, ownerId);
    if (existing.mainClaimId !== claimId) throw new RpcError('SESSION_WORKER_CATALOG_STALE_CLAIM', `Main catalog claim for ${sessionId} is stale.`, true);
    delete existing.mainClaimId;
  }

  releaseWorker(sessionId: string, ownerId: string, handoff?: {
    mainStub: Session;
    reconciledSession: Session;
    projection: SessionWorkerCatalogProjection;
  }): void {
    const existing = this.requireOwner(sessionId, ownerId);
    if (existing.mainClaimId) {
      throw new RpcError('SESSION_WORKER_CATALOG_CLAIMED', `Cannot release catalog ownership for ${sessionId} during a main mutation.`, true);
    }
    if (!handoff || handoff.mainStub.id !== sessionId || handoff.reconciledSession.id !== sessionId || handoff.projection.sessionId !== sessionId) {
      throw new RpcError('SESSION_WORKER_CATALOG_HANDOFF', `Catalog release handoff does not match ${sessionId}.`, true);
    }
    if (!isDeepStrictEqual(existing.projection, handoff.projection)) {
      throw new RpcError('SESSION_WORKER_CATALOG_HANDOFF', `Catalog release handoff for ${sessionId} is not the latest registered projection.`, true);
    }
    if (!projectionMatchesSession(handoff.projection, handoff.reconciledSession)) {
      throw new RpcError('SESSION_WORKER_CATALOG_HANDOFF', `Catalog release handoff for ${sessionId} does not match reconciled authoritative state.`, true);
    }
    const reconciled = captureSessionSemanticState(handoff.reconciledSession);
    replaceSessionSemanticState(handoff.mainStub, reconciled);
    applySessionWorkerMainOwnedCatalogPatch(handoff.mainStub, handoff.projection);
    this.ownerships.delete(sessionId);
  }

  mergeFullSave(sessionId: string, latest: Record<string, any> | undefined, incoming: Record<string, any>): Record<string, any> {
    const ownership = this.ownerships.get(sessionId);
    if (!ownership) return structuredClone(incoming);
    const mainMerged = structuredClone(latest || {});
    for (const field of MAIN_OWNED_CATALOG_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(incoming, field)) mainMerged[field] = structuredClone(incoming[field]);
      else delete mainMerged[field];
    }
    const latestMeta = latest?.meta && typeof latest.meta === 'object' ? latest.meta : {};
    const incomingMeta = incoming.meta && typeof incoming.meta === 'object' ? incoming.meta : {};
    mainMerged.meta = { ...latestMeta };
    if (Object.prototype.hasOwnProperty.call(incomingMeta, 'lastChannel')) {
      mainMerged.meta.lastChannel = structuredClone(incomingMeta.lastChannel);
    } else {
      delete mainMerged.meta.lastChannel;
    }
    if (ownership.mainClaimId) applySessionWorkerMainOwnedCatalogPatch(mainMerged, ownership.projection);
    return mergeSessionWorkerCatalogProjection(mainMerged, ownership.projection);
  }

  getOwnership(sessionId: string): Readonly<WorkerCatalogOwnership> | undefined {
    const value = this.ownerships.get(sessionId);
    return value ? structuredClone(value) : undefined;
  }

  isWorkerOwned(sessionId: string): boolean { return this.ownerships.has(sessionId); }

  assertWorkerOwner(sessionId: string, ownerId: string): void { this.requireOwner(sessionId, ownerId); }

  private requireOwner(sessionId: string, ownerId: string): WorkerCatalogOwnership {
    const existing = this.ownerships.get(sessionId);
    if (!existing || existing.ownerId !== ownerId) {
      throw new RpcError('SESSION_WORKER_CATALOG_STALE_OWNER', `Catalog projection owner for ${sessionId} is stale.`, true);
    }
    return existing;
  }
}

export const sessionWorkerCatalogCoordinator = new SessionWorkerCatalogCoordinator();

function projectionMatchesSession(projection: SessionWorkerCatalogProjection, session: Session): boolean {
  const lastMessage = session.history[session.history.length - 1];
  return projection.sessionId === session.id
    && projection.lastAppliedMailboxId === (session.lastAppliedMailboxId || 0)
    && isDeepStrictEqual(projection.stats, session.stats || { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null })
    && projection.busy === !!session.busy
    && projection.busyStartedAt === (typeof session.busyStartedAt === 'number' ? session.busyStartedAt : null)
    && projection.lastMessageTime === (session.meta?.lastMessageTime
      ?? (typeof lastMessage?.__meta?.timestamp === 'number' ? lastMessage.__meta.timestamp : 0))
    && projection.messageCount === (session.meta?.messageCount ?? session.history.length)
    && projection.queueLength === (session.queue?.length || 0)
    && isDeepStrictEqual(projection.runtimeState, buildSessionRuntimeState(session))
    && projection.currentNode === (session.currentNode || 'master')
    && projection.cwd === (session.cwd || null)
    && projection.model === (session.model || null)
    && projection.childModelDefault === (session.childModelDefault || null)
    && projection.compactThresholdTokens === (typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null)
    && isDeepStrictEqual(projection.mainOwned, {
      agent: session.agent || null,
      aliases: session.aliases || null,
      parentSessionId: session.parentSessionId || null,
      displayName: session.displayName || null,
      archived: !!session.archived,
      pinned: !!session.pinned,
      sidebarOrder: typeof session.sidebarOrder === 'number' ? session.sidebarOrder : null,
      lastChannel: session.meta?.lastChannel ? structuredClone(session.meta.lastChannel) : null,
    });
}

/** Merge only bounded worker-owned presentation state, preserving main-owned topology/UI fields. */
export function mergeSessionWorkerCatalogProjection(
  existing: Record<string, any>,
  projection: SessionWorkerCatalogProjection,
): Record<string, any> {
  const { queue: _staleFullQueue, ...catalog } = existing;
  const { wait: _staleWait, managedSession: _staleManaged, ...mainMeta } =
    existing.meta && typeof existing.meta === 'object' ? existing.meta : {};
  return {
    ...catalog,
    busy: projection.busy,
    ...(projection.busyStartedAt === null ? { busyStartedAt: undefined } : { busyStartedAt: projection.busyStartedAt }),
    stats: structuredClone(projection.stats),
    currentNode: projection.currentNode,
    ...(projection.cwd === null ? { cwd: undefined } : { cwd: projection.cwd }),
    ...(projection.model === null ? { model: undefined } : { model: projection.model }),
    ...(projection.childModelDefault === null ? { childModelDefault: undefined } : { childModelDefault: projection.childModelDefault }),
    ...(projection.compactThresholdTokens === null
      ? { compactThresholdTokens: undefined }
      : { compactThresholdTokens: projection.compactThresholdTokens }),
    meta: {
      ...mainMeta,
      lastMessageTime: projection.lastMessageTime,
      messageCount: projection.messageCount,
      workerQueueLength: projection.queueLength,
      workerRuntimeState: structuredClone(projection.runtimeState),
    },
  };
}

export function applySessionWorkerMainOwnedCatalogPatch(
  target: any,
  projection: SessionWorkerCatalogProjection,
): Record<string, any> {
  const values: Record<string, unknown> = {
    agent: projection.mainOwned.agent,
    aliases: projection.mainOwned.aliases,
    parentSessionId: projection.mainOwned.parentSessionId,
    displayName: projection.mainOwned.displayName,
    sidebarOrder: projection.mainOwned.sidebarOrder,
  };
  for (const [field, value] of Object.entries(values)) {
    if (value === null) delete target[field]; else target[field] = structuredClone(value);
  }
  target.archived = projection.mainOwned.archived;
  target.pinned = projection.mainOwned.pinned;
  target.meta = target.meta && typeof target.meta === 'object' ? target.meta : {};
  if (projection.mainOwned.lastChannel === null) delete target.meta.lastChannel;
  else target.meta.lastChannel = structuredClone(projection.mainOwned.lastChannel);
  return target;
}

/** Main-only catalog writer. A session worker must never import/call this path. */
export async function writeSessionWorkerCatalogProjection(
  projection: SessionWorkerCatalogProjection,
  dependencies: {
    load?: typeof loadSessionsMetadataSnapshot;
    write?: typeof writeSessionsMetadataAtomically;
    coordinator?: SessionWorkerCatalogCoordinator;
    ownerId?: string;
    claim?: SessionWorkerMainMutationClaim;
  } = {},
): Promise<void> {
  const load = dependencies.load || loadSessionsMetadataSnapshot;
  const write = dependencies.write || writeSessionsMetadataAtomically;
  dependencies.claim?.assertActive('before catalog projection ownership update');
  if (dependencies.coordinator && dependencies.ownerId) {
    dependencies.coordinator.assertWorkerOwner(projection.sessionId, dependencies.ownerId);
  }
  await withSessionsMetadataWriteLock(async () => {
    const { data } = await load();
    const sessions = data?.sessions && typeof data.sessions === 'object' ? data.sessions : {};
    const existing = sessions[projection.sessionId];
    if (!existing || typeof existing !== 'object') {
      throw new RpcError('SESSION_WORKER_CATALOG_MISSING', `Main catalog entry for ${projection.sessionId} is missing.`);
    }
    dependencies.claim?.assertActive('before serialized catalog write');
    const projectionBase = dependencies.claim
      ? applySessionWorkerMainOwnedCatalogPatch(structuredClone(existing), projection)
      : existing;
    await write({
      ...data,
      sessions: {
        ...sessions,
        [projection.sessionId]: mergeSessionWorkerCatalogProjection(projectionBase, projection),
      },
    }, dependencies.claim ? () => dependencies.claim!.assertActive('before catalog-file rename') : undefined);
    if (dependencies.coordinator && dependencies.ownerId) {
      dependencies.coordinator.updateWorker(projection.sessionId, dependencies.ownerId, projection);
    }
  });
}
