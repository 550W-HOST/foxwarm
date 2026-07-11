import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, MessageSquarePlus, Plus, X } from 'lucide-react'
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
          ? 'inline-flex items-center justify-center rounded-lg px-2 transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white transition'}
        title="Create agent or session"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <Plus className="h-4 w-4" />
        {compact && <ChevronDown className="ml-0.5 h-3 w-3" />}
      </button>

      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <button type="button" role="menuitem" onClick={() => openModal('agent')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700">
            <Bot className="h-4 w-4" /> New agent
          </button>
          <button type="button" role="menuitem" onClick={() => openModal('session')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700">
            <MessageSquarePlus className="h-4 w-4" /> New session
          </button>
        </div>
      )}

      {mode && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !loading) setMode(null)
        }}>
          <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="creation-dialog-title" className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="creation-dialog-title" className="text-lg font-semibold text-gray-900 dark:text-white">{mode === 'agent' ? 'New agent' : 'New session'}</h2>
              <button type="button" onClick={() => setMode(null)} disabled={loading} className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {mode === 'agent' ? (
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Agent ID
                  <input ref={element => { firstInputRef.current = element }} value={agentId} onChange={event => setAgentId(event.target.value)} autoComplete="off" placeholder="my-agent" className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
                  <span className="mt-1 block text-xs font-normal text-gray-500 dark:text-gray-400">Letters, numbers, hyphens, and underscores.</span>
                </label>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Inherit agent
                  <select value={inheritAgent} onChange={event => setInheritAgent(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white">
                    <option value="">None</option>
                    {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.id === agentId.trim()}>{agent.id}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Agent
                  <select ref={element => { firstInputRef.current = element }} value={sessionAgent} onChange={event => setSessionAgent(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white">
                    {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Session ID <span className="font-normal text-gray-500">(optional)</span>
                  <input value={sessionId} onChange={event => setSessionId(event.target.value)} autoComplete="off" placeholder={RANDOM_SESSION_ID_PLACEHOLDER} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
                </label>
              </div>
            )}

            {error && <div role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setMode(null)} disabled={loading} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
              <button type="submit" disabled={loading || (mode === 'session' && agents.length === 0)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
