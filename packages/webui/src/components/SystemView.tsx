import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Network } from 'lucide-react'
import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import type { Session } from './SessionListCore'
import type { TokenUsage } from './TokenUsageDetails'
import AgentCreationMenu from './AgentCreationMenu'
import SystemNodes from './SystemNodes'
import SystemTimers, { SessionTimersSection } from './SystemTimers'
import SystemWebhooks from './SystemWebhooks'
import SystemUsage from './SystemUsage'
import SystemActivity from './SystemActivity'
import type { ActivityFilters } from '../activity'
import type { UsagePeriod } from '../usageOverview'
import { AgentRegistryCard, AgentRegistryInspector, type AgentMemoryFile, type AgentRegistryChanges, type AgentRegistryEntry } from './SystemAgents'
import { SessionFilterBar, SessionInspector, SessionOperationRow } from './SystemSessions'
import { addLoadedUsage, emptyLoadedUsage, renderMetaBadge, type LoadedUsage } from './SystemShared'
import { buildAgentCreationBody, type AgentSettingsChanges } from '../agentCreation'
import { useNodeDirectory } from '../useNodeDirectory'
import { getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'
import { API_BASE_PATH } from '../config'
import { createSessionListRefreshScheduler, requestSessionListStreamOpenResync } from '../sessionListRefresh'
import { BoundedReplayRevisionMismatch, createEpochRows, filterPresentationPathForAgent, mergeDeltaRows, mergeForcedPresentationPath, mergeHttpRows, pruneEpochRows, replayAtomicWindows, replayCursorBranches, replayCursorWindow, trackHttpRowsRequest } from '../boundedSessionReplay'
import { webUiRealtime } from '../realtime'
import { filterArchitectureSessions, getArchitectureSessionModel, getArchitectureSessionNodeId, groupArchitectureSessionsByNode, orderArchitectureAgents, type ArchitectureStatusFilter } from '../architectureOperations'
import { makeVscodeWebUrl } from '../vscodeWeb'

// The Timeline shares Chat rendering pieces; load them only when it is opened.
const SessionSequenceView = lazy(() => import('./SessionSequenceView'))

export type SystemSection = 'agents' | 'sessions' | 'nodes' | 'timers' | 'webhooks' | 'usage' | 'activity'

export const SYSTEM_SECTIONS: Array<{ id: SystemSection; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'timers', label: 'Timers' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'usage', label: 'Usage' },
  { id: 'activity', label: 'Activity' },
]

const SECTION_SUBTITLES: Record<SystemSection, string> = {
  agents: 'Agent workspaces, inheritance, isolation and memory.',
  sessions: 'Session state, placement and usage, and how sessions work together.',
  nodes: 'Connected nodes, the sessions running on them, and new node setup.',
  timers: 'Scheduled messages and scripts, their next runs and recent results.',
  webhooks: 'Events from outside services, where they go and what arrived recently.',
  usage: 'Model requests, tokens and estimated cost across the installation.',
  activity: 'Who ran which tools, on which Nodes, and what happened.',
}

interface SystemViewProps {
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onBack?: () => void
  /** Section to show; a change from the caller switches to it. */
  section?: SystemSection
  onSectionChange?: (section: SystemSection) => void
  onCreateAgent?: (agentId: string, settings: AgentSettingsChanges) => Promise<void>
  onCreateSession?: (agentId: string, sessionId?: string, runtime?: 'foxwarm' | 'claude-code') => Promise<void>
  onAgentsChanged?: () => void | Promise<void>
  onOpenAgentMemory?: (memoryRoot: string, filePath?: string) => void
  /** Opens the Agents section with this Agent's settings; a new nonce repeats the request. */
  agentRequest?: { agent: string; nonce: number } | null
  /** Opens the Sessions list filtered by this state; a new nonce repeats the request. */
  sessionsRequest?: { status: ArchitectureStatusFilter; nonce: number } | null
  /** Opens the Usage section for this period; a new nonce repeats the request. */
  usageRequest?: { period: UsagePeriod; nonce: number } | null
}

