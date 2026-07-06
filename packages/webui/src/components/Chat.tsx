import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Menu, MessageSquareText, SquareTerminal, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import ChatComposer from './ChatComposer'
import type { ModelOption } from './ChatComposer'
import ChatTimeline from './ChatTimeline'
import ContentHeader from './ContentHeader'
import ProcessingStatus from './ProcessingStatus'
import { copyTextToClipboard } from './chatShared'
import type { Message, MessagePart, ModelStreamToolCall, SessionStreamEvent, ToolScriptSubCall } from './chatShared'
import { ToolScriptProgressContext } from './ToolScriptProgressContext'

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
  sessionDisplayName?: string
  onBack?: () => void
  onOpenTerminal?: () => void
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
  queueLength?: number
  displayName?: string | null
  archived?: boolean
  currentNode?: string
  model?: string | null
  modelKey?: string
  defaultModelKey?: string
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  isolated?: boolean
}

type SessionFilePayload = {
  history?: Message[]
  persistentMemorySnapshot?: string
  [key: string]: any
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

async function fetchSessionFilePayload(sessionId: string): Promise<{ resolvedPath: string | null; payload: SessionFilePayload | null }> {
  try {
    const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/debug-file`)
    if (!res.ok) {
      return { resolvedPath: null, payload: null }
    }

    const data = await res.json()
    return {
      resolvedPath: typeof data?.resolvedPath === 'string' ? data.resolvedPath : null,
      payload: data?.payload && typeof data.payload === 'object' ? data.payload as SessionFilePayload : null,
    }
  } catch {
    return { resolvedPath: null, payload: null }
  }
}

const Chat = memo(function Chat({ sessionId, sessionDisplayName, onBack, onOpenTerminal, sendKeyMode = 'modEnter', groupTools = false, showUsageBadge = true, onDraftEdited }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionMissing, setSessionMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionQueueLength, setSessionQueueLength] = useState(0)
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [connectionState, setConnectionState] = useState<'connected' | 'connecting' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [showScrollTopButton, setShowScrollTopButton] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showDebugInfo, setShowDebugInfo] = useState(false)
  const [debugInfoLoading, setDebugInfoLoading] = useState(false)
  const [debugInfoError, setDebugInfoError] = useState<string | null>(null)
  const [debugInfoCopied, setDebugInfoCopied] = useState(false)
  const [streamingAssistantDraft, setStreamingAssistantDraft] = useState<StreamingAssistantDraft | null>(null)
  const [toolScriptProgress, setToolScriptProgress] = useState<Record<string, ToolScriptSubCall[]>>({})
  const [asrAvailable, setAsrAvailable] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sessionRecord, setSessionRecord] = useState<SessionListRecord | null>(null)
  const [resolvedSessionFilePath, setResolvedSessionFilePath] = useState<string | null>(null)
  const [sessionFilePayload, setSessionFilePayload] = useState<SessionFilePayload | null>(null)
  const [showFullTimeline, setShowFullTimeline] = useState(false)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatRootRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastKnownTimestampRef = useRef<number>(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef<number>(1000)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const shouldAutoScrollRef = useRef<boolean>(true)
  const pendingSentMessagesRef = useRef<string[]>([])
  const debugInfoCopyResetTimeoutRef = useRef<number | null>(null)
  const composerHeightRef = useRef<number | null>(null)
  const expandHistoryScrollRestoreRef = useRef<{ top: number; height: number } | null>(null)

  useEffect(() => {
    setStreamingAssistantDraft(null)
    setToolScriptProgress({})
  }, [sessionId])

  useEffect(() => {
    setShowDebugInfo(false)
    setDebugInfoError(null)
    setDebugInfoCopied(false)
  }, [sessionId])

  useEffect(() => {
    setShowFullTimeline(false)
    expandHistoryScrollRestoreRef.current = null
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

  useEffect(() => {
    let cancelled = false

    const fetchModels = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/models`)
        if (!res.ok) throw new Error(`Failed to load models (${res.status})`)
        const data = await res.json()
        if (!cancelled) {
          setModelOptions(Array.isArray(data.models) ? data.models : [])
        }
      } catch (error) {
        console.error('Failed to fetch models:', error)
        if (!cancelled) {
          setModelError(error instanceof Error ? error.message : 'Failed to load models')
          setModelOptions([])
        }
      }
    }

    fetchModels()
    return () => {
      cancelled = true
    }
  }, [])

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
    }
  }, [])

  const handleComposerHeightChange = useCallback((height: number) => {
    const nextHeight = Math.max(0, Math.round(height))
    if (composerHeightRef.current === nextHeight) {
      return
    }
    composerHeightRef.current = nextHeight
    chatRootRef.current?.style.setProperty('--chat-composer-offset', `${nextHeight}px`)
  }, [])

  useEffect(() => {
    return () => {
      if (debugInfoCopyResetTimeoutRef.current !== null) {
        window.clearTimeout(debugInfoCopyResetTimeoutRef.current)
      }
    }
  }, [])

  const scrollToTop = useCallback(() => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = 0
    }
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      const container = messagesContainerRef.current
      if (!container) return

      const scrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const clientHeight = container.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight

      setShowScrollButton(distanceFromBottom > 200)
      setShowScrollTopButton(scrollTop > 200)
      shouldAutoScrollRef.current = distanceFromBottom < 200

      if (!showFullTimeline && messages.length > DEFAULT_VISIBLE_TIMELINE_MESSAGES && scrollTop < 120) {
        expandHistoryScrollRestoreRef.current = {
          top: scrollTop,
          height: container.scrollHeight,
        }
        setShowFullTimeline(true)
      }
    }

    const container = messagesContainerRef.current
    if (container) {
      container.addEventListener('scroll', handleScroll)
      return () => container.removeEventListener('scroll', handleScroll)
    }
  }, [messages.length, showFullTimeline])

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history`)
      if (res.status === 404) {
        setSessionMissing(true)
        setMessages([])
        lastKnownTimestampRef.current = 0
        return
      }

      if (res.ok) {
        const data = await res.json()
        setSessionMissing(false)
        setMessages(data.messages || [])
        setStreamingAssistantDraft(null)
        const lastMsg = data.messages?.[data.messages.length - 1]
        if (lastMsg?.__meta?.timestamp) {
          lastKnownTimestampRef.current = lastMsg.__meta.timestamp
        }
      }
    } catch (e) {
      console.error('Failed to fetch history:', e)
    }
  }, [sessionId])

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

    es.onopen = () => {
      setConnectionState('connected')
      reconnectDelayRef.current = 1000
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'session-event') {
          const sessionEvent = data.event as SessionStreamEvent
          if (sessionEvent.type === 'model-stream-reset') {
            setStreamingAssistantDraft({
              streamId: sessionEvent.streamId || `stream-${sessionEvent.iteration ?? 'current'}`,
              iteration: sessionEvent.iteration,
              reasoning: '',
              text: '',
              toolCalls: [],
            })
          } else if (sessionEvent.type === 'model-stream-update') {
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

          if (!isCommandResponse && !isUpdateExisting) {
            if (msgTimestamp && msgTimestamp <= lastKnownTimestampRef.current) {
              return
            }
          }

          setMessages(prev => {
            const msgSeq = data.message.__meta?.seq
            const msgId = data.message.__meta?.id
            if (!isCommandResponse && (msgSeq || msgId)) {
              const existingIndex = prev.findIndex(m => (
                (msgSeq && m.__meta?.seq === msgSeq) ||
                (msgId && m.__meta?.id === msgId)
              ))
              if (existingIndex !== -1) {
                if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
                  lastKnownTimestampRef.current = msgTimestamp
                }
                const next = [...prev]
                next[existingIndex] = data.message
                return next
              }
            }

            if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
              const exists = prev.some(m => m.__meta?.timestamp === msgTimestamp)
              if (exists) {
                return prev
              }
            }

            if (data.message.role === 'user') {
              const newMessageText = data.message.parts
                .map((p: MessagePart) => p.text || '')
                .join('')
                .trim()

              const pendingIndex = pendingSentMessagesRef.current.findIndex(pending =>
                newMessageText.includes(pending) || pending.includes(newMessageText)
              )

              if (pendingIndex !== -1) {
                pendingSentMessagesRef.current.splice(pendingIndex, 1)

                const filtered = prev.filter((m) => {
                  if (m.role !== 'user') return true
                  const userMessages = prev.filter(msg => msg.role === 'user')
                  const isLastUser = m === userMessages[userMessages.length - 1]
                  return !isLastUser
                })

                if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
                  lastKnownTimestampRef.current = msgTimestamp
                }

                return [...filtered, data.message]
              }
            }

            if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
              lastKnownTimestampRef.current = msgTimestamp
            }
            return [...prev, data.message]
          })

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
          fetchHistory().then(() => {
            connectSSE()
          })
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
        }, delay)
      } else {
        setConnectionState('disconnected')
      }
    }

    eventSourceRef.current = es
  }, [fetchHistory, sessionId])

  const refreshSessionDebugData = useCallback(async () => {
    setDebugInfoLoading(true)
    setDebugInfoError(null)

    try {
      const [sessionsRes, fileData] = await Promise.all([
        fetch(`${API_BASE_PATH}/sessions`),
        fetchSessionFilePayload(sessionId),
      ])

      if (sessionsRes.ok) {
        const data = await sessionsRes.json()
        const currentSession = (data.sessions || []).find((session: SessionListRecord) => session.id === sessionId) || null
        setSessionRecord(currentSession)
      } else {
        setSessionRecord(null)
      }

      setResolvedSessionFilePath(fileData.resolvedPath)
      setSessionFilePayload(fileData.payload)

      if (!fileData.payload) {
        setDebugInfoError('Session file JSON is not available from the current WebUI runtime paths.')
      }
    } catch (error) {
      console.error('Failed to refresh session debug data:', error)
      setDebugInfoError(error instanceof Error ? error.message : 'Failed to refresh debug info')
    } finally {
      setDebugInfoLoading(false)
    }
  }, [sessionId])

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
      await refreshSessionDebugData()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [refreshSessionDebugData, sessionId])

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
      await refreshSessionDebugData()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update child default model'
      setModelError(message)
      throw error
    } finally {
      setModelBusy(false)
    }
  }, [refreshSessionDebugData, sessionId])

  useEffect(() => {
    fetchHistory()
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
    }
  }, [connectSSE, fetchHistory])

  useEffect(() => {
    refreshSessionDebugData()
  }, [refreshSessionDebugData])

  useEffect(() => {
    setSessionMissing(false)

    const fetchBusyStatus = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/sessions`)
        if (res.ok) {
          const data = await res.json()
          const currentSession = data.sessions.find((s: any) => s.id === sessionId)
          if (currentSession) {
            setSessionBusy(currentSession.busy || false)
            setSessionQueueLength(currentSession.queueLength || 0)
          } else {
            setSessionBusy(false)
            setSessionQueueLength(0)
          }
        }
      } catch (e) {
        console.error('Failed to fetch busy status:', e)
      }
    }

    fetchBusyStatus()
    const interval = setInterval(fetchBusyStatus, 2000)

    return () => clearInterval(interval)
  }, [sessionId])

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom()
      setTimeout(() => {
        scrollToBottom()
      }, 100)
    }
  }, [messages.length > 0, scrollToBottom, sessionId])

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [messages, scrollToBottom, streamingAssistantDraft])

  useEffect(() => {
    const restore = expandHistoryScrollRestoreRef.current
    if (!restore || !showFullTimeline) {
      return
    }

    const container = messagesContainerRef.current
    if (!container) {
      return
    }

    const nextScrollHeight = container.scrollHeight
    container.scrollTop = Math.max(0, nextScrollHeight - restore.height + restore.top)
    expandHistoryScrollRestoreRef.current = null
  }, [showFullTimeline, messages.length])

  const snapshotSystemMessage = useMemo<Message | null>(() => {
    const snapshotText = typeof sessionFilePayload?.persistentMemorySnapshot === 'string'
      ? sessionFilePayload.persistentMemorySnapshot.trim()
      : ''

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
  }, [sessionFilePayload])

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

  const debugInfoObject = useMemo(() => ({
    sessionId,
    sessionDisplayName: sessionDisplayName || null,
    sessionRecord,
    resolvedSessionFilePath,
    sessionPayload: sessionFilePayload
      ? {
          ...sessionFilePayload,
          history: messages,
        }
      : {
          history: messages,
        },
    clientState: {
      connectionState,
      reconnectCountdown,
      sessionMissing,
      sessionBusy,
      sessionQueueLength,
      groupTools,
      showUsageBadge,
      sendKeyBehavior: sendKeyMode === 'enter' ? 'Enter sends; Shift+Enter inserts a new line.' : 'Ctrl/Cmd+Enter sends; Enter inserts a new line.',
      loading,
      asrAvailable,
      modelBusy,
      streamingAssistantDraft,
    },
  }), [
    asrAvailable,
    connectionState,
    loading,
    messages,
    modelBusy,
    reconnectCountdown,
    resolvedSessionFilePath,
    sessionBusy,
    sessionDisplayName,
    sessionFilePayload,
    sessionId,
    sessionMissing,
    sessionQueueLength,
    sessionRecord,
    streamingAssistantDraft,
    groupTools,
    showUsageBadge,
  ])

  const debugInfoText = useMemo(() => JSON.stringify(debugInfoObject, null, 2), [debugInfoObject])

  const handleOpenDebugInfo = useCallback(async () => {
    setShowMenu(false)
    setShowDebugInfo(true)
    await refreshSessionDebugData()
  }, [refreshSessionDebugData])

  const handleCopyDebugInfo = useCallback(async () => {
    try {
      await copyTextToClipboard(debugInfoText)
      setDebugInfoCopied(true)
      if (debugInfoCopyResetTimeoutRef.current !== null) {
        window.clearTimeout(debugInfoCopyResetTimeoutRef.current)
      }
      debugInfoCopyResetTimeoutRef.current = window.setTimeout(() => {
        setDebugInfoCopied(false)
        debugInfoCopyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy debug info:', error)
    }
  }, [debugInfoText])

  const handleSend = useCallback(async ({ text, attachments }: { text: string; attachments: File[] }) => {
    if (sessionMissing || (!text.trim() && attachments.length === 0) || loading) return false

    setLoading(true)
    setStreamingAssistantDraft(null)

    const userMessage = text.trim()
    const files = [...attachments]
    const sendTimestamp = Date.now()
    lastKnownTimestampRef.current = sendTimestamp

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

    pendingSentMessagesRef.current.push(userMessage)
    setMessages(prev => [...prev, { role: 'user', parts: previewParts }])

    try {
      fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parts, uploadedFiles }),
      }).catch(e => {
        console.error('Failed to send message:', e)
        setMessages(prev => [...prev, { role: 'model', parts: [{ text: 'Error: Failed to send message' }] }])
      })

      setLoading(false)
      return true
    } catch (e) {
      console.error('Failed to send message:', e)
      setLoading(false)
      return false
    }
  }, [loading, sessionId, sessionMissing])

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

  return (
    <div ref={chatRootRef} className="foxwarm-chat-root relative flex h-full flex-col overflow-hidden">
      <ContentHeader
        icon={<MessageSquareText className="h-5 w-5" />}
        title={sessionDisplayName || sessionId}
        subtitle={<span className="font-mono text-[12px]">session {sessionId}</span>}
        onBack={isMobile ? onBack : undefined}
        sticky
        actions={(
          <>
            <button
              onClick={onOpenTerminal}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Open terminal"
            >
              <SquareTerminal className="h-4 w-4" />
              <span className="hidden md:inline">Open terminal</span>
            </button>
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
        <div ref={messagesContainerRef} className="foxwarm-chat-messages h-full overflow-y-auto p-4">
          {hiddenMessageCount > 0 && !showFullTimeline && (
            <div className="mb-3 rounded-lg border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-300">
              Showing the latest {visibleMessages.length} messages. Scroll upward to load {hiddenMessageCount} earlier messages.
            </div>
          )}
          <ToolScriptProgressContext.Provider value={toolScriptProgress}>
            <ChatTimeline sessionId={sessionId} messages={timelineMessages} isMobile={isMobile} groupTools={groupTools} showUsageBadge={showUsageBadge} />
          </ToolScriptProgressContext.Provider>
          <ProcessingStatus
            sessionBusy={sessionBusy}
            sessionQueueLength={sessionQueueLength}
            loading={loading}
            isMobile={isMobile}
          />
          <div aria-hidden="true" style={{ height: 'var(--chat-composer-offset, 224px)' }} />
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
        sendKeyMode={sendKeyMode}
        onHeightChange={handleComposerHeightChange}
        onSend={handleSend}
        onTranscribeAudio={handleTranscribeAudio}
        onCreateStreamingTranscriber={handleCreateStreamingTranscriber}
        onDraftEdited={onDraftEdited}
      />

      {showDebugInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowDebugInfo(false)}>
          <div
            className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">debug info</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Current session internal/debug JSON</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void refreshSessionDebugData()}
                  className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  refresh
                </button>
                <button
                  onClick={() => void handleCopyDebugInfo()}
                  className="inline-flex items-center gap-1 rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {debugInfoCopied ? <Check size={13} /> : <Copy size={13} />}
                  {debugInfoCopied ? 'copied' : 'copy'}
                </button>
                <button
                  onClick={() => setShowDebugInfo(false)}
                  className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  title="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950">
              <div className="border-b border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                {resolvedSessionFilePath
                  ? `session file: ${resolvedSessionFilePath}`
                  : 'session file: unavailable from current WebUI runtime paths'}
              </div>
              {debugInfoError && (
                <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                  {debugInfoError}
                </div>
              )}
              {debugInfoLoading && (
                <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300">
                  Refreshing debug info...
                </div>
              )}
              <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-gray-900 dark:text-gray-100">{debugInfoText}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.sessionDisplayName === next.sessionDisplayName &&
  Boolean(prev.onBack) === Boolean(next.onBack) &&
  prev.onOpenTerminal === next.onOpenTerminal
))

export default Chat
