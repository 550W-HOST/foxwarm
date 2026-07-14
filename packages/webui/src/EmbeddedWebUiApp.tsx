import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { Bot } from 'lucide-react'
import Chat from './components/Chat'
import SessionListCore, { type Session } from './components/SessionListCore'
import AgentCreationMenu from './components/AgentCreationMenu'
import GlobalUiSettingsMenu from './components/GlobalUiSettingsMenu'
import { API_BASE_PATH } from './config'
import { buildSessionCreationBody, type AgentSummary } from './agentCreation'
import { postFoxwarmEmbedHostMessage, readEmbeddedSessionLink, type FoxwarmEmbeddedTarget } from './embeddedWebUi'

const UI_THEME_STYLE_STORAGE_KEY = 'foxwarm_ui_theme_style_v1'
const SEND_KEY_MODE_STORAGE_KEY = 'foxwarm_send_key_mode_v1'
const GROUP_TOOLS_STORAGE_KEY = 'foxwarm_group_tools_v1'
const SHOW_USAGE_BADGE_STORAGE_KEY = 'foxwarm_show_usage_badge_v1'

type ThemeMode = 'auto' | 'light' | 'dark'
type UiThemeStyle = 'default' | '550a'
type SendKeyMode = 'modEnter' | 'enter'
type WebUiSettings = { instanceName: string; tabIcon: string }

type EmbeddedPreferences = {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  uiThemeStyle: UiThemeStyle
  setUiThemeStyle: (style: UiThemeStyle) => void
  sendKeyMode: SendKeyMode
  setSendKeyMode: (mode: SendKeyMode) => void
  groupTools: boolean
  setGroupTools: (enabled: boolean) => void
  showUsageBadge: boolean
  setShowUsageBadge: (enabled: boolean) => void
}

const readPreferences = () => ({
  themeMode: (['auto', 'light', 'dark'].includes(localStorage.getItem('themeMode') || '') ? localStorage.getItem('themeMode') : 'auto') as ThemeMode,
  uiThemeStyle: (localStorage.getItem(UI_THEME_STYLE_STORAGE_KEY) === '550a' ? '550a' : 'default') as UiThemeStyle,
  sendKeyMode: (localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY) === 'enter' ? 'enter' : 'modEnter') as SendKeyMode,
  groupTools: localStorage.getItem(GROUP_TOOLS_STORAGE_KEY) === 'true',
  showUsageBadge: localStorage.getItem(SHOW_USAGE_BADGE_STORAGE_KEY) !== 'false',
})

