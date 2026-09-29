import { useCallback, useEffect, useState } from 'react'
import Chat from './components/Chat'
import { API_BASE_PATH } from './config'
import { useChatPreferences } from './chatPreferences'
import { useTheme } from './theme/useTheme'

type SessionItem = { id: string; agent: string; parentSessionId?: string | null; displayName?: string | null }

/** Experiment-only shell: the actual Chat, composer, timeline and realtime client remain shared. */
export default function ExperimentChatApp() {
  useTheme()
  const preferences = useChatPreferences()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [agents, setAgents] = useState<string[]>(['main'])
  const [selectedAgent, setSelectedAgent] = useState('main')
  const [selected, setSelected] = useState<string | null>(null)
  const [newAgent, setNewAgent] = useState('')
  const [newMemory, setNewMemory] = useState('')
  const [childSuffix, setChildSuffix] = useState('')
  const [childAgent, setChildAgent] = useState('')
  const [childMessage, setChildMessage] = useState('')
  const [loginRequired, setLoginRequired] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [response, agentResponse] = await Promise.all([
      fetch(`${API_BASE_PATH}/sessions`), fetch(`${API_BASE_PATH}/agents`),
    ])
    if (response.status === 401 || agentResponse.status === 401) { setLoginRequired(true); return }
    if (!response.ok || !agentResponse.ok) throw new Error('Could not load Agents and Sessions')
    const data = await response.json()
    const agentData = await agentResponse.json()
    const currentSessions: SessionItem[] = (Array.isArray(data?.sessions) ? data.sessions : [])
      .filter((item: SessionItem) => typeof item?.id === 'string' && typeof item?.agent === 'string')
    const currentAgents: string[] = (Array.isArray(agentData?.agents) ? agentData.agents : [])
      .filter((name: unknown): name is string => typeof name === 'string')
    setSessions(currentSessions)
    setAgents(currentAgents)
    const requested = new URLSearchParams(window.location.search).get('sessionId')
    setSelected(current => current && currentSessions.some(session => session.id === current) ? current
      : requested && currentSessions.some(session => session.id === requested) ? requested : currentSessions[0]?.id || null)
    setSelectedAgent(current => currentAgents.includes(current) ? current : currentAgents[0] || 'main')
    setLoginRequired(false)
  }, [])

  useEffect(() => { void refresh().catch(e => setError(String(e))) }, [refresh])
  useEffect(() => {
    const owner = sessions.find(session => session.id === selected)
    if (owner) setSelectedAgent(owner.agent)
  }, [sessions, selected])
  const select = (id: string) => {
    setSelected(id)
    const owner = sessions.find(session => session.id === id)
    if (owner) setSelectedAgent(owner.agent)
    const url = new URL(window.location.href)
    url.searchParams.set('sessionId', id)
    window.history.replaceState(null, '', url)
  }
  const post = async (path: string, body?: object) => {
    const response = await fetch(`${API_BASE_PATH}${path}`, {
      method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
    return data
  }
  const perform = async (action: () => Promise<void>) => {
    setError(null)
    try { await action() } catch (e) { setError(String(e)) }
  }
  const createSession = () => perform(async () => {
    const name = `session_${Date.now().toString(36)}`
    const data = selectedAgent === 'main' ? await post('/sessions')
      : await post('/sessions', { agentName: selectedAgent, sessionName: name })
    await refresh()
    select(data.sessionId)
  })
  const createAgent = (event: React.FormEvent) => {
    event.preventDefault()
    void perform(async () => {
      const data = await post('/agents', { agentName: newAgent, memory: newMemory })
      setNewAgent(''); setNewMemory('')
      await refresh()
      if (data.mainSessionId) select(data.mainSessionId)
    })
  }
  const createChild = (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected) return
    void perform(async () => {
      const data = await post(`/sessions/${encodeURIComponent(selected)}/children`, {
        suffix: childSuffix, ...(childAgent ? { agentName: childAgent } : {}),
        ...(childMessage ? { message: childMessage } : {}),
      })
      setChildSuffix(''); setChildMessage('')
      await refresh()
      select(data.sessionId)
    })
  }
  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const response = await fetch(`${API_BASE_PATH}/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      setToken('')
      if (!response.ok) throw new Error('Invalid local access token')
      await refresh()
    } catch (e) { setToken(''); setError(String(e)) }
  }
  const selectedSession = sessions.find(session => session.id === selected)
  const children = sessions.filter(session => session.parentSessionId === selected)

  return <div className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col bg-fw-canvas text-fw-text dark:bg-fw-canvas">
    {loginRequired ? <form onSubmit={login} className="m-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-fw-border bg-fw-surface p-6">
      <h1 className="text-lg font-semibold">Experimental Chat</h1>
      <label htmlFor="experiment-token">Local access token</label>
      <input id="experiment-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} className="rounded border border-fw-border bg-fw-surface px-3 py-2" />
      <button type="submit" className="rounded bg-fw-accent px-3 py-2 text-fw-text-inverse">Connect</button>
      {error && <p role="alert" className="text-fw-danger">{error}</p>}
    </form> : <>
      <header className="flex flex-wrap items-center gap-2 border-b border-fw-border px-3 py-2">
        <span className="font-medium">Experimental Chat</span>
        <select aria-label="Agent" value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)} className="rounded border border-fw-border bg-fw-surface px-2 py-1">
          {agents.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <select aria-label="Session" value={selected || ''} onChange={e => select(e.target.value)} className="min-w-0 rounded border border-fw-border bg-fw-surface px-2 py-1">
          {!selected && <option value="">Choose a session</option>}
          {agents.map(name => <optgroup label={name} key={name}>
            {sessions.filter(session => session.agent === name).map(session =>
              <option key={session.id} value={session.id}>{session.displayName || session.id}</option>)}
          </optgroup>)}
        </select>
        <button type="button" onClick={() => void createSession()} className="rounded border border-fw-border px-2 py-1">New session</button>
        <button type="button" onClick={() => void refresh().catch(e => setError(String(e)))} className="rounded border border-fw-border px-2 py-1">Refresh list</button>
        {selected && <button type="button" onClick={() => void perform(async () => { await post(`/sessions/${encodeURIComponent(selected)}/refresh-memory`) })}
          className="rounded border border-fw-border px-2 py-1">Refresh memory</button>}
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b border-fw-border px-3 py-1 text-sm">
        <form className="flex items-center gap-1" onSubmit={createAgent}>
          <input aria-label="New agent name" required value={newAgent} onChange={e => setNewAgent(e.target.value)} placeholder="Agent name" className="w-28 rounded border border-fw-border bg-fw-surface px-2 py-1" />
          <input aria-label="Agent memory" value={newMemory} onChange={e => setNewMemory(e.target.value)} placeholder="MEMORY.md (optional)" className="w-44 rounded border border-fw-border bg-fw-surface px-2 py-1" />
          <button className="rounded border border-fw-border px-2 py-1">Create agent</button>
        </form>
        {selected && <form className="flex items-center gap-1" onSubmit={createChild}>
          <input aria-label="Child suffix" required value={childSuffix} onChange={e => setChildSuffix(e.target.value)} placeholder="Child suffix" className="w-28 rounded border border-fw-border bg-fw-surface px-2 py-1" />
          <select aria-label="Child agent" value={childAgent} onChange={e => setChildAgent(e.target.value)} className="rounded border border-fw-border bg-fw-surface px-2 py-1">
            <option value="">Same agent</option>
            {agents.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <input aria-label="Child message" value={childMessage} onChange={e => setChildMessage(e.target.value)} placeholder="Initial message (optional)" className="w-44 rounded border border-fw-border bg-fw-surface px-2 py-1" />
          <button className="rounded border border-fw-border px-2 py-1">Create child</button>
        </form>}
        {selectedSession?.parentSessionId && <button onClick={() => select(selectedSession.parentSessionId!)} className="rounded border border-fw-border px-2 py-1">Parent: {selectedSession.parentSessionId}</button>}
        {children.map(child => <button key={child.id} onClick={() => select(child.id)} className="rounded border border-fw-border px-2 py-1">Child: {child.displayName || child.id}</button>)}
      </div>
      {error && <p role="alert" className="px-3 text-fw-danger">{error}</p>}
      <div className="min-h-0 flex-1">
        {selected ? <Chat key={selected} sessionId={selected} canonicalSessionId={selected} sessionDisplayName={selectedSession?.displayName || selected}
          experimentalTextOnly
          sendKeyMode={preferences.sendKeyMode} groupTools={preferences.groupTools}
          showUsageBadge={preferences.showUsageBadge} showUserMessageMetadata={preferences.showUserMessageMetadata}
          onSendKeyModeChange={preferences.setSendKeyMode} onGroupToolsChange={preferences.setGroupTools}
          onShowUsageBadgeChange={preferences.setShowUsageBadge}
          onShowUserMessageMetadataChange={preferences.setShowUserMessageMetadata} />
          : <div className="p-6 text-fw-text-muted">Create a session to begin.</div>}
      </div>
    </>}
  </div>
}
