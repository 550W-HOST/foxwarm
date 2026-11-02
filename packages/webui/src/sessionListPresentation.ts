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
  itemTotal?: number
  allowTree: boolean
}): { total: number | null; canExpand: boolean } {
  if (!options.bounded) {
    return { total: options.loadedCount, canExpand: options.loadedCount > 0 }
  }
  const rawTotal = typeof options.boundedTotal === 'number' ? options.boundedTotal : options.itemTotal
  if (typeof rawTotal !== 'number') return { total: null, canExpand: false }
  const total = Math.max(0, rawTotal)
  return { total, canExpand: options.allowTree && total > 0 }
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

export function getSessionListAutoExpandedPath(
  activePathRootToCurrent: readonly string[],
  manuallyCollapsed: ReadonlySet<string>,
  currentSessionChanged: boolean,
): string[] {
  if (currentSessionChanged) return [...activePathRootToCurrent]

  const expandedPath: string[] = []
  for (const sessionId of activePathRootToCurrent) {
    if (manuallyCollapsed.has(sessionId)) break
    expandedPath.push(sessionId)
  }
  return expandedPath
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

/** The Agent's main Session ID, matching the backend: `main` for the main Agent, otherwise `<agent>/main`. */
export function getAgentMainSessionId(agent: string): string {
  return agent === 'main' ? 'main' : `${agent}/main`
}

/**
 * Agent tag for a top-level tree row: any unpinned row other than its Agent's main Session,
 * except rows of the default `main` Agent and rows whose visible title already names the Agent.
 */
export function getSessionListAgentTag(session: { id: string; agent?: string; pinned?: boolean }, title: string): string | null {
  const agent = session.agent
  if (!agent || agent === 'main' || session.pinned || session.id === getAgentMainSessionId(agent)) return null
  return title.startsWith(`${agent}/`) ? null : agent
}

export type SessionListGrouping = 'none' | 'agent' | 'node'

/** A Sidebar group header as served by the backend, in display order. */
export interface SessionListGroup {
  key: string
  label: string
  count: number
  online?: boolean
}

/**
 * Places the top-level rows the list renders into their server-assigned groups: rows of a
 * loaded group page keep the page order, other rows (focus paths, exact rows) follow by the
 * server's presentation group. Rows without a known group are returned separately.
 */
export function assignSessionListGroupRoots(
  rootIds: readonly string[],
  groupPages: ReadonlyMap<string, { ids: readonly string[] }>,
  presentationGroups: Readonly<Record<string, string>>,
): { byGroup: Map<string, string[]>; ungrouped: string[] } {
  const roots = new Set(rootIds)
  const placed = new Set<string>()
  const byGroup = new Map<string, string[]>()
  for (const [key, page] of groupPages) {
    const ids = page.ids.filter(id => roots.has(id) && !placed.has(id))
    ids.forEach(id => placed.add(id))
    byGroup.set(key, ids)
  }
  const ungrouped: string[] = []
  for (const id of rootIds) {
    if (placed.has(id)) continue
    const key = presentationGroups[id]
    if (key === undefined) { ungrouped.push(id); continue }
    byGroup.set(key, [...(byGroup.get(key) || []), id])
  }
  return { byGroup, ungrouped }
}

export const SESSION_LIST_GROUPING_KEY = 'foxwarm_session_list_grouping_v1'
export const SESSION_LIST_GROUPINGS: SessionListGrouping[] = ['none', 'agent', 'node']

/** The stored Sidebar grouping. The mobile list stays ungrouped. */
export function loadStoredSessionListGrouping(): SessionListGrouping {
  try {
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'none'
    const stored = localStorage.getItem(SESSION_LIST_GROUPING_KEY)
    if (SESSION_LIST_GROUPINGS.includes(stored as SessionListGrouping)) return stored as SessionListGrouping
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
  return 'none'
}
