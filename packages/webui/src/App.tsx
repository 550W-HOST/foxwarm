import { useEffect, useMemo, useRef, useState } from 'react'
import Chat from './components/Chat'
import ArchitectureView from './components/ArchitectureView'
import SessionList from './components/SessionList'
import Sidebar from './components/Sidebar'
import TerminalView from './components/TerminalView'
import WorkspaceView from './components/WorkspaceView'
import FileEditorView from './components/FileEditorView'
import WorkbenchTabs, { type WorkbenchTab } from './components/WorkbenchTabs'
import type { Session } from './components/SessionListCore'
import { API_BASE_PATH } from './config'

type ThemeMode = 'auto' | 'light' | 'dark'
type AppView = 'session' | 'architecture'

type RouteState =
  | { view: 'architecture' }
  | { view: 'session'; sessionId: string; tabId: string | null }

type TerminalRegistryRecord = {
  id: string
  sessionId: string
  cwd: string
  nodeId: string
  shell: string
  pid: number
  createdAt: number
}

const LIGHT_THEME_COLOR = '#f3f4f6'
const DARK_THEME_COLOR = '#111827'
const ARCHITECTURE_HASH = 'architecture'
const SESSION_HASH_PREFIX = 'session/'
const WORKBENCH_TABS_STORAGE_KEY = 'foxwarm_workbench_tabs_v2'
const LAST_VISITED_SESSION_STORAGE_KEY = 'foxwarm_last_visited_session_v1'

function loadStoredLastVisitedSession(): string {
  try {
    return localStorage.getItem(LAST_VISITED_SESSION_STORAGE_KEY) || 'main'
  } catch {
    return 'main'
  }
}

function getHashState(): RouteState {
  const fallbackSessionId = loadStoredLastVisitedSession()
  const hash = decodeURIComponent(window.location.hash.slice(1))

  if (!hash || hash.startsWith('token=')) {
    return { view: 'session', sessionId: fallbackSessionId, tabId: null }
  }

  if (hash === ARCHITECTURE_HASH || hash === '__architecture__') {
    return { view: 'architecture' }
  }

  if (hash.startsWith(SESSION_HASH_PREFIX)) {
    const remainder = hash.slice(SESSION_HASH_PREFIX.length)
    const [sessionIdPart, queryPart = ''] = remainder.split('?')
    const params = new URLSearchParams(queryPart)
    return {
      view: 'session',
      sessionId: sessionIdPart || fallbackSessionId,
      tabId: params.get('tab') || null,
    }
  }

  if (hash.startsWith('__workspace__:')) {
    return { view: 'session', sessionId: hash.slice('__workspace__:'.length) || fallbackSessionId, tabId: null }
  }

  if (hash.startsWith('__terminal__:')) {
    const remainder = hash.slice('__terminal__:'.length)
    const [sessionIdPart] = remainder.split('?')
    return { view: 'session', sessionId: sessionIdPart || fallbackSessionId, tabId: null }
  }

  return { view: 'session', sessionId: hash, tabId: null }
}

function setSessionHash(sessionId: string, tabId?: string | null) {
  const params = new URLSearchParams()
  if (tabId) {
    params.set('tab', tabId)
  }
  const suffix = params.toString() ? `?${params.toString()}` : ''
  window.location.hash = `${SESSION_HASH_PREFIX}${encodeURIComponent(sessionId)}${suffix}`
}

function loadStoredWorkbenchTabs(): WorkbenchTab[] {
  try {
    const raw = localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter((item): item is WorkbenchTab => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.type !== 'string' || typeof item.title !== 'string' || typeof item.sessionId !== 'string') {
        return false
      }
      if (item.type === 'chat') return true
      if (item.type === 'workspace' || item.type === 'file') return typeof item.nodeId === 'string' && typeof item.path === 'string'
      if (item.type === 'terminal') return true
      return false
    })
  } catch {
    return []
  }
}

function makeChatTab(sessionId: string, title: string): WorkbenchTab {
  return { id: `chat:${sessionId}`, type: 'chat', sessionId, title }
}

function makeWorkspaceTab(sessionId: string, nodeId: string, path: string): WorkbenchTab {
  return {
    id: `workspace:${sessionId}:${nodeId}:${path}`,
    type: 'workspace',
    sessionId,
    nodeId,
    path,
    title: `Workspace · ${path}`,
  }
}

