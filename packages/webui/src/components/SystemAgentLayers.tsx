// System › Agents inspector: the layers an Agent's system prompt is built from and the rule
// layers every one of its tool calls must pass.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FileText, FolderOpen, Pencil, Save, ShieldCheck } from 'lucide-react'
import YAML from 'yaml'
import SimpleCodeEditor from './SimpleCodeEditor'
import JsonInspectorDialog from './JsonInspectorDialog'
import { API_BASE_PATH } from '../config'
import { agentRulesYamlModelUri } from '../yamlConfigSchemas'
import type { AgentMemoryFile, AgentRegistryEntry } from './SystemAgents'

export type OpenInCode = (workspace: string, filePath?: string) => void

/** The installation's prompt additions file, from `GET /api/agents` `prompt.installation`. */
export type InstallationPrompt = { path: string; exists: boolean } | null

/** Names in running text: "a", "a and b", "a, b and c". */
export const joinNames = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || ''

export const systemHeading = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-fw-text-muted'
const linkButton = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium text-fw-accent hover:bg-fw-accent-surface disabled:opacity-50'

type Tone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success' | 'muted'
export const pill = (label: ReactNode, tone: Tone = 'neutral', title?: string) => {
  const tones: Record<Tone, string> = {
    neutral: 'bg-fw-neutral-surface text-fw-text dark:bg-fw-surface-raised',
    accent: 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40',
    warning: 'bg-fw-warning-surface text-fw-warning dark:bg-fw-warning-surface-strong/40',
    danger: 'bg-fw-danger-surface text-fw-danger dark:bg-fw-danger-surface-strong/40',
    success: 'bg-fw-success-surface text-fw-success dark:bg-fw-success-surface-strong/40',
    muted: 'bg-fw-surface-sunken text-fw-text-muted',
  }
  return <span title={title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}>{label}</span>
}

// ---------------------------------------------------------------------------------------------
// Prompt layers

/** Memory manifests of the Agents in a chain, reloaded when the chain changes. */
function useMemoryManifests(agentIds: string[]) {
  const key = agentIds.join('\u0000')
  const [manifests, setManifests] = useState<Record<string, { memoryRoot: string; files: AgentMemoryFile[] } | { error: string }>>({})
  useEffect(() => {
    let live = true
    void Promise.all(agentIds.map(async id => {
      try {
        const response = await fetch(`${API_BASE_PATH}/agents/${encodeURIComponent(id)}/memory`)
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `Memory query failed (${response.status})`)
        return [id, { memoryRoot: String(payload.memoryRoot || ''), files: Array.isArray(payload.files) ? payload.files : [] }] as const
      } catch (cause) { return [id, { error: cause instanceof Error ? cause.message : String(cause) }] as const }
    })).then(rows => { if (live) setManifests(Object.fromEntries(rows)) })
    return () => { live = false }
  }, [key])
  return manifests
}

function LayerRow({ index, title, subtitle, badge, children, actions, name }: { index: number; title: ReactNode; subtitle?: ReactNode; badge?: ReactNode; children?: ReactNode; actions?: ReactNode; name: string }) {
  return (
    <li className="relative pl-8" data-prompt-layer={name}>
      <span className="absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-fw-border bg-fw-surface text-[10px] font-semibold tabular-nums text-fw-text-muted">{index}</span>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-fw-text-strong">{title}{badge}</div>
          {subtitle ? <div className="mt-0.5 text-xs text-fw-text-muted">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children ? <div className="mt-1.5">{children}</div> : null}
    </li>
  )
}

