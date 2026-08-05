import { RpcError } from './rpc';
import { loadSessionsMetadataSnapshot, withSessionsMetadataWriteLock, writeSessionsMetadataAtomically } from './session/metadataStore';
import type { SessionWorkerCatalogProjection } from './sessionWorkerPersistence';

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

/** Main-only catalog writer. A session worker must never import/call this path. */
export async function writeSessionWorkerCatalogProjection(
  projection: SessionWorkerCatalogProjection,
  dependencies: {
    load?: typeof loadSessionsMetadataSnapshot;
    write?: typeof writeSessionsMetadataAtomically;
  } = {},
): Promise<void> {
  const load = dependencies.load || loadSessionsMetadataSnapshot;
  const write = dependencies.write || writeSessionsMetadataAtomically;
  await withSessionsMetadataWriteLock(async () => {
    const { data } = await load();
    const sessions = data?.sessions && typeof data.sessions === 'object' ? data.sessions : {};
    const existing = sessions[projection.sessionId];
    if (!existing || typeof existing !== 'object') {
      throw new RpcError('SESSION_WORKER_CATALOG_MISSING', `Main catalog entry for ${projection.sessionId} is missing.`);
    }
    await write({
      ...data,
      sessions: {
        ...sessions,
        [projection.sessionId]: mergeSessionWorkerCatalogProjection(existing, projection),
      },
    });
  });
}
