import { useCallback, useMemo, useState } from 'react'
import type { Session } from './SessionListCore'
import type { WebUiNodeTarget } from '../nodeTargets'
import { NodeStatusBadge, StatusBadge } from './StatusBadge'
import NodeOnboardingModal, { useNodePendingApprovals } from './NodeOnboardingModal'
import { getArchitectureNodePreview, groupArchitectureSessionsByNode } from '../architectureOperations'
import { getRuntimeStateSummary, isSessionRuntimeActive } from '../sessionRuntimeState'
import { getStatusTone } from './SystemShared'

function NodeSessionRow({ session, onSelect }: { session: Session; onSelect: () => void }) {
  const tool = session.runtimeState?.state === 'running-tool' ? session.runtimeState.tool?.name : undefined
  return (
    <button type="button" onClick={onSelect} data-system-node-session={session.id}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-fw-hover">
      <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusTone(session)}`} />
      <span className="min-w-0 flex-1 truncate font-medium text-fw-text-strong" title={session.id}>{session.displayName || session.id}</span>
      <span className="shrink-0 truncate text-[11px] text-fw-text-muted">{tool ? `running ${tool}` : getRuntimeStateSummary(session.runtimeState, !!session.busy)}</span>
    </button>
  )
}

function NodeOverviewCard({ node, sessions, onSelectSession }: { node: WebUiNodeTarget; sessions: Session[]; onSelectSession: (sessionId: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const incompatible = node.protocolStatus === 'upgrade-required'
  const shown = expanded ? sessions : getArchitectureNodePreview(sessions, new Set())
  const active = sessions.filter(isSessionRuntimeActive).length
  return <article data-system-node-id={node.id} className="flex flex-col rounded-xl border border-fw-border bg-fw-surface p-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="truncate font-semibold text-fw-text-strong">{node.displayName}</h3>
      {node.unavailable ? <StatusBadge tone="warning">Unavailable</StatusBadge> : <NodeStatusBadge online={node.online} />}
    </div>
    <p className="mt-1 break-all font-mono text-xs text-fw-text-muted">{node.id}</p>
    {node.unavailable ? <p className="mt-2 text-xs text-fw-text-muted">Not in the node directory.</p> : <p className="mt-2 text-xs text-fw-text-muted">{node.type}{node.lastSeenAt ? ` · Last seen ${new Date(node.lastSeenAt).toLocaleString()}` : ''}</p>}
    {!node.unavailable && (node.availability === 'error' || node.availability === 'unavailable') ? <div className="mt-2"><StatusBadge tone="warning">Unavailable</StatusBadge></div> : null}
    {incompatible ? <div className="mt-2"><StatusBadge tone="warning">Upgrade required</StatusBadge></div> : null}
    {node.protocolMessage && node.protocolMessage !== 'upgrade required' ? <p className="mt-2 text-xs text-fw-warning">{node.protocolMessage}</p> : null}
    {Object.keys(node.services).length ? <div className="mt-3 flex flex-wrap gap-1.5">
      {Object.entries(node.services).map(([name, version]) => <span key={name} className="rounded bg-fw-canvas px-2 py-1 text-xs text-fw-text-muted">{name} v{version}</span>)}
    </div> : null}
    <section className="mt-3 border-t border-fw-border-muted pt-2" data-system-node-sessions>
      <div className="flex items-center justify-between px-2 text-[11px] text-fw-text-muted">
        <span>{sessions.length ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} here` : 'No sessions here'}</span>
        {active ? <span className="text-fw-accent">{active} active</span> : null}
      </div>
      {sessions.length ? <div className="mt-1 max-h-[240px] overflow-y-auto">
        {shown.map(session => <NodeSessionRow key={session.id} session={session} onSelect={() => onSelectSession(session.id)} />)}
      </div> : null}
      {sessions.length > shown.length || expanded && sessions.length > 6 ? (
        <button type="button" onClick={() => setExpanded(value => !value)} className="mt-1 w-full rounded-lg px-2 py-1 text-left text-xs font-medium text-fw-accent hover:bg-fw-accent-surface">
          {expanded ? 'Show fewer' : `Show all ${sessions.length}`}
        </button>
      ) : null}
    </section>
  </article>
}

/**
 * Node directory with the Sessions placed on each Node. Placement is the active tool's
 * execution Node, otherwise the Session's current Node, otherwise master.
 */
export default function SystemNodes({ nodes, error, sessions, onNodesChanged, onSelectSession }: {
  nodes: WebUiNodeTarget[]
  error?: string | null
  sessions: Session[]
  onNodesChanged: () => Promise<void>
  onSelectSession: (sessionId: string) => void
}) {
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const closeOnboarding = useCallback(() => setOnboardingOpen(false), [])
  const pendingApprovals = useNodePendingApprovals(true)
  const placed = useMemo(() => groupArchitectureSessionsByNode(sessions), [sessions])
  const cards = useMemo(() => {
    const known = new Set(nodes.map(node => node.id))
    const unknown: WebUiNodeTarget[] = [...placed.keys()].filter(id => !known.has(id)).sort()
      .map(id => ({ id, type: 'unavailable', displayName: id, online: false, services: {}, unavailable: true }))
    return [...nodes, ...unknown]
  }, [nodes, placed])
  const online = nodes.filter(node => node.online === true).length

  return <div data-node-surface className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <p className="text-xs text-fw-text-muted" data-system-summary="nodes">Online {online} · Total {nodes.length}</p>
      <div className="flex flex-wrap items-center gap-2">
        {pendingApprovals.total > 0 && !pendingApprovals.error ? <span className="text-xs text-fw-accent">{pendingApprovals.total} pending approvals</span> : null}
        <button type="button" onClick={() => setOnboardingOpen(true)} className="rounded-lg bg-fw-accent px-3 py-2 text-sm font-medium text-fw-accent-text">New nodes</button>
      </div>
    </div>
    {error || pendingApprovals.error ? <p role="alert" className="text-sm text-fw-danger">{error || pendingApprovals.error}</p> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{cards.map(node => <NodeOverviewCard key={node.id} node={node} sessions={placed.get(node.id) || []} onSelectSession={onSelectSession} />)}</div>
    {onboardingOpen ? <NodeOnboardingModal pending={pendingApprovals} onClose={closeOnboarding} onNodesChanged={onNodesChanged} /> : null}
  </div>
}