function makeFileTab(sessionId: string, nodeId: string, path: string): WorkbenchTab {
  return {
    id: `file:${sessionId}:${nodeId}:${path}`,
    type: 'file',
    sessionId,
    nodeId,
    path,
    title: path.split('/').pop() || path,
  }
}

function makeTerminalDraftTab(sessionId: string, nodeId: string, cwd: string): WorkbenchTab {
  return {
    id: `terminal-draft:${sessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    type: 'terminal',
    sessionId,
    nodeId,
    cwd,
    createMode: 'new',
    title: `Terminal · ${cwd}`,
  }
}

function makeTerminalTabFromRecord(record: TerminalRegistryRecord): WorkbenchTab {
  return {
    id: `terminal:${record.id}`,
    type: 'terminal',
    sessionId: record.sessionId,
    terminalId: record.id,
    nodeId: record.nodeId,
    cwd: record.cwd,
    title: `Terminal · ${record.cwd}`,
  }
}

function mergeTerminalTabsWithRegistry(localTabs: WorkbenchTab[], terminals: TerminalRegistryRecord[]): WorkbenchTab[] {
  const terminalMap = new Map(terminals.map((terminal) => [terminal.id, terminal]))
  const merged: WorkbenchTab[] = []
  const seenTerminalIds = new Set<string>()

  for (const tab of localTabs) {
    if (tab.type !== 'terminal') {
      merged.push(tab)
      continue
    }

    if (!tab.terminalId) {
      merged.push(tab)
      continue
    }

    const terminal = terminalMap.get(tab.terminalId)
    if (!terminal) {
      continue
    }

    merged.push({
      ...tab,
      id: `terminal:${terminal.id}`,
      sessionId: terminal.sessionId,
      terminalId: terminal.id,
      nodeId: terminal.nodeId,
      cwd: terminal.cwd,
      title: `Terminal · ${terminal.cwd}`,
      createMode: undefined,
    })
    seenTerminalIds.add(terminal.id)
  }

  for (const terminal of terminals) {
    if (!seenTerminalIds.has(terminal.id)) {
      merged.push(makeTerminalTabFromRecord(terminal))
    }
  }

  return merged
}

function App() {
  const initialRoute = getHashState()

  const [sessions, setSessions] = useState<Session[]>([])
  const [route, setRoute] = useState<RouteState>(initialRoute)
  const [workbenchTabs, setWorkbenchTabs] = useState<WorkbenchTab[]>(() => loadStoredWorkbenchTabs())
  const [activeTerminals, setActiveTerminals] = useState<TerminalRegistryRecord[]>([])
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [showSessionList, setShowSessionList] = useState<boolean>(() => !window.location.hash)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('themeMode')
    return saved === 'auto' || saved === 'light' || saved === 'dark' ? saved : 'auto'
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  const darkMode = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark)

  const globalSSERef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectDelayRef = useRef<number>(1000)

  const sessionTitle = (sessionId: string) => sessions.find(session => session.id === sessionId || session.aliases?.includes(sessionId))?.displayName || sessionId

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', darkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR)
  }, [darkMode])

  useEffect(() => {
    localStorage.setItem('themeMode', themeMode)
  }, [themeMode])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify(workbenchTabs))
  }, [workbenchTabs])

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(getHashState())
      if (isMobile) {
        setShowSessionList(!window.location.hash)
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [isMobile])

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions)
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error)
    }
  }

  const fetchActiveTerminals = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/terminals`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch terminals')
      }
      setActiveTerminals(Array.isArray(data.terminals) ? data.terminals : [])
    } catch (error) {
      console.error('Failed to fetch terminals:', error)
      setActiveTerminals([])
    }
  }

  const connectGlobalSSE = () => {
    if (globalSSERef.current) {
      globalSSERef.current.close()
      globalSSERef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    const es = new EventSource(`${API_BASE_PATH}/sessions/stream`)
    es.onopen = () => {
      reconnectDelayRef.current = 1000
    }
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'sessions-updated') {
          void fetchSessions()
          void fetchActiveTerminals()
        }
      } catch (error) {
        console.error('Failed to parse SSE message:', error)
      }
    }
    es.onerror = () => {
      es.close()
      if (es.readyState === EventSource.CLOSED) {
        const delay = Math.min(reconnectDelayRef.current, 30000)
        reconnectTimeoutRef.current = setTimeout(() => {
          void fetchSessions().then(() => connectGlobalSSE())
          void fetchActiveTerminals()
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
        }, delay)
      }
    }
    globalSSERef.current = es
  }

  useEffect(() => {
    void fetchSessions()
    void fetchActiveTerminals()
    connectGlobalSSE()
    return () => {
      globalSSERef.current?.close()
      globalSSERef.current = null
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    setWorkbenchTabs((previous) => mergeTerminalTabsWithRegistry(previous, activeTerminals))
  }, [activeTerminals])

  useEffect(() => {
    setWorkbenchTabs((previous) => previous.map((tab) => (
      tab.type === 'chat'
        ? { ...tab, title: sessionTitle(tab.sessionId) }
        : tab
    )))
  }, [sessions])

  const currentContextSessionId = route.view === 'session' ? route.sessionId : loadStoredLastVisitedSession()
  const currentContextSessionRecord = sessions.find(session => session.id === currentContextSessionId || session.aliases?.includes(currentContextSessionId))

  useEffect(() => {
    if (route.view !== 'session') {
      return
    }

    localStorage.setItem(LAST_VISITED_SESSION_STORAGE_KEY, route.sessionId)

    const matchingRouteTab = route.tabId
      ? workbenchTabs.find((tab) => tab.id === route.tabId && tab.sessionId === route.sessionId)
      : null

    if (matchingRouteTab) {
      return
    }

    const firstSessionTab = workbenchTabs.find((tab) => tab.sessionId === route.sessionId)
    if (firstSessionTab) {
      if (route.tabId !== firstSessionTab.id) {
        setSessionHash(route.sessionId, firstSessionTab.id)
      }
      return
    }

    const chatTab = makeChatTab(route.sessionId, sessionTitle(route.sessionId))
    setWorkbenchTabs((previous) => [...previous, chatTab])
    setSessionHash(route.sessionId, chatTab.id)
  }, [route, workbenchTabs, sessions])

  const activeTab = useMemo(() => {
    if (route.view !== 'session' || !route.tabId) {
      return null
    }
    return workbenchTabs.find((tab) => tab.id === route.tabId && tab.sessionId === route.sessionId) || null
  }, [route, workbenchTabs])

  const activeWorkbenchTabType = activeTab?.type || null
  const currentView: AppView = route.view

  const navigateToSession = (sessionId: string, tabId?: string | null) => {
    setRoute({ view: 'session', sessionId, tabId: tabId || null })
    setSessionHash(sessionId, tabId || null)
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const openChatTab = (sessionId: string) => {
    const tab = makeChatTab(sessionId, sessionTitle(sessionId))
    setWorkbenchTabs((previous) => {
      const index = previous.findIndex((item) => item.id === tab.id)
      if (index >= 0) {
        const next = [...previous]
        next[index] = tab
        return next
      }
      return [...previous, tab]
    })
    navigateToSession(sessionId, tab.id)
  }

  const openWorkspaceTab = (sessionId: string, options?: { nodeId?: string; path?: string }) => {
    const sessionRecord = sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))
    const nodeId = options?.nodeId || sessionRecord?.currentNode || 'master'
    const path = options?.path || sessionRecord?.cwd || '/'
    const tab = makeWorkspaceTab(sessionId, nodeId, path)
    setWorkbenchTabs((previous) => {
      const existingIndex = previous.findIndex((item) => item.id === tab.id)
      if (existingIndex >= 0) {
        return previous
      }
      return [...previous, tab]
    })
    navigateToSession(sessionId, tab.id)
  }

  const openFileTab = (sessionId: string, nodeId: string, path: string) => {
    const tab = makeFileTab(sessionId, nodeId, path)
    setWorkbenchTabs((previous) => {
      const existingIndex = previous.findIndex((item) => item.id === tab.id)
      if (existingIndex >= 0) {
        return previous
      }
      return [...previous, tab]
    })
    navigateToSession(sessionId, tab.id)
  }

  const openTerminalTab = (sessionId: string, options?: { nodeId?: string; path?: string; terminalId?: string }) => {
    if (options?.terminalId) {
      const existing = workbenchTabs.find((tab) => tab.type === 'terminal' && tab.terminalId === options.terminalId)
      const terminal = activeTerminals.find((item) => item.id === options.terminalId)
      const tab = existing || (terminal ? makeTerminalTabFromRecord(terminal) : null)
      if (tab) {
        if (!existing) {
          setWorkbenchTabs((previous) => [...previous, tab])
        }
        navigateToSession(tab.sessionId, tab.id)
      }
      return
    }

    const sessionRecord = sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))
    const nodeId = options?.nodeId || sessionRecord?.currentNode || 'master'
    const path = options?.path || sessionRecord?.cwd || '/'
    const tab = makeTerminalDraftTab(sessionId, nodeId, path)
    setWorkbenchTabs((previous) => [...previous, tab])
    navigateToSession(sessionId, tab.id)
  }

  const closeWorkbenchTab = async (tabId: string) => {
    const targetTab = workbenchTabs.find((tab) => tab.id === tabId) || null
    if (targetTab?.type === 'terminal' && targetTab.terminalId) {
      try {
        await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(targetTab.terminalId)}`, { method: 'DELETE' })
      } catch (error) {
        console.error('Failed to close terminal:', error)
      }
      await fetchActiveTerminals()
    }

    const remainingTabs = workbenchTabs.filter((tab) => tab.id !== tabId)
    setWorkbenchTabs(remainingTabs)

    if (route.view === 'session' && route.tabId === tabId) {
      const nextTab = remainingTabs.find((tab) => tab.sessionId === route.sessionId) || remainingTabs[0] || null
      if (nextTab) {
        navigateToSession(nextTab.sessionId, nextTab.id)
      } else {
        openChatTab(route.sessionId)
      }
    }
  }

  const handleTerminalReady = (draftTabId: string, terminal: { id: string; sessionId: string; cwd: string; nodeId?: string }) => {
    const nextId = `terminal:${terminal.id}`
    setWorkbenchTabs((previous) => previous.map((tab) => {
      if (tab.id !== draftTabId) return tab
      return {
        id: nextId,
        type: 'terminal',
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
        nodeId: terminal.nodeId || 'master',
        cwd: terminal.cwd,
        title: `Terminal · ${terminal.cwd}`,
      }
    }))

    if (route.view === 'session' && route.tabId === draftTabId) {
      navigateToSession(terminal.sessionId, nextId)
    }
    void fetchActiveTerminals()
  }

  const handleTerminalClosed = (terminalId: string) => {
    const target = workbenchTabs.find((tab) => tab.type === 'terminal' && tab.terminalId === terminalId)
    if (target) {
      void closeWorkbenchTab(target.id)
    }
    void fetchActiveTerminals()
  }

  const handleCreateSession = () => {
    fetch(`${API_BASE_PATH}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to create session')
      if (!data.sessionId) throw new Error('Missing sessionId in create response')
      await fetchSessions()
      openChatTab(data.sessionId)
    }).catch((error) => {
      console.error('Failed to create session:', error)
      window.alert(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const handleBackToList = () => {
    window.location.hash = ''
    setShowSessionList(true)
    setRoute(getHashState())
  }

  useEffect(() => {
    const helper = {
      sendMessage: (message: string) => {
        if (route.view !== 'session') return
        void fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(route.sessionId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        })
      },
      switchToSession: (sessionId: string) => {
        openChatTab(sessionId)
      },
    }

    ;(window as any).foxwarmTest = helper
    ;(window as any).alphabotTest = helper
  }, [route, sessions])

  const renderSessionContent = (onBack?: () => void) => {
    if (!activeTab) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          No active tab.
        </div>
      )
    }

    if (activeTab.type === 'chat') {
      const sessionRecord = sessions.find((session) => session.id === activeTab.sessionId || session.aliases?.includes(activeTab.sessionId))
      return (
        <Chat
          key={activeTab.id}
          sessionId={activeTab.sessionId}
          sessionDisplayName={sessionRecord?.displayName}
          onBack={onBack}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
        />
      )
    }

    if (activeTab.type === 'workspace') {
      const sessionRecord = sessions.find((session) => session.id === activeTab.sessionId || session.aliases?.includes(activeTab.sessionId))
      return (
        <WorkspaceView
          sessionId={activeTab.sessionId}
          session={sessionRecord}
          initialNodeId={activeTab.nodeId}
          initialPath={activeTab.path}
          onBack={onBack}
          onSessionsChanged={() => { void fetchSessions() }}
          onOpenTerminal={(cwd) => openTerminalTab(activeTab.sessionId, { nodeId: activeTab.nodeId, path: cwd || activeTab.path })}
          onOpenFile={(nodeId, path) => openFileTab(activeTab.sessionId, nodeId, path)}
        />
      )
    }

    if (activeTab.type === 'file') {
      const sessionRecord = sessions.find((session) => session.id === activeTab.sessionId || session.aliases?.includes(activeTab.sessionId))
      return (
        <FileEditorView
          sessionId={activeTab.sessionId}
          session={sessionRecord}
          nodeId={activeTab.nodeId}
          filePath={activeTab.path}
          onBack={onBack}
          onSessionsChanged={() => { void fetchSessions() }}
          onOpenTerminal={(cwd) => openTerminalTab(activeTab.sessionId, { nodeId: activeTab.nodeId, path: cwd || activeTab.path.split('/').slice(0, -1).join('/') || '/' })}
        />
      )
    }

    const sessionRecord = sessions.find((session) => session.id === activeTab.sessionId || session.aliases?.includes(activeTab.sessionId))
    return (
      <TerminalView
        key={activeTab.id}
        sessionId={activeTab.sessionId}
        session={sessionRecord}
        initialCwd={activeTab.cwd}
        initialTerminalId={activeTab.terminalId}
        createMode={activeTab.createMode || 'reuse'}
        onBack={onBack}
        onSessionsChanged={() => { void fetchSessions() }}
        onTerminalReady={(terminal) => handleTerminalReady(activeTab.id, terminal)}
        onTerminalClosed={handleTerminalClosed}
      />
    )
  }

  if (isMobile) {
    if (showSessionList) {
      return (
        <SessionList
          sessions={sessions}
          currentSession={currentContextSessionId}
          currentView={currentView}
          activeWorkbenchTabType={activeWorkbenchTabType}
          currentSessionRecord={currentContextSessionRecord}
          onSelectSession={openChatTab}
          onSelectArchitecture={() => {
            setRoute({ view: 'architecture' })
            window.location.hash = ARCHITECTURE_HASH
            setShowSessionList(false)
          }}
          onCreateWorkspaceTab={(options) => openWorkspaceTab(currentContextSessionId, options)}
          onCreateTerminalTab={(options) => openTerminalTab(currentContextSessionId, options)}
          onCreateSession={handleCreateSession}
        />
      )
    }

    if (route.view === 'architecture') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <ArchitectureView sessions={sessions} currentSession={currentContextSessionId} onSelectSession={openChatTab} onBack={handleBackToList} />
        </div>
      )
    }

    return (
      <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <WorkbenchTabs
            tabs={workbenchTabs.filter((tab) => tab.sessionId === route.sessionId)}
            activeTabId={route.tabId}
            onSelectTab={(tabId) => {
              const tab = workbenchTabs.find((item) => item.id === tabId)
              if (tab) navigateToSession(tab.sessionId, tab.id)
            }}
            onCloseTab={(tabId) => { void closeWorkbenchTab(tabId) }}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderSessionContent(handleBackToList)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
      <Sidebar
        sessions={sessions}
        currentSession={currentContextSessionId}
        currentView={currentView}
        activeWorkbenchTabType={activeWorkbenchTabType}
        currentSessionRecord={currentContextSessionRecord}
        onSelectSession={openChatTab}
        onSelectArchitecture={() => {
          setRoute({ view: 'architecture' })
          window.location.hash = ARCHITECTURE_HASH
        }}
        onCreateWorkspaceTab={(options) => openWorkspaceTab(currentContextSessionId, options)}
        onCreateTerminalTab={(options) => openTerminalTab(currentContextSessionId, options)}
        onCreateSession={handleCreateSession}
      />
      <div className="flex-1 h-screen overflow-hidden">
        {route.view === 'architecture' ? (
          <ArchitectureView sessions={sessions} currentSession={currentContextSessionId} onSelectSession={openChatTab} />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <WorkbenchTabs
              tabs={workbenchTabs.filter((tab) => tab.sessionId === route.sessionId)}
              activeTabId={route.tabId}
              onSelectTab={(tabId) => {
                const tab = workbenchTabs.find((item) => item.id === tabId)
                if (tab) navigateToSession(tab.sessionId, tab.id)
              }}
              onCloseTab={(tabId) => { void closeWorkbenchTab(tabId) }}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {renderSessionContent()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App