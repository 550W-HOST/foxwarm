import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import Chat from './components/Chat'
import SessionList from './components/SessionList'
import Sidebar from './components/Sidebar'
import CollapsedSidebar from './components/CollapsedSidebar'
import WorkbenchLayout from './components/WorkbenchLayout'
import WorkbenchPane from './components/WorkbenchPane'
import VscodeWebFrameHost, { type VscodeWebFrameHostHandle } from './components/VscodeWebFrameHost'
import type { SessionMoveRequest } from './components/SessionListCore'
import { API_BASE_PATH } from './config'
import { isSessionRuntimeActive } from './sessionRuntimeState'
import { selectVisibleSessionIds, shouldAcknowledgeSessionNavigation, type SessionNavigationOrigin } from './sessionIdleAttention'
import { useSessionIdleNotifications } from './sessionIdleNotifications'
import { useBoundedSessionList } from './boundedSessionList'
import { useWorkbenchStore } from './workbench/store'
import type { WorkbenchTab } from './workbench/types'
import { createWorkbenchId, findPaneBelow, findPaneContainingTab, findPaneNode, getFlattenedTabIds, getPaneIds, getPaneNodes } from './workbench/utils'
import { makeVscodeWebUrl, normalizeCodePath, planCodeOpen, readCodeOpenInNewWindowPreference, readCodeWorkspaceNodePreference, readCodeWorkspacePathPreference, resolveSessionCodeTarget, resolveToolCodeFileTarget, selectCodeFrameStarted, VSCODE_WEB_TAB_ID, writeCodeOpenInNewWindowPreference, writeCodeWorkspaceNodePreference, writeCodeWorkspacePathPreference, type CodeCommitTarget, type CodeFileTarget, type CodeTarget } from './vscodeWeb'
import { buildSessionCreationBody, type AgentSummary } from './agentCreation'
import { MASTER_NODE_TARGET, parseWebUiNodeTargets, type WebUiNodeTarget } from './nodeTargets'
import { findTerminalForTarget, normalizeTerminalTarget } from './terminalTarget'

type ThemeMode = 'auto' | 'light' | 'dark'
type UiThemeStyle = 'default' | '550a'
type AppView = 'session' | 'agents' | 'setup'
type SendKeyMode = 'modEnter' | 'enter'

type RouteState = { view: 'tab'; tabId: string | null }

type TerminalRegistryRecord = {
  id: string
  cwd: string
  nodeId: string
  shell: string
  pid: number
  createdAt: number
}

type WebUiSettings = {
  instanceName: string
  tabIcon: string
}

type ApiErrorPayload = {
  error?: string
  message?: string
  reason?: string
  code?: string
}

type ApiErrorDetails = {
  status: number
  statusText: string
  contentType: string
  payload: ApiErrorPayload | null
  text: string
}

const LIGHT_THEME_COLOR = '#f3f4f6'
const DARK_THEME_COLOR = '#111827'
const THEME_550A_LIGHT_COLOR = '#f4f3ef'
const THEME_550A_DARK_COLOR = '#0c0c0c'
const ARCHITECTURE_HASH = 'agents'
const SETUP_HASH = 'setup'
const TAB_HASH_PREFIX = 'tab/'
const AGENTS_TAB_ID = 'system:agents'
const SETUP_TAB_ID = 'system:setup'
const LAST_VISITED_SESSION_STORAGE_KEY = 'foxwarm_last_visited_session_v1'
const LAST_ACTIVE_TAB_STORAGE_KEY = 'foxwarm_last_active_tab_v1'
const SIDEBAR_WIDTH_STORAGE_KEY = 'foxwarm_sidebar_width_v1'
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'foxwarm_sidebar_collapsed_v1'
const UI_THEME_STYLE_STORAGE_KEY = 'foxwarm_ui_theme_style_v1'
const SEND_KEY_MODE_STORAGE_KEY = 'foxwarm_send_key_mode_v1'
const GROUP_TOOLS_STORAGE_KEY = 'foxwarm_group_tools_v1'
const SHOW_USAGE_BADGE_STORAGE_KEY = 'foxwarm_show_usage_badge_v1'
const FOXWARM_TOKEN_KEY = 'foxwarm_token'
const LEGACY_PREVIEW_CHAT_TAB_ID = 'chat:__preview__'
const CUSTOM_FAVICON_LINK_ID = 'foxwarm-custom-favicon'

type OriginalFaviconLink = {
  link: HTMLLinkElement
  rel: string
  href: string | null
  type: string | null
  sizes: string | null
}

let originalFaviconLinks: OriginalFaviconLink[] | null = null

const ArchitectureView = lazy(() => import('./components/ArchitectureView'))
const SetupView = lazy(() => import('./components/SetupView'))
const TerminalView = lazy(() => import('./components/TerminalView'))

function normalizeWebUiSettingsPayload(settings: unknown): WebUiSettings {
  const raw = settings && typeof settings === 'object' ? settings as Partial<WebUiSettings> : {}
  return {
    instanceName: typeof raw.instanceName === 'string' ? raw.instanceName : '',
    tabIcon: typeof raw.tabIcon === 'string' ? raw.tabIcon : '',
  }
}

function getStoredAuthToken() {
  try {
    return localStorage.getItem(FOXWARM_TOKEN_KEY)
  } catch {
    return null
  }
}