export default function SystemView({
  currentSession,
  onSelectSession,
  onBack,
  section: requestedSection,
  onSectionChange,
  onCreateAgent,
  onCreateSession,
  onAgentsChanged,
  onOpenAgentMemory,
  agentRequest,
  sessionsRequest,
  usageRequest,
}: SystemViewProps) {
  const tabHeader = useWorkbenchTabHeader()
  const [sessions, setSessions] = useState<Session[]>([])
  const [rootIds, setRootIds] = useState<string[]>([])
  const [rootCursor, setRootCursor] = useState<string | null>(null)
  const [rootTarget, setRootTarget] = useState(50)
  const [childCursors, setChildCursors] = useState<Map<string, string | null>>(new Map())
  const [childTotals, setChildTotals] = useState<Map<string, number>>(new Map())
  const [childIds, setChildIds] = useState<Map<string, string[]>>(new Map())
  const [focusPathIds, setFocusPathIds] = useState<Set<string>>(new Set())
  const [agentCounts, setAgentCounts] = useState<Array<{ agent: string; count: number }>>([])
  const [globalSummary, setGlobalSummary] = useState<{ total: number; busy: number; queued: number; managed: number } & TokenUsage>({ total: 0, busy: 0, queued: 0, managed: 0, cachedTokens: 0, inputTokens: 0, outputTokens: 0 })
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<ArchitectureStatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [nodeFilter, setNodeFilter] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState<string | null>(null)
  const [sessionsView, setSessionsView] = useState<'list' | 'timeline'>('list')
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(currentSession || null)
  const { nodes: nodeTargets, agentDefaultNode, error: nodeTargetsError, reload: reloadNodes } = useNodeDirectory()
  const [section, setSectionState] = useState<SystemSection>(requestedSection || 'sessions')
  useEffect(() => { if (requestedSection) setSectionState(requestedSection) }, [requestedSection])
  const onSectionChangeRef = useRef(onSectionChange); onSectionChangeRef.current = onSectionChange
  const setSection = useCallback((next: SystemSection) => { setSectionState(next); onSectionChangeRef.current?.(next) }, [])
  const [agentRegistry, setAgentRegistry] = useState<AgentRegistryEntry[]>([])
  const [selectedRegistryAgentId, setSelectedRegistryAgentId] = useState<string | null>(agentRequest?.agent || 'main')
  useEffect(() => {
    if (!agentRequest) return
    setSection('agents')
    setSelectedRegistryAgentId(agentRequest.agent)
  }, [agentRequest?.agent, agentRequest?.nonce])
  useEffect(() => {
    if (!sessionsRequest) return
    setSection('sessions')
    setSessionsView('list')
    setSearchQuery(''); setNodeFilter(null); setModelFilter(null)
    setStatusFilter(sessionsRequest.status)
  }, [sessionsRequest?.status, sessionsRequest?.nonce])
  const [timersSessionFilter, setTimersSessionFilter] = useState<string | null>(null)
  const [activityRequest, setActivityRequest] = useState<{ filters: ActivityFilters; nonce: number } | null>(null)
  const showActivity = useCallback((filters: ActivityFilters) => {
    setActivityRequest(current => ({ filters, nonce: (current?.nonce || 0) + 1 }))
    setSection('activity')
  }, [setSection])
  const showSessionTimers = (sessionId: string) => {
    setTimersSessionFilter(sessionId)
    setSection('timers')
  }
  const [agentMemoryFiles, setAgentMemoryFiles] = useState<AgentMemoryFile[]>([])
  const [agentMemoryLoading, setAgentMemoryLoading] = useState(false)
  const [agentMemoryError, setAgentMemoryError] = useState('')
  const [agentRegistryError, setAgentRegistryError] = useState('')
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
    branchTargetsRef.current = new Map(); setSessions([]); rowStoreRef.current = createEpochRows<Session>()
    setChildIds(new Map()); setChildTotals(new Map()); setChildCursors(new Map()); setFocusPathIds(new Set()); setRootIds([]); setRootTarget(50)
    void replayArchitecture(50, new Map()).catch(error => console.error('Failed Architecture bootstrap', error))
  }, [selectedAgent])
  useEffect(() => {
    setInspectedSessionId(currentSession || null)
    void replayArchitecture(rootTargetRef.current, new Map(branchTargetsRef.current)).catch(error => console.error('Failed Architecture focus replay', error))
  }, [currentSession])

  const loadAgentRegistry = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_PATH}/agents`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `Agent query failed (${response.status})`)
      const nextAgents = Array.isArray(payload.agents) ? payload.agents as AgentRegistryEntry[] : []
      setAgentRegistry(nextAgents)
      setSelectedRegistryAgentId(previous => previous && nextAgents.some(agent => agent.id === previous) ? previous : nextAgents.find(agent => agent.id === 'main')?.id || nextAgents[0]?.id || null)
      setAgentRegistryError('')
    } catch (error) {
      setAgentRegistryError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadAgentRegistry()
    if (section !== 'agents') return
    const timer = window.setInterval(() => { void loadAgentRegistry() }, 30_000)
    return () => window.clearInterval(timer)
  }, [loadAgentRegistry, section])

  useEffect(() => {
    if (section !== 'agents' || !selectedRegistryAgentId) { setAgentMemoryFiles([]); return }
    let disposed = false
    setAgentMemoryLoading(true); setAgentMemoryError('')
    void fetch(`${API_BASE_PATH}/agents/${encodeURIComponent(selectedRegistryAgentId)}/memory`)
      .then(async response => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `Memory query failed (${response.status})`)
        if (!disposed) setAgentMemoryFiles(Array.isArray(payload.files) ? payload.files : [])
      })
      .catch(error => { if (!disposed) { setAgentMemoryFiles([]); setAgentMemoryError(error instanceof Error ? error.message : String(error)) } })
      .finally(() => { if (!disposed) setAgentMemoryLoading(false) })
    return () => { disposed = true }
  }, [selectedRegistryAgentId, section])

  const architectureSubscriptionIds = useMemo(() => [...rootIds, ...[...childIds].flatMap(([parent, ids]) => [parent, ...ids])].filter((id, index, all) => all.indexOf(id) === index), [rootIds, childIds])
  useEffect(() => {
    const scheduler = createSessionListRefreshScheduler(() => replayArchitecture(rootTargetRef.current, new Map(branchTargetsRef.current)))
    const subscriptionAgent = selectedAgent
    const unsubscribe = webUiRealtime.subscribeSessionList(architectureSubscriptionIds, {
      onOpen: () => requestSessionListStreamOpenResync(scheduler),
      onMessage: data => { if (selectedAgentRef.current !== subscriptionAgent) return
        if (data.type === 'session-list-delta') { mergeDeltaRows(rowStoreRef.current, data.sessions || [], data.deletedIds || []); setSessions([...rowStoreRef.current.rows.values()]) }
        if (data.type === 'session-list-invalidated' || data.type === 'sessions-updated') { const identity = data.eventId !== undefined ? `${data.eventId}:${data.presentationRevision ?? ''}` : null; if (!identity || invalidationIdentityRef.current !== identity) { invalidationIdentityRef.current = identity; scheduler.requestRefresh() } }
      },
    })
    return () => { scheduler.dispose(); unsubscribe() }
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

  const loadedAgentUsage = useMemo(() => {
    const totals = new Map<string, LoadedUsage>()
    for (const session of sessions) {
      const agent = session.agent || 'main'
      const total = totals.get(agent) || emptyLoadedUsage()
      addLoadedUsage(total, session)
      totals.set(agent, total)
    }
    return totals
  }, [sessions])

  const summary = {
    agentCount: agentCounts.length,
    sessionCount: globalSummary.total,
    activeCount: globalSummary.busy,
    waitingCount: sessions.filter(session => getSessionRuntimeStateName(session) === 'waiting').length,
    queuedSessions: globalSummary.queued,
    managedCount: globalSummary.managed,
    totalCachedTokens: globalSummary.cachedTokens,
    totalInputTokens: globalSummary.inputTokens,
    totalOutputTokens: globalSummary.outputTokens,
    cost: globalSummary.cost,
  }

  const visibleSessions = useMemo(
    () => filterArchitectureSessions(sessions, statusFilter, searchQuery, { nodeId: nodeFilter, model: modelFilter })
      .sort((left, right) => (right.lastMessageTime || 0) - (left.lastMessageTime || 0) || left.id.localeCompare(right.id)),
    [sessions, statusFilter, searchQuery, nodeFilter, modelFilter],
  )
  const groupedSessions = useMemo(() => groupArchitectureSessionsByNode(sessions), [sessions])
  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) { const model = getArchitectureSessionModel(session); if (model) counts.set(model, (counts.get(model) || 0) + 1) }
    if (modelFilter && !counts.has(modelFilter)) counts.set(modelFilter, 0)
    return [...counts].sort((left, right) => left[0].localeCompare(right[0])).map(([id, count]) => ({ id, count }))
  }, [sessions, modelFilter])

  const displayNodes = useMemo(() => {
    const byId = new Map(nodeTargets.map(node => [node.id, node]))
    for (const nodeId of groupedSessions.keys()) {
      if (!byId.has(nodeId)) {
        byId.set(nodeId, { id: nodeId, type: 'unavailable', displayName: nodeId, online: false, services: {}, unavailable: true })
      }
    }
    return [...byId.values()].sort((left, right) => {
      if (left.id === 'master') return -1
      if (right.id === 'master') return 1
      if (left.online !== right.online) return left.online ? -1 : 1
      return left.displayName.localeCompare(right.displayName)
    })
  }, [nodeTargets, groupedSessions])

  const nodeMap = useMemo(() => new Map(displayNodes.map(node => [node.id, node])), [displayNodes])
  const inspectedSession = inspectedSessionId ? sessionMap.get(inspectedSessionId) || null : null
  const inspectedParentId = inspectedSession ? normalizedParentMap.get(inspectedSession.id) : null
  const inspectedParent = inspectedParentId ? sessionMap.get(inspectedParentId) || null : null
  const inspectedChildren = inspectedSession ? childrenMap.get(inspectedSession.id) || [] : []
  const inspectedChildTotal = inspectedSession ? childTotals.get(inspectedSession.id) ?? inspectedChildren.length : 0
  const inspectedNode = inspectedSession ? nodeMap.get(getArchitectureSessionNodeId(inspectedSession)) || null : null

  const loadSessionRelationships = (sessionId: string, increment = 10) => {
    const targets = new Map(branchTargetsRef.current)
    const loaded = childIds.get(sessionId)?.length || 0
    targets.set(sessionId, Math.max(loaded + increment, targets.get(sessionId) || 0, 10))
    branchTargetsRef.current = targets
    void replayArchitecture(rootTargetRef.current, targets).catch(error => console.error('Failed Architecture relationship replay', error))
  }

  const inspectSession = (sessionId: string) => {
    setInspectedSessionId(sessionId)
    if (!branchTargetsRef.current.has(sessionId)) loadSessionRelationships(sessionId)
  }

  useEffect(() => {
    if (inspectedSessionId && sessionMap.has(inspectedSessionId)) return
    if (currentSession && sessionMap.has(currentSession)) { setInspectedSessionId(currentSession); return }
    const firstActive = sessions.find(isSessionRuntimeActive)
    setInspectedSessionId(firstActive?.id || sessions[0]?.id || null)
  }, [currentSession, inspectedSessionId, sessionMap, sessions])

  const statusFilters: Array<{ id: ArchitectureStatusFilter; label: string; count?: number }> = [
    { id: 'all', label: 'All', count: sessions.length },
    { id: 'active', label: 'Active', count: sessions.filter(isSessionRuntimeActive).length },
    { id: 'waiting', label: 'Waiting', count: summary.waitingCount },
    { id: 'queued', label: 'Queued', count: sessions.filter(session => Number(session.runtimeState?.queueLength ?? session.queueLength ?? 0) > 0).length },
    { id: 'isolated', label: 'Isolated', count: sessions.filter(session => session.isolated).length },
  ]

  const selectedRegistryAgent = selectedRegistryAgentId ? agentRegistry.find(agent => agent.id === selectedRegistryAgentId) || null : null
  const orderedAgentRegistry = useMemo(() => orderArchitectureAgents(agentRegistry), [agentRegistry])

  const createAgentFromRegistry = async (agentId: string, settings: AgentSettingsChanges) => {
    if (onCreateAgent) await onCreateAgent(agentId, settings)
    else {
      const response = await fetch(`${API_BASE_PATH}/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildAgentCreationBody(agentId, settings)) })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to create agent')
      if (payload.sessionId) onSelectSession(payload.sessionId)
    }
    await loadAgentRegistry(); setSelectedRegistryAgentId(agentId); await onAgentsChanged?.()
  }

  const createSessionFromRegistry = async (agentId: string, sessionId?: string, runtime: 'foxwarm' | 'claude-code' = 'foxwarm') => {
    if (onCreateSession) await onCreateSession(agentId, sessionId, runtime)
    else {
      const response = await fetch(`${API_BASE_PATH}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, sessionId: sessionId || undefined, runtime }) })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to create session')
      if (payload.sessionId) onSelectSession(payload.sessionId)
    }
    await loadAgentRegistry(); await onAgentsChanged?.()
  }

  const openAgentMemory = (memoryRoot: string, filePath?: string) => {
    if (onOpenAgentMemory) { onOpenAgentMemory(memoryRoot, filePath); return }
    const workspace = { nodeId: 'master', path: memoryRoot }
    window.open(makeVscodeWebUrl(API_BASE_PATH, window.location.origin, workspace, filePath ? { openFile: { kind: 'openFile', nodeId: 'master', path: filePath } } : undefined).toString(), '_blank', 'noopener,noreferrer')
  }

  const saveRegistryAgent = async (agentId: string, changes: AgentRegistryChanges) => {
    const response = await fetch(`${API_BASE_PATH}/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to update agent')
    await loadAgentRegistry(); await onAgentsChanged?.()
  }

  const deleteRegistryAgent = async (agentId: string) => {
    const response = await fetch(`${API_BASE_PATH}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmAgentId: agentId }) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Failed to delete agent')
    setSelectedRegistryAgentId(null); await loadAgentRegistry(); await onAgentsChanged?.()
  }

  const sessionsSummary = [
    { id: 'active' as const, label: 'active', value: summary.activeCount },
    { id: 'waiting' as const, label: 'waiting', value: summary.waitingCount },
    { id: 'queued' as const, label: 'queued', value: summary.queuedSessions },
  ]
  const nodeOptions = displayNodes.map(node => ({ id: node.id, label: node.displayName || node.id, count: groupedSessions.get(node.id)?.length || 0 }))
  const showSessionFromNode = (sessionId: string) => {
    setStatusFilter('all'); setSearchQuery(''); setNodeFilter(null); setModelFilter(null)
    setSessionsView('list')
    setSection('sessions')
    inspectSession(sessionId)
  }
  const tabClass = (active: boolean, kind = 'foxwarm-system-tab') => `${kind} rounded-md px-3 py-1 text-xs font-medium ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`

  return (
    <div className="h-full overflow-y-auto bg-fw-canvas" data-system-section={section}>
      <div className="mx-auto max-w-[1500px] p-4 md:p-5 lg:p-6">
        <header className="mb-4">
          <WorkbenchHeaderDragArea className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {tabHeader ? <WorkbenchTabClose className="inline-flex items-center justify-center rounded-lg p-2 text-fw-text hover:bg-fw-hover" /> : onBack ? (
                <button onClick={onBack} className="inline-flex items-center gap-1 rounded-lg border border-fw-border bg-fw-section px-3 py-1.5 text-sm text-fw-text hover:bg-fw-hover md:hidden">
                  <ArrowLeft className="h-4 w-4" /> Back
                </button>
              ) : null}
              <WorkbenchTabIcon className="flex h-10 w-10 items-center justify-center rounded-xl bg-fw-text-strong text-fw-surface"><Network className="h-5 w-5" /></WorkbenchTabIcon>
              <div>
                <h1 className="text-2xl font-bold text-fw-text-strong">System</h1>
                <p className="mt-0.5 text-sm text-fw-text-muted">{SECTION_SUBTITLES[section]}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-fw-text-muted">
              {summary.managedCount > 0 ? renderMetaBadge(`${summary.managedCount} managed`, 'active') : null}
              {nodeTargetsError ? renderMetaBadge('node status unavailable', 'warning') : null}
              <WorkbenchPaneControls />
            </div>
          </WorkbenchHeaderDragArea>
          <nav className="mt-4 flex items-center gap-1 border-b border-fw-border-muted pb-3" aria-label="System sections">
            <div className="inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5" role="tablist">
              {SYSTEM_SECTIONS.map(item => (
                <button key={item.id} type="button" role="tab" aria-selected={section === item.id} data-active={section === item.id} data-system-tab={item.id} onClick={() => setSection(item.id)} className={tabClass(section === item.id)}>{item.label}</button>
              ))}
            </div>
          </nav>
        </header>

        {section === 'sessions' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <div className="inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5" role="group" aria-label="Session view">
                <button type="button" aria-pressed={sessionsView === 'list'} data-sessions-view="list" data-active={sessionsView === 'list'} onClick={() => setSessionsView('list')} className={tabClass(sessionsView === 'list', 'foxwarm-system-view-tab')}>List</button>
                <button type="button" aria-pressed={sessionsView === 'timeline'} data-sessions-view="timeline" data-active={sessionsView === 'timeline'} onClick={() => setSessionsView('timeline')} className={tabClass(sessionsView === 'timeline', 'foxwarm-system-view-tab')}>Timeline</button>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs" data-system-summary="sessions">
                {sessionsSummary.map(item => (
                  <button key={item.id} type="button" aria-pressed={sessionsView === 'list' && statusFilter === item.id}
                    onClick={() => { setSessionsView('list'); setStatusFilter(statusFilter === item.id ? 'all' : item.id) }}
                    className={`rounded-md px-2 py-1 ${sessionsView === 'list' && statusFilter === item.id ? 'bg-fw-accent-section text-fw-accent' : 'text-fw-text-muted hover:bg-fw-hover'}`}>
                    <strong className="font-semibold tabular-nums text-fw-text-strong">{item.value}</strong> {item.label}
                  </button>
                ))}
              </div>
            </div>
            {sessionsView === 'timeline' ? <Suspense fallback={<div className="p-6 text-sm text-fw-text-muted">Loading timeline…</div>}><SessionSequenceView currentSession={currentSession} onSelectSession={onSelectSession} /></Suspense> : <>
              <div className="border-b border-fw-border-muted pb-4">
                <SessionFilterBar
                  filters={{ query: searchQuery, status: statusFilter, agent: selectedAgent, nodeId: nodeFilter, model: modelFilter }}
                  onChange={patch => {
                    if (patch.query !== undefined) setSearchQuery(patch.query)
                    if (patch.status !== undefined) setStatusFilter(patch.status)
                    if (patch.agent !== undefined) setSelectedAgent(patch.agent)
                    if (patch.nodeId !== undefined) setNodeFilter(patch.nodeId)
                    if (patch.model !== undefined) setModelFilter(patch.model)
                  }}
                  statusOptions={statusFilters}
                  agents={agents}
                  totalSessions={summary.sessionCount}
                  nodes={nodeOptions}
                  models={modelOptions}
                  usage={{ cachedTokens: summary.totalCachedTokens, inputTokens: summary.totalInputTokens, outputTokens: summary.totalOutputTokens, cost: summary.cost }}
                />
              </div>
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <main className="min-w-0 space-y-2" data-system-session-list>
                  <div className="flex items-center justify-between px-1 text-xs text-fw-text-muted">
                    <span>{visibleSessions.length} of {sessions.length} loaded sessions</span>
                    <span>{summary.sessionCount} total</span>
                  </div>
                  {visibleSessions.map(session => (
                    <SessionOperationRow
                      key={session.id}
                      session={session}
                      selected={inspectedSession?.id === session.id}
                      current={currentSession === session.id}
                      now={now}
                      nodeLabel={nodeMap.get(getArchitectureSessionNodeId(session))?.displayName}
                      onInspect={() => inspectSession(session.id)}
                      onOpen={() => onSelectSession(session.id)}
                    />
                  ))}
                  {visibleSessions.length === 0 ? <div className="rounded-xl border border-dashed border-fw-border-strong py-10 text-center text-sm text-fw-text-muted">No matching sessions.</div> : null}
                  {rootCursor ? (
                    <button type="button" onClick={() => { void replayArchitecture(rootTargetRef.current + 50, new Map(branchTargetsRef.current)) }} className="w-full rounded-xl border border-dashed border-fw-border-strong bg-fw-section/60 px-3 py-2.5 text-sm font-medium text-fw-accent hover:bg-fw-section">
                      Load 50 more root sessions…
                    </button>
                  ) : null}
                </main>
                <SessionInspector
                  session={inspectedSession}
                  parent={inspectedParent}
                  children={inspectedChildren}
                  childTotal={inspectedChildTotal}
                  hasMoreChildren={!!(inspectedSession && childCursors.get(inspectedSession.id))}
                  now={now}
                  current={!!inspectedSession && inspectedSession.id === currentSession}
                  node={inspectedNode}
                  onInspect={inspectSession}
                  onOpen={onSelectSession}
                  onLoadMoreChildren={(sessionId) => loadSessionRelationships(sessionId, 20)}
                  extra={inspectedSession ? <>
                    <SessionTimersSection key={inspectedSession.id} sessionId={inspectedSession.id} onShowTimers={showSessionTimers} />
                    <section className="mt-4 flex items-center justify-between gap-2 border-t border-fw-border-muted pt-4" data-session-activity={inspectedSession.id}>
                      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted">Activity</h3>
                      <button type="button" onClick={() => showActivity({ sessionId: inspectedSession.id, tree: true })} className="text-xs font-medium text-fw-accent hover:underline" data-session-activity-open>View activity</button>
                    </section>
                  </> : null}
                />
              </div>
            </>}
          </div>
        ) : section === 'agents' ? (
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <main className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <div><h2 className="text-sm font-semibold text-fw-text-strong">Agent registry</h2><p className="mt-0.5 text-xs text-fw-text-muted">Manage persistent workspace owners and open self-owned memory in Code.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs text-fw-text-muted" data-system-summary="agents">{agentRegistry.length || summary.agentCount} agents</span><AgentCreationMenu agents={agentRegistry.map(agent => ({ id: agent.id, inherit: agent.inherit || undefined }))} currentAgent={selectedRegistryAgentId || undefined} compact onCreateAgent={createAgentFromRegistry} onCreateSession={createSessionFromRegistry} /></div>
              </div>
              {agentRegistryError ? <div className="mb-3 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger">{agentRegistryError}</div> : null}
              <div className="grid gap-3 md:grid-cols-2">
                {orderedAgentRegistry.map(agent => <AgentRegistryCard key={agent.id} agent={agent} usage={loadedAgentUsage.get(agent.id)} selected={selectedRegistryAgentId === agent.id} onSelect={() => setSelectedRegistryAgentId(agent.id)} />)}
                {agentRegistry.length === 0 && !agentRegistryError ? <div className="col-span-full rounded-xl border border-dashed border-fw-border-strong py-10 text-center text-sm text-fw-text-muted">No agents found.</div> : null}
              </div>
            </main>
            <AgentRegistryInspector agent={selectedRegistryAgent} allAgents={agentRegistry} nodes={displayNodes} installDefaultNode={agentDefaultNode} memoryFiles={agentMemoryFiles} memoryLoading={agentMemoryLoading} memoryError={agentMemoryError} onOpenMemory={openAgentMemory} onSave={saveRegistryAgent} onDelete={deleteRegistryAgent} />
          </div>
        ) : section === 'webhooks' ? (
          <SystemWebhooks onInspectSession={sessionId => sessionMap.has(sessionId) ? showSessionFromNode(sessionId) : onSelectSession(sessionId)} onOpenSession={onSelectSession} />
        ) : section === 'usage' ? (
          <SystemUsage request={usageRequest} onOpenSession={onSelectSession} />
        ) : section === 'activity' ? (
          <SystemActivity request={activityRequest} onOpenSession={onSelectSession} />
        ) : section === 'timers' ? (
          <SystemTimers sessionFilter={timersSessionFilter} onSessionFilterChange={setTimersSessionFilter} onInspectSession={sessionId => sessionMap.has(sessionId) ? showSessionFromNode(sessionId) : onSelectSession(sessionId)} onOpenSession={onSelectSession} />
        ) : (
          <SystemNodes nodes={nodeTargets} error={nodeTargetsError} sessions={sessions} onNodesChanged={reloadNodes} onSelectSession={showSessionFromNode} />
        )}
      </div>
    </div>
  )

}
