import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Code2, ExternalLink, Menu, MessageSquareText, SquareTerminal } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import ChatComposer from './ChatComposer'
import type { ModelOption } from './ChatComposer'
import ChatTimeline from './ChatTimeline'
import ContextScrollbar from './ContextScrollbar'
import type { CodeCommitTarget } from '../commitMarker'
import ContentHeader from './ContentHeader'
import ProcessingStatus from './ProcessingStatus'
import type { Message, MessagePart, ModelStreamToolCall, SessionStreamEvent, ToolScriptSubCall } from './chatShared'
import SessionDebugModal from './SessionDebugModal'
import { ToolScriptProgressContext } from './ToolScriptProgressContext'
import { isSessionRuntimeActive, type SessionRuntimeState } from '../sessionRuntimeState'
import { shouldAppendOptimisticMessage } from '../utils/chatOptimistic'
import { getRetryableLlmRetryNotice } from '../retryNotice'
import { formatSessionHeaderSubtitle } from '../sessionHeader'
import { createLatestRequestGate, runLatestModelOptionsRequest } from '../modelOptionsLoader'
import {
  buildOptimisticUserMessage,
  getClientMessageId,
  hasStableHistoryIdentity,
  mergeHistorySnapshot,
  reconcileHistoryMessage,
} from '../chatHistoryState'
import {
  CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX,
  CHAT_MESSAGE_ANCHOR_SELECTOR,
  CONTEXT_SCROLLBAR_ANCHOR_SELECTOR,
  chooseChatViewportState,
  getChatViewportAnchorAdjustment,
  getStoredChatViewportState,
  storeChatViewportState,
  updateChatBottomFollow,
  type ChatViewportState,
} from '../chatViewportState'

function getAsrStreamUrl() {
  const base = `${window.location.origin}${API_BASE_PATH}/asr/stream`
  return base.replace(/^http/i, 'ws')
}

type AsrTranscribeResult = {
  text: string
  status: number
  rawLength: number
  textLength: number
  responsePreview: string
}

const ASR_CONTEXT_MAX_CHARS = 2400
const ASR_CONTEXT_MAX_MESSAGES = 8
const DEFAULT_VISIBLE_TIMELINE_MESSAGES = 100

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
  canonicalSessionId?: string
  sessionDisplayName?: string
  onBack?: () => void
  onOpenTerminal?: () => void
  onOpenCode?: () => void
  onOpenCodeNewWindow?: () => void
  onOpenCodeFile?: (filePath: string, lines?: { startLine?: number; endLine?: number }) => void
  onOpenCodeCommit?: (target: CodeCommitTarget) => void | Promise<void>
  onOpenModelSettings?: () => void
  sendKeyMode?: 'modEnter' | 'enter'
  groupTools?: boolean
  showUsageBadge?: boolean
  onDraftEdited?: (draftText: string) => void
}

type StreamingAsrSession = {
  sendAudioChunk: (chunk: ArrayBuffer) => void
  stop: () => void
  cancel: () => void
}

type SessionListRecord = {
  id: string
  agent?: string
  messageCount?: number
  lastMessageTime?: number
  parentSessionId?: string | null
  childSessions?: string[]
  aliases?: string[]
  busy?: boolean
  busyStartedAt?: number | null
  queueLength?: number
  runtimeState?: SessionRuntimeState
  displayName?: string | null
  archived?: boolean
  currentNode?: string
  cwd?: string | null
  model?: string | null
  modelKey?: string
  defaultModelKey?: string
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  isolated?: boolean
}

type StreamingAssistantDraft = {
  streamId: string
  iteration?: number
  reasoning: string
  text: string
  toolCalls: ModelStreamToolCall[]
}

const normalizeStreamingToolCalls = (toolCalls: ModelStreamToolCall[] | undefined): ModelStreamToolCall[] => {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((toolCall, fallbackIndex) => ({
    index: Number.isFinite(toolCall.index) ? toolCall.index : fallbackIndex,
    ...(typeof toolCall.id === 'string' && toolCall.id.trim() ? { id: toolCall.id.trim() } : {}),
    ...(typeof toolCall.name === 'string' && toolCall.name.trim() ? { name: toolCall.name.trim() } : {}),
  }))
}

const buildStreamingAssistantMessage = (draft: StreamingAssistantDraft | null): Message | null => {
  if (!draft) return null

  const parts: MessagePart[] = []
  if (draft.reasoning.trim()) {
    parts.push({ thinking: draft.reasoning })
  }
  if (draft.text) {
    parts.push({ text: draft.text })
  }
  for (const toolCall of draft.toolCalls) {
    parts.push({
      functionCall: {
        id: toolCall.id || `stream-${draft.streamId}-${toolCall.index}`,
        name: toolCall.name || 'tool call',
        args: {},
      },
    })
  }

  if (parts.length === 0) return null
  return {
    role: 'model',
    parts,
    __meta: {
      synthetic: 'streamingAssistantDraft',
      temporary: true,
      streaming: true,
      streamId: draft.streamId,
      iteration: draft.iteration,
      timestamp: Number.MAX_SAFE_INTEGER,
    },
  }
}

