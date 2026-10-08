import { useEffect, useState } from 'react'
import Chat from './components/Chat'
import { WebUiImageSessionContext } from './components/ImageParts'
import { API_BASE_PATH } from './config'
import { useChatPreferences } from './chatPreferences'
import { useTheme } from './theme/useTheme'

type WebUiAuth = { role: 'webui'; identityId: string; sessionIds: string[] }
type WebUiSession = { id: string; displayName?: string | null }

/** A restricted WebUI identity mounts only its bound chat surface, never an administrator workbench leaf. */
export default function WebUiIdentityApp({ auth }: { auth: WebUiAuth }) {
  useTheme()
  const preferences = useChatPreferences()
  const [sessions, setSessions] = useState<WebUiSession[] | null>(null)
  const [selectedId, setSelectedId] = useState(() => auth.sessionIds[0] || '')
  const allowedIds = auth.sessionIds.join('\0')

  useEffect(() => {
    let active = true
    fetch(`${API_BASE_PATH}/sessions`).then(async response => {
      if (!response.ok) throw new Error(`Failed to load sessions (${response.status})`)
      return response.json()
    }).then(data => {
      if (active) setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    }).catch(() => {
      if (active) setSessions(null)
    })
    return () => { active = false }
  }, [allowedIds])

  const available: WebUiSession[] = sessions ?? auth.sessionIds.map(id => ({ id }))
  const sessionId = available.some(session => session.id === selectedId) ? selectedId : available[0]?.id
  const current = available.find(session => session.id === sessionId)
  return (
    <div data-webui-role="webui" className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col overflow-hidden bg-fw-canvas">
      {available.length > 1 && (
        <label className="flex shrink-0 items-center gap-3 border-b border-fw-border px-4 py-2 text-sm text-fw-text">
          <span>Session</span>
          <select aria-label="Session" value={sessionId} onChange={event => setSelectedId(event.currentTarget.value)} className="min-w-0 flex-1 rounded border border-fw-border bg-fw-surface px-2 py-1 text-fw-text">
            {available.map(session => <option key={session.id} value={session.id}>{session.displayName || session.id}</option>)}
          </select>
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {sessionId
          ? <WebUiImageSessionContext.Provider value={sessionId}><Chat key={sessionId} sessionId={sessionId} canonicalSessionId={sessionId} sessionDisplayName={current?.displayName || undefined} webUiIdentityMode sendKeyMode={preferences.sendKeyMode} groupTools={preferences.groupTools} showUsageBadge={preferences.showUsageBadge} showUserMessageMetadata={preferences.showUserMessageMetadata} /></WebUiImageSessionContext.Provider>
          : <div className="flex h-full items-center justify-center px-4 text-sm text-fw-text-muted">No sessions are available.</div>}
      </div>
    </div>
  )
}
