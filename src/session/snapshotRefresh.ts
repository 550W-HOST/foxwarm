import { logger } from '../common';
import type { Session } from '../types';

export const AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS = 60 * 60 * 1000;

type RefreshSessionSnapshot = (sessionId: string) => Promise<unknown>;

function getSessionIdleMs(session: Pick<Session, 'meta'>, now: number = Date.now()): number {
  const lastMessageTime = session.meta?.lastMessageTime;
  if (typeof lastMessageTime !== 'number' || !Number.isFinite(lastMessageTime)) {
    return 0;
  }

  return Math.max(0, now - lastMessageTime);
}

function shouldAutoRefreshSessionSnapshot(session: Pick<Session, 'meta'>, now: number = Date.now()): boolean {
  return getSessionIdleMs(session, now) > AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS;
}

export async function maybeRefreshStaleSessionSnapshot(
  session: Pick<Session, 'id' | 'meta'>,
  refreshSessionSnapshot: RefreshSessionSnapshot,
  now: number = Date.now(),
): Promise<boolean> {
  const idleMs = getSessionIdleMs(session, now);
  if (idleMs <= AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS) {
    return false;
  }

  try {
    await refreshSessionSnapshot(session.id);
    logger.info({ sessionId: session.id, idleMs }, 'Auto-refreshed stale session prompt snapshot');
    return true;
  } catch (err) {
    logger.warn({ err, sessionId: session.id, idleMs }, 'Failed to auto-refresh stale session prompt snapshot; continuing session turn');
    return false;
  }
}
