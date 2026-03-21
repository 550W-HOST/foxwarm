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
type AppView = 'workbench' | 'architecture' | 'workspace'
type ActiveWorkbenchTabType = WorkbenchTab['type'] | null
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
const ARCHITECTURE_HASH = '__architecture__'
const WORKSPACE_HASH_PREFIX = '__workspace__:'
const WORKBENCH_TABS_STORAGE_KEY = 'foxwarm_workbench_tabs_v1'
const WORKBENCH_ACTIVE_TAB_STORAGE_KEY = 'foxwarm_workbench_active_tab_v1'

const getHashState = (): { view: AppView; sessionId: string } => {
  const hash = decodeURIComponent(window.location.hash.slice(1))

  if (!hash || hash.startsWith('token=')) {
    return { view: 'workbench', sessionId: 'main' }
  }

  if (hash === ARCHITECTURE_HASH) {
    return { view: 'architecture', sessionId: 'main' }
  }

  if (hash.startsWith(WORKSPACE_HASH_PREFIX)) {
    const sessionId = hash.slice(WORKSPACE_HASH_PREFIX.length) || 'main'
    return { view: 'workspace', sessionId }
  }

  return { view: 'workbench', sessionId: hash }
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
      if (item.type === 'file') return typeof item.nodeId === 'string' && typeof item.path === 'string'
      if (item.type === 'terminal') return true
      return false
    })
  } catch {
    return []
  }
}

function loadStoredActiveTabId(): string | null {
  try {
    return localStorage.getItem(WORKBENCH_ACTIVE_TAB_STORAGE_KEY)
  } catch {
    return null
  }
}

function makeChatTab(sessionId: string, title: string): WorkbenchTab {
  return { id: `chat:${sessionId}`, type: 'chat', sessionId, title }
}

function makeFileTab(sessionId: string, nodeId: string, filePath: string): WorkbenchTab {
  const title = filePath.split('/').pop() || filePath
  return { id: `file:${nodeId}:${filePath}`, type: 'file', sessionId, nodeId, path: filePath, title }
}

