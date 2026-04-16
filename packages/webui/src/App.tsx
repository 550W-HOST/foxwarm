import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import Chat from './components/Chat'
import ArchitectureView from './components/ArchitectureView'
import SessionList from './components/SessionList'
import Sidebar from './components/Sidebar'
import TerminalView from './components/TerminalView'
import WorkspaceView from './components/WorkspaceView'
import FileEditorView from './components/FileEditorView'
import WorkbenchLayout from './components/WorkbenchLayout'
import WorkbenchPane from './components/WorkbenchPane'
import type { SendKeyMode } from './components/chatShared'
import type { Session } from './components/SessionListCore'
import { API_BASE_PATH } from './config'
import { useWorkbenchStore } from './workbench/store'
import type { WorkbenchTab } from './workbench/types'
import { findPaneNode, getFlattenedTabIds, getPaneIds, getPaneNodes } from './workbench/utils'

type ThemeMode = 'auto' | 'light' | 'dark'
type AppView = 'session' | 'agents'

type RouteState =
  | { view: 'agents' }
  | { view: 'tab'; tabId: string | null }

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
const ARCHITECTURE_HASH = 'agents'
const TAB_HASH_PREFIX = 'tab/'
const LAST_VISITED_SESSION_STORAGE_KEY = 'foxwarm_last_visited_session_v1'
const LAST_ACTIVE_TAB_STORAGE_KEY = 'foxwarm_last_active_tab_v1'
const PREVIEW_CHAT_TAB_ID = 'chat:__preview__'

function isChatTab(tab: WorkbenchTab): tab is Extract<WorkbenchTab, { type: 'chat' }> {
  return tab.type === 'chat'
}

function isPreviewChatTab(tab: WorkbenchTab): tab is Extract<WorkbenchTab, { type: 'chat' }> {
  return tab.type === 'chat' && !!tab.preview
}

function getPersistentChatTabId(sessionId: string) {
  return `chat:${sessionId}`
}

function loadStoredLastVisitedSession(): string {
  try {
    return localStorage.getItem(LAST_VISITED_SESSION_STORAGE_KEY) || 'main'
  } catch {
    return 'main'
  }
}

function loadStoredLastActiveTabId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_TAB_STORAGE_KEY)
  } catch {
    return null
  }
}

function getHashState(): RouteState {
  const hash = decodeURIComponent(window.location.hash.slice(1))
  const fallbackTabId = loadStoredLastActiveTabId()

  if (!hash || hash.startsWith('token=')) {
    return { view: 'tab', tabId: fallbackTabId }
  }

  if (hash === ARCHITECTURE_HASH || hash === '__architecture__' || hash === 'architecture') {
    return { view: 'agents' }
  }

  if (hash.startsWith(TAB_HASH_PREFIX)) {
    return { view: 'tab', tabId: hash.slice(TAB_HASH_PREFIX.length) || fallbackTabId }
  }

  if (hash.startsWith('session/')) {
    const remainder = hash.slice('session/'.length)
    const [sessionIdPart, queryPart = ''] = remainder.split('?')
    const params = new URLSearchParams(queryPart)
    const explicitTabId = params.get('tab')
    if (explicitTabId) {
      return { view: 'tab', tabId: explicitTabId }
    }
    const sessionId = sessionIdPart || loadStoredLastVisitedSession()
    return { view: 'tab', tabId: `chat:${sessionId}` }
  }

  if (hash.startsWith('__workspace__:')) {
    const sessionId = hash.slice('__workspace__:'.length) || loadStoredLastVisitedSession()
    return { view: 'tab', tabId: `chat:${sessionId}` }
  }

  if (hash.startsWith('__terminal__:')) {
    const remainder = hash.slice('__terminal__:'.length)
    const [sessionIdPart] = remainder.split('?')
    const sessionId = sessionIdPart || loadStoredLastVisitedSession()
    return { view: 'tab', tabId: `chat:${sessionId}` }
  }

  return { view: 'tab', tabId: `chat:${hash}` }
}

