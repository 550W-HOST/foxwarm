import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'
import { makeApiUrl } from '../config'
import { RANDOM_SESSION_ID_PLACEHOLDER, agentStartLocation, validateAgentId, validateSessionId, type AgentSettingsChanges, type AgentSummary } from '../agentCreation'
import { parseAgentDefaultNode, parseWebUiNodeTargets, type WebUiNodeTarget } from '../nodeTargets'
import AgentSettingsFields, { EMPTY_AGENT_SETTINGS, agentSettingsChanges, nodeDisplayName, type AgentSettingsDraft } from './AgentSettingsFields'

type CreationMode = 'agent' | 'session'
/** Opens the New session dialog for a child of an existing Session. */
/** Presets for the New session dialog: an Agent, and optionally the parent of a child Session. */
export interface SessionCreationRequest {
  agent?: string
  parent?: { sessionId: string; label: string }
}

interface AgentCreationMenuProps {
  agents: AgentSummary[]
  currentAgent?: string
  compact?: boolean
  triggerLabel?: string
  triggerClassName?: string
  onCreateAgent: (agentId: string, settings: AgentSettingsChanges) => Promise<void>
  onCreateSession: (agentId: string, sessionId?: string, runtime?: 'foxwarm' | 'claude-code', parentSessionId?: string) => Promise<void>
  creationRequest?: SessionCreationRequest | null
  onCreationRequestHandled?: () => void
  /**
   * With only the `main` Agent and no alternative runtime, the trigger creates a Session
   * directly and a separate options control opens the full dialog.
   */
  directCreate?: boolean
  optionsTriggerClassName?: string
}

