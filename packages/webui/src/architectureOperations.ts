import { getSessionRuntimeStateName, isSessionRuntimeActive, type SessionRuntimeState } from './sessionRuntimeState'
import { getResolvedSessionNodeId } from './sessionNode'

export type ArchitectureStatusFilter = 'all' | 'active' | 'waiting' | 'queued'

export interface ArchitectureSessionLike {
  id: string
  displayName?: string
  agent?: string
  currentNode?: string
  model?: string | null
  modelKey?: string
  defaultModelKey?: string
  archived?: boolean
  busy?: boolean
  queueLength?: number
  runtimeState?: SessionRuntimeState
}

export const getArchitectureSessionNodeId = (session: ArchitectureSessionLike): string => getResolvedSessionNodeId(session)

export const matchesArchitectureStatus = (session: ArchitectureSessionLike, filter: ArchitectureStatusFilter): boolean => {
  if (filter === 'all') return true
  if (filter === 'active') return isSessionRuntimeActive(session)
  if (filter === 'waiting') return getSessionRuntimeStateName(session) === 'waiting'
  return Number(session.runtimeState?.queueLength ?? session.queueLength ?? 0) > 0
}

/** Model the Session is using now, otherwise its configured model. */
export const getArchitectureSessionModel = (session: ArchitectureSessionLike): string | undefined => (
  session.runtimeState?.active?.modelKey || session.modelKey || session.model || session.defaultModelKey || undefined
)

export interface ArchitectureSessionFilters {
  nodeId?: string | null
  model?: string | null
}

export const filterArchitectureSessions = <T extends ArchitectureSessionLike>(
  sessions: readonly T[],
  filter: ArchitectureStatusFilter,
  query: string,
  filters: ArchitectureSessionFilters = {},
): T[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return sessions.filter((session) => {
    if (!matchesArchitectureStatus(session, filter)) return false
    if (filters.nodeId && getArchitectureSessionNodeId(session) !== filters.nodeId) return false
    if (filters.model && getArchitectureSessionModel(session) !== filters.model) return false
    if (!normalizedQuery) return true
    const fields = [
      session.id,
      session.displayName,
      session.agent || 'main',
      getArchitectureSessionNodeId(session),
      getArchitectureSessionModel(session),
      session.model,
      session.modelKey,
      session.runtimeState?.tool?.name,
      session.runtimeState?.waiting?.waitingFor,
    ]
    return fields.some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(normalizedQuery))
  })
}
