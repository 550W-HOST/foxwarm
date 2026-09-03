import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useTheme } from './theme/useTheme'

const ArchitectureView = lazy(() => import('./components/ArchitectureView'))
const SetupView = lazy(() => import('./components/SetupView'))

const SEND_KEY_MODE_STORAGE_KEY = 'foxwarm_send_key_mode_v1'
const GROUP_TOOLS_STORAGE_KEY = 'foxwarm_group_tools_v1'
const SHOW_USAGE_BADGE_STORAGE_KEY = 'foxwarm_show_usage_badge_v1'

type SendKeyMode = 'modEnter' | 'enter'
type WebUiSettings = { instanceName: string; tabIcon: string }

type EmbeddedPreferences = {
  sendKeyMode: SendKeyMode
  setSendKeyMode: (mode: SendKeyMode) => void
  groupTools: boolean
  setGroupTools: (enabled: boolean) => void
  showUsageBadge: boolean
  setShowUsageBadge: (enabled: boolean) => void
}

const readPreferences = () => ({
  sendKeyMode: (localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY) === 'enter' ? 'enter' : 'modEnter') as SendKeyMode,
  groupTools: localStorage.getItem(GROUP_TOOLS_STORAGE_KEY) === 'true',
  showUsageBadge: localStorage.getItem(SHOW_USAGE_BADGE_STORAGE_KEY) !== 'false',
})

function useEmbeddedPreferences(): EmbeddedPreferences {
  const initial = useMemo(readPreferences, [])
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(initial.sendKeyMode)
  const [groupTools, setGroupTools] = useState(initial.groupTools)
  const [showUsageBadge, setShowUsageBadge] = useState(initial.showUsageBadge)
  useEffect(() => { localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, sendKeyMode) }, [sendKeyMode])
  useEffect(() => { localStorage.setItem(GROUP_TOOLS_STORAGE_KEY, groupTools ? 'true' : 'false') }, [groupTools])
  useEffect(() => { localStorage.setItem(SHOW_USAGE_BADGE_STORAGE_KEY, showUsageBadge ? 'true' : 'false') }, [showUsageBadge])

  useEffect(() => {
    const sync = () => {
      const next = readPreferences()
      setSendKeyMode(next.sendKeyMode)
      setGroupTools(next.groupTools)
      setShowUsageBadge(next.showUsageBadge)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  return { sendKeyMode, setSendKeyMode, groupTools, setGroupTools, showUsageBadge, setShowUsageBadge }
}

function normalizeSettings(value: unknown): WebUiSettings {
  const raw = value && typeof value === 'object' ? value as Partial<WebUiSettings> : {}
  return {
    instanceName: typeof raw.instanceName === 'string' ? raw.instanceName : '',
    tabIcon: typeof raw.tabIcon === 'string' ? raw.tabIcon : '',
  }
}

export function EmbeddedSidebarApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'sidebar' }> }) {
  useTheme()
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
    branchLoadStates: boundedSessions.branchLoadStates,
    descendantBusy: boundedSessions.descendantBusy, invalidationVersion: boundedSessions.invalidationVersion,
    onModeChange: boundedSessions.setMode, onFilterChange: boundedSessions.setQuery,
    onLoadMoreRoots: () => { void boundedSessions.loadMoreRoots() },
    onLoadMoreChildren: (sessionId: string) => { void boundedSessions.loadMoreChildren(sessionId) },
    onExpandBranch: (sessionId: string) => { void boundedSessions.expandBranch(sessionId) },
    onExpandBranches: (sessionIds: string[]) => { void boundedSessions.expandBranches(sessionIds) },
    onRetryBranch: (sessionId: string) => { void boundedSessions.retryBranch(sessionId) },
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

  const notificationOpenSessionRef = useRef<((sessionId: string) => void) | null>(null)
  const { idleNotificationModes, toggleIdleNotificationMode, unreadSessionIds } = useSessionIdleNotifications(sessions, {
    visibleSessionIds,
    onOpenSession: (sessionId) => notificationOpenSessionRef.current?.(sessionId),
  })

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
    const session = sessions.find(item => item.id === sessionId || item.aliases?.includes(sessionId))
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId, title: session?.displayName || session?.id || sessionId })
  }
  notificationOpenSessionRef.current = openSession

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
      <div className="foxwarm-fixed-viewport-shell flex h-full min-h-0 flex-col bg-fw-surface">
        <div className="border-b border-fw-border p-3 dark:border-fw-border">
          <div className="flex items-center justify-between gap-2">
            <h1 className="flex min-w-0 items-center gap-2 truncate text-lg font-bold text-fw-text-strong"><Bot className="h-4 w-4 shrink-0" /> Foxwarm</h1>
            <div className="flex items-stretch gap-1">
              <GlobalUiSettingsMenu
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
          {loadError && <div className="mt-2 rounded bg-fw-danger-surface px-2 py-1 text-xs text-fw-danger dark:bg-fw-danger-surface-strong/40 dark:text-fw-danger">{loadError}</div>}
          <div className="mt-3 flex items-stretch gap-1">
            <button
              type="button"
              onClick={openAgents}
              className={`inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${agentsActive ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'}`}
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
        <div className="min-h-0 flex-1 border-t border-fw-border">
          <SessionListCore sessions={sidebarSessions} currentSession={currentSession} onSelectSession={openSession} onKeepSession={openSession} toolbarContainerClassName="p-2 pb-1" listContainerClassName="p-2 pt-1" dragEnabled={false} idleNotificationModes={idleNotificationModes} unreadSessionIds={unreadSessionIds} onToggleIdleNotificationMode={toggleIdleNotificationMode} bounded={boundedPresentation} />
        </div>
      </div>
    </DndContext>
  )
}

function EmbeddedLeafFallback({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center bg-fw-neutral-surface text-sm text-fw-text-muted dark:bg-fw-canvas dark:text-fw-text-muted">Loading {label}…</div>
}

export function EmbeddedAgentsApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'agents' }> }) {
  useTheme()
  useEmbeddedPreferences()
  const openSession = (sessionId: string) => {
    postFoxwarmEmbedHostMessage(target.nonce, { type: 'open-session', sessionId, title: sessionId })
  }
  return (
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-fw-canvas">
      <Suspense fallback={<EmbeddedLeafFallback label="Agents" />}>
        <ArchitectureView onSelectSession={openSession} />
      </Suspense>
    </div>
  )
}

export function EmbeddedSetupApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'setup' }> }) {
  useTheme()
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
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-fw-surface-sunken dark:bg-fw-canvas-edge">
      <Suspense fallback={<EmbeddedLeafFallback label="Setup" />}>
        <SetupView focusModelsRequest={focusModelsRequest} />
      </Suspense>
    </div>
  )
}

export function EmbeddedChatApp({ target }: { target: Extract<FoxwarmEmbeddedTarget, { kind: 'chat' }> }) {
  useTheme()
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
    <div className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-fw-canvas">
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