function FileLinks({ manifest, onOpen }: { manifest?: { memoryRoot: string; files: AgentMemoryFile[] } | { error: string }; onOpen: OpenInCode }) {
  if (!manifest) return <div className="text-xs text-fw-text-muted">Loading…</div>
  if ('error' in manifest) return <div className="text-xs text-fw-danger">{manifest.error}</div>
  if (!manifest.files.length) return <div className="text-xs text-fw-text-muted">No memory files</div>
  return (
    <div className="flex flex-wrap gap-1.5">
      {manifest.files.map(file => (
        <button key={file.path} type="button" data-prompt-file={file.path} onClick={() => onOpen(manifest.memoryRoot, file.absolutePath)} title={`Open ${file.path} in Code`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-fw-border bg-fw-surface px-2 py-1 font-mono text-[11px] text-fw-text-strong hover:border-fw-accent-border hover:text-fw-accent">
          <FileText className="h-3 w-3 shrink-0 text-fw-text-muted" /><span className="truncate">{file.path}</span>
        </button>
      ))}
    </div>
  )
}

type FrameworkPrompt = { text: string | null; modelDependent: boolean; model: string | null; defaultModel: string | null }

/** Read-only view of the framework prompt text that currently applies to the Agent's new Sessions. */
export function FrameworkPromptDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState<FrameworkPrompt | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void fetch(`${API_BASE_PATH}/agents/${encodeURIComponent(agentId)}/framework-prompt`).then(async response => {
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `Couldn't load the prompt (${response.status})`)
      if (live) setPrompt(payload)
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { live = false }
  }, [agentId])
  const status = error ? <p role="alert" className="shrink-0 px-4 py-2 text-xs text-fw-danger">{error}</p>
    : prompt && prompt.text === null ? <p className="shrink-0 px-4 py-2 text-xs text-fw-text-muted">This installation has no framework prompt.</p>
    : prompt?.modelDependent ? <p data-framework-prompt-model={prompt.model || ''} className="shrink-0 border-b border-fw-border-muted px-4 py-2 text-xs text-fw-text-muted">Parts of this prompt depend on the model. Shown for <span className="font-mono text-fw-text-strong">{prompt.model || prompt.defaultModel || 'no model'}</span>, which new sessions of this agent use.</p>
    : null
  return <JsonInspectorDialog title="Foxwarm framework prompt" text={prompt?.text || ''} language="markdown" loading={!prompt && !error} status={status} onClose={onClose} />
}

