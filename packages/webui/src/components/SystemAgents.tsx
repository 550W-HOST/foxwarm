// System › Agents: the Agents as a creator tree, and an inspector with the Agent's Sessions,
// prompt layers, rule layers and settings.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bot, ChevronRight, ExternalLink, Lock, Plus, Save, Trash2 } from 'lucide-react'
import AgentSettingsFields, { EMPTY_AGENT_SETTINGS, agentSettingsChanges, agentSettingsDirty, agentSettingsDraft, type AgentSettingsDraft } from './AgentSettingsFields'
import type { AgentSettingsChanges } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'
import type { Session } from './SessionListCore'
import { API_BASE_PATH } from '../config'
import { getStatusTone } from './SystemShared'
import { formatActivityTime } from '../activityTime'
import { SystemEmptyDetail, SystemSplit, useSystemSplit } from './SystemSplit'
import { PromptLayers, RuleLayers, isAllowlistLayer, joinNames, pill, systemHeading, type InstallationPrompt, type OpenInCode } from './SystemAgentLayers'
import { SessionStateText, sessionShortName } from './SystemSessions'

export type AgentRegistryEntry = {
  id: string
  inherit: string | null
  inheritanceChain: string[]
  /** The Agent that created this one, or null for a top-level Agent. */
  createdBy: string | null
  /** Root-first creator ancestry ending with this Agent; null when it can't be resolved. */
  creatorChain: string[] | null
  /** This Agent's own rule layer. */
  rules: unknown[]
  ruleCount: number
  inheritable: boolean
  restricted: boolean
  isolationMigration: { migratedAt: number | null; automatic: boolean; node: string | null; failClosed?: string } | null
  defaultNode: string | null
  defaultCwd: string | null
  sessionCount: number
  activeSessionCount: number
  queuedSessionCount: number
  /** Latest message time of the Agent's Sessions, in milliseconds. */
  lastActivity: number | null
  memoryRoot: string
  memoryFileCount: number
  memoryLastModified: number | null
}

export type AgentRegistryChanges = AgentSettingsChanges | { rules: unknown[] }

export type AgentMemoryFile = { path: string; absolutePath: string; size: number; modifiedAt: number }

export type AgentTab = 'overview' | 'prompt' | 'rules' | 'settings'
const AGENT_TABS: Array<[AgentTab, string]> = [['overview', 'Overview'], ['prompt', 'Prompt'], ['rules', 'Rules'], ['settings', 'Settings']]

/** Creator-tree order: each Agent after its creator; `main` first, then by name. */
export function creatorTreeOrder(agents: AgentRegistryEntry[]) {
  const ids = new Set(agents.map(agent => agent.id))
  const byParent = new Map<string, AgentRegistryEntry[]>()
  for (const agent of agents) {
    const parent = agent.createdBy && ids.has(agent.createdBy) && agent.createdBy !== agent.id ? agent.createdBy : ''
    byParent.set(parent, [...(byParent.get(parent) || []), agent])
  }
  const rows: Array<{ agent: AgentRegistryEntry; depth: number }> = []
  const seen = new Set<string>()
  const visit = (parent: string, depth: number) => {
    const children = (byParent.get(parent) || []).sort((left, right) => left.id === 'main' ? -1 : right.id === 'main' ? 1 : left.id.localeCompare(right.id))
    for (const agent of children) {
      if (seen.has(agent.id)) continue
      seen.add(agent.id); rows.push({ agent, depth }); visit(agent.id, depth + 1)
    }
  }
  visit('', 0)
  // A creator cycle has no root; list its members at the top level rather than hiding them.
  for (const agent of agents) if (!seen.has(agent.id)) { seen.add(agent.id); rows.push({ agent, depth: 0 }) }
  return rows
}

function AgentRulesPill({ agent }: { agent: AgentRegistryEntry }) {
  if (agent.isolationMigration?.failClosed || agent.creatorChain === null) return pill('Blocked', 'danger')
  if (agent.restricted) return pill(<><Lock className="h-2.5 w-2.5" />Allowlist</>, 'warning')
  if (agent.ruleCount) return pill(`${agent.ruleCount} rule${agent.ruleCount === 1 ? '' : 's'}`, 'neutral')
  return null
}

