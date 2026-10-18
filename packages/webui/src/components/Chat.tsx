import { getLastSessionFailure } from '../sessionNotices'
import { CONTINUOUS_HISTORY_WINDOW_SIZE, type HistoryMode } from '../continuousHistory'
import { useContentBeforeResize } from '../contentResize'
import { historyModeForTimelineView, useMobileChatViewport, type TimelineView } from '../chatPreferences'
import { Component, memo, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SquarePen, ChevronDown, ChevronUp, Code2, MessageSquareText, Search, SquareTerminal, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import ChatComposer from './ChatComposer'
import type { ModelOption } from './ChatComposer'
import ChatTimeline from './ChatTimeline'
import { buildTimelineRows } from './timelineRows'
import { findRenderedMatchRange, findSearchSurface, findSessionSearchMatches, projectSessionSearchFields } from './chatSessionSearch'
import ContextScrollbar from './ContextScrollbar'
import { CONTEXT_SCROLLBAR_SETTINGS_EVENT, readContextScrollbarSettings } from '../contextScrollbarSettings'
import type { CodeCommitTarget } from '../commitMarker'
import ContentHeader from './ContentHeader'
import ProcessingStatus, { QueuedMessageStatus } from './ProcessingStatus'
import type { Message } from './chatShared'
import { buildStreamingAssistantMessage } from '../streamingAssistantDraft'
import { useChatConversationSync } from './useChatConversationSync'
import { isSessionRuntimeActive } from '../sessionRuntimeState'
import SessionDebugModal from './SessionDebugModal'
import { ToolScriptProgressContext } from './ToolScriptProgressContext'
import { ThreadCardHeightContext } from './useThreadCardHeightTransition'
import { isSessionTurnIncomplete } from '../../../shared/src/sessionContinuation'
import { formatSessionHeaderSubtitle } from '../sessionHeader'
import { createLatestRequestGate, loadPageOnce, MODEL_OPTIONS_CHANGED_EVENT, refreshModelOptions, runLatestModelOptionsRequest } from '../modelOptionsLoader'
import SessionUiSettingsMenu from './SessionUiSettingsMenu'
import {
  CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX,
  CHAT_MESSAGE_ANCHOR_SELECTOR,
  CONTEXT_SCROLLBAR_ANCHOR_SELECTOR,
  chooseChatViewportState,
  getChatViewportAnchorAdjustment,
  getChatViewportAnchorSeq,
  getMessageStableKey,
  getMessageViewportAnchorKey,
  getStoredChatViewportState,
  storeChatViewportState,
  updateChatBottomFollow,
  type ChatViewportState,
} from '../chatViewportState'

function getAsrStreamUrl() {
  const base = `${window.location.origin}${API_BASE_PATH}/asr/stream`
  return base.replace(/^http/i, 'ws')
}

const ASR_CONTEXT_MAX_CHARS = 2400
const ASR_CONTEXT_MAX_MESSAGES = 8
const DEFAULT_VISIBLE_TIMELINE_MESSAGES = 100
const HISTORY_PRELOAD_DISTANCE_PX = 500
const SEARCH_HISTORY_STORAGE_KEY = 'foxwarm.chat.search-history'
const SEARCH_HISTORY_LIMIT = 20

function readSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, SEARCH_HISTORY_LIMIT)
  } catch {
    return []
  }
}

function writeSearchHistory(history: string[]): void {
  try {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch {
    // Browser storage can be unavailable or full; Search remains usable in memory.
  }
}

function getSelectedFindText(): string | null {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    const start = activeElement.selectionStart
    const end = activeElement.selectionEnd
    if (start !== null && end !== null && start !== end) return activeElement.value.slice(start, end)
  }

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString()
  return text || null
}

// Capture immediately before React mutates the old history DOM, not when a request starts.
class HistoryCommit extends Component<{ revision: unknown; beforeCommit: () => void; children: ReactNode }> {
  getSnapshotBeforeUpdate(previous: Readonly<{ revision: unknown }>) {
    if (previous.revision !== this.props.revision) this.props.beforeCommit()
    return null
  }
  componentDidUpdate() {}
  render() { return this.props.children }
}

type PendingViewportRestore =
  | { kind: 'state'; state: ChatViewportState; interactionVersion: number }
  | {
      kind: 'prepend'
      visibleEndKey?: string
      anchors: Array<{ messageKey: string; offsetPx: number }>
      scrollTop: number
      scrollHeight: number
      interactionVersion: number
    }