function useEmbeddedPreferences(): EmbeddedPreferences {
  const initial = useMemo(readPreferences, [])
  const [themeMode, setThemeMode] = useState<ThemeMode>(initial.themeMode)
  const [uiThemeStyle, setUiThemeStyle] = useState<UiThemeStyle>(initial.uiThemeStyle)
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(initial.sendKeyMode)
  const [groupTools, setGroupTools] = useState(initial.groupTools)
  const [showUsageBadge, setShowUsageBadge] = useState(initial.showUsageBadge)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches || false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const dark = themeMode === 'dark' || (themeMode === 'auto' && systemDark)
    document.documentElement.classList.toggle('dark', dark)
    if (uiThemeStyle === '550a') document.documentElement.setAttribute('data-foxwarm-ui-style', '550a')
    else document.documentElement.removeAttribute('data-foxwarm-ui-style')
  }, [systemDark, themeMode, uiThemeStyle])

  useEffect(() => { localStorage.setItem('themeMode', themeMode) }, [themeMode])
  useEffect(() => { localStorage.setItem(UI_THEME_STYLE_STORAGE_KEY, uiThemeStyle) }, [uiThemeStyle])
  useEffect(() => { localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, sendKeyMode) }, [sendKeyMode])
  useEffect(() => { localStorage.setItem(GROUP_TOOLS_STORAGE_KEY, groupTools ? 'true' : 'false') }, [groupTools])
  useEffect(() => { localStorage.setItem(SHOW_USAGE_BADGE_STORAGE_KEY, showUsageBadge ? 'true' : 'false') }, [showUsageBadge])

  useEffect(() => {
    const sync = () => {
      const next = readPreferences()
      setThemeMode(next.themeMode)
      setUiThemeStyle(next.uiThemeStyle)
      setSendKeyMode(next.sendKeyMode)
      setGroupTools(next.groupTools)
      setShowUsageBadge(next.showUsageBadge)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  return { themeMode, setThemeMode, uiThemeStyle, setUiThemeStyle, sendKeyMode, setSendKeyMode, groupTools, setGroupTools, showUsageBadge, setShowUsageBadge }
}

function normalizeSettings(value: unknown): WebUiSettings {
  const raw = value && typeof value === 'object' ? value as Partial<WebUiSettings> : {}
  return {
    instanceName: typeof raw.instanceName === 'string' ? raw.instanceName : '',
    tabIcon: typeof raw.tabIcon === 'string' ? raw.tabIcon : '',
  }
}

export function EmbeddedSidebarApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'sidebar' }> }) {
  const preferences = useEmbeddedPreferences()
  const [sessions, setSessions] = useState<Session[]>([])
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [settings, setSettings] = useState<WebUiSettings>({ instanceName: '', tabIcon: '' })
  const [currentSession, setCurrentSession] = useState('')
  const [loadError, setLoadError] = useState('')
  const reconnectTimer = useRef<number | null>(null)

  const fetchSessions = useCallback(async () => {
    const response = await fetch(`${API_BASE_PATH}/sessions`)
    if (!response.ok) throw new Error(`Failed to load sessions (${response.status})`)
    const data = await response.json()
    setSessions(Array.isArray(data.sessions) ? data.sessions : [])
  }, [])

  const fetchAgents = useCallback(async () => {
    const response = await fetch(`${API_BASE_PATH}/agents`)
    if (!response.ok) return
    const data = await response.json()
    setAgents(Array.isArray(data.agents) ? data.agents : [])
  }, [])

  const fetchSettings = useCallback(async () => {
    const response = await fetch(`${API_BASE_PATH}/webui/settings`)
    if (!response.ok) return
    const data = await response.json()
    setSettings(normalizeSettings(data.settings))
  }, [])

  useEffect(() => {
    let disposed = false
    let eventSource: EventSource | null = null
    let delay = 1000

    const refresh = async () => {
      try {
        await Promise.all([fetchSessions(), fetchAgents(), fetchSettings()])
        if (!disposed) setLoadError('')
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      }
    }
    const connect = () => {
      if (disposed) return
      eventSource?.close()
      eventSource = new EventSource(`${API_BASE_PATH}/sessions/stream`)
      eventSource.onopen = () => { delay = 1000 }
      eventSource.onmessage = (event) => {
        try {
          if (JSON.parse(event.data)?.type === 'sessions-updated') void Promise.all([fetchSessions(), fetchAgents()])
        } catch {}
      }
      eventSource.onerror = () => {
        eventSource?.close()
        reconnectTimer.current = window.setTimeout(() => {
          void refresh().finally(connect)
          delay = Math.min(delay * 2, 30000)
        }, delay)
      }
    }

    void refresh().finally(connect)
    return () => {
      disposed = true
      eventSource?.close()
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current)
    }
  }, [fetchAgents, fetchSessions, fetchSettings])

  const openSession = (sessionId: string) => {
    setCurrentSession(sessionId)
    const session = sessions.find(item => item.id === sessionId || item.aliases?.includes(sessionId))
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId, title: session?.displayName || session?.id || sessionId })
  }

  const createAgent = async (agentId: string, inheritAgent?: string) => {
    const response = await fetch(`${API_BASE_PATH}/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, inheritAgent }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Failed to create agent')
    if (typeof data.sessionId !== 'string') throw new Error('Missing sessionId in create response')
    await Promise.all([fetchSessions(), fetchAgents()])
    openSession(data.sessionId)
  }

  const createSession = async (agentId: string, sessionId?: string) => {
    const response = await fetch(`${API_BASE_PATH}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSessionCreationBody(agentId, sessionId || '')),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Failed to create session')
    if (typeof data.sessionId !== 'string') throw new Error('Missing sessionId in create response')
    await fetchSessions()
    openSession(data.sessionId)
  }

  const saveSettings = async (next: WebUiSettings) => {
    const response = await fetch(`${API_BASE_PATH}/webui/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Failed to save WebUI settings')
    setSettings(normalizeSettings(data.settings))
  }

  const currentRecord = sessions.find(item => item.id === currentSession || item.aliases?.includes(currentSession))
  return (
    <DndContext>
      <div className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col bg-white dark:bg-gray-800">
        <div className="border-b border-gray-200 p-3 dark:border-gray-700">
          <div className="flex items-center justify-between gap-2">
            <h1 className="flex min-w-0 items-center gap-2 truncate text-lg font-bold text-gray-900 dark:text-white"><Bot className="h-4 w-4 shrink-0" /> Foxwarm</h1>
            <div className="flex items-stretch gap-1">
              <AgentCreationMenu agents={agents} currentAgent={currentRecord?.agent} compact onCreateAgent={createAgent} onCreateSession={createSession} />
              <GlobalUiSettingsMenu
                themeMode={preferences.themeMode} onThemeChange={preferences.setThemeMode}
                uiThemeStyle={preferences.uiThemeStyle} onUiThemeStyleChange={preferences.setUiThemeStyle}
                sendKeyMode={preferences.sendKeyMode} onSendKeyModeChange={preferences.setSendKeyMode}
                groupTools={preferences.groupTools} onGroupToolsChange={preferences.setGroupTools}
                showUsageBadge={preferences.showUsageBadge} onShowUsageBadgeChange={preferences.setShowUsageBadge}
                instanceName={settings.instanceName} onInstanceNameChange={(instanceName) => saveSettings({ ...settings, instanceName })}
                tabIcon={settings.tabIcon} onTabIconChange={(tabIcon) => saveSettings({ ...settings, tabIcon })}
                menuAlign="start"
              />
            </div>
          </div>
          {loadError && <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{loadError}</div>}
        </div>
        <div className="min-h-0 flex-1 border-t border-gray-200 dark:border-gray-700">
          <SessionListCore sessions={sessions} currentSession={currentSession} onSelectSession={openSession} onKeepSession={openSession} toolbarContainerClassName="p-2 pb-1" listContainerClassName="p-2 pt-1" dragEnabled={false} />
        </div>
      </div>
    </DndContext>
  )
}

export function EmbeddedChatApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'chat' }> }) {
  const preferences = useEmbeddedPreferences()

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const sessionId = readEmbeddedSessionLink(event.target)
      if (!sessionId) return
      event.preventDefault()
      postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId })
    }
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [target.nonce])

  return (
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
      <Chat
        sessionId={target.sessionId}
        canonicalSessionId={target.sessionId}
        sessionDisplayName={target.title}
        sendKeyMode={preferences.sendKeyMode}
        groupTools={preferences.groupTools}
        showUsageBadge={preferences.showUsageBadge}
        onOpenCodeCommit={(commit) => postFoxwarmEmbedHostMessage(target.nonce, {
          type: 'open-commit', nodeId: commit.nodeId, path: commit.path, commitId: commit.commitId,
        })}
      />
    </div>
  )
}
