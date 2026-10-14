import { useCallback, useState } from 'react'
import { ArrowLeft, Server } from 'lucide-react'
import type { WebUiNodeTarget } from '../nodeTargets'
import { useNodeDirectory } from '../useNodeDirectory'
import NodeOnboardingModal, { useNodePendingApprovals } from './NodeOnboardingModal'
import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'

function NodeOverviewCard({ node }: { node: WebUiNodeTarget }) {
  const incompatible = node.protocolStatus === 'upgrade-required'
  return <article className="rounded-xl border border-fw-border bg-fw-surface p-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="truncate font-semibold text-fw-text-strong">{node.displayName}</h3>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${incompatible ? 'bg-fw-warning-surface text-fw-warning' : node.online ? 'bg-fw-accent-surface text-fw-accent' : 'bg-fw-surface-sunken text-fw-text-muted'}`}>{incompatible ? 'Upgrade required' : node.online ? 'Ready' : 'Offline'}</span>
    </div>
    <p className="mt-1 break-all font-mono text-xs text-fw-text-muted">{node.id}</p>
    <p className="mt-2 text-xs text-fw-text-muted">{node.type}{node.lastSeenAt ? ` · Last seen ${new Date(node.lastSeenAt).toLocaleString()}` : ''}</p>
    {node.protocolMessage ? <p className="mt-2 text-xs text-fw-warning">{node.protocolMessage}</p> : null}
    <div className="mt-3 flex flex-wrap gap-1.5">
      {Object.entries(node.services).map(([name, version]) => <span key={name} className="rounded bg-fw-canvas px-2 py-1 text-xs text-fw-text-muted">{name} v{version}</span>)}
    </div>
  </article>
}

export default function NodesView({ onBack }: { onBack?: () => void }) {
  const tabHeader = useWorkbenchTabHeader()
  const { nodes, error, reload } = useNodeDirectory()
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const closeOnboarding = useCallback(() => setOnboardingOpen(false), [])
  const pendingApprovals = useNodePendingApprovals(true)

  return <div className="h-full overflow-y-auto bg-fw-canvas">
    <div className="mx-auto max-w-[1500px] p-4 md:p-5 lg:p-6">
      <header className="mb-5">
        <WorkbenchHeaderDragArea className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {tabHeader ? <WorkbenchTabClose className="inline-flex items-center justify-center rounded-lg p-2 text-fw-text hover:bg-fw-hover" /> : onBack ? <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-lg border border-fw-border bg-fw-surface px-3 py-1.5 text-sm text-fw-text hover:bg-fw-hover md:hidden"><ArrowLeft className="h-4 w-4" /> Back</button> : null}
            <WorkbenchTabIcon className="flex h-10 w-10 items-center justify-center rounded-xl bg-fw-text-strong text-fw-surface"><Server className="h-5 w-5" /></WorkbenchTabIcon>
            <div>
              <h1 className="text-2xl font-bold text-fw-text-strong">Nodes</h1>
              <p className="mt-0.5 text-sm text-fw-text-muted">Connected Nodes and new Node setup.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pendingApprovals.total > 0 && !pendingApprovals.error ? <span className="text-xs text-fw-accent">{pendingApprovals.total} pending approvals</span> : null}
            <button type="button" onClick={() => setOnboardingOpen(true)} className="rounded-lg bg-fw-accent px-3 py-2 text-sm font-medium text-white">New nodes</button>
            <WorkbenchPaneControls />
          </div>
        </WorkbenchHeaderDragArea>
      </header>
      <main data-node-surface className="space-y-4">
        <p className="text-xs text-fw-text-muted">{nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}</p>
        {error || pendingApprovals.error ? <p role="alert" className="text-sm text-fw-danger">{error || pendingApprovals.error}</p> : null}
        <div className="grid gap-3 md:grid-cols-2">{nodes.map(node => <NodeOverviewCard key={node.id} node={node} />)}</div>
      </main>
      {onboardingOpen ? <NodeOnboardingModal pending={pendingApprovals} onClose={closeOnboarding} onNodesChanged={reload} /> : null}
    </div>
  </div>
}
