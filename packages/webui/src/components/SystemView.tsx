import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Network } from 'lucide-react'
import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import type { Session } from './SessionListCore'
import type { TokenUsage } from './TokenUsageDetails'
import AgentCreationMenu from './AgentCreationMenu'
import SystemNodes from './SystemNodes'
import SystemTimers, { SessionTimersSection } from './SystemTimers'
import SystemWebhooks, { useWebhookList } from './SystemWebhooks'
import SystemUsage from './SystemUsage'
import SystemActivity from './SystemActivity'
import type { ActivityFilters } from '../activity'
import type { UsagePeriod } from '../usageOverview'
import SystemAgents, { type AgentRegistryChanges, type AgentRegistryEntry, type AgentTab } from './SystemAgents'
import type { InstallationPrompt } from './SystemAgentLayers'
import { SessionFilterBar, SessionInspector, SystemSessionsList } from './SystemSessions'
import { renderMetaBadge } from './SystemShared'
import { buildAgentCreationBody, type AgentSettingsChanges } from '../agentCreation'
import { useNodeDirectory } from '../useNodeDirectory'
import { getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'
import { API_BASE_PATH } from '../config'
import { createSessionListRefreshScheduler, requestSessionListStreamOpenResync } from '../sessionListRefresh'
import { BoundedReplayRevisionMismatch, createEpochRows, filterPresentationPathForAgent, mergeDeltaRows, mergeForcedPresentationPath, mergeHttpRows, pruneEpochRows, replayAtomicWindows, replayCursorBranches, replayCursorWindow, trackHttpRowsRequest } from '../boundedSessionReplay'
import { webUiRealtime } from '../realtime'
import { filterArchitectureSessions, getArchitectureSessionModel, getArchitectureSessionNodeId, type ArchitectureStatusFilter } from '../architectureOperations'
import { makeVscodeWebUrl } from '../vscodeWeb'
import { useMobileChatViewport } from '../chatPreferences'
import MobilePageHeader from './MobilePageHeader'

// The Timeline shares Chat rendering pieces; load them only when it is opened.
const SessionSequenceView = lazy(() => import('./SessionSequenceView'))

export type SystemSection = 'agents' | 'sessions' | 'nodes' | 'timers' | 'webhooks' | 'usage' | 'activity'

export const SYSTEM_SECTIONS: Array<{ id: SystemSection; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'timers', label: 'Timers' },
  { id: 'usage', label: 'Usage' },
  { id: 'activity', label: 'Activity' },
  // Shown once a webhook exists, or when a route opens it.
  { id: 'webhooks', label: 'Webhooks' },
]

const SECTION_SUBTITLES: Record<SystemSection, string> = {
  agents: 'Agent workspaces, inheritance and memory.',
  sessions: 'Session state, placement and usage, and how sessions work together.',
  nodes: 'Connected nodes and how to add more.',
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
  /** Opens Setup on its Authorization tab. */
  onOpenSetupAuthorization?: () => void
  /** Opens the Agents section with this Agent's settings; a new nonce repeats the request. */
  agentRequest?: { agent: string; nonce: number } | null
  /** Opens the Sessions list filtered by this state; a new nonce repeats the request. */
  sessionsRequest?: { status: ArchitectureStatusFilter; nonce: number } | null
  /** Opens the Usage section for this period; a new nonce repeats the request. */
  usageRequest?: { period: UsagePeriod; nonce: number } | null
}

