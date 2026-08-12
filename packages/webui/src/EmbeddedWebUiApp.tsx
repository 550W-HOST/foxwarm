import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { Bot, Workflow } from 'lucide-react'
import Chat from './components/Chat'
import SessionListCore from './components/SessionListCore'
import AgentCreationMenu from './components/AgentCreationMenu'
import GlobalUiSettingsMenu from './components/GlobalUiSettingsMenu'
import CreateTabButton from './components/CreateTabButton'
import { API_BASE_PATH } from './config'
import { buildSessionCreationBody, type AgentSummary } from './agentCreation'
import { postFoxwarmEmbedHostMessage, readEmbeddedSessionLink, readFoxwarmActiveTargetMessage, readFoxwarmFocusModelsMessage, readFoxwarmVisibleSessionIdsMessage, type FoxwarmActiveTarget, type FoxwarmEmbeddedTarget } from './embeddedWebUi'
import { useSessionIdleNotifications } from './sessionIdleNotifications'
import { useBoundedSessionList } from './boundedSessionList'

const ArchitectureView = lazy(() => import('./components/ArchitectureView'))
const SetupView = lazy(() => import('./components/SetupView'))

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
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [settings, setSettings] = useState<WebUiSettings>({ instanceName: '', tabIcon: '' })
  const [activeTarget, setActiveTarget] = useState<FoxwarmActiveTarget | null>(null)
  const [visibleSessionIds, setVisibleSessionIds] = useState<string[]>([])
  const currentSession = activeTarget?.kind === 'session' ? activeTarget.sessionId : ''
  const boundedSessions = useBoundedSessionList({ focusIds: currentSession ? [currentSession] : [], exactIds: currentSession ? [currentSession] : [] })
  const sessions = boundedSessions.knownSessions
  const sidebarSessions = boundedSessions.sessions
  const fetchSessions = boundedSessions.refresh
  const loadError = ''
  const boundedPresentation = {
    serverOrdered: true as const, hasMoreRoots: boundedSessions.hasMoreRoots, childPages: boundedSessions.childPages,
    descendantBusy: boundedSessions.descendantBusy, invalidationVersion: boundedSessions.invalidationVersion,
    onModeChange: boundedSessions.setMode, onFilterChange: boundedSessions.setQuery,
    onLoadMoreRoots: () => { void boundedSessions.loadMoreRoots() },
    onLoadMoreChildren: (sessionId: string) => { void boundedSessions.loadMoreChildren(sessionId) },
    onExpandBranch: (sessionId: string) => { void boundedSessions.expandBranch(sessionId) },
    onCollapseBranch: boundedSessions.collapseBranch,
  }

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

  const { idleNotificationModes, toggleIdleNotificationMode, unreadSessionIds, acknowledgeSession } = useSessionIdleNotifications(sessions, { visibleSessionIds })

  useEffect(() => {
    void fetchSettings()
    void fetchAgents()
  }, [fetchSettings, fetchAgents])

  useEffect(() => {
    const handleHostMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const next = readFoxwarmActiveTargetMessage(event.data, target.nonce)
      if (next !== undefined) setActiveTarget(next)
      const nextVisibleSessionIds = readFoxwarmVisibleSessionIdsMessage(event.data, target.nonce)
      if (nextVisibleSessionIds !== undefined) setVisibleSessionIds(nextVisibleSessionIds)
    }
    window.addEventListener('message', handleHostMessage)
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'sidebar-ready' })
    return () => window.removeEventListener('message', handleHostMessage)
  }, [target.nonce])

  const openSession = (sessionId: string) => {
    setActiveTarget({ kind: 'session', sessionId })
    acknowledgeSession(sessionId)
    const session = sessions.find(item => item.id === sessionId || item.aliases?.includes(sessionId))
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId, title: session?.displayName || session?.id || sessionId })
  }

  const openAgents = () => {
    setActiveTarget({ kind: 'agents' })
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-agents' })
  }

  const openSetup = () => {
    setActiveTarget({ kind: 'setup' })
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-setup' })
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
  const agentsActive = activeTarget?.kind === 'agents'
  return (
    <DndContext>
      <div className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col bg-white dark:bg-gray-800">
        <div className="border-b border-gray-200 p-3 dark:border-gray-700">
          <div className="flex items-center justify-between gap-2">
            <h1 className="flex min-w-0 items-center gap-2 truncate text-lg font-bold text-gray-900 dark:text-white"><Bot className="h-4 w-4 shrink-0" /> Foxwarm</h1>
            <div className="flex items-stretch gap-1">
              <GlobalUiSettingsMenu
                themeMode={preferences.themeMode} onThemeChange={preferences.setThemeMode}
                uiThemeStyle={preferences.uiThemeStyle} onUiThemeStyleChange={preferences.setUiThemeStyle}
                sendKeyMode={preferences.sendKeyMode} onSendKeyModeChange={preferences.setSendKeyMode}
                groupTools={preferences.groupTools} onGroupToolsChange={preferences.setGroupTools}
                showUsageBadge={preferences.showUsageBadge} onShowUsageBadgeChange={preferences.setShowUsageBadge}
                instanceName={settings.instanceName} onInstanceNameChange={(instanceName) => saveSettings({ ...settings, instanceName })}
                tabIcon={settings.tabIcon} onTabIconChange={(tabIcon) => saveSettings({ ...settings, tabIcon })}
                menuAlign="end"
                onOpenSetup={openSetup}
                setupActive={activeTarget?.kind === 'setup'}
              />
            </div>
          </div>
          {loadError && <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{loadError}</div>}
          <div className="mt-3 flex items-stretch gap-1">
            <button
              type="button"
              onClick={openAgents}
              className={`inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${agentsActive ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'}`}
              title="Open agents overview"
              aria-pressed={agentsActive}
            >
              <Workflow className="h-4 w-4" />
              <span>Agents</span>
            </button>
            <AgentCreationMenu agents={agents} currentAgent={currentRecord?.agent} compact onCreateAgent={createAgent} onCreateSession={createSession} />
          </div>
          <div className="mt-2">
            <CreateTabButton
              defaultNodeId={currentRecord?.currentNode || 'master'}
              defaultPath={currentRecord?.cwd || '/'}
              onCreate={() => postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-terminal' })}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 border-t border-gray-200 dark:border-gray-700">
          <SessionListCore sessions={sidebarSessions} currentSession={currentSession} onSelectSession={openSession} onKeepSession={openSession} toolbarContainerClassName="p-2 pb-1" listContainerClassName="p-2 pt-1" dragEnabled={false} idleNotificationModes={idleNotificationModes} unreadSessionIds={unreadSessionIds} onToggleIdleNotificationMode={toggleIdleNotificationMode} bounded={boundedPresentation} />
        </div>
      </div>
    </DndContext>
  )
}

function EmbeddedLeafFallback({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center bg-gray-100 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">Loading {label}…</div>
}

export function EmbeddedAgentsApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'agents' }> }) {
  useEmbeddedPreferences()
  const openSession = (sessionId: string) => {
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId, title: sessionId })
  }
  return (
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
      <Suspense fallback={<EmbeddedLeafFallback label="Agents" />}>
        <ArchitectureView onSelectSession={openSession} />
      </Suspense>
    </div>
  )
}

export function EmbeddedSetupApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'setup' }> }) {
  useEmbeddedPreferences()
  const [focusModelsRequest, setFocusModelsRequest] = useState(0)
  useEffect(() => {
    const handleHostMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      if (readFoxwarmFocusModelsMessage(event.data, target.nonce)) {
        setFocusModelsRequest((current) => current + 1)
      }
    }
    window.addEventListener('message', handleHostMessage)
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'setup-ready' })
    return () => window.removeEventListener('message', handleHostMessage)
  }, [target.nonce])
  return (
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-gray-50 dark:bg-gray-950">
      <Suspense fallback={<EmbeddedLeafFallback label="Setup" />}>
        <SetupView focusModelsRequest={focusModelsRequest} />
      </Suspense>
    </div>
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
        onOpenModelSettings={() => postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-setup', focus: 'models' })}
        onOpenCodeCommit={(commit) => postFoxwarmEmbedHostMessage(target.nonce, {
          type: 'open-commit', nodeId: commit.nodeId, path: commit.path, commitId: commit.commitId,
        })}
      />
    </div>
  )
}
