export type SessionListOrderMode = 'default' | 'time' | 'flat-time'

export interface SessionListSortable {
  id: string
  lastMessageTime: number
  archived?: boolean
  pinned?: boolean
  sidebarOrder?: number | null
}

export function getSessionListChildDisclosure(options: {
  bounded: boolean
  loadedCount: number
  boundedTotal?: number
  allowUnknown: boolean
}): { total: number | null; canExpand: boolean } {
  if (!options.bounded) {
    return { total: options.loadedCount, canExpand: options.loadedCount > 0 }
  }
  if (typeof options.boundedTotal === 'number') {
    const total = Math.max(0, options.boundedTotal)
    return { total, canExpand: total > 0 }
  }
  return { total: null, canExpand: options.allowUnknown }
}

export function collapseSessionListExpandedBranch(
  expanded: ReadonlySet<string>,
  childrenByParent: ReadonlyMap<string, readonly { id: string }[]>,
  rootId: string,
): Set<string> {
  const collapsed = new Set([rootId])
  const pending = [rootId]
  while (pending.length) {
    const parentId = pending.pop()!
    for (const child of childrenByParent.get(parentId) || []) {
      if (collapsed.has(child.id)) continue
      collapsed.add(child.id)
      pending.push(child.id)
    }
  }
  return new Set([...expanded].filter(sessionId => !collapsed.has(sessionId)))
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

export function getSessionListDisplayId(sessionId: string, parentSessionId?: string | null, isDirectChild: boolean = true): string {
  if (!parentSessionId) return sessionId
  if (sessionId.startsWith(parentSessionId)) {
    return sessionId.slice(parentSessionId.length)
  }

  if (isDirectChild && parentSessionId.endsWith('/main')) {
    const agentId = parentSessionId.slice(0, -'/main'.length)
    if (agentId && sessionId.startsWith(`${agentId}/`)) {
      return sessionId.slice(agentId.length)
    }
  }

  return sessionId
}
