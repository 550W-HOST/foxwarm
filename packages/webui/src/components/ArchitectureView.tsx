import { useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { Session } from './SessionListCore'

interface ArchitectureViewProps {
  sessions: Session[]
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onBack?: () => void
}

type ArchitectureMode = 'agent' | 'lineage'

interface SessionCardProps {
  session: Session
  currentSession?: string
  parent: Session | null
  children: Session[]
  onSelectSession: (sessionId: string) => void
  showAgentBadge?: boolean
}

const sortSessions = (a: Session, b: Session) => {
  if (a.archived && !b.archived) return 1
  if (!a.archived && b.archived) return -1
  if ((a.busy || false) !== (b.busy || false)) {
    return a.busy ? -1 : 1
  }
  if ((a.queueLength || 0) !== (b.queueLength || 0)) {
    return (b.queueLength || 0) - (a.queueLength || 0)
  }
  return (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
}

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return 'No messages yet'

  const diff = Date.now() - timestamp
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  return `${Math.floor(diff / day)}d ago`
}

const renderMetaBadge = (label: string, tone: 'default' | 'active' | 'warning' | 'muted' = 'default') => {
  const toneClasses = {
    default: 'bg-gray-100 text-gray-700 dark:bg-gray-700/70 dark:text-gray-200',
    active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
    muted: 'bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${toneClasses[tone]}`}>
      {label}
    </span>
  )
}

function SessionCard({
  session,
  currentSession,
  parent,
  children,
  onSelectSession,
  showAgentBadge = false,
}: SessionCardProps) {
  const sessionName = session.displayName || session.id
  const hasCrossAgentParent = parent && (parent.agent || 'main') !== (session.agent || 'main')
  const crossAgentChildren = children.filter(child => (child.agent || 'main') !== (session.agent || 'main'))
  const previewChildren = children.slice(0, 3)

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition-colors ${
        currentSession === session.id
          ? 'border-blue-300 bg-blue-50/70 dark:border-blue-700 dark:bg-blue-950/30'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
      } ${session.archived ? 'opacity-80' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">
              {sessionName}
            </h3>
            {currentSession === session.id && renderMetaBadge('current', 'active')}
            {showAgentBadge && renderMetaBadge(`agent:${session.agent || 'main'}`, 'default')}
            {session.archived && renderMetaBadge('archived', 'muted')}
          </div>
          {session.displayName && (
            <div className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
              {session.id}
            </div>
          )}
        </div>

        <button
          onClick={() => onSelectSession(session.id)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span>Open</span>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {session.busy && renderMetaBadge('busy', 'active')}
        {!!session.queueLength && renderMetaBadge(`${session.queueLength} queued`, 'warning')}
        {renderMetaBadge(`${session.messageCount || 0} msgs`, 'default')}
        {renderMetaBadge(`node:${session.currentNode || 'master'}`, 'muted')}
        {session.isolated && renderMetaBadge('isolated', 'warning')}
        <span className="inline-flex items-center text-xs text-gray-500 dark:text-gray-400">
          updated {formatRelativeTime(session.lastMessageTime)}
        </span>
      </div>

      <div className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-300">
        <div>
          <span className="font-medium text-gray-800 dark:text-gray-100">Parent:</span>{' '}
          {parent ? (
            <>
              <button
                onClick={() => onSelectSession(parent.id)}
                className="rounded text-left font-mono text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
              >
                {parent.displayName || parent.id}
              </button>
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                ({parent.agent || 'main'})
              </span>
              {hasCrossAgentParent && <span className="ml-2">↔ cross-agent lineage</span>}
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">root session</span>
          )}
        </div>

        <div>
          <span className="font-medium text-gray-800 dark:text-gray-100">Children:</span>{' '}
          {children.length > 0 ? (
            <>
              <span>{children.length} session{children.length > 1 ? 's' : ''}</span>
              {crossAgentChildren.length > 0 && (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {crossAgentChildren.length} cross-agent
                </span>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {previewChildren.map(child => (
                  <button
                    key={child.id}
                    onClick={() => onSelectSession(child.id)}
                    className="rounded-full border border-gray-200 px-2.5 py-1 font-mono text-xs text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {child.displayName || child.id}
                    {(child.agent || 'main') !== (session.agent || 'main') && ` · ${child.agent || 'main'}`}
                  </button>
                ))}
                {children.length > previewChildren.length && (
                  <span className="inline-flex items-center text-xs text-gray-500 dark:text-gray-400">
                    +{children.length - previewChildren.length} more
                  </span>
                )}
              </div>
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">no child sessions</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ArchitectureView({
  sessions,
  currentSession,
  onSelectSession,
  onBack,
}: ArchitectureViewProps) {
  const [mode, setMode] = useState<ArchitectureMode>('agent')

  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])

  const aliasMap = useMemo(() => {
    const map = new Map<string, string>()

    for (const session of sessions) {
      map.set(session.id, session.id)
      for (const alias of session.aliases || []) {
        map.set(alias, session.id)
      }
    }

    return map
  }, [sessions])

  const normalizedParentMap = useMemo(() => {
    const map = new Map<string, string | null>()

    for (const session of sessions) {
      const resolvedParentId = session.parentSessionId ? aliasMap.get(session.parentSessionId) || null : null
      map.set(
        session.id,
        resolvedParentId && resolvedParentId !== session.id && sessionMap.has(resolvedParentId)
          ? resolvedParentId
          : null,
      )
    }

    return map
  }, [sessions, aliasMap, sessionMap])

  const childrenMap = useMemo(() => {
    const map = new Map<string, Session[]>()

    for (const session of sessions) {
      const parentId = normalizedParentMap.get(session.id)
      if (!parentId) continue

      if (!map.has(parentId)) {
        map.set(parentId, [])
      }

      map.get(parentId)?.push(session)
    }

    for (const children of map.values()) {
      children.sort(sortSessions)
    }

    return map
  }, [sessions, normalizedParentMap])

  const sessionsByAgent = useMemo(() => {
    const map = new Map<string, Session[]>()

    for (const session of sessions) {
      const agentName = session.agent || 'main'
      if (!map.has(agentName)) {
        map.set(agentName, [])
      }
      map.get(agentName)?.push(session)
    }

    return Array.from(map.entries())
      .map(([agentName, agentSessions]) => [agentName, [...agentSessions].sort(sortSessions)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  }, [sessions])

  const lineageRoots = useMemo(
    () => sessions.filter(session => !normalizedParentMap.get(session.id)).sort(sortSessions),
    [sessions, normalizedParentMap],
  )

  const detachedSessions = useMemo(() => {
    const visited = new Set<string>()

    const visit = (session: Session) => {
      if (visited.has(session.id)) return
      visited.add(session.id)
      for (const child of childrenMap.get(session.id) || []) {
        visit(child)
      }
    }

    for (const root of lineageRoots) {
      visit(root)
    }

    return sessions.filter(session => !visited.has(session.id)).sort(sortSessions)
  }, [sessions, childrenMap, lineageRoots])

  const summary = useMemo(() => {
    const busyCount = sessions.filter(session => session.busy).length
    const queuedSessions = sessions.filter(session => (session.queueLength || 0) > 0)
    const queuedItems = queuedSessions.reduce((sum, session) => sum + (session.queueLength || 0), 0)
    const crossAgentLineages = sessions.filter(session => {
      const parentId = normalizedParentMap.get(session.id)
      if (!parentId) return false
      const parent = sessionMap.get(parentId)
      return !!parent && (parent.agent || 'main') !== (session.agent || 'main')
    }).length

    return {
      agentCount: sessionsByAgent.length,
      sessionCount: sessions.length,
      busyCount,
      queuedSessions: queuedSessions.length,
      queuedItems,
      crossAgentLineages,
    }
  }, [sessions, sessionsByAgent.length, normalizedParentMap, sessionMap])

  const renderLineageTree = (session: Session, depth = 0, parent: Session | null = null): JSX.Element => {
    const children = childrenMap.get(session.id) || []
    const isCrossAgent = parent && (parent.agent || 'main') !== (session.agent || 'main')

    return (
      <div key={session.id} className={depth > 0 ? 'ml-4 border-l border-gray-200 pl-4 dark:border-gray-700' : ''}>
        <div
          className={`rounded-xl border p-4 shadow-sm ${
            currentSession === session.id
              ? 'border-blue-300 bg-blue-50/70 dark:border-blue-700 dark:bg-blue-950/30'
              : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                  {session.displayName || session.id}
                </h3>
                {renderMetaBadge(`agent:${session.agent || 'main'}`, 'default')}
                {currentSession === session.id && renderMetaBadge('current', 'active')}
                {isCrossAgent && renderMetaBadge('cross-agent child', 'warning')}
              </div>
              {session.displayName && (
                <div className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {session.id}
                </div>
              )}
            </div>
            <button
              onClick={() => onSelectSession(session.id)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Open</span>
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {session.busy && renderMetaBadge('busy', 'active')}
            {!!session.queueLength && renderMetaBadge(`${session.queueLength} queued`, 'warning')}
            {renderMetaBadge(`${session.messageCount || 0} msgs`, 'default')}
            {renderMetaBadge(`node:${session.currentNode || 'master'}`, 'muted')}
            {session.isolated && renderMetaBadge('isolated', 'warning')}
          </div>

          <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">
            {parent ? (
              <>
                Derived from{' '}
                <button
                  onClick={() => onSelectSession(parent.id)}
                  className="rounded font-mono text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {parent.displayName || parent.id}
                </button>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  ({parent.agent || 'main'})
                </span>
              </>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">Root lineage</span>
            )}
          </div>
        </div>

        {children.length > 0 && (
          <div className="mt-3 space-y-3">
            {children.map(child => renderLineageTree(child, depth + 1, session))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-7xl p-4 md:p-6 lg:p-8">
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                {onBack && (
                  <button
                    onClick={onBack}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 md:hidden"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>Back</span>
                  </button>
                )}
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Architecture</h1>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
                First-pass global structure view. “By Agent” shows ownership (agent → sessions) while surfacing lineage on each
                session row. “By Lineage” shows runtime parent/child derivation and always labels the owning agent so cross-agent
                relationships stay explicit.
              </p>
            </div>

            <div className="inline-flex rounded-xl bg-gray-100 p-1 dark:bg-gray-900/70">
              <button
                onClick={() => setMode('agent')}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  mode === 'agent'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                }`}
              >
                By Agent
              </button>
              <button
                onClick={() => setMode('lineage')}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  mode === 'lineage'
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                }`}
              >
                By Lineage
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Agents</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{summary.agentCount}</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Sessions</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{summary.sessionCount}</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Busy</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{summary.busyCount}</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Queued</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{summary.queuedSessions}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{summary.queuedItems} total queued items</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Cross-agent lineage</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{summary.crossAgentLineages}</div>
            </div>
          </div>
        </div>

        {mode === 'agent' ? (
          <div className="space-y-6">
            {sessionsByAgent.map(([agentName, agentSessions]) => (
              <section
                key={agentName}
                className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-4 dark:border-gray-700">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{agentName}</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {agentSessions.length} session{agentSessions.length > 1 ? 's' : ''} ·{' '}
                      {agentSessions.filter(session => session.busy).length} busy ·{' '}
                      {agentSessions.filter(session => (session.queueLength || 0) > 0).length} queued
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  {agentSessions.map(session => {
                    const parentId = normalizedParentMap.get(session.id)
                    const parent = parentId ? sessionMap.get(parentId) || null : null
                    const children = childrenMap.get(session.id) || []

                    return (
                      <SessionCard
                        key={session.id}
                        session={session}
                        currentSession={currentSession}
                        parent={parent}
                        children={children}
                        onSelectSession={onSelectSession}
                      />
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="border-b border-gray-100 pb-4 dark:border-gray-700">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Session lineage</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Runtime parent/child relationships, with each node labelled by its owning agent.
                </p>
              </div>

              <div className="mt-4 space-y-4">
                {lineageRoots.map(root => renderLineageTree(root))}
              </div>
            </section>

            {detachedSessions.length > 0 && (
              <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm dark:border-amber-800 dark:bg-amber-950/20">
                <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-100">Detached / unresolved nodes</h2>
                <p className="mt-1 text-sm text-amber-800/80 dark:text-amber-200/80">
                  These sessions were not reached from the resolved lineage roots. They may reference missing parents or form an unusual structure.
                </p>

                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  {detachedSessions.map(session => {
                    const parentId = normalizedParentMap.get(session.id)
                    const parent = parentId ? sessionMap.get(parentId) || null : null
                    const children = childrenMap.get(session.id) || []

                    return (
                      <SessionCard
                        key={session.id}
                        session={session}
                        currentSession={currentSession}
                        parent={parent}
                        children={children}
                        onSelectSession={onSelectSession}
                        showAgentBadge
                      />
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}