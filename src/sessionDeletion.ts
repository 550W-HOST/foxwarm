import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';

export type SessionDeletionResult =
  | { status: 'not-found'; requestedSessionId: string }
  | {
    status: 'busy';
    includeDescendants: boolean;
    busySessionIds: string[];
    droppedQueueItems: number;
    abortedInFlightCount: number;
    message: string;
  }
  | {
    status: 'deleted';
    includeDescendants: boolean;
    deletedCount: number;
    deletedSessionIds: string[];
    detachedChildSessionIds: string[];
  };

export class SessionDeletionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'SessionDeletionError';
  }
}

type ActiveCrossSessionDeletion = {
  operationId: number;
  sourceSessionId: string;
  targetSessionId: string;
};

let nextCrossSessionDeletionOperationId = 1;
const activeCrossSessionDeletionBySession = new Map<string, ActiveCrossSessionDeletion>();
let beforeCrossSessionDeletionAdmissionForTests: ((selection: {
  sourceSessionId: string;
  targetSessionIds: string[];
}) => void | Promise<void>) | undefined;

export function setBeforeCrossSessionDeletionAdmissionForTests(
  hook?: (selection: { sourceSessionId: string; targetSessionIds: string[] }) => void | Promise<void>,
): void {
  beforeCrossSessionDeletionAdmissionForTests = hook;
}

function acquireCrossSessionDeletionAdmission(
  sourceSessionId: string,
  targetSessionIds: string[],
): () => void {
  const involvedSessionIds = [...new Set([sourceSessionId, ...targetSessionIds])];
  const conflictingSessionId = involvedSessionIds.find(sessionId => activeCrossSessionDeletionBySession.has(sessionId));
  if (conflictingSessionId) {
    const conflict = activeCrossSessionDeletionBySession.get(conflictingSessionId)!;
    throw new SessionDeletionError(
      'Another cross-session deletion involving the source or target is already in progress. Retry after that operation finishes.',
      'SESSION_DELETE_CONFLICT',
      409,
      {
        sourceSessionId,
        targetSessionId: targetSessionIds[0],
        conflictingSessionId,
        conflictingSourceSessionId: conflict.sourceSessionId,
        conflictingTargetSessionId: conflict.targetSessionId,
      },
      true,
    );
  }

  const admission: ActiveCrossSessionDeletion = {
    operationId: nextCrossSessionDeletionOperationId++,
    sourceSessionId,
    targetSessionId: targetSessionIds[0],
  };
  for (const sessionId of involvedSessionIds) activeCrossSessionDeletionBySession.set(sessionId, admission);
  return () => {
    for (const sessionId of involvedSessionIds) {
      if (activeCrossSessionDeletionBySession.get(sessionId)?.operationId === admission.operationId) {
        activeCrossSessionDeletionBySession.delete(sessionId);
      }
    }
  };
}

export type SessionDeletionOptions = {
  requestedSessionId: string;
  sourceSessionId?: string;
  includeDescendants?: boolean;
  /** Operation-specific source-generation fence, used only by Worker reverse deletion. */
  assertSourceCurrent?: () => void | Promise<void>;
  /** Test-only pause between preparation and graph/state revalidation. */
  beforeRevalidateForTests?: (selection: {
    rootSessionId: string;
    includeDescendants: boolean;
    targetSessionIds: string[];
  }) => void | Promise<void>;
  /** Test-only pause after revalidation and before any final relation/delete mutation. */
  beforeFinalMutationForTests?: (selection: {
    rootSessionId: string;
    includeDescendants: boolean;
    targetSessionIds: string[];
  }) => void | Promise<void>;
};

function haveSameSessionIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((sessionId, index) => sessionId === right[index]);
}

function channelBlockers(sessionIds: string[]) {
  return sessionIds.flatMap(sessionId => sessionManager
    .getChannelsBySession(sessionId)
    .filter(channel => channel.channelId !== 'webui')
    .map(channel => ({ sessionId, ...channel })));
}

function treeChanged(
  includeDescendants: boolean,
  details: Record<string, unknown> = {},
): SessionDeletionError {
  return new SessionDeletionError(
    'The canonical session tree changed while preparing deletion. Retry the delete request.',
    'SESSION_DELETE_TREE_CHANGED',
    409,
    { includeDescendants, ...details },
  );
}

/**
 * One Main-owned, operation-specific deletion flow shared by WebUI, commands,
 * and model tools. It owns graph selection/claim/revalidation, blockers,
 * exact-Worker teardown through sessionManager's delete hook, child detachment,
 * and final live-record cleanup. It is intentionally not a generic lifecycle
 * executor and does not recursively delete unless includeDescendants is true.
 */
