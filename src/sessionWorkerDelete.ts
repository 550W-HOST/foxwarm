import type { SessionWorkerStore } from './sessionWorkerStore';
import type { SessionWorkerSupervisor } from './sessionWorkerSupervisor';

export type SessionWorkerDeleteDeps = {
  store: SessionWorkerStore;
  supervisor: SessionWorkerSupervisor;
};

/**
 * The worker-fenced half of the closed delete operation: interrupt any active
 * turn, gracefully stop the exact worker (drain, handback, fence release),
 * then delete the durable fence plus mailbox rows. Any lifecycle failure
 * propagates so the caller fails closed and never deletes underneath a live
 * or unproven worker. Returns false when the session has no worker fence and
 * the caller should use ordinary local semantics.
 */
export async function teardownSessionWorkerForDelete(
  deps: SessionWorkerDeleteDeps,
  sessionId: string,
): Promise<boolean> {
  const ownership = deps.store.findOwnership(sessionId);
  if (!ownership) return false;
  const status = deps.supervisor.getStatus(sessionId);
  if (status?.ready) {
    // Abort the in-flight provider request before the graceful drain; the
    // worker may legitimately reject the interrupt (for example a turn that
    // just finished), which must not block the teardown.
    try { await deps.supervisor.interruptActivated(sessionId, ownership); } catch { /* best-effort pre-abort */ }
    await deps.supervisor.stopWorker(sessionId);
  }
  deps.store.deleteSessionRows(sessionId);
  return true;
}
