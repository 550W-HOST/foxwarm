import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { Session } from './SessionListCore'

interface ArchitectureViewProps {
  sessions: Session[]
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onBack?: () => void
}

const ROOT_CHILD_PREVIEW_COUNT = 10
const CHILD_PREVIEW_COUNT = 8

const sortSessions = (a: Session, b: Session) => {
  if ((a.busy || false) !== (b.busy || false)) {
    return a.busy ? -1 : 1
  }
  if ((a.queueLength || 0) !== (b.queueLength || 0)) {
    return (b.queueLength || 0) - (a.queueLength || 0)
  }
  if ((a.childSessions?.length || 0) !== (b.childSessions?.length || 0)) {
    return (b.childSessions?.length || 0) - (a.childSessions?.length || 0)
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

const formatBusyDuration = (busyStartedAt?: number | null, now: number = Date.now()) => {
  if (!busyStartedAt) return '—'
  const diff = Math.max(0, now - busyStartedAt)
  const totalSeconds = Math.floor(diff / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const formatTokenMillions = (value: number | undefined) => {
  const tokens = value || 0
  const millions = tokens / 1_000_000
  if (millions === 0) return '0m'
  if (millions >= 10) return `${millions.toFixed(1)}m`
  if (millions >= 1) return `${millions.toFixed(2)}m`
  return `${millions.toFixed(3)}m`
}

const renderMetaBadge = (label: string, tone: 'default' | 'active' | 'warning' | 'muted' = 'default') => {
  const toneClasses = {
    default: 'bg-gray-100 text-gray-700 dark:bg-gray-700/70 dark:text-gray-200',
    active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
    muted: 'bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ${toneClasses[tone]}`}>
      {label}
    </span>
  )
}

interface SessionNodeProps {
  session: Session
  parent: Session | null
  children: Session[]
  depth: number
  now: number
  expandedSessions: Set<string>
  showMoreChildren: Set<string>
  onToggleExpanded: (sessionId: string) => void
  onToggleShowMore: (sessionId: string) => void
  onSelectSession: (sessionId: string) => void
  sessionMap: Map<string, Session>
  childrenMap: Map<string, Session[]>
}

function SessionNode({
  session,
  parent,
  children,
  depth,
  now,
  expandedSessions,
  showMoreChildren,
  onToggleExpanded,
  onToggleShowMore,
  onSelectSession,
  sessionMap,
  childrenMap,
}: SessionNodeProps) {
  const expanded = expandedSessions.has(session.id)
  const previewCount = depth === 0 ? ROOT_CHILD_PREVIEW_COUNT : CHILD_PREVIEW_COUNT
  const showingAllChildren = showMoreChildren.has(session.id)
  const visibleChildren = showingAllChildren ? children : children.slice(0, previewCount)
  const hiddenChildrenCount = Math.max(0, children.length - visibleChildren.length)
  const tokenUsage = session.tokenUsage || { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const totalTokens = tokenUsage.cachedTokens + tokenUsage.inputTokens + tokenUsage.outputTokens
  const sessionName = session.displayName || session.id
  const canExpand = children.length > 0
  const statusText = `${session.busy ? 'busy' : 'idle'} ${session.busy ? formatBusyDuration(session.busyStartedAt, now) : '—'}`

  const handleCardClick = () => {
    if (canExpand) {
      onToggleExpanded(session.id)
    }
  }

  return (
    <div className="relative">
      <div
        className={`rounded-xl border px-4 py-2.5 shadow-sm transition-colors ${
          expanded && canExpand
            ? 'border-blue-300 bg-blue-50/70 dark:border-blue-700 dark:bg-blue-950/20'
            : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
        } ${session.archived ? 'opacity-80' : ''} ${canExpand ? 'cursor-pointer hover:border-gray-300 dark:hover:border-gray-600' : ''}`}
        onClick={handleCardClick}
      >
        {/* Row 1: Name + badges + jump button */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
            <h3 title={sessionName} className="truncate text-sm font-semibold text-gray-900 dark:text-white">
              {sessionName}
            </h3>
            {session.displayName && (
              <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">{session.id}</span>
            )}
            {renderMetaBadge(`agent:${session.agent || 'main'}`, 'default')}
            {session.archived && renderMetaBadge('archived', 'muted')}
            {session.isolated && renderMetaBadge('isolated', 'warning')}
            {parent ? (
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                child of{' '}
                <button
                  onClick={(e) => { e.stopPropagation(); onSelectSession(parent.id) }}
                  className="rounded font-mono text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {parent.displayName || parent.id}
                </button>
              </span>
            ) : null}
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              updated {formatRelativeTime(session.lastMessageTime)}
            </span>
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); onSelectSession(session.id) }}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Jump</span>
          </button>
        </div>

        {/* Row 2: Metadata */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
          <span><span className="font-medium text-gray-900 dark:text-gray-100">status</span> {statusText}</span>
          <span><span className="font-medium text-gray-900 dark:text-gray-100">msgs</span> {session.messageCount || 0}</span>
          {children.length > 0 && <span><span className="font-medium text-gray-900 dark:text-gray-100">children</span> {children.length}</span>}
          <span><span className="font-medium text-gray-900 dark:text-gray-100">node</span> {session.currentNode || 'master'}</span>
          {!!session.queueLength && <span><span className="font-medium text-gray-900 dark:text-gray-100">queued</span> {session.queueLength}</span>}
          {session.cwd && (
            <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400" title={session.cwd}>
              cwd {session.cwd}
            </span>
          )}
          <span><span className="font-medium text-gray-900 dark:text-gray-100">tokens</span> {formatTokenMillions(totalTokens)}</span>
          <span className="text-gray-400 dark:text-gray-500">
            cached {formatTokenMillions(tokenUsage.cachedTokens)} · in {formatTokenMillions(tokenUsage.inputTokens)} · out {formatTokenMillions(tokenUsage.outputTokens)}
          </span>
        </div>
      </div>

      {/* Children list (indented) */}
      {expanded && children.length > 0 && (
        <div className="ml-5 mt-1.5 space-y-1.5 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
          {children.length > 0 && hiddenChildrenCount > 0 && (
            <div className="flex items-center justify-between px-1 py-1">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {children.length} child session{children.length > 1 ? 's' : ''}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleShowMore(session.id) }}
                className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {showingAllChildren ? 'Show less' : `Show ${hiddenChildrenCount} more`}
              </button>
            </div>
          )}

          {visibleChildren.map(child => (
            <SessionNode
              key={child.id}
              session={child}
              parent={sessionMap.get(session.id) || null}
              children={childrenMap.get(child.id) || []}
              depth={depth + 1}
              now={now}
              expandedSessions={expandedSessions}
              showMoreChildren={showMoreChildren}
              onToggleExpanded={onToggleExpanded}
              onToggleShowMore={onToggleShowMore}
              onSelectSession={onSelectSession}
              sessionMap={sessionMap}
              childrenMap={childrenMap}
            />
          ))}

          {!showingAllChildren && hiddenChildrenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleShowMore(session.id) }}
              className="ml-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              Show {hiddenChildrenCount} more…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function ArchitectureView({
  sessions,
  currentSession,
  onSelectSession,
  onBack,
}: ArchitectureViewProps) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [showMoreChildren, setShowMoreChildren] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const hasBusySession = sessions.some(session => session.busy)
    if (!hasBusySession) return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [sessions])

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

  const roots = useMemo(
    () => sessions.filter(session => !normalizedParentMap.get(session.id)).sort(sortSessions),
    [sessions, normalizedParentMap],
  )

  useEffect(() => {
    if (!currentSession) return

    const next = new Set<string>()
    let cursor: string | null | undefined = currentSession
    while (cursor) {
      next.add(cursor)
      cursor = normalizedParentMap.get(cursor)
    }

    setExpandedSessions(prev => {
      const merged = new Set(prev)
      for (const id of next) merged.add(id)
      return merged
    })
  }, [currentSession, normalizedParentMap])

  const summary = useMemo(() => {
    const busyCount = sessions.filter(session => session.busy).length
    const queuedSessions = sessions.filter(session => (session.queueLength || 0) > 0)
    const queuedItems = queuedSessions.reduce((sum, session) => sum + (session.queueLength || 0), 0)
    const totalCachedTokens = sessions.reduce((sum, session) => sum + (session.tokenUsage?.cachedTokens || 0), 0)
    const totalInputTokens = sessions.reduce((sum, session) => sum + (session.tokenUsage?.inputTokens || 0), 0)
    const totalOutputTokens = sessions.reduce((sum, session) => sum + (session.tokenUsage?.outputTokens || 0), 0)
    const agentCount = new Set(sessions.map(session => session.agent || 'main')).size

    return {
      agentCount,
      sessionCount: sessions.length,
      busyCount,
      queuedSessions: queuedSessions.length,
      queuedItems,
      totalCachedTokens,
      totalInputTokens,
      totalOutputTokens,
    }
  }, [sessions])

  const toggleExpanded = (sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const toggleShowMore = (sessionId: string) => {
    setShowMoreChildren(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1200px] p-4 md:p-5 lg:p-6">
        <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
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
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agents</h1>
              </div>
              <p className="mt-2 max-w-4xl text-sm text-gray-600 dark:text-gray-300">
                Runtime session hierarchy with status, busy time, message counts, agent ownership, and token usage.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
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
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{summary.queuedItems} queued items</div>
            </div>
            <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/70 xl:col-span-2">
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Total token usage</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {formatTokenMillions(summary.totalCachedTokens + summary.totalInputTokens + summary.totalOutputTokens)}
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>cached {formatTokenMillions(summary.totalCachedTokens)}</span>
                <span>input {formatTokenMillions(summary.totalInputTokens)}</span>
                <span>output {formatTokenMillions(summary.totalOutputTokens)}</span>
              </div>
            </div>
          </div>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Sessions</h2>

          <div className="space-y-2">
            {roots.map(root => (
              <SessionNode
                key={root.id}
                session={root}
                parent={null}
                children={childrenMap.get(root.id) || []}
                depth={0}
                now={now}
                expandedSessions={expandedSessions}
                showMoreChildren={showMoreChildren}
                onToggleExpanded={toggleExpanded}
                onToggleShowMore={toggleShowMore}
                onSelectSession={onSelectSession}
                sessionMap={sessionMap}
                childrenMap={childrenMap}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
