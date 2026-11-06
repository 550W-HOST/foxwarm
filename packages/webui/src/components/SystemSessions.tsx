import type { ReactNode } from 'react'
import { Bot, ChevronRight, CircleDot, ExternalLink, GitFork, ListFilter, Search, Server, Sparkles } from 'lucide-react'
import type { Session } from './SessionListCore'
import { formatUsdCost } from '../usageCost'
import type { TokenUsage } from './TokenUsageDetails'
import type { WebUiNodeTarget } from '../nodeTargets'
import { getRuntimeStateSummary, getSessionRuntimeStateName, isRuntimeStateInactiveName } from '../sessionRuntimeState'
import { getArchitectureSessionModel, getArchitectureSessionNodeId, type ArchitectureStatusFilter } from '../architectureOperations'
import { UsagePie, formatBusyDuration, formatRelativeTime, formatTokenCount, getStatusTone, renderMetaBadge } from './SystemShared'

export function SessionOperationRow({ session, selected, current, now, nodeLabel, onInspect, onOpen }: {
  session: Session
  nodeLabel?: string
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
  const model = getArchitectureSessionModel(session)
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
        ? 'border-fw-accent-border bg-fw-accent-surface/80 ring-1 ring-fw-focus-ring dark:border-fw-accent-border dark:bg-fw-accent-surface-strong/30 dark:ring-fw-focus-ring'
        : 'border-fw-border bg-fw-surface-sunken/70 hover:border-fw-border-strong hover:bg-fw-surface dark:border-fw-border dark:bg-fw-canvas/40 dark:hover:border-fw-border-strong dark:hover:bg-fw-hover'} focus-visible:ring-2 focus-visible:ring-fw-focus-ring`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${getStatusTone(session)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-fw-text-strong" title={name}>{name}</span>
            {current ? renderMetaBadge('current', 'active') : null}
            {session.isolated ? renderMetaBadge('isolated', 'warning') : null}
            {session.archived ? renderMetaBadge('archived', 'muted') : null}
          </div>
          {session.displayName ? <div className="mt-0.5 truncate font-mono text-[10px] text-fw-text-muted">{session.id}</div> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fw-text-muted">
            <span className="font-medium text-fw-text-strong">{runtimeSummary}</span>
            {!isRuntimeStateInactiveName(runtimeState) ? <span>{formatBusyDuration(activeSince, now)}</span> : null}
            <span>agent {session.agent || 'main'}</span>
            <span>node {nodeLabel || getArchitectureSessionNodeId(session)}</span>
            {queueLength > 0 ? <span className="text-fw-warning dark:text-fw-warning">queued {queueLength}</span> : null}
            {model ? <span className="max-w-[180px] truncate" title={model}>model {model}</span> : null}
          </div>

        </div>
        <UsagePie usage={session.tokenUsage} />
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onOpen() }}
          title="Open session"
          className="rounded-md p-1.5 text-fw-text-muted opacity-70 transition hover:bg-fw-hover hover:text-fw-text group-hover:opacity-100 dark:hover:bg-fw-hover dark:hover:text-fw-text-strong"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
const InspectorField = ({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 py-1.5 text-xs">
    <dt className="text-fw-text-muted">{label}</dt>
    <dd className={`min-w-0 break-words text-fw-text-strong ${mono ? 'font-mono text-[11px]' : ''}`}>{value || '—'}</dd>
  </div>
)

export function SessionInspector({ session, parent, children, childTotal, hasMoreChildren, now, current, node, onInspect, onOpen, onLoadMoreChildren, extra }: {
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
  /** Further sections for the inspected Session, shown after its relationships. */
  extra?: ReactNode
}) {
  if (!session) {
    return (
      <aside className="rounded-xl border border-dashed border-fw-border-strong bg-fw-surface/60 p-6 text-center dark:border-fw-border dark:bg-fw-surface/50">
        <CircleDot className="mx-auto h-6 w-6 text-fw-text" />
        <h3 className="mt-3 text-sm font-semibold text-fw-text-strong">Select a session</h3>
        <p className="mt-1 text-xs leading-5 text-fw-text-muted">Inspect runtime, placement, queue, tokens, and lineage without navigating away.</p>
      </aside>
    )
  }

  const state = getSessionRuntimeStateName(session)
  const runtime = session.runtimeState
  const queueLength = runtime?.queueLength ?? session.queueLength ?? 0
  const tokenUsage = session.tokenUsage || { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const totalTokens = tokenUsage.cachedTokens + tokenUsage.inputTokens + tokenUsage.outputTokens
  const model = getArchitectureSessionModel(session)
  const waiting = runtime?.waiting
  const tool = runtime?.tool

  return (
    <aside data-architecture-inspector-session-id={session.id} className="overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-sm dark:border-fw-border dark:bg-fw-surface xl:sticky xl:top-4">
      <div className="border-b border-fw-border-muted p-4 dark:border-fw-border">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-fw-text-strong">{session.displayName || session.id}</h2>
              {current ? renderMetaBadge('current', 'active') : null}
            </div>
            {session.displayName ? <div className="mt-1 break-all font-mono text-[10px] text-fw-text-muted">{session.id}</div> : null}
          </div>
          <button type="button" onClick={() => onOpen(session.id)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-fw-text-strong px-2.5 py-1.5 text-xs font-medium text-fw-surface hover:bg-fw-text">
            <ExternalLink className="h-3.5 w-3.5" /> Open
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`h-2 w-2 rounded-full ${getStatusTone(session)}`} />
          <span className="font-medium text-fw-text-strong">{getRuntimeStateSummary(runtime, !!session.busy)}</span>
          {!isRuntimeStateInactiveName(state) ? <span className="text-fw-text-muted">for {formatBusyDuration(runtime?.since || session.busyStartedAt, now)}</span> : null}
        </div>
      </div>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-4">
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted">Runtime</h3>
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
          <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-warning">Wait condition</h3>
            <dl className="mt-1">
              <InspectorField label="Waiting for" value={waiting.waitingFor} />
              <InspectorField label="Reason" value={waiting.reason || '—'} />
              {waiting.waitAllSessions ? <InspectorField label="Sessions" value={`${waiting.satisfiedSessions?.length || 0}/${waiting.waitAllSessions.length} satisfied`} /> : null}
              {waiting.pendingSessions?.length ? <InspectorField label="Pending" value={waiting.pendingSessions.join(', ')} mono /> : null}
              {waiting.waitExecIds?.length ? <InspectorField label="Exec IDs" value={waiting.waitExecIds.join(', ')} mono /> : null}
            </dl>
          </section>
        ) : null}

        <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted">Placement</h3>
          <dl className="mt-1">
            <InspectorField label="Agent" value={session.agent || 'main'} />
            <InspectorField label="Node" value={<span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${node?.online ? 'bg-fw-success' : 'bg-fw-text-subtle'}`} />{node?.displayName || getArchitectureSessionNodeId(session)}</span>} />
            <InspectorField label="Node ID" value={getArchitectureSessionNodeId(session)} mono />
            <InspectorField label="CWD" value={session.cwd || '—'} mono />
            <InspectorField label="Isolation" value={session.isolated ? 'isolated agent' : 'shared runtime'} />
          </dl>
        </section>

        <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted">Activity</h3>
          <dl className="mt-1">
            <InspectorField label="Messages" value={String(session.messageCount || 0)} />
            <InspectorField label="Updated" value={formatRelativeTime(session.lastMessageTime)} />
            <InspectorField label="Tokens" value={formatTokenCount(totalTokens)} />
            {tokenUsage.cost !== undefined ? <InspectorField label="Estimated cost" value={formatUsdCost(tokenUsage.cost)} /> : null}
            <InspectorField label="Cached" value={formatTokenCount(tokenUsage.cachedTokens)} />
            <InspectorField label="Input / output" value={`${formatTokenCount(tokenUsage.inputTokens)} / ${formatTokenCount(tokenUsage.outputTokens)}`} />
          </dl>
        </section>

        <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted">Relationships</h3>
          <div className="mt-2 space-y-1.5">
            {parent ? (
              <button type="button" onClick={() => onInspect(parent.id)} className="flex w-full items-center gap-2 rounded-lg border border-fw-border px-2.5 py-2 text-left text-xs hover:bg-fw-hover dark:border-fw-border dark:hover:bg-fw-hover">
                <GitFork className="h-3.5 w-3.5 rotate-180 text-fw-text-muted" />
                <span className="min-w-0 flex-1 truncate"><span className="text-fw-text-muted">parent</span> {parent.displayName || parent.id}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fw-text" />
              </button>
            ) : <div className="text-xs text-fw-text-muted">Root session</div>}
            {children.map(child => (
              <button key={child.id} type="button" onClick={() => onInspect(child.id)} className="flex w-full items-center gap-2 rounded-lg border border-fw-border px-2.5 py-2 text-left text-xs hover:bg-fw-hover dark:border-fw-border dark:hover:bg-fw-hover">
                <GitFork className="h-3.5 w-3.5 text-fw-text-muted" />
                <span className="min-w-0 flex-1 truncate"><span className="text-fw-text-muted">child</span> {child.displayName || child.id}</span>
                <ChevronRight className="h-3.5 w-3.5 text-fw-text" />
              </button>
            ))}
            {children.length === 0 && childTotal === 0 ? <div className="text-xs text-fw-text-muted">No child sessions</div> : null}
            {hasMoreChildren ? <button type="button" onClick={() => onLoadMoreChildren(session.id)} className="w-full rounded-lg px-2.5 py-1.5 text-xs font-medium text-fw-accent hover:bg-fw-accent-surface dark:text-fw-accent dark:hover:bg-fw-accent-surface-strong/30">Load more relationships…</button> : null}
          </div>
        </section>
        {extra}
      </div>
    </aside>
  )
}