/** The order an Agent's system prompt is built in. Files open in Code. */
export function PromptLayers({ agent, installation, onOpen, onCreateInstallation, onShowAgent }: {
  agent: AgentRegistryEntry
  installation: InstallationPrompt
  onOpen: OpenInCode
  onCreateInstallation: () => Promise<void>
  onShowAgent: (agentId: string) => void
}) {
  const chain = agent.inheritanceChain?.length ? agent.inheritanceChain : [agent.id]
  const manifests = useMemoryManifests(chain)
  const inherited = chain.filter(id => id !== agent.id)
  const [frameworkOpen, setFrameworkOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const installationDir = installation ? installation.path.replace(/[\\/][^\\/]*$/, '') : ''
  const create = async () => {
    setCreating(true); setError('')
    try { await onCreateInstallation() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setCreating(false) }
  }
  let index = 0
  return (
    <>
      <ol className="space-y-4" data-prompt-layers>
        <LayerRow name="framework" index={++index} title="Foxwarm framework prompt" badge={pill('Built in', 'muted')} subtitle="Part of this Foxwarm version"
          actions={<button type="button" data-prompt-framework-view className={linkButton} onClick={() => setFrameworkOpen(true)}><BookOpen className="h-3.5 w-3.5" />View</button>} />
        <LayerRow name="installation" index={++index} title="Installation additions" badge={pill('Every agent', 'neutral')}
          subtitle={<span className="font-mono text-[11px]">agents/00_SYSTEM.local.md</span>}
          actions={installation ? installation.exists
            ? <button type="button" data-prompt-installation-open className={linkButton} onClick={() => onOpen(installationDir, installation.path)}><ExternalLink className="h-3.5 w-3.5" />Open in Code</button>
            : <button type="button" data-prompt-installation-create disabled={creating} className={linkButton} onClick={() => { void create() }}><ExternalLink className="h-3.5 w-3.5" />{creating ? 'Creating…' : 'Create in Code'}</button>
            : null}>
          {installation && !installation.exists ? <div className="text-xs text-fw-text-muted">Not created yet</div> : null}
          {error ? <div role="alert" className="text-xs text-fw-danger">{error}</div> : null}
        </LayerRow>
        {inherited.map(id => {
          const manifest = manifests[id]
          return (
            <LayerRow key={id} name={`memory:${id}`} index={++index}
              title={<>Memory of <button type="button" className="text-fw-accent hover:underline" onClick={() => onShowAgent(id)}>{id}</button></>}
              badge={pill('Inherited', 'neutral')}
              actions={manifest && 'memoryRoot' in manifest ? <button type="button" className={linkButton} onClick={() => onOpen(manifest.memoryRoot)}><FolderOpen className="h-3.5 w-3.5" />Folder</button> : null}>
              <FileLinks manifest={manifest} onOpen={onOpen} />
            </LayerRow>
          )
        })}
        <LayerRow name={`memory:${agent.id}`} index={++index} title={<>Memory of {agent.id}</>} badge={pill('This agent', 'accent')}
          actions={<button type="button" className={linkButton} onClick={() => onOpen(agent.memoryRoot)}><FolderOpen className="h-3.5 w-3.5" />Folder</button>}>
          <FileLinks manifest={manifests[agent.id]} onOpen={onOpen} />
        </LayerRow>
      </ol>
      {frameworkOpen ? <FrameworkPromptDialog agentId={agent.id} onClose={() => setFrameworkOpen(false)} /> : null}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Rule layers

type Rule = Record<string, unknown>
const RULE_META = ['id', 'action', 'reason', 'approval', 'enabled']

const flow = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(flow).join(', ')
  if (value && typeof value === 'object') return '{ ' + Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${flow(item)}`).join(', ') + ' }'
  return String(value)
}

const actionTone = (action: unknown): Tone => action === 'deny' ? 'danger' : action === 'ask' ? 'warning' : 'success'

export function RuleList({ rules, emptyText }: { rules: unknown[]; emptyText: string }) {
  if (!rules.length) return <div className="rounded-lg border border-dashed border-fw-border px-3 py-2 text-xs text-fw-text-muted">{emptyText}</div>
  return (
    <ol className="divide-y divide-fw-border-muted overflow-hidden rounded-lg border border-fw-border bg-fw-surface" data-rule-list>
      {rules.map((raw, index) => {
        const rule = (raw && typeof raw === 'object' ? raw : {}) as Rule
        const id = String(rule.id ?? `rule ${index + 1}`)
        const selectors = Object.entries(rule).filter(([key]) => !RULE_META.includes(key))
        return (
          <li key={index} className="px-3 py-2" data-rule-id={id}>
            <div className="flex min-w-0 items-center gap-2">
              {pill(String(rule.action ?? 'allow'), actionTone(rule.action))}
              <span className="min-w-0 truncate font-mono text-[11px] text-fw-text-strong">{id}</span>
              {rule.enabled === false ? pill('disabled', 'muted') : null}
            </div>
            <div className="mt-1 font-mono text-[11px] leading-5 text-fw-text-muted">
              {selectors.length ? selectors.map(([key, value]) => <div key={key} className="break-words"><span className="text-fw-text">{key}</span> {flow(value)}</div>) : <div>every call</div>}
            </div>
            {rule.reason ? <div className="mt-0.5 text-xs text-fw-text-muted">{String(rule.reason)}</div> : null}
          </li>
        )
      })}
    </ol>
  )
}

/** Whether a stored Agent rule layer uses the `{ script, data? }` object form. */
export const isScriptRuleLayer = (rules: unknown): rules is { script: string; data?: unknown } =>
  !!rules && typeof rules === 'object' && !Array.isArray(rules)

const expandedRulesOf = (agent?: AgentRegistryEntry): unknown[] => {
  if (!agent) return []
  if (Array.isArray(agent.expandedRules)) return agent.expandedRules
  return Array.isArray(agent.rules) ? agent.rules : []
}

/** A layer whose last rule is a selector-free deny admits only what its earlier rules allow. */
export const isAllowlistLayer = (rules: unknown[]) => {
  if (!Array.isArray(rules)) return false
  const last = rules.at(-1) as Rule | undefined
  return !!last && last.action === 'deny' && last.enabled !== false && Object.keys(last).every(key => RULE_META.includes(key))
}

const layerPill = (rules: unknown[], allowlist = isAllowlistLayer(rules)) =>
  allowlist ? pill('Allowlist', 'warning') : rules.length ? pill(`${rules.length} rule${rules.length === 1 ? '' : 's'}`, 'neutral') : pill('No rules', 'muted')

/** Who may replace an Agent's layer: administrators, and Sessions of its strict creator ancestors. */
function whoMayChange(agents: Map<string, AgentRegistryEntry>, id: string) {
  const ancestors = (agents.get(id)?.creatorChain || [id]).slice(0, -1)
  return ancestors.length ? `Changed by administrators and sessions of ${joinNames(ancestors)}` : 'Changed by administrators'
}

type InstallationPolicy = { rules: unknown[]; defaultAction: string; scripted?: boolean; error?: string } | { loadError: string }

/** The global policy's rules, read-only, from Setup › Authorization's route. */
function useInstallationPolicy() {
  const [policy, setPolicy] = useState<InstallationPolicy | null>(null)
  useEffect(() => {
    let live = true
    void fetch(`${API_BASE_PATH}/setup/authorization`).then(async response => {
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `Couldn't load the rules (${response.status})`)
      if (payload.error) return { rules: [], defaultAction: 'deny', error: String(payload.error) }
      if (Array.isArray(payload.expandedRules)) {
        return {
          rules: payload.expandedRules,
          defaultAction: String(payload.defaultAction || 'allow'),
          scripted: payload.scripted === true,
        }
      }
      const document = payload.exists ? YAML.parse(String(payload.yaml || '')) || {} : {}
      return { rules: Array.isArray(document.rules) ? document.rules : [], defaultAction: String(document.defaultAction || 'allow') }
    }).then(next => { if (live) setPolicy(next) }).catch(cause => { if (live) setPolicy({ loadError: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { live = false }
  }, [])
  return policy
}

function ReadOnlyLayer({ name, title, kind, who, action, children }: { name: string; title: ReactNode; kind: ReactNode; who: string; action: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-lg border border-fw-border bg-fw-surface-sunken/60 px-3 py-2" data-rule-layer={name}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex min-w-0 items-start gap-1.5 text-left">
          {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fw-text-muted" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fw-text-muted" />}
          <span className="min-w-0"><span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-fw-text-strong">{title} {kind}</span><span className="mt-0.5 block text-[11px] text-fw-text-muted">{who}</span></span>
        </button>
        {action}
      </div>
      {open ? <div className="mt-2">{children}</div> : null}
    </li>
  )
}

function parseLayerYaml(text: string): unknown[] | { script: string; data?: unknown } {
  let parsed: unknown
  try { parsed = text.trim() ? YAML.parse(text) : [] } catch (cause) { throw new Error(`YAML: ${cause instanceof Error ? cause.message : String(cause)}`) }
  if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
    return parsed as unknown[] | { script: string; data?: unknown }
  }
  throw new Error('Rules must be a YAML list or a { script, data? } mapping.')
}

function looksScriptedAgentYaml(text: string): boolean {
  try {
    const parsed = YAML.parse(text)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return /^\s*script\s*:/m.test(text)
  }
}

function OwnLayerEditor({ agent, onSave }: { agent: AgentRegistryEntry; onSave: (rules: unknown[] | { script: string; data?: unknown }) => Promise<void> }) {
  const scripted = isScriptRuleLayer(agent.rules)
  const expanded = useMemo(() => expandedRulesOf(agent), [agent])
  const original = useMemo(() => {
    if (isScriptRuleLayer(agent.rules)) return YAML.stringify(agent.rules)
    return Array.isArray(agent.rules) && agent.rules.length ? YAML.stringify(agent.rules) : ''
  }, [agent.rules])
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(original)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<{ rules: unknown[]; error?: string } | null>(null)
  useEffect(() => { setText(original); setEditing(false); setError(''); setPreview(null) }, [agent.id, original])

  const editorHasScript = useMemo(() => scripted || looksScriptedAgentYaml(text), [scripted, text])

  const runPreview = async () => {
    setPreviewing(true); setError('')
    try {
      const parsed = parseLayerYaml(text)
      const response = await fetch(`${API_BASE_PATH}/agents/rules/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: parsed }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setPreview({ rules: [], error: data.error || `Preview failed (${response.status})` })
      } else {
        setPreview({ rules: Array.isArray(data.expandedRules) ? data.expandedRules : [] })
      }
    } catch (cause) {
      setPreview({ rules: [], error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setPreviewing(false)
    }
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const parsed = parseLayerYaml(text)
      await onSave(parsed)
      setPreview(null)
      setEditing(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  if (!editing) return (
    <>
      {agent.rulesError ? (
        <div role="alert" data-rule-error className="rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">
          These rules are invalid, so all tool calls of this agent are refused: {agent.rulesError}
        </div>
      ) : (
        <>
          {scripted ? <div className="mb-1.5 text-[11px] font-medium text-fw-text-muted" data-rule-expanded-label>Expanded rules</div> : null}
          <RuleList rules={expanded} emptyText={scripted ? 'No rules generated. This agent can do whatever the layers above allow.' : 'No rules. This agent can do whatever the layers above allow.'} />
        </>
      )}
      <div className="mt-2 flex justify-end"><button type="button" data-rule-edit onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-fw-border px-2.5 py-1.5 text-xs font-medium text-fw-text-strong hover:bg-fw-hover"><Pencil className="h-3.5 w-3.5" />Edit rules</button></div>
    </>
  )
  return (
    <div data-rule-editor>
      <div className="overflow-hidden rounded-lg border border-fw-accent-border"><SimpleCodeEditor value={text} onChange={setText} language="yaml" height={280} modelUri={agentRulesYamlModelUri(agent.id)} ariaLabel={`Rules of ${agent.id}`} /></div>
      {error ? <div className="mt-2 rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger" role="alert" data-rule-error>{error}</div> : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {editorHasScript ? (
          <button type="button" data-rule-preview disabled={previewing} onClick={() => { void runPreview() }} className="rounded-lg border border-fw-border px-3 py-1.5 text-xs font-medium text-fw-text-strong hover:bg-fw-hover disabled:opacity-40">
            {previewing ? 'Previewing…' : 'Preview rules'}
          </button>
        ) : null}
        <button type="button" data-rule-cancel onClick={() => { setText(original); setEditing(false); setError(''); setPreview(null) }} className="rounded-lg px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover">Cancel</button>
        <button type="button" data-rule-save disabled={saving || text === original} onClick={() => { void save() }} className="inline-flex items-center gap-1.5 rounded-lg bg-fw-accent px-3 py-1.5 text-xs font-medium text-fw-accent-text disabled:opacity-40"><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save rules'}</button>
      </div>
      {preview ? (
        <div className="mt-3 rounded-lg border border-fw-border bg-fw-surface-sunken/60 p-2.5" data-rule-expanded-preview>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fw-text-strong">
            <span>Expanded rules</span>
            {preview.error ? pill('Invalid', 'danger') : layerPill(preview.rules)}
          </div>
          {preview.error ? (
            <div role="alert" className="rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">{preview.error}</div>
          ) : (
            <RuleList rules={preview.rules} emptyText="No rules generated." />
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The layers every tool call of the Agent must pass, in evaluation order: the installation
 * policy, each creator ancestor's layer, then the Agent's own, which is the only one edited here.
 */
export function RuleLayers({ agent, agents, onSave, onShowAgent, onOpenSetupAuthorization }: {
  agent: AgentRegistryEntry
  agents: AgentRegistryEntry[]
  onSave: (rules: unknown[] | { script: string; data?: unknown }) => Promise<void>
  onShowAgent: (agentId: string) => void
  onOpenSetupAuthorization?: () => void
}) {
  const byId = useMemo(() => new Map(agents.map(item => [item.id, item])), [agents])
  const installation = useInstallationPolicy()
  const chain = agent.creatorChain || [agent.id]
  const openAgent = (id: string) => <button type="button" className={linkButton} onClick={() => onShowAgent(id)}>Open<ChevronRight className="h-3 w-3" /></button>
  const ownExpanded = expandedRulesOf(agent)
  return (
    <div data-rule-layers>
      <p className="mb-3 text-xs leading-5 text-fw-text-muted">A call must pass every layer. Each layer can only narrow what the layers above allow.</p>
      {agent.creatorChain === null ? <p role="alert" className="mb-3 rounded-lg bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">This agent's creators can't be determined, so all its tool calls are refused.</p> : null}
      <ol className="space-y-2">
        <ReadOnlyLayer name="installation" title={<><ShieldCheck className="h-3.5 w-3.5 text-fw-text-muted" />Installation rules</>}
          kind={!installation ? null : 'loadError' in installation ? pill('Unavailable', 'muted') : installation.error ? pill('Invalid', 'danger') : <>{installation.scripted ? pill('Script', 'neutral') : null}{layerPill(installation.rules, installation.defaultAction === 'deny')}</>}
          who="Changed by administrators in Setup"
          action={onOpenSetupAuthorization ? <button type="button" data-rule-installation-setup className={linkButton} onClick={onOpenSetupAuthorization}>Edit in Setup<ChevronRight className="h-3 w-3" /></button> : null}>
          {!installation ? <div className="text-xs text-fw-text-muted">Loading…</div>
            : 'loadError' in installation ? <div role="alert" className="text-xs text-fw-danger">{installation.loadError}</div>
            : installation.error ? <div role="alert" className="text-xs text-fw-danger">{installation.error}</div>
            : <>
              <RuleList rules={installation.rules} emptyText="No rules." />
              {installation.defaultAction !== 'allow' ? <div className="mt-1.5 text-xs text-fw-text-muted" data-rule-default-action>Calls that match no rule: {installation.defaultAction}</div> : null}
            </>}
        </ReadOnlyLayer>
        {chain.slice(0, -1).map(id => {
          const entry = byId.get(id)
          const rules = expandedRulesOf(entry)
          const scripted = isScriptRuleLayer(entry?.rules)
          return (
            <ReadOnlyLayer key={id} name={id} title={<>From {id}</>} kind={<>{scripted ? pill('Script', 'neutral') : null}{entry?.rulesError ? pill('Invalid', 'danger') : layerPill(rules)}</>} who={whoMayChange(byId, id)} action={openAgent(id)}>
              {entry?.rulesError ? <div role="alert" className="text-xs text-fw-danger">{entry.rulesError}</div> : <RuleList rules={rules} emptyText="No rules." />}
            </ReadOnlyLayer>
          )
        })}
        <li className="rounded-lg border border-fw-accent-border bg-fw-surface px-3 py-2.5" data-rule-layer="own">
          <div className="mb-2 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-fw-text-strong">
              {agent.id}
              {isScriptRuleLayer(agent.rules) ? pill('Script', 'neutral') : null}
              {agent.rulesError ? pill('Invalid', 'danger') : layerPill(ownExpanded)}
            </div>
            <div className="mt-0.5 text-[11px] text-fw-text-muted">{whoMayChange(byId, agent.id)}</div>
          </div>
          <OwnLayerEditor agent={agent} onSave={onSave} />
        </li>
      </ol>
    </div>
  )
}
