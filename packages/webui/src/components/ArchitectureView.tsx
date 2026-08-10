import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { Session } from './SessionListCore'
import { getRuntimeStateSummary, isSessionRuntimeActive } from '../sessionRuntimeState'
import { API_BASE_PATH } from '../config'
import { createSessionListRefreshScheduler } from '../sessionListRefresh'
import { BoundedReplayRevisionMismatch, createEpochRows, filterPresentationPathForAgent, mergeDeltaRows, mergeForcedPresentationPath, mergeHttpRows, pruneEpochRows, replayAtomicWindows, replayCursorBranches, replayCursorWindow, trackHttpRowsRequest } from '../boundedSessionReplay'

interface ArchitectureViewProps {
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onBack?: () => void
}

const ROOT_CHILD_PREVIEW_COUNT = 10
const CHILD_PREVIEW_COUNT = 8

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
  childTotals: Map<string, number>
  childCursors: Map<string, string | null>
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
  childTotals,
  childCursors,
}: SessionNodeProps) {
  const expanded = expandedSessions.has(session.id)
  const previewCount = depth === 0 ? ROOT_CHILD_PREVIEW_COUNT : CHILD_PREVIEW_COUNT
  const showingAllChildren = showMoreChildren.has(session.id)
  const visibleChildren = showingAllChildren ? children : children.slice(0, previewCount)
  const hiddenChildrenCount = Math.max(0, (childTotals.get(session.id) ?? children.length) - visibleChildren.length)
  const hasMoreChildren = !!childCursors.get(session.id)
  const tokenUsage = session.tokenUsage || { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const totalTokens = tokenUsage.cachedTokens + tokenUsage.inputTokens + tokenUsage.outputTokens
  const sessionName = session.displayName || session.id
  const canExpand = childTotals.has(session.id) ? (childTotals.get(session.id) || 0) > 0 : true
  const isActive = isSessionRuntimeActive(session)
  const statusText = session.runtimeState
    ? getRuntimeStateSummary(session.runtimeState, !!session.busy)
    : `${session.busy ? 'busy' : 'idle'} ${session.busy ? formatBusyDuration(session.busyStartedAt, now) : '—'}`
  const statusDuration = isActive ? formatBusyDuration(session.runtimeState?.since || session.busyStartedAt, now) : undefined

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
        <div className="mt-1.5 flex items-center gap-x-3 text-xs text-gray-600 dark:text-gray-300">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 flex-1">
            <span><span className="font-medium text-gray-900 dark:text-gray-100">status</span> {statusText}{statusDuration ? ` · ${statusDuration}` : ''}</span>
            <span><span className="font-medium text-gray-900 dark:text-gray-100">msgs</span> {session.messageCount || 0}</span>
            {(childTotals.get(session.id) || 0) > 0 && <span><span className="font-medium text-gray-900 dark:text-gray-100">children</span> {childTotals.get(session.id)}</span>}
            <span><span className="font-medium text-gray-900 dark:text-gray-100">node</span> {session.currentNode || 'master'}</span>
            {!!session.queueLength && <span><span className="font-medium text-gray-900 dark:text-gray-100">queued</span> {session.queueLength}</span>}
            {session.cwd && (
              <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400 max-w-[200px]" title={session.cwd}>
                cwd {session.cwd}
              </span>
            )}
          </div>
          <div className="flex-shrink-0 flex items-center gap-x-2 text-right">
            <span><span className="font-medium text-gray-900 dark:text-gray-100">tokens</span> {formatTokenMillions(totalTokens)}</span>
            <span className="text-gray-400 dark:text-gray-500">
              cached {formatTokenMillions(tokenUsage.cachedTokens)} · in {formatTokenMillions(tokenUsage.inputTokens)} · out {formatTokenMillions(tokenUsage.outputTokens)}
            </span>
          </div>
        </div>
      </div>

      {/* Children list (indented) */}
      {expanded && children.length > 0 && (
        <div className="ml-5 mt-1.5 space-y-1.5 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
          {children.length > 0 && (hiddenChildrenCount > 0 || showingAllChildren) && (
            <div className="flex items-center justify-between px-1 py-1">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {children.length} child session{children.length > 1 ? 's' : ''}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleShowMore(session.id) }}
                className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {hasMoreChildren ? `Show ${hiddenChildrenCount} more` : showingAllChildren ? 'Show less' : `Show ${hiddenChildrenCount} more`}
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
              childTotals={childTotals}
              childCursors={childCursors}
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
  currentSession,
  onSelectSession,
  onBack,
}: ArchitectureViewProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [rootIds, setRootIds] = useState<string[]>([])
  const [rootCursor, setRootCursor] = useState<string | null>(null)
  const [rootTarget, setRootTarget] = useState(50)
  const [childCursors, setChildCursors] = useState<Map<string, string | null>>(new Map())
  const [childTotals, setChildTotals] = useState<Map<string, number>>(new Map())
  const [childIds, setChildIds] = useState<Map<string, string[]>>(new Map())
  const [focusPathIds, setFocusPathIds] = useState<Set<string>>(new Set())
  const [agentCounts, setAgentCounts] = useState<Array<{ agent: string; count: number }>>([])
  const [globalSummary, setGlobalSummary] = useState({ total: 0, busy: 0, queued: 0, managed: 0, cachedTokens: 0, inputTokens: 0, outputTokens: 0 })
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [showMoreChildren, setShowMoreChildren] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now())
  const generationRef = useRef(0)
  const rowStoreRef = useRef(createEpochRows<Session>())
  const branchTargetsRef = useRef(new Map<string, number>())
  const selectedAgentRef = useRef(selectedAgent); selectedAgentRef.current = selectedAgent
  const rootTargetRef = useRef(rootTarget); rootTargetRef.current = rootTarget
  const currentSessionRef = useRef(currentSession); currentSessionRef.current = currentSession
  const invalidationIdentityRef = useRef<string | null>(null)

  const collectArchitectureRoots = async (target: number, agent: string | null) => {
    const result = await replayCursorWindow<Session>({ targetCount: target, pageCap: 100, fetchPage: async (cursor, limit) => {
      const params = new URLSearchParams({ limit: String(limit), childLimit: '10' }); if (agent) params.set('agent', agent); if (cursor) params.set('cursor', cursor)
      const response = await fetch(`${API_BASE_PATH}/session-list/architecture?${params}`); if (!response.ok) throw new Error(`Architecture query failed (${response.status})`)
      const payload = await response.json(); return { ...payload.roots, items: payload.roots?.sessions || [], nextCursor: payload.roots?.nextCursor || null, architecturePayload: payload }
    } })
    const rows = [...result.items]; const ids = new Map<string, string[]>(); const totals = new Map<string, number>(); const cursors = new Map<string, string | null>()
    let summary = globalSummary; let counts = agentCounts
    for (const page of result.pages as any[]) { const payload = page.architecturePayload; summary = payload.summary || summary; counts = payload.agentCounts || counts
      for (const group of payload.children || []) { ids.set(group.parentSessionId, (group.sessions || []).map((row: Session) => row.id)); totals.set(group.parentSessionId, Number(group.total || 0)); cursors.set(group.parentSessionId, group.nextCursor || null); rows.push(...(group.sessions || [])) } }
    return { rootIds: result.items.map(row => row.id), rootCursor: result.nextCursor, childIds: ids, childTotals: totals, childCursors: cursors, rows, summary, agentCounts: counts, revision: result.revision }
  }

  const collectArchitectureBranches = async (targets: Map<string, number>, agent: string | null, expectedRevision?: string) => replayCursorBranches<Session>({ targets, pageCap: 20, parentBatchCap: 20, expectedRevision,
    fetchBatch: async (parents, limit) => { const response = await fetch(`${API_BASE_PATH}/session-list/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'time', limit, ...(agent ? { agent } : {}), parents }) }); if (!response.ok) throw new Error(`Architecture child query failed (${response.status})`)
      const payload = await response.json(); return { reset: payload.reset, revision: payload.revision, groups: (payload.children || []).map((group: any) => ({ parentSessionId: group.parentSessionId, items: group.sessions, nextCursor: group.nextCursor, total: group.total })) } } })

  const collectArchitectureFocus = async (requestedId: string | undefined, selectedAgent: string | null) => {
    if (!requestedId) return { rows: [] as Session[], path: [] as string[], missing: false, revision: undefined as string | undefined }
    const response = await fetch(`${API_BASE_PATH}/session-list/by-id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [requestedId], includePaths: true }) })
    if (!response.ok) throw new Error(`Architecture focus query failed (${response.status})`)
    const payload = await response.json(); const result = payload.results?.[0]
    if (!result?.session) return { rows: [] as Session[], path: [] as string[], missing: true, revision: payload.revision as string | undefined }
    const path = payload.paths?.[requestedId] || [result.session.id]; const rows: Session[] = []
    for (let index = 0; index < path.length; index += 100) { const exactResponse = await fetch(`${API_BASE_PATH}/session-list/by-id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: path.slice(index, index + 100), includePaths: false }) }); if (!exactResponse.ok) throw new Error(`Architecture focus path query failed (${exactResponse.status})`); const exact = await exactResponse.json(); if (payload.revision !== undefined && exact.revision !== payload.revision) throw new BoundedReplayRevisionMismatch(); rows.push(...(exact.results || []).flatMap((item: any) => item.session ? [item.session] : [])) }
    const rowMap = new Map(rows.map(row => [row.id, row])); const filteredPath = filterPresentationPathForAgent(path, rowMap, result.session.id, selectedAgent); const owned = new Set(filteredPath)
    return { rows: rows.filter(row => owned.has(row.id)), path: filteredPath, missing: false, revision: payload.revision as string | undefined }
  }

  const replayArchitecture = async (target: number, branchTargets: Map<string, number>) => trackHttpRowsRequest(rowStoreRef.current, async startEpoch => {
    const generation = ++generationRef.current; const requestAgent = selectedAgentRef.current; const requestFocus = currentSessionRef.current
    const { roots: combined, branches } = await replayAtomicWindows({ loadRoots: async () => { const roots = await collectArchitectureRoots(target, requestAgent); const focus = await collectArchitectureFocus(requestFocus, requestAgent); if (roots.revision !== undefined && focus.revision !== undefined && roots.revision !== focus.revision) throw new BoundedReplayRevisionMismatch(); return { ...roots, focus } },
      loadBranches: combined => { const targets = new Map(branchTargets); for (const parent of combined.focus.path.slice(0, -1)) targets.set(parent, Math.max(1, targets.get(parent) || 0)); return targets.size ? collectArchitectureBranches(targets, requestAgent, combined.revision) : Promise.resolve(new Map<string, { items: Session[]; nextCursor: string | null; total: number }>()) } })
    const { focus, ...roots } = combined
    if (generation !== generationRef.current || selectedAgentRef.current !== requestAgent || currentSessionRef.current !== requestFocus) return
    const ids = new Map(roots.childIds); const totals = new Map(roots.childTotals); const cursors = new Map(roots.childCursors); const rows = [...roots.rows]
    for (const [parent, branch] of branches) { ids.set(parent, branch.items.map(row => row.id)); totals.set(parent, branch.total); cursors.set(parent, branch.nextCursor); rows.push(...branch.items) }
    rows.push(...focus.rows)
    const forced = mergeForcedPresentationPath(roots.rootIds, ids, focus.path); roots.rootIds = forced.rootIds; for (const [parent, children] of forced.childIds) ids.set(parent, children)
    const focusRows = new Map(focus.rows.map(row => [row.id, row]))
    for (const parent of focus.path.slice(0, -1)) { const total = focusRows.get(parent)?.childTotal; if (typeof total === 'number') totals.set(parent, total) }
    const reachable = new Set(roots.rootIds); let changed = true
    while (changed) { changed = false; for (const [parent, children] of ids) if (reachable.has(parent)) for (const child of children) if (!reachable.has(child)) { reachable.add(child); changed = true } }
    for (const parent of [...branchTargets.keys()]) if (!reachable.has(parent)) { branchTargets.delete(parent); ids.delete(parent); totals.delete(parent); cursors.delete(parent) }
    const keep = new Set([...roots.rootIds, ...[...ids].flatMap(([parent, children]) => [parent, ...children])]); mergeHttpRows(rowStoreRef.current, rows, startEpoch)
    if (focus.missing && requestFocus && (rowStoreRef.current.epochs.get(requestFocus) || 0) <= startEpoch) mergeDeltaRows(rowStoreRef.current, [], [requestFocus])
    pruneEpochRows(rowStoreRef.current, keep)
    setSessions([...rowStoreRef.current.rows.values()]); setRootIds(roots.rootIds); setRootCursor(roots.rootCursor); setRootTarget(target)
    setChildIds(ids); setChildTotals(totals); setChildCursors(cursors); setAgentCounts(roots.agentCounts); setGlobalSummary(roots.summary)
    setFocusPathIds(new Set(focus.path))
    branchTargetsRef.current = new Map(branchTargets)
  })

  useEffect(() => {
    branchTargetsRef.current = new Map(); setExpandedSessions(new Set()); setShowMoreChildren(new Set()); setSessions([]); rowStoreRef.current = createEpochRows<Session>()
    setChildIds(new Map()); setChildTotals(new Map()); setChildCursors(new Map()); setFocusPathIds(new Set()); setRootIds([]); setRootTarget(50)
    void replayArchitecture(50, new Map()).catch(error => console.error('Failed Architecture bootstrap', error))
  }, [selectedAgent])
  useEffect(() => { void replayArchitecture(rootTargetRef.current, new Map(branchTargetsRef.current)).catch(error => console.error('Failed Architecture focus replay', error)) }, [currentSession])

  const architectureSubscriptionIds = useMemo(() => [...rootIds, ...[...childIds].flatMap(([parent, ids]) => [parent, ...ids])].filter((id, index, all) => all.indexOf(id) === index), [rootIds, childIds])
  useEffect(() => {
    const scheduler = createSessionListRefreshScheduler(() => replayArchitecture(rootTargetRef.current, new Map(branchTargetsRef.current)))
    const subscriptionAgent = selectedAgent
    const sources: EventSource[] = []
    const batches = architectureSubscriptionIds.length ? Array.from({ length: Math.ceil(architectureSubscriptionIds.length / 100) }, (_, index) => architectureSubscriptionIds.slice(index * 100, index * 100 + 100)) : [[]]
    for (const batch of batches) { const params = new URLSearchParams(); batch.forEach(id => params.append('sessionId', id)); const queryString = params.toString()
      const source = new EventSource(`${API_BASE_PATH}/sessions/stream${queryString ? `?${queryString}` : ''}`); sources.push(source); source.onmessage = event => { try { if (selectedAgentRef.current !== subscriptionAgent) return; const data = JSON.parse(event.data)
        if (data.type === 'session-list-delta') { mergeDeltaRows(rowStoreRef.current, data.sessions || [], data.deletedIds || []); setSessions([...rowStoreRef.current.rows.values()]) }
        if (data.type === 'session-list-invalidated' || data.type === 'sessions-updated') { const identity = data.eventId !== undefined ? `${data.eventId}:${data.presentationRevision ?? ''}` : null; if (!identity || invalidationIdentityRef.current !== identity) { invalidationIdentityRef.current = identity; scheduler.requestRefresh() } }
      } catch {} } }
    return () => { scheduler.dispose(); sources.forEach(source => source.close()) }
  }, [selectedAgent, architectureSubscriptionIds.join('\0')])

  useEffect(() => {
    const hasBusySession = sessions.some(session => isSessionRuntimeActive(session))
    if (!hasBusySession) return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [sessions])

  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])

  const agents = useMemo(() => agentCounts.map(item => ({ name: item.agent, sessionCount: item.count })), [agentCounts])

  // Reset selectedAgent if it no longer exists
  useEffect(() => {
    if (selectedAgent && !agents.some(a => a.name === selectedAgent)) {
      setSelectedAgent(null)
    }
  }, [agents, selectedAgent])

  const filteredSessionSet = useMemo(() => {
    if (!selectedAgent) return null
    return new Set(sessions.filter(s => (s.agent || 'main') === selectedAgent).map(s => s.id))
  }, [sessions, selectedAgent])

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
    for (const [parentId, ids] of childIds) map.set(parentId, ids.map(id => sessionMap.get(id))
      .filter((row): row is Session => !!row && (!filteredSessionSet || filteredSessionSet.has(row.id) || focusPathIds.has(row.id))))
    return map
  }, [childIds, sessionMap, filteredSessionSet, focusPathIds])

  const roots = useMemo(() => rootIds.map(id => sessionMap.get(id)).filter((row): row is Session => !!row), [rootIds, sessionMap])

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

  const summary = {
    agentCount: agentCounts.length, sessionCount: globalSummary.total, busyCount: globalSummary.busy,
    queuedSessions: globalSummary.queued,
    totalCachedTokens: globalSummary.cachedTokens, totalInputTokens: globalSummary.inputTokens,
    totalOutputTokens: globalSummary.outputTokens,
  }

  const removeArchitectureBranch = (sessionId: string) => {
    const remove = new Set([sessionId]); let changed = true
    while (changed) { changed = false; for (const [parent, ids] of childIds) if (remove.has(parent)) for (const id of ids) if (!remove.has(id)) { remove.add(id); changed = true } }
    const targets = new Map(branchTargetsRef.current); for (const id of remove) targets.delete(id)
    branchTargetsRef.current = targets
    void replayArchitecture(rootTargetRef.current, targets).catch(error => console.error('Failed Architecture collapse replay', error))
  }

  const toggleExpanded = (sessionId: string) => {
    const opening = !expandedSessions.has(sessionId)
    setExpandedSessions(prev => { const next = new Set(prev); opening ? next.add(sessionId) : next.delete(sessionId); return next })
    if (!opening) { removeArchitectureBranch(sessionId); return }
    const targets = new Map(branchTargetsRef.current); targets.set(sessionId, Math.max(10, childIds.get(sessionId)?.length || 0))
    void replayArchitecture(rootTargetRef.current, targets).catch(error => console.error('Failed Architecture branch replay', error))
  }

  const toggleShowMore = (sessionId: string) => {
    const showing = showMoreChildren.has(sessionId); const hasMore = !!childCursors.get(sessionId)
    if (hasMore) { const targets = new Map(branchTargetsRef.current); targets.set(sessionId, (targets.get(sessionId) || childIds.get(sessionId)?.length || 0) + 10)
      if (!showing) setShowMoreChildren(prev => new Set(prev).add(sessionId)); void replayArchitecture(rootTargetRef.current, targets).catch(error => console.error('Failed Architecture continuation replay', error)); return }
    setShowMoreChildren(prev => { const next = new Set(prev); next.has(sessionId) ? next.delete(sessionId) : next.add(sessionId); return next })
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
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{summary.queuedSessions} queued sessions</div>
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
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelectedAgent(null)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                selectedAgent === null
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-700'
              }`}
            >
              All
              <span className="ml-1.5 text-xs opacity-70">{summary.sessionCount}</span>
            </button>
            {agents.map(agent => (
              <button
                key={agent.name}
                onClick={() => setSelectedAgent(prev => prev === agent.name ? null : agent.name)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selectedAgent === agent.name
                    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-700'
                }`}
              >
                {agent.name}
                <span className="ml-1.5 text-xs opacity-70">{agent.sessionCount}</span>
              </button>
            ))}
          </div>

          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Sessions
            {selectedAgent && <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">filtered by {selectedAgent}</span>}
          </h2>

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
                childTotals={childTotals}
                childCursors={childCursors}
              />
            ))}
            {rootCursor && (
              <button onClick={() => { void replayArchitecture(rootTargetRef.current + 50, new Map(branchTargetsRef.current)) }} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-white dark:border-gray-700 dark:text-blue-300 dark:hover:bg-gray-800">
                Show 50 more sessions…
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
