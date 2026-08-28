import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, ArrowLeft, Bot, ChevronRight, CircleDot, Clock3, ExternalLink, FileText, FolderOpen, GitFork, Layers3, ListFilter, MemoryStick, MessageSquare, Network, Save, Search, Server, Shield, Trash2 } from 'lucide-react'
import type { Session } from './SessionListCore'
import AgentCreationMenu from './AgentCreationMenu'
import { getRuntimeStateSummary, getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'
import { API_BASE_PATH } from '../config'
import { createSessionListRefreshScheduler, requestSessionListStreamOpenResync } from '../sessionListRefresh'
import { BoundedReplayRevisionMismatch, createEpochRows, filterPresentationPathForAgent, mergeDeltaRows, mergeForcedPresentationPath, mergeHttpRows, pruneEpochRows, replayAtomicWindows, replayCursorBranches, replayCursorWindow, trackHttpRowsRequest } from '../boundedSessionReplay'
import { webUiRealtime } from '../realtime'
import { parseWebUiNodeTargets, type WebUiNodeTarget } from '../nodeTargets'
import { filterArchitectureSessions, getArchitectureNodePreview, getArchitectureSessionNodeId, groupArchitectureSessionsByNode, orderArchitectureAgents, type ArchitectureStatusFilter } from '../architectureOperations'
import { makeVscodeWebUrl } from '../vscodeWeb'

interface ArchitectureViewProps {
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onBack?: () => void
  onCreateAgent?: (agentId: string, inheritAgent?: string) => Promise<void>
  onCreateSession?: (agentId: string, sessionId?: string) => Promise<void>
  onAgentsChanged?: () => void | Promise<void>
  onOpenAgentMemory?: (memoryRoot: string, filePath?: string) => void
}

type AgentRegistryEntry = {
  id: string
  inherit: string | null
  inheritanceChain: string[]
  isolated: boolean
  isolatedNode: string | null
  sessionCount: number
  activeSessionCount: number
  queuedSessionCount: number
  memoryRoot: string
  memoryFileCount: number
  memoryLastModified: number | null
}

type AgentMemoryFile = { path: string; absolutePath: string; size: number; modifiedAt: number }

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return 'No messages yet'
  const diff = Math.max(0, Date.now() - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  return `${Math.floor(diff / day)}d ago`
}

const formatBusyDuration = (startedAt?: number | null, now: number = Date.now()) => {
  if (!startedAt) return '—'
  const totalSeconds = Math.floor(Math.max(0, now - startedAt) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const formatTokenCount = (value: number | undefined) => {
  const tokens = value || 0
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return String(tokens)
}

const renderMetaBadge = (label: string, tone: 'default' | 'active' | 'warning' | 'muted' = 'default') => {
  const toneClasses = {
    default: 'bg-gray-100 text-gray-700 dark:bg-gray-700/70 dark:text-gray-200',
    active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
    muted: 'bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClasses[tone]}`}>{label}</span>
}

const getStatusTone = (session: Session) => {
  const state = getSessionRuntimeStateName(session)
  if (state === 'requesting-model') return 'bg-blue-500'
  if (state === 'running-tool') return 'bg-violet-500'
  if (state === 'waiting') return 'bg-amber-500'
  return 'bg-gray-300 dark:bg-gray-600'
}

function SummaryMetric({ label, value, detail, icon, active, onClick }: {
  label: string
  value: string | number
  detail?: string
  icon: ReactNode
  active?: boolean
  onClick?: () => void
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">{label}</span>
        <span className="text-gray-400 dark:text-gray-500">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">{value}</div>
      {detail ? <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{detail}</div> : null}
    </>
  )
  const classes = `rounded-xl border p-3 text-left transition-colors ${active
    ? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/30'
    : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'} ${onClick ? 'hover:border-gray-300 dark:hover:border-gray-600' : ''}`
  return onClick ? <button type="button" onClick={onClick} className={classes}>{content}</button> : <div className={classes}>{content}</div>
}

function SessionOperationRow({ session, selected, current, now, onInspect, onOpen }: {
  session: Session
  selected: boolean
  current: boolean
  now: number
  onInspect: () => void
  onOpen: () => void
}) {
  const runtimeState = getSessionRuntimeStateName(session)
  const runtimeSummary = getRuntimeStateSummary(session.runtimeState, !!session.busy)
  const queueLength = session.runtimeState?.queueLength ?? session.queueLength ?? 0
  const activeSince = session.runtimeState?.since || session.busyStartedAt
  const model = session.runtimeState?.active?.modelKey || session.modelKey || session.model || session.defaultModelKey
  const name = session.displayName || session.id

  return (
    <div
      role="button"
      tabIndex={0}
      data-architecture-session-id={session.id}
      data-architecture-session-selected={selected ? 'true' : 'false'}
      onClick={onInspect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onInspect() } }}
      className={`group rounded-lg border px-3 py-2.5 outline-none transition-colors ${selected
        ? 'border-blue-400 bg-blue-50/80 ring-1 ring-blue-200 dark:border-blue-600 dark:bg-blue-950/30 dark:ring-blue-900'
        : 'border-gray-200 bg-gray-50/70 hover:border-gray-300 hover:bg-white dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600 dark:hover:bg-gray-800'} focus-visible:ring-2 focus-visible:ring-blue-500`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${getStatusTone(session)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-gray-900 dark:text-white" title={name}>{name}</span>
            {current ? renderMetaBadge('current', 'active') : null}
            {session.isolated ? renderMetaBadge('isolated', 'warning') : null}
            {session.archived ? renderMetaBadge('archived', 'muted') : null}
          </div>
          {session.displayName ? <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400 dark:text-gray-500">{session.id}</div> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-700 dark:text-gray-200">{runtimeSummary}</span>
            {runtimeState !== 'idle' ? <span>{formatBusyDuration(activeSince, now)}</span> : null}
            <span>agent {session.agent || 'main'}</span>
            {queueLength > 0 ? <span className="text-amber-600 dark:text-amber-300">queued {queueLength}</span> : null}
            {model ? <span className="max-w-[180px] truncate" title={model}>model {model}</span> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onOpen() }}
          title="Open session"
          className="rounded-md p-1.5 text-gray-400 opacity-70 transition hover:bg-gray-100 hover:text-gray-700 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function NodeLane({ node, rows, selectedSessionId, currentSession, now, onInspect, onOpen }: {
  node: WebUiNodeTarget
  rows: Session[]
  selectedSessionId: string | null
  currentSession?: string
  now: number
  onInspect: (sessionId: string) => void
  onOpen: (sessionId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const activeCount = rows.filter(isSessionRuntimeActive).length
  const waitingCount = rows.filter(session => getSessionRuntimeStateName(session) === 'waiting').length
  const serviceCount = Object.keys(node.services || {}).length
  const upgradeRequired = node.protocolStatus === 'upgrade-required'
  const ready = node.online && !upgradeRequired
  const quarantined = node.online && upgradeRequired
  const statusLabel = quarantined ? 'upgrade required' : node.online ? 'ready' : upgradeRequired ? 'offline · upgrade required' : 'offline'
  const preferredIds = new Set([selectedSessionId, currentSession].filter((id): id is string => !!id))
  const visibleRows = expanded ? rows : getArchitectureNodePreview(rows, preferredIds)
  return (
    <section data-architecture-node-id={node.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ready ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300' : quarantined ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500'}`}>
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{node.displayName || node.id}</h3>
              <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : quarantined ? 'bg-amber-500' : 'bg-gray-400'}`} />
              <span className={`text-[10px] uppercase tracking-wide ${quarantined ? 'text-amber-600 dark:text-amber-300' : 'text-gray-400'}`}>{statusLabel}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{node.id} · {node.type || 'remote'}{serviceCount ? ` · ${serviceCount} services` : ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
          <span>{rows.length} loaded</span>
          {activeCount > 0 ? <span className="text-blue-600 dark:text-blue-300">{activeCount} active</span> : null}
          {waitingCount > 0 ? <span className="text-amber-600 dark:text-amber-300">{waitingCount} waiting</span> : null}
        </div>
      </header>
      {rows.length > 0 ? (
        <>
          <div data-architecture-node-session-scroll className="max-h-[360px] overflow-y-auto overscroll-contain">
            <div className="grid gap-2 p-3 lg:grid-cols-2">
              {visibleRows.map(session => (
                <SessionOperationRow
                  key={session.id}
                  session={session}
                  selected={selectedSessionId === session.id}
                  current={currentSession === session.id}
                  now={now}
                  onInspect={() => onInspect(session.id)}
                  onOpen={() => onOpen(session.id)}
                />
              ))}
            </div>
          </div>
          {rows.length > 6 ? (
            <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-700">
              <button type="button" onClick={() => setExpanded(value => !value)} className="w-full rounded-lg px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30">
                {expanded ? 'Show operational preview' : `Browse ${rows.length - visibleRows.length} more in this node…`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

const InspectorField = ({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 py-1.5 text-xs">
    <dt className="text-gray-400 dark:text-gray-500">{label}</dt>
    <dd className={`min-w-0 break-words text-gray-700 dark:text-gray-200 ${mono ? 'font-mono text-[11px]' : ''}`}>{value || '—'}</dd>
  </div>
)

function SessionInspector({ session, parent, children, childTotal, hasMoreChildren, now, current, node, onInspect, onOpen, onLoadMoreChildren }: {
  session: Session | null
  parent: Session | null
  children: Session[]
  childTotal: number
  hasMoreChildren: boolean
  now: number
  current: boolean
  node: WebUiNodeTarget | null
  onInspect: (sessionId: string) => void
  onOpen: (sessionId: string) => void
  onLoadMoreChildren: (sessionId: string) => void
}) {
  if (!session) {
    return (
      <aside className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center dark:border-gray-700 dark:bg-gray-800/50">
        <CircleDot className="mx-auto h-6 w-6 text-gray-300 dark:text-gray-600" />
        <h3 className="mt-3 text-sm font-semibold text-gray-700 dark:text-gray-200">Select a session</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">Inspect runtime, placement, queue, tokens, and lineage without navigating away.</p>
      </aside>
    )
  }

  const state = getSessionRuntimeStateName(session)
  const runtime = session.runtimeState
  const queueLength = runtime?.queueLength ?? session.queueLength ?? 0
  const tokenUsage = session.tokenUsage || { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const totalTokens = tokenUsage.cachedTokens + tokenUsage.inputTokens + tokenUsage.outputTokens
  const model = runtime?.active?.modelKey || session.modelKey || session.model || session.defaultModelKey
  const waiting = runtime?.waiting
  const tool = runtime?.tool

  return (
    <aside data-architecture-inspector-session-id={session.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:sticky xl:top-4">
      <div className="border-b border-gray-100 p-4 dark:border-gray-700">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-gray-900 dark:text-white">{session.displayName || session.id}</h2>
              {current ? renderMetaBadge('current', 'active') : null}
            </div>
            {session.displayName ? <div className="mt-1 break-all font-mono text-[10px] text-gray-400">{session.id}</div> : null}
          </div>
          <button type="button" onClick={() => onOpen(session.id)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`h-2 w-2 rounded-full ${getStatusTone(session)}`} />
          <span className="font-medium text-gray-800 dark:text-gray-100">{getRuntimeStateSummary(runtime, !!session.busy)}</span>
          {state !== 'idle' ? <span className="text-gray-400">for {formatBusyDuration(runtime?.since || session.busyStartedAt, now)}</span> : null}
        </div>
      </div>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-4">
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Runtime</h3>
          <dl className="mt-1">
            <InspectorField label="State" value={state} />
            <InspectorField label="Phase" value={runtime?.active?.phase || '—'} />
            <InspectorField label="Model" value={model || '—'} mono />
            <InspectorField label="Queue" value={String(queueLength)} />
            {tool ? <InspectorField label="Tool" value={`${tool.name}${typeof tool.index === 'number' && typeof tool.total === 'number' ? ` ${tool.index + 1}/${tool.total}` : ''}`} /> : null}
            {tool?.argsPreview ? <InspectorField label="Arguments" value={tool.argsPreview} mono /> : null}
          </dl>
        </section>

        {waiting ? (
          <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-500">Wait condition</h3>
            <dl className="mt-1">
              <InspectorField label="Waiting for" value={waiting.waitingFor} />
              <InspectorField label="Reason" value={waiting.reason || '—'} />
              {waiting.waitAllSessions ? <InspectorField label="Sessions" value={`${waiting.satisfiedSessions?.length || 0}/${waiting.waitAllSessions.length} satisfied`} /> : null}
              {waiting.pendingSessions?.length ? <InspectorField label="Pending" value={waiting.pendingSessions.join(', ')} mono /> : null}
              {waiting.waitExecIds?.length ? <InspectorField label="Exec IDs" value={waiting.waitExecIds.join(', ')} mono /> : null}
            </dl>
          </section>
        ) : null}

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Placement</h3>
          <dl className="mt-1">
            <InspectorField label="Agent" value={session.agent || 'main'} />
            <InspectorField label="Node" value={<span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${node?.online ? 'bg-emerald-500' : 'bg-gray-400'}`} />{node?.displayName || getArchitectureSessionNodeId(session)}</span>} />
            <InspectorField label="Node ID" value={getArchitectureSessionNodeId(session)} mono />
            <InspectorField label="CWD" value={session.cwd || '—'} mono />
            <InspectorField label="Isolation" value={session.isolated ? 'isolated agent' : 'shared runtime'} />
          </dl>
        </section>

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Activity</h3>
          <dl className="mt-1">
            <InspectorField label="Messages" value={String(session.messageCount || 0)} />
            <InspectorField label="Updated" value={formatRelativeTime(session.lastMessageTime)} />
            <InspectorField label="Tokens" value={formatTokenCount(totalTokens)} />
            <InspectorField label="Cached" value={formatTokenCount(tokenUsage.cachedTokens)} />
            <InspectorField label="Input / output" value={`${formatTokenCount(tokenUsage.inputTokens)} / ${formatTokenCount(tokenUsage.outputTokens)}`} />
          </dl>
        </section>

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Relationships</h3>
          <div className="mt-2 space-y-1.5">
            {parent ? (
              <button type="button" onClick={() => onInspect(parent.id)} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 text-left text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                <GitFork className="h-3.5 w-3.5 rotate-180 text-gray-400" />
                <span className="min-w-0 flex-1 truncate"><span className="text-gray-400">parent</span> {parent.displayName || parent.id}</span>
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
              </button>
            ) : <div className="text-xs text-gray-400">Root session</div>}
            {children.map(child => (
              <button key={child.id} type="button" onClick={() => onInspect(child.id)} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 text-left text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                <GitFork className="h-3.5 w-3.5 text-gray-400" />
                <span className="min-w-0 flex-1 truncate"><span className="text-gray-400">child</span> {child.displayName || child.id}</span>
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
              </button>
            ))}
            {children.length === 0 && childTotal === 0 ? <div className="text-xs text-gray-400">No child sessions</div> : null}
            {hasMoreChildren ? <button type="button" onClick={() => onLoadMoreChildren(session.id)} className="w-full rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30">Load more relationships…</button> : null}
          </div>
        </section>
      </div>
    </aside>
  )
}

const formatBytes = (size: number) => {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

function AgentRegistryCard({ agent, selected, onSelect }: { agent: AgentRegistryEntry; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-architecture-agent-id={agent.id}
      data-architecture-agent-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      className={`rounded-xl border p-4 text-left shadow-sm transition-colors ${selected
        ? 'border-blue-400 bg-blue-50/80 ring-1 ring-blue-200 dark:border-blue-600 dark:bg-blue-950/30 dark:ring-blue-900'
        : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300"><Bot className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{agent.id}</h3>
            <p className="mt-0.5 truncate text-[11px] text-gray-400">{agent.inherit ? `inherits ${agent.inherit}` : 'independent memory'}</p>
          </div>
        </div>
        {agent.isolated ? renderMetaBadge(agent.isolatedNode ? `isolated · ${agent.isolatedNode}` : 'isolated', 'warning') : null}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-gray-50 px-2 py-2 dark:bg-gray-900/50"><div className="text-base font-semibold tabular-nums text-gray-900 dark:text-white">{agent.sessionCount}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">sessions</div></div>
        <div className="rounded-lg bg-gray-50 px-2 py-2 dark:bg-gray-900/50"><div className="text-base font-semibold tabular-nums text-blue-600 dark:text-blue-300">{agent.activeSessionCount}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">active</div></div>
        <div className="rounded-lg bg-gray-50 px-2 py-2 dark:bg-gray-900/50"><div className="text-base font-semibold tabular-nums text-gray-900 dark:text-white">{agent.memoryFileCount}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">memory</div></div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-gray-400">
        <span>{agent.queuedSessionCount > 0 ? `${agent.queuedSessionCount} queued` : 'queue clear'}</span>
        <span>{agent.memoryLastModified ? `memory ${formatRelativeTime(agent.memoryLastModified)}` : 'no memory files'}</span>
      </div>
    </button>
  )
}

function AgentRegistryInspector({ agent, allAgents, nodes, memoryFiles, memoryLoading, memoryError, onOpenMemory, onSave, onDelete }: {
  agent: AgentRegistryEntry | null
  allAgents: AgentRegistryEntry[]
  nodes: WebUiNodeTarget[]
  memoryFiles: AgentMemoryFile[]
  memoryLoading: boolean
  memoryError: string
  onOpenMemory: (memoryRoot: string, filePath?: string) => void
  onSave: (agentId: string, changes: { inheritAgent: string | null; isolatedNode: string | null }) => Promise<void>
  onDelete: (agentId: string) => Promise<void>
}) {
  const [inheritAgent, setInheritAgent] = useState('')
  const [isolatedNode, setIsolatedNode] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setInheritAgent(agent?.inherit || '')
    setIsolatedNode(agent?.isolatedNode || '')
    setDeleteOpen(false)
    setDeleteConfirm('')
    setError('')
  }, [agent?.id, agent?.inherit, agent?.isolatedNode])

  if (!agent) {
    return <aside className="rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center dark:border-gray-700 dark:bg-gray-800/50"><Bot className="mx-auto h-6 w-6 text-gray-300" /><h3 className="mt-3 text-sm font-semibold text-gray-700 dark:text-gray-200">Select an agent</h3><p className="mt-1 text-xs text-gray-500">Inspect memory, inheritance, isolation, and lifecycle controls.</p></aside>
  }

  const dirty = inheritAgent !== (agent.inherit || '') || isolatedNode !== (agent.isolatedNode || '')
  const save = async () => {
    setSaving(true); setError('')
    try { await onSave(agent.id, { inheritAgent: inheritAgent || null, isolatedNode: isolatedNode || null }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  const remove = async () => {
    setSaving(true); setError('')
    try { await onDelete(agent.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false) }
  }

  return (
    <aside data-architecture-agent-inspector-id={agent.id} className="order-first overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:order-none xl:sticky xl:top-4">
      <header className="border-b border-gray-100 p-4 dark:border-gray-700">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-base font-semibold text-gray-900 dark:text-white">{agent.id}</h2><p className="mt-1 text-xs text-gray-400">Persistent workspace and memory owner</p></div>
          <button type="button" onClick={() => onOpenMemory(agent.memoryRoot)} className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"><FolderOpen className="h-3.5 w-3.5" /> Memory</button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">{renderMetaBadge(`${agent.sessionCount} sessions`)}{agent.activeSessionCount ? renderMetaBadge(`${agent.activeSessionCount} active`, 'active') : null}{agent.isolated ? renderMetaBadge('isolated', 'warning') : renderMetaBadge('shared runtime', 'muted')}</div>
      </header>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-4">
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Memory inheritance</h3>
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-gray-500">{agent.inheritanceChain.map((item, index) => <span key={item} className="inline-flex items-center gap-1"><span className={`rounded px-1.5 py-0.5 ${item === agent.id ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200' : 'bg-gray-100 dark:bg-gray-700'}`}>{item}</span>{index < agent.inheritanceChain.length - 1 ? <ChevronRight className="h-3 w-3" /> : null}</span>)}</div>
          <label className="mt-3 block text-xs text-gray-500">Inherit agent<select value={inheritAgent} onChange={event => setInheritAgent(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs text-gray-800 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"><option value="">None</option>{allAgents.filter(item => item.id !== agent.id && !item.isolated).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        </section>

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400"><Shield className="h-3.5 w-3.5" /> Isolation</h3>
          <label className="mt-2 block text-xs text-gray-500">Execution node<select value={isolatedNode} onChange={event => setIsolatedNode(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs text-gray-800 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"><option value="">Shared runtime</option>{nodes.filter(node => node.id !== 'master').map(node => <option key={node.id} value={node.id} disabled={node.protocolStatus === 'upgrade-required'}>{node.displayName} · {node.protocolStatus === 'upgrade-required' ? 'upgrade required' : node.online ? 'ready' : 'offline'}</option>)}</select></label>
          <button type="button" disabled={!dirty || saving} onClick={() => { void save() }} className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save agent settings'}</button>
        </section>

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400"><MemoryStick className="h-3.5 w-3.5" /> Memory files</h3><span className="text-[10px] text-gray-400">{memoryFiles.length} Markdown</span></div>
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {memoryLoading ? <div className="py-4 text-center text-xs text-gray-400">Loading memory manifest…</div> : null}
            {memoryError ? <div className="rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-300">{memoryError}</div> : null}
            {!memoryLoading && !memoryError && memoryFiles.map(file => (
              <button key={file.path} type="button" onClick={() => onOpenMemory(agent.memoryRoot, file.absolutePath)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700">
                <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" /><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-gray-700 dark:text-gray-200" title={file.path}>{file.path}</span><span className="shrink-0 text-[9px] text-gray-400">{formatBytes(file.size)}</span>
              </button>
            ))}
            {!memoryLoading && !memoryError && memoryFiles.length === 0 ? <div className="py-4 text-center text-xs text-gray-400">No Markdown memory files.</div> : null}
          </div>
        </section>

        <section className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-red-400">Danger zone</h3>
          {agent.id === 'main' ? <p className="mt-2 text-xs text-gray-400">The main agent cannot be deleted.</p> : !deleteOpen ? <button type="button" onClick={() => setDeleteOpen(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"><Trash2 className="h-3.5 w-3.5" /> Delete agent</button> : (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900 dark:bg-red-950/20"><p className="text-xs leading-5 text-red-700 dark:text-red-300">Deletes {agent.sessionCount} session(s), this workspace, and self-owned memory. Durable session archives remain reserved. Type <strong>{agent.id}</strong> to confirm.</p><input value={deleteConfirm} onChange={event => setDeleteConfirm(event.target.value)} className="mt-2 w-full rounded-md border border-red-200 bg-white px-2.5 py-1.5 font-mono text-xs outline-none dark:border-red-900 dark:bg-gray-900" /><div className="mt-2 flex gap-2"><button type="button" onClick={() => { setDeleteOpen(false); setDeleteConfirm('') }} className="flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs dark:border-gray-700">Cancel</button><button type="button" disabled={deleteConfirm !== agent.id || saving} onClick={() => { void remove() }} className="flex-1 rounded-md bg-red-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40">Delete</button></div></div>
          )}
        </section>
        {error ? <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-300">{error}</div> : null}
      </div>
    </aside>
  )
}

export default function ArchitectureView({
  currentSession,
  onSelectSession,
  onBack,
  onCreateAgent,
  onCreateSession,
  onAgentsChanged,
  onOpenAgentMemory,
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
  const [statusFilter, setStatusFilter] = useState<ArchitectureStatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(currentSession || null)
  const [nodeTargets, setNodeTargets] = useState<WebUiNodeTarget[]>(() => parseWebUiNodeTargets({ nodes: [] }))
  const [nodeTargetsError, setNodeTargetsError] = useState('')
  const [surface, setSurface] = useState<'topology' | 'agents'>('topology')
  const [agentRegistry, setAgentRegistry] = useState<AgentRegistryEntry[]>([])
  const [selectedRegistryAgentId, setSelectedRegistryAgentId] = useState<string | null>('main')
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

  useEffect(() => {
    let disposed = false
    const loadNodes = async () => {
      try {
        const response = await fetch(`${API_BASE_PATH}/nodes`)
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `Node query failed (${response.status})`)
        if (!disposed) { setNodeTargets(parseWebUiNodeTargets(payload)); setNodeTargetsError('') }
      } catch (error) {
        if (!disposed) setNodeTargetsError(error instanceof Error ? error.message : String(error))
      }
    }
    void loadNodes()
    const timer = window.setInterval(() => { void loadNodes() }, 30_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

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
    if (surface !== 'agents') return
    const timer = window.setInterval(() => { void loadAgentRegistry() }, 30_000)
    return () => window.clearInterval(timer)
  }, [loadAgentRegistry, surface])

  useEffect(() => {
    if (surface !== 'agents' || !selectedRegistryAgentId) { setAgentMemoryFiles([]); return }
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
  }, [selectedRegistryAgentId, surface])

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
  }

  const visibleSessions = useMemo(
    () => filterArchitectureSessions(sessions, statusFilter, searchQuery),
    [sessions, statusFilter, searchQuery],
  )
  const groupedSessions = useMemo(() => groupArchitectureSessionsByNode(visibleSessions), [visibleSessions])

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

  const readyNodes = displayNodes.filter(node => node.online && node.protocolStatus !== 'upgrade-required').length
  const totalTokens = summary.totalCachedTokens + summary.totalInputTokens + summary.totalOutputTokens
  const selectedRegistryAgent = selectedRegistryAgentId ? agentRegistry.find(agent => agent.id === selectedRegistryAgentId) || null : null
  const orderedAgentRegistry = useMemo(() => orderArchitectureAgents(agentRegistry), [agentRegistry])

  const createAgentFromRegistry = async (agentId: string, inheritAgent?: string) => {
    if (onCreateAgent) await onCreateAgent(agentId, inheritAgent)
    else {
      const response = await fetch(`${API_BASE_PATH}/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, inheritAgent }) })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to create agent')
      if (payload.sessionId) onSelectSession(payload.sessionId)
    }
    await loadAgentRegistry(); setSelectedRegistryAgentId(agentId); await onAgentsChanged?.()
  }

  const createSessionFromRegistry = async (agentId: string, sessionId?: string) => {
    if (onCreateSession) await onCreateSession(agentId, sessionId)
    else {
      const response = await fetch(`${API_BASE_PATH}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, sessionId: sessionId || undefined }) })
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

  const saveRegistryAgent = async (agentId: string, changes: { inheritAgent: string | null; isolatedNode: string | null }) => {
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

  return (
    <div className="h-full overflow-y-auto bg-gray-100 dark:bg-gray-900">
      <div className="mx-auto max-w-[1500px] p-4 md:p-5 lg:p-6">
        <header className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                {onBack ? (
                  <button onClick={onBack} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 md:hidden">
                    <ArrowLeft className="h-4 w-4" /> Back
                  </button>
                ) : null}
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white dark:bg-white dark:text-gray-900"><Network className="h-5 w-5" /></span>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-white">System Architecture</h1>
                  <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{surface === 'topology' ? 'Operational topology, runtime placement, and session diagnostics.' : 'Agent lifecycle, inheritance, isolation, and memory workspaces.'}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-800">
                <button type="button" onClick={() => setSurface('topology')} className={`rounded-md px-2.5 py-1 text-xs font-medium ${surface === 'topology' ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>Topology</button>
                <button type="button" onClick={() => setSurface('agents')} className={`rounded-md px-2.5 py-1 text-xs font-medium ${surface === 'agents' ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>Agents</button>
              </div>
              <span>{sessions.length} loaded of {summary.sessionCount} sessions</span>
              {summary.managedCount > 0 ? renderMetaBadge(`${summary.managedCount} managed`, 'active') : null}
              {nodeTargetsError ? renderMetaBadge('node status unavailable', 'warning') : null}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <SummaryMetric label="Agents" value={agentRegistry.length || summary.agentCount} detail="persistent workspaces" icon={<Bot className="h-4 w-4" />} onClick={() => setSurface('agents')} active={surface === 'agents'} />
            <SummaryMetric label="Sessions" value={summary.sessionCount} detail={`${sessions.length} in loaded window`} icon={<Layers3 className="h-4 w-4" />} onClick={() => { setSurface('topology'); setStatusFilter('all') }} active={surface === 'topology' && statusFilter === 'all'} />
            <SummaryMetric label="Active" value={summary.activeCount} detail="model or tool work" icon={<Activity className="h-4 w-4" />} onClick={() => { setSurface('topology'); setStatusFilter('active') }} active={surface === 'topology' && statusFilter === 'active'} />
            <SummaryMetric label="Waiting" value={summary.waitingCount} detail="loaded wait conditions" icon={<Clock3 className="h-4 w-4" />} onClick={() => { setSurface('topology'); setStatusFilter('waiting') }} active={surface === 'topology' && statusFilter === 'waiting'} />
            <SummaryMetric label="Queued" value={summary.queuedSessions} detail="sessions with pending work" icon={<MessageSquare className="h-4 w-4" />} onClick={() => { setSurface('topology'); setStatusFilter('queued') }} active={surface === 'topology' && statusFilter === 'queued'} />
            <SummaryMetric label="Nodes ready" value={`${readyNodes}/${displayNodes.length}`} detail="protocol-compatible execution" icon={<Server className="h-4 w-4" />} onClick={() => setSurface('topology')} />
          </div>

        </header>

        {surface === 'topology' ? <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <label className="relative min-w-0 flex-1 sm:min-w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search sessions, models, tools…" className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-xs text-gray-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-600 dark:focus:ring-blue-900" />
              </label>
              <label className="relative sm:w-56">
                <Bot className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <select aria-label="Filter by agent" value={selectedAgent || ''} onChange={event => setSelectedAgent(event.target.value || null)} className="h-9 w-full appearance-none rounded-lg border border-gray-200 bg-gray-50 py-0 pl-9 pr-8 text-xs font-medium leading-5 text-gray-700 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                  <option value="">All agents · {summary.sessionCount}</option>
                  {agents.map(agent => <option key={agent.name} value={agent.name}>{agent.name} · {agent.sessionCount}</option>)}
                </select>
                <ChevronRight className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-gray-400" />
              </label>
              <label className="relative sm:w-44">
                <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value as ArchitectureStatusFilter)} className="h-9 w-full appearance-none rounded-lg border border-gray-200 bg-gray-50 py-0 pl-9 pr-8 text-xs font-medium leading-5 text-gray-700 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                  {statusFilters.map(filter => <option key={filter.id} value={filter.id}>{filter.label}{typeof filter.count === 'number' ? ` · ${filter.count}` : ''}</option>)}
                </select>
                <ChevronRight className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-gray-400" />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 pt-3 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400 2xl:border-l 2xl:border-t-0 2xl:pl-4 2xl:pt-0">
              <span className="font-semibold uppercase tracking-[0.12em] text-gray-400">Traffic</span>
              <span><strong className="font-semibold text-gray-800 dark:text-gray-100">{formatTokenCount(totalTokens)}</strong> total</span>
              <span><strong className="font-semibold text-gray-700 dark:text-gray-200">{formatTokenCount(summary.totalCachedTokens)}</strong> cached</span>
              <span><strong className="font-semibold text-gray-700 dark:text-gray-200">{formatTokenCount(summary.totalInputTokens)}</strong> input</span>
              <span><strong className="font-semibold text-gray-700 dark:text-gray-200">{formatTokenCount(summary.totalOutputTokens)}</strong> output</span>
            </div>
          </div>
        </div> : null}

        {surface === 'topology' ? <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <main className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-3 px-1">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Execution topology</h2>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Sessions are grouped by their effective tool-execution node, not sidebar hierarchy.</p>
              </div>
              <span className="text-xs text-gray-400">{visibleSessions.length} matching</span>
            </div>
            {displayNodes.map(node => (
              <NodeLane
                key={node.id}
                node={node}
                rows={groupedSessions.get(node.id) || []}
                selectedSessionId={inspectedSession?.id || null}
                currentSession={currentSession}
                now={now}
                onInspect={inspectSession}
                onOpen={onSelectSession}
              />
            ))}
            {rootCursor ? (
              <button type="button" onClick={() => { void replayArchitecture(rootTargetRef.current + 50, new Map(branchTargetsRef.current)) }} className="w-full rounded-xl border border-dashed border-gray-300 bg-white/60 px-3 py-2.5 text-sm font-medium text-blue-600 hover:bg-white dark:border-gray-700 dark:bg-gray-800/50 dark:text-blue-300 dark:hover:bg-gray-800">
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
          />
        </div> : (
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <main className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <div><h2 className="text-sm font-semibold text-gray-900 dark:text-white">Agent registry</h2><p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Manage persistent workspace owners and open self-owned memory in Code.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs text-gray-400">{agentRegistry.length} agents</span><AgentCreationMenu agents={agentRegistry.map(agent => ({ id: agent.id, inherit: agent.inherit || undefined }))} currentAgent={selectedRegistryAgentId || undefined} compact onCreateAgent={createAgentFromRegistry} onCreateSession={createSessionFromRegistry} /></div>
              </div>
              {agentRegistryError ? <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{agentRegistryError}</div> : null}
              <div className="grid gap-3 md:grid-cols-2">
                {orderedAgentRegistry.map(agent => <AgentRegistryCard key={agent.id} agent={agent} selected={selectedRegistryAgentId === agent.id} onSelect={() => setSelectedRegistryAgentId(agent.id)} />)}
                {agentRegistry.length === 0 && !agentRegistryError ? <div className="col-span-full rounded-xl border border-dashed border-gray-300 py-10 text-center text-sm text-gray-400 dark:border-gray-700">No agents found.</div> : null}
              </div>
            </main>
            <AgentRegistryInspector agent={selectedRegistryAgent} allAgents={agentRegistry} nodes={displayNodes} memoryFiles={agentMemoryFiles} memoryLoading={agentMemoryLoading} memoryError={agentMemoryError} onOpenMemory={openAgentMemory} onSave={saveRegistryAgent} onDelete={deleteRegistryAgent} />
          </div>
        )}
      </div>
    </div>
  )
}