function FilterSelect({ label, icon, value, onChange, options }: {
  label: string
  icon: ReactNode
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="relative min-w-0 flex-1 sm:w-44 sm:flex-none">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fw-text-muted">{icon}</span>
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="h-9 w-full appearance-none truncate rounded-lg border border-transparent bg-transparent py-0 pl-9 pr-8 text-xs font-medium leading-5 text-fw-text outline-none hover:bg-fw-hover focus:border-fw-accent-border dark:text-fw-text-strong">
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronRight className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-fw-text-muted" />
    </label>
  )
}

export interface SystemSessionFilterState {
  query: string
  status: ArchitectureStatusFilter
  agent: string | null
  nodeId: string | null
  model: string | null
}

export function SessionFilterBar({ filters, onChange, statusOptions, agents, totalSessions, nodes, models, usage }: {
  filters: SystemSessionFilterState
  onChange: (patch: Partial<SystemSessionFilterState>) => void
  statusOptions: Array<{ id: ArchitectureStatusFilter; label: string; count?: number }>
  agents: Array<{ name: string; sessionCount: number }>
  totalSessions: number
  nodes: Array<{ id: string; label: string; count: number }>
  models: Array<{ id: string; count: number }>
  usage: TokenUsage
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-64 sm:shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fw-text-muted" />
          <input value={filters.query} onChange={event => onChange({ query: event.target.value })} aria-label="Search sessions, models, tools" placeholder="Search sessions…" className="h-9 w-full rounded-lg border border-fw-border bg-fw-surface py-0 pl-9 pr-3 text-xs text-fw-text-strong outline-none hover:bg-fw-hover focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring" />
        </label>
        <FilterSelect label="Filter by status" icon={<ListFilter className="h-3.5 w-3.5" />} value={filters.status} onChange={value => onChange({ status: value as ArchitectureStatusFilter })}
          options={statusOptions.map(option => ({ value: option.id, label: `${option.label}${typeof option.count === 'number' ? ` · ${option.count}` : ''}` }))} />
        <FilterSelect label="Filter by agent" icon={<Bot className="h-3.5 w-3.5" />} value={filters.agent || ''} onChange={value => onChange({ agent: value || null })}
          options={[{ value: '', label: `All agents · ${totalSessions}` }, ...agents.map(agent => ({ value: agent.name, label: `${agent.name} · ${agent.sessionCount}` }))]} />
        <FilterSelect label="Filter by node" icon={<Server className="h-3.5 w-3.5" />} value={filters.nodeId || ''} onChange={value => onChange({ nodeId: value || null })}
          options={[{ value: '', label: 'All nodes' }, ...nodes.map(node => ({ value: node.id, label: `${node.label} · ${node.count}` }))]} />
        <FilterSelect label="Filter by model" icon={<Sparkles className="h-3.5 w-3.5" />} value={filters.model || ''} onChange={value => onChange({ model: value || null })}
          options={[{ value: '', label: 'All models' }, ...models.map(model => ({ value: model.id, label: `${model.id} · ${model.count}` }))]} />
      </div>
      <div className="ml-auto flex shrink-0 items-center">
        <UsagePie global usage={usage} />
      </div>
    </div>
  )
}
