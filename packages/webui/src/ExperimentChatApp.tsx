import { useCallback, useEffect, useState } from 'react'
import Chat from './components/Chat'
import { API_BASE_PATH } from './config'
import { useChatPreferences } from './chatPreferences'
import { useTheme } from './theme/useTheme'

type SessionItem = { id: string }

/** Experiment-only shell: the actual Chat, composer, timeline and realtime client remain shared. */
export default function ExperimentChatApp() {
  useTheme()
  const preferences = useChatPreferences()
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loginRequired, setLoginRequired] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const response = await fetch(`${API_BASE_PATH}/sessions`)
    if (response.status === 401) { setLoginRequired(true); return }
    if (!response.ok) throw new Error(`Could not load sessions (${response.status})`)
    const data = await response.json()
    const ids = (Array.isArray(data?.sessions) ? data.sessions : [])
      .map((item: SessionItem) => item?.id).filter((id: unknown): id is string => typeof id === 'string')
    setSessionIds(ids)
    const requested = new URLSearchParams(window.location.search).get('sessionId')
    setSelected(current => current && ids.includes(current) ? current : requested && ids.includes(requested) ? requested : ids[0] || null)
    setLoginRequired(false)
  }, [])

  useEffect(() => { void refresh().catch(e => setError(String(e))) }, [refresh])
  const select = (id: string) => {
    setSelected(id)
    const url = new URL(window.location.href)
    url.searchParams.set('sessionId', id)
    window.history.replaceState(null, '', url)
  }
  const create = async () => {
    setError(null)
    try {
      const response = await fetch(`${API_BASE_PATH}/sessions`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Session creation failed')
      await refresh()
      select(data.sessionId)
    } catch (e) { setError(String(e)) }
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

  return <div className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col bg-fw-canvas text-fw-text dark:bg-fw-canvas">
    {loginRequired ? <form onSubmit={login} className="m-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-fw-border bg-fw-surface p-6">
      <h1 className="text-lg font-semibold">Experimental Chat</h1>
      <label htmlFor="experiment-token">Local access token</label>
      <input id="experiment-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} className="rounded border border-fw-border bg-fw-surface px-3 py-2" />
      <button type="submit" className="rounded bg-fw-accent px-3 py-2 text-fw-text-inverse">Connect</button>
      {error && <p role="alert" className="text-fw-danger">{error}</p>}
    </form> : <>
      <header className="flex items-center gap-2 border-b border-fw-border px-3 py-2">
        <span className="font-medium">Experimental Chat</span>
        <select aria-label="Session" value={selected || ''} onChange={e => select(e.target.value)} className="min-w-0 rounded border border-fw-border bg-fw-surface px-2 py-1">
          {!selected && <option value="">Choose a session</option>}
          {sessionIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <button type="button" onClick={() => void create()} className="rounded border border-fw-border px-2 py-1">New session</button>
      </header>
      {error && <p role="alert" className="px-3 text-fw-danger">{error}</p>}
      <div className="min-h-0 flex-1">
        {selected ? <Chat key={selected} sessionId={selected} canonicalSessionId={selected} sessionDisplayName={selected}
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
