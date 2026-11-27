// System › Nodes: every Node in one table. Sessions are not listed here (the Sidebar groups them
// by Node); each row's count opens the Sessions list filtered to that Node.
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Terminal, Trash2 } from 'lucide-react'
import ContextMenu, { type ContextMenuAnchorRect, type ContextMenuEntry } from './ContextMenu'
import type { Session } from './SessionListCore'
import type { WebUiNodeTarget } from '../nodeTargets'
import { NodeStatusBadge, StatusBadge } from './StatusBadge'
import NodeOnboardingModal, { useNodePendingApprovals } from './NodeOnboardingModal'
import NodeActionsModal from './NodeActionsModal'
import { getArchitectureSessionNodeId } from '../architectureOperations'
import { isSessionRuntimeActive } from '../sessionRuntimeState'
import { formatActivityTime } from '../activityTime'

/** Pane width below which the table becomes a two-line list. */
const NODE_TABLE_MIN_WIDTH = 640

export default function SystemNodes({ nodes, error, sessions, sessionCounts, phone, onNodesChanged, onShowSessions }: {
  nodes: WebUiNodeTarget[]
  error?: string | null
  /** Loaded Sessions, for the active count. */
  sessions: Session[]
  /** Sessions per Node across the installation. */
  sessionCounts: Map<string, number>
  phone: boolean
  onNodesChanged: () => Promise<void>
  onShowSessions: (nodeId: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const narrow = phone || (width > 0 && width < NODE_TABLE_MIN_WIDTH)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [nodeAction, setNodeAction] = useState<{ node: WebUiNodeTarget; action: 'command' | 'delete' } | null>(null)
  const [menu, setMenu] = useState<{ node: WebUiNodeTarget; anchor: ContextMenuAnchorRect; trigger: HTMLButtonElement } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const pending = useNodePendingApprovals(true)
  const active = useMemo(() => {
    const result = new Map<string, number>()
    for (const session of sessions) if (isSessionRuntimeActive(session)) { const id = getArchitectureSessionNodeId(session); result.set(id, (result.get(id) || 0) + 1) }
    return result
  }, [sessions])
  // Sessions can name a Node the directory no longer lists.
  const rows = useMemo(() => {
    const known = new Set(nodes.map(node => node.id))
    const unknown = [...sessionCounts.keys()].filter(id => !known.has(id)).sort()
      .map(id => ({ id, type: 'unavailable', displayName: id, online: false, services: {}, unavailable: true }) as WebUiNodeTarget)
    return [...nodes, ...unknown]
  }, [nodes, sessionCounts])
  const online = nodes.filter(node => node.online).length
  // Connectivity is always shown; a Provider's unavailability and a required upgrade are separate
  // warnings beside it.
  const status = (node: WebUiNodeTarget) => node.unavailable ? <StatusBadge tone="warning" title="Not in the node directory.">Unavailable</StatusBadge> : (
    <span className="inline-flex flex-wrap items-center gap-1">
      <NodeStatusBadge online={node.online} />
      {node.availability === 'error' || node.availability === 'unavailable' ? <StatusBadge tone="warning">Unavailable</StatusBadge> : null}
      {node.protocolStatus === 'upgrade-required' ? <StatusBadge tone="warning">Upgrade required</StatusBadge> : null}
    </span>
  )
  // A protocol explanation stays visible on the row, not only in its details.
  const protocolNote = (node: WebUiNodeTarget) => node.protocolMessage && node.protocolMessage !== 'upgrade required' ? <div className="mt-0.5 text-xs text-fw-warning" data-node-protocol-message>{node.protocolMessage}</div> : null
  // A Node is named once: its ID only when it differs from the display name, its type only when it
  // differs from both.
  const nodeId = (node: WebUiNodeTarget) => node.id !== node.displayName ? node.id : ''
  const nodeType = (node: WebUiNodeTarget) => node.type !== node.id && node.type !== node.displayName ? node.type : ''
  const lastSeen = (node: WebUiNodeTarget) => node.id === 'master' ? 'This server' : node.online ? 'Connected' : node.lastSeenAt ? formatActivityTime(node.lastSeenAt) : '—'
  const sessionsCell = (node: WebUiNodeTarget) => {
    const total = sessionCounts.get(node.id) || 0
    if (!total) return <span className="text-fw-text-muted">—</span>
    const running = active.get(node.id) || 0
    return <button type="button" data-node-sessions-link={node.id} onClick={() => onShowSessions(node.id)} className="whitespace-nowrap text-fw-accent hover:underline">{total}{running ? <span className="ml-1 text-fw-text-muted">({running} active)</span> : null}</button>
  }
  const actions = (node: WebUiNodeTarget) => node.credentialManaged ? (
    <button type="button" aria-label={`More actions for ${node.displayName}`} aria-haspopup="menu" aria-expanded={menu?.node.id === node.id} data-node-menu={node.id}
      onClick={event => setMenu({ node, anchor: event.currentTarget.getBoundingClientRect(), trigger: event.currentTarget })}
      className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text"><MoreHorizontal className="h-4 w-4" /></button>
  ) : null
  const menuEntries: ContextMenuEntry[] = menu ? [
    ...(menu.node.type === 'cli-node' || menu.node.type === 'shell-node' ? [{ key: 'command', label: 'Start command', icon: <Terminal size={16} />, onSelect: () => setNodeAction({ node: menu.node, action: 'command' }) }] : []),
    { key: 'delete', label: 'Delete', icon: <Trash2 size={16} />, danger: true, onSelect: () => setNodeAction({ node: menu.node, action: 'delete' }) },
  ] : []
  const toggle = (node: WebUiNodeTarget) => <button type="button" aria-expanded={expanded === node.id} aria-label={`Details of ${node.displayName}`} onClick={() => setExpanded(expanded === node.id ? null : node.id)} className="rounded p-0.5 text-fw-text-muted hover:bg-fw-hover">{expanded === node.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
  const details = (node: WebUiNodeTarget) => expanded === node.id ? (
    <div className="flex flex-wrap items-center gap-1.5 py-1" data-node-details={node.id}>
      {node.id !== node.displayName ? <span className="font-mono text-[11px] text-fw-text-muted">{node.id}</span> : null}
      {Object.entries(node.services || {}).map(([name, version]) => <span key={name} className="rounded bg-fw-surface-sunken px-2 py-0.5 font-mono text-[11px] text-fw-text-muted">{name} v{version}</span>)}
      {node.lastSeenAt ? <span className="text-xs text-fw-text-muted">Last seen {new Date(node.lastSeenAt).toLocaleString()}</span> : null}
      {node.unavailable ? <span className="text-xs text-fw-text-muted">Not in the node directory.</span> : null}
    </div>
  ) : null
  return (
    <div ref={ref} className="pb-4" data-node-surface>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-xs text-fw-text-muted" data-system-summary="nodes">Online {online} · Total {nodes.length}</p>
        <div className="flex items-center gap-2">
          {pending.total > 0 && !pending.error ? <button type="button" onClick={() => setOnboardingOpen(true)} className="text-xs font-medium text-fw-accent hover:underline" data-node-pending-count>{pending.total} pending approval{pending.total === 1 ? '' : 's'}</button> : null}
          <button type="button" data-node-onboarding-open onClick={() => setOnboardingOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-fw-accent px-3 py-1.5 text-xs font-medium text-fw-accent-text"><Plus className="h-3.5 w-3.5" />New nodes</button>
        </div>
      </div>
      {error || pending.error ? <p role="alert" className="mb-2 text-sm text-fw-danger">{error || pending.error}</p> : null}
      <div className="rounded-xl border border-fw-border bg-fw-surface">
        {narrow ? (
          <ul className="divide-y divide-fw-border-muted" data-system-node-table="list">
            {rows.map(node => (
              <li key={node.id} className="px-3 py-2.5" data-system-node-id={node.id}>
                <div className="flex items-center gap-2">
                  {toggle(node)}
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-fw-text-strong">{node.displayName}</div><div className="mt-0.5 truncate text-xs text-fw-text-muted">{[nodeId(node), nodeType(node), lastSeen(node)].filter(Boolean).join(' · ')}</div>{protocolNote(node)}</div>
                  {status(node)}{actions(node)}
                </div>
                <div className="mt-1 pl-6 text-xs text-fw-text-muted">Sessions {sessionsCell(node)}</div>
                <div className="pl-6">{details(node)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full text-left text-xs" data-system-node-table="table">
            <thead className="text-[11px] text-fw-text-muted">
              <tr className="border-b border-fw-border-muted"><th className="px-4 py-2 font-medium">Node</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Last seen</th><th className="px-3 py-2 font-medium">Sessions</th><th className="w-10 px-2 py-2"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-fw-border-muted">
              {rows.map(node => (
                <Fragment key={node.id}>
                  <tr className="align-middle hover:bg-fw-hover/50" data-system-node-id={node.id}>
                    <td className="px-4 py-2"><div className="flex items-center gap-1.5">{toggle(node)}<span className="text-sm font-medium text-fw-text-strong">{node.displayName}</span>{nodeId(node) ? <span className="font-mono text-[11px] text-fw-text-muted">{node.id}</span> : null}</div>{protocolNote(node) ? <div className="pl-6">{protocolNote(node)}</div> : null}</td>
                    <td className="px-3 py-2">{status(node)}</td>
                    <td className="px-3 py-2 text-fw-text-muted">{nodeType(node)}</td>
                    <td className="px-3 py-2 text-fw-text-muted">{lastSeen(node)}</td>
                    <td className="px-3 py-2">{sessionsCell(node)}</td>
                    <td className="px-2 py-2">{actions(node)}</td>
                  </tr>
                  {expanded === node.id ? <tr className="!border-t-0"><td colSpan={6} className="px-4 pb-2 pl-10">{details(node)}</td></tr> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ContextMenu open={!!menu} entries={menuEntries} anchorRect={menu?.anchor} preferredPlacement="bottom-end"
        onClose={() => { const trigger = menu?.trigger; setMenu(null); if (trigger?.isConnected) trigger.focus() }} />
      {nodeAction ? <NodeActionsModal key={`${nodeAction.node.id}:${nodeAction.action}`} {...nodeAction} onClose={() => setNodeAction(null)} onNodesChanged={onNodesChanged} /> : null}
      {onboardingOpen ? <NodeOnboardingModal pending={pending} onClose={() => setOnboardingOpen(false)} onNodesChanged={onNodesChanged} /> : null}
    </div>
  )
}
