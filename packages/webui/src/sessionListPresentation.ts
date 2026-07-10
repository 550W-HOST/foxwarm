export type SessionListOrderMode = 'default' | 'time' | 'flat-time'

export interface SessionListSortable {
  id: string
  lastMessageTime: number
  archived?: boolean
  pinned?: boolean
  sidebarOrder?: number | null
}

function getSidebarOrder(session: SessionListSortable): number | undefined {
  return typeof session.sidebarOrder === 'number' && Number.isFinite(session.sidebarOrder)
    ? session.sidebarOrder
    : undefined
}

export function compareSessionListSessions(
  a: SessionListSortable,
  b: SessionListSortable,
  mode: SessionListOrderMode,
): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
  if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1

  if (mode === 'default') {
    const aOrder = getSidebarOrder(a)
    const bOrder = getSidebarOrder(b)
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder
    if (aOrder !== undefined && bOrder === undefined) return -1
    if (aOrder === undefined && bOrder !== undefined) return 1
  }

  const timeDelta = (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
  if (timeDelta !== 0) return timeDelta
  return a.id.localeCompare(b.id)
}

export function shouldElevateSessionToRoot(session: Pick<SessionListSortable, 'pinned'>, mode: SessionListOrderMode): boolean {
  return mode === 'flat-time' || !!session.pinned
}