export default function AgentCreationMenu({
  agents,
  currentAgent,
  compact = false,
  triggerLabel,
  triggerClassName,
  onCreateAgent,
  onCreateSession,
  creationRequest,
  onCreationRequestHandled,
  directCreate = false,
  optionsTriggerClassName,
}: AgentCreationMenuProps) {
  const [mode, setMode] = useState<CreationMode | null>(null)
  const [agentId, setAgentId] = useState('')
  const [agentSettings, setAgentSettings] = useState<AgentSettingsDraft>(EMPTY_AGENT_SETTINGS)
  const [nodes, setNodes] = useState<WebUiNodeTarget[]>(() => parseWebUiNodeTargets({ nodes: [] }))
  const [installDefaultNode, setInstallDefaultNode] = useState<string | null>(null)
  const [sessionAgent, setSessionAgent] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [runtime, setRuntime] = useState<'foxwarm' | 'claude-code'>('foxwarm')
  const [claudeAvailable, setClaudeAvailable] = useState(false)
  const [parent, setParent] = useState<SessionCreationRequest['parent'] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Unknown until checked; the dialog stays the default while an alternative runtime may exist.
  const [alternativeRuntime, setAlternativeRuntime] = useState<boolean | null>(null)
  const [creatingDirectly, setCreatingDirectly] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const agentIdInputRef = useRef<HTMLInputElement>(null)
  const sessionIdInputRef = useRef<HTMLInputElement>(null)
  const newAgentButtonRef = useRef<HTMLButtonElement>(null)

  const defaultAgent = agents.some(agent => agent.id === currentAgent)
    ? currentAgent!
    : agents[0]?.id || ''

  useEffect(() => {
    if (!mode) return
    const timer = window.setTimeout(() => {
      if (mode === 'agent') agentIdInputRef.current?.focus()
      else if (agents.length > 0) sessionIdInputRef.current?.focus()
      else newAgentButtonRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [mode])

  useEffect(() => {
    if (!mode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || loading) return
      if (mode === 'agent') {
        setMode('session')
        setError('')
      } else {
        setMode(null)
        window.setTimeout(() => triggerRef.current?.focus(), 0)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mode, loading])

  // Node names for the start location and the agent settings; read once per opening.
  const open = mode !== null
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void fetch(makeApiUrl('/nodes'), { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!payload || controller.signal.aborted) return
        setNodes(parseWebUiNodeTargets(payload))
        setInstallDefaultNode(parseAgentDefaultNode(payload))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [open])

  useEffect(() => {
    if (mode !== 'session') return
    if (agents.some(agent => agent.id === sessionAgent)) return
    setSessionAgent(defaultAgent)
  }, [agents, defaultAgent, mode, sessionAgent])

  useEffect(() => {
    if (mode !== 'session') return
    const controller = new AbortController()
    // Claude Code stays unavailable until this opening's check confirms it.
    setClaudeAvailable(false)
    void fetch(makeApiUrl('/setup/status'), { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!controller.signal.aborted) setClaudeAvailable(payload?.capabilities?.claudeCode?.available === true)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [mode])

  useEffect(() => {
    if (!directCreate) return
    const controller = new AbortController()
    void fetch(makeApiUrl('/setup/status'), { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (payload && !controller.signal.aborted) setAlternativeRuntime(payload.capabilities?.claudeCode?.available === true)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [directCreate])

  const direct = directCreate && alternativeRuntime === false && agents.length === 1 && agents[0].id === 'main'

  const createDirectly = async () => {
    if (creatingDirectly) return
    setCreatingDirectly(true)
    try {
      await onCreateSession('main')
    } catch (cause) {
      // Show the failure where the user can adjust the request and retry.
      openSessionModal()
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreatingDirectly(false)
    }
  }

  const openSessionModal = (request: SessionCreationRequest | null = null) => {
    setMode('session')
    setParent(request?.parent || null)
    setSessionAgent(request?.agent && agents.some(agent => agent.id === request.agent) ? request.agent : defaultAgent)
    setSessionId('')
    setRuntime('foxwarm')
    setClaudeAvailable(false)
    setError('')
  }

  useEffect(() => {
    if (!creationRequest) return
    openSessionModal(creationRequest)
    onCreationRequestHandled?.()
  }, [creationRequest])

  const openAgentModal = () => {
    setMode('agent')
    setClaudeAvailable(false)
    setAgentId('')
    setAgentSettings(EMPTY_AGENT_SETTINGS)
    setError('')
  }

  const closeDialog = () => {
    if (loading) return
    setError('')
    if (mode === 'agent') {
      setMode('session')
      return
    }
    setMode(null)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (mode === 'agent') {
      const validationError = validateAgentId(agentId)
      if (validationError) return setError(validationError)
      if (agentSettings.inheritAgent && agentSettings.inheritAgent === agentId.trim()) {
        return setError('Agent cannot inherit from itself.')
      }
    } else if (mode === 'session') {
      if (!sessionAgent) return setError('Choose an agent.')
      if (runtime === 'claude-code' && !claudeAvailable) {
        return setError('Claude Code is unavailable.')
      }
      const validationError = validateSessionId(sessionId)
      if (validationError) return setError(validationError)
    } else {
      return
    }

    setLoading(true)
    try {
      if (mode === 'agent') {
        await onCreateAgent(agentId.trim(), agentSettingsChanges(agentSettings))
      } else {
        await onCreateSession(sessionAgent, sessionId.trim() || undefined, runtime, parent?.sessionId)
      }
      setMode(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const startLocation = mode === 'session' ? agentStartLocation(agents.find(agent => agent.id === sessionAgent), installDefaultNode) : null

  return (
    <div className="relative flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (direct) void createDirectly(); else openSessionModal() }}
        disabled={creatingDirectly}
        className={`${triggerClassName ?? (compact
          ? 'inline-flex items-center justify-center rounded-lg border border-fw-border-strong px-2 transition-colors bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition')}${direct ? ' rounded-r-none' : ''}`}
        title="New session"
        aria-label="New session"
        aria-haspopup={direct ? undefined : 'dialog'}
        data-new-session-direct={direct || undefined}
      >
        <Plus className="h-4 w-4" />
        {triggerLabel && <span>{triggerLabel}</span>}
      </button>
      {direct && (
        <button
          type="button"
          onClick={() => openSessionModal()}
          className={`${optionsTriggerClassName ?? 'inline-flex h-8 w-5 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong transition'} rounded-l-none`}
          title="New session options"
          aria-label="New session options"
          aria-haspopup="dialog"
          aria-expanded={mode !== null}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}

      {mode && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-fw-overlay/40 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog()
        }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="creation-dialog-title" className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-md overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-5 shadow-xl dark:border-fw-border dark:bg-fw-surface">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="creation-dialog-title" className="text-lg font-semibold text-fw-text-strong">{mode === 'agent' ? 'New agent' : parent ? 'New child session' : 'New session'}</h2>
              <button type="button" onClick={closeDialog} disabled={loading} className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover disabled:opacity-50 dark:text-fw-text-muted dark:hover:bg-fw-hover" aria-label={mode === 'agent' ? 'Back to new session' : 'Close'}>
                <X className="h-5 w-5" />
              </button>
            </div>

            {mode === 'agent' ? (
              <div className="space-y-4">
                <label className="block text-sm font-medium text-fw-text-strong">
                  Agent ID
                  <input ref={agentIdInputRef} value={agentId} onChange={event => setAgentId(event.target.value)} autoComplete="off" placeholder="my-agent" className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong" />
                  <span className="mt-1 block text-xs font-normal text-fw-text-muted">Letters, numbers, hyphens, and underscores.</span>
                </label>
                <AgentSettingsFields value={agentSettings} onChange={setAgentSettings} agentId={agentId} agents={agents} nodes={nodes} installDefaultNode={installDefaultNode} disabled={loading} isolationCollapsed />
              </div>
            ) : (
              <div className="space-y-4">
                {parent && (
                  <p className="min-w-0 truncate text-sm text-fw-text-muted" data-creation-parent={parent.sessionId} title={parent.sessionId}>
                    Parent: <span className="font-medium text-fw-text-strong">{parent.label}</span>
                  </p>
                )}
                <fieldset disabled={loading} className="min-w-0">
                  <legend className="text-sm font-medium text-fw-text-strong">Agent</legend>
                  <div className="mt-2 flex min-w-0 flex-wrap gap-2" aria-label="Choose an agent">
                    {agents.map(agent => {
                      const selected = agent.id === sessionAgent
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          aria-pressed={selected}
                          title={agent.id}
                          onClick={() => {
                            setSessionAgent(agent.id)
                            setError('')
                          }}
                          className={`inline-flex min-w-0 max-w-full items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-fw-focus-ring/30 ${selected
                            ? 'border-fw-accent-border bg-fw-accent-surface text-fw-accent dark:border-fw-accent-border/70 dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent'
                            : 'border-fw-border-strong bg-fw-surface-sunken text-fw-text hover:border-fw-accent-border hover:bg-fw-hover hover:text-fw-text-strong dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text dark:hover:border-fw-accent-border/70 dark:hover:bg-fw-hover dark:hover:text-fw-text-strong'}`}
                        >
                          <span className="min-w-0 max-w-full truncate">{agent.id}</span>
                        </button>
                      )
                    })}
                    <button
                      ref={newAgentButtonRef}
                      type="button"
                      onClick={openAgentModal}
                      aria-label="New agent"
                      title="New agent"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-fw-border-strong bg-fw-surface-sunken text-fw-text-muted transition-colors hover:border-fw-accent-border hover:bg-fw-hover hover:text-fw-accent focus:outline-none focus:ring-2 focus:ring-fw-focus-ring/30 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-muted dark:hover:border-fw-accent-border/70 dark:hover:bg-fw-hover dark:hover:text-fw-accent"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  {agents.length === 0 && <p className="mt-2 text-xs text-fw-text-muted">No agents yet. Create one to start a session.</p>}
                  {startLocation && (
                    <p data-creation-start-location className="mt-2 min-w-0 truncate text-xs text-fw-text-muted" title={startLocation.cwd || undefined}>
                      Starts on {nodeDisplayName(nodes, startLocation.node)}
                      {startLocation.cwd && <> · <span className="font-mono">{startLocation.cwd}</span></>}
                    </p>
                  )}
                </fieldset>
                <label className="block text-sm font-medium text-fw-text-strong">
                  Session ID <span className="font-normal text-fw-text-muted">(optional)</span>
                  <input ref={sessionIdInputRef} value={sessionId} onChange={event => setSessionId(event.target.value)} autoComplete="off" placeholder={RANDOM_SESSION_ID_PLACEHOLDER} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong" />
                </label>
                <label className="block text-sm font-medium text-fw-text-strong">
                  Runtime
                  <select aria-label="Session runtime" value={runtime} onChange={event => setRuntime(event.target.value as 'foxwarm' | 'claude-code')} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2">
                    <option value="foxwarm">Foxwarm</option>
                    <option value="claude-code" disabled={!claudeAvailable}>Claude Code{claudeAvailable ? '' : ' — unavailable'}</option>
                  </select>
                </label>
              </div>
            )}

            {error && <div role="alert" className="mt-4 rounded-lg bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger dark:bg-fw-danger-surface-strong/40 dark:text-fw-danger">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeDialog} disabled={loading} className="rounded-lg px-3 py-2 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50 dark:text-fw-text dark:hover:bg-fw-hover">Cancel</button>
              <button type="submit" disabled={loading || (mode === 'session' && (agents.length === 0 || (runtime === 'claude-code' && !claudeAvailable)))} className="rounded-lg bg-fw-accent px-4 py-2 text-sm font-medium text-fw-accent-text hover:bg-fw-accent disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>, document.body,
      )}
    </div>
  )
}
