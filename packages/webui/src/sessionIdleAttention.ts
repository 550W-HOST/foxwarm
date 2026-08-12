export const SESSION_IDLE_UNREAD_STORAGE_KEY = 'foxwarm_session_idle_unread_v1'
export const SESSION_IDLE_UNREAD_EVENT = 'foxwarm-idle-unread-changed'
export const SESSION_IDLE_SESSION_DELETED_EVENT = 'foxwarm-idle-session-deleted'
export const SESSION_IDLE_UNREAD_LIMIT = 256

export type SessionIdleUnread = Record<string, number>

function isValidSessionId(value: string): boolean {
  return !!value && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function normalizeSessionIdleUnread(value: unknown): SessionIdleUnread {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const envelope = value as { version?: unknown; unread?: unknown }
  if (envelope.version !== 1 || !envelope.unread || typeof envelope.unread !== 'object' || Array.isArray(envelope.unread)) return {}
  return Object.entries(envelope.unread)
    .filter(([sessionId, timestamp]) => isValidSessionId(sessionId) && typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SESSION_IDLE_UNREAD_LIMIT)
    .reduce<SessionIdleUnread>((unread, [sessionId, timestamp]) => {
      unread[sessionId] = timestamp as number
      return unread
    }, {})
}

export function readSessionIdleUnread(storage: Pick<Storage, 'getItem'>): SessionIdleUnread {
  try {
    const raw = storage.getItem(SESSION_IDLE_UNREAD_STORAGE_KEY)
    return raw ? normalizeSessionIdleUnread(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

export function writeSessionIdleUnread(storage: Pick<Storage, 'setItem' | 'removeItem'>, unread: SessionIdleUnread): SessionIdleUnread {
  const normalized = normalizeSessionIdleUnread({ version: 1, unread })
  try {
    if (Object.keys(normalized).length === 0) storage.removeItem(SESSION_IDLE_UNREAD_STORAGE_KEY)
    else storage.setItem(SESSION_IDLE_UNREAD_STORAGE_KEY, JSON.stringify({ version: 1, unread: normalized }))
  } catch {
    // Browser storage can be unavailable or full. Keep the in-memory state for this page.
  }
  return normalized
}

export function updateStoredSessionIdleUnread(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  update: (current: SessionIdleUnread) => SessionIdleUnread,
): SessionIdleUnread {
  return writeSessionIdleUnread(storage, update(readSessionIdleUnread(storage)))
}

export function getSessionIdleUnreadIds(storage: Pick<Storage, 'getItem'>): string[] {
  return Object.keys(readSessionIdleUnread(storage))
}

export function selectVisibleSessionIds(activeSessionIds: Iterable<string | null | undefined>, workbenchVisible: boolean): string[] {
  return workbenchVisible ? [...new Set([...activeSessionIds].filter((value): value is string => !!value))] : []
}

export function shouldMarkSessionIdleUnread(sessionId: string, visibleSessionIds: ReadonlySet<string>, visibilityState: DocumentVisibilityState): boolean {
  return visibilityState !== 'visible' || !visibleSessionIds.has(sessionId)
}

export function dispatchSessionIdleDeleted(sessionIds: Iterable<string>): void {
  const ids = [...new Set(sessionIds)].filter(isValidSessionId)
  if (ids.length > 0) window.dispatchEvent(new CustomEvent(SESSION_IDLE_SESSION_DELETED_EVENT, { detail: { sessionIds: ids } }))
}