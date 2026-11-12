import type { ReactNode } from 'react'
import { FolderOpen, MemoryStick } from 'lucide-react'
import type { WebUiNodeTarget } from '../nodeTargets'
import type { AgentSettingsChanges, AgentSummary } from '../agentCreation'

/** Mutable Agent settings shared by the New agent dialog and the Agents inspector. */
export type AgentSettingsDraft = {
  inheritAgent: string
  defaultNode: string
  defaultCwd: string
}

export const EMPTY_AGENT_SETTINGS: AgentSettingsDraft = { inheritAgent: '', defaultNode: '', defaultCwd: '' }

export function agentSettingsDraft(agent: AgentSummary): AgentSettingsDraft {
  return {
    inheritAgent: agent.inherit || '',
    defaultNode: agent.defaultNode || '',
    defaultCwd: agent.defaultCwd || '',
  }
}

export function agentSettingsChanges(draft: AgentSettingsDraft): AgentSettingsChanges {
  return {
    inheritAgent: draft.inheritAgent || null,
    defaultNode: draft.defaultNode || null,
    defaultCwd: draft.defaultCwd.trim() || null,
  }
}

export function agentSettingsDirty(draft: AgentSettingsDraft, agent: AgentSummary): boolean {
  const next = agentSettingsChanges(draft)
  return next.inheritAgent !== (agent.inherit || null)
    || next.defaultNode !== (agent.defaultNode || null)
    || next.defaultCwd !== (agent.defaultCwd || null)
}

export function nodeDisplayName(nodes: readonly WebUiNodeTarget[], nodeId: string): string {
  return nodes.find(node => node.id === nodeId)?.displayName || nodeId
}

const sectionTitle = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted'
const labelClass = 'mt-2 block text-xs font-medium text-fw-text-muted'
const controlClass = 'mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface-sunken px-2.5 py-2 text-sm font-normal text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 disabled:cursor-not-allowed disabled:opacity-70 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong'
const hintClass = 'mt-1 block text-[11px] font-normal text-fw-text-muted'

export default function AgentSettingsFields({ value, onChange, agentId, agents, nodes, installDefaultNode = null, inheritanceChain, disabled = false }: {
  value: AgentSettingsDraft
  onChange: (next: AgentSettingsDraft) => void
  /** The edited Agent; empty while creating one. */
  agentId: string
  agents: readonly AgentSummary[]
  nodes: readonly WebUiNodeTarget[]
  /** Installation `agentDefaultNode`, used when the Agent sets no default Node. */
  installDefaultNode?: string | null
  inheritanceChain?: ReactNode
  disabled?: boolean
}) {
  const set = (patch: Partial<AgentSettingsDraft>) => onChange({ ...value, ...patch })
  const known = (id: string) => !id || nodes.some(node => node.id === id)
  const withSaved = (ids: string[]) => {
    const extra = ids.filter(id => !known(id)).map(id => ({ id, type: 'unknown', displayName: id, online: false, services: {} }) as WebUiNodeTarget)
    return [...nodes, ...extra]
  }
  const startNode = value.defaultNode
  // With an installation default, unset and an explicit master choose different Nodes.
  const installDefault = installDefaultNode && installDefaultNode !== 'master' ? installDefaultNode : null
  const nodeOptions = withSaved([value.defaultNode, installDefault || ''])
  const inheritOptions = agents.filter(agent => agent.id !== agentId.trim() && agent.inheritable !== false)

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
          <select data-agent-default-node value={startNode === 'master' && !installDefault ? '' : startNode} disabled={disabled} onChange={event => set({ defaultNode: event.target.value })} className={controlClass}>
            <option value="">{installDefault ? `Installation default (${nodeDisplayName(nodeOptions, installDefault)})` : `${nodeDisplayName(nodes, 'master')} (default)`}</option>
            {installDefault ? <option value="master">{nodeDisplayName(nodes, 'master')}</option> : null}
            {nodeOptions.filter(node => node.id !== 'master').map(node => (
              <option key={node.id} value={node.id}>{node.displayName}{node.online ? '' : ' · offline'}</option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Working directory
          <input data-agent-default-cwd value={value.defaultCwd} disabled={disabled} onChange={event => set({ defaultCwd: event.target.value })} placeholder={`Absolute path on ${nodeDisplayName(nodeOptions, startNode || installDefault || 'master')}`} spellCheck={false} autoComplete="off" className={`${controlClass} font-mono`} />
          <span className={hintClass}>Existing sessions keep their current directory.</span>
        </label>
      </section>

    </div>
  )
}
