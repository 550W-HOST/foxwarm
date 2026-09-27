import { useEffect, useState } from 'react'
import Chat from './components/Chat'
import { GuestImageSessionContext } from './components/ImageParts'
import { API_BASE_PATH } from './config'
import { useChatPreferences } from './chatPreferences'
import { useTheme } from './theme/useTheme'

type GuestAuth = { role: 'guest'; tokenId: string; sessionIds: string[] }
type GuestSession = { id: string; displayName?: string | null }

/** A guest mounts only the bound chat surface, never an administrator workbench leaf. */
export default function GuestWebUiApp({ auth }: { auth: GuestAuth }) {
  useTheme()
  const preferences = useChatPreferences()
  const [sessions, setSessions] = useState<GuestSession[]>([])
  const [selectedId, setSelectedId] = useState(() => auth.sessionIds[0] || '')
  const allowedIds = auth.sessionIds.join('\0')

  useEffect(() => {
    let active = true
    fetch(`${API_BASE_PATH}/sessions`).then(async response => {
      if (!response.ok) throw new Error(`Failed to load sessions (${response.status})`)
      return response.json()
    }).then(data => {
      if (active) setSessions(Array.isArray(data.sessions) ? data.sessions.filter((entry: GuestSession) => auth.sessionIds.includes(entry.id)) : [])
    }).catch(() => {
      if (active) setSessions([])
    })
    return () => { active = false }
  }, [allowedIds])

  const sessionId = auth.sessionIds.includes(selectedId) ? selectedId : auth.sessionIds[0]
  const current = sessions.find(session => session.id === sessionId)
  return (
    <div data-webui-role="guest" className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col overflow-hidden bg-fw-canvas">
      {auth.sessionIds.length > 1 && (
        <label className="flex shrink-0 items-center gap-3 border-b border-fw-border px-4 py-2 text-sm text-fw-text">
          <span>Session</span>
          <select aria-label="Guest session" value={sessionId} onChange={event => setSelectedId(event.currentTarget.value)} className="min-w-0 flex-1 rounded border border-fw-border bg-fw-surface px-2 py-1 text-fw-text">
            {auth.sessionIds.map(id => <option key={id} value={id}>{sessions.find(session => session.id === id)?.displayName || id}</option>)}
          </select>
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {sessionId
          ? <GuestImageSessionContext.Provider value={sessionId}><Chat key={sessionId} sessionId={sessionId} canonicalSessionId={sessionId} sessionDisplayName={current?.displayName || undefined} guestMode sendKeyMode={preferences.sendKeyMode} groupTools={preferences.groupTools} showUsageBadge={preferences.showUsageBadge} showUserMessageMetadata={preferences.showUserMessageMetadata} /></GuestImageSessionContext.Provider>
          : <div className="flex h-full items-center justify-center px-4 text-sm text-fw-text-muted">No sessions are available.</div>}
      </div>
    </div>
  )
}