async function readApiErrorDetails(response: Response): Promise<ApiErrorDetails> {
  const contentType = response.headers.get('content-type') || ''
  let payload: ApiErrorPayload | null = null
  let text = ''

  if (contentType.includes('application/json')) {
    try {
      const parsed = await response.json()
      payload = parsed && typeof parsed === 'object' ? parsed as ApiErrorPayload : null
      text = payload?.error || payload?.message || payload?.reason || ''
    } catch {
      text = ''
    }
  } else {
    try {
      text = (await response.text()).trim()
    } catch {
      text = ''
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    contentType,
    payload,
    text,
  }
}

function formatSessionMoveError(details: ApiErrorDetails): string {
  const code = details.payload?.code || ''
  const backendMessage = details.payload?.error || details.payload?.message || details.payload?.reason || details.text
  const statusLabel = `${details.status} ${details.statusText}`.trim()

  if (details.status === 401) {
    return 'Could not reorganize the sidebar.\n\nReason: WebUI is not authorized. Refresh the page or sign in again, then retry.'
  }

  if (details.status === 404 && !code) {
    return `Could not reorganize the sidebar.\n\nReason: this Foxwarm backend does not seem to have the sidebar move API loaded yet (${statusLabel}).\n\nTry restarting Foxwarm and refreshing the WebUI.`
  }

  switch (code) {
    case 'PARENT_CYCLE_NOT_ALLOWED':
      return 'Could not move that session there.\n\nReason: it would create a parent/child loop. A parent session cannot be placed under one of its own descendants.'
    case 'SELF_PARENT_NOT_ALLOWED':
      return 'Could not move that session there.\n\nReason: a session cannot be assigned as a child of itself.'
    case 'SESSION_NOT_FOUND':
    case 'TARGET_PARENT_NOT_FOUND':
    case 'PARENTSESSIONID_NOT_FOUND':
    case 'BEFORESESSIONID_NOT_FOUND':
    case 'AFTERSESSIONID_NOT_FOUND':
      return 'Could not move that session.\n\nReason: one of the sessions involved no longer exists. Refresh the session list and try again.'
    case 'MULTIPLE_MOVE_ANCHORS':
    case 'POSITION_WITH_ANCHOR_NOT_ALLOWED':
    case 'INVALID_MOVE_POSITION':
    case 'ANCHOR_PARENT_MISMATCH':
    case 'BEFORE_ANCHOR_NOT_IN_TARGET_GROUP':
    case 'AFTER_ANCHOR_NOT_IN_TARGET_GROUP':
      return 'Could not interpret that drop target.\n\nTry dropping on the top or bottom edge to reorder, the center to make a child, or the root drop zone to detach.'
    default:
      if (backendMessage && !/^<!doctype html/i.test(backendMessage)) {
        return `Could not reorganize the sidebar.\n\nReason: ${backendMessage}\n\nStatus: ${statusLabel || 'request failed'}${code ? `\nCode: ${code}` : ''}`
      }
      return `Could not reorganize the sidebar.\n\nStatus: ${statusLabel || 'request failed'}\n\nTry refreshing the page; if this continues, restart Foxwarm so frontend and backend are on the same version.`
  }
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildSvgFaviconDataUrl(label: string): string | null {
  const trimmed = label.trim()
  if (!trimmed) return null

  try {
    const glyphCount = Array.from(trimmed).length
    const fontSize = glyphCount <= 1 ? 92 : glyphCount <= 2 ? 76 : glyphCount <= 4 ? 54 : 38
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">',
      '<rect width="128" height="128" fill="transparent"/>',
      `<text x="64" y="68" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${escapeSvgText(trimmed)}</text>`,
      '</svg>',
    ].join('')
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  } catch (error) {
    console.warn('Failed to build custom favicon', error)
    return null
  }
}

function applyCustomTabIcon(tabIcon: string) {
  const trimmed = tabIcon.trim()
  const customLink = document.getElementById(CUSTOM_FAVICON_LINK_ID)

  if (!trimmed) {
    customLink?.remove()
    originalFaviconLinks?.forEach((item) => {
      item.link.rel = item.rel
      if (item.href === null) item.link.removeAttribute('href')
      else item.link.href = item.href
      if (item.type === null) item.link.removeAttribute('type')
      else item.link.type = item.type
      if (item.sizes === null) item.link.removeAttribute('sizes')
      else item.link.setAttribute('sizes', item.sizes)
    })
    originalFaviconLinks = null
    return
  }

  const href = buildSvgFaviconDataUrl(trimmed)
  if (!href) {
    customLink?.remove()
    return
  }

  if (!originalFaviconLinks) {
    originalFaviconLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
      .filter((link) => link.id !== CUSTOM_FAVICON_LINK_ID)
      .map((link) => ({
        link,
        rel: link.rel,
        href: link.getAttribute('href'),
        type: link.getAttribute('type'),
        sizes: link.getAttribute('sizes'),
      }))
  }

  const link = customLink instanceof HTMLLinkElement ? customLink : document.createElement('link')
  link.id = CUSTOM_FAVICON_LINK_ID
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.sizes = 'any'
  link.href = href

  if (!link.parentNode) {
    document.head.appendChild(link)
  }

  // Some browsers keep using the first eligible favicon link instead of a new
  // one appended later, especially when the document already has multiple PNG
  // and SVG favicon candidates. Point every ordinary favicon candidate at the
  // same generated icon so the tab updates consistently.
  originalFaviconLinks.forEach((item) => {
    item.link.rel = 'icon'
    item.link.type = 'image/svg+xml'
    item.link.setAttribute('sizes', 'any')
    item.link.href = href
  })
}

function LazyViewFallback({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-gray-50 px-6 text-center text-sm text-gray-500 dark:bg-gray-950 dark:text-gray-400">
      <div>{label}</div>
    </div>
  )
}

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

function loadStoredCodePath(): string {
  return readCodeWorkspacePathPreference(localStorage)
}

function loadStoredCodeNodeId(): string {
  return readCodeWorkspaceNodePreference(localStorage)
}

function loadStoredCodeOpenInNewWindow(): boolean {
  return readCodeOpenInNewWindowPreference(localStorage)
}

function getHashState(): RouteState {
  const hash = decodeURIComponent(window.location.hash.slice(1))
  const fallbackTabId = loadStoredLastActiveTabId()

  if (!hash || hash.startsWith('token=')) {
    return { view: 'tab', tabId: fallbackTabId }
  }

  if (hash === ARCHITECTURE_HASH || hash === '__architecture__' || hash === 'architecture') {
    return { view: 'tab', tabId: AGENTS_TAB_ID }
  }

  if (hash === SETUP_HASH || hash === 'oobe') {
    return { view: 'tab', tabId: SETUP_TAB_ID }
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

function makePreviewChatTabId() {
  return createWorkbenchId('chatpreview')
}

function makeChatTab(sessionId: string, title: string, options?: { preview?: boolean }): WorkbenchTab {
  return {
    id: options?.preview ? makePreviewChatTabId() : getPersistentChatTabId(sessionId),
    type: 'chat',
    sessionId,
    title,
    preview: !!options?.preview,
  }
}

function formatTerminalTabTitle(cwd: string, nodeId?: string): string {
  const trimmed = cwd.trim() || '/'
  const normalized = trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '')
  const lastSegment = normalized === '/' ? '/' : normalized.split('/').filter(Boolean).pop() || normalized
  return nodeId && nodeId !== 'master' ? `${lastSegment} · ${nodeId}` : lastSegment
}

function makeTerminalDraftTab(nodeId: string, cwd: string): WorkbenchTab {
  return {
    id: `terminal-draft:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    type: 'terminal',
    nodeId,
    cwd,
    createMode: 'new',
    title: formatTerminalTabTitle(cwd, nodeId),
  }
}

function makeTerminalTabFromRecord(record: TerminalRegistryRecord): WorkbenchTab {
  return {
    id: `terminal:${record.id}`,
    type: 'terminal',
    terminalId: record.id,
    nodeId: record.nodeId,
    cwd: record.cwd,
    title: formatTerminalTabTitle(record.cwd, record.nodeId),
  }
}

function makeVscodeWebTab(): WorkbenchTab {
  return {
    id: VSCODE_WEB_TAB_ID,
    type: 'vscode',
    title: 'Code',
  }
}

function makeAgentsTab(): WorkbenchTab {
  return {
    id: AGENTS_TAB_ID,
    type: 'agents',
    title: 'Agents',
  }
}

function makeSetupTab(): WorkbenchTab {
  return {
    id: SETUP_TAB_ID,
    type: 'setup',
    title: 'Setup',
  }
}

function isRestorableRouteTabId(tabId: string): boolean {
  return tabId.startsWith('chat:') || tabId === AGENTS_TAB_ID || tabId === SETUP_TAB_ID
}

function App() {
  const initialRoute = getHashState()

  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [route, setRoute] = useState<RouteState>(initialRoute)
  const [setupOobe, setSetupOobe] = useState(false)
  const [focusModelsRequest, setFocusModelsRequest] = useState(0)
  const [activeTerminals, setActiveTerminals] = useState<TerminalRegistryRecord[]>([])
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [showSessionList, setShowSessionList] = useState<boolean>(() => !window.location.hash)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('themeMode')
    return saved === 'auto' || saved === 'light' || saved === 'dark' ? saved : 'auto'
  })
  const [uiThemeStyle, setUiThemeStyle] = useState<UiThemeStyle>(() => {
    const saved = localStorage.getItem(UI_THEME_STYLE_STORAGE_KEY)
    return saved === '550a' ? '550a' : 'default'
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || 256)
    return Number.isFinite(saved) ? Math.min(420, Math.max(180, saved)) : 256
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true')
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(() => {
    const saved = localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY)
    return saved === 'enter' || saved === 'modEnter' ? saved : 'modEnter'
  })
  const [groupTools, setGroupTools] = useState<boolean>(() => localStorage.getItem(GROUP_TOOLS_STORAGE_KEY) === 'true')
  const [showUsageBadge, setShowUsageBadge] = useState<boolean>(() => localStorage.getItem(SHOW_USAGE_BADGE_STORAGE_KEY) !== 'false')
  const [webUiSettings, setWebUiSettings] = useState<WebUiSettings>({ instanceName: '', tabIcon: '' })
  const [vscodeFrameStarted, setVscodeFrameStarted] = useState(false)
  const [vscodeFrameSlot, setVscodeFrameSlot] = useState<HTMLElement | null>(null)
  const vscodeFrameRef = useRef<VscodeWebFrameHostHandle | null>(null)
  const [codePath, setCodePath] = useState(loadStoredCodePath)
  const [codeNodeId, setCodeNodeId] = useState(loadStoredCodeNodeId)
  const [codeOpenInNewWindow, setCodeOpenInNewWindow] = useState(loadStoredCodeOpenInNewWindow)
  const [codeFrameUrl, setCodeFrameUrl] = useState(() => makeVscodeWebUrl(API_BASE_PATH, window.location.origin, { nodeId: loadStoredCodeNodeId(), path: loadStoredCodePath() }, { embedded: true }).toString())
  const [nodeTargets, setNodeTargets] = useState<WebUiNodeTarget[]>([MASTER_NODE_TARGET])
  const [nodeTargetsError, setNodeTargetsError] = useState('')


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
  const splitPaneWithNewTab = useWorkbenchStore((state) => state.splitPaneWithNewTab)
  const closePane = useWorkbenchStore((state) => state.closePane)
  const updateSplitSizes = useWorkbenchStore((state) => state.updateSplitSizes)

  const darkMode = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark)
  const [draggingItem, setDraggingItem] = useState<{ type: 'tab' | 'session'; id: string; title: string } | null>(null)

  const pendingRouteTabIdRef = useRef<string | null>(null)
  const currentRouteTabIdRef = useRef<string | null>(route.tabId)
  const closingRouteTabIdsRef = useRef<Set<string>>(new Set())
  const didInitializeEmptyWorkbenchRef = useRef(false)
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const allTabs = useMemo(() => Object.values(tabsById), [tabsById])
  const paneNodes = useMemo(() => getPaneNodes(root), [root])
  const paneIds = useMemo(() => getPaneIds(root), [root])
  const flattenedTabIds = useMemo(() => getFlattenedTabIds(root), [root])
  const focusedPane = useMemo(() => (focusedPaneId ? findPaneNode(root, focusedPaneId) : null), [root, focusedPaneId])
  const focusedActiveTabId = focusedPane?.activeTabId || paneNodes[0]?.activeTabId || null
  const focusedActiveTab = focusedActiveTabId ? (tabsById[focusedActiveTabId] || null) : null
  const activePaneTabTypes = useMemo(
    () => paneNodes.map((pane) => pane.activeTabId ? tabsById[pane.activeTabId]?.type : null),
    [paneNodes, tabsById],
  )
  const handleVscodeFrameSlot = useCallback((element: HTMLElement | null) => setVscodeFrameSlot(element), [])

  const sessionTitle = (sessionId: string) => sessions.find((session) => session.id === sessionId || session.aliases?.includes(sessionId))?.displayName || sessionId

  const currentContextSessionId = focusedActiveTab?.type === 'chat'
    ? focusedActiveTab.sessionId
    : loadStoredLastVisitedSession()
  const visibleSessionIds = useMemo(() => {
    const visiblePanes = isMobile ? (focusedPane ? [focusedPane] : paneNodes.slice(0, 1)) : paneNodes
    const activeSessionIds = visiblePanes.map(pane => {
      const tab = pane.activeTabId ? tabsById[pane.activeTabId] : null
      return tab?.type === 'chat' ? tab.sessionId : null
    })
    return selectVisibleSessionIds(activeSessionIds, !isMobile || !showSessionList)
  }, [isMobile, showSessionList, focusedPane, paneNodes, tabsById])
  const exactSessionIds = useMemo(() => allTabs.flatMap(tab => isChatTab(tab) ? [tab.sessionId] : []), [allTabs])
  const boundedSessions = useBoundedSessionList({ focusIds: currentContextSessionId ? [currentContextSessionId] : [], exactIds: exactSessionIds, includeGlobalSummary: true })
  const collapsedSessions = useBoundedSessionList({ focusIds: currentContextSessionId ? [currentContextSessionId] : [],
    rootLimit: 20, childLimit: 1, includeIdleWatches: false })
  const sessions = boundedSessions.knownSessions
  const sidebarSessions = boundedSessions.sessions
  const notificationOpenSessionRef = useRef<((sessionId: string) => void) | null>(null)
  const { idleNotificationModes, toggleIdleNotificationMode, unreadSessionIds, acknowledgeSession } = useSessionIdleNotifications(sessions, {
    visibleSessionIds,
    onOpenSession: (sessionId) => notificationOpenSessionRef.current?.(sessionId),
  })
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
  const currentContextSessionRecord = sessions.find((session) => session.id === currentContextSessionId || session.aliases?.includes(currentContextSessionId))
  const currentView: AppView = focusedActiveTab?.type === 'agents'
    ? 'agents'
    : focusedActiveTab?.type === 'setup'
      ? 'setup'
      : 'session'
  const busyCount = boundedSessions.globalSummary?.busy ?? sessions.filter((session) => isSessionRuntimeActive(session)).length

  const fetchWebUiSettings = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/webui/settings`)
      if (!res.ok) {
        return
      }
      const data = await res.json()
      setWebUiSettings(normalizeWebUiSettingsPayload(data?.settings))
    } catch (error) {
      console.warn('Failed to load WebUI settings', error)
    }
  }

  const saveWebUiInstanceName = async (name: string) => {
    const res = await fetch(`${API_BASE_PATH}/webui/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceName: name, tabIcon: webUiSettings.tabIcon }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save instance name')
    }
    setWebUiSettings(normalizeWebUiSettingsPayload(data?.settings))
  }

  const saveWebUiTabIcon = async (tabIcon: string) => {
    const res = await fetch(`${API_BASE_PATH}/webui/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceName: webUiSettings.instanceName, tabIcon }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save tab icon')
    }
    setWebUiSettings(normalizeWebUiSettingsPayload(data?.settings))
  }

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    if (uiThemeStyle === '550a') {
      document.documentElement.setAttribute('data-foxwarm-ui-style', '550a')
    } else {
      document.documentElement.removeAttribute('data-foxwarm-ui-style')
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', uiThemeStyle === '550a' ? (darkMode ? THEME_550A_DARK_COLOR : THEME_550A_LIGHT_COLOR) : darkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR)
  }, [darkMode, uiThemeStyle])

  useEffect(() => {
    localStorage.setItem('themeMode', themeMode)
  }, [themeMode])

  useEffect(() => {
    localStorage.setItem(UI_THEME_STYLE_STORAGE_KEY, uiThemeStyle)
  }, [uiThemeStyle])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? 'true' : 'false')
  }, [sidebarCollapsed])

  useEffect(() => {
    localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, sendKeyMode)
  }, [sendKeyMode])

  useEffect(() => {
    localStorage.setItem(GROUP_TOOLS_STORAGE_KEY, groupTools ? 'true' : 'false')
  }, [groupTools])

  useEffect(() => {
    localStorage.setItem(SHOW_USAGE_BADGE_STORAGE_KEY, showUsageBadge ? 'true' : 'false')
  }, [showUsageBadge])

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
      const nextRoute = getHashState()
      setRoute(setupOobe && nextRoute.tabId !== SETUP_TAB_ID ? { view: 'tab', tabId: SETUP_TAB_ID } : nextRoute)
      if (isMobile) {
        setShowSessionList(!window.location.hash)
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [isMobile, setupOobe])

  useEffect(() => {
    if (setupOobe && route.tabId !== SETUP_TAB_ID) {
      setRoute({ view: 'tab', tabId: SETUP_TAB_ID })
      window.location.hash = SETUP_HASH
    }
  }, [setupOobe, route.tabId])

  const fetchSessions = boundedSessions.refresh

  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/agents`)
      if (res.ok) {
        const data = await res.json()
        setAgents(Array.isArray(data.agents) ? data.agents : [])
      }
    } catch (error) {
      console.error('Failed to fetch agents:', error)
    }
  }

  const fetchSetupStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/status`)
      if (!res.ok) return
      const data = await res.json()
      const isOobe = !!data?.oobe
      setSetupOobe(isOobe)
      if (isOobe && route.tabId !== SETUP_TAB_ID) {
        setRoute({ view: 'tab', tabId: SETUP_TAB_ID })
        window.location.hash = SETUP_HASH
      }
    } catch (error) {
      console.error('Failed to fetch setup status:', error)
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

  const fetchNodeTargets = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/nodes`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to fetch nodes')
      setNodeTargets(parseWebUiNodeTargets(data))
      setNodeTargetsError('')
    } catch (error) {
      console.error('Failed to fetch nodes:', error)
      setNodeTargetsError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void fetchAgents()
    void fetchSetupStatus()
    void fetchWebUiSettings()
    void fetchActiveTerminals()
    void fetchNodeTargets()
    return undefined
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
    const legacyPreview = allTabs.find((tab) => isPreviewChatTab(tab) && tab.id === LEGACY_PREVIEW_CHAT_TAB_ID)
    if (!legacyPreview) return

    const nextId = makePreviewChatTabId()
    replaceTabId(legacyPreview.id, { ...legacyPreview, id: nextId })

    if (route.tabId === legacyPreview.id) {
      setRoute({ view: 'tab', tabId: nextId })
      setTabHash(nextId)
    }
  }, [allTabs, route, replaceTabId])

  useEffect(() => {
    const activeTerminalMap = new Map(activeTerminals.map((terminal) => [terminal.id, terminal]))
    const terminalTabs = allTabs.filter((tab): tab is Extract<WorkbenchTab, { type: 'terminal' }> => tab.type === 'terminal')
    const terminalDraftTabs = terminalTabs.filter((tab) => !tab.terminalId)

    terminalTabs.forEach((tab) => {
      if (!tab.terminalId) return
      const terminal = activeTerminalMap.get(tab.terminalId)
      if (!terminal) {
        if (tab.createMode === 'new') {
          return
        }
        removeTab(tab.id)
        return
      }

      const nextTitle = formatTerminalTabTitle(terminal.cwd, terminal.nodeId)
      if (tab.title !== nextTitle || tab.cwd !== terminal.cwd || tab.nodeId !== terminal.nodeId || tab.createMode) {
        updateTab(tab.id, (current) => current.type === 'terminal'
          ? {
              ...current,
              title: nextTitle,
              cwd: terminal.cwd,
              nodeId: terminal.nodeId,
              terminalId: terminal.id,
              createMode: undefined,
            }
          : current)
      }
    })

    activeTerminals.forEach((terminal) => {
      const existing = terminalTabs.find((tab) => tab.terminalId === terminal.id)
      if (existing) {
        return
      }

      const matchingDraft = terminalDraftTabs.find((tab) => (
        (tab.nodeId || 'master') === terminal.nodeId
        && (tab.cwd || '/') === terminal.cwd
      ))

      if (matchingDraft) {
        return
      }

      upsertTab(makeTerminalTabFromRecord(terminal), { activate: false })
    })

  }, [activeTerminals, allTabs, upsertTab])

  useEffect(() => {
    const trimmedInstanceName = webUiSettings.instanceName.trim()
    const titleIcon = webUiSettings.tabIcon.trim() || '🦊'
    const baseTitle = trimmedInstanceName ? `${trimmedInstanceName} · Foxwarm` : `${titleIcon} Foxwarm`
    document.title = busyCount > 0 ? `[${busyCount} busy] ${baseTitle}` : baseTitle
  }, [busyCount, webUiSettings.instanceName, webUiSettings.tabIcon])

  useEffect(() => {
    applyCustomTabIcon(webUiSettings.tabIcon)
  }, [webUiSettings.tabIcon])

  useEffect(() => {
    if (route.tabId && tabsById[route.tabId] && route.tabId !== focusedActiveTabId) {
      activateTab(route.tabId)
    }
  }, [route, tabsById, focusedActiveTabId, activateTab])

  useEffect(() => {
    if (route.tabId && tabsById[route.tabId] && pendingRouteTabIdRef.current === route.tabId) {
      pendingRouteTabIdRef.current = null
    }
  }, [route, tabsById])

  currentRouteTabIdRef.current = route.tabId

  useEffect(() => {
    if (!route.tabId || !closingRouteTabIdsRef.current.has(route.tabId)) {
      closingRouteTabIdsRef.current.clear()
    }
  }, [route.tabId])

  useEffect(() => {
    if (focusedActiveTabId) {
      localStorage.setItem(LAST_ACTIVE_TAB_STORAGE_KEY, focusedActiveTabId)
    }
  }, [focusedActiveTabId])

  useEffect(() => {
    const sessionId = focusedActiveTab?.type === 'chat' ? focusedActiveTab.sessionId : undefined
    if (sessionId) {
      localStorage.setItem(LAST_VISITED_SESSION_STORAGE_KEY, sessionId)
    }
  }, [focusedActiveTab])

  useEffect(() => {
    if (route.tabId && tabsById[route.tabId]) {
      return
    }

    if (route.tabId && pendingRouteTabIdRef.current === route.tabId) {
      return
    }

    if (route.tabId && isRestorableRouteTabId(route.tabId)) {
      return
    }

    if (focusedActiveTabId) {
      setRoute({ view: 'tab', tabId: focusedActiveTabId })
      setTabHash(focusedActiveTabId)
    }
  }, [route, tabsById, focusedActiveTabId])

  useEffect(() => {
    if (flattenedTabIds.length > 0) {
      didInitializeEmptyWorkbenchRef.current = true
      return
    }
    if (didInitializeEmptyWorkbenchRef.current) return
    if (route.tabId && isRestorableRouteTabId(route.tabId)) return

    didInitializeEmptyWorkbenchRef.current = true
    const fallbackSessionId = loadStoredLastVisitedSession()
    const tab = makeChatTab(fallbackSessionId, sessionTitle(fallbackSessionId), { preview: true })
    upsertTab(tab, { paneId: focusedPaneId || paneIds[0], activate: true })
    setRoute({ view: 'tab', tabId: tab.id })
    setTabHash(tab.id)
  }, [route.tabId, flattenedTabIds.length, focusedPaneId, paneIds.join('|')])

  const navigateToTab = (tabId: string, origin: SessionNavigationOrigin = 'user') => {
    pendingRouteTabIdRef.current = tabId
    currentRouteTabIdRef.current = tabId
    activateTab(tabId)
    setRoute({ view: 'tab', tabId })
    setTabHash(tabId)
    if (isMobile) {
      setShowSessionList(false)
    }
    const tab = useWorkbenchStore.getState().tabsById[tabId]
    if (tab?.type === 'chat' && shouldAcknowledgeSessionNavigation(origin)) acknowledgeSession(tab.sessionId)
  }

  useLayoutEffect(() => {
    setVscodeFrameStarted((started) => selectCodeFrameStarted(started, activePaneTabTypes, {
      workbenchVisible: !isMobile || !showSessionList,
    }))
  }, [activePaneTabTypes, isMobile, showSessionList])

  const updateCodePath = (path: string) => {
    const normalized = writeCodeWorkspacePathPreference(localStorage, path)
    setCodePath(normalized)
  }

  const updateCodeNodeId = (nodeId: string) => {
    const normalized = writeCodeWorkspaceNodePreference(localStorage, nodeId)
    setCodeNodeId(normalized)
  }

  const updateCodeOpenInNewWindow = (enabled: boolean) => {
    setCodeOpenInNewWindow(enabled)
    writeCodeOpenInNewWindowPreference(localStorage, enabled)
  }

  const activateEmbeddedCodeTab = () => {
    const existingTab = tabsById[VSCODE_WEB_TAB_ID]
    const tab = existingTab ? { ...existingTab, title: 'Code' } as WorkbenchTab : makeVscodeWebTab()
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openCode = (target: CodeTarget, forceNewWindow = false) => {
    const plan = planCodeOpen(vscodeFrameStarted, codeOpenInNewWindow, forceNewWindow)
    if (plan === 'new-window') {
      const url = makeVscodeWebUrl(API_BASE_PATH, window.location.origin, target).toString()
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    if (plan === 'start-embedded') {
      const url = makeVscodeWebUrl(API_BASE_PATH, window.location.origin, target, { embedded: true }).toString()
      setCodeFrameUrl(url)
      setVscodeFrameStarted(true)
    }
    void vscodeFrameRef.current?.request({ kind: 'addFolder', nodeId: target.nodeId, path: target.path }).catch((error) => {
      window.alert(`Could not add the folder to Code.\n\n${error instanceof Error ? error.message : String(error)}`)
    })
    activateEmbeddedCodeTab()
  }

  const openCodeFile = (
    request: CodeFileTarget,
    workspaceTarget: CodeTarget,
  ) => {
    const plan = planCodeOpen(vscodeFrameStarted, codeOpenInNewWindow)
    if (plan === 'new-window') {
      window.open(makeVscodeWebUrl(API_BASE_PATH, window.location.origin, workspaceTarget, { openFile: request }).toString(), '_blank', 'noopener,noreferrer')
      return
    }
    if (plan === 'start-embedded') {
      setCodeFrameUrl(makeVscodeWebUrl(API_BASE_PATH, window.location.origin, workspaceTarget, { embedded: true }).toString())
      setVscodeFrameStarted(true)
    }
    void vscodeFrameRef.current?.request(request).catch((error) => {
      window.alert(`Could not open the file in Code.\n\n${error instanceof Error ? error.message : String(error)}`)
    })
    activateEmbeddedCodeTab()
  }

  const openCodeCommit = async (target: CodeCommitTarget): Promise<void> => {
    const plan = planCodeOpen(vscodeFrameStarted, codeOpenInNewWindow)
    if (plan === 'new-window') {
      const opened = window.open(
        makeVscodeWebUrl(API_BASE_PATH, window.location.origin, target, { openCommit: target }).toString(),
        '_blank',
        'noopener,noreferrer',
      )
      if (!opened) throw new Error('The browser blocked the Code window.')
      return
    }
    if (plan === 'start-embedded') {
      setCodeFrameUrl(makeVscodeWebUrl(API_BASE_PATH, window.location.origin, undefined, { embedded: true }).toString())
      setVscodeFrameStarted(true)
    }
    activateEmbeddedCodeTab()
    const frame = vscodeFrameRef.current
    if (!frame) throw new Error('The embedded Code frame is unavailable.')
    await frame.request({ kind: 'openCommit', ...target })
  }

  const findPreferredChatTab = (sessionId: string): WorkbenchTab | null => {
    return allTabs.find((tab) => isChatTab(tab) && !tab.preview && tab.sessionId === sessionId)
      || null
  }

  const openChatTab = (sessionId: string, origin: SessionNavigationOrigin = 'user') => {
    const title = sessionTitle(sessionId)
    const existingTab = findPreferredChatTab(sessionId)

    if (existingTab) {
      if (existingTab.title !== title) {
        updateTab(existingTab.id, (current) => isChatTab(current) ? { ...current, title } : current)
      }
      navigateToTab(existingTab.id, origin)
      return
    }

    const previewTab = allTabs.find(isPreviewChatTab)
    if (previewTab) {
      updateTab(previewTab.id, (current) => isPreviewChatTab(current)
        ? { ...current, sessionId, title, preview: true }
        : current)
      navigateToTab(previewTab.id, origin)
      return
    }

    const tab = makeChatTab(sessionId, title, { preview: true })
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id, origin)
  }
  notificationOpenSessionRef.current = (sessionId) => openChatTab(sessionId, 'notification')

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

  const getPaneHeight = (paneId: string): number => {
    const paneElement = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)
    return Math.round(paneElement?.getBoundingClientRect().height || 0)
  }

  const getTerminalTabInPane = (paneId: string, options?: { nodeId?: string; path?: string }): Extract<WorkbenchTab, { type: 'terminal' }> | null => {
    const pane = findPaneNode(root, paneId)
    if (!pane) return null

    const paneTabs = pane.tabIds
      .map((tabId) => tabsById[tabId])
      .filter((tab): tab is Extract<WorkbenchTab, { type: 'terminal' }> => tab?.type === 'terminal')

    if (paneTabs.length === 0) return null

    if (options?.path) {
      return findTerminalForTarget(paneTabs, { nodeId: options.nodeId, cwd: options.path }) || null
    }

    const activeTab = pane.activeTabId ? tabsById[pane.activeTabId] : null
    if (activeTab?.type === 'terminal') {
      return activeTab
    }

    return paneTabs[0]
  }

  const openTerminalTab = (options?: { nodeId?: string; path?: string; terminalId?: string; sourcePaneId?: string }) => {
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

    const target = normalizeTerminalTarget({ nodeId: options?.nodeId, cwd: options?.path })
    const nodeId = target.nodeId
    const path = target.cwd

    const sourcePaneId = options?.sourcePaneId || focusedPaneId || null

    if (!isMobile && sourcePaneId) {
      const paneBelow = findPaneBelow(root, sourcePaneId)
      if (paneBelow) {
        const existingBottomTerminal = getTerminalTabInPane(paneBelow.id, { nodeId, path })
        if (existingBottomTerminal) {
          navigateToTab(existingBottomTerminal.id)
          return
        }
        const draftTab = makeTerminalDraftTab(nodeId, path)
        upsertTab(draftTab, { paneId: paneBelow.id, activate: true })
        navigateToTab(draftTab.id)
        return
      }

      if (getPaneHeight(sourcePaneId) > 700) {
        const draftTab = makeTerminalDraftTab(nodeId, path)
        const createdPaneId = splitPaneWithNewTab(sourcePaneId, draftTab, 'bottom')
        if (createdPaneId) {
          navigateToTab(draftTab.id)
          return
        }
      }
    }

    const tab = makeTerminalDraftTab(nodeId, path)
    upsertTab(tab, { paneId: sourcePaneId || undefined, activate: true })
    navigateToTab(tab.id)
  }

  const closeWorkbenchTab = async (tabId: string, options?: { deferRoute?: boolean }) => {
    const targetTab = tabsById[tabId] || null
    if (targetTab?.type === 'setup' && setupOobe) {
      return
    }

    const stateBeforeClose = useWorkbenchStore.getState()
    const paneBeforeClose = findPaneContainingTab(stateBeforeClose.root, tabId)
    const wasFocusedActiveTab = paneBeforeClose?.activeTabId === tabId
      && stateBeforeClose.focusedPaneId === paneBeforeClose.id

    if (targetTab?.type === 'terminal' && targetTab.terminalId) {
      try {
        await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(targetTab.terminalId)}`, { method: 'DELETE' })
      } catch (error) {
        console.error('Failed to close terminal:', error)
      }
      await fetchActiveTerminals()
    }

    if (targetTab?.type === 'vscode') {
      setVscodeFrameStarted((started) => selectCodeFrameStarted(started, [], { explicitlyClosed: true }))
    }

    if (currentRouteTabIdRef.current === tabId) {
      // Zustand publishes removeTab synchronously, before React's route state
      // update is committed. Mark this route as intentionally closing so the
      // route-restoration effect cannot recreate the tab in that brief render.
      closingRouteTabIdsRef.current.add(tabId)
    }

    removeTab(tabId)

    if (options?.deferRoute) {
      return
    }

    if (route.tabId === tabId || wasFocusedActiveTab) {
      const stateAfterClose = useWorkbenchStore.getState()
      const focusedPaneAfterClose = stateAfterClose.focusedPaneId
        ? findPaneNode(stateAfterClose.root, stateAfterClose.focusedPaneId)
        : null
      const nextTabId = focusedPaneAfterClose?.activeTabId
        || getPaneNodes(stateAfterClose.root)[0]?.activeTabId
        || null

      if (nextTabId) {
        navigateToTab(nextTabId)
      } else {
        pendingRouteTabIdRef.current = null
        currentRouteTabIdRef.current = null
        localStorage.removeItem(LAST_ACTIVE_TAB_STORAGE_KEY)
        setRoute({ view: 'tab', tabId: null })
        setTabHash(null)
      }
    }
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

    const persistentTab = makeChatTab(targetTab.sessionId, sessionTitle(targetTab.sessionId))
    replaceTabId(tabId, persistentTab)
    navigateToTab(persistentTab.id)
  }

  const promotePreviewTab = (tabId: string): string | null => {
    const targetTab = tabsById[tabId]
    if (!targetTab) return null

    if (!isPreviewChatTab(targetTab)) {
      return tabId
    }

    const persistentId = getPersistentChatTabId(targetTab.sessionId)
    const existingTab = tabsById[persistentId]
    if (existingTab) {
      removeTab(tabId)
      return existingTab.id
    }

    const persistentTab = makeChatTab(targetTab.sessionId, sessionTitle(targetTab.sessionId))
    replaceTabId(tabId, persistentTab)
    return persistentTab.id
  }

  const closePaneTabsByPredicate = async (paneId: string, predicate: (tab: WorkbenchTab) => boolean) => {
    const pane = findPaneNode(root, paneId)
    if (!pane) return

    const tabsToClose = pane.tabIds
      .map((tabId) => tabsById[tabId])
      .filter((tab): tab is WorkbenchTab => !!tab)
      .filter(predicate)

    tabsToClose.forEach((tab) => {
      if (tab.type !== 'setup' || !setupOobe) {
        closingRouteTabIdsRef.current.add(tab.id)
      }
    })

    try {
      for (const tab of tabsToClose) {
        await closeWorkbenchTab(tab.id, { deferRoute: true })
      }
    } finally {
      const stateAfterClose = useWorkbenchStore.getState()
      const focusedPaneAfterClose = stateAfterClose.focusedPaneId
        ? findPaneNode(stateAfterClose.root, stateAfterClose.focusedPaneId)
        : null
      const nextTabId = focusedPaneAfterClose?.activeTabId
        || getPaneNodes(stateAfterClose.root)[0]?.activeTabId
        || null

      if (!nextTabId) {
        pendingRouteTabIdRef.current = null
        currentRouteTabIdRef.current = null
        localStorage.removeItem(LAST_ACTIVE_TAB_STORAGE_KEY)
        setRoute({ view: 'tab', tabId: null })
        setTabHash(null)
      } else {
        navigateToTab(nextTabId)
      }
    }
  }

  const handleChatDraftEdited = (tabId: string) => {
    const targetTab = tabsById[tabId]
    if (targetTab && isPreviewChatTab(targetTab)) {
      keepWorkbenchTab(tabId)
    }
  }

  const handleTerminalReady = (draftTabId: string, terminal: { id: string; cwd: string; nodeId?: string }) => {
    // Keep createMode='new' until activeTerminals reconciliation sees this terminal id,
    // so the missing-terminal cleanup path does not immediately remove the just-opened tab.
    updateTab(draftTabId, (current) => current.type === 'terminal'
      ? {
          ...current,
          terminalId: terminal.id,
          nodeId: terminal.nodeId || 'master',
          cwd: terminal.cwd,
          title: formatTerminalTabTitle(terminal.cwd, terminal.nodeId || 'master'),
        }
      : current)
    navigateToTab(draftTabId)
    void fetchActiveTerminals()
  }

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(420, Math.max(180, startWidth + (moveEvent.clientX - startX)))
      setSidebarWidth(nextWidth)
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  const handleTerminalClosed = (terminalId: string) => {
    const target = allTabs.find((tab) => tab.type === 'terminal' && tab.terminalId === terminalId)
    if (target) {
      void closeWorkbenchTab(target.id)
    }
    void fetchActiveTerminals()
  }

  const openPersistentChatTab = (sessionId: string, options?: { paneId?: string; beforeTabId?: string | null; edge?: 'left' | 'right' | 'bottom' }) => {
    const title = sessionTitle(sessionId)
    const existingTab = findPreferredChatTab(sessionId)

    let targetTabId: string | null = null

    if (existingTab) {
      if (existingTab.title !== title) {
        updateTab(existingTab.id, (current) => isChatTab(current) ? { ...current, title } : current)
      }
      targetTabId = existingTab.id
    } else {
      const previewTab = allTabs.find((tab) => isPreviewChatTab(tab) && tab.sessionId === sessionId)
      if (previewTab) {
        targetTabId = promotePreviewTab(previewTab.id)
      }

      if (!targetTabId) {
        const tab = makeChatTab(sessionId, title)
        upsertTab(tab, { activate: false })
        targetTabId = tab.id
      }
    }

    if (!targetTabId) return null

    if (options?.edge && options.paneId) {
      dockTabToPaneEdge(targetTabId, options.paneId, options.edge)
    } else if (options?.paneId) {
      moveTabToPane(targetTabId, options.paneId, { beforeTabId: options.beforeTabId || null, activate: true })
    }

    navigateToTab(targetTabId)
    return targetTabId
  }

  const handleCreateAgent = async (agentId: string, inheritAgent?: string) => {
    const res = await fetch(`${API_BASE_PATH}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, inheritAgent }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Failed to create agent')
    if (!data.sessionId) throw new Error('Missing sessionId in create response')
    await Promise.all([fetchSessions(), fetchAgents()])
    openChatTab(data.sessionId)
  }

  const handleCreateSession = async (agentId: string, sessionId?: string) => {
    const res = await fetch(`${API_BASE_PATH}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSessionCreationBody(agentId, sessionId || '')),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Failed to create session')
    if (!data.sessionId) throw new Error('Missing sessionId in create response')
    await fetchSessions()
    openChatTab(data.sessionId)
  }

  const handleQuickCreateSession = () => {
    void handleCreateSession('main').catch((error) => {
      console.error('Failed to create session:', error)
      window.alert(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const handleMoveSession = async (sessionId: string, move: SessionMoveRequest) => {
    try {
      const token = getStoredAuthToken()
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(move),
      })
      if (!res.ok) {
        throw new Error(formatSessionMoveError(await readApiErrorDetails(res)))
      }
      await fetchSessions()
    } catch (error) {
      console.error('Failed to move session:', error)
      window.alert(error instanceof Error ? error.message : String(error))
      await fetchSessions()
    }
  }

  const handleBackToList = () => {
    window.location.hash = ''
    setShowSessionList(true)
    setRoute(getHashState())
  }

  const openAgentsView = () => {
    const tab = tabsById[AGENTS_TAB_ID] || makeAgentsTab()
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  const openSetupView = (options?: { focusModels?: boolean }) => {
    if (options?.focusModels) setFocusModelsRequest((current) => current + 1)
    const tab = tabsById[SETUP_TAB_ID] || makeSetupTab()
    upsertTab(tab, { activate: true })
    navigateToTab(tab.id)
  }

  useEffect(() => {
    if (!route.tabId || tabsById[route.tabId]) {
      return
    }

    if (closingRouteTabIdsRef.current.has(route.tabId)) {
      return
    }

    if (route.tabId === AGENTS_TAB_ID) {
      upsertTab(makeAgentsTab(), { activate: true })
      return
    }

    if (route.tabId === SETUP_TAB_ID) {
      upsertTab(makeSetupTab(), { activate: true })
      return
    }

    if (!route.tabId.startsWith('chat:')) {
      return
    }

    const sessionId = route.tabId.slice('chat:'.length)
    if (!sessionId) {
      return
    }

    openPersistentChatTab(sessionId)
  }, [route, tabsById, allTabs, sessions])

  useEffect(() => {
    const helper = {
      sendMessage: (message: string) => {
        const activeTab = focusedActiveTab
        const sessionId = activeTab?.type === 'chat' ? activeTab.sessionId : loadStoredLastVisitedSession()
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
  }, [focusedActiveTab, sessions])

  const renderTabContent = (tab: WorkbenchTab, onBack?: () => void) => {
    const sourcePaneId = findPaneContainingTab(root, tab.id)?.id

    if (tab.type === 'chat') {
      const sessionRecord = sessions.find((session) => session.id === tab.sessionId || session.aliases?.includes(tab.sessionId))
      return (
        <Chat
          key={`chat:${tab.sessionId}`}
          sessionId={tab.sessionId}
          canonicalSessionId={sessionRecord?.id || tab.sessionId}
          sessionDisplayName={sessionRecord?.displayName}
          onBack={onBack}
          onOpenTerminal={() => openTerminalTab({ nodeId: sessionRecord?.currentNode || 'master', path: sessionRecord?.cwd || '/', sourcePaneId })}
          onOpenCode={() => openCode(resolveSessionCodeTarget(sessionRecord?.currentNode, sessionRecord?.cwd))}
          onOpenCodeNewWindow={() => openCode(resolveSessionCodeTarget(sessionRecord?.currentNode, sessionRecord?.cwd), true)}
          onOpenCodeFile={(filePath, lines) => {
            const request = resolveToolCodeFileTarget(filePath, sessionRecord?.currentNode, sessionRecord?.cwd, lines)
            if (!request) {
              window.alert('This path cannot be opened in Code yet. Tool file links require a valid node and either an absolute path or a session cwd.')
              return
            }
            const workspaceTarget = resolveSessionCodeTarget(sessionRecord?.currentNode, sessionRecord?.cwd)
            openCodeFile(request, workspaceTarget)
          }}
          onOpenCodeCommit={openCodeCommit}
          onOpenModelSettings={() => openSetupView({ focusModels: true })}
          sendKeyMode={sendKeyMode}
          groupTools={groupTools}
          showUsageBadge={showUsageBadge}
          onDraftEdited={() => handleChatDraftEdited(tab.id)}
        />
      )
    }

    if (tab.type === 'agents') {
      return (
        <Suspense fallback={<LazyViewFallback label="Loading agents…" />}>
          <ArchitectureView
            currentSession={currentContextSessionId}
            onSelectSession={openChatTab}
            onBack={onBack}
            onCreateAgent={handleCreateAgent}
            onCreateSession={handleCreateSession}
            onAgentsChanged={() => { void Promise.all([fetchAgents(), fetchSessions()]) }}
            onOpenAgentMemory={(memoryRoot, filePath) => {
              const workspace = { nodeId: 'master', path: memoryRoot }
              if (filePath) openCodeFile({ kind: 'openFile', nodeId: 'master', path: filePath }, workspace)
              else openCode(workspace)
            }}
          />
        </Suspense>
      )
    }

    if (tab.type === 'setup') {
      return (
        <Suspense fallback={<LazyViewFallback label="Loading setup…" />}>
          <SetupView
            forced={setupOobe}
            onClose={setupOobe ? undefined : () => { void closeWorkbenchTab(tab.id) }}
            onSetupChanged={() => { void fetchSetupStatus() }}
            focusModelsRequest={focusModelsRequest}
          />
        </Suspense>
      )
    }

    if (tab.type === 'vscode') {
      return <div ref={handleVscodeFrameSlot} className="h-full min-h-0 w-full bg-gray-950" data-foxwarm-vscode-web-slot="true" />
    }

    return (
      <Suspense fallback={<LazyViewFallback label="Loading terminal…" />}>
        <TerminalView
          key={tab.id}
          initialCwd={tab.cwd}
          initialNodeId={tab.nodeId}
          initialTerminalId={tab.terminalId}
          createMode={tab.createMode || 'reuse'}
          onBack={onBack}
          onSessionsChanged={() => { void fetchActiveTerminals() }}
          onTerminalReady={(terminal) => handleTerminalReady(tab.id, terminal)}
          onTerminalClosed={handleTerminalClosed}
        />
      </Suspense>
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
            <div>Focus this pane and open a chat or terminal from the sidebar/session list.</div>
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
        showPaneControls={!isMobile}
        canClosePane={paneIds.length > 1}
        content={content}
        onFocusPane={handleFocus}
        onSelectTab={navigateToTab}
        onCloseTab={(tabId) => { void closeWorkbenchTab(tabId) }}
        onKeepTab={keepWorkbenchTab}
        onCloseOtherTabs={(tabId) => { void closePaneTabsByPredicate(paneId, (tab) => tab.id !== tabId) }}
        onCloseAllTabs={() => { void closePaneTabsByPredicate(paneId, () => true) }}
        onSplitRight={() => handleSplit('right')}
        onSplitDown={() => handleSplit('bottom')}
        onClosePane={handleClosePane}
      />
    )
  }

  const draggingTab = draggingItem?.type === 'tab' && draggingItem.id ? (tabsById[draggingItem.id] || null) : null

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id)
    const activeData = event.active.data.current as { type?: string; title?: string; sessionId?: string } | undefined
    if (activeData?.type === 'session') {
      setDraggingItem({ type: 'session', id: activeData.sessionId || activeId, title: activeData.title || activeData.sessionId || activeId })
      return
    }
    const tab = tabsById[activeId]
    setDraggingItem({ type: 'tab', id: activeId, title: tab?.title || activeId })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = event.over?.id ? String(event.over.id) : null
    const activeData = event.active.data.current as { type?: string; paneId?: string; sessionId?: string; sessionPinned?: boolean } | undefined
    const overData = event.over?.data.current as {
      type?: string
      paneId?: string
      edge?: 'left' | 'right' | 'top' | 'bottom'
      sessionId?: string
      parentSessionId?: string | null
      position?: 'first' | 'last'
      updateOrder?: boolean
    } | undefined

    setDraggingItem(null)

    if (!overId || !activeData) {
      return
    }

    const applyTabDrop = (targetPaneId: string, options?: { beforeTabId?: string | null }) => {
      moveTabToPane(activeId, targetPaneId, { beforeTabId: options?.beforeTabId || null, activate: true })
      navigateToTab(activeId)
      return activeId
    }

    if (activeData.type === 'session') {
      const draggedSessionId = activeData.sessionId || activeId
      if (overData?.type === 'sidebar-root-drop') {
        if (activeData.sessionPinned) return
        void handleMoveSession(draggedSessionId, overData.updateOrder === false
          ? { parentSessionId: null, updateOrder: false }
          : { parentSessionId: null, position: overData.position || 'first' })
        return
      }

      if (overData?.type === 'sidebar-session-child' && overData.sessionId) {
        if (activeData.sessionPinned) return
        if (overData.sessionId !== draggedSessionId) {
          void handleMoveSession(draggedSessionId, overData.updateOrder === false
            ? { parentSessionId: overData.sessionId, updateOrder: false }
            : { parentSessionId: overData.sessionId, position: overData.position || 'first' })
        }
        return
      }

      if (overData?.type === 'sidebar-session-before' && overData.sessionId) {
        if (activeData.sessionPinned) return
        if (overData.sessionId !== draggedSessionId) {
          void handleMoveSession(draggedSessionId, {
            parentSessionId: overData.parentSessionId ?? null,
            beforeSessionId: overData.sessionId,
          })
        }
        return
      }

      if (overData?.type === 'sidebar-session-after' && overData.sessionId) {
        if (activeData.sessionPinned) return
        if (overData.sessionId !== draggedSessionId) {
          void handleMoveSession(draggedSessionId, {
            parentSessionId: overData.parentSessionId ?? null,
            afterSessionId: overData.sessionId,
          })
        }
        return
      }

      if (overData?.type === 'tab' && overData.paneId) {
        openPersistentChatTab(draggedSessionId, { paneId: overData.paneId, beforeTabId: overId })
        return
      }

      if (overData?.type === 'tab-row' && overData.paneId) {
        openPersistentChatTab(draggedSessionId, { paneId: overData.paneId })
        return
      }

      if (overData?.type === 'pane-center' && overData.paneId) {
        openPersistentChatTab(draggedSessionId, { paneId: overData.paneId })
        return
      }

      if (overData?.type === 'pane-edge' && overData.paneId && overData.edge && overData.edge !== 'top') {
        openPersistentChatTab(draggedSessionId, { paneId: overData.paneId, edge: overData.edge })
      }
      return
    }

    if (activeData.type !== 'tab') {
      return
    }

    if (overData?.type === 'tab' && overData.paneId) {
      if (activeData.paneId === overData.paneId) {
        if (activeId !== overId) {
          reorderTabs(overData.paneId, activeId, overId)
        }
        return
      }

      applyTabDrop(overData.paneId, { beforeTabId: overId })
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
      if (activeData.paneId === overData.paneId) {
        return
      }
      applyTabDrop(overData.paneId)
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
    setDraggingItem(null)
  }

  const renderWorkbenchSurface = (content: ReactNode) => (
    <DndContext
      sensors={dragSensors}
      collisionDetection={(args) => {
        const collisions = pointerWithin(args)
        const priorityByType: Record<string, number> = {
          'sidebar-session-before': 0,
          'sidebar-session-after': 0,
          'sidebar-session-child': 1,
          'sidebar-root-drop': 1,
          tab: 0,
          'tab-row': 1,
          'pane-edge': 2,
          'pane-center': 3,
        }

        return [...collisions].sort((a, b) => {
          const aType = args.droppableContainers.find((container) => container.id === a.id)?.data.current?.type as string | undefined
          const bType = args.droppableContainers.find((container) => container.id === b.id)?.data.current?.type as string | undefined
          return (priorityByType[aType || ''] ?? 99) - (priorityByType[bType || ''] ?? 99)
        })
      }}
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
        ) : draggingItem?.type === 'session' ? (
          <div data-session-drag-overlay className="inline-flex max-w-[24rem] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
            <span className="truncate">{draggingItem.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )

  const renderWithVscodeFrame = (content: ReactNode) => (
    <>
      {content}
      <VscodeWebFrameHost
        key="foxwarm-vscode-web-frame-host"
        ref={vscodeFrameRef}
        started={vscodeFrameStarted}
        src={codeFrameUrl}
        slot={vscodeFrameSlot}
      />
    </>
  )

  if (isMobile) {
    if (showSessionList) {
      return renderWithVscodeFrame(renderWorkbenchSurface(
        <SessionList
          sessions={sidebarSessions}
          agents={agents}
          currentSession={currentContextSessionId}
          currentView={currentView}
          currentSessionRecord={currentContextSessionRecord}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
          uiThemeStyle={uiThemeStyle}
          onUiThemeStyleChange={setUiThemeStyle}
          sendKeyMode={sendKeyMode}
          onSendKeyModeChange={setSendKeyMode}
          groupTools={groupTools}
          onGroupToolsChange={setGroupTools}
          showUsageBadge={showUsageBadge}
          onShowUsageBadgeChange={setShowUsageBadge}
          instanceName={webUiSettings.instanceName}
          onInstanceNameChange={saveWebUiInstanceName}
          tabIcon={webUiSettings.tabIcon}
          onTabIconChange={saveWebUiTabIcon}
          onSelectSession={openChatTab}
          onKeepSession={openKeptChatTab}
          onSelectArchitecture={openAgentsView}
          onSelectSetup={openSetupView}
          codePath={codePath}
          codeNodeId={codeNodeId}
          codeOpenInNewWindow={codeOpenInNewWindow}
          codeActive={focusedActiveTab?.type === 'vscode'}
          nodeTargets={nodeTargets}
          nodeTargetsError={nodeTargetsError}
          onRefreshNodeTargets={() => { void fetchNodeTargets() }}
          onOpenCode={(nodeId, path) => openCode({ nodeId, path: normalizeCodePath(path) || '/' })}
          onCodeNodeChange={updateCodeNodeId}
          onCodePathChange={updateCodePath}
          onCodeOpenInNewWindowChange={updateCodeOpenInNewWindow}
          onCreateTerminalTab={(options) => openTerminalTab({ nodeId: options?.nodeId || currentContextSessionRecord?.currentNode || 'master', path: options?.path || currentContextSessionRecord?.cwd || '/' })}
          onCreateAgent={handleCreateAgent}
          onCreateSession={handleCreateSession}
          idleNotificationModes={idleNotificationModes}
          unreadSessionIds={unreadSessionIds}
          onToggleIdleNotificationMode={toggleIdleNotificationMode}
          bounded={boundedPresentation}
        />,
      ))
    }

    const mobilePaneId = focusedPaneId || paneIds[0]

    return renderWithVscodeFrame(
      <div className="foxwarm-safe-area-shell foxwarm-fixed-viewport-shell fixed inset-x-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden p-0">
          {renderWorkbenchSurface(mobilePaneId ? renderPane(mobilePaneId, handleBackToList) : null)}
        </div>
      </div>,
    )
  }

  return renderWithVscodeFrame(renderWorkbenchSurface(
    <div className="foxwarm-safe-area-shell foxwarm-viewport-shell relative flex overflow-hidden bg-gray-100 dark:bg-gray-900">
      {!sidebarCollapsed ? (
        <div className="relative h-full shrink-0" style={{ width: sidebarWidth }}>
          <Sidebar
            sessions={sidebarSessions}
            agents={agents}
            currentSession={currentContextSessionId}
            currentView={currentView}
            currentSessionRecord={currentContextSessionRecord}
            themeMode={themeMode}
            onThemeChange={setThemeMode}
            uiThemeStyle={uiThemeStyle}
            onUiThemeStyleChange={setUiThemeStyle}
            sendKeyMode={sendKeyMode}
            onSendKeyModeChange={setSendKeyMode}
            groupTools={groupTools}
            onGroupToolsChange={setGroupTools}
            showUsageBadge={showUsageBadge}
            onShowUsageBadgeChange={setShowUsageBadge}
            instanceName={webUiSettings.instanceName}
            onInstanceNameChange={saveWebUiInstanceName}
            tabIcon={webUiSettings.tabIcon}
            onTabIconChange={saveWebUiTabIcon}
            onSelectSession={openChatTab}
            onKeepSession={openKeptChatTab}
            onSelectArchitecture={openAgentsView}
            onSelectSetup={openSetupView}
            codePath={codePath}
            codeNodeId={codeNodeId}
            codeOpenInNewWindow={codeOpenInNewWindow}
            codeActive={focusedActiveTab?.type === 'vscode'}
            nodeTargets={nodeTargets}
            nodeTargetsError={nodeTargetsError}
            onRefreshNodeTargets={() => { void fetchNodeTargets() }}
            onOpenCode={(nodeId, path) => openCode({ nodeId, path: normalizeCodePath(path) || '/' })}
            onCodeNodeChange={updateCodeNodeId}
            onCodePathChange={updateCodePath}
            onCodeOpenInNewWindowChange={updateCodeOpenInNewWindow}
            onCreateTerminalTab={(options) => openTerminalTab({ nodeId: options?.nodeId || currentContextSessionRecord?.currentNode || 'master', path: options?.path || currentContextSessionRecord?.cwd || '/' })}
            onCreateAgent={handleCreateAgent}
            onCreateSession={handleCreateSession}
            onToggleCollapsed={() => setSidebarCollapsed(true)}
            isPeek={false}
            idleNotificationModes={idleNotificationModes}
            unreadSessionIds={unreadSessionIds}
            onToggleIdleNotificationMode={toggleIdleNotificationMode}
            bounded={boundedPresentation}
          />
          <div
            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize bg-transparent transition hover:bg-blue-400/40"
            onMouseDown={startSidebarResize}
          />
        </div>
      ) : (
        <CollapsedSidebar
          sessions={collapsedSessions.sessions}
          currentSession={currentContextSessionId}
          onSelectSession={openChatTab}
          onCreateSession={handleQuickCreateSession}
          onToggleCollapsed={() => setSidebarCollapsed(false)}
          unreadSessionIds={unreadSessionIds}
        />
      )}
      <div className="flex-1 h-full min-h-0 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">
          <WorkbenchLayout
            node={root}
            renderPane={(paneId) => renderPane(paneId)}
            onLayoutResize={updateSplitSizes}
          />
        </div>
      </div>
    </div>,
  ))
}

export default App
