import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, Menu } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import ChatComposer from './ChatComposer'
import ChatTimeline from './ChatTimeline'
import ProcessingStatus from './ProcessingStatus'
import type { Message, MessagePart, SendKeyMode, SessionStreamEvent } from './chatShared'

function getAsrStreamUrl() {
  const base = `${window.location.origin}${API_BASE_PATH}/asr/stream`
  return base.replace(/^http/i, 'ws')
}

function getAsrLanguageHint(): string {
  const locales = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  for (const locale of locales) {
    const normalized = locale.toLowerCase()
    if (normalized.startsWith('zh')) {
      return 'Chinese'
    }
  }

  return ''
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
  themeMode: 'auto' | 'light' | 'dark'
  onThemeChange: (mode: 'auto' | 'light' | 'dark') => void
}

type StreamingAsrSession = {
  sendAudioChunk: (chunk: ArrayBuffer) => void
  stop: () => void
  cancel: () => void
}

const Chat = memo(function Chat({ sessionId, sessionDisplayName, onBack, themeMode, onThemeChange }: ChatProps) {
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
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(() => {
    const saved = localStorage.getItem('sendKeyMode')
    return saved === 'enter' || saved === 'mod-enter' ? saved : 'mod-enter'
  })
  const [verbose, setVerbose] = useState<boolean>(() => {
    const saved = localStorage.getItem(`verbose_${sessionId}`)
    return saved !== null ? saved === 'true' : true
  })
  const [showMenu, setShowMenu] = useState(false)
  const [processingReasoningSummary, setProcessingReasoningSummary] = useState('')
  const [asrAvailable, setAsrAvailable] = useState(false)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastKnownTimestampRef = useRef<number>(0)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef<number>(1000)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const shouldAutoScrollRef = useRef<boolean>(true)
  const pendingSentMessagesRef = useRef<string[]>([])

  useEffect(() => {
    localStorage.setItem('sendKeyMode', sendKeyMode)
  }, [sendKeyMode])

  useEffect(() => {
    setProcessingReasoningSummary('')
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
    if (!sessionBusy) {
      setProcessingReasoningSummary('')
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
    }

    const container = messagesContainerRef.current
    if (container) {
      container.addEventListener('scroll', handleScroll)
      return () => container.removeEventListener('scroll', handleScroll)
    }
  }, [])

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
        setProcessingReasoningSummary('')
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
          if (sessionEvent.type === 'reasoning-summary') {
            setProcessingReasoningSummary(sessionEvent.text || '')
          } else if (sessionEvent.type === 'reasoning-summary-reset') {
            setProcessingReasoningSummary('')
          }
          return
        }

        if (data.type === 'message') {
          const msgTimestamp = data.message.__meta?.timestamp
          const isCommandResponse = data.message.__meta?.isCommandResponse

          if (data.message.role === 'model') {
            setProcessingReasoningSummary('')
          }

          if (!isCommandResponse) {
            if (msgTimestamp && msgTimestamp <= lastKnownTimestampRef.current) {
              return
            }
          }

          setMessages(prev => {
            if (msgTimestamp && !isCommandResponse) {
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

                if (msgTimestamp && !isCommandResponse) {
                  lastKnownTimestampRef.current = msgTimestamp
                }

                return [...filtered, data.message]
              }
            }

            if (msgTimestamp && !isCommandResponse) {
              lastKnownTimestampRef.current = msgTimestamp
            }
            return [...prev, data.message]
          })
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
  }, [messages, scrollToBottom])

  const handleSend = useCallback(async ({ text, attachments }: { text: string; attachments: File[] }) => {
    if (sessionMissing || (!text.trim() && attachments.length === 0) || loading) return false

    setLoading(true)
    setProcessingReasoningSummary('')

    const userMessage = text.trim()
    const files = [...attachments]
    const sendTimestamp = Date.now()
    lastKnownTimestampRef.current = sendTimestamp

    const parts: any[] = []
    let messageText = userMessage
    const filePaths: string[] = []

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

        const { path: filePath } = await uploadRes.json()
        filePaths.push(filePath)

        if (file.type.startsWith('image/')) {
          messageText += `\n\n[Image: ${file.name}]\nPath: ${filePath}`
        } else {
          messageText += `\n\n[File: ${file.name}]\nPath: ${filePath}`
        }
      } catch (err) {
        console.error('File upload failed:', err)
        messageText += `\n\n[Failed to upload: ${file.name}]`
      }
    }

    if (messageText) {
      parts.push({ text: messageText })
    }

    pendingSentMessagesRef.current.push(userMessage)
    setMessages(prev => [...prev, { role: 'user', parts }])

    try {
      fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parts, filePaths }),
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

  const toggleSendKeyMode = useCallback(() => {
    setSendKeyMode(prev => prev === 'enter' ? 'mod-enter' : 'enter')
  }, [])

  const handleTranscribeAudio = useCallback(async (file: File, draftText: string): Promise<AsrTranscribeResult> => {
    const formData = new FormData()
    formData.append('audio', file)
    const context = buildAsrContext(messages, draftText)
    const language = getAsrLanguageHint()
    if (context.trim()) {
      formData.append('context', context.trim())
    }
    if (language) {
      formData.append('language', language)
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
    const language = getAsrLanguageHint()

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
        onDebug(`ws open; contextLength=${context.length} language=${language || 'auto'}`)
        socket.send(JSON.stringify({
          type: 'start',
          context,
          language,
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
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="sticky top-0 z-30 h-20 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4">
        <div className="flex h-full items-center justify-between">
          <div className="flex items-center space-x-3 min-w-0">
            {isMobile && onBack && (
              <button
                onClick={onBack}
                className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white truncate">{sessionDisplayName || sessionId}</h2>
              {sessionDisplayName && (
                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">{sessionId}</div>
              )}
            </div>
          </div>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Menu"
            >
              <Menu size={20} />
            </button>
            {showMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 text-gray-900 dark:text-gray-100">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Theme</div>
                  <div className="flex gap-1">
                    {(['auto', 'light', 'dark'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => {
                          onThemeChange(mode)
                          setShowMenu(false)
                        }}
                        className={`flex-1 px-2 py-1 text-xs rounded capitalize ${themeMode === mode ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Send key</div>
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      onClick={() => {
                        setSendKeyMode('mod-enter')
                        setShowMenu(false)
                      }}
                      className={`px-2 py-1 text-xs rounded ${sendKeyMode === 'mod-enter' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                    >
                      Ctrl/Cmd+Enter
                    </button>
                    <button
                      onClick={() => {
                        setSendKeyMode('enter')
                        setShowMenu(false)
                      }}
                      className={`px-2 py-1 text-xs rounded ${sendKeyMode === 'enter' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                    >
                      Enter
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {sendKeyMode === 'mod-enter'
                      ? 'Default: Ctrl/Cmd+Enter sends, Enter inserts a new line.'
                      : 'Enter sends, Shift/Ctrl/Cmd+Enter inserts a new line.'}
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newVerbose = !verbose
                    setVerbose(newVerbose)
                    localStorage.setItem(`verbose_${sessionId}`, String(newVerbose))
                    setShowMenu(false)
                  }}
                  className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span>Verbose Mode</span>
                    <span className="inline-flex items-center justify-center min-w-4">
                      {verbose ? <Check size={14} /> : null}
                    </span>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

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

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 pb-56 md:pb-52">
        <ChatTimeline messages={messages} isMobile={isMobile} verbose={verbose} />
        <ProcessingStatus
          sessionBusy={sessionBusy}
          sessionQueueLength={sessionQueueLength}
          loading={loading}
          processingReasoningSummary={processingReasoningSummary}
          isMobile={isMobile}
        />
        <div className="h-56 md:h-52" />
      </div>

      {showScrollTopButton && (
        <button
          onClick={scrollToTop}
          className="fixed right-6 top-24 z-30 w-12 h-12 bg-blue-500 dark:bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-600 dark:hover:bg-blue-700 transition-all flex items-center justify-center"
          aria-label="Scroll to top"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        </button>
      )}

      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed right-6 bottom-32 z-30 w-12 h-12 bg-blue-500 dark:bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-600 dark:hover:bg-blue-700 transition-all flex items-center justify-center md:bottom-28"
          aria-label="Scroll to bottom"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}

      <ChatComposer
        sessionId={sessionId}
        sessionMissing={sessionMissing}
        loading={loading}
        asrAvailable={asrAvailable}
        sendKeyMode={sendKeyMode}
        onToggleSendKeyMode={toggleSendKeyMode}
        onSend={handleSend}
        onTranscribeAudio={handleTranscribeAudio}
        onCreateStreamingTranscriber={handleCreateStreamingTranscriber}
      />
    </div>
  )
}, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.sessionDisplayName === next.sessionDisplayName &&
  prev.themeMode === next.themeMode &&
  Boolean(prev.onBack) === Boolean(next.onBack)
))

export default Chat
