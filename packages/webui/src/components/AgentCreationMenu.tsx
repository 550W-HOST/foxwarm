import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { RANDOM_SESSION_ID_PLACEHOLDER, validateAgentId, validateSessionId, type AgentSummary } from '../agentCreation'

type CreationMode = 'agent' | 'session'

interface AgentCreationMenuProps {
  agents: AgentSummary[]
  currentAgent?: string
  compact?: boolean
  onCreateAgent: (agentId: string, inheritAgent?: string) => Promise<void>
  onCreateSession: (agentId: string, sessionId?: string) => Promise<void>
}

export default function AgentCreationMenu({
  agents,
  currentAgent,
  compact = false,
  onCreateAgent,
  onCreateSession,
}: AgentCreationMenuProps) {
  const [mode, setMode] = useState<CreationMode | null>(null)
  const [agentId, setAgentId] = useState('')
  const [inheritAgent, setInheritAgent] = useState('')
  const [sessionAgent, setSessionAgent] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
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

  useEffect(() => {
    if (mode !== 'session') return
    if (agents.some(agent => agent.id === sessionAgent)) return
    setSessionAgent(defaultAgent)
  }, [agents, defaultAgent, mode, sessionAgent])

  const openSessionModal = () => {
    setMode('session')
    setSessionAgent(defaultAgent)
    setSessionId('')
    setError('')
  }

  const openAgentModal = () => {
    setMode('agent')
    setAgentId('')
    setInheritAgent('')
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
      if (inheritAgent && inheritAgent === agentId.trim()) {
        return setError('Agent cannot inherit from itself.')
      }
    } else if (mode === 'session') {
      if (!sessionAgent) return setError('Choose an agent.')
      const validationError = validateSessionId(sessionId)
      if (validationError) return setError(validationError)
    } else {
      return
    }

    setLoading(true)
    try {
      if (mode === 'agent') {
        await onCreateAgent(agentId.trim(), inheritAgent || undefined)
      } else {
        await onCreateSession(sessionAgent, sessionId.trim() || undefined)
      }
      setMode(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={openSessionModal}
        className={compact
          ? 'inline-flex items-center justify-center rounded-lg px-2 transition-colors bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition'}
        title="New session"
        aria-label="New session"
        aria-haspopup="dialog"
      >
        <Plus className="h-4 w-4" />
      </button>

      {mode && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-fw-overlay/40 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog()
        }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="creation-dialog-title" className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-md overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-5 shadow-xl dark:border-fw-border dark:bg-fw-surface">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="creation-dialog-title" className="text-lg font-semibold text-fw-text-strong">{mode === 'agent' ? 'New agent' : 'New session'}</h2>
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
                <label className="block text-sm font-medium text-fw-text-strong">
                  Inherit agent
                  <select value={inheritAgent} onChange={event => setInheritAgent(event.target.value)} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong">
                    <option value="">None</option>
                    {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.id === agentId.trim()}>{agent.id}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className="space-y-4">
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
                </fieldset>
                <label className="block text-sm font-medium text-fw-text-strong">
                  Session ID <span className="font-normal text-fw-text-muted">(optional)</span>
                  <input ref={sessionIdInputRef} value={sessionId} onChange={event => setSessionId(event.target.value)} autoComplete="off" placeholder={RANDOM_SESSION_ID_PLACEHOLDER} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong" />
                </label>
              </div>
            )}

            {error && <div role="alert" className="mt-4 rounded-lg bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger dark:bg-fw-danger-surface-strong/40 dark:text-fw-danger">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeDialog} disabled={loading} className="rounded-lg px-3 py-2 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50 dark:text-fw-text dark:hover:bg-fw-hover">Cancel</button>
              <button type="submit" disabled={loading || (mode === 'session' && agents.length === 0)} className="rounded-lg bg-fw-accent px-4 py-2 text-sm font-medium text-fw-text-inverse hover:bg-fw-accent disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