function setTabHash(tabId?: string | null) {
  if (!tabId) {
    window.location.hash = ''
    return
  }
  window.location.hash = `${TAB_HASH_PREFIX}${encodeURIComponent(tabId)}`
}

function makeChatTab(sessionId: string, title: string, options?: { preview?: boolean; pinned?: boolean }): WorkbenchTab {
  return {
    id: options?.preview ? PREVIEW_CHAT_TAB_ID : getPersistentChatTabId(sessionId),
    type: 'chat',
    sessionId,
    title,
    preview: !!options?.preview,
    pinned: options?.preview ? false : options?.pinned,
  }
}

function makeWorkspaceTab(sessionId: string, nodeId: string, path: string): WorkbenchTab {
  return {
    id: `workspace:${nodeId}:${path}`,
    type: 'workspace',
    nodeId,
    path,
    contextSessionId: sessionId,
    title: `Workspace · ${path}`,
  }
}

function makeFileTab(sessionId: string, nodeId: string, path: string): WorkbenchTab {
  return {
    id: `file:${nodeId}:${path}`,
    type: 'file',
    nodeId,
    path,
    contextSessionId: sessionId,
    title: path.split('/').pop() || path,
  }
}

function makeTerminalDraftTab(sessionId: string, nodeId: string, cwd: string): WorkbenchTab {
  return {
    id: `terminal-draft:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    type: 'terminal',
    nodeId,
    cwd,
    contextSessionId: sessionId,
    createMode: 'new',
    title: `Terminal · ${cwd}`,
  }
}

function makeTerminalTabFromRecord(record: TerminalRegistryRecord): WorkbenchTab {
  return {
    id: `terminal:${record.id}`,
    type: 'terminal',
    terminalId: record.id,
    nodeId: record.nodeId,
    cwd: record.cwd,
    contextSessionId: record.sessionId,
    title: `Terminal · ${record.cwd}`,
  }
}

function App() {
  const initialRoute = getHashState()

  const [sessions, setSessions] = useState<Session[]>([])
  const [route, setRoute] = useState<RouteState>(initialRoute)
  const [activeTerminals, setActiveTerminals] = useState<TerminalRegistryRecord[]>([])
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [showSessionList, setShowSessionList] = useState<boolean>(() => !window.location.hash)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('themeMode')
    return saved === 'auto' || saved === 'light' || saved === 'dark' ? saved : 'auto'
  })
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(() => {
    const saved = localStorage.getItem('sendKeyMode')
    return saved === 'enter' || saved === 'mod-enter' ? saved : 'mod-enter'
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  const tabsById = useWorkbenchStore((state) => state.tabsById)
  const root = useWorkbenchStore((state) => state.root)
  const focusedPaneId = useWorkbenchStore((state) => state.focusedPaneId)
  const focusPane = useWorkbenchStore((state) => state.focusPane)
  const activateTab = useWorkbenchStore((state) => state.activateTab)
  const upsertTab = useWorkbenchStore((state) => state.upsertTab)
  const updateTab = useWorkbenchStore((state) => state.updateTab)
  const removeTab = useWorkbenchStore((state) => state.removeTab)
  const replaceTabId = useWorkbenchStore((state) => state.replaceTabId)
  const moveTabToPane = useWorkbenchStore((state) => state.moveTabToPane)
  const dockTabToPaneEdge = useWorkbenchStore((state) => state.dockTabToPaneEdge)
  const reorderTabs = useWorkbenchStore((state) => state.reorderTabs)
  const splitPaneWithTab = useWorkbenchStore((state) => state.splitPaneWithTab)
  const closePane = useWorkbenchStore((state) => state.closePane)
  const updateSplitSizes = useWorkbenchStore((state) => state.updateSplitSizes)

  const darkMode = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)

  const globalSSERef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectDelayRef = useRef<number>(1000)
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const allTabs = useMemo(() => Object.values(tabsById), [tabsById])
  const paneNodes = useMemo(() => getPaneNodes(root), [root])
  const paneIds = useMemo(() => getPaneIds(root), [root])
  const flattenedTabIds = useMemo(() => getFlattenedTabIds(root), [root])
  const focusedPane = useMemo(() => (focusedPaneId ? findPaneNode(root, focusedPaneId) : null), [root, focusedPaneId])
  const focusedActiveTabId = focusedPane?.activeTabId || paneNodes[0]?.activeTabId || null
  const focusedActiveTab = focusedActiveTabId ? (tabsById[focusedActiveTabId] || null) : null

  const sessionTitle = (sessionId: string) => sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))?.displayName || sessionId

  const currentContextSessionId = focusedActiveTab?.type === 'chat'
    ? focusedActiveTab.sessionId
    : focusedActiveTab?.contextSessionId || loadStoredLastVisitedSession()
  const currentContextSessionRecord = sessions.find((session) => session.id === currentContextSessionId || session.aliases?.includes(currentContextSessionId))
  const currentView: AppView = route.view === 'agents' ? 'agents' : 'session'
  const busyCount = useMemo(() => sessions.filter((session) => session.busy).length, [sessions])

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
    localStorage.setItem('sendKeyMode', sendKeyMode)
  }, [sendKeyMode])

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
    allTabs.forEach((tab) => {
      if (!isChatTab(tab)) return
      const nextTitle = sessionTitle(tab.sessionId)
      if (tab.title !== nextTitle) {
        updateTab(tab.id, (current) => isChatTab(current) ? { ...current, title: nextTitle } : current)
      }
    })
  }, [allTabs, sessions])

  useEffect(() => {
    const activeTerminalMap = new Map(activeTerminals.map((terminal) => [terminal.id, terminal]))
    const terminalTabs = allTabs.filter((tab): tab is Extract<WorkbenchTab, { type: 'terminal' }> => tab.type === 'terminal')

    terminalTabs.forEach((tab) => {
      if (!tab.terminalId) return
      const terminal = activeTerminalMap.get(tab.terminalId)
      if (!terminal) {
        removeTab(tab.id)
        return
      }

      const nextTitle = `Terminal · ${terminal.cwd}`
      if (tab.title !== nextTitle || tab.cwd !== terminal.cwd || tab.nodeId !== terminal.nodeId || tab.contextSessionId !== terminal.sessionId || tab.createMode) {
        updateTab(tab.id, (current) => current.type === 'terminal'
          ? {
              ...current,
              title: nextTitle,
              cwd: terminal.cwd,
              nodeId: terminal.nodeId,
              terminalId: terminal.id,
              contextSessionId: terminal.sessionId,
              createMode: undefined,
            }
          : current)
      }
    })

    activeTerminals.forEach((terminal) => {
      const existing = terminalTabs.find((tab) => tab.terminalId === terminal.id)
      if (!existing) {
        upsertTab(makeTerminalTabFromRecord(terminal), { activate: false })
      }
    })
  }, [activeTerminals, allTabs])

  useEffect(() => {
    const baseTitle = '🦊 Foxwarm'
    document.title = busyCount > 0 ? `[${busyCount} busy] ${baseTitle}` : baseTitle
  }, [busyCount])

  useEffect(() => {
    if (route.view !== 'tab') return
    if (route.tabId && tabsById[route.tabId] && route.tabId !== focusedActiveTabId) {
      activateTab(route.tabId)
    }
  }, [route, tabsById, focusedActiveTabId, activateTab])

  useEffect(() => {
    if (focusedActiveTabId) {
      localStorage.setItem(LAST_ACTIVE_TAB_STORAGE_KEY, focusedActiveTabId)
    }
  }, [focusedActiveTabId])

  useEffect(() => {
    const sessionId = focusedActiveTab?.type === 'chat' ? focusedActiveTab.sessionId : focusedActiveTab?.contextSessionId
    if (sessionId) {
      localStorage.setItem(LAST_VISITED_SESSION_STORAGE_KEY, sessionId)
    }
  }, [focusedActiveTab])

  useEffect(() => {
    if (route.view !== 'tab') {
      return
    }

    if (route.tabId && tabsById[route.tabId]) {
      return
    }

    if (focusedActiveTabId) {
      setRoute({ view: 'tab', tabId: focusedActiveTabId })
      setTabHash(focusedActiveTabId)
    }
  }, [route, tabsById, focusedActiveTabId])

  useEffect(() => {
    if (route.view !== 'tab') return
    if (flattenedTabIds.length > 0) return

    const fallbackSessionId = loadStoredLastVisitedSession()
    const tab = makeChatTab(fallbackSessionId, sessionTitle(fallbackSessionId), { preview: true })
    upsertTab(tab, { paneId: focusedPaneId || paneIds[0], activate: true })
    setRoute({ view: 'tab', tabId: tab.id })
    setTabHash(tab.id)
  }, [route.view, flattenedTabIds.length, focusedPaneId, paneIds.join('|')])

  const navigateToTab = (tabId: string) => {
    activateTab(tabId)
    setRoute({ view: 'tab', tabId })
    setTabHash(tabId)
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const findPreferredChatTab = (sessionId: string): WorkbenchTab | null => {
    return allTabs.find((tab) => isChatTab(tab) && !tab.preview && tab.pinned && tab.sessionId === sessionId)
      || allTabs.find((tab) => isChatTab(tab) && !tab.preview && tab.sessionId === sessionId)
      || null
  }

  const openChatTab = (sessionId: string) => {
    const title = sessionTitle(sessionId)
    const existingTab = findPreferredChatTab(sessionId)

    if (existingTab) {
      if (existingTab.title !== title) {
        updateTab(existingTab.id, (current) => isChatTab(current) ? { ...current, title } : current)
      }
      navigateToTab(existingTab.id)
      return
    }

    const previewTab = allTabs.find(isPreviewChatTab)
    if (previewTab) {
      updateTab(previewTab.id, (current) => isPreviewChatTab(current)
        ? { ...current, sessionId, title, preview: true, pinned: false }
        : current)
      navigateToTab(previewTab.id)
      return
    }

    const tab = makeChatTab(sessionId, title, { preview: true })
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openKeptChatTab = (sessionId: string) => {
    const title = sessionTitle(sessionId)
    const existingTab = findPreferredChatTab(sessionId)

    if (existingTab) {
      if (existingTab.title !== title) {
        updateTab(existingTab.id, (current) => isChatTab(current) ? { ...current, title } : current)
      }
      navigateToTab(existingTab.id)
      return
    }

    const previewTab = allTabs.find((tab) => isPreviewChatTab(tab) && tab.sessionId === sessionId)
    if (previewTab) {
      const persistentTab = makeChatTab(sessionId, title)
      replaceTabId(previewTab.id, persistentTab)
      navigateToTab(persistentTab.id)
      return
    }

    const tab = makeChatTab(sessionId, title)
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openWorkspaceTab = (sessionId: string, options?: { nodeId?: string; path?: string }) => {
    const sessionRecord = sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))
    const nodeId = options?.nodeId || sessionRecord?.currentNode || 'master'
    const path = options?.path || sessionRecord?.cwd || '/'
    const tab = makeWorkspaceTab(sessionId, nodeId, path)
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openFileTab = (sessionId: string, nodeId: string, path: string) => {
    const tab = makeFileTab(sessionId, nodeId, path)
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openTerminalTab = (sessionId: string, options?: { nodeId?: string; path?: string; terminalId?: string }) => {
    if (options?.terminalId) {
      const existing = allTabs.find((tab) => tab.type === 'terminal' && tab.terminalId === options.terminalId)
      const terminal = activeTerminals.find((item) => item.id === options.terminalId)
      const tab = existing || (terminal ? makeTerminalTabFromRecord(terminal) : null)
      if (tab) {
        upsertTab(tab, { activate: true })
        navigateToTab(tab.id)
      }
      return
    }

    const sessionRecord = sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))
    const nodeId = options?.nodeId || sessionRecord?.currentNode || 'master'
    const path = options?.path || sessionRecord?.cwd || '/'
    const tab = makeTerminalDraftTab(sessionId, nodeId, path)
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const closeWorkbenchTab = async (tabId: string) => {
    const targetTab = tabsById[tabId] || null
    if (targetTab?.type === 'terminal' && targetTab.terminalId) {
      try {
        await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(targetTab.terminalId)}`, { method: 'DELETE' })
      } catch (error) {
        console.error('Failed to close terminal:', error)
      }
      await fetchActiveTerminals()
    }

    removeTab(tabId)
  }

  const keepWorkbenchTab = (tabId: string) => {
    const targetTab = tabsById[tabId]
    if (!targetTab || !isPreviewChatTab(targetTab)) {
      return
    }

    const persistentId = getPersistentChatTabId(targetTab.sessionId)
    const existingTab = tabsById[persistentId]

    if (existingTab) {
      removeTab(tabId)
      navigateToTab(existingTab.id)
      return
    }

    const persistentTab = makeChatTab(targetTab.sessionId, sessionTitle(targetTab.sessionId), { pinned: !!targetTab.pinned })
    replaceTabId(tabId, persistentTab)
    navigateToTab(persistentTab.id)
  }

  const pinWorkbenchTab = (tabId: string) => {
    const targetTab = tabsById[tabId]
    if (!targetTab) {
      return
    }

    if (isPreviewChatTab(targetTab)) {
      const persistentId = getPersistentChatTabId(targetTab.sessionId)
      const existingTab = tabsById[persistentId]
      if (existingTab) {
        updateTab(existingTab.id, (current) => ({ ...current, pinned: true }))
        removeTab(tabId)
        navigateToTab(existingTab.id)
        return
      }

      const pinnedTab = makeChatTab(targetTab.sessionId, sessionTitle(targetTab.sessionId), { pinned: true })
      replaceTabId(tabId, pinnedTab)
      navigateToTab(pinnedTab.id)
      return
    }

    if (!targetTab.pinned) {
      updateTab(tabId, (current) => ({ ...current, pinned: true }))
    }
  }

  const unpinWorkbenchTab = (tabId: string) => {
    const targetTab = tabsById[tabId]
    if (!targetTab?.pinned) {
      return
    }
    updateTab(tabId, (current) => ({ ...current, pinned: false }))
  }

  const closePaneTabsByPredicate = async (paneId: string, predicate: (tab: WorkbenchTab) => boolean) => {
    const pane = findPaneNode(root, paneId)
    if (!pane) return

    const tabsToClose = pane.tabIds
      .map((tabId) => tabsById[tabId])
      .filter((tab): tab is WorkbenchTab => !!tab)
      .filter(predicate)

    for (const tab of tabsToClose) {
      await closeWorkbenchTab(tab.id)
    }
  }

  const handleChatDraftEdited = (tabId: string) => {
    const targetTab = tabsById[tabId]
    if (targetTab && isPreviewChatTab(targetTab)) {
      keepWorkbenchTab(tabId)
    }
  }

  const handleTerminalReady = (draftTabId: string, terminal: { id: string; sessionId: string; cwd: string; nodeId?: string }) => {
    const draftTab = tabsById[draftTabId]
    const nextId = `terminal:${terminal.id}`
    replaceTabId(draftTabId, {
      id: nextId,
      type: 'terminal',
      terminalId: terminal.id,
      nodeId: terminal.nodeId || 'master',
      cwd: terminal.cwd,
      contextSessionId: terminal.sessionId,
      title: `Terminal · ${terminal.cwd}`,
      pinned: draftTab?.pinned,
    })
    navigateToTab(nextId)
    void fetchActiveTerminals()
  }

  const handleTerminalClosed = (terminalId: string) => {
    const target = allTabs.find((tab) => tab.type === 'terminal' && tab.terminalId === terminalId)
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
        const activeTab = focusedActiveTab
        const sessionId = activeTab?.type === 'chat' ? activeTab.sessionId : activeTab?.contextSessionId
        if (!sessionId) return
        void fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
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
  }, [focusedActiveTab, sessions])

  const renderTabContent = (tab: WorkbenchTab, onBack?: () => void) => {
    if (tab.type === 'chat') {
      const sessionRecord = sessions.find((session) => session.id === tab.sessionId || session.aliases?.includes(tab.sessionId))
      return (
        <Chat
          key={`chat:${tab.sessionId}`}
          sessionId={tab.sessionId}
          sessionDisplayName={sessionRecord?.displayName}
          onBack={onBack}
          sendKeyMode={sendKeyMode}
          onToggleSendKeyMode={() => setSendKeyMode((current) => current === 'enter' ? 'mod-enter' : 'enter')}
          onOpenWorkspace={() => openWorkspaceTab(tab.sessionId)}
          onOpenTerminal={() => openTerminalTab(tab.sessionId)}
          onDraftEdited={() => handleChatDraftEdited(tab.id)}
        />
      )
    }

    if (tab.type === 'workspace') {
      const sessionId = tab.contextSessionId || currentContextSessionId
      return (
        <WorkspaceView
          key={tab.id}
          initialNodeId={tab.nodeId}
          initialPath={tab.path}
          onBack={onBack}
          onOpenTerminal={(cwd) => openTerminalTab(sessionId, { nodeId: tab.nodeId, path: cwd || tab.path })}
          onOpenFile={(nodeId, path) => openFileTab(sessionId, nodeId, path)}
        />
      )
    }

    if (tab.type === 'file') {
      const sessionId = tab.contextSessionId || currentContextSessionId
      return (
        <FileEditorView
          key={tab.id}
          nodeId={tab.nodeId}
          filePath={tab.path}
          onBack={onBack}
          onOpenTerminal={(cwd) => openTerminalTab(sessionId, { nodeId: tab.nodeId, path: cwd || tab.path.split('/').slice(0, -1).join('/') || '/' })}
          onOpenFileTab={(nodeId, path) => openFileTab(sessionId, nodeId, path)}
        />
      )
    }

    const sessionId = tab.contextSessionId || currentContextSessionId
    return (
      <TerminalView
        key={tab.id}
        sessionId={sessionId}
        initialCwd={tab.cwd}
        initialTerminalId={tab.terminalId}
        createMode={tab.createMode || 'reuse'}
        onBack={onBack}
        onSessionsChanged={() => { void fetchSessions() }}
        onTerminalReady={(terminal) => handleTerminalReady(tab.id, terminal)}
        onTerminalClosed={handleTerminalClosed}
        onOpenWorkspace={(cwd) => openWorkspaceTab(sessionId, { nodeId: tab.nodeId, path: cwd || tab.cwd || '/' })}
      />
    )
  }

  const renderPane = (paneId: string, onBack?: () => void) => {
    const pane = findPaneNode(root, paneId)
    if (!pane) {
      return null
    }

    const paneTabs = pane.tabIds
      .map((tabId) => tabsById[tabId])
      .filter((tab): tab is WorkbenchTab => !!tab)
    const activeTab = pane.activeTabId ? (tabsById[pane.activeTabId] || null) : null
    const otherPaneIds = paneIds.filter((id) => id !== paneId)

    const handleFocus = (targetPaneId: string) => {
      focusPane(targetPaneId)
      const active = findPaneNode(useWorkbenchStore.getState().root, targetPaneId)?.activeTabId
      if (active) {
        navigateToTab(active)
      }
    }

    const handleSplit = (edge: 'right' | 'bottom') => {
      if (!pane.activeTabId) return
      const createdPaneId = splitPaneWithTab(paneId, pane.activeTabId, edge)
      if (createdPaneId) {
        navigateToTab(pane.activeTabId)
      }
    }

    const handleMoveActiveTab = () => {
      if (!pane.activeTabId || otherPaneIds.length === 0) return
      const targetPaneId = otherPaneIds[0]
      moveTabToPane(pane.activeTabId, targetPaneId, { activate: true })
      navigateToTab(pane.activeTabId)
    }

    const handleClosePane = () => {
      if (otherPaneIds.length === 0) return
      if (pane.tabIds.length > 0) {
        pane.tabIds.forEach((tabId, index) => {
          moveTabToPane(tabId, otherPaneIds[0], { activate: index === pane.tabIds.length - 1 })
        })
      }
      closePane(paneId)
      const nextActive = findPaneNode(useWorkbenchStore.getState().root, otherPaneIds[0])?.activeTabId
      if (nextActive) {
        navigateToTab(nextActive)
      }
    }

    const content = activeTab
      ? renderTabContent(activeTab, onBack)
      : (
        <div className="flex h-full items-center justify-center bg-gray-50 text-center text-sm text-gray-500 dark:bg-gray-950 dark:text-gray-400">
          <div className="max-w-sm space-y-2 px-6">
            <div className="text-base font-medium text-gray-700 dark:text-gray-200">Empty pane</div>
            <div>Focus this pane and open a chat, workspace, file, or terminal from the sidebar/session list.</div>
          </div>
        </div>
      )

    return (
      <WorkbenchPane
        paneId={paneId}
        tabs={paneTabs}
        activeTabId={pane.activeTabId}
        focused={focusedPaneId === paneId}
        emphasizeFocus={paneIds.length > 1}
        dragEnabled={!isMobile}
        canClosePane={paneIds.length > 1}
        canMoveActiveTab={otherPaneIds.length > 0}
        content={content}
        onFocusPane={handleFocus}
        onSelectTab={navigateToTab}
        onCloseTab={(tabId) => { void closeWorkbenchTab(tabId) }}
        onKeepTab={keepWorkbenchTab}
        onPinTab={pinWorkbenchTab}
        onUnpinTab={unpinWorkbenchTab}
        onCloseAllTabs={() => { void closePaneTabsByPredicate(paneId, () => true) }}
        onCloseAllPinnedTabs={() => { void closePaneTabsByPredicate(paneId, (tab) => !!tab.pinned) }}
        onSplitRight={() => handleSplit('right')}
        onSplitDown={() => handleSplit('bottom')}
        onMoveActiveTab={handleMoveActiveTab}
        onClosePane={handleClosePane}
      />
    )
  }

  const draggingTab = draggingTabId ? (tabsById[draggingTabId] || null) : null

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id)
    setDraggingTabId(activeId)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = event.over?.id ? String(event.over.id) : null
    const activeData = event.active.data.current as { type?: string; paneId?: string; pinned?: boolean } | undefined
    const overData = event.over?.data.current as { type?: string; paneId?: string; pinned?: boolean; edge?: 'left' | 'right' | 'top' | 'bottom' } | undefined

    setDraggingTabId(null)

    if (!overId || !activeData || activeData.type !== 'tab') {
      return
    }

    if (overData?.type === 'tab' && overData.paneId) {
      if (activeData.paneId === overData.paneId) {
        if (activeData.pinned === overData.pinned && activeId !== overId) {
          reorderTabs(overData.paneId, activeId, overId)
        }
        return
      }

      moveTabToPane(activeId, overData.paneId, { beforeTabId: overId, activate: true })
      navigateToTab(activeId)
      return
    }

    if (overData?.type === 'pane-center' && overData.paneId) {
      if (activeData.paneId !== overData.paneId) {
        moveTabToPane(activeId, overData.paneId, { activate: true })
        navigateToTab(activeId)
      }
      return
    }

    if (overData?.type === 'tab-row' && overData.paneId) {
      const nextPinned = !!overData.pinned
      const targetPane = findPaneNode(root, overData.paneId)
      if (!targetPane) {
        return
      }

      if (activeData.paneId === overData.paneId && !!activeData.pinned === nextPinned) {
        return
      }

      const beforeTabId = nextPinned
        ? targetPane.tabIds.find((tabId) => {
            if (tabId === activeId) return false
            return !(tabsById[tabId]?.pinned)
          }) || null
        : null

      if (!!activeData.pinned !== nextPinned) {
        updateTab(activeId, (current) => ({ ...current, pinned: nextPinned }))
      }

      moveTabToPane(activeId, overData.paneId, { beforeTabId, activate: true })
      navigateToTab(activeId)
      return
    }

    if (overData?.type === 'pane-edge' && overData.paneId && overData.edge) {
      if (overData.edge === 'top') {
        return
      }
      dockTabToPaneEdge(activeId, overData.paneId, overData.edge)
      navigateToTab(activeId)
    }
  }

  const handleDragCancel = () => {
    setDraggingTabId(null)
  }

  const renderWorkbenchSurface = (content: ReactNode) => (
    <DndContext
      sensors={dragSensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {content}
      <DragOverlay>
        {draggingTab ? (
          <div className="inline-flex max-w-[24rem] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
            <span className="truncate">{draggingTab.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )

  if (isMobile) {
    if (showSessionList) {
      return (
        <SessionList
          sessions={sessions}
          currentSession={currentContextSessionId}
          currentView={currentView}
          currentSessionRecord={currentContextSessionRecord}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
          sendKeyMode={sendKeyMode}
          onSendKeyModeChange={setSendKeyMode}
          onSelectSession={openChatTab}
          onKeepSession={openKeptChatTab}
          onSelectArchitecture={() => {
            setRoute({ view: 'agents' })
            window.location.hash = ARCHITECTURE_HASH
            setShowSessionList(false)
          }}
          onCreateWorkspaceTab={(options) => openWorkspaceTab(currentContextSessionId, options)}
          onCreateTerminalTab={(options) => openTerminalTab(currentContextSessionId, options)}
          onCreateSession={handleCreateSession}
        />
      )
    }

    if (route.view === 'agents') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <ArchitectureView sessions={sessions} currentSession={currentContextSessionId} onSelectSession={openChatTab} onBack={handleBackToList} />
        </div>
      )
    }

    const mobilePaneId = focusedPaneId || paneIds[0]

    return (
      <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden p-0">
          {renderWorkbenchSurface(mobilePaneId ? renderPane(mobilePaneId, handleBackToList) : null)}
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
        currentSessionRecord={currentContextSessionRecord}
        themeMode={themeMode}
        onThemeChange={setThemeMode}
        sendKeyMode={sendKeyMode}
        onSendKeyModeChange={setSendKeyMode}
        onSelectSession={openChatTab}
        onKeepSession={openKeptChatTab}
        onSelectArchitecture={() => {
          setRoute({ view: 'agents' })
          window.location.hash = ARCHITECTURE_HASH
        }}
        onCreateWorkspaceTab={(options) => openWorkspaceTab(currentContextSessionId, options)}
        onCreateTerminalTab={(options) => openTerminalTab(currentContextSessionId, options)}
        onCreateSession={handleCreateSession}
      />
      <div className="flex-1 h-screen overflow-hidden">
        {route.view === 'agents' ? (
          <ArchitectureView sessions={sessions} currentSession={currentContextSessionId} onSelectSession={openChatTab} />
        ) : (
          <div className="h-full min-h-0 overflow-hidden">
            {renderWorkbenchSurface(
              <WorkbenchLayout
                node={root}
                renderPane={(paneId) => renderPane(paneId)}
                onLayoutResize={updateSplitSizes}
              />,
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
