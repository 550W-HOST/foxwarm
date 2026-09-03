import { useEffect, useRef, useState } from 'react'
import { Bot, MessageSquarePlus, Plus, X } from 'lucide-react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<CreationMode | null>(null)
  const [agentId, setAgentId] = useState('')
  const [inheritAgent, setInheritAgent] = useState('')
  const [sessionAgent, setSessionAgent] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLElement | null>(null)

  const defaultAgent = agents.some(agent => agent.id === currentAgent)
    ? currentAgent!
    : agents[0]?.id || 'main'

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  useEffect(() => {
    if (!mode) return
    const timer = window.setTimeout(() => firstInputRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) setMode(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mode, loading])

  const openModal = (nextMode: CreationMode) => {
    setMenuOpen(false)
    setMode(nextMode)
    setError('')
    if (nextMode === 'agent') {
      setAgentId('')
      setInheritAgent('')
    } else {
      setSessionAgent(defaultAgent)
      setSessionId('')
    }
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
    <div ref={rootRef} className="relative flex">
      <button
        type="button"
        onClick={() => setMenuOpen(open => !open)}
        className={compact
          ? 'inline-flex items-center justify-center rounded-lg px-2 transition-colors bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition'}
        title="Create agent or session"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <Plus className="h-4 w-4" />
      </button>

      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-fw-border bg-fw-surface p-1 shadow-lg dark:border-fw-border dark:bg-fw-surface">
          <button type="button" role="menuitem" onClick={() => openModal('agent')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-fw-text hover:bg-fw-hover dark:text-fw-text-strong dark:hover:bg-fw-hover">
            <Bot className="h-4 w-4" /> New agent
          </button>
          <button type="button" role="menuitem" onClick={() => openModal('session')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-fw-text hover:bg-fw-hover dark:text-fw-text-strong dark:hover:bg-fw-hover">
            <MessageSquarePlus className="h-4 w-4" /> New session
          </button>
        </div>
      )}

      {mode && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-fw-overlay/40 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !loading) setMode(null)
        }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="creation-dialog-title" className="w-full max-w-md rounded-xl border border-fw-border bg-fw-surface p-5 shadow-xl dark:border-fw-border dark:bg-fw-surface">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="creation-dialog-title" className="text-lg font-semibold text-fw-text-strong">{mode === 'agent' ? 'New agent' : 'New session'}</h2>
              <button type="button" onClick={() => setMode(null)} disabled={loading} className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover disabled:opacity-50 dark:text-fw-text-muted dark:hover:bg-fw-hover" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {mode === 'agent' ? (
              <div className="space-y-4">
                <label className="block text-sm font-medium text-fw-text-strong">
                  Agent ID
                  <input ref={element => { firstInputRef.current = element }} value={agentId} onChange={event => setAgentId(event.target.value)} autoComplete="off" placeholder="my-agent" className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong" />
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
                <label className="block text-sm font-medium text-fw-text-strong">
                  Agent
                  <select ref={element => { firstInputRef.current = element }} value={sessionAgent} onChange={event => setSessionAgent(event.target.value)} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong">
                    {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium text-fw-text-strong">
                  Session ID <span className="font-normal text-fw-text-muted">(optional)</span>
                  <input value={sessionId} onChange={event => setSessionId(event.target.value)} autoComplete="off" placeholder={RANDOM_SESSION_ID_PLACEHOLDER} className="mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong" />
                </label>
              </div>
            )}

            {error && <div role="alert" className="mt-4 rounded-lg bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger dark:bg-fw-danger-surface-strong/40 dark:text-fw-danger">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setMode(null)} disabled={loading} className="rounded-lg px-3 py-2 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50 dark:text-fw-text dark:hover:bg-fw-hover">Cancel</button>
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
