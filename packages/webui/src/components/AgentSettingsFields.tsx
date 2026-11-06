import type { ReactNode } from 'react'
import { ChevronRight, FolderOpen, MemoryStick, Shield } from 'lucide-react'
import type { WebUiNodeTarget } from '../nodeTargets'
import type { AgentSettingsChanges, AgentSummary } from '../agentCreation'

/** Mutable Agent settings shared by the New agent dialog and the Agents inspector. */
export type AgentSettingsDraft = {
  inheritAgent: string
  defaultNode: string
  defaultCwd: string
  isolatedNode: string
}

export const EMPTY_AGENT_SETTINGS: AgentSettingsDraft = { inheritAgent: '', defaultNode: '', defaultCwd: '', isolatedNode: '' }

export function agentSettingsDraft(agent: AgentSummary): AgentSettingsDraft {
  return {
    inheritAgent: agent.inherit || '',
    defaultNode: agent.defaultNode || '',
    defaultCwd: agent.defaultCwd || '',
    isolatedNode: agent.isolatedNode || '',
  }
}

/** An isolated Agent always runs on its isolation Node, so that Node is also its default. */
export function agentSettingsChanges(draft: AgentSettingsDraft): AgentSettingsChanges {
  const defaultNode = draft.isolatedNode || draft.defaultNode
  return {
    inheritAgent: draft.inheritAgent || null,
    defaultNode: defaultNode || null,
    defaultCwd: draft.defaultCwd.trim() || null,
    isolatedNode: draft.isolatedNode || null,
  }
}

export function agentSettingsDirty(draft: AgentSettingsDraft, agent: AgentSummary): boolean {
  const next = agentSettingsChanges(draft)
  // An unchanged isolation already decides the Node, whatever default was saved before.
  const nodeUnchanged = next.defaultNode === (agent.defaultNode || null)
    || (!!draft.isolatedNode && draft.isolatedNode === (agent.isolatedNode || ''))
  return next.inheritAgent !== (agent.inherit || null)
    || !nodeUnchanged
    || next.defaultCwd !== (agent.defaultCwd || null)
    || next.isolatedNode !== (agent.isolatedNode || null)
}

export function nodeDisplayName(nodes: readonly WebUiNodeTarget[], nodeId: string): string {
  return nodes.find(node => node.id === nodeId)?.displayName || nodeId
}

const sectionTitle = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted'
const labelClass = 'mt-2 block text-xs font-medium text-fw-text-muted'
const controlClass = 'mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface-sunken px-2.5 py-2 text-sm font-normal text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 disabled:cursor-not-allowed disabled:opacity-70 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong'
const hintClass = 'mt-1 block text-[11px] font-normal text-fw-text-muted'

export default function AgentSettingsFields({ value, onChange, agentId, agents, nodes, installDefaultNode = null, inheritanceChain, isolationCollapsed = false, disabled = false }: {
  value: AgentSettingsDraft
  onChange: (next: AgentSettingsDraft) => void
  /** The edited Agent; empty while creating one. */
  agentId: string
  agents: readonly AgentSummary[]
  nodes: readonly WebUiNodeTarget[]
  /** Installation `agentDefaultNode`, used when the Agent sets no default Node. */
  installDefaultNode?: string | null
  inheritanceChain?: ReactNode
  /** Collapse Isolation until opened (New agent). */
  isolationCollapsed?: boolean
  disabled?: boolean
}) {
  const set = (patch: Partial<AgentSettingsDraft>) => onChange({ ...value, ...patch })
  const known = (id: string) => !id || nodes.some(node => node.id === id)
  const withSaved = (ids: string[]) => {
    const extra = ids.filter(id => !known(id)).map(id => ({ id, type: 'unknown', displayName: id, online: false, services: {} }) as WebUiNodeTarget)
    return [...nodes, ...extra]
  }
  const startNode = value.isolatedNode || value.defaultNode
  // With an installation default, unset and an explicit master choose different Nodes.
  const installDefault = installDefaultNode && installDefaultNode !== 'master' ? installDefaultNode : null
  const nodeOptions = withSaved([value.defaultNode, value.isolatedNode, installDefault || ''])
  const isolationOptions = withSaved([value.isolatedNode]).filter(node => node.id !== 'master')
  const inheritOptions = agents.filter(agent => agent.id !== agentId.trim() && !agent.isolated)

  const isolation = (
    <label className={labelClass}>
      Isolation node
      <select data-agent-settings-isolation value={value.isolatedNode} disabled={disabled} onChange={event => set({ isolatedNode: event.target.value })} className={controlClass}>
        <option value="">Not isolated</option>
        {isolationOptions.map(node => (
          <option key={node.id} value={node.id} disabled={node.protocolStatus === 'upgrade-required'}>
            {node.displayName} · {node.protocolStatus === 'upgrade-required' ? 'upgrade required' : node.online ? 'ready' : 'offline'}
          </option>
        ))}
      </select>
      <span className={hintClass}>An isolated agent always runs on this node.</span>
    </label>
  )

  return (
    <div data-agent-settings className="space-y-4">
      <section>
        <h3 className={sectionTitle}><MemoryStick className="h-3.5 w-3.5" /> Memory inheritance</h3>
        {inheritanceChain}
        <label className={labelClass}>
          Inherit agent
          <select data-agent-settings-inherit value={value.inheritAgent} disabled={disabled} onChange={event => set({ inheritAgent: event.target.value })} className={controlClass}>
            <option value="">None</option>
            {inheritOptions.map(agent => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
          </select>
        </label>
      </section>

      <section className="border-t border-fw-border-muted pt-4 dark:border-fw-border">
        <h3 className={sectionTitle}><FolderOpen className="h-3.5 w-3.5" /> Session defaults</h3>
        <label className={labelClass}>
          Node
          <select data-agent-default-node value={startNode === 'master' && !installDefault ? '' : startNode} disabled={disabled || !!value.isolatedNode} onChange={event => set({ defaultNode: event.target.value })} className={controlClass}>
            <option value="">{installDefault ? `Installation default (${nodeDisplayName(nodeOptions, installDefault)})` : `${nodeDisplayName(nodes, 'master')} (default)`}</option>
            {installDefault ? <option value="master">{nodeDisplayName(nodes, 'master')}</option> : null}
            {nodeOptions.filter(node => node.id !== 'master').map(node => (
              <option key={node.id} value={node.id}>{node.displayName}{node.online ? '' : ' · offline'}</option>
            ))}
          </select>
          {value.isolatedNode ? <span className={hintClass}>Set by isolation.</span> : null}
        </label>
        <label className={labelClass}>
          Working directory
          <input data-agent-default-cwd value={value.defaultCwd} disabled={disabled} onChange={event => set({ defaultCwd: event.target.value })} placeholder={`Absolute path on ${nodeDisplayName(nodeOptions, startNode || installDefault || 'master')}`} spellCheck={false} autoComplete="off" className={`${controlClass} font-mono`} />
          <span className={hintClass}>Existing sessions keep their current directory.</span>
        </label>
      </section>

      <section className="border-t border-fw-border-muted pt-4 dark:border-fw-border">
        {isolationCollapsed ? (
          <details data-agent-settings-isolation-section open={!!value.isolatedNode || undefined} className="group">
            <summary className={`${sectionTitle} cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden`}><Shield className="h-3.5 w-3.5" /> Isolation<ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /></summary>
            {isolation}
          </details>
        ) : (
          <>
            <h3 className={sectionTitle}><Shield className="h-3.5 w-3.5" /> Isolation</h3>
            {isolation}
          </>
        )}
      </section>
    </div>
  )
}
