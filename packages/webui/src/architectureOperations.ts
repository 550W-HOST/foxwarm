import { getSessionRuntimeStateName, isSessionRuntimeActive, type SessionRuntimeState } from './sessionRuntimeState'

export type ArchitectureStatusFilter = 'all' | 'active' | 'waiting' | 'queued' | 'isolated'

export interface ArchitectureSessionLike {
  id: string
  displayName?: string
  agent?: string
  currentNode?: string
  model?: string | null
  modelKey?: string
  isolated?: boolean
  archived?: boolean
  busy?: boolean
  queueLength?: number
  runtimeState?: SessionRuntimeState
}

export interface ArchitectureAgentLike {
  id: string
  activeSessionCount: number
  sessionCount: number
}

export const orderArchitectureAgents = <T extends ArchitectureAgentLike>(agents: readonly T[]): T[] => (
  [...agents].sort((left, right) => {
    if ((left.id === 'main') !== (right.id === 'main')) return left.id === 'main' ? -1 : 1
    if ((left.activeSessionCount > 0) !== (right.activeSessionCount > 0)) return left.activeSessionCount > 0 ? -1 : 1
    if ((left.sessionCount > 0) !== (right.sessionCount > 0)) return left.sessionCount > 0 ? -1 : 1
    return left.id.localeCompare(right.id)
  })
)

export const getArchitectureSessionNodeId = (session: ArchitectureSessionLike): string => (
  session.runtimeState?.tool?.executionNode
  || session.currentNode
  || 'master'
)

export const matchesArchitectureStatus = (session: ArchitectureSessionLike, filter: ArchitectureStatusFilter): boolean => {
  if (filter === 'all') return true
  if (filter === 'active') return isSessionRuntimeActive(session)
  if (filter === 'waiting') return getSessionRuntimeStateName(session) === 'waiting'
  if (filter === 'queued') return Number(session.runtimeState?.queueLength ?? session.queueLength ?? 0) > 0
  return session.isolated === true
}

export const filterArchitectureSessions = <T extends ArchitectureSessionLike>(
  sessions: readonly T[],
  filter: ArchitectureStatusFilter,
  query: string,
): T[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return sessions.filter((session) => {
    if (!matchesArchitectureStatus(session, filter)) return false
    if (!normalizedQuery) return true
    const fields = [
      session.id,
      session.displayName,
      session.agent || 'main',
      getArchitectureSessionNodeId(session),
      session.model,
      session.modelKey,
      session.runtimeState?.tool?.name,
      session.runtimeState?.waiting?.waitingFor,
    ]
    return fields.some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(normalizedQuery))
  })
}

export const groupArchitectureSessionsByNode = <T extends ArchitectureSessionLike>(sessions: readonly T[]): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const session of sessions) {
    const nodeId = getArchitectureSessionNodeId(session)
    const group = groups.get(nodeId)
    if (group) group.push(session)
    else groups.set(nodeId, [session])
  }
  return groups
}

export const getArchitectureNodePreview = <T extends ArchitectureSessionLike>(
  sessions: readonly T[],
  preferredIds: ReadonlySet<string>,
  limit = 6,
): T[] => {
  if (sessions.length <= limit) return [...sessions]
  const seen = new Set<string>()
  const ordered: T[] = []
  const append = (session: T) => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    ordered.push(session)
  }
  sessions.filter(session => preferredIds.has(session.id)).forEach(append)
  sessions.filter(isSessionRuntimeActive).forEach(append)
  sessions.forEach(append)
  return ordered.slice(0, Math.max(1, limit))
}