export async function deleteSessionLifecycle(options: SessionDeletionOptions): Promise<SessionDeletionResult> {
  const requestedSessionId = typeof options.requestedSessionId === 'string'
    ? options.requestedSessionId
    : '';
  if (!requestedSessionId.trim()) {
    throw new SessionDeletionError('Session ID is required.', 'SESSION_DELETE_INVALID', 400);
  }
  const includeDescendants = options.includeDescendants === true;
  await options.assertSourceCurrent?.();

  const rootSession = sessionManager.getSessionCatalog(requestedSessionId);
  if (!rootSession) return { status: 'not-found', requestedSessionId };
  let sourceSessionId: string | undefined;
  if (options.sourceSessionId) {
    const source = sessionManager.getSessionCatalog(options.sourceSessionId);
    if (!source) {
      throw new SessionDeletionError('Source session was not found.', 'SESSION_DELETE_SOURCE_NOT_FOUND', 404);
    }
    if (source.id === rootSession.id) {
      throw new SessionDeletionError(
        'Cannot delete current session. Use /clear to clear history or switch to another session first.',
        'SESSION_DELETE_CURRENT',
        400,
      );
    }
    sourceSessionId = source.id;
  }

  const relationTree = includeDescendants
    ? sessionManager.collectSessionDescendants(rootSession.id)
    : undefined;
  const directChildSessionIds = relationTree?.directChildIds
    || sessionManager.getCanonicalChildSessionIds(rootSession.id);
  const targetSessionIds = relationTree
    ? [rootSession.id, ...relationTree.descendantIds]
    : [rootSession.id];
  const postOrderSessionIds = relationTree?.postOrderIds || [rootSession.id];
  const claimSessionIds = includeDescendants
    ? targetSessionIds
    : [rootSession.id, ...directChildSessionIds];
  if (sourceSessionId) {
    await beforeCrossSessionDeletionAdmissionForTests?.({
      sourceSessionId,
      targetSessionIds: [...targetSessionIds],
    });
    await options.assertSourceCurrent?.();
  }
  const releaseCrossSessionAdmission = sourceSessionId
    ? acquireCrossSessionDeletionAdmission(sourceSessionId, targetSessionIds)
    : () => {};
  let claimId: string | undefined;

  try {
    claimId = (await sessionManager.claimSessionsForDestructiveLifecycle(claimSessionIds)).claimId;
    const blockers = channelBlockers(targetSessionIds);
    if (blockers.length > 0) {
      throw new SessionDeletionError(
        'Cannot delete session tree while one or more sessions have non-WebUI channels attached. Detach those channels and retry.',
        'SESSION_DELETE_CHANNEL_BLOCKED',
        409,
        {
          includeDescendants,
          blockingSessionIds: [...new Set(blockers.map(blocker => blocker.sessionId))],
          blockingChannels: blockers,
        },
      );
    }

    // Preparation may interrupt/hand back an exact Worker target, so recheck
    // the fixed reverse source generation immediately before this first effect.
    const prepResults = [];
    for (const sessionId of targetSessionIds) {
      try {
        await options.assertSourceCurrent?.();
        prepResults.push(await sessionManager.prepareSessionForDestructiveAction(sessionId));
      } catch (error: any) {
        if (!sessionManager.getSessionCatalog(sessionId)) throw treeChanged(includeDescendants);
        throw error;
      }
    }
    const busySessionIds = prepResults
      .filter(result => result.requiresRetry)
      .map(result => result.session.id);
    if (busySessionIds.length > 0) {
      const droppedQueueItems = prepResults.reduce((sum, result) => sum + result.droppedQueueItems, 0);
      const abortedInFlightCount = prepResults.filter(result => result.abortedInFlight).length;
      const queueNote = droppedQueueItems > 0
        ? ` Cleared ${droppedQueueItems} queued item(s).`
        : '';
      const stopNote = abortedInFlightCount > 0
        ? ` Aborted ${abortedInFlightCount} in-flight LLM request(s); other running tools will stop after their current call.`
        : ' Running tools will stop after their current call.';
      return {
        status: 'busy', includeDescendants, busySessionIds, droppedQueueItems, abortedInFlightCount,
        message: `Session tree contains busy sessions. Stop signals sent.${stopNote}${queueNote} Retry delete after every listed session becomes idle.`,
      };
    }

    await options.beforeRevalidateForTests?.({
      rootSessionId: rootSession.id,
      includeDescendants,
      targetSessionIds: [...targetSessionIds],
    });

    const currentRootSession = sessionManager.getSessionCatalog(rootSession.id);
    if (!currentRootSession) throw treeChanged(includeDescendants);
    const currentRelationTree = includeDescendants
      ? sessionManager.collectSessionDescendants(currentRootSession.id)
      : undefined;
    const currentDirectChildSessionIds = currentRelationTree?.directChildIds
      || sessionManager.getCanonicalChildSessionIds(currentRootSession.id);
    const currentTargetSessionIds = currentRelationTree
      ? [currentRootSession.id, ...currentRelationTree.descendantIds]
      : [currentRootSession.id];
    const currentPostOrderSessionIds = currentRelationTree?.postOrderIds || [currentRootSession.id];
    if (!haveSameSessionIds(currentTargetSessionIds, targetSessionIds)
      || !haveSameSessionIds(currentPostOrderSessionIds, postOrderSessionIds)
      || !haveSameSessionIds(currentDirectChildSessionIds, directChildSessionIds)) {
      throw treeChanged(includeDescendants, {
        expectedSessionIds: targetSessionIds,
        currentSessionIds: currentTargetSessionIds,
      });
    }

    const revalidatedChannelBlockers = channelBlockers(targetSessionIds);
    const runtimeById = new Map((await sessionRuntime.listSessions()).map(session => [session.id, session]));
    const revalidatedBusySessionIds = targetSessionIds.filter(sessionId => runtimeById.get(sessionId)?.busy);
    const revalidatedQueuedSessionIds = targetSessionIds.filter(sessionId => (runtimeById.get(sessionId)?.queueLength || 0) > 0);
    if (revalidatedChannelBlockers.length > 0 || revalidatedBusySessionIds.length > 0 || revalidatedQueuedSessionIds.length > 0) {
      throw new SessionDeletionError(
        'The session tree became active or channel-blocked while preparing deletion. Retry the delete request.',
        'SESSION_DELETE_STATE_CHANGED',
        409,
        {
          includeDescendants,
          blockingSessionIds: [...new Set(revalidatedChannelBlockers.map(blocker => blocker.sessionId))],
          blockingChannels: revalidatedChannelBlockers,
          busySessionIds: revalidatedBusySessionIds,
          queuedSessionIds: revalidatedQueuedSessionIds,
        },
      );
    }

    await options.beforeFinalMutationForTests?.({
      rootSessionId: rootSession.id,
      includeDescendants,
      targetSessionIds: [...targetSessionIds],
    });

    // No detach or delete may occur after a stale reverse source generation.
    await options.assertSourceCurrent?.();
    const detachedChildSessionIds: string[] = [];
    if (!includeDescendants) {
      for (const childSessionId of directChildSessionIds) {
        if (!sessionManager.getAllSessions().has(childSessionId)) continue;
        await options.assertSourceCurrent?.();
        try {
        await sessionManager.setSessionParent(childSessionId, undefined, claimId);
          detachedChildSessionIds.push(childSessionId);
        } catch (error: any) {
          throw new SessionDeletionError(
            `Session "${rootSession.id}" was not deleted because surviving child "${childSessionId}" could not be detached: ${error?.message || error}`,
            'SESSION_DELETE_DETACH_PARTIAL',
            500,
            {
              includeDescendants,
              deletedSessionIds: [],
              failedDetachChildSessionId: childSessionId,
              detachedChildSessionIds,
            },
          );
        }
      }
    }

    const deletedSessionIds: string[] = [];
    for (const sessionId of postOrderSessionIds) {
      await options.assertSourceCurrent?.();
      try {
        const deleted = await sessionManager.deleteSession(sessionId, claimId);
        if (!deleted) throw new Error(`Session "${sessionId}" disappeared before deletion.`);
        deletedSessionIds.push(sessionId);
      } catch (error: any) {
        throw new SessionDeletionError(
          `Session tree deletion stopped after an unexpected failure at "${sessionId}": ${error?.message || error}`,
          'SESSION_TREE_DELETE_PARTIAL',
          500,
          {
            includeDescendants,
            failedSessionId: sessionId,
            deletedSessionIds,
            remainingSessionIds: postOrderSessionIds.filter(id => sessionManager.getAllSessions().has(id)),
          },
        );
      }
    }

    return {
      status: 'deleted', includeDescendants,
      deletedCount: deletedSessionIds.length,
      deletedSessionIds,
      detachedChildSessionIds,
    };
  } finally {
    if (claimId) sessionManager.releaseSessionsForDestructiveLifecycle(claimId);
    releaseCrossSessionAdmission();
  }
}