function AgentList({ agents, selectedId, onSelect, onCreateSession }: { agents: AgentRegistryEntry[]; selectedId: string | null; onSelect: (id: string) => void; onCreateSession?: (id: string) => void }) {
  const rows = useMemo(() => creatorTreeOrder(agents), [agents])
  return (
    <ul className="space-y-0.5" data-system-agent-list>
      {rows.map(({ agent, depth }) => {
        const active = agent.activeSessionCount
        const selected = agent.id === selectedId
        return (
          <li key={agent.id}>
            <div role="button" tabIndex={0} data-architecture-agent-id={agent.id} data-architecture-agent-selected={selected ? 'true' : 'false'} data-agent-depth={depth}
              onClick={() => onSelect(agent.id)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(agent.id) } }}
              className={`group flex min-w-0 items-center gap-2 rounded-lg py-2 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring ${selected ? 'bg-fw-accent-surface ring-1 ring-fw-accent-border dark:bg-fw-accent-surface-strong/30' : 'hover:bg-fw-hover'}`}
              style={{ paddingLeft: 10 + depth * 18 }}>
              {depth ? <span className="h-3 w-2.5 shrink-0 self-start border-b border-l border-fw-border-strong" aria-hidden /> : null}
              <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-fw-accent' : 'bg-fw-border-strong'}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13px] font-semibold text-fw-text-strong">{agent.id}</span><AgentRulesPill agent={agent} /></div>
                <div className="mt-0.5 truncate text-[11px] text-fw-text-muted">{[agent.inherit ? `memory from ${agent.inherit}` : 'own memory', agent.defaultNode ? `starts on ${agent.defaultNode}` : ''].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="shrink-0 text-right text-[11px] tabular-nums text-fw-text-muted">
                {active ? <div className="font-medium text-fw-accent">{active} active</div> : <div>{agent.sessionCount} session{agent.sessionCount === 1 ? '' : 's'}</div>}
                <div>{agent.lastActivity ? formatActivityTime(agent.lastActivity) : '—'}</div>
              </div>
              {onCreateSession ? <button type="button" aria-label={`New session for ${agent.id}`} title="New session" onClick={event => { event.stopPropagation(); onCreateSession(agent.id) }} className="rounded-md p-1 text-fw-text-muted opacity-0 hover:bg-fw-surface hover:text-fw-text focus:opacity-100 group-hover:opacity-100"><Plus className="h-3.5 w-3.5" /></button> : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One Agent's Sessions, newest first, from the Agent-filtered catalog query (the System list
 * holds only a bounded window). Loaded rows supply live runtime state.
 */
function useAgentSessions(agent: AgentRegistryEntry, live: Session[]) {
  const [rows, setRows] = useState<Session[] | null>(null)
  useEffect(() => {
    let current = true
    const params = new URLSearchParams({ agent: agent.id, limit: '20', childLimit: '20' })
    void fetch(`${API_BASE_PATH}/session-list/architecture?${params}`).then(async response => {
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `Session query failed (${response.status})`)
      const all: Session[] = [...(payload.roots?.sessions || []), ...((payload.children || []) as Array<{ sessions?: Session[] }>).flatMap(group => group.sessions || [])]
      if (current) setRows([...new Map(all.filter(row => (row.agent || 'main') === agent.id).map(row => [row.id, row])).values()])
    }).catch(() => { if (current) setRows([]) })
    return () => { current = false }
  }, [agent.id, agent.sessionCount, agent.lastActivity])
  return useMemo(() => {
    if (!rows) return null
    const byId = new Map(live.map(row => [row.id, row]))
    return rows.map(row => byId.get(row.id) || row).sort((left, right) => (right.lastMessageTime || 0) - (left.lastMessageTime || 0))
  }, [rows, live])
}

function AgentSessionList({ sessions, total, now, onInspect, onOpen, onShowAll }: { sessions: Session[] | null; total: number; now: number; onInspect: (id: string) => void; onOpen: (id: string) => void; onShowAll: () => void }) {
  const [all, setAll] = useState(false)
  if (!sessions) return <div className="text-xs text-fw-text-muted">Loading…</div>
  if (!sessions.length) return <div className="text-xs text-fw-text-muted">No sessions yet.</div>
  const limit = 8
  return (
    <div>
      <ul className="divide-y divide-fw-border-muted" data-agent-sessions>
        {(all ? sessions : sessions.slice(0, limit)).map(session => (
          <li key={session.id} className="flex min-w-0 items-center gap-2 py-1.5 text-xs" data-agent-session-id={session.id}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusTone(session)}`} aria-hidden />
            <button type="button" onClick={() => onInspect(session.id)} className="min-w-0 flex-1 truncate text-left font-medium text-fw-text-strong hover:text-fw-accent" title={session.id}>{sessionShortName(session)}</button>
            <SessionStateText session={session} now={now} />
            <span className="shrink-0 text-fw-text-muted">{session.lastMessageTime ? formatActivityTime(session.lastMessageTime) : '—'}</span>
            <button type="button" onClick={() => onOpen(session.id)} aria-label={`Open ${session.id}`} title="Open session" className="rounded p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text"><ExternalLink className="h-3 w-3" /></button>
          </li>
        ))}
      </ul>
      {/* The inspector loads the newest Sessions; the Sessions section lists all of them. */}
      {total > sessions.length && (all || sessions.length <= limit)
        ? <button type="button" data-agent-sessions-all onClick={onShowAll} className="mt-1 text-xs font-medium text-fw-accent hover:underline">Show all {total} in Sessions</button>
        : sessions.length > limit ? <button type="button" onClick={() => setAll(value => !value)} className="mt-1 text-xs font-medium text-fw-accent hover:underline">{all ? 'Show fewer' : `Show all ${sessions.length}`}</button> : null}
    </div>
  )
}

function AgentSettingsPanel({ agent, agents, nodes, installDefaultNode, onSave, onDelete }: {
  agent: AgentRegistryEntry; agents: AgentRegistryEntry[]; nodes: WebUiNodeTarget[]; installDefaultNode: string | null
  onSave: (agentId: string, changes: AgentRegistryChanges) => Promise<void>; onDelete: (agentId: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<AgentSettingsDraft>(EMPTY_AGENT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  useEffect(() => { setDraft(agentSettingsDraft(agent)); setError(''); setDeleteOpen(false); setConfirm('') }, [agent.id, agent.inherit, agent.defaultNode, agent.defaultCwd])
  const dirty = agentSettingsDirty(draft, agent)
  const run = async (action: () => Promise<void>) => { setSaving(true); setError(''); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) } }
  return (
    <div data-agent-settings={agent.id}>
      <AgentSettingsFields value={draft} onChange={setDraft} agentId={agent.id} agents={agents} nodes={nodes} installDefaultNode={installDefaultNode} disabled={saving}
        inheritanceChain={<div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-fw-text-muted">{agent.inheritanceChain.map((item, index) => <span key={item} className="inline-flex items-center gap-1"><span className={`rounded px-1.5 py-0.5 ${item === agent.id ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40' : 'bg-fw-neutral-surface dark:bg-fw-surface-raised'}`}>{item}</span>{index < agent.inheritanceChain.length - 1 ? <ChevronRight className="h-3 w-3" /> : null}</span>)}</div>} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" data-agent-settings-reset disabled={!dirty || saving} onClick={() => setDraft(agentSettingsDraft(agent))} className="rounded-lg px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:opacity-40">Reset</button>
        <button type="button" data-agent-settings-save disabled={!dirty || saving} onClick={() => { void run(() => onSave(agent.id, agentSettingsChanges(draft))) }} className="inline-flex items-center gap-1.5 rounded-lg bg-fw-accent px-3 py-1.5 text-xs font-medium text-fw-accent-text disabled:opacity-40"><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save agent settings'}</button>
      </div>
      <section className="mt-5 border-t border-fw-border-muted pt-4">
        {agent.id === 'main' ? <p className="text-xs text-fw-text-muted">The main agent cannot be deleted.</p> : !deleteOpen ? (
          <button type="button" data-agent-delete onClick={() => setDeleteOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-fw-danger hover:bg-fw-danger-surface"><Trash2 className="h-3.5 w-3.5" />Delete agent</button>
        ) : (
          <div className="rounded-lg border border-fw-danger-border bg-fw-danger-surface/50 p-3 dark:bg-fw-danger-surface-strong/20">
            <p className="text-xs leading-5 text-fw-danger">Deletes {agent.sessionCount} session(s), this workspace, and self-owned memory. Durable session archives remain reserved. Type <strong>{agent.id}</strong> to confirm.</p>
            <input value={confirm} onChange={event => setConfirm(event.target.value)} aria-label="Agent name" className="mt-2 w-full rounded-md border border-fw-danger-border bg-fw-surface px-2.5 py-1.5 font-mono text-xs outline-none dark:bg-fw-canvas" />
            <div className="mt-2 flex gap-2"><button type="button" onClick={() => { setDeleteOpen(false); setConfirm('') }} className="flex-1 rounded-md border border-fw-border px-2 py-1.5 text-xs">Cancel</button><button type="button" disabled={confirm !== agent.id || saving} onClick={() => { void run(() => onDelete(agent.id)) }} className="flex-1 rounded-md bg-fw-danger px-2 py-1.5 text-xs font-medium text-fw-text-inverse disabled:opacity-40">Delete</button></div>
          </div>
        )}
      </section>
      {error ? <div role="alert" className="mt-3 rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">{error}</div> : null}
    </div>
  )
}

export type SystemAgentsProps = {
  phone: boolean
  now: number
  agents: AgentRegistryEntry[]
  error: string
  /** Every loaded Session, for live state in an Agent's Session list. */
  sessions: Session[]
  nodes: WebUiNodeTarget[]
  installDefaultNode: string | null
  installationPrompt: InstallationPrompt
  selectedId: string | null
  onSelect: (agentId: string) => void
  tab: AgentTab
  onTabChange: (tab: AgentTab) => void
  /** A new value opens the selected Agent's details on a narrow pane. */
  detailRequest: number
  toolbar: ReactNode
  onCreateSession: (agentId: string) => void
  onInspectSession: (sessionId: string) => void
  onOpenSession: (sessionId: string) => void
  /** Shows the Sessions section filtered to this Agent. */
  onShowAgentSessions: (agentId: string) => void
  onOpenInCode: OpenInCode
  onCreateInstallationPrompt: () => Promise<void>
  onOpenSetupAuthorization?: () => void
  onSave: (agentId: string, changes: AgentRegistryChanges) => Promise<void>
  onDelete: (agentId: string) => Promise<void>
}

function AgentInspector({ agent, props }: { agent: AgentRegistryEntry; props: SystemAgentsProps }) {
  const sessions = useAgentSessions(agent, props.sessions)
  const { tab, onTabChange: setTab } = props
  const showAgent = (id: string) => props.onSelect(id)
  const ancestors = (agent.creatorChain || []).slice(0, -1)
  return (
    <section className="rounded-xl border border-fw-border bg-fw-surface" data-architecture-agent-inspector-id={agent.id}>
      <header className="border-b border-fw-border-muted px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-fw-text-strong">{agent.id}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fw-text-muted">
              <span>{agent.inherit ? <>Memory from <span className="text-fw-text-strong">{agent.inherit}</span></> : 'Own memory'}</span>
              {agent.createdBy ? <span>Created by <span className="text-fw-text-strong">{agent.createdBy}</span></span> : null}
              <span>Starts on <span className="text-fw-text-strong">{agent.defaultNode || props.installDefaultNode || 'master'}</span></span>
            </div>
          </div>
          <button type="button" data-agent-new-session onClick={() => props.onCreateSession(agent.id)} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-fw-text-strong px-2.5 py-1.5 text-xs font-medium text-fw-surface hover:bg-fw-text"><Plus className="h-3.5 w-3.5" />New session</button>
        </div>
        {agent.isolationMigration?.failClosed ? <p data-agent-migration-blocked className="mt-3 rounded-lg bg-fw-warning-surface px-3 py-2 text-xs leading-5 text-fw-warning dark:bg-fw-warning-surface-strong/40">Every tool call of this agent is blocked: {agent.isolationMigration.failClosed} Replace its rules to restore access.</p>
          : agent.isolationMigration ? <p data-agent-migration className="mt-2 text-xs leading-5 text-fw-text-muted">Rules generated from legacy isolation{agent.isolationMigration.automatic ? ' at startup' : ''}.</p> : null}
        <div className="-mb-px mt-3 flex gap-4 overflow-x-auto text-xs" role="tablist" aria-label="Agent details">
          {AGENT_TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-agent-tab={id} onClick={() => setTab(id)} className={`whitespace-nowrap border-b-2 pb-2 font-medium ${tab === id ? 'border-fw-accent text-fw-text-strong' : 'border-transparent text-fw-text-muted hover:text-fw-text'}`}>
              {label}{id === 'rules' && agent.ruleCount > 0 ? <span className="ml-1 text-fw-text-muted">{agent.ruleCount}</span> : null}
            </button>
          ))}
        </div>
      </header>
      <div className="p-4" role="tabpanel" data-agent-tab-panel={tab}>
        {tab === 'overview' ? (
          <div className="space-y-5">
            <section><h3 className={systemHeading}>Sessions</h3><div className="mt-1.5"><AgentSessionList sessions={sessions} total={agent.sessionCount} now={props.now} onInspect={props.onInspectSession} onOpen={props.onOpenSession} onShowAll={() => props.onShowAgentSessions(agent.id)} /></div></section>
            <section data-agent-access>
              <h3 className={systemHeading}>Access</h3>
              <p className="mt-1.5 text-xs leading-5 text-fw-text">
                {agent.restricted || isAllowlistLayer(agent.rules || []) ? 'Only what its own rules allow.' : agent.ruleCount > 0 ? `Whatever the layers above allow, narrowed by its ${agent.ruleCount === 1 ? 'rule' : `${agent.ruleCount} rules`}.` : 'Whatever the layers above allow.'}
                {ancestors.length ? ` Rules from ${joinNames(ancestors)} apply too.` : ''}{' '}
                <button type="button" className="font-medium text-fw-accent hover:underline" onClick={() => setTab('rules')}>View rules</button>
              </p>
            </section>
            <section>
              <h3 className={systemHeading}>Prompt</h3>
              <p className="mt-1.5 text-xs leading-5 text-fw-text">
                {agent.inheritanceChain.length > 1 ? `Framework prompt, installation additions, memory of ${joinNames(agent.inheritanceChain.slice(0, -1))}, then its own memory.` : 'Framework prompt, installation additions, then its own memory.'}{' '}
                <button type="button" className="font-medium text-fw-accent hover:underline" onClick={() => setTab('prompt')}>View prompt</button>
              </p>
            </section>
          </div>
        ) : tab === 'prompt' ? <PromptLayers agent={agent} installation={props.installationPrompt} onOpen={props.onOpenInCode} onCreateInstallation={props.onCreateInstallationPrompt} onShowAgent={showAgent} />
          : tab === 'rules' ? <RuleLayers agent={agent} agents={props.agents} onSave={rules => props.onSave(agent.id, { rules })} onShowAgent={showAgent} onOpenSetupAuthorization={props.onOpenSetupAuthorization} />
          : <AgentSettingsPanel agent={agent} agents={props.agents} nodes={props.nodes} installDefaultNode={props.installDefaultNode} onSave={props.onSave} onDelete={props.onDelete} />}
      </div>
    </section>
  )
}

export default function SystemAgents(props: SystemAgentsProps) {
  const split = useSystemSplit(props.phone)
  const agent = props.agents.find(item => item.id === props.selectedId) || null
  useEffect(() => { if (props.detailRequest) split.open() }, [props.detailRequest])
  const select = (id: string) => { props.onSelect(id); split.open() }
  return (
    <SystemSplit split={split} name="agents" backLabel="Agents" detailWidth="minmax(380px,460px)"
      toolbar={<>
        <div className="flex items-center gap-2 px-1">{props.toolbar}</div>
        {props.error ? <div role="alert" className="mt-2 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger">{props.error}</div> : null}
      </>}
      list={props.agents.length ? <AgentList agents={props.agents} selectedId={split.narrow ? null : props.selectedId} onSelect={select} onCreateSession={split.narrow ? undefined : props.onCreateSession} />
        : props.error ? null : <div className="rounded-xl border border-dashed border-fw-border-strong py-10 text-center text-sm text-fw-text-muted">No agents found.</div>}
      detail={agent ? <AgentInspector key={agent.id} agent={agent} props={props} /> : <SystemEmptyDetail icon={<Bot className="h-6 w-6" />} title="Select an agent" />}
    />
  )
}
