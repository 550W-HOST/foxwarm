import { useEffect, useState } from 'react'
import { Bot, ChevronRight, FileText, FolderOpen, MemoryStick, Save, Trash2 } from 'lucide-react'
import AgentSettingsFields, { EMPTY_AGENT_SETTINGS, agentSettingsChanges, agentSettingsDirty, agentSettingsDraft, type AgentSettingsDraft } from './AgentSettingsFields'
import type { AgentSettingsChanges } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'
import { UsagePie, formatRelativeTime, renderMetaBadge, type LoadedUsage } from './SystemShared'

export type AgentRegistryEntry = {
  id: string
  inherit: string | null
  inheritanceChain: string[]
  inheritable: boolean
  restricted: boolean
  isolationMigration: { migratedAt: number | null; automatic: boolean; node: string | null; failClosed?: string } | null
  defaultNode: string | null
  defaultCwd: string | null
  sessionCount: number
  activeSessionCount: number
  queuedSessionCount: number
  memoryRoot: string
  memoryFileCount: number
  memoryLastModified: number | null
}

export type AgentRegistryChanges = AgentSettingsChanges

export type AgentMemoryFile = { path: string; absolutePath: string; size: number; modifiedAt: number }

const formatBytes = (size: number) => {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

const agentPolicyBadge = (agent: AgentRegistryEntry) => (
  agent.isolationMigration?.failClosed ? renderMetaBadge('blocked', 'warning')
    : agent.restricted ? renderMetaBadge('restricted', 'warning')
    : null
)

export function AgentRegistryCard({ agent, usage, selected, onSelect }: { agent: AgentRegistryEntry; usage?: LoadedUsage; selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect() } }}
      data-architecture-agent-id={agent.id}
      data-architecture-agent-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      className={`rounded-xl border p-4 text-left shadow-sm transition-colors ${selected
        ? 'border-fw-accent-border bg-fw-accent-surface/80 ring-1 ring-fw-focus-ring dark:border-fw-accent-border dark:bg-fw-accent-surface-strong/30 dark:ring-fw-focus-ring'
        : 'border-fw-border bg-fw-surface hover:border-fw-border-strong dark:border-fw-border dark:bg-fw-surface dark:hover:border-fw-border-strong'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fw-special-surface text-fw-special dark:bg-fw-special-surface/40 dark:text-fw-special"><Bot className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-fw-text-strong">{agent.id}</h3>
            <p className="mt-0.5 truncate text-[11px] text-fw-text-muted">{agent.inherit ? `inherits ${agent.inherit}` : 'independent memory'}</p>
          </div>
        </div>
        <UsagePie usage={usage?.count ? usage : undefined} loaded />
        {agentPolicyBadge(agent)}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-fw-surface-sunken px-2 py-2 dark:bg-fw-canvas/50"><div className="text-base font-semibold tabular-nums text-fw-text-strong">{agent.sessionCount}</div><div className="text-[10px] uppercase tracking-wide text-fw-text-muted">sessions</div></div>
        <div className="rounded-lg bg-fw-surface-sunken px-2 py-2 dark:bg-fw-canvas/50"><div className="text-base font-semibold tabular-nums text-fw-accent dark:text-fw-accent">{agent.activeSessionCount}</div><div className="text-[10px] uppercase tracking-wide text-fw-text-muted">active</div></div>
        <div className="rounded-lg bg-fw-surface-sunken px-2 py-2 dark:bg-fw-canvas/50"><div className="text-base font-semibold tabular-nums text-fw-text-strong">{agent.memoryFileCount}</div><div className="text-[10px] uppercase tracking-wide text-fw-text-muted">memory</div></div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-fw-text-muted">
        <span>{agent.queuedSessionCount > 0 ? `${agent.queuedSessionCount} queued` : 'queue clear'}</span>
        <span>{agent.memoryLastModified ? `memory ${formatRelativeTime(agent.memoryLastModified)}` : 'no memory files'}</span>
      </div>
    </div>
  )
}

export function AgentRegistryInspector({ agent, allAgents, nodes, installDefaultNode = null, memoryFiles, memoryLoading, memoryError, onOpenMemory, onSave, onDelete }: {
  agent: AgentRegistryEntry | null
  allAgents: AgentRegistryEntry[]
  nodes: WebUiNodeTarget[]
  installDefaultNode?: string | null
  memoryFiles: AgentMemoryFile[]
  memoryLoading: boolean
  memoryError: string
  onOpenMemory: (memoryRoot: string, filePath?: string) => void
  onSave: (agentId: string, changes: AgentRegistryChanges) => Promise<void>
  onDelete: (agentId: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<AgentSettingsDraft>(EMPTY_AGENT_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(agent ? agentSettingsDraft(agent) : EMPTY_AGENT_SETTINGS)
    setDeleteOpen(false)
    setDeleteConfirm('')
    setError('')
  }, [agent?.id, agent?.inherit, agent?.defaultNode, agent?.defaultCwd])

  if (!agent) {
    return <aside className="rounded-xl border border-dashed border-fw-border-strong bg-fw-surface/60 p-6 text-center dark:border-fw-border dark:bg-fw-surface/50"><Bot className="mx-auto h-6 w-6 text-fw-text" /><h3 className="mt-3 text-sm font-semibold text-fw-text-strong">Select an agent</h3><p className="mt-1 text-xs text-fw-text-muted">Inspect memory, inheritance, placement, and lifecycle controls.</p></aside>
  }

  const dirty = agentSettingsDirty(draft, agent)
  const save = async () => {
    setSaving(true); setError('')
    try { await onSave(agent.id, agentSettingsChanges(draft)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  const remove = async () => {
    setSaving(true); setError('')
    try { await onDelete(agent.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false) }
  }

  return (
    <aside data-architecture-agent-inspector-id={agent.id} className="order-first overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-sm dark:border-fw-border dark:bg-fw-surface xl:order-none xl:sticky xl:top-4">
      <header className="border-b border-fw-border-muted p-4 dark:border-fw-border">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-base font-semibold text-fw-text-strong">{agent.id}</h2><p className="mt-1 text-xs text-fw-text-muted">Persistent workspace and memory owner</p></div>
          <button type="button" onClick={() => onOpenMemory(agent.memoryRoot)} className="inline-flex items-center gap-1.5 rounded-lg bg-fw-text-strong px-2.5 py-1.5 text-xs font-medium text-fw-surface hover:bg-fw-text"><FolderOpen className="h-3.5 w-3.5" /> Memory</button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">{renderMetaBadge(`${agent.sessionCount} sessions`)}{agent.activeSessionCount ? renderMetaBadge(`${agent.activeSessionCount} active`, 'active') : null}{agentPolicyBadge(agent) ?? renderMetaBadge('unrestricted', 'muted')}</div>
        {agent.isolationMigration?.failClosed ? <p data-agent-migration-blocked className="mt-3 rounded-lg bg-fw-warning-surface px-3 py-2 text-xs leading-5 text-fw-warning dark:bg-fw-warning-surface-strong/40">Every tool call of this agent is blocked: {agent.isolationMigration.failClosed} Replace its rules to restore access.</p>
          : agent.isolationMigration ? <p data-agent-migration className="mt-3 text-xs leading-5 text-fw-text-muted">Rules generated from legacy isolation{agent.isolationMigration.automatic ? ' at startup' : ''}.</p> : null}
      </header>

      <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-4">
        <AgentSettingsFields
          value={draft}
          onChange={setDraft}
          agentId={agent.id}
          agents={allAgents}
          nodes={nodes}
          installDefaultNode={installDefaultNode}
          disabled={saving}
          inheritanceChain={<div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-fw-text-muted">{agent.inheritanceChain.map((item, index) => <span key={item} className="inline-flex items-center gap-1"><span className={`rounded px-1.5 py-0.5 ${item === agent.id ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent' : 'bg-fw-neutral-surface dark:bg-fw-surface-raised'}`}>{item}</span>{index < agent.inheritanceChain.length - 1 ? <ChevronRight className="h-3 w-3" /> : null}</span>)}</div>}
        />
        <div className="mt-4 flex gap-2">
          <button type="button" data-agent-settings-reset disabled={!dirty || saving} onClick={() => setDraft(agentSettingsDraft(agent))} className="rounded-lg px-3 py-2 text-xs text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-fw-hover">Reset</button>
          <button type="button" disabled={!dirty || saving} onClick={() => { void save() }} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-fw-accent px-3 py-2 text-xs font-medium text-fw-accent-text hover:bg-fw-accent disabled:cursor-not-allowed disabled:opacity-40"><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save agent settings'}</button>
        </div>

        <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
          <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted"><MemoryStick className="h-3.5 w-3.5" /> Memory files</h3><span className="text-[10px] text-fw-text-muted">{memoryFiles.length} Markdown</span></div>
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {memoryLoading ? <div className="py-4 text-center text-xs text-fw-text-muted">Loading memory manifest…</div> : null}
            {memoryError ? <div className="rounded-lg bg-fw-danger-surface px-2.5 py-2 text-xs text-fw-danger dark:bg-fw-danger-surface-strong/30 dark:text-fw-danger">{memoryError}</div> : null}
            {!memoryLoading && !memoryError && memoryFiles.map(file => (
              <button key={file.path} type="button" onClick={() => onOpenMemory(agent.memoryRoot, file.absolutePath)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-fw-hover dark:hover:bg-fw-hover">
                <FileText className="h-3.5 w-3.5 shrink-0 text-fw-text-muted" /><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fw-text-strong" title={file.path}>{file.path}</span><span className="shrink-0 text-[9px] text-fw-text-muted">{formatBytes(file.size)}</span>
              </button>
            ))}
            {!memoryLoading && !memoryError && memoryFiles.length === 0 ? <div className="py-4 text-center text-xs text-fw-text-muted">No Markdown memory files.</div> : null}
          </div>
        </section>

        <section className="mt-4 border-t border-fw-border-muted pt-4 dark:border-fw-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-danger">Danger zone</h3>
          {agent.id === 'main' ? <p className="mt-2 text-xs text-fw-text-muted">The main agent cannot be deleted.</p> : !deleteOpen ? <button type="button" onClick={() => setDeleteOpen(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-fw-danger-border px-2.5 py-1.5 text-xs font-medium text-fw-danger hover:bg-fw-danger-surface dark:border-fw-danger-border dark:text-fw-danger dark:hover:bg-fw-danger-surface-strong/30"><Trash2 className="h-3.5 w-3.5" /> Delete agent</button> : (
            <div className="mt-2 rounded-lg border border-fw-danger-border bg-fw-danger-surface/50 p-3 dark:border-fw-danger-border dark:bg-fw-danger-surface-strong/20"><p className="text-xs leading-5 text-fw-danger dark:text-fw-danger">Deletes {agent.sessionCount} session(s), this workspace, and self-owned memory. Durable session archives remain reserved. Type <strong>{agent.id}</strong> to confirm.</p><input value={deleteConfirm} onChange={event => setDeleteConfirm(event.target.value)} className="mt-2 w-full rounded-md border border-fw-danger-border bg-fw-surface px-2.5 py-1.5 font-mono text-xs outline-none dark:border-fw-danger-border dark:bg-fw-canvas" /><div className="mt-2 flex gap-2"><button type="button" onClick={() => { setDeleteOpen(false); setDeleteConfirm('') }} className="flex-1 rounded-md border border-fw-border px-2 py-1.5 text-xs dark:border-fw-border">Cancel</button><button type="button" disabled={deleteConfirm !== agent.id || saving} onClick={() => { void remove() }} className="flex-1 rounded-md bg-fw-danger px-2 py-1.5 text-xs font-medium text-fw-text-inverse disabled:opacity-40">Delete</button></div></div>
          )}
        </section>
        {error ? <div className="mt-3 rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger dark:bg-fw-danger-surface-strong/30 dark:text-fw-danger">{error}</div> : null}
      </div>
    </aside>
  )
}