/** The Agents inspector's selection, kept while System is unmounted (one System tab exists). */
const agentSelectionMemory: { agent: string | null; tab: AgentTab; request: number } = { agent: null, tab: 'overview', request: 0 }

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
  onOpenSetupAuthorization,
  agentRequest,
  sessionsRequest,
  usageRequest,
}: SystemViewProps) {
  const tabHeader = useWorkbenchTabHeader()
  const phone = useMobileChatViewport() && !tabHeader
  const sectionTabsRef = useRef<HTMLDivElement>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [rootIds, setRootIds] = useState<string[]>([])
  const [rootCursor, setRootCursor] = useState<string | null>(null)
  const [rootTarget, setRootTarget] = useState(50)
  const [childCursors, setChildCursors] = useState<Map<string, string | null>>(new Map())
  const [childTotals, setChildTotals] = useState<Map<string, number>>(new Map())
  const [childIds, setChildIds] = useState<Map<string, string[]>>(new Map())
  const [focusPathIds, setFocusPathIds] = useState<Set<string>>(new Set())
  const [agentCounts, setAgentCounts] = useState<Array<{ agent: string; count: number }>>([])
  const [nodeCounts, setNodeCounts] = useState<Array<{ node: string; count: number }>>([])
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
  // The phone section strip scrolls sideways; keep the selected section in view.
  useEffect(() => {
    const strip = sectionTabsRef.current
    const tab = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!phone || !strip || !tab) return
    const bounds = strip.getBoundingClientRect(), rect = tab.getBoundingClientRect()
    if (rect.left < bounds.left + 16) strip.scrollLeft -= bounds.left + 16 - rect.left
    else if (rect.right > bounds.right - 16) strip.scrollLeft += rect.right - (bounds.right - 16)
  }, [phone, section])
  const setSection = useCallback((next: SystemSection) => { setSectionState(next); onSectionChangeRef.current?.(next) }, [])
  const webhookList = useWebhookList()
  const [agentRegistry, setAgentRegistry] = useState<AgentRegistryEntry[]>([])
  // An Agent request applies once; a remount doesn't replay it.
  const pendingAgentRequest = agentRequest && agentRequest.nonce !== agentSelectionMemory.request ? agentRequest : null
  const [selectedRegistryAgentId, setSelectedRegistryAgentId] = useState<string | null>(pendingAgentRequest?.agent || agentSelectionMemory.agent || 'main')
  const [installationPrompt, setInstallationPrompt] = useState<InstallationPrompt>(null)
  const [agentTab, setAgentTab] = useState<AgentTab>(pendingAgentRequest ? 'settings' : agentSelectionMemory.tab)
  // Opening a file in Code replaces this tab's content; coming back restores the inspected Agent.
  useEffect(() => { agentSelectionMemory.agent = selectedRegistryAgentId; agentSelectionMemory.tab = agentTab }, [selectedRegistryAgentId, agentTab])
  // Requests that open a selection's details when the pane shows the list alone.
  const [agentDetailRequest, setAgentDetailRequest] = useState(0)
  const [sessionDetailRequest, setSessionDetailRequest] = useState(0)
  useEffect(() => {
    if (!agentRequest || agentRequest.nonce === agentSelectionMemory.request) return
    agentSelectionMemory.request = agentRequest.nonce
    setSection('agents')
    setSelectedRegistryAgentId(agentRequest.agent)
    setAgentTab('settings')
    setAgentDetailRequest(value => value + 1)
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
    let summary = globalSummary; let counts = agentCounts; let nodes = nodeCounts
    for (const page of result.pages as any[]) { const payload = page.architecturePayload; summary = payload.summary || summary; counts = payload.agentCounts || counts; nodes = payload.nodeCounts || nodes
      for (const group of payload.children || []) { ids.set(group.parentSessionId, (group.sessions || []).map((row: Session) => row.id)); totals.set(group.parentSessionId, Number(group.total || 0)); cursors.set(group.parentSessionId, group.nextCursor || null); rows.push(...(group.sessions || [])) } }
    return { rootIds: result.items.map(row => row.id), rootCursor: result.nextCursor, childIds: ids, childTotals: totals, childCursors: cursors, rows, summary, agentCounts: counts, nodeCounts: nodes, revision: result.revision }
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
    setChildIds(ids); setChildTotals(totals); setChildCursors(cursors); setAgentCounts(roots.agentCounts); setNodeCounts(roots.nodeCounts); setGlobalSummary(roots.summary)
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
      setInstallationPrompt(payload.prompt?.installation || null)
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
  const agentCount = agentRegistry.length || summary.agentCount

  const visibleSessions = useMemo(
    () => filterArchitectureSessions(sessions, statusFilter, searchQuery, { nodeId: nodeFilter, model: modelFilter })
      .sort((left, right) => (right.lastMessageTime || 0) - (left.lastMessageTime || 0) || left.id.localeCompare(right.id)),
    [sessions, statusFilter, searchQuery, nodeFilter, modelFilter],
  )
  const nodeSessionCounts = useMemo(() => new Map(nodeCounts.map(item => [item.node, Number(item.count) || 0])), [nodeCounts])
  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) { const model = getArchitectureSessionModel(session); if (model) counts.set(model, (counts.get(model) || 0) + 1) }
    if (modelFilter && !counts.has(modelFilter)) counts.set(modelFilter, 0)
    return [...counts].sort((left, right) => left[0].localeCompare(right[0])).map(([id, count]) => ({ id, count }))
  }, [sessions, modelFilter])

  const displayNodes = useMemo(() => {
    const byId = new Map(nodeTargets.map(node => [node.id, node]))
    for (const nodeId of nodeSessionCounts.keys()) {
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
  }, [nodeTargets, nodeSessionCounts])

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
  ]


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
  const nodeLabels = useMemo(() => new Map(displayNodes.map(node => [node.id, node.displayName || node.id])), [displayNodes])
  const nodeOptions = displayNodes.map(node => ({ id: node.id, label: node.displayName || node.id, count: sessions.filter(session => getArchitectureSessionNodeId(session) === node.id).length }))
  /** Shows a Session in the Sessions list with its details. */
  const showSession = (sessionId: string) => {
    setStatusFilter('all'); setSearchQuery(''); setNodeFilter(null); setModelFilter(null)
    setSessionsView('list')
    setSection('sessions')
    inspectSession(sessionId)
    setSessionDetailRequest(value => value + 1)
  }
  const showAgentSessions = (agentId: string) => {
    setStatusFilter('all'); setSearchQuery(''); setNodeFilter(null); setModelFilter(null); setSelectedAgent(agentId)
    setSessionsView('list')
    setSection('sessions')
  }
  const showNodeSessions = (nodeId: string) => {
    setStatusFilter('all'); setSearchQuery(''); setModelFilter(null); setNodeFilter(nodeId)
    setSessionsView('list')
    setSection('sessions')
  }
  // Creates the empty installation additions file through Code's file route, then opens it.
  const createInstallationPrompt = async () => {
    if (!installationPrompt) return
    const params = new URLSearchParams({ nodeId: 'master', path: installationPrompt.path, create: 'true', overwrite: 'false' })
    const response = await fetch(`${API_BASE_PATH}/vscode-web/fs/write-file?${params}`, { method: 'PUT', body: new Uint8Array() })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      // Created meanwhile by someone else: open it as it is.
      if (payload.code !== 'FileExists') throw new Error(payload.message || payload.error || `Couldn't create the file (${response.status})`)
    }
    await loadAgentRegistry()
    openAgentMemory(installationPrompt.path.replace(/[\\/][^\\/]*$/, ''), installationPrompt.path)
  }
  const tabClass = (active: boolean, kind = 'foxwarm-system-tab', touch = false) => `${kind} shrink-0 whitespace-nowrap rounded-md font-medium ${touch ? 'min-h-9 px-3.5 text-[13px]' : 'px-3 py-1 text-xs'} ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`

  const sectionTabs = (
    <div ref={sectionTabsRef} className={phone ? 'mobile-system-tabs -mx-4 overflow-x-auto px-4' : undefined}>
      <div className={`inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5 ${phone ? 'mobile-glass-surface' : ''}`} role="tablist">
        {SYSTEM_SECTIONS.filter(item => item.id !== 'webhooks' || section === 'webhooks' || webhookList.webhooks.length > 0).map(item => (
          <button key={item.id} type="button" role="tab" aria-selected={section === item.id} data-active={section === item.id} data-system-tab={item.id} onClick={() => setSection(item.id)} className={tabClass(section === item.id, 'foxwarm-system-tab', phone)}>{item.label}</button>
        ))}
      </div>
    </div>
  )
  const headerBadges = summary.managedCount > 0 || nodeTargetsError ? <>
    {summary.managedCount > 0 ? renderMetaBadge(`${summary.managedCount} managed`, 'active') : null}
    {nodeTargetsError ? renderMetaBadge('node status unavailable', 'warning') : null}
  </> : null
  const renderSessionInspector = () => (
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
  )
  const sessionsHeaderRow = (
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
  )
  const sessionsFilterBar = (
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
  )
  const sessionToolbar = <div className="space-y-3">{sessionsHeaderRow}{sessionsFilterBar}</div>
  // The list holds a bounded window: say how much of it is shown and how much exists.
  const sessionLoadMore = (
    <>
      <div className="flex items-center justify-between border-t border-fw-border-muted px-3 py-2 text-xs text-fw-text-muted" data-system-session-count>
        <span>{visibleSessions.length} of {sessions.length} loaded sessions · {summary.sessionCount} in total</span>
      </div>
      {rootCursor ? <button type="button" onClick={() => { void replayArchitecture(rootTargetRef.current + 50, new Map(branchTargetsRef.current)) }} className="w-full border-t border-fw-border-muted px-3 py-2.5 text-sm font-medium text-fw-accent hover:bg-fw-section">Load 50 more root sessions…</button> : null}
    </>
  )
  const agentToolbar = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fw-text-muted" data-system-summary="agents">{agentCount} agent{agentCount === 1 ? '' : 's'}</span>
      <AgentCreationMenu agents={agentRegistry.map(agent => ({ id: agent.id, inherit: agent.inherit || undefined }))} currentAgent={selectedRegistryAgentId || undefined} compact onCreateAgent={createAgentFromRegistry} onCreateSession={createSessionFromRegistry} />
    </div>
  )
  const inspectSessionFromSection = (sessionId: string) => sessionMap.has(sessionId) ? showSession(sessionId) : onSelectSession(sessionId)
  // Sections whose list and details fill the pane and scroll separately when it is wide.
  const splitSection = section === 'agents' || section === 'timers' || section === 'webhooks' || (section === 'sessions' && sessionsView === 'list')
  const content = (
    section === 'sessions' ? (
      sessionsView === 'timeline' ? (
        <div className="space-y-4 pb-4">
          {sessionsHeaderRow}
          <Suspense fallback={<div className="p-6 text-sm text-fw-text-muted">Loading timeline…</div>}><SessionSequenceView currentSession={currentSession} onSelectSession={onSelectSession} /></Suspense>
        </div>
      ) : (
        <SystemSessionsList
          phone={phone}
          detailRequest={sessionDetailRequest}
          toolbar={sessionToolbar}
          sessions={visibleSessions}
          selectedId={inspectedSessionId}
          currentId={currentSession}
          now={now}
          nodeLabels={nodeLabels}
          onSelect={inspectSession}
          onOpen={onSelectSession}
          footer={sessionLoadMore}
          detail={renderSessionInspector()}
        />
      )
    ) : section === 'agents' ? (
      <SystemAgents
        phone={phone}
        now={now}
        agents={agentRegistry}
        error={agentRegistryError}
        sessions={sessions}
        nodes={displayNodes}
        installDefaultNode={agentDefaultNode}
        installationPrompt={installationPrompt}
        selectedId={selectedRegistryAgentId}
        onSelect={setSelectedRegistryAgentId}
        tab={agentTab}
        onTabChange={setAgentTab}
        detailRequest={agentDetailRequest}
        toolbar={agentToolbar}
        onCreateSession={agentId => { void createSessionFromRegistry(agentId) }}
        onInspectSession={showSession}
        onOpenSession={onSelectSession}
        onShowAgentSessions={showAgentSessions}
        onOpenInCode={openAgentMemory}
        onCreateInstallationPrompt={createInstallationPrompt}
        onOpenSetupAuthorization={onOpenSetupAuthorization}
        onSave={saveRegistryAgent}
        onDelete={deleteRegistryAgent}
      />
    ) : section === 'webhooks' ? (
      <SystemWebhooks phone={phone} onInspectSession={inspectSessionFromSection} onOpenSession={onSelectSession} />
    ) : section === 'usage' ? (
      <div className="pb-4"><SystemUsage request={usageRequest} onOpenSession={onSelectSession} /></div>
    ) : section === 'activity' ? (
      <div className="pb-4"><SystemActivity request={activityRequest} onOpenSession={onSelectSession} /></div>
    ) : section === 'timers' ? (
      <SystemTimers phone={phone} sessionFilter={timersSessionFilter} onSessionFilterChange={setTimersSessionFilter} onInspectSession={inspectSessionFromSection} onOpenSession={onSelectSession} />
    ) : (
      <SystemNodes nodes={nodeTargets} error={nodeTargetsError} sessions={sessions} sessionCounts={nodeSessionCounts} phone={phone} onNodesChanged={reloadNodes} onShowSessions={showNodeSessions} />
    )
  )

  // Phones use the mobile page frame: a floating header with Back, the title and the section
  // switch, over content that scrolls beneath it and clears the bottom safe area. Both frames
  // share one element tree with `content` at the same position, so crossing the phone
  // breakpoint restyles the page without remounting the open section, its modals or its state.
  return (
    <div className={phone ? 'mobile-page-root mobile-system-page h-full min-h-0 overflow-hidden bg-fw-canvas' : 'flex h-full min-h-0 flex-col overflow-hidden bg-fw-canvas'} data-system-section={section}>
      {phone ? (
        <MobilePageHeader title="System"
          leading={onBack ? <button type="button" onClick={onBack} aria-label="Back" className="mobile-header-circle"><ArrowLeft size={20} /></button> : null}
          actions={headerBadges ? <div className="flex flex-wrap justify-end gap-1">{headerBadges}</div> : null}>
          {sectionTabs}
        </MobilePageHeader>
      ) : null}
      <div className={phone ? 'h-full overflow-y-auto overflow-x-hidden px-4' : 'mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col px-4 pt-4 md:px-5 md:pt-5 lg:px-6 lg:pt-6'} data-system-scroll={phone ? '' : undefined}>
        {phone ? null : (
          <header className="mb-4 shrink-0">
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
                {headerBadges}
                <WorkbenchPaneControls />
              </div>
            </WorkbenchHeaderDragArea>
            <nav className="mt-4 flex items-center gap-1 border-b border-fw-border-muted pb-3" aria-label="System sections">
              {sectionTabs}
            </nav>
          </header>
        )}
        {/* On desktop the header stays put; the section scrolls below it, or fills it and scrolls
            its list and details separately. Phones scroll the whole page. The same elements
            render on both, so crossing the breakpoint keeps the section and its modals mounted. */}
        <div className={phone ? '' : 'min-h-0 flex-1 overflow-y-auto'} data-system-scroll={phone ? undefined : ''}>
          <div className={!phone && splitSection ? 'h-full pb-4' : ''}>{content}</div>
        </div>
      </div>
    </div>
  )

}