function getMessagePlainText(message: Message): string {
  return message.parts
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function buildAsrContext(messages: Message[], draftText: string): string {
  const recentMessages = messages
    .filter((message) => (message.role === 'user' || message.role === 'model') && !message.__meta?.temporary)
    .map((message) => ({
      role: message.role,
      text: getMessagePlainText(message),
    }))
    .filter((message) => Boolean(message.text))
    .slice(-ASR_CONTEXT_MAX_MESSAGES)

  const blocks = recentMessages.map((message) => (
    `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`
  ))

  const trimmedDraft = draftText.trim()
  if (trimmedDraft) {
    blocks.push(`Current draft: ${trimmedDraft}`)
  }

  let combined = blocks.join('\n\n').trim()
  if (combined.length <= ASR_CONTEXT_MAX_CHARS) {
    return combined
  }

  combined = combined.slice(combined.length - ASR_CONTEXT_MAX_CHARS)
  const newlineIndex = combined.indexOf('\n')
  if (newlineIndex > 0 && newlineIndex < 200) {
    combined = combined.slice(newlineIndex + 1)
  }

  return `[recent session context]\n${combined}`
}

interface ChatProps {
  sessionId: string
  searchShortcutActive?: boolean
  experimentalTextOnly?: boolean
  experimentalAttachments?: boolean
  canonicalSessionId?: string
  sessionDisplayName?: string
  webUiIdentityMode?: boolean
  onBack?: () => void
  onNewSession?: () => Promise<void>
  onOpenTerminal?: () => void
  onOpenCode?: () => void
  onOpenCodeFile?: (filePath: string, lines?: { startLine?: number; endLine?: number }, target?: { nodeId: string; resolvedPath: string }) => void
  onOpenCodeCommit?: (target: CodeCommitTarget) => void | Promise<void>
  onOpenModelSettings?: () => void
  sendKeyMode?: 'modEnter' | 'enter'
  historyMode?: HistoryMode
  timelineView?: TimelineView
  showUsageBadge?: boolean
  showUserMessageMetadata?: boolean
  fullWidth?: boolean
  onFullWidthChange?: (enabled: boolean) => void
  onSendKeyModeChange?: (mode: 'modEnter' | 'enter') => void
  onTimelineViewChange?: (mode: TimelineView) => void
  onShowUsageBadgeChange?: (enabled: boolean) => void
  onShowUserMessageMetadataChange?: (enabled: boolean) => void
}

type StreamingAsrSession = {
  sendAudioChunk: (chunk: ArrayBuffer) => void
  stop: () => void
  cancel: () => void
}

const Chat = memo(function Chat({ sessionId, searchShortcutActive = true, experimentalTextOnly = false, experimentalAttachments = false, canonicalSessionId, sessionDisplayName, webUiIdentityMode = false, onBack, onNewSession, onOpenTerminal, onOpenCode, onOpenCodeFile, onOpenCodeCommit, onOpenModelSettings, sendKeyMode = 'modEnter', timelineView = 'detailed', historyMode = historyModeForTimelineView(timelineView), showUsageBadge = true, showUserMessageMetadata = false, fullWidth = true, onFullWidthChange = () => {}, onSendKeyModeChange = () => {}, onTimelineViewChange = () => {}, onShowUsageBadgeChange = () => {}, onShowUserMessageMetadataChange = () => {} }: ChatProps) {
  const viewportSessionId = canonicalSessionId || sessionId
  const initialContinuousAnchorSeq = useMemo(() => getChatViewportAnchorSeq(getStoredChatViewportState(viewportSessionId, 'continuous')), [viewportSessionId])
  const {
    messages: activeMessages, continuousMessages, archivePage, loadArchivePage, queuedMessages, sessionRecord, sessionMissing, sessionBusy, sessionQueueLength,
    persistentMemorySnapshot, streamingAssistantDraft, toolScriptProgress,
    historyLoaded, isFullHistoryLoaded, earlierHistoryError, connectionState, reconnectCountdown,
    pendingControl, controlFeedback, loading, retryEarlierHistory, sendMessage: handleSend, sendSessionCommand, mergeConfirmedSettings,
  } = useChatConversationSync(sessionId, webUiIdentityMode, historyMode, initialContinuousAnchorSeq)
  const messages = historyMode === 'continuous' ? continuousMessages : activeMessages
  const [continuousWindowKey, setContinuousWindowKey] = useState<string | null>(null)
  const [continuousWindowEndKey, setContinuousWindowEndKey] = useState<string | null>(null)
  const currentHistoryRef = useRef({ mode: historyMode, messages })
  currentHistoryRef.current = { mode: historyMode, messages }
  const continuousWindowRangeRef = useRef({ start: 0, count: CONTINUOUS_HISTORY_WINDOW_SIZE })
  const continuousWindowAtLatestRef = useRef(true)
  const [layout, setLayout] = useState({ isMobile: true, compactModelSelector: true, compactComposer: false })
  const layoutRef = useRef(layout)
  const { isMobile, compactModelSelector, compactComposer } = layout
  const mobileUi = useMobileChatViewport()
  const [creatingSession, setCreatingSession] = useState(false)
  const [followingBottom, setFollowingBottom] = useState(true)
  const [showScrollTopButton, setShowScrollTopButton] = useState(false)
  const [showDebugInfo, setShowDebugInfo] = useState(false)
  const [asrAvailable, setAsrAvailable] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [modelsRefreshing, setModelsRefreshing] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [showFullTimeline, setShowFullTimeline] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchId, setSearchMatchId] = useState<string | null>(null)
  const [searchNavigation, setSearchNavigation] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchAppliedNavigationRef = useRef(0)
  const searchHistoryRef = useRef<string[]>([])
  const searchHistoryIndexRef = useRef<number | null>(null)
  const searchHistoryDraftRef = useRef('')
  const searchHighlightName = `foxwarm-chat-search-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const sessionHeaderSubtitle = formatSessionHeaderSubtitle(sessionId, sessionRecord?.cwd)
  const chatMessageContainerId = `foxwarm-chat-messages-${useId()}`

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const committedTimelineRef = useRef<HTMLDivElement>(null)
  const [contextScrollbarSettings, setContextScrollbarSettings] = useState(readContextScrollbarSettings)
  const showMinimap = timelineView !== 'conversation' && contextScrollbarSettings.showMinimap
  const showScrollbar = timelineView === 'conversation' || contextScrollbarSettings.showScrollbar
  useEffect(() => {
    const sync = () => setContextScrollbarSettings(readContextScrollbarSettings())
    window.addEventListener(CONTEXT_SCROLLBAR_SETTINGS_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CONTEXT_SCROLLBAR_SETTINGS_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const chatRootRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef<boolean>(true)
  const pendingUserLeaveBottomRef = useRef(false)
  const touchScrollStartYRef = useRef<number | null>(null)
  const pointerScrollInteractionRef = useRef(false)
  const continuousPagingIntentRef = useRef<'earlier' | 'later' | null>(null)
  const lastNativeScrollTopRef = useRef(0)
  const composerHeightRef = useRef<number | null>(null)
  const initialViewportState = getStoredChatViewportState(viewportSessionId, historyMode) || { kind: 'bottom' as const }
  const currentViewportStateRef = useRef<ChatViewportState>(initialViewportState)
  const pendingViewportRestoreRef = useRef<PendingViewportRestore | null>({
    kind: 'state',
    state: initialViewportState,
    interactionVersion: 0,
  })
  const currentViewportGeometryRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const userInteractionVersionRef = useRef(0)
  const capturedInteractionVersionRef = useRef(0)
  const pendingContentResizeRef = useRef<{ state: ChatViewportState; interactionVersion: number } | null>(null)
  const resizeRestoreFrameRef = useRef<number | null>(null)
  const cardHeightChangesRef = useRef(new Set<object>())
  const pendingContextScrollbarNavigationRef = useRef<{ anchorKey: string; fraction: number } | null>(null)
  const pendingScrollToTrueTopRef = useRef(false)
  const modelRequestGateRef = useRef(createLatestRequestGate())

  useEffect(() => {
    pendingContextScrollbarNavigationRef.current = null
    pendingScrollToTrueTopRef.current = false
  }, [sessionId])

  useEffect(() => {
    setShowDebugInfo(false)
  }, [sessionId])

  useEffect(() => {
    let cancelled = false

    const fetchAsrStatus = async () => {
      try {
        const available = await loadPageOnce('webui:asr-status', async () => {
          const res = await fetch(`${API_BASE_PATH}/asr/status`)
          if (!res.ok) throw new Error(`Failed to load ASR status (${res.status})`)
          const data = await res.json()
          return Boolean(data?.configured && data?.available)
        })
        if (!cancelled) setAsrAvailable(available)
      } catch (e) {
        if (!cancelled) {
          setAsrAvailable(false)
        }
      }
    }

    if (!webUiIdentityMode) void fetchAsrStatus()
    else setAsrAvailable(false)
    return () => {
      cancelled = true
    }
  }, [webUiIdentityMode])

  const fetchModels = useCallback(async () => {
    if (webUiIdentityMode) return
    await runLatestModelOptionsRequest(modelRequestGateRef.current, () => loadPageOnce('webui:models', async () => {
      const res = await fetch(`${API_BASE_PATH}/models`)
      if (!res.ok) throw new Error(`Failed to load models (${res.status})`)
      const data = await res.json()
      return (Array.isArray(data.models) ? data.models : []) as ModelOption[]
    }), (state) => {
      if (state.options) setModelOptions(state.options)
      if (state.error !== undefined) {
        setModelError(state.error)
        if (state.error) console.error('Failed to fetch models:', state.error)
      }
      if (state.loading !== undefined) setModelsRefreshing(state.loading)
    })
  }, [webUiIdentityMode])

  useEffect(() => {
    const handleModelsChanged = () => { void fetchModels() }
    if (!webUiIdentityMode) {
      window.addEventListener(MODEL_OPTIONS_CHANGED_EVENT, handleModelsChanged)
      void fetchModels()
    }
    return () => {
      window.removeEventListener(MODEL_OPTIONS_CHANGED_EVENT, handleModelsChanged)
      modelRequestGateRef.current.invalidate()
    }
  }, [fetchModels, webUiIdentityMode])

  useLayoutEffect(() => {
    const root = chatRootRef.current
    if (!root) return
    const measure = () => {
      const { width, height } = root.getBoundingClientRect()
      // Hidden panes keep their last layout until they have a measurable size.
      if (width <= 0 || height <= 0) return
      const next = { isMobile: width < 768, compactModelSelector: width <= 640, compactComposer: height < 600 }
      if (next.isMobile === layoutRef.current.isMobile && next.compactModelSelector === layoutRef.current.compactModelSelector && next.compactComposer === layoutRef.current.compactComposer) return
      layoutRef.current = next
      setLayout(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const root = chatRootRef.current
    const header = root?.querySelector<HTMLElement>('[data-mobile-chat-header]')
    if (!root || !mobileUi || !header) return
    const measure = () => root.style.setProperty('--chat-mobile-header-height', `${header.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => { observer.disconnect(); root.style.removeProperty('--chat-mobile-header-height') }
  }, [mobileUi])

  const setBottomFollow = useCallback((following: boolean, pendingUserLeave = false) => {
    shouldAutoScrollRef.current = following
    pendingUserLeaveBottomRef.current = pendingUserLeave
    setFollowingBottom(following)
  }, [])

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current
    if (container) {
      // Explicit bottom navigation and attached content updates use the same follow state.
      container.scrollTop = container.scrollHeight
      const state: ChatViewportState = { kind: 'bottom' }
      currentViewportStateRef.current = state
      currentViewportGeometryRef.current = null
      setBottomFollow(true)
      storeChatViewportState(viewportSessionId, state, historyMode)
    }
  }, [setBottomFollow, viewportSessionId, historyMode])

  useEffect(() => () => {
    cardHeightChangesRef.current.clear()
    messagesContainerRef.current?.style.removeProperty('overflow-anchor')
  }, [sessionId])

  const handleComposerHeightChange = useCallback((height: number) => {
    const nextHeight = Math.max(0, Math.round(height))
    if (composerHeightRef.current === nextHeight) {
      return
    }
    composerHeightRef.current = nextHeight
    chatRootRef.current?.style.setProperty('--chat-composer-offset', `${nextHeight}px`)
  }, [])

  const readCurrentViewportState = useCallback((bottomThresholdPx?: number): ChatViewportState | null => {
    const container = messagesContainerRef.current
    const timeline = committedTimelineRef.current
    if (!container || !timeline) return null

    const containerRect = container.getBoundingClientRect()
    const anchors = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR)).map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        messageKey: element.getAttribute('data-chat-message-anchor-key') || '',
        top: rect.top,
        bottom: rect.bottom,
      }
    }).filter((anchor) => anchor.messageKey)

    return chooseChatViewportState({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      viewportTop: containerRect.top,
      viewportBottom: containerRect.bottom,
      anchors,
      ...(bottomThresholdPx === undefined ? {} : { bottomThresholdPx }),
    })
  }, [])

  const updateBottomFollowState = useCallback((userIntent: 'none' | 'leave' | 'toward-bottom' = 'none') => {
    const container = messagesContainerRef.current
    const distanceFromBottom = historyMode === 'continuous' && !continuousWindowAtLatestRef.current ? Number.POSITIVE_INFINITY : container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : Number.POSITIVE_INFINITY
    const next = updateChatBottomFollow({
      following: shouldAutoScrollRef.current,
      pendingUserLeave: pendingUserLeaveBottomRef.current,
      distanceFromBottom,
      userIntent,
    })
    setBottomFollow(next.following, next.pendingUserLeave)
    return next
  }, [historyMode, setBottomFollow])

  const captureCurrentViewportState = useCallback((): ChatViewportState | null => {
    // A pending restore owns the position until its rows arrive or user input cancels it.
    const pending = pendingViewportRestoreRef.current
    if (pending?.kind === 'state') return pending.state
    if (pendingContentResizeRef.current) return pendingContentResizeRef.current.state
    const followState = updateBottomFollowState()
    const bottomThresholdPx = followState.pendingUserLeave
      ? -1
      : followState.following
        // Passive reflow must not turn an active follow intent into an anchor.
        ? Number.POSITIVE_INFINITY
        : CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX
    const state = readCurrentViewportState(bottomThresholdPx)
    if (!state) return null

    currentViewportStateRef.current = state
    currentViewportGeometryRef.current = null
    capturedInteractionVersionRef.current = userInteractionVersionRef.current
    storeChatViewportState(viewportSessionId, state, historyMode)
    return state
  }, [readCurrentViewportState, updateBottomFollowState, viewportSessionId, historyMode])

  useContentBeforeResize(useCallback(() => {
    // Do not acknowledge detached user input before its native scroll captures position.
    if (!shouldAutoScrollRef.current && capturedInteractionVersionRef.current !== userInteractionVersionRef.current) return
    const state = captureCurrentViewportState()
    if (state) pendingContentResizeRef.current = { state, interactionVersion: userInteractionVersionRef.current }
  }, [captureCurrentViewportState]))

  const applyViewportState = useCallback((state: ChatViewportState): boolean => {
    const container = messagesContainerRef.current
    if (!container) return false

    if (state.kind === 'bottom') {
      container.scrollTop = container.scrollHeight
      currentViewportStateRef.current = state
      currentViewportGeometryRef.current = null
      setBottomFollow(true)
      storeChatViewportState(viewportSessionId, state, historyMode)
      return true
    }

    const timeline = committedTimelineRef.current
    if (!timeline) return false

    const anchor = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR))
      .find((element) => element.getAttribute('data-chat-message-anchor-key') === state.messageKey)
    if (!anchor) return false

    const currentOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
    const adjustment = getChatViewportAnchorAdjustment(currentOffset, state.offsetPx)
    if (Math.abs(adjustment) >= 0.5) {
      container.scrollTop += adjustment
    }
    currentViewportStateRef.current = state
    currentViewportGeometryRef.current = null
    setBottomFollow(false)
    storeChatViewportState(viewportSessionId, state, historyMode)
    return true
  }, [setBottomFollow, viewportSessionId, historyMode])

  const applyViewportAnchorCandidates = useCallback((anchors: Array<{ messageKey: string; offsetPx: number }>): boolean => {
    for (const candidate of anchors) {
      const state: ChatViewportState = { kind: 'anchor', ...candidate }
      if (!applyViewportState(state)) continue
      const container = messagesContainerRef.current
      const timeline = committedTimelineRef.current
      const anchor = timeline
        ? Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR))
          .find((element) => element.getAttribute('data-chat-message-anchor-key') === candidate.messageKey)
        : null
      if (!container || !anchor) continue
      const restoredOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
      if (Math.abs(restoredOffset - candidate.offsetPx) <= 2) return true
    }
    return false
  }, [applyViewportState])

  const markUserViewportInteraction = useCallback(() => {
    continuousPagingIntentRef.current = null
    pendingContentResizeRef.current = null
    userInteractionVersionRef.current += 1
    pendingViewportRestoreRef.current = null
    currentViewportGeometryRef.current = null
  }, [])

  const handleBottomNavigation = useCallback(() => {
    if (historyMode === 'continuous' && archivePage.hasLater) void loadArchivePage('latest')
    if (historyMode === 'continuous') setContinuousWindowKey(null)
    markUserViewportInteraction()
    pendingContextScrollbarNavigationRef.current = null
    pendingScrollToTrueTopRef.current = false
    capturedInteractionVersionRef.current = userInteractionVersionRef.current
    scrollToBottom()
  }, [archivePage.hasLater, historyMode, loadArchivePage, markUserViewportInteraction, scrollToBottom])

  const leaveBottomFollow = useCallback(() => {
    if (historyMode === 'continuous' && continuousWindowKey === null && messages.length) {
      setContinuousWindowKey(getMessageStableKey(messages[Math.max(0, messages.length - CONTINUOUS_HISTORY_WINDOW_SIZE)], 0))
    }
    markUserViewportInteraction()
    updateBottomFollowState('leave')
  }, [continuousWindowKey, historyMode, messages, markUserViewportInteraction, updateBottomFollowState])

  const prepareCardHeight = useCallback(() => {
    const token = {}
    cardHeightChangesRef.current.add(token)
    const container = messagesContainerRef.current
    if (container) container.style.overflowAnchor = 'none'
    return () => {
      cardHeightChangesRef.current.delete(token)
      if (!cardHeightChangesRef.current.size) container?.style.removeProperty('overflow-anchor')
    }
  }, [])

  const beginCardHeight = useCallback((card: HTMLElement, startHeight: number, targetHeight: number) => {
    const container = messagesContainerRef.current
    if (!container) return
    if (shouldAutoScrollRef.current && targetHeight > startHeight) {
      const bottomAlignmentDelta = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop)
      if (card.getBoundingClientRect().top - bottomAlignmentDelta < container.getBoundingClientRect().top) leaveBottomFollow()
    }
    captureCurrentViewportState()
  }, [captureCurrentViewportState, leaveBottomFollow])

  const cardHeightContext = useMemo(() => ({ before: prepareCardHeight, begin: beginCardHeight }), [prepareCardHeight, beginCardHeight])

  const scrollToTop = useCallback(() => {
    const container = messagesContainerRef.current
    if (container) {
      markUserViewportInteraction()
      setBottomFollow(false)
      if (historyMode === 'active' && !showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
        pendingScrollToTrueTopRef.current = true
        setShowFullTimeline(true)
        return
      }
      if (historyMode === 'continuous' && messages.length) {
        pendingScrollToTrueTopRef.current = true
        setContinuousWindowKey(getMessageStableKey(messages[0], 0))
      }
      container.scrollTop = 0
    }
  }, [historyMode, markUserViewportInteraction, messages, setBottomFollow, showFullTimeline])

  const scrollToContextScrollbarAnchor = useCallback((anchorKey: string, fraction: number): boolean => {
    const container = messagesContainerRef.current
    const timeline = committedTimelineRef.current
    if (!container || !timeline) return false
    const anchor = Array.from(timeline.querySelectorAll<HTMLElement>(CONTEXT_SCROLLBAR_ANCHOR_SELECTOR))
      .find((element) => element.getAttribute('data-context-scrollbar-anchor-key') === anchorKey)
    if (!anchor) return false
    const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop += offset + anchor.getBoundingClientRect().height * Math.max(0, Math.min(1, fraction))
    return true
  }, [])

  const handleContextScrollbarNavigate = useCallback((anchorKey: string, fraction: number) => {
    // This is an explicit pointer/keyboard scroll intent, so use the same
    // latch as wheel/touch/scrollbar interaction before moving native scroll.
    leaveBottomFollow()
    if (scrollToContextScrollbarAnchor(anchorKey, fraction)) return
    pendingContextScrollbarNavigationRef.current = { anchorKey, fraction }
    if (historyMode === 'continuous') {
      const index = messages.findIndex(message => getMessageViewportAnchorKey(message) === anchorKey)
      if (index >= 0) setContinuousWindowKey(getMessageStableKey(messages[Math.max(0, index - 20)], 0))
    } else setShowFullTimeline(true)
  }, [leaveBottomFollow, scrollToContextScrollbarAnchor, historyMode, messages])

  const readVisibleHistoryEnd = useCallback(() => {
    const container = messagesContainerRef.current
    const viewport = container?.getBoundingClientRect()
    if (!container || !viewport) return null
    const keys = new Set(Array.from(container.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR)).filter(element => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    }).map(element => element.getAttribute('data-chat-history-end-key') || element.getAttribute('data-chat-message-anchor-key')))
    const end = currentHistoryRef.current.messages.findLast(message => keys.has(getMessageViewportAnchorKey(message)))
    return end ? getMessageViewportAnchorKey(end) : null
  }, [])

  const captureHistoryCommit = useCallback(() => {
    if (shouldAutoScrollRef.current || pendingViewportRestoreRef.current || pendingScrollToTrueTopRef.current
      || pendingContextScrollbarNavigationRef.current || searchAppliedNavigationRef.current !== searchNavigation) return
    const container = messagesContainerRef.current
    const timeline = committedTimelineRef.current
    if (!container || !timeline || !timeline.querySelector('[data-search-row], [data-chat-message-anchor-key]')) return
    const resizing = pendingContentResizeRef.current
    const resizeAnchor = resizing?.interactionVersion === userInteractionVersionRef.current && resizing.state.kind === 'anchor' ? resizing.state : null
    pendingContentResizeRef.current = null
    const viewport = container.getBoundingClientRect()
    const anchors = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR)).map((element, index) => {
      const rect = element.getBoundingClientRect()
      return { messageKey: element.getAttribute('data-chat-message-anchor-key') || '', offsetPx: rect.top - viewport.top,
        distance: Math.max(viewport.top - rect.bottom, rect.top - viewport.bottom, 0), index }
    }).filter(anchor => anchor.messageKey).sort((a, b) => a.distance - b.distance || a.index - b.index)
    const visibleEndKey = readVisibleHistoryEnd()
    if (resizeAnchor) anchors.unshift({ messageKey: resizeAnchor.messageKey, offsetPx: resizeAnchor.offsetPx, distance: -1, index: -1 })
    const current = resizeAnchor || readCurrentViewportState(-1)
    if (current?.kind === 'anchor') currentViewportStateRef.current = current
    pendingViewportRestoreRef.current = { kind: 'prepend', visibleEndKey: visibleEndKey || undefined, anchors: anchors.slice(0, 8).map(({ messageKey, offsetPx }) => ({ messageKey, offsetPx })),
      scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, interactionVersion: userInteractionVersionRef.current }
  }, [readCurrentViewportState, readVisibleHistoryEnd, searchNavigation])

  const showEarlierWindow = useCallback((key: string) => {
    const visibleEndKey = readVisibleHistoryEnd()
    continuousPagingIntentRef.current = null
    setContinuousWindowEndKey(visibleEndKey)
    setContinuousWindowKey(key)
  }, [readVisibleHistoryEnd])

  const loadEarlierArchivePage = useCallback(() => loadArchivePage('earlier', rows => {
    if (currentHistoryRef.current.mode === 'continuous' && rows.length && !shouldAutoScrollRef.current) showEarlierWindow(getMessageStableKey(rows[0], 0))
  }), [loadArchivePage, showEarlierWindow])

  useEffect(() => {
    const handleScroll = () => {
      const container = messagesContainerRef.current
      if (!container) return

      const scrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const clientHeight = container.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const pagingIntent = continuousPagingIntentRef.current || (pointerScrollInteractionRef.current
        ? scrollTop < lastNativeScrollTopRef.current ? 'earlier' : scrollTop > lastNativeScrollTopRef.current ? 'later' : null
        : null)
      lastNativeScrollTopRef.current = scrollTop

      if (pointerScrollInteractionRef.current && distanceFromBottom > CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX) {
        leaveBottomFollow()
      }

      setShowScrollTopButton(scrollTop > 200)
      captureCurrentViewportState()

      const { start: windowStart, count: windowCount } = continuousWindowRangeRef.current
      const earlierContinuous = historyMode === 'continuous' && pagingIntent === 'earlier' && scrollTop < HISTORY_PRELOAD_DISTANCE_PX && !archivePage.loading && !archivePage.error
        && (windowStart > 0 || archivePage.hasEarlier)
      const laterContinuous = historyMode === 'continuous' && pagingIntent === 'later' && distanceFromBottom < 120
        && windowStart + windowCount < messages.length
      if (earlierContinuous || laterContinuous || (historyMode === 'active' && !showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES && scrollTop < HISTORY_PRELOAD_DISTANCE_PX)) {
        // This reading navigation supersedes an older host-resize correction.
        pendingContentResizeRef.current = null
        setBottomFollow(false)
        if (earlierContinuous || laterContinuous) continuousPagingIntentRef.current = null
        if (earlierContinuous) {
          if (windowStart > 0) showEarlierWindow(getMessageStableKey(messages[Math.max(0, windowStart - 100)], 0))
          else {
            void loadEarlierArchivePage()
          }
        } else if (laterContinuous) {
          setContinuousWindowKey(getMessageStableKey(messages[Math.min(messages.length - 1, windowStart + Math.max(100, windowCount - 100))], 0))
        } else {
          // Active context is local: retain its existing native-event geometry priority.
          captureHistoryCommit()
          setShowFullTimeline(true)
        }
      }
    }

    const container = messagesContainerRef.current
    if (container) {
      const handleWheel = (event: WheelEvent) => {
        const readingAwayFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight > CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX
        // Reading navigation away from the actual tail outranks pending reflow.
        if (event.deltaY < 0 || (event.deltaY > 0 && readingAwayFromBottom)) {
          leaveBottomFollow()
        } else {
          markUserViewportInteraction()
          if (event.deltaY > 0) {
            // A new downward gesture can finish a tiny leave inside bottom tolerance.
            updateBottomFollowState('toward-bottom')
            captureCurrentViewportState()
          }
        }
        if (event.deltaY) continuousPagingIntentRef.current = event.deltaY < 0 ? 'earlier' : 'later'
        // Also handle upward input when the native scroller cannot move further.
        if (historyMode === 'continuous' && event.deltaY < 0 && container.scrollTop < HISTORY_PRELOAD_DISTANCE_PX) handleScroll()
      }
      const handleTouchStart = (event: TouchEvent) => {
        markUserViewportInteraction()
        touchScrollStartYRef.current = event.touches[0]?.clientY ?? null
      }
      const handleTouchMove = (event: TouchEvent) => {
        const currentY = event.touches[0]?.clientY
        const startY = touchScrollStartYRef.current
        if (typeof currentY === 'number' && typeof startY === 'number' && currentY > startY + 2) {
          leaveBottomFollow()
        }
        if (typeof currentY === 'number') {
          if (typeof startY === 'number' && currentY !== startY) continuousPagingIntentRef.current = currentY > startY ? 'earlier' : 'later'
          touchScrollStartYRef.current = currentY
          if (historyMode === 'continuous' && typeof startY === 'number' && currentY > startY && container.scrollTop < HISTORY_PRELOAD_DISTANCE_PX) handleScroll()
        }
      }
      const handleTouchEnd = () => {
        touchScrollStartYRef.current = null
      }
      const handlePointerDown = () => {
        markUserViewportInteraction()
        // A fresh pointer gesture supersedes an unfinished earlier wheel leave.
        if (pendingUserLeaveBottomRef.current) setBottomFollow(false)
        pointerScrollInteractionRef.current = true
      }
      const handlePointerEnd = () => {
        pointerScrollInteractionRef.current = false
      }
      const handleWindowKeyDown = (event: KeyboardEvent) => {
        const target = event.target
        if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) {
          return
        }
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
          const leavesBottom = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
          if (leavesBottom) leaveBottomFollow()
          else markUserViewportInteraction()
          continuousPagingIntentRef.current = leavesBottom ? 'earlier' : 'later'
        }
      }
      container.addEventListener('scroll', handleScroll)
      container.addEventListener('wheel', handleWheel, { passive: true })
      container.addEventListener('touchstart', handleTouchStart, { passive: true })
      container.addEventListener('touchmove', handleTouchMove, { passive: true })
      container.addEventListener('touchend', handleTouchEnd, { passive: true })
      container.addEventListener('touchcancel', handleTouchEnd, { passive: true })
      container.addEventListener('pointerdown', handlePointerDown, { passive: true })
      window.addEventListener('pointerup', handlePointerEnd)
      window.addEventListener('pointercancel', handlePointerEnd)
      window.addEventListener('keydown', handleWindowKeyDown)
      return () => {
        container.removeEventListener('scroll', handleScroll)
        container.removeEventListener('wheel', handleWheel)
        container.removeEventListener('touchstart', handleTouchStart)
        container.removeEventListener('touchmove', handleTouchMove)
        container.removeEventListener('touchend', handleTouchEnd)
        container.removeEventListener('touchcancel', handleTouchEnd)
        container.removeEventListener('pointerdown', handlePointerDown)
        window.removeEventListener('pointerup', handlePointerEnd)
        window.removeEventListener('pointercancel', handlePointerEnd)
        window.removeEventListener('keydown', handleWindowKeyDown)
      }
    }
  }, [captureCurrentViewportState, captureHistoryCommit, leaveBottomFollow, markUserViewportInteraction, messages, historyMode, continuousWindowKey, archivePage, loadEarlierArchivePage, showEarlierWindow, setBottomFollow, showFullTimeline, updateBottomFollowState])

  const updateSessionModel = useCallback(async (model: string | null) => {
    setModelBusy(true)
    setModelError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { model } : { clear: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Failed to update model (${res.status})`)
      mergeConfirmedSettings(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [mergeConfirmedSettings, sessionId])

  const updateSessionNode = useCallback(async (nodeId: string, signal: AbortSignal) => {
    const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId }),
      signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error || 'Could not switch node.')
    signal.throwIfAborted()
    mergeConfirmedSettings({
      currentNode: data.session.currentNode,
      cwd: data.session.cwd,
    })
  }, [mergeConfirmedSettings, sessionId])

  const updateChildModel = useCallback(async (model: string | null) => {
    setModelBusy(true)
    setModelError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/child-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { model } : { clear: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Failed to update child default model (${res.status})`)
      mergeConfirmedSettings(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update child default model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [mergeConfirmedSettings, sessionId])

  const updateSessionEffort = useCallback(async (effort: string | null) => {
    setModelBusy(true); setModelError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Failed to update effort (${res.status})`)
      mergeConfirmedSettings(data)
    } catch (error) { setModelError(error instanceof Error ? error.message : 'Failed to update effort'); throw error }
    finally { setModelBusy(false) }
  }, [mergeConfirmedSettings, sessionId])

  const updateChildEffort = useCallback(async (effort: string | null) => {
    setModelBusy(true); setModelError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/child-model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childEffortDefault: effort }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Failed to update child effort (${res.status})`)
      mergeConfirmedSettings(data)
    } catch (error) { setModelError(error instanceof Error ? error.message : 'Failed to update child effort'); throw error }
    finally { setModelBusy(false) }
  }, [mergeConfirmedSettings, sessionId])

  useEffect(() => {
    if (pendingViewportRestoreRef.current || !shouldAutoScrollRef.current) return
    scrollToBottom()
  }, [messages, scrollToBottom, streamingAssistantDraft])

  const snapshotSystemMessage = useMemo<Message | null>(() => {
    const snapshotText = webUiIdentityMode || historyMode === 'continuous' ? '' : persistentMemorySnapshot.trim()

    if (!snapshotText) {
      return null
    }

    return {
      role: 'tool',
      parts: [{ text: `<foxwarm-system kind="snapshot" hint="snapshot" />\n${snapshotText}` }],
      __meta: {
        timestamp: -1,
        synthetic: 'persistentMemorySnapshot',
      },
    }
  }, [webUiIdentityMode, historyMode, persistentMemorySnapshot])

  const { start: continuousWindowStart, end: continuousWindowEnd } = useMemo(() => {
    const start = continuousWindowKey === null ? Math.max(0, messages.length - CONTINUOUS_HISTORY_WINDOW_SIZE)
      : Math.max(0, messages.findIndex(message => getMessageStableKey(message, 0) === continuousWindowKey))
    let end = Math.min(messages.length, Math.max(start + CONTINUOUS_HISTORY_WINDOW_SIZE,
      continuousWindowEndKey ? messages.findIndex(message => getMessageViewportAnchorKey(message) === continuousWindowEndKey) + 1 : 0))
    if (historyMode === 'continuous' && end - start > CONTINUOUS_HISTORY_WINDOW_SIZE) {
      const rows = buildTimelineRows({ messages: messages.slice(start, end), isMobile, timelineView, showUsageBadge: false,
        showTimeDividers: false, nestedDepth: 0, expandedGroupKeys: new Set<string>() }, null).rows
      if (rows.length > CONTINUOUS_HISTORY_WINDOW_SIZE) end = Math.min(messages.length, start + CONTINUOUS_HISTORY_WINDOW_SIZE)
    }
    return { start, end }
  }, [continuousWindowKey, continuousWindowEndKey, historyMode, messages, timelineView, isMobile])
  continuousWindowRangeRef.current = { start: continuousWindowStart, count: continuousWindowEnd - continuousWindowStart }
  const visibleMessages = useMemo(() => {
    if (historyMode === 'continuous') return messages.slice(continuousWindowStart, continuousWindowEnd)
    if (showFullTimeline || messages.length <= DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
      return messages
    }
    return messages.slice(-DEFAULT_VISIBLE_TIMELINE_MESSAGES)
  }, [continuousWindowStart, continuousWindowEnd, historyMode, messages, showFullTimeline])

  const displayingLatest = historyMode === 'active' || !archivePage.hasLater && continuousWindowStart + visibleMessages.length >= messages.length
  continuousWindowAtLatestRef.current = displayingLatest
  const hiddenMessageCount = messages.length - visibleMessages.length

  useEffect(() => {
    if (historyMode !== 'continuous' || !archivePage.hasLater) return
    setBottomFollow(false)
    setContinuousWindowKey(previous => previous ?? (messages.length ? getMessageStableKey(messages[continuousWindowStart], 0) : null))
  }, [archivePage.hasLater, continuousWindowStart, historyMode, messages, setBottomFollow])

  const searchFields = useMemo(() => searchOpen ? projectSessionSearchFields(messages, timelineView, activeMessages) : [], [activeMessages, timelineView, messages, searchOpen])
  const searchMatches = useMemo(() => findSessionSearchMatches(searchFields, searchQuery), [searchFields, searchQuery])
  const currentSearchIndex = searchMatches.findIndex(match => match.id === searchMatchId)
  const selectedSearchMatch = searchMatches[currentSearchIndex >= 0 ? currentSearchIndex : 0] || null

  const loadSearchHistory = useCallback(() => {
    const history = readSearchHistory()
    searchHistoryRef.current = history
    return history
  }, [])

  const recordSearchHistory = useCallback((query: string) => {
    if (!query.trim()) return
    const history = [query, ...searchHistoryRef.current.filter(item => item !== query)].slice(0, SEARCH_HISTORY_LIMIT)
    searchHistoryRef.current = history
    writeSearchHistory(history)
  }, [])

  const streamingAssistantMessage = useMemo(() => (
    buildStreamingAssistantMessage(streamingAssistantDraft)
  ), [streamingAssistantDraft])

  const timelineMessages = useMemo(() => {
    const baseMessages = snapshotSystemMessage ? [snapshotSystemMessage, ...visibleMessages] : visibleMessages
    return streamingAssistantMessage && displayingLatest ? [...baseMessages, streamingAssistantMessage] : baseMessages
  }, [snapshotSystemMessage, streamingAssistantMessage, visibleMessages, displayingLatest])

  const navigateSearch = useCallback((match: typeof selectedSearchMatch) => {
    if (!match) return
    leaveBottomFollow()
    const inGroup = match.groupKey && (match.surface === 'call' || match.surface === 'response' || match.surface === 'reasoning' || match.surface === 'system')
    const requiredIndex = inGroup ? Math.min(match.sourceIndex, match.groupStartIndex ?? match.sourceIndex) : match.sourceIndex
    if (historyMode === 'continuous') setContinuousWindowKey(getMessageStableKey(messages[Math.max(0, requiredIndex - 20)], 0))
    else if (!showFullTimeline && requiredIndex < messages.length - DEFAULT_VISIBLE_TIMELINE_MESSAGES) setShowFullTimeline(true)
    setSearchMatchId(match.id)
    setSearchNavigation(value => value + 1)
  }, [leaveBottomFollow, messages, historyMode, showFullTimeline])

  const closeSearch = useCallback(() => {
    recordSearchHistory(searchQuery)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatchId(null)
    searchHistoryIndexRef.current = null
    searchHistoryDraftRef.current = ''
    lastSearchQueryRef.current = ''
  }, [recordSearchHistory, searchQuery])

  const navigateSearchHistory = useCallback((direction: -1 | 1): boolean => {
    const history = searchHistoryRef.current
    const currentIndex = searchHistoryIndexRef.current
    if (!history.length) return false

    if (direction < 0) {
      if (currentIndex === null) searchHistoryDraftRef.current = searchQuery
      const nextIndex = currentIndex === null ? 0 : Math.min(currentIndex + 1, history.length - 1)
      searchHistoryIndexRef.current = nextIndex
      setSearchQuery(history[nextIndex])
      setSearchMatchId(null)
      return true
    }

    if (currentIndex === null) return false
    if (currentIndex === 0) {
      searchHistoryIndexRef.current = null
      setSearchQuery(searchHistoryDraftRef.current)
    } else {
      const nextIndex = currentIndex - 1
      searchHistoryIndexRef.current = nextIndex
      setSearchQuery(history[nextIndex])
    }
    setSearchMatchId(null)
    return true
  }, [searchQuery])

  const stepSearch = useCallback((direction: -1 | 1) => {
    if (!searchMatches.length) return
    if (currentSearchIndex < 0) { navigateSearch(searchMatches[0]); return }
    const index = currentSearchIndex
    navigateSearch(searchMatches[(index + direction + searchMatches.length) % searchMatches.length])
  }, [currentSearchIndex, navigateSearch, searchMatches])

  const lastSearchQueryRef = useRef('')
  useEffect(() => {
    if (!searchOpen) return
    const queryChanged = lastSearchQueryRef.current !== searchQuery
    if (!queryChanged && currentSearchIndex >= 0) return
    if (queryChanged) {
      lastSearchQueryRef.current = searchQuery
      setSearchMatchId(null)
    }
    if (!searchMatches.length) return
    // Let a person finish typing before mounting a loaded-but-windowed old row.
    const timer = window.setTimeout(() => navigateSearch(searchMatches[0]), 150)
    return () => window.clearTimeout(timer)
  }, [currentSearchIndex, navigateSearch, searchMatches, searchOpen, searchQuery])

  useEffect(() => { if (searchOpen) { searchInputRef.current?.focus(); searchInputRef.current?.select() } }, [searchOpen])

  const activateSearch = useCallback((selectedText?: string | null) => {
    loadSearchHistory()
    setSearchOpen(true)
    if (selectedText && selectedText.trim()) {
      setSearchQuery(selectedText)
      setSearchMatchId(null)
      searchHistoryIndexRef.current = null
      searchHistoryDraftRef.current = ''
    }
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [loadSearchHistory])

  useEffect(() => {
    if (!searchShortcutActive) return
    const onFindShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey)
        || event.altKey || event.shiftKey || event.isComposing) return
      const selectedText = getSelectedFindText()
      event.preventDefault()
      activateSearch(selectedText)
    }
    window.addEventListener('keydown', onFindShortcut)
    return () => window.removeEventListener('keydown', onFindShortcut)
  }, [activateSearch, searchShortcutActive])
  useLayoutEffect(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatchId(null)
    searchHistoryIndexRef.current = null
    searchHistoryDraftRef.current = ''
    lastSearchQueryRef.current = ''
  }, [sessionId])

  useLayoutEffect(() => {
    const registry = CSS.highlights
    registry?.delete(searchHighlightName)
    if (!searchOpen || !selectedSearchMatch || selectedSearchMatch.id !== searchMatchId) return
    const timeline = committedTimelineRef.current
    const surface = timeline ? findSearchSurface(timeline, selectedSearchMatch) : null
    const range = surface ? findRenderedMatchRange(surface, selectedSearchMatch.query, selectedSearchMatch.ordinal) : null
    if (!range) return
    if (registry && typeof Highlight === 'function') registry.set(searchHighlightName, new Highlight(range))
    if (searchNavigation !== searchAppliedNavigationRef.current) {
      const container = messagesContainerRef.current
      if (container) {
        const rect = range.getBoundingClientRect()
        const viewport = container.getBoundingClientRect()
        container.scrollTop += rect.top - viewport.top - Math.min(96, container.clientHeight * 0.25)
        currentViewportGeometryRef.current = null
        captureCurrentViewportState()
        searchAppliedNavigationRef.current = searchNavigation
      }
    }
    return () => { registry?.delete(searchHighlightName) }
  }, [captureCurrentViewportState, searchHighlightName, searchMatchId, searchNavigation, searchOpen, selectedSearchMatch, showFullTimeline, timelineMessages])

  useLayoutEffect(() => {
    if (!pendingScrollToTrueTopRef.current) return
    const container = messagesContainerRef.current
    if (!container || (historyMode === 'active' && !showFullTimeline)) return
    container.scrollTop = 0
    captureCurrentViewportState()
    pendingScrollToTrueTopRef.current = false
  }, [captureCurrentViewportState, historyMode, showFullTimeline, timelineMessages])

  useEffect(() => {
    if (historyMode === 'continuous' || showFullTimeline || !historyLoaded || messages.length <= DEFAULT_VISIBLE_TIMELINE_MESSAGES) return
    const container = messagesContainerRef.current
    const content = messagesContentRef.current
    if (!container || !content) return
    const expandIfNoUpwardScroll = () => {
      if (container.scrollHeight <= container.clientHeight + 1) setShowFullTimeline(true)
    }
    expandIfNoUpwardScroll()
    const observer = new ResizeObserver(expandIfNoUpwardScroll)
    observer.observe(content)
    return () => observer.disconnect()
  }, [historyLoaded, messages.length, showFullTimeline, timelineMessages])

  useLayoutEffect(() => {
    userInteractionVersionRef.current += 1
    continuousPagingIntentRef.current = null
    capturedInteractionVersionRef.current = userInteractionVersionRef.current
    pendingContextScrollbarNavigationRef.current = null
    pendingScrollToTrueTopRef.current = false
    const state = getStoredChatViewportState(viewportSessionId, historyMode) || { kind: 'bottom' as const }
    currentViewportStateRef.current = state
    pendingContentResizeRef.current = null
    currentViewportGeometryRef.current = null
    pendingViewportRestoreRef.current = { kind: 'state', state, interactionVersion: userInteractionVersionRef.current }
    setBottomFollow(state.kind === 'bottom')
  }, [historyMode, viewportSessionId, setBottomFollow])

  useLayoutEffect(() => {
    const pending = pendingViewportRestoreRef.current
    if (!pending) return

    if (pending.interactionVersion !== userInteractionVersionRef.current) {
      pendingViewportRestoreRef.current = null
      return
    }

    if (pending.kind === 'state') {
      if (applyViewportState(pending.state)) {
        pendingViewportRestoreRef.current = null
        return
      }

      if (historyMode === 'continuous' && pending.state.kind === 'anchor') {
        const messageKey = pending.state.messageKey
        const index = messages.findIndex(message => getMessageViewportAnchorKey(message) === messageKey)
        if (index >= 0 && (index < continuousWindowStart || index >= continuousWindowStart + visibleMessages.length)) {
          setContinuousWindowKey(getMessageStableKey(messages[Math.max(0, index - 20)], 0))
          return
        }
      }

      if (historyMode === 'active' && pending.state.kind === 'anchor' && !showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
        setShowFullTimeline(true)
        return
      }

      if (historyMode === 'continuous' ? !archivePage.loaded : !historyLoaded) return
      const fallbackState: ChatViewportState = { kind: 'bottom' }
      pendingViewportRestoreRef.current = null
      applyViewportState(fallbackState)
      return
    }

    if (historyMode === 'continuous' && pending.visibleEndKey && !visibleMessages.some(message => getMessageViewportAnchorKey(message) === pending.visibleEndKey)) {
      if (pending.visibleEndKey !== continuousWindowEndKey) {
        setContinuousWindowEndKey(pending.visibleEndKey)
        return
      }
      const state = currentViewportStateRef.current
      const index = state.kind === 'anchor' ? messages.findIndex(message => getMessageViewportAnchorKey(message) === state.messageKey) : -1
      if (index >= 0) {
        const key = getMessageStableKey(messages[Math.max(0, index - 20)], 0)
        if (key !== continuousWindowKey) {
          setContinuousWindowKey(key)
          return
        }
      }
    }

    if (applyViewportAnchorCandidates(pending.anchors)) {
      pendingViewportRestoreRef.current = null
      return
    }

    if (historyMode === 'active' ? !showFullTimeline || !historyLoaded : !archivePage.loaded) return

    const container = messagesContainerRef.current
    if (!container) return
    container.scrollTop = pending.scrollTop + (container.scrollHeight - pending.scrollHeight)
    pendingViewportRestoreRef.current = null
    setBottomFollow(false)

    const nextState = readCurrentViewportState(CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX)
    if (nextState?.kind === 'anchor') {
      currentViewportStateRef.current = nextState
      currentViewportGeometryRef.current = null
      capturedInteractionVersionRef.current = userInteractionVersionRef.current
      storeChatViewportState(viewportSessionId, nextState, historyMode)
    } else {
      currentViewportGeometryRef.current = {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
      }
      capturedInteractionVersionRef.current = userInteractionVersionRef.current
    }
  }, [applyViewportAnchorCandidates, applyViewportState, historyLoaded, messages.length, readCurrentViewportState, setBottomFollow, showFullTimeline, timelineMessages, viewportSessionId, historyMode, archivePage.loaded, continuousWindowStart, continuousWindowKey, continuousWindowEndKey, visibleMessages])

  useLayoutEffect(() => {
    const pending = pendingContextScrollbarNavigationRef.current
    if (!pending) return
    if (scrollToContextScrollbarAnchor(pending.anchorKey, pending.fraction)) {
      pendingContextScrollbarNavigationRef.current = null
    }
  }, [scrollToContextScrollbarAnchor, showFullTimeline, timelineMessages])

  useEffect(() => {
    const content = messagesContentRef.current
    const container = messagesContainerRef.current
    if (!content || !container) return

    const syncScrollbarGutter = () => {
      if (container.clientWidth > 0) {
        chatRootRef.current?.style.setProperty('--foxwarm-chat-scrollbar-gutter', `${container.offsetWidth - container.clientWidth}px`)
      }
    }
    syncScrollbarGutter()
    const observer = new ResizeObserver(() => {
      syncScrollbarGutter()
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current)
      }
      resizeRestoreFrameRef.current = window.requestAnimationFrame(() => {
        resizeRestoreFrameRef.current = null
        const contentResize = pendingContentResizeRef.current
        if (contentResize) {
          if (contentResize.interactionVersion === userInteractionVersionRef.current) applyViewportState(contentResize.state)
          // A width-band React commit can resize the Timeline again after this
          // delivery. Keep the pre-resize anchor until a frame has settled;
          // another observer delivery cancels this release and restores again.
          resizeRestoreFrameRef.current = window.requestAnimationFrame(() => {
            resizeRestoreFrameRef.current = null
            if (pendingContentResizeRef.current === contentResize) {
              if (contentResize.interactionVersion === userInteractionVersionRef.current) applyViewportState(contentResize.state)
              pendingContentResizeRef.current = null
            }
          })
        }
        if (capturedInteractionVersionRef.current !== userInteractionVersionRef.current) return

        const pending = pendingViewportRestoreRef.current
        if (pending) {
          if (pending.interactionVersion === userInteractionVersionRef.current) {
            if (pending.kind === 'state') {
              applyViewportState(pending.state)
            } else {
              applyViewportAnchorCandidates(pending.anchors)
            }
          }
          return
        }
        const geometry = currentViewportGeometryRef.current
        if (geometry) {
          container.scrollTop = geometry.scrollTop + (container.scrollHeight - geometry.scrollHeight)
          currentViewportGeometryRef.current = {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
          }
          return
        }
        applyViewportState(currentViewportStateRef.current)
      })
    })
    observer.observe(content)
    observer.observe(container)

    return () => {
      observer.disconnect()
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current)
        resizeRestoreFrameRef.current = null
      }
    }
  }, [applyViewportAnchorCandidates, applyViewportState])

  useLayoutEffect(() => () => {
    // A mode switch has already changed the rendered source by cleanup time.
    // Save the last owned position, never measure the replacement mode's DOM.
    storeChatViewportState(viewportSessionId, currentViewportStateRef.current, historyMode)
  }, [historyMode, viewportSessionId])

  const handleOpenDebugInfo = useCallback(() => {
    setShowDebugInfo(true)
  }, [])

  const handleCloseDebugInfo = useCallback(() => {
    setShowDebugInfo(false)
  }, [])

  const handleStop = useCallback(() => {
    void sendSessionCommand('/stop')
  }, [sendSessionCommand])

  const handleRunQueued = useCallback(() => {
    void sendSessionCommand('/dequeue')
  }, [sendSessionCommand])

  const handleCancelCompaction = useCallback(() => { void sendSessionCommand('/stop compact') }, [sendSessionCommand])

  const handleContinue = useCallback(() => {
    void sendSessionCommand('/continue')
  }, [sendSessionCommand])

  const handleCreateStreamingTranscriber = useCallback(async ({
    draftText,
    onPartial,
    onFinal,
    onError,
    onDebug,
  }: {
    draftText: string
    onPartial: (text: string) => void
    onFinal: (text: string) => void
    onError: (message: string) => void
    onDebug: (message: string) => void
  }): Promise<StreamingAsrSession> => {
    const context = buildAsrContext(activeMessages, draftText)

    return await new Promise<StreamingAsrSession>((resolve, reject) => {
      const socket = new WebSocket(getAsrStreamUrl())
      let resolved = false
      let settled = false
      let terminal = false

      const fail = (message: string) => {
        if (terminal) return
        terminal = true
        onError(message)
        if (!settled) {
          settled = true
          if (!resolved) {
            reject(new Error(message))
          }
        }
        try {
          socket.close()
        } catch {}
      }

      socket.binaryType = 'arraybuffer'

      socket.onopen = () => {
        if (terminal) return
        onDebug(`ws open; contextLength=${context.length} language=auto`)
        socket.send(JSON.stringify({
          type: 'start',
          context,
        }))
        onDebug('ws start sent')
      }

      socket.onmessage = (event) => {
        if (terminal) return
        try {
          const payload = JSON.parse(String(event.data))
          if (payload.type === 'ready') {
            onDebug('ws ready received')
            if (resolved) return
            resolved = true
            settled = true
            let chunkCount = 0
            let totalBytes = 0
            resolve({
              sendAudioChunk: (chunk: ArrayBuffer) => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(chunk)
                  chunkCount += 1
                  totalBytes += chunk.byteLength
                  if (chunkCount <= 3 || chunkCount % 20 === 0) {
                    onDebug(`ws chunk sent; count=${chunkCount} bytes=${chunk.byteLength} totalBytes=${totalBytes}`)
                  }
                }
              },
              stop: () => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: 'stop' }))
                  onDebug(`ws stop sent; chunkCount=${chunkCount} totalBytes=${totalBytes}`)
                }
              },
              cancel: () => {
                terminal = true
                onDebug('ws cancel called')
                try {
                  socket.close()
                } catch {}
              },
            })
            return
          }

          if (payload.type === 'partial') {
            onDebug(`ws partial received; textLength=${typeof payload.text === 'string' ? payload.text.length : 0}`)
            onPartial(typeof payload.text === 'string' ? payload.text : '')
            return
          }

          if (payload.type === 'final') {
            terminal = true
            onDebug(`ws final received; textLength=${typeof payload.text === 'string' ? payload.text.length : 0}`)
            onFinal(typeof payload.text === 'string' ? payload.text : '')
            try {
              socket.close()
            } catch {}
            return
          }

          if (payload.type === 'error') {
            onDebug(`ws error payload; ${payload.error || 'unknown error'}`)
            fail(payload.error || 'Streaming ASR failed')
          }
        } catch (error) {
          onDebug(`ws invalid payload; ${error instanceof Error ? error.message : 'unknown error'}`)
          fail(error instanceof Error ? error.message : 'Invalid streaming ASR response')
        }
      }

      socket.onerror = () => {
        onDebug('ws onerror fired')
        fail('Failed to connect to streaming ASR service')
      }

      socket.onclose = () => {
        onDebug(`ws closed; resolved=${String(resolved)} settled=${String(settled)} terminal=${String(terminal)}`)
        if (terminal) return
        if (resolved) fail('Streaming ASR connection closed before the final transcript')
        else {
          terminal = true
          settled = true
          reject(new Error('Streaming ASR connection closed before ready'))
        }
      }
    })
  }, [activeMessages])

  const contextLimit = useMemo(() => {
    const currentModelKey = sessionRecord?.modelKey
    return modelOptions.find(option => option.key === currentModelKey)?.contextLimit ?? null
  }, [modelOptions, sessionRecord?.modelKey])

  const turnIncomplete = useMemo(() => isSessionTurnIncomplete(activeMessages), [activeMessages])

  const renderQueuedFooter = (alignment: 'left' | 'right') => <QueuedMessageStatus
    count={sessionQueueLength}
    disabled={!!pendingControl || !!sessionRecord?.runtimeState?.stopping}
    alignment={alignment}
    isMobile={isMobile}
    onRunQueued={webUiIdentityMode ? undefined : handleRunQueued}
  />

  return (
    <div ref={chatRootRef} data-mobile-chat-ui={mobileUi || undefined} data-chat-connection-state={connectionState} data-compact-composer={compactComposer ? "true" : undefined} className="foxwarm-chat-root relative flex h-full flex-col overflow-hidden">
      {searchOpen && <style>{`::highlight(${searchHighlightName}) { background-color: #facc15; color: #171717; }`}</style>}
      <ContentHeader
        icon={<MessageSquareText className="h-5 w-5" />}
        title={sessionDisplayName || sessionRecord?.displayName || sessionId}
        compact={mobileUi}
        subtitle={webUiIdentityMode || mobileUi ? null : (
          <span data-session-header-subtitle className="font-mono text-[12px]" title={sessionRecord?.cwd || undefined}>
            {sessionHeaderSubtitle}
          </span>
        )}
        onBack={isMobile ? onBack : undefined}
        sticky
        below={searchOpen ? (
          <div role="search" className="flex min-w-0 items-center gap-2" data-chat-search>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={event => {
                setSearchQuery(event.target.value)
                searchHistoryIndexRef.current = null
                searchHistoryDraftRef.current = ''
              }}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); closeSearch() }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  recordSearchHistory(searchQuery)
                  searchHistoryIndexRef.current = null
                  searchHistoryDraftRef.current = ''
                  stepSearch(event.shiftKey ? -1 : 1)
                }
                if (!event.nativeEvent.isComposing && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                  if (navigateSearchHistory(event.key === 'ArrowUp' ? -1 : 1)) event.preventDefault()
                }
              }}
              type="search"
              aria-label="Search messages"
              placeholder="Search messages"
              className="min-w-0 flex-1 rounded-md border border-fw-border bg-fw-surface px-3 py-1.5 text-sm text-fw-text-strong focus:outline-fw-accent dark:border-fw-border-strong"
            />
            <span aria-live="polite" className="shrink-0 text-xs text-fw-text-muted tabular-nums">{searchQuery ? `${selectedSearchMatch ? Math.max(currentSearchIndex, 0) + 1 : 0}/${searchMatches.length}` : '0/0'}</span>
            <button type="button" onClick={() => stepSearch(-1)} disabled={!searchMatches.length} aria-label="Previous match" className="rounded p-1.5 text-fw-text-muted hover:bg-fw-hover disabled:opacity-40"><ChevronUp size={16} /></button>
            <button type="button" onClick={() => stepSearch(1)} disabled={!searchMatches.length} aria-label="Next match" className="rounded p-1.5 text-fw-text-muted hover:bg-fw-hover disabled:opacity-40"><ChevronDown size={16} /></button>
            <button type="button" onClick={closeSearch} aria-label="Close search" className="rounded p-1.5 text-fw-text-muted hover:bg-fw-hover"><X size={16} /></button>
            {!isFullHistoryLoaded && <span className="foxwarm-chat-lg-label text-xs text-fw-text-muted">Earlier messages may still load.</span>}
          </div>
        ) : undefined}
        actions={webUiIdentityMode ? null : (
          <>
            {mobileUi && onNewSession && <button type="button" aria-label="Start a new session" title="New session" disabled={creatingSession}
              onClick={async () => { if (creatingSession) return; setCreatingSession(true); try { await onNewSession() } finally { setCreatingSession(false) } }}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-fw-text-strong hover:bg-fw-hover disabled:opacity-50"><SquarePen size={20} /></button>}
            {!mobileUi && <button type="button" onClick={() => activateSearch()} aria-label="Find in chat" title="Find in chat" className="inline-flex items-center gap-1 rounded-lg border border-fw-border px-2 py-2 text-sm text-fw-text hover:bg-fw-hover dark:border-fw-border-strong dark:text-fw-text-strong dark:hover:bg-fw-hover">
              <Search className="h-4 w-4" /><span className="foxwarm-chat-sm-label">Find</span>
            </button>}
            {!mobileUi && onOpenCode && (
              <button
                onClick={onOpenCode}
                className="foxwarm-chat-code-button inline-flex items-center gap-1 rounded-lg border border-fw-border px-2 py-2 text-sm text-fw-text hover:bg-fw-hover dark:border-fw-border-strong dark:text-fw-text-strong dark:hover:bg-fw-hover"
                title="Code"
              >
                <Code2 className="h-4 w-4" />
                <span className="foxwarm-chat-sm-label">Code</span>
              </button>
            )}
            {!mobileUi && onOpenTerminal && (
              <button
                onClick={onOpenTerminal}
                className="inline-flex items-center gap-1 rounded-lg border border-fw-border px-3 py-2 text-sm text-fw-text hover:bg-fw-hover dark:border-fw-border-strong dark:text-fw-text-strong dark:hover:bg-fw-hover"
                title="Terminal"
              >
                <SquareTerminal className="h-4 w-4" />
                <span className="foxwarm-chat-md-label">Terminal</span>
              </button>
            )}
            <SessionUiSettingsMenu
              mobile={mobileUi}
              onFind={() => activateSearch()}
              onOpenCode={onOpenCode}
              onOpenTerminal={onOpenTerminal}
              sendKeyMode={sendKeyMode}
              onSendKeyModeChange={onSendKeyModeChange}
              timelineView={timelineView}
              onTimelineViewChange={onTimelineViewChange}
              showUsageBadge={showUsageBadge}
              onShowUsageBadgeChange={onShowUsageBadgeChange}
              fullWidth={fullWidth}
              onFullWidthChange={onFullWidthChange}
              showUserMessageMetadata={showUserMessageMetadata}
              onShowUserMessageMetadataChange={onShowUserMessageMetadataChange}
              onOpenDebugInfo={handleOpenDebugInfo}
            />
          </>
        )}
      />

      {connectionState !== 'connected' && (
        <div data-chat-connection-status className={`sticky top-0 z-20 px-4 py-2 text-sm ${
          connectionState === 'connecting' ? 'bg-fw-warning-surface dark:bg-fw-warning-surface-strong/20 text-fw-warning dark:text-fw-warning' :
          connectionState === 'reconnecting' ? 'bg-fw-warning-surface dark:bg-fw-warning-surface-strong/20 text-fw-warning dark:text-fw-warning' :
          'bg-fw-danger-surface dark:bg-fw-danger-surface-strong/20 text-fw-danger dark:text-fw-danger'
        }`}>
          {connectionState === 'connecting' && 'Connecting...'}
          {connectionState === 'reconnecting' && 'Reconnecting...'}
          {connectionState === 'disconnected' && 'Disconnected'}
        </div>
      )}

      <div className="foxwarm-chat-message-region relative min-h-0 flex-1">
        <div
          id={chatMessageContainerId}
          ref={messagesContainerRef}
          data-show-system-scrollbar={showScrollbar}
          data-show-context-minimap={showMinimap}
          className="foxwarm-chat-messages foxwarm-content-gutter h-full overflow-x-hidden overflow-y-auto py-4"
        >
          {!isMobile && showMinimap && (
            <div className="foxwarm-context-scrollbar-overlay">
              <ContextScrollbar
                settings={contextScrollbarSettings}
                messages={messages}
                contextMessages={activeMessages}
                persistentMemorySnapshot={snapshotSystemMessage}
                contextLimit={contextLimit}
                historyComplete={isFullHistoryLoaded}
                containerId={chatMessageContainerId}
                containerRef={messagesContainerRef}
                timelineRef={committedTimelineRef}
                onNavigate={handleContextScrollbarNavigate}
              />
            </div>
          )}
          <div ref={messagesContentRef} data-full-width={fullWidth} className="foxwarm-chat-messages-content foxwarm-content-column">
            {historyMode === 'active' && hiddenMessageCount > 0 && !showFullTimeline && (
              <div className="mb-3 rounded-lg border border-fw-border bg-fw-surface/80 px-3 py-2 text-xs text-fw-text-muted shadow-sm dark:border-fw-border dark:bg-fw-surface/80 dark:text-fw-text">
                Showing the latest {visibleMessages.length} messages. Scroll upward to load {hiddenMessageCount} earlier messages.
              </div>
            )}
            {historyMode === 'active' && earlierHistoryError && !isFullHistoryLoaded && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-fw-border bg-fw-surface/80 px-3 py-2 text-xs text-fw-text-muted shadow-sm dark:border-fw-border dark:bg-fw-surface/80 dark:text-fw-text">
                <span>Earlier messages could not be loaded.</span>
                <button
                  type="button"
                  className="font-medium text-fw-accent hover:underline"
                  onClick={() => {
                    void retryEarlierHistory()
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {historyMode === 'continuous' && <div className="mb-3 flex items-center justify-between gap-3 text-xs text-fw-text-muted" data-continuous-history>
              <span>{archivePage.loading ? 'Loading messages…' : archivePage.error ? 'Messages could not be loaded.' : archivePage.hasEarlier || continuousWindowStart > 0 ? 'Scroll up for earlier messages.' : ''}</span>
              {(archivePage.error || archivePage.hasEarlier) && <button type="button" disabled={archivePage.loading} className="text-fw-accent hover:underline" onClick={() => {
                const state = captureCurrentViewportState()
                const interactionVersion = userInteractionVersionRef.current
                const direction = archivePage.error ? archivePage.direction : archivePage.loaded ? 'earlier' : 'initial'
                if (direction === 'earlier') { void loadEarlierArchivePage(); return }
                void loadArchivePage(direction).then(rows => {
                  if (interactionVersion !== userInteractionVersionRef.current) return
                  if (state) pendingViewportRestoreRef.current = { kind: 'state', state, interactionVersion }
                  if (rows.length && direction !== 'later' && direction !== 'latest') setContinuousWindowKey(getMessageStableKey(rows[0], 0))
                })
              }}>{archivePage.error ? 'Retry' : 'Load earlier messages'}</button>}
            </div>}
            <HistoryCommit revision={historyMode === 'continuous' ? visibleMessages : showFullTimeline} beforeCommit={captureHistoryCommit}>
            <div ref={committedTimelineRef} data-chat-timeline="committed" className="min-w-0 max-w-full">
              <ThreadCardHeightContext.Provider value={cardHeightContext}>
                <ToolScriptProgressContext.Provider value={toolScriptProgress}>
                  <ChatTimeline sessionId={sessionId} historyMessages={messages} currentHistoryMessages={activeMessages} runtimeState={displayingLatest ? sessionRecord?.runtimeState : undefined} busyStartedAt={displayingLatest ? sessionRecord?.busyStartedAt : undefined} isRunningTool={displayingLatest && sessionRecord?.runtimeState?.state === 'running-tool'} messages={timelineMessages} isMobile={isMobile} timelineView={timelineView} showUsageBadge={showUsageBadge} showUserMessageMetadata={showUserMessageMetadata} onOpenCodeFile={onOpenCodeFile} onOpenCodeCommit={onOpenCodeCommit} searchTarget={searchOpen && selectedSearchMatch?.id === searchMatchId ? selectedSearchMatch : null} renderMessageFooter={displayingLatest && sessionQueueLength > 0 && queuedMessages.length === 0 ? renderQueuedFooter : undefined} />
                </ToolScriptProgressContext.Provider>
              </ThreadCardHeightContext.Provider>
            </div>
            </HistoryCommit>
            {historyMode === 'continuous' && archivePage.hasLater && <button type="button" disabled={archivePage.loading} className="my-3 text-xs text-fw-accent hover:underline" onClick={() => { void loadArchivePage('later') }}>Load newer messages</button>}
            {displayingLatest && <ProcessingStatus
              timelineView={timelineView}
              sessionBusy={sessionBusy}
              runtimeState={sessionRecord?.runtimeState}
              sessionQueueLength={sessionQueueLength}
              turnIncomplete={sessionRecord?.runtimeState?.state === 'idle' && turnIncomplete}
              loading={loading}
              pendingControl={pendingControl}
              controlFeedback={controlFeedback}
              failure={getLastSessionFailure(messages)}
              onCancelCompaction={webUiIdentityMode ? undefined : handleCancelCompaction}
              isMobile={isMobile}
              onContinue={webUiIdentityMode ? undefined : handleContinue}
            />}
            {displayingLatest && queuedMessages.length > 0 && (
              <div className="foxwarm-queued-preview min-w-0 max-w-full" data-queued-preview="true" aria-label="Queued messages">
                <ThreadCardHeightContext.Provider value={cardHeightContext}><ChatTimeline sessionId={sessionId} messages={queuedMessages} isMobile={isMobile} timelineView={timelineView} showUsageBadge={false} showTimeDividers={false} showUserMessageMetadata={showUserMessageMetadata} onOpenCodeFile={onOpenCodeFile} onOpenCodeCommit={onOpenCodeCommit} renderMessageFooter={sessionQueueLength > 0 ? renderQueuedFooter : undefined} /></ThreadCardHeightContext.Provider>
              </div>
            )}
            <div aria-hidden="true" data-chat-composer-spacer style={{ height: 'calc(var(--chat-composer-offset, 224px) - 2.5rem)' }} />
          </div>
        </div>
        <div className="foxwarm-display-effect-overlay" aria-hidden="true" />
        {showScrollTopButton && (
          <button
            onClick={scrollToTop}
            className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-fw-accent text-fw-accent-text shadow-lg transition-all hover:bg-fw-accent dark:bg-fw-accent dark:hover:bg-fw-accent"
            aria-label="Scroll to top"
            style={mobileUi ? {top: 'calc(var(--chat-mobile-header-height, 60px) + 1rem)'} : undefined}
          >
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
        )}

        {(!followingBottom || historyMode === 'continuous' && archivePage.hasLater) && (
          <button
            onClick={handleBottomNavigation}
            className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-fw-accent text-fw-accent-text shadow-lg transition-all hover:bg-fw-accent dark:bg-fw-accent dark:hover:bg-fw-accent"
            style={{ bottom: 'calc(var(--chat-composer-offset, 224px) + 1rem)' }}
            aria-label="Scroll to bottom"
          >
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        )}
      </div>

      <ChatComposer
        experimentalTextOnly={experimentalTextOnly}
        experimentalAttachments={experimentalAttachments}
        compactModelSelector={compactModelSelector}
        sessionId={sessionId}
        webUiIdentityMode={webUiIdentityMode}
        currentNode={sessionRecord?.currentNode}
        onChangeNode={updateSessionNode}
        sessionMissing={sessionMissing}
        loading={loading}
        stopPending={pendingControl === 'stop' || !!sessionRecord?.runtimeState?.stopping}
        sessionRunning={isSessionRuntimeActive({runtimeState: sessionRecord?.runtimeState, busy: sessionBusy})}
        onStop={webUiIdentityMode ? undefined : handleStop}
        asrAvailable={asrAvailable}
        modelOptions={modelOptions}
        currentModelKey={sessionRecord?.modelKey}
        sessionModel={sessionRecord?.model || null}
        defaultModelKey={sessionRecord?.defaultModelKey}
        childModelDefault={sessionRecord?.childModelDefault || null}
        childModelPolicySource={sessionRecord?.childModelPolicySource}
        childPolicyChain={sessionRecord?.childPolicyChain}
        effectiveChildModelKey={sessionRecord?.effectiveChildModelKey}
        effort={sessionRecord?.effort || null}
        effectiveEffort={sessionRecord?.effectiveEffort}
        effortAllowed={sessionRecord?.effortAllowed || []}
        effortDefault={sessionRecord?.effortDefault || null}
        childEffortDefault={sessionRecord?.childEffortDefault || null}
        effectiveChildEffort={sessionRecord?.effectiveChildEffort}
        childEffortAllowed={sessionRecord?.childEffortAllowed || []}
        childModelEffortDefault={sessionRecord?.childModelEffortDefault || null}
        modelBusy={modelBusy}
        modelError={modelError}
        onChangeModel={updateSessionModel}
        onChangeChildModel={updateChildModel}
        onChangeEffort={updateSessionEffort}
        onChangeChildEffort={updateChildEffort}
        onRefreshModels={refreshModelOptions}
        modelsRefreshing={modelsRefreshing}
        onOpenModelSettings={onOpenModelSettings || (() => {})}
        sendKeyMode={sendKeyMode}
        onHeightChange={handleComposerHeightChange}
        onSend={handleSend}
        onCreateStreamingTranscriber={handleCreateStreamingTranscriber}
      />

      {!webUiIdentityMode && showDebugInfo && (
        <SessionDebugModal
          source={{
            sessionId,
            sessionDisplayName,
            sessionRecord,
            messages: activeMessages,
            connectionState,
            reconnectCountdown,
            sessionMissing,
            sessionBusy,
            sessionQueueLength,
            queuedPreviewCount: queuedMessages.length,
            timelineView,
            showUsageBadge,
            showUserMessageMetadata,
            sendKeyMode,
            loading,
            asrAvailable,
            modelBusy,
            streamingAssistantDraft,
          }}
          onClose={handleCloseDebugInfo}
        />
      )}
    </div>
  )
}, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.searchShortcutActive === next.searchShortcutActive &&
  prev.experimentalTextOnly === next.experimentalTextOnly &&
  prev.experimentalAttachments === next.experimentalAttachments &&
  prev.sessionDisplayName === next.sessionDisplayName &&
  Boolean(prev.onBack) === Boolean(next.onBack) &&
  Boolean(prev.onNewSession) === Boolean(next.onNewSession) &&
  prev.onOpenTerminal === next.onOpenTerminal
  && prev.onOpenCode === next.onOpenCode
  && prev.onOpenCodeFile === next.onOpenCodeFile
  && prev.onOpenCodeCommit === next.onOpenCodeCommit
  && prev.onOpenModelSettings === next.onOpenModelSettings
  && prev.sendKeyMode === next.sendKeyMode
  && prev.historyMode === next.historyMode
  && prev.timelineView === next.timelineView
  && prev.showUsageBadge === next.showUsageBadge
  && prev.webUiIdentityMode === next.webUiIdentityMode
  && prev.fullWidth === next.fullWidth
  && prev.onFullWidthChange === next.onFullWidthChange
  && prev.showUserMessageMetadata === next.showUserMessageMetadata
  && prev.onSendKeyModeChange === next.onSendKeyModeChange
  && prev.onTimelineViewChange === next.onTimelineViewChange
  && prev.onShowUsageBadgeChange === next.onShowUsageBadgeChange
  && prev.onShowUserMessageMetadataChange === next.onShowUserMessageMetadataChange
))

export default Chat