function makeTerminalDraftTab(sessionId: string, cwd?: string): WorkbenchTab {
  return {
    id: `terminal-draft:${sessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    type: 'terminal',
    sessionId,
    cwd,
    title: cwd ? `Terminal · ${cwd}` : 'Terminal',
  }
}

function makeTerminalTabFromRecord(record: TerminalRegistryRecord): WorkbenchTab {
  return {
    id: `terminal:${record.id}`,
    type: 'terminal',
    sessionId: record.sessionId,
    terminalId: record.id,
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
      cwd: terminal.cwd,
      title: `Terminal · ${terminal.cwd}`,
    })
    seenTerminalIds.add(terminal.id)
  }

  for (const terminal of terminals) {
    if (seenTerminalIds.has(terminal.id)) {
      continue
    }
    merged.push(makeTerminalTabFromRecord(terminal))
  }

  return merged
}

function App() {
  const initialHashState = getHashState()

  const [sessions, setSessions] = useState<Session[]>([])
  const [currentView, setCurrentView] = useState<AppView>(initialHashState.view)
  const [currentSession, setCurrentSession] = useState<string>(initialHashState.sessionId)
  const [workbenchTabs, setWorkbenchTabs] = useState<WorkbenchTab[]>(() => loadStoredWorkbenchTabs())
  const [activeWorkbenchTabId, setActiveWorkbenchTabId] = useState<string | null>(() => loadStoredActiveTabId())
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
    const handleChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches)
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
    if (activeWorkbenchTabId) {
      localStorage.setItem(WORKBENCH_ACTIVE_TAB_STORAGE_KEY, activeWorkbenchTabId)
    } else {
      localStorage.removeItem(WORKBENCH_ACTIVE_TAB_STORAGE_KEY)
    }
  }, [activeWorkbenchTabId])

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
        }
      } catch (e) {
        console.error('Failed to parse SSE message:', e)
      }
    }
    es.onerror = () => {
      es.close()
      if (es.readyState === EventSource.CLOSED) {
        const delay = Math.min(reconnectDelayRef.current, 30000)
        reconnectTimeoutRef.current = setTimeout(() => {
          void fetchSessions().then(() => connectGlobalSSE())
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
        }, delay)
      }
    }
    globalSSERef.current = es
  }

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions)
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e)
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
    } catch (e) {
      console.error('Failed to fetch terminals:', e)
      setActiveTerminals([])
    }
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
    const handleHashChange = () => {
      const nextState = getHashState()
      setCurrentView(nextState.view)
      setCurrentSession(nextState.sessionId)
      if (nextState.view === 'workbench') {
        ensureChatTab(nextState.sessionId, true)
      }
      if (isMobile) {
        setShowSessionList(!window.location.hash)
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [isMobile, sessions, workbenchTabs])

  const upsertWorkbenchTab = (tab: WorkbenchTab, activate: boolean = true) => {
    setWorkbenchTabs((previous) => {
      const index = previous.findIndex(item => item.id === tab.id)
      if (index >= 0) {
        const next = [...previous]
        next[index] = { ...next[index], ...tab }
        return next
      }
      return [...previous, tab]
    })
    if (activate) {
      setActiveWorkbenchTabId(tab.id)
    }
    return tab.id
  }

  const ensureChatTab = (sessionId: string, activate: boolean = true) => {
    const tab = makeChatTab(sessionId, sessionTitle(sessionId))
    upsertWorkbenchTab(tab, activate)
    return tab.id
  }

  useEffect(() => {
    if (currentView === 'workbench' && currentSession) {
      ensureChatTab(currentSession, activeWorkbenchTabId === null)
    }
  }, [currentView, currentSession])

  useEffect(() => {
    if (workbenchTabs.length === 0) {
      setActiveWorkbenchTabId(null)
      return
    }

    if (!activeWorkbenchTabId || !workbenchTabs.some((tab) => tab.id === activeWorkbenchTabId)) {
      setActiveWorkbenchTabId(workbenchTabs[0].id)
    }
  }, [workbenchTabs, activeWorkbenchTabId])

  useEffect(() => {
    setWorkbenchTabs((previous) => previous.map((tab) => (
      tab.type === 'chat' ? { ...tab, title: sessionTitle(tab.sessionId) } : tab
    )))
  }, [sessions])

  const openChatTab = (sessionId: string) => {
    window.location.hash = encodeURIComponent(sessionId)
    setCurrentView('workbench')
    setCurrentSession(sessionId)
    ensureChatTab(sessionId, true)
    if (isMobile) setShowSessionList(false)
  }

  const openFileTab = (sessionId: string, nodeId: string, filePath: string) => {
    const tab = makeFileTab(sessionId, nodeId, filePath)
    setCurrentView('workbench')
    setCurrentSession(sessionId)
    upsertWorkbenchTab(tab, true)
    if (isMobile) setShowSessionList(false)
  }

  const openTerminalTab = (sessionId: string, options: { terminalId?: string; cwd?: string } = {}) => {
    const existing = workbenchTabs.find((tab) => tab.type === 'terminal' && (
      (options.terminalId && tab.terminalId === options.terminalId) ||
      (!options.terminalId && tab.sessionId === sessionId && (tab.cwd === options.cwd || !options.cwd))
    ))

    const nextTab = existing || (options.terminalId
      ? { id: `terminal:${options.terminalId}`, type: 'terminal', sessionId, terminalId: options.terminalId, cwd: options.cwd, title: options.cwd ? `Terminal · ${options.cwd}` : 'Terminal' }
      : makeTerminalDraftTab(sessionId, options.cwd))

    setCurrentView('workbench')
    setCurrentSession(sessionId)
    upsertWorkbenchTab(nextTab, true)
    if (isMobile) setShowSessionList(false)
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
    }).catch((err) => {
      console.error('Failed to create session:', err)
      window.alert(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const handleBackToList = () => {
    window.location.hash = ''
    setShowSessionList(true)
    void fetchSessions()
  }

  useEffect(() => {
    const helper = {
      sendMessage: (message: string) => {
        if (!currentSession) return
        void fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(currentSession)}/message`, {
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
  }, [currentSession, workbenchTabs])

  const activeWorkbenchTab = useMemo(
    () => workbenchTabs.find((tab) => tab.id === activeWorkbenchTabId) || null,
    [workbenchTabs, activeWorkbenchTabId],
  )

  const activeSessionId = activeWorkbenchTab?.sessionId || currentSession
  const activeSessionRecord = sessions.find(session => session.id === activeSessionId || session.aliases?.includes(activeSessionId))
  const activeWorkbenchTabType: ActiveWorkbenchTabType = activeWorkbenchTab?.type || null

  const closeWorkbenchTab = async (tabId: string) => {
    const targetTab = workbenchTabs.find(tab => tab.id === tabId) || null
    if (targetTab?.type === 'terminal' && targetTab.terminalId) {
      try {
        await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(targetTab.terminalId)}`, { method: 'DELETE' })
      } catch (err) {
        console.error('Failed to close terminal:', err)
      }
      await fetchActiveTerminals()
    }

    setWorkbenchTabs((previous) => {
      const index = previous.findIndex(tab => tab.id === tabId)
      const next = previous.filter(tab => tab.id !== tabId)
      if (activeWorkbenchTabId === tabId) {
        const fallback = next[Math.max(0, index - 1)] || next[index] || null
        if (fallback) {
          setActiveWorkbenchTabId(fallback.id)
          setCurrentSession(fallback.sessionId)
          setCurrentView('workbench')
          window.location.hash = encodeURIComponent(fallback.sessionId)
        } else {
          const fallbackSessionId = currentSession || 'main'
          const chatTab = makeChatTab(fallbackSessionId, sessionTitle(fallbackSessionId))
          setActiveWorkbenchTabId(chatTab.id)
          setCurrentSession(fallbackSessionId)
          setCurrentView('workbench')
          window.location.hash = encodeURIComponent(fallbackSessionId)
          return [...next, chatTab]
        }
      }
      return next
    })
  }

  const handleSelectWorkbenchTab = (tabId: string) => {
    const tab = workbenchTabs.find(item => item.id === tabId)
    if (!tab) return
    setActiveWorkbenchTabId(tab.id)
    setCurrentSession(tab.sessionId)
    setCurrentView('workbench')
    window.location.hash = encodeURIComponent(tab.sessionId)
    if (isMobile) setShowSessionList(false)
  }

  const handleTerminalReady = (draftTabId: string, terminal: { id: string; sessionId: string; cwd: string }) => {
    setWorkbenchTabs((previous) => previous.map((tab) => {
      if (tab.id !== draftTabId) return tab
      return {
        id: `terminal:${terminal.id}`,
        type: 'terminal',
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
        cwd: terminal.cwd,
        title: `Terminal · ${terminal.cwd}`,
      }
    }))
    setActiveWorkbenchTabId((current) => current === draftTabId ? `terminal:${terminal.id}` : current)
    void fetchActiveTerminals()
  }

  const handleTerminalClosed = (terminalId: string) => {
    const tab = workbenchTabs.find(item => item.type === 'terminal' && item.terminalId === terminalId)
    if (tab) {
      closeWorkbenchTab(tab.id)
    }
    void fetchActiveTerminals()
  }

  const renderWorkbenchContent = (onBack?: () => void) => {
    if (!activeWorkbenchTab) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          No active tab.
        </div>
      )
    }

    if (activeWorkbenchTab.type === 'chat') {
      const sessionRecord = sessions.find(session => session.id === activeWorkbenchTab.sessionId || session.aliases?.includes(activeWorkbenchTab.sessionId))
      return (
        <Chat
          key={activeWorkbenchTab.id}
          sessionId={activeWorkbenchTab.sessionId}
          sessionDisplayName={sessionRecord?.displayName}
          onBack={onBack}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
        />
      )
    }

    if (activeWorkbenchTab.type === 'file') {
      const sessionRecord = sessions.find(session => session.id === activeWorkbenchTab.sessionId || session.aliases?.includes(activeWorkbenchTab.sessionId))
      return (
        <FileEditorView
          sessionId={activeWorkbenchTab.sessionId}
          session={sessionRecord}
          nodeId={activeWorkbenchTab.nodeId}
          filePath={activeWorkbenchTab.path}
          onBack={onBack}
          onSessionsChanged={() => { void fetchSessions() }}
          onOpenTerminal={(cwd) => openTerminalTab(activeWorkbenchTab.sessionId, { cwd })}
        />
      )
    }

    const sessionRecord = sessions.find(session => session.id === activeWorkbenchTab.sessionId || session.aliases?.includes(activeWorkbenchTab.sessionId))
    return (
      <TerminalView
        key={activeWorkbenchTab.id}
        sessionId={activeWorkbenchTab.sessionId}
        session={sessionRecord}
        initialCwd={activeWorkbenchTab.cwd}
        initialTerminalId={activeWorkbenchTab.terminalId}
        onBack={onBack}
        onSessionsChanged={() => { void fetchSessions() }}
        onTerminalReady={(terminal) => handleTerminalReady(activeWorkbenchTab.id, terminal)}
        onTerminalClosed={handleTerminalClosed}
      />
    )
  }

  if (isMobile) {
    if (showSessionList) {
      return (
        <SessionList
          sessions={sessions}
          currentSession={currentSession}
          currentView={currentView}
          activeWorkbenchTabType={activeWorkbenchTabType}
          onSelectSession={openChatTab}
          onSelectArchitecture={() => {
            window.location.hash = ARCHITECTURE_HASH
            setCurrentView('architecture')
            setShowSessionList(false)
          }}
          onSelectWorkspace={(sessionId) => {
            const target = sessionId || activeSessionId || 'main'
            window.location.hash = `${WORKSPACE_HASH_PREFIX}${encodeURIComponent(target)}`
            setCurrentView('workspace')
            setCurrentSession(target)
            setShowSessionList(false)
          }}
          onSelectTerminal={(sessionId) => openTerminalTab(sessionId || activeSessionId || 'main')}
          onCreateSession={handleCreateSession}
        />
      )
    }

    if (currentView === 'architecture') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <ArchitectureView sessions={sessions} currentSession={currentSession} onSelectSession={openChatTab} onBack={handleBackToList} />
        </div>
      )
    }

    if (currentView === 'workspace') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <WorkspaceView
            sessionId={currentSession}
            session={activeSessionRecord}
            onBack={handleBackToList}
            onSessionsChanged={() => { void fetchSessions() }}
            onOpenTerminal={(cwd) => openTerminalTab(currentSession, { cwd })}
            onOpenFile={(nodeId, filePath) => openFileTab(currentSession, nodeId, filePath)}
          />
        </div>
      )
    }

    return (
      <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <WorkbenchTabs tabs={workbenchTabs} activeTabId={activeWorkbenchTabId} onSelectTab={handleSelectWorkbenchTab} onCloseTab={closeWorkbenchTab} />
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderWorkbenchContent(handleBackToList)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
      <Sidebar
        sessions={sessions}
        currentSession={activeSessionId}
        currentView={currentView}
        activeWorkbenchTabType={activeWorkbenchTabType}
        onSelectSession={openChatTab}
        onSelectArchitecture={() => {
          window.location.hash = ARCHITECTURE_HASH
          setCurrentView('architecture')
        }}
        onSelectWorkspace={(sessionId) => {
          const target = sessionId || activeSessionId || 'main'
          window.location.hash = `${WORKSPACE_HASH_PREFIX}${encodeURIComponent(target)}`
          setCurrentView('workspace')
          setCurrentSession(target)
        }}
        onSelectTerminal={(sessionId) => openTerminalTab(sessionId || activeSessionId || 'main')}
        onCreateSession={handleCreateSession}
      />
      <div className="flex-1 h-screen overflow-hidden">
        {currentView === 'architecture' ? (
          <ArchitectureView sessions={sessions} currentSession={activeSessionId} onSelectSession={openChatTab} />
        ) : currentView === 'workspace' ? (
          <WorkspaceView
            sessionId={currentSession}
            session={activeSessionRecord}
            onSessionsChanged={() => { void fetchSessions() }}
            onOpenTerminal={(cwd) => openTerminalTab(currentSession, { cwd })}
            onOpenFile={(nodeId, filePath) => openFileTab(currentSession, nodeId, filePath)}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <WorkbenchTabs tabs={workbenchTabs} activeTabId={activeWorkbenchTabId} onSelectTab={handleSelectWorkbenchTab} onCloseTab={closeWorkbenchTab} />
            <div className="min-h-0 flex-1 overflow-hidden">
              {renderWorkbenchContent()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App