const Chat = memo(function Chat({ sessionId, canonicalSessionId, sessionDisplayName, onBack, onOpenTerminal, onOpenCode, onOpenCodeNewWindow, onOpenCodeFile, onOpenCodeCommit, onOpenModelSettings, sendKeyMode = 'modEnter', groupTools = false, showUsageBadge = true, onDraftEdited }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionMissing, setSessionMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionQueueLength, setSessionQueueLength] = useState(0)
  const [queuedMessages, setQueuedMessages] = useState<Message[]>([])
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [connectionState, setConnectionState] = useState<'connected' | 'connecting' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [showScrollTopButton, setShowScrollTopButton] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showDebugInfo, setShowDebugInfo] = useState(false)
  const [streamingAssistantDraft, setStreamingAssistantDraft] = useState<StreamingAssistantDraft | null>(null)
  const [toolScriptProgress, setToolScriptProgress] = useState<Record<string, ToolScriptSubCall[]>>({})
  const [asrAvailable, setAsrAvailable] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [modelsRefreshing, setModelsRefreshing] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sessionRecord, setSessionRecord] = useState<SessionListRecord | null>(null)
  const [persistentMemorySnapshot, setPersistentMemorySnapshot] = useState('')
  const [showFullTimeline, setShowFullTimeline] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const sessionHeaderSubtitle = formatSessionHeaderSubtitle(sessionId, sessionRecord?.cwd)
  const chatMessageContainerId = `foxwarm-chat-messages-${useId()}`

  const viewportSessionId = canonicalSessionId || sessionId
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const committedTimelineRef = useRef<HTMLDivElement>(null)
  const chatRootRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastKnownTimestampRef = useRef<number>(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef<number>(1000)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const shouldAutoScrollRef = useRef<boolean>(true)
  const pendingUserLeaveBottomRef = useRef(false)
  const touchScrollStartYRef = useRef<number | null>(null)
  const pointerScrollInteractionRef = useRef(false)
  const pendingSentMessageIdsRef = useRef<Set<string>>(new Set())
  const sessionBusyRef = useRef(false)
  const sessionQueueLengthRef = useRef(0)
  const sessionMessageCountRef = useRef(0)
  const queuedMessagesRef = useRef<Message[]>([])
  const sessionStateInitializedRef = useRef(false)
  const composerHeightRef = useRef<number | null>(null)
  const initialViewportState = getStoredChatViewportState(viewportSessionId) || { kind: 'bottom' as const }
  const currentViewportStateRef = useRef<ChatViewportState>(initialViewportState)
  const pendingViewportRestoreRef = useRef<{ state: ChatViewportState; interactionVersion: number } | null>({
    state: initialViewportState,
    interactionVersion: 0,
  })
  const userInteractionVersionRef = useRef(0)
  const capturedInteractionVersionRef = useRef(0)
  const resizeRestoreFrameRef = useRef<number | null>(null)
  const pendingContextScrollbarNavigationRef = useRef<{ anchorKey: string; fraction: number } | null>(null)
  const pendingScrollToTrueTopRef = useRef(false)
  const modelRequestGateRef = useRef(createLatestRequestGate())
  const historyRequestGateRef = useRef(createLatestRequestGate())
  const historyAbortControllerRef = useRef<AbortController | null>(null)
  const historyInFlightRef = useRef<{ sessionId: string; promise: Promise<boolean>; controller: AbortController } | null>(null)
  const historyTrailingRefreshRef = useRef(false)
  const historyEventVersionRef = useRef(0)
  const historyStateEventVersionRef = useRef(0)
  const historyModelStreamEventVersionRef = useRef(0)
  const historyEventsRef = useRef<Array<{ version: number; message: Message }>>([])
  const historyRefreshTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    setMessages([])
    setHistoryLoaded(false)
    setStreamingAssistantDraft(null)
    setToolScriptProgress({})
    setQueuedMessages([])
    setSessionRecord(null)
    setSessionBusy(false)
    setSessionQueueLength(0)
    sessionBusyRef.current = false
    sessionQueueLengthRef.current = 0
    sessionMessageCountRef.current = 0
    queuedMessagesRef.current = []
    pendingSentMessageIdsRef.current.clear()
    sessionStateInitializedRef.current = false
    historyRequestGateRef.current.invalidate()
    historyAbortControllerRef.current?.abort()
    historyAbortControllerRef.current = null
    historyInFlightRef.current = null
    historyTrailingRefreshRef.current = false
    historyEventVersionRef.current = 0
    historyStateEventVersionRef.current = 0
    historyModelStreamEventVersionRef.current = 0
    historyEventsRef.current = []
    setPersistentMemorySnapshot('')
    pendingContextScrollbarNavigationRef.current = null
    pendingScrollToTrueTopRef.current = false
  }, [sessionId])

  useEffect(() => {
    sessionBusyRef.current = sessionBusy
  }, [sessionBusy])

  useEffect(() => {
    sessionQueueLengthRef.current = sessionQueueLength
  }, [sessionQueueLength])

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages
  }, [queuedMessages])

  useEffect(() => {
    setShowDebugInfo(false)
  }, [sessionId])

  useEffect(() => {
    let cancelled = false

    const fetchAsrStatus = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/asr/status`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) {
          setAsrAvailable(Boolean(data?.configured && data?.available))
        }
      } catch (e) {
        if (!cancelled) {
          setAsrAvailable(false)
        }
      }
    }

    fetchAsrStatus()
    return () => {
      cancelled = true
    }
  }, [])

  const fetchModels = useCallback(async () => {
    await runLatestModelOptionsRequest(modelRequestGateRef.current, async () => {
      const res = await fetch(`${API_BASE_PATH}/models`)
      if (!res.ok) throw new Error(`Failed to load models (${res.status})`)
      const data = await res.json()
      return (Array.isArray(data.models) ? data.models : []) as ModelOption[]
    }, (state) => {
      if (state.options) setModelOptions(state.options)
      if (state.error !== undefined) {
        setModelError(state.error)
        if (state.error) console.error('Failed to fetch models:', state.error)
      }
      if (state.loading !== undefined) setModelsRefreshing(state.loading)
    })
  }, [])

  useEffect(() => {
    void fetchModels()
    return () => modelRequestGateRef.current.invalidate()
  }, [fetchModels])

  useEffect(() => {
    if (!sessionBusy) {
      setStreamingAssistantDraft(null)
    }
  }, [sessionBusy])

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
      const state: ChatViewportState = { kind: 'bottom' }
      currentViewportStateRef.current = state
      shouldAutoScrollRef.current = true
      pendingUserLeaveBottomRef.current = false
      storeChatViewportState(viewportSessionId, state)
    }
  }, [viewportSessionId])

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

  const updateBottomFollowState = useCallback((userIntent: 'none' | 'leave' = 'none') => {
    const container = messagesContainerRef.current
    const distanceFromBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : Number.POSITIVE_INFINITY
    const next = updateChatBottomFollow({
      following: shouldAutoScrollRef.current,
      pendingUserLeave: pendingUserLeaveBottomRef.current,
      distanceFromBottom,
      userIntent,
    })
    shouldAutoScrollRef.current = next.following
    pendingUserLeaveBottomRef.current = next.pendingUserLeave
    return next
  }, [])

  const captureCurrentViewportState = useCallback((): ChatViewportState | null => {
    const followState = updateBottomFollowState()
    const bottomThresholdPx = followState.pendingUserLeave
      ? -1
      : followState.following
        ? undefined
        : CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX
    const state = readCurrentViewportState(bottomThresholdPx)
    if (!state) return null

    currentViewportStateRef.current = state
    capturedInteractionVersionRef.current = userInteractionVersionRef.current
    storeChatViewportState(viewportSessionId, state)
    return state
  }, [readCurrentViewportState, updateBottomFollowState, viewportSessionId])

  const applyViewportState = useCallback((state: ChatViewportState): boolean => {
    const container = messagesContainerRef.current
    if (!container) return false

    if (state.kind === 'bottom') {
      container.scrollTop = container.scrollHeight
      currentViewportStateRef.current = state
      shouldAutoScrollRef.current = true
      pendingUserLeaveBottomRef.current = false
      storeChatViewportState(viewportSessionId, state)
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
    shouldAutoScrollRef.current = false
    pendingUserLeaveBottomRef.current = false
    storeChatViewportState(viewportSessionId, state)
    return true
  }, [viewportSessionId])

  const markUserViewportInteraction = useCallback(() => {
    userInteractionVersionRef.current += 1
    pendingViewportRestoreRef.current = null
  }, [])

  const leaveBottomFollow = useCallback(() => {
    markUserViewportInteraction()
    updateBottomFollowState('leave')
  }, [markUserViewportInteraction, updateBottomFollowState])

  const scrollToTop = useCallback(() => {
    const container = messagesContainerRef.current
    if (container) {
      markUserViewportInteraction()
      shouldAutoScrollRef.current = false
      pendingUserLeaveBottomRef.current = false
      if (!showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
        pendingScrollToTrueTopRef.current = true
        setShowFullTimeline(true)
        return
      }
      container.scrollTop = 0
    }
  }, [markUserViewportInteraction, messages.length, showFullTimeline])

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
    setShowFullTimeline(true)
  }, [leaveBottomFollow, scrollToContextScrollbarAnchor])

  useEffect(() => {
    const handleScroll = () => {
      const container = messagesContainerRef.current
      if (!container) return

      const scrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const clientHeight = container.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight

      if (pointerScrollInteractionRef.current && distanceFromBottom > CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX) {
        leaveBottomFollow()
      }

      setShowScrollButton(distanceFromBottom > 200)
      setShowScrollTopButton(scrollTop > 200)
      const viewportState = captureCurrentViewportState()

      if (!showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES && scrollTop < 120) {
        const restoreState = viewportState?.kind === 'anchor' ? viewportState : readCurrentViewportState()
        if (restoreState?.kind === 'anchor') {
          pendingViewportRestoreRef.current = {
            state: restoreState,
            interactionVersion: userInteractionVersionRef.current,
          }
          setShowFullTimeline(true)
        }
      }
    }

    const container = messagesContainerRef.current
    if (container) {
      const handleWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) {
          leaveBottomFollow()
        } else {
          markUserViewportInteraction()
        }
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
          touchScrollStartYRef.current = currentY
        }
      }
      const handleTouchEnd = () => {
        touchScrollStartYRef.current = null
      }
      const handlePointerDown = () => {
        markUserViewportInteraction()
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
  }, [captureCurrentViewportState, leaveBottomFollow, markUserViewportInteraction, messages.length, readCurrentViewportState, showFullTimeline])

  const applySessionState = useCallback((session: SessionListRecord | null | undefined) => {
    if (!session || typeof session.id !== 'string') return
    const nextBusy = isSessionRuntimeActive(session)
    const nextQueueLength = typeof session.queueLength === 'number' ? session.queueLength : 0
    const nextMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0
    sessionBusyRef.current = nextBusy
    sessionQueueLengthRef.current = nextQueueLength
    sessionMessageCountRef.current = nextMessageCount
    sessionStateInitializedRef.current = true
    setSessionRecord(session)
    setSessionBusy(nextBusy)
    setSessionQueueLength(nextQueueLength)
  }, [])

  const fetchHistory = useCallback(async () => {
    const activeRequest = historyInFlightRef.current
    if (activeRequest?.sessionId === sessionId) {
      historyTrailingRefreshRef.current = true
      return activeRequest.promise
    }

    const requestSequence = historyRequestGateRef.current.begin()
    const eventVersionAtStart = historyEventVersionRef.current
    const stateEventVersionAtStart = historyStateEventVersionRef.current
    const modelStreamEventVersionAtStart = historyModelStreamEventVersionRef.current
    const controller = new AbortController()
    historyAbortControllerRef.current = controller

    const requestPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history`, {
          signal: controller.signal,
        })
        if (!historyRequestGateRef.current.isCurrent(requestSequence)) return true

        if (res.status === 404) {
          if (historyStateEventVersionRef.current > stateEventVersionAtStart) return true
          setSessionMissing(true)
          setMessages([])
          setQueuedMessages([])
          setSessionQueueLength(0)
          setPersistentMemorySnapshot('')
          lastKnownTimestampRef.current = 0
          setHistoryLoaded(true)
          return false
        }

        if (res.ok) {
          const data = await res.json()
          if (!historyRequestGateRef.current.isCurrent(requestSequence)) return true

          const concurrentMessages = historyEventsRef.current
            .filter(entry => entry.version > eventVersionAtStart)
            .map(entry => entry.message)
          const snapshotMessages = Array.isArray(data.messages) ? data.messages as Message[] : []
          const hasNewerStreamState = historyStateEventVersionRef.current > stateEventVersionAtStart
          const hasNewerModelStream = historyModelStreamEventVersionRef.current > modelStreamEventVersionAtStart
          const historyQueueLength = typeof data.queueLength === 'number' ? data.queueLength : null
          const hasNewerMismatchedQueue = hasNewerStreamState
            && historyQueueLength !== null
            && historyQueueLength !== sessionQueueLengthRef.current

          if (!hasNewerStreamState) {
            setSessionMissing(false)
            applySessionState(data.session)
          }
          setMessages(currentMessages => mergeHistorySnapshot({
            snapshot: snapshotMessages,
            concurrentMessages,
            currentMessages,
            pendingClientMessageIds: pendingSentMessageIdsRef.current,
          }))
          for (const message of snapshotMessages) {
            const clientMessageId = getClientMessageId(message)
            if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
          }
          const nextQueuedMessages = Array.isArray(data.queuedMessages) ? data.queuedMessages : []
          if (hasNewerMismatchedQueue) {
            historyTrailingRefreshRef.current = true
          } else {
            setQueuedMessages(nextQueuedMessages)
          }
          setPersistentMemorySnapshot(typeof data.persistentMemorySnapshot === 'string' ? data.persistentMemorySnapshot : '')
          if (!hasNewerStreamState && typeof data.queueLength === 'number') {
            setSessionQueueLength(data.queueLength)
          }
          if (!hasNewerModelStream) setStreamingAssistantDraft(null)
          const lastMsg = snapshotMessages[snapshotMessages.length - 1]
          if (lastMsg?.__meta?.timestamp) {
            lastKnownTimestampRef.current = Math.max(lastKnownTimestampRef.current, lastMsg.__meta.timestamp)
          }
          historyEventsRef.current = []
          setHistoryLoaded(true)
          return true
        }
        return true
      } catch (e) {
        if (controller.signal.aborted) return true
        console.error('Failed to fetch history:', e)
        return true
      } finally {
        if (historyAbortControllerRef.current === controller) {
          historyAbortControllerRef.current = null
        }
      }
    })()

    historyInFlightRef.current = { sessionId, promise: requestPromise, controller }
    void requestPromise.finally(() => {
      if (historyInFlightRef.current?.controller !== controller) return
      historyInFlightRef.current = null
      if (!historyTrailingRefreshRef.current || !historyRequestGateRef.current.isCurrent(requestSequence)) return
      historyTrailingRefreshRef.current = false
      void fetchHistory()
    })
    return requestPromise
  }, [applySessionState, sessionId])

  const scheduleHistoryRefresh = useCallback((delay = 100) => {
    if (historyRefreshTimeoutRef.current !== null) {
      window.clearTimeout(historyRefreshTimeoutRef.current)
    }
    historyRefreshTimeoutRef.current = window.setTimeout(() => {
      historyRefreshTimeoutRef.current = null
      void fetchHistory()
    }, delay)
  }, [fetchHistory])

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }

    setConnectionState('connecting')
    const es = new EventSource(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/stream`)
    let opened = false

    es.onopen = () => {
      opened = true
      setConnectionState('connected')
      reconnectDelayRef.current = 1000
      void fetchHistory().then((sessionExists) => {
        if (sessionExists || eventSourceRef.current !== es) return
        es.close()
        eventSourceRef.current = null
        setConnectionState('disconnected')
      })
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'session-state') {
          historyStateEventVersionRef.current += 1
          const hadSessionState = sessionStateInitializedRef.current
          const previousQueueLength = sessionQueueLengthRef.current
          const previousMessageCount = sessionMessageCountRef.current
          const nextQueueLength = typeof data.session?.queueLength === 'number' ? data.session.queueLength : 0
          const nextMessageCount = typeof data.session?.messageCount === 'number' ? data.session.messageCount : 0
          setSessionMissing(false)
          applySessionState(data.session)
          if (hadSessionState && (
            nextQueueLength !== previousQueueLength ||
            nextMessageCount !== previousMessageCount ||
            (nextQueueLength === 0 && queuedMessagesRef.current.length > 0)
          )) {
            scheduleHistoryRefresh()
          }
          return
        }

        if (data.type === 'session-deleted') {
          historyRequestGateRef.current.invalidate()
          historyAbortControllerRef.current?.abort()
          historyAbortControllerRef.current = null
          historyInFlightRef.current = null
          historyTrailingRefreshRef.current = false
          historyEventsRef.current = []
          if (historyRefreshTimeoutRef.current !== null) {
            window.clearTimeout(historyRefreshTimeoutRef.current)
            historyRefreshTimeoutRef.current = null
          }
          setSessionMissing(true)
          setSessionBusy(false)
          setSessionQueueLength(0)
          setQueuedMessages([])
          setMessages([])
          setPersistentMemorySnapshot('')
          setStreamingAssistantDraft(null)
          setHistoryLoaded(true)
          lastKnownTimestampRef.current = 0
          sessionBusyRef.current = false
          sessionQueueLengthRef.current = 0
          sessionMessageCountRef.current = 0
          queuedMessagesRef.current = []
          es.close()
          eventSourceRef.current = null
          setConnectionState('disconnected')
          return
        }

        if (data.type === 'session-event') {
          const sessionEvent = data.event as SessionStreamEvent
          if (sessionEvent.type === 'model-stream-reset') {
            historyModelStreamEventVersionRef.current += 1
            setStreamingAssistantDraft({
              streamId: sessionEvent.streamId || `stream-${sessionEvent.iteration ?? 'current'}`,
              iteration: sessionEvent.iteration,
              reasoning: '',
              text: '',
              toolCalls: [],
            })
          } else if (sessionEvent.type === 'model-stream-update') {
            historyModelStreamEventVersionRef.current += 1
            const streamId = sessionEvent.streamId || `stream-${sessionEvent.iteration ?? 'current'}`
            setStreamingAssistantDraft(prev => ({
              streamId,
              iteration: sessionEvent.iteration ?? prev?.iteration,
              reasoning: sessionEvent.reasoning ?? (prev?.streamId === streamId ? prev.reasoning : ''),
              text: sessionEvent.text ?? (prev?.streamId === streamId ? prev.text : ''),
              toolCalls: sessionEvent.toolCalls !== undefined
                ? normalizeStreamingToolCalls(sessionEvent.toolCalls)
                : (prev?.streamId === streamId ? prev.toolCalls : []),
            }))
          } else if (sessionEvent.type === 'toolscript-progress' && sessionEvent.toolUseId) {
            setToolScriptProgress(prev => ({
              ...prev,
              [sessionEvent.toolUseId!]: sessionEvent.subCalls || [],
            }))
          }
          return
        }

        if (data.type === 'message') {
          const msgTimestamp = data.message.__meta?.timestamp
          const isCommandResponse = data.message.__meta?.isCommandResponse
          const isUpdateExisting = data.message.__meta?.updateExisting

          if (data.message.role === 'model') {
            setStreamingAssistantDraft(null)
          }

          if (sessionQueueLengthRef.current > 0 || queuedMessagesRef.current.length > 0) {
            scheduleHistoryRefresh()
          }

          const incomingMessage = data.message as Message
          const hasStableIdentity = hasStableHistoryIdentity(incomingMessage)
          if (!isCommandResponse && !isUpdateExisting && !hasStableIdentity
            && msgTimestamp && msgTimestamp <= lastKnownTimestampRef.current) {
            return
          }

          const clientMessageId = getClientMessageId(incomingMessage)
          if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
          historyEventVersionRef.current += 1
          if (historyAbortControllerRef.current) {
            historyEventsRef.current.push({
              version: historyEventVersionRef.current,
              message: incomingMessage,
            })
          }

          setMessages(prev => reconcileHistoryMessage(prev, incomingMessage))

          if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
            lastKnownTimestampRef.current = Math.max(lastKnownTimestampRef.current, msgTimestamp)
          }

          // Clean up toolscript progress when tool response message arrives
          if (data.message.role === 'tool') {
            const responseIds = (data.message.parts || [])
              .filter((p: MessagePart) => p.functionResponse)
              .map((p: MessagePart) => p.functionResponse!.tool_use_id)
              .filter(Boolean) as string[]
            if (responseIds.length > 0) {
              setToolScriptProgress(prev => {
                const hasMatch = responseIds.some(id => prev[id])
                if (!hasMatch) return prev
                const next = { ...prev }
                for (const id of responseIds) {
                  delete next[id]
                }
                return next
              })
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse SSE message:', e)
      }
    }

    es.onerror = () => {
      es.close()

      if (es.readyState === EventSource.CLOSED) {
        const scheduleReconnect = () => {
          setConnectionState('reconnecting')
          const delay = Math.min(reconnectDelayRef.current, 30000)
          setReconnectCountdown(Math.ceil(delay / 1000))

          countdownIntervalRef.current = setInterval(() => {
            setReconnectCountdown(prev => {
              if (prev <= 1) {
                if (countdownIntervalRef.current) {
                  clearInterval(countdownIntervalRef.current)
                  countdownIntervalRef.current = null
                }
                return 0
              }
              return prev - 1
            })
          }, 1000)

          reconnectTimeoutRef.current = setTimeout(() => {
            connectSSE()
            reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
          }, delay)
        }

        if (opened) {
          scheduleReconnect()
        } else {
          void (async () => {
            try {
              const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/state`)
              if (eventSourceRef.current !== es) return
              if (response.status === 404) {
                historyRequestGateRef.current.invalidate()
                historyAbortControllerRef.current?.abort()
                historyAbortControllerRef.current = null
                historyInFlightRef.current = null
                historyTrailingRefreshRef.current = false
                if (historyRefreshTimeoutRef.current !== null) {
                  window.clearTimeout(historyRefreshTimeoutRef.current)
                  historyRefreshTimeoutRef.current = null
                }
                setSessionMissing(true)
                setSessionBusy(false)
                setMessages([])
                setQueuedMessages([])
                setSessionQueueLength(0)
                setPersistentMemorySnapshot('')
                setStreamingAssistantDraft(null)
                setHistoryLoaded(true)
                lastKnownTimestampRef.current = 0
                sessionBusyRef.current = false
                sessionQueueLengthRef.current = 0
                sessionMessageCountRef.current = 0
                queuedMessagesRef.current = []
                eventSourceRef.current = null
                setConnectionState('disconnected')
                return
              }
              if (response.ok) {
                const data = await response.json()
                if (eventSourceRef.current !== es) return
                historyStateEventVersionRef.current += 1
                setSessionMissing(false)
                applySessionState(data.session)
              }
            } catch (error) {
              console.error('Failed to probe session state after stream connection failure:', error)
            }
            if (eventSourceRef.current === es) scheduleReconnect()
          })()
        }
      } else {
        setConnectionState('disconnected')
      }
    }

    eventSourceRef.current = es
  }, [applySessionState, fetchHistory, scheduleHistoryRefresh, sessionId])

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
      setSessionRecord(previous => ({ ...(previous || { id: sessionId }), ...data }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [sessionId])

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
      setSessionRecord(previous => ({ ...(previous || { id: sessionId }), ...data }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update child default model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [sessionId])

  useEffect(() => {
    connectSSE()

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
      if (historyRefreshTimeoutRef.current !== null) {
        window.clearTimeout(historyRefreshTimeoutRef.current)
        historyRefreshTimeoutRef.current = null
      }
      historyRequestGateRef.current.invalidate()
      historyAbortControllerRef.current?.abort()
      historyAbortControllerRef.current = null
      historyInFlightRef.current = null
      historyTrailingRefreshRef.current = false
    }
  }, [connectSSE, fetchHistory])

  useEffect(() => {
    if (!pendingViewportRestoreRef.current && shouldAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [messages, scrollToBottom, streamingAssistantDraft])

  const snapshotSystemMessage = useMemo<Message | null>(() => {
    const snapshotText = persistentMemorySnapshot.trim()

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
  }, [persistentMemorySnapshot])

  const visibleMessages = useMemo(() => {
    if (showFullTimeline || messages.length <= DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
      return messages
    }
    return messages.slice(-DEFAULT_VISIBLE_TIMELINE_MESSAGES)
  }, [messages, showFullTimeline])

  const hiddenMessageCount = messages.length - visibleMessages.length

  const streamingAssistantMessage = useMemo(() => (
    buildStreamingAssistantMessage(streamingAssistantDraft)
  ), [streamingAssistantDraft])

  const timelineMessages = useMemo(() => {
    const baseMessages = snapshotSystemMessage ? [snapshotSystemMessage, ...visibleMessages] : visibleMessages
    return streamingAssistantMessage ? [...baseMessages, streamingAssistantMessage] : baseMessages
  }, [snapshotSystemMessage, streamingAssistantMessage, visibleMessages])

  useLayoutEffect(() => {
    if (!pendingScrollToTrueTopRef.current) return
    const container = messagesContainerRef.current
    if (!container || !showFullTimeline) return
    container.scrollTop = 0
    pendingScrollToTrueTopRef.current = false
  }, [showFullTimeline, timelineMessages])

  useEffect(() => {
    if (showFullTimeline || !historyLoaded || messages.length <= DEFAULT_VISIBLE_TIMELINE_MESSAGES) return
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
    const pending = pendingViewportRestoreRef.current
    if (!pending) return

    if (pending.interactionVersion !== userInteractionVersionRef.current) {
      pendingViewportRestoreRef.current = null
      return
    }

    if (applyViewportState(pending.state)) {
      pendingViewportRestoreRef.current = null
      return
    }

    if (pending.state.kind === 'anchor' && !showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES) {
      setShowFullTimeline(true)
      return
    }

    if (historyLoaded) {
      const fallbackState: ChatViewportState = { kind: 'bottom' }
      pendingViewportRestoreRef.current = null
      applyViewportState(fallbackState)
    }
  }, [applyViewportState, historyLoaded, messages.length, showFullTimeline, timelineMessages])

  useLayoutEffect(() => {
    const pending = pendingContextScrollbarNavigationRef.current
    if (!pending) return
    if (scrollToContextScrollbarAnchor(pending.anchorKey, pending.fraction)) {
      pendingContextScrollbarNavigationRef.current = null
    }
  }, [scrollToContextScrollbarAnchor, showFullTimeline, timelineMessages])

  useEffect(() => {
    const content = messagesContentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current)
      }
      resizeRestoreFrameRef.current = window.requestAnimationFrame(() => {
        resizeRestoreFrameRef.current = null
        if (capturedInteractionVersionRef.current !== userInteractionVersionRef.current) return

        const pending = pendingViewportRestoreRef.current
        if (pending) {
          if (pending.interactionVersion === userInteractionVersionRef.current) {
            applyViewportState(pending.state)
          }
          return
        }
        applyViewportState(currentViewportStateRef.current)
      })
    })
    observer.observe(content)

    return () => {
      observer.disconnect()
      if (resizeRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeRestoreFrameRef.current)
        resizeRestoreFrameRef.current = null
      }
    }
  }, [applyViewportState])

  useLayoutEffect(() => () => {
    captureCurrentViewportState()
  }, [captureCurrentViewportState])

  const handleOpenDebugInfo = useCallback(() => {
    setShowMenu(false)
    setShowDebugInfo(true)
  }, [])

  const handleCloseDebugInfo = useCallback(() => {
    setShowDebugInfo(false)
  }, [])

  const handleSend = useCallback(async ({ text, attachments }: { text: string; attachments: File[] }) => {
    if (sessionMissing || (!text.trim() && attachments.length === 0) || loading) return false

    setLoading(true)
    setStreamingAssistantDraft(null)

    const userMessage = text.trim()
    const isSlashCommand = /^\/[a-zA-Z_\-.]+(?:\s+.*)?$/s.test(userMessage)
    const files = [...attachments]
    const sendTimestamp = Date.now()
    const clientMessageId = globalThis.crypto?.randomUUID?.()
      || `webui-${sendTimestamp}-${Math.random().toString(36).slice(2)}`

    const parts: any[] = []
    let messageText = userMessage
    let requestText = userMessage
    const uploadedFiles: Array<{ path: string; filename: string; mimeType: string; size?: number }> = []

    for (const file of files) {
      try {
        const formData = new FormData()
        formData.append('file', file)

        const uploadRes = await fetch(`${API_BASE_PATH}/upload`, {
          method: 'POST',
          body: formData,
        })

        if (!uploadRes.ok) {
          throw new Error('Upload failed')
        }

        const uploadData = await uploadRes.json()
        uploadedFiles.push({
          path: uploadData.path,
          filename: uploadData.filename || file.name,
          mimeType: uploadData.mimeType || file.type || 'application/octet-stream',
          size: uploadData.size,
        })

        messageText += file.type.startsWith('image/')
          ? `\n\n[Image: ${file.name}]`
          : `\n\n[File: ${file.name}]`
      } catch (err) {
        console.error('File upload failed:', err)
        messageText += `\n\n[Failed to upload: ${file.name}]`
      }
    }

    if (requestText) {
      parts.push({ text: requestText })
    }

    const previewParts = messageText ? [{ text: messageText }] : parts

    const appendOptimistic = !isSlashCommand
      && shouldAppendOptimisticMessage(sessionBusyRef.current, sessionQueueLengthRef.current)
    if (appendOptimistic) {
      pendingSentMessageIdsRef.current.add(clientMessageId)
      setMessages(prev => [...prev, buildOptimisticUserMessage({
        clientMessageId,
        parts: previewParts,
        timestamp: sendTimestamp,
      })])
    }

    void fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parts,
          uploadedFiles,
          ...(!isSlashCommand ? { clientMessageId } : {}),
        }),
      })
      .then(response => {
        if (!response.ok) throw new Error(`Failed to send message (${response.status})`)
        if (!appendOptimistic) scheduleHistoryRefresh()
      })
      .catch(e => {
        console.error('Failed to send message:', e)
        pendingSentMessageIdsRef.current.delete(clientMessageId)
        setMessages(prev => {
          const hasReconciledRow = prev.some(message => (
            !message.__meta?.optimistic
            && getClientMessageId(message) === clientMessageId
          ))
          const hasPendingOptimisticRow = prev.some(message => (
            message.__meta?.optimistic
            && getClientMessageId(message) === clientMessageId
          ))
          if (appendOptimistic && (hasReconciledRow || !hasPendingOptimisticRow)) return prev
          return [
            ...prev.filter(message => !(
              message.__meta?.optimistic
              && getClientMessageId(message) === clientMessageId
            )),
            { role: 'model', parts: [{ text: 'Error: Failed to send message' }], __meta: { temporary: true, timestamp: Date.now() } },
          ]
        })
      })

    setLoading(false)
    return true
  }, [loading, scheduleHistoryRefresh, sessionId, sessionMissing])

  const sendSessionCommand = useCallback(async (command: string) => {
    if (sessionMissing) return
    try {
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: command }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || `Command failed (${response.status})`)
      }
    } catch (error) {
      console.error(`Failed to send ${command}:`, error)
      setMessages(prev => [...prev, {
        role: 'model',
        parts: [{ text: `Error: ${error instanceof Error ? error.message : `Failed to send ${command}`}` }],
        __meta: { temporary: true, timestamp: Date.now() },
      }])
    }
  }, [sessionId, sessionMissing])

  const handleStop = useCallback(() => {
    void sendSessionCommand('/stop')
  }, [sendSessionCommand])

  const handleRunQueued = useCallback(() => {
    void sendSessionCommand('/dequeue')
  }, [sendSessionCommand])

  const handleRetryLlmNotice = useCallback(() => {
    void sendSessionCommand('/retry')
  }, [sendSessionCommand])

  const handleTranscribeAudio = useCallback(async (file: File, draftText: string): Promise<AsrTranscribeResult> => {
    const formData = new FormData()
    formData.append('audio', file)
    const context = buildAsrContext(messages, draftText)
    if (context.trim()) {
      formData.append('context', context.trim())
    }

    const response = await fetch(`${API_BASE_PATH}/asr/transcribe`, {
      method: 'POST',
      body: formData,
    })

    const responseText = await response.text()
    let data: any = {}
    try {
      data = responseText ? JSON.parse(responseText) : {}
    } catch {
      data = { error: responseText || 'ASR request failed' }
    }

    if (!response.ok) {
      throw new Error(data?.error || `ASR request failed (${response.status})`)
    }

    const text = typeof data?.text === 'string' ? data.text : ''
    return {
      text,
      status: response.status,
      rawLength: responseText.length,
      textLength: text.length,
      responsePreview: responseText.slice(0, 200),
    }
  }, [messages])

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
    const context = buildAsrContext(messages, draftText)

    return await new Promise<StreamingAsrSession>((resolve, reject) => {
      const socket = new WebSocket(getAsrStreamUrl())
      let resolved = false
      let settled = false

      const fail = (message: string) => {
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
        onDebug(`ws open; contextLength=${context.length} language=auto`)
        socket.send(JSON.stringify({
          type: 'start',
          context,
        }))
        onDebug('ws start sent')
      }

      socket.onmessage = (event) => {
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
        onDebug(`ws closed; resolved=${String(resolved)} settled=${String(settled)}`)
        if (!resolved && !settled) {
          reject(new Error('Streaming ASR connection closed before ready'))
        }
      }
    })
  }, [messages])

  const contextLimit = useMemo(() => {
    const currentModelKey = sessionRecord?.modelKey
    return modelOptions.find(option => option.key === currentModelKey)?.contextLimit ?? null
  }, [modelOptions, sessionRecord?.modelKey])

  const retryableLlmRetryNotice = useMemo(
    () => getRetryableLlmRetryNotice(messages, sessionBusy),
    [messages, sessionBusy],
  )

  return (
    <div ref={chatRootRef} className="foxwarm-chat-root relative flex h-full flex-col overflow-hidden">
      <ContentHeader
        icon={<MessageSquareText className="h-5 w-5" />}
        title={sessionDisplayName || sessionRecord?.displayName || sessionId}
        subtitle={(
          <span data-session-header-subtitle className="font-mono text-[12px]" title={sessionRecord?.cwd || undefined}>
            {sessionHeaderSubtitle}
          </span>
        )}
        onBack={isMobile ? onBack : undefined}
        sticky
        actions={(
          <>
            {(onOpenCode || onOpenCodeNewWindow) && (
              <div className="flex items-stretch">
                {onOpenCode && (
                  <button
                    onClick={onOpenCode}
                    className={`inline-flex items-center gap-1 border border-gray-200 px-2 py-2 text-sm text-gray-700 hover:bg-gray-50 sm:px-3 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 ${onOpenCodeNewWindow ? 'rounded-l-lg' : 'rounded-lg'}`}
                    title="Open code"
                  >
                    <Code2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Open code</span>
                  </button>
                )}
                {onOpenCodeNewWindow && (
                  <button
                    onClick={onOpenCodeNewWindow}
                    className={`inline-flex items-center justify-center rounded-r-lg border border-gray-200 px-2 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 ${onOpenCode ? 'border-l-0' : ''}`}
                    title="Open code in a new browser tab"
                    aria-label="Open code in a new browser tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            {onOpenTerminal && (
              <button
                onClick={onOpenTerminal}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                title="Open terminal"
              >
                <SquareTerminal className="h-4 w-4" />
                <span className="hidden md:inline">Open terminal</span>
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
                title="Session options"
              >
                <Menu size={20} />
              </button>
              {showMenu && (
                <div className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-200 bg-white text-gray-900 shadow-lg z-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
                  <button
                    onClick={handleOpenDebugInfo}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    debug info
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      />

      {connectionState !== 'connected' && (
        <div className={`sticky top-0 z-20 px-4 py-2 text-sm ${
          connectionState === 'connecting' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
          connectionState === 'reconnecting' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
          'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
        }`}>
          {connectionState === 'connecting' && 'Connecting...'}
          {connectionState === 'reconnecting' && `Reconnecting in ${reconnectCountdown}s...`}
          {connectionState === 'disconnected' && 'Disconnected'}
        </div>
      )}

      <div className="foxwarm-chat-message-region relative min-h-0 flex-1">
        <div id={chatMessageContainerId} ref={messagesContainerRef} className="foxwarm-chat-messages h-full overflow-x-hidden overflow-y-auto p-4">
          {!isMobile && (
            <div className="foxwarm-context-scrollbar-overlay">
              <ContextScrollbar
                messages={messages}
                persistentMemorySnapshot={snapshotSystemMessage}
                contextLimit={contextLimit}
                containerId={chatMessageContainerId}
                containerRef={messagesContainerRef}
                timelineRef={committedTimelineRef}
                onNavigate={handleContextScrollbarNavigate}
              />
            </div>
          )}
          <div ref={messagesContentRef} className="foxwarm-chat-messages-content min-w-0 max-w-full overflow-x-hidden">
            {hiddenMessageCount > 0 && !showFullTimeline && (
              <div className="mb-3 rounded-lg border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-300">
                Showing the latest {visibleMessages.length} messages. Scroll upward to load {hiddenMessageCount} earlier messages.
              </div>
            )}
            <div ref={committedTimelineRef} data-chat-timeline="committed" className="min-w-0 max-w-full overflow-x-hidden">
              <ToolScriptProgressContext.Provider value={toolScriptProgress}>
                <ChatTimeline sessionId={sessionId} messages={timelineMessages} isMobile={isMobile} groupTools={groupTools} showUsageBadge={showUsageBadge} retryableLlmRetryNotice={retryableLlmRetryNotice} onRetryLlmNotice={handleRetryLlmNotice} onOpenCodeFile={onOpenCodeFile} onOpenCodeCommit={onOpenCodeCommit} />
              </ToolScriptProgressContext.Provider>
            </div>
            <ProcessingStatus
              sessionBusy={sessionBusy}
              sessionQueueLength={sessionQueueLength}
              loading={loading}
              isMobile={isMobile}
              onStop={handleStop}
              onRunQueued={handleRunQueued}
            />
            {queuedMessages.length > 0 && (
              <div className="foxwarm-queued-preview min-w-0 max-w-full overflow-x-hidden" data-queued-preview="true" aria-label="Queued messages">
                <ChatTimeline sessionId={sessionId} messages={queuedMessages} isMobile={isMobile} groupTools={groupTools} showUsageBadge={false} onOpenCodeFile={onOpenCodeFile} onOpenCodeCommit={onOpenCodeCommit} />
              </div>
            )}
            <div aria-hidden="true" style={{ height: 'var(--chat-composer-offset, 224px)' }} />
          </div>
        </div>
        {showScrollTopButton && (
          <button
            onClick={scrollToTop}
            className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg transition-all hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700"
            aria-label="Scroll to top"
          >
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
        )}

        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg transition-all hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700"
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
        sessionId={sessionId}
        sessionMissing={sessionMissing}
        loading={loading}
        asrAvailable={asrAvailable}
        modelOptions={modelOptions}
        currentModelKey={sessionRecord?.modelKey}
        sessionModel={sessionRecord?.model || null}
        defaultModelKey={sessionRecord?.defaultModelKey}
        childModelDefault={sessionRecord?.childModelDefault || null}
        effectiveChildModelKey={sessionRecord?.effectiveChildModelKey}
        modelBusy={modelBusy}
        modelError={modelError}
        onChangeModel={updateSessionModel}
        onChangeChildModel={updateChildModel}
        onRefreshModels={fetchModels}
        modelsRefreshing={modelsRefreshing}
        onOpenModelSettings={onOpenModelSettings || (() => {})}
        sendKeyMode={sendKeyMode}
        onHeightChange={handleComposerHeightChange}
        onSend={handleSend}
        onTranscribeAudio={handleTranscribeAudio}
        onCreateStreamingTranscriber={handleCreateStreamingTranscriber}
        onDraftEdited={onDraftEdited}
      />

      {showDebugInfo && (
        <SessionDebugModal
          source={{
            sessionId,
            sessionDisplayName,
            sessionRecord,
            messages,
            connectionState,
            reconnectCountdown,
            sessionMissing,
            sessionBusy,
            sessionQueueLength,
            queuedPreviewCount: queuedMessages.length,
            groupTools,
            showUsageBadge,
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
  prev.sessionDisplayName === next.sessionDisplayName &&
  Boolean(prev.onBack) === Boolean(next.onBack) &&
  prev.onOpenTerminal === next.onOpenTerminal
  && prev.onOpenCode === next.onOpenCode
  && prev.onOpenCodeNewWindow === next.onOpenCodeNewWindow
  && prev.onOpenCodeFile === next.onOpenCodeFile
  && prev.onOpenCodeCommit === next.onOpenCodeCommit
  && prev.onOpenModelSettings === next.onOpenModelSettings
))

export default Chat
