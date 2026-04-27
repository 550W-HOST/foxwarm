import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Mic, Paperclip, Plus, Square } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import {
  applySlashCommandSuggestion,
  getSlashCommandCompletion,
  resizeTextarea,
  type SlashCommandOption,
  type SlashCommandSuggestion,
} from './chatShared'

export type ModelOption = {
  key: string
  label: string
  isDefault?: boolean
  contextLimit?: number | null
}

interface ChatComposerProps {
  sessionId: string
  sessionMissing: boolean
  loading: boolean
  asrAvailable: boolean
  modelOptions: ModelOption[]
  currentModelKey?: string
  sessionModel?: string | null
  defaultModelKey?: string
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  modelBusy?: boolean
  modelError?: string | null
  onChangeModel: (model: string | null) => Promise<void>
  onChangeChildModel: (model: string | null) => Promise<void>
  onHeightChange?: (height: number) => void
  onSend: (payload: { text: string; attachments: File[] }) => Promise<boolean>
  onTranscribeAudio: (file: File, context: string) => Promise<{
    text: string
    status: number
    rawLength: number
    textLength: number
    responsePreview: string
  }>
  onCreateStreamingTranscriber: (options: {
    draftText: string
    onPartial: (text: string) => void
    onFinal: (text: string) => void
    onError: (message: string) => void
    onDebug: (message: string) => void
  }) => Promise<{
    sendAudioChunk: (chunk: ArrayBuffer) => void
    stop: () => void
    cancel: () => void
  }>
  onDraftEdited?: (draftText: string) => void
}

function persistDraft(sessionId: string, value: string) {
  const draftKey = `draft_${sessionId}`
  if (value.length > 0) {
    localStorage.setItem(draftKey, value)
  } else {
    localStorage.removeItem(draftKey)
  }
}

function formatModelLabel(option: ModelOption, defaultModelKey?: string) {
  return `${option.label}${option.key === defaultModelKey || option.isDefault ? ' · default' : ''}`
}

function ModelSelector({
  options,
  currentModelKey,
  sessionModel,
  defaultModelKey,
  childModelDefault,
  effectiveChildModelKey,
  busy,
  error,
  onChangeModel,
  onChangeChildModel,
}: {
  options: ModelOption[]
  currentModelKey?: string
  sessionModel?: string | null
  defaultModelKey?: string
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  busy: boolean
  error?: string | null
  onChangeModel: (model: string | null) => Promise<void>
  onChangeChildModel: (model: string | null) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const currentIsDefault = !sessionModel
  const childFollows = !childModelDefault

  const updatePopupPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(420, Math.max(320, Math.min(window.innerWidth - 16, rect.width + 150)))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const preferredMaxHeight = Math.min(360, Math.max(220, window.innerHeight - 24))
    const spaceAbove = Math.max(0, rect.top - 12)
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 12)
    const openAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow
    const maxHeight = Math.max(180, Math.min(preferredMaxHeight, openAbove ? spaceAbove : spaceBelow || preferredMaxHeight))
    if (openAbove) {
      setPopupStyle({
        position: 'fixed',
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
        maxHeight,
      })
    } else {
      setPopupStyle({
        position: 'fixed',
        left,
        top: Math.min(window.innerHeight - maxHeight - 8, rect.bottom + 8),
        width,
        maxHeight,
      })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    updatePopupPosition()

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        rootRef.current?.contains(target)
        || buttonRef.current?.contains(target)
        || (target instanceof Element && target.closest('[data-model-selector-popup="true"]'))
      ) {
        return
      }
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const handleReposition = () => updatePopupPosition()

    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [open, updatePopupPosition])

  const applyCurrentModel = useCallback((model: string | null) => {
    if (busy) return
    void onChangeModel(model).catch(() => {})
  }, [busy, onChangeModel])

  const applyChildModel = useCallback((model: string | null) => {
    if (busy) return
    void onChangeChildModel(model).catch(() => {})
  }, [busy, onChangeChildModel])

  const renderCheckbox = (checked: boolean, label: string) => (
    <span
      aria-label={label}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[12px] font-semibold ${checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-300 bg-white text-transparent dark:border-gray-600 dark:bg-gray-900'}`}
    >
      ✓
    </span>
  )

  const renderRow = (row: { key: string | null; label: string; title: string; currentChecked: boolean; childChecked: boolean; defaultRow?: boolean }) => (
    <div
      key={row.key || '__default__'}
      className="grid grid-cols-[minmax(0,1fr)_4.5rem_4rem] items-stretch border-t border-gray-100 text-xs first:border-t-0 dark:border-gray-800"
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => applyCurrentModel(row.key)}
        className={`min-w-0 px-3 py-2 text-left transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-blue-950/30 ${row.currentChecked ? 'text-blue-700 dark:text-blue-200' : 'text-gray-700 dark:text-gray-200'}`}
        title={row.title}
      >
        <div className="truncate font-medium">{row.label}</div>
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => applyCurrentModel(row.key)}
        className="flex items-center justify-center transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-blue-950/30"
        title={`Use ${row.label} as current session model`}
      >
        {renderCheckbox(row.currentChecked, 'current model selected')}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => applyChildModel(row.key)}
        className="flex items-center justify-center transition hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-purple-950/30"
        title={`Use ${row.label} as child default model`}
      >
        {renderCheckbox(row.childChecked, 'child default selected')}
      </button>
    </div>
  )

  return (
    <div ref={rootRef} className="relative inline-flex min-w-0 shrink-0" title={error || undefined}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 max-w-[19rem] shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="shrink-0 text-gray-500 dark:text-gray-400">Model</span>
        <span className="min-w-0 truncate" title={currentModelKey || defaultModelKey || 'model'}>{currentModelKey || defaultModelKey || 'model'}</span>
        {childModelDefault && (
          <>
            <span className="hidden shrink-0 text-gray-400 dark:text-gray-500 sm:inline">/</span>
            <span className="hidden min-w-0 truncate text-gray-500 dark:text-gray-400 sm:inline" title={childModelDefault}>child {childModelDefault}</span>
          </>
        )}
        {busy && <span className="shrink-0 text-gray-400 dark:text-gray-500">…</span>}
        {error && <span className="shrink-0 text-red-500 dark:text-red-300">!</span>}
      </button>

      {open && createPortal(
        <div
          className="z-[1000] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
          style={popupStyle}
          role="dialog"
          aria-label="Model selection"
          data-model-selector-popup="true"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4rem] border-b border-gray-200 bg-gray-50 px-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            <div className="px-3 py-2">Model id</div>
            <div className="px-2 py-2 text-center">Current</div>
            <div className="px-2 py-2 text-center">Child</div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: typeof popupStyle.maxHeight === 'number' ? popupStyle.maxHeight - (error ? 78 : 42) : undefined }}>
            {renderRow({
              key: null,
              label: 'default / follow',
              title: `Current default: ${defaultModelKey || currentModelKey || 'model'}; child follows: ${effectiveChildModelKey || currentModelKey || 'model'}`,
              currentChecked: currentIsDefault,
              childChecked: childFollows,
              defaultRow: true,
            })}
            {options.map((option) => renderRow({
              key: option.key,
              label: formatModelLabel(option, defaultModelKey),
              title: option.key,
              currentChecked: sessionModel === option.key,
              childChecked: childModelDefault === option.key,
            }))}
          </div>
          {error && <div className="border-t border-red-100 px-3 py-2 text-xs text-red-600 dark:border-red-900/50 dark:text-red-300">{error}</div>}
        </div>,
        document.body,
      )}
    </div>
  )
}

const ChatComposer = memo(function ChatComposer({
  sessionId,
  sessionMissing,
  loading,
  asrAvailable,
  modelOptions,
  currentModelKey,
  sessionModel,
  defaultModelKey,
  childModelDefault,
  effectiveChildModelKey,
  modelBusy = false,
  modelError,
  onChangeModel,
  onChangeChildModel,
  onHeightChange,
  onSend,
  onTranscribeAudio,
  onCreateStreamingTranscriber,
  onDraftEdited,
}: ChatComposerProps) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isRecordingAudio, setIsRecordingAudio] = useState(false)
  const [transcribingAudio, setTranscribingAudio] = useState(false)
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const [liveTranscriptionPreview, setLiveTranscriptionPreview] = useState('')
  const [waveformBars, setWaveformBars] = useState<number[]>(() => Array.from({ length: 5 }, () => 0.22))
  const [availableCommands, setAvailableCommands] = useState<SlashCommandOption[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsError, setCommandsError] = useState<string | null>(null)
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioGainRef = useRef<GainNode | null>(null)
  const audioAnalyserRef = useRef<AnalyserNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioSampleRateRef = useRef<number>(16000)
  const recordingActiveRef = useRef(false)
  const waveformFrameRef = useRef<number | null>(null)
  const waveformPeakRef = useRef<number>(0.12)
  const audioChunkCountRef = useRef(0)
  const audioMaxPeakRef = useRef(0)
  const audioMaxRmsRef = useRef(0)
  const audioRmsSumRef = useRef(0)
  const pendingStreamingChunksRef = useRef<Int16Array[]>([])
  const streamingFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamingSessionRef = useRef<{
    sendAudioChunk: (chunk: ArrayBuffer) => void
    stop: () => void
    cancel: () => void
  } | null>(null)
  const lastReportedHeightRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchCommands = async () => {
      setCommandsLoading(true)
      setCommandsError(null)

      try {
        const res = await fetch(`${API_BASE_PATH}/commands`)
        if (!res.ok) {
          throw new Error(`Failed to load commands (${res.status})`)
        }

        const data = await res.json()
        if (!cancelled) {
          setAvailableCommands(Array.isArray(data.commands) ? data.commands : [])
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to fetch commands:', e)
          setCommandsError(e instanceof Error ? e.message : 'Failed to load commands')
          setAvailableCommands([])
        }
      } finally {
        if (!cancelled) {
          setCommandsLoading(false)
        }
      }
    }

    fetchCommands()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const draftKey = `draft_${sessionId}`
    const savedDraft = localStorage.getItem(draftKey)
    setInput(savedDraft || '')
    setAttachments([])
    setIsRecordingAudio(false)
    setTranscribeError(null)
    setLiveTranscriptionPreview('')
    setWaveformBars(Array.from({ length: 5 }, () => 0.22))
    setDismissedSlashQuery(null)

    setTimeout(() => {
      resizeTextarea(textareaRef.current)
    }, 0)
  }, [sessionId])

  useEffect(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current)
    }

    draftSaveTimerRef.current = setTimeout(() => {
      persistDraft(sessionId, input)
    }, 2000)

    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current)
      }
    }
  }, [input, sessionId])

  const cleanupRecording = useCallback(async () => {
    recordingActiveRef.current = false
    if (waveformFrameRef.current !== null) {
      cancelAnimationFrame(waveformFrameRef.current)
      waveformFrameRef.current = null
    }
    if (streamingFlushTimerRef.current) {
      clearInterval(streamingFlushTimerRef.current)
      streamingFlushTimerRef.current = null
    }
    audioProcessorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    audioGainRef.current?.disconnect()
    audioAnalyserRef.current?.disconnect()
    audioStreamRef.current?.getTracks().forEach(track => track.stop())

    audioProcessorRef.current = null
    audioSourceRef.current = null
    audioGainRef.current = null
    audioAnalyserRef.current = null
    audioStreamRef.current = null
    waveformPeakRef.current = 0.12
    audioChunkCountRef.current = 0
    audioMaxPeakRef.current = 0
    audioMaxRmsRef.current = 0
    audioRmsSumRef.current = 0
    pendingStreamingChunksRef.current = []
    setWaveformBars(Array.from({ length: 5 }, () => 0.22))

    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      streamingSessionRef.current?.cancel()
      streamingSessionRef.current = null
      void cleanupRecording()
    }
  }, [cleanupRecording])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !onHeightChange) return

    const reportHeight = () => {
      const nextHeight = Math.max(0, Math.round(root.getBoundingClientRect().height))
      if (lastReportedHeightRef.current === nextHeight) {
        return
      }
      lastReportedHeightRef.current = nextHeight
      onHeightChange(nextHeight)
    }

    reportHeight()

    const observer = new ResizeObserver(() => {
      reportHeight()
    })
    observer.observe(root)

    return () => {
      observer.disconnect()
    }
  }, [onHeightChange])

  const slashCompletion = useMemo(() => getSlashCommandCompletion(input, availableCommands), [availableCommands, input])
  const slashCommandSuggestions = slashCompletion?.suggestions || []
  const slashCommandHints = slashCompletion?.hints || []

  const showSlashCommandMenu = slashCompletion !== null && dismissedSlashQuery !== input && (
    commandsLoading ||
    slashCommandSuggestions.length > 0 ||
    slashCommandHints.length > 0 ||
    !!commandsError
  )

  useEffect(() => {
    if (!showSlashCommandMenu) {
      setHighlightedCommandIndex(0)
      return
    }

    setHighlightedCommandIndex((current) => {
      if (slashCommandSuggestions.length === 0) return 0
      return Math.min(current, slashCommandSuggestions.length - 1)
    })
  }, [showSlashCommandMenu, slashCommandSuggestions.length])

  useEffect(() => {
    if (!showSlashCommandMenu) return
    const activeItem = slashMenuRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    activeItem?.scrollIntoView({ block: 'nearest' })
  }, [showSlashCommandMenu, highlightedCommandIndex])

  const applySlashCommand = useCallback((suggestion: SlashCommandSuggestion) => {
    if (!slashCompletion) return

    const nextValue = applySlashCommandSuggestion(slashCompletion, suggestion)
    setInput(nextValue)
    setHighlightedCommandIndex(0)
    setDismissedSlashQuery(null)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
        textareaRef.current.focus()
        const caret = nextValue.length
        textareaRef.current.setSelectionRange(caret, caret)
      }
    })
  }, [slashCompletion])

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (sessionMissing || (!input.trim() && attachments.length === 0) || loading) return

    const accepted = await onSend({ text: input.trim(), attachments })
    if (!accepted) return

    setInput('')
    setAttachments([])
    setDismissedSlashQuery(null)
    const draftKey = `draft_${sessionId}`
    localStorage.removeItem(draftKey)

    requestAnimationFrame(() => {
      resizeTextarea(textareaRef.current)
      textareaRef.current?.focus()
    })
  }, [attachments, input, loading, onSend, sessionId, sessionMissing])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashCommandMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (slashCommandSuggestions.length > 0) {
          setHighlightedCommandIndex((current) => (current + 1) % slashCommandSuggestions.length)
        }
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (slashCommandSuggestions.length > 0) {
          setHighlightedCommandIndex((current) => (current - 1 + slashCommandSuggestions.length) % slashCommandSuggestions.length)
        }
        return
      }

      if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
        if (slashCommandSuggestions.length > 0) {
          e.preventDefault()
          applySlashCommand(slashCommandSuggestions[highlightedCommandIndex])
          return
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedSlashQuery(input)
        return
      }
    }

    if (e.key !== 'Enter') {
      return
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }, [applySlashCommand, handleSubmit, highlightedCommandIndex, input, showSlashCommandMenu, slashCommandSuggestions])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value
    setInput(nextValue)
    persistDraft(sessionId, nextValue)
    onDraftEdited?.(nextValue)
    setDismissedSlashQuery(null)
    resizeTextarea(e.target)
  }, [onDraftEdited, sessionId])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          setAttachments(prev => [...prev, file])
        }
      }
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setAttachments(prev => [...prev, ...files])
    }
  }, [])

  const appendTranscriptToDraft = useCallback((transcript: string) => {
    const trimmed = transcript.trim()
    if (!trimmed) return

    setInput(prev => {
      const prefix = prev.trim()
      const nextValue = prefix ? `${prefix}\n\n${trimmed}` : trimmed
      persistDraft(sessionId, nextValue)
      onDraftEdited?.(nextValue)
      return nextValue
    })

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
        textareaRef.current.focus()
        const caret = textareaRef.current.value.length
        textareaRef.current.setSelectionRange(caret, caret)
      }
    })
  }, [onDraftEdited, sessionId])

  const pushAsrDebug = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false })
    const line = `${timestamp} ${message}`
    console.info('[ASR debug]', line)
  }, [])

  const downsampleTo16k = useCallback((inputData: Float32Array, inputSampleRate: number) => {
    if (inputSampleRate === 16000) {
      return inputData
    }

    const ratio = inputSampleRate / 16000
    const outputLength = Math.max(1, Math.round(inputData.length / ratio))
    const output = new Float32Array(outputLength)
    let offsetResult = 0
    let offsetBuffer = 0

    while (offsetResult < output.length) {
      const nextOffsetBuffer = Math.min(inputData.length, Math.round((offsetResult + 1) * ratio))
      let accum = 0
      let count = 0
      for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
        accum += inputData[i]
        count++
      }
      output[offsetResult] = count > 0 ? accum / count : 0
      offsetResult++
      offsetBuffer = nextOffsetBuffer
    }

    return output
  }, [])

  const floatChunkToPcm16Buffer = useCallback((inputData: Float32Array, inputSampleRate: number) => {
    const downsampled = downsampleTo16k(inputData, inputSampleRate)
    const pcm16 = new Int16Array(downsampled.length)
    for (let i = 0; i < downsampled.length; i++) {
      const sample = Math.max(-1, Math.min(1, downsampled[i]))
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    return pcm16.buffer
  }, [downsampleTo16k])

  const mergePcmChunksToBuffer = useCallback((chunks: Int16Array[]) => {
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Int16Array(totalSamples)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged.buffer
  }, [])

  const analyzeAudioChunk = useCallback((inputData: Float32Array) => {
    let peak = 0
    let sumSquares = 0

    for (let i = 0; i < inputData.length; i++) {
      const sample = inputData[i]
      const abs = Math.abs(sample)
      if (abs > peak) {
        peak = abs
      }
      sumSquares += sample * sample
    }

    const rms = inputData.length > 0 ? Math.sqrt(sumSquares / inputData.length) : 0
    return { rms, peak }
  }, [])

  const flushPendingStreamingChunks = useCallback((reason: string) => {
    const streamingSession = streamingSessionRef.current
    const chunks = pendingStreamingChunksRef.current
    if (!streamingSession || chunks.length === 0) {
      return
    }

    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const chunkCount = chunks.length
    const payload = mergePcmChunksToBuffer(chunks)
    pendingStreamingChunksRef.current = []
    pushAsrDebug(`ws batch sent; reason=${reason} chunkCount=${chunkCount} bytes=${totalBytes}`)
    streamingSession.sendAudioChunk(payload)
  }, [mergePcmChunksToBuffer, pushAsrDebug])

  const startWaveformLoop = useCallback(() => {
    const analyser = audioAnalyserRef.current
    if (!analyser) return

    const data = new Uint8Array(analyser.frequencyBinCount)
    const barCount = 5
    const minVoiceHz = 120
    const maxVoiceHz = 4000

    const tick = () => {
      const activeAnalyser = audioAnalyserRef.current
      if (!recordingActiveRef.current || !activeAnalyser) {
        waveformFrameRef.current = null
        return
      }

      activeAnalyser.getByteFrequencyData(data)
      const sampleRate = activeAnalyser.context.sampleRate || 16000
      const binHz = sampleRate / activeAnalyser.fftSize
      const startBin = Math.max(0, Math.floor(minVoiceHz / binHz))
      const endBinExclusive = Math.max(startBin + 1, Math.min(data.length, Math.ceil(maxVoiceHz / binHz)))
      const voiceBinCount = Math.max(1, endBinExclusive - startBin)
      const binsPerBar = Math.max(1, Math.floor(voiceBinCount / barCount))

      const rawBars = Array.from({ length: barCount }, (_, index) => {
        const start = startBin + index * binsPerBar
        const end = index === barCount - 1
          ? endBinExclusive
          : Math.min(endBinExclusive, start + binsPerBar)
        let sum = 0
        for (let i = start; i < end; i++) {
          sum += data[i]
        }
        const avg = end > start ? sum / (end - start) : 0
        return avg / 255
      })

      const framePeak = rawBars.reduce((max, value) => Math.max(max, value), 0)
      waveformPeakRef.current = Math.max(framePeak, waveformPeakRef.current * 0.92, 0.06)

      // Auto-normalize quiet input for display only, capped at +20 dB (~10x amplitude).
      const targetPeak = 0.78
      const normalizationScale = Math.min(10, targetPeak / waveformPeakRef.current)
      const centerWeight = [0.72, 0.88, 1, 0.88, 0.72]
      const nextBars = rawBars.map((value, index) => {
        const weighted = value * normalizationScale * centerWeight[index]
        return Math.max(0.22, Math.min(1, weighted))
      })

      setWaveformBars(nextBars)
      waveformFrameRef.current = requestAnimationFrame(tick)
    }

    if (waveformFrameRef.current !== null) {
      cancelAnimationFrame(waveformFrameRef.current)
    }
    waveformFrameRef.current = requestAnimationFrame(tick)
  }, [])

  const handleAudioPick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const file = files[0]
    setTranscribeError(null)
    setTranscribingAudio(true)
    pushAsrDebug(`file start; name=${file.name} size=${file.size} type=${file.type || 'unknown'}`)

    try {
      const result = await onTranscribeAudio(file, input)
      pushAsrDebug(`file response; status=${result.status} rawLength=${result.rawLength} textLength=${result.textLength}`)
      if (result.responsePreview) {
        pushAsrDebug(`file preview=${JSON.stringify(result.responsePreview)}`)
      }
      const transcript = result.text
      if (!transcript.trim()) {
        throw new Error(`ASR returned empty text (status=${result.status}, rawLength=${result.rawLength}, textLength=${result.textLength})`)
      }

      appendTranscriptToDraft(transcript)
      pushAsrDebug(`file append success; trimmedLength=${transcript.trim().length}`)
    } catch (e) {
      console.error('ASR transcription failed:', e)
      setTranscribeError(e instanceof Error ? e.message : 'ASR transcription failed')
      pushAsrDebug(`file error; ${e instanceof Error ? e.message : 'ASR transcription failed'}`)
    } finally {
      setTranscribingAudio(false)
    }
  }, [appendTranscriptToDraft, input, onTranscribeAudio, pushAsrDebug])

  const handleRecordToggle = useCallback(async () => {
    if (transcribingAudio) return

    if (isRecordingAudio) {
      setIsRecordingAudio(false)
      setTranscribingAudio(true)
      setTranscribeError(null)

      if (audioChunkCountRef.current > 0) {
        const avgRms = audioRmsSumRef.current / audioChunkCountRef.current
        pushAsrDebug(
          `rec stop requested; chunkCount=${audioChunkCountRef.current} avgRms=${avgRms.toFixed(4)} maxRms=${audioMaxRmsRef.current.toFixed(4)} maxPeak=${audioMaxPeakRef.current.toFixed(4)}`
        )
      } else {
        pushAsrDebug('rec stop requested; no audio chunks captured')
      }

      try {
        flushPendingStreamingChunks('stop')
        await cleanupRecording()
        streamingSessionRef.current?.stop()
      } catch (e) {
        console.error('Failed to stop streaming audio recording:', e)
        setTranscribeError(e instanceof Error ? e.message : 'Failed to stop streaming audio recording')
        pushAsrDebug(`rec stop error; ${e instanceof Error ? e.message : 'Failed to stop streaming audio recording'}`)
        setTranscribingAudio(false)
      }
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setTranscribeError('Current browser does not support microphone recording')
      return
    }

    try {
      setTranscribeError(null)
      setLiveTranscriptionPreview('')
      pushAsrDebug('rec start requested')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      pushAsrDebug('mic stream granted')
      const streamingSession = await onCreateStreamingTranscriber({
        draftText: input,
        onPartial: (text) => {
          setLiveTranscriptionPreview(text)
        },
        onFinal: (text) => {
          setLiveTranscriptionPreview(text)
          if (text.trim()) {
            appendTranscriptToDraft(text)
            pushAsrDebug(`rec append success; trimmedLength=${text.trim().length}`)
          } else {
            pushAsrDebug('rec final text empty after trim')
          }
          setTranscribingAudio(false)
          setIsRecordingAudio(false)
          streamingSessionRef.current = null
          setTimeout(() => {
            setLiveTranscriptionPreview('')
          }, 1200)
        },
        onError: (message) => {
          setTranscribeError(message)
          setTranscribingAudio(false)
          setIsRecordingAudio(false)
          setLiveTranscriptionPreview('')
          streamingSessionRef.current = null
          void cleanupRecording()
        },
        onDebug: pushAsrDebug,
      })

      const audioContext = new AudioContext()
      await audioContext.resume().catch(() => {})
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const gain = audioContext.createGain()
      const analyser = audioContext.createAnalyser()
      gain.gain.value = 0
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.82

      audioSampleRateRef.current = audioContext.sampleRate
      recordingActiveRef.current = true
      audioChunkCountRef.current = 0
      audioMaxPeakRef.current = 0
      audioMaxRmsRef.current = 0
      audioRmsSumRef.current = 0
      pendingStreamingChunksRef.current = []
      streamingSessionRef.current = streamingSession
      streamingFlushTimerRef.current = setInterval(() => {
        flushPendingStreamingChunks('timer')
      }, 600)

      processor.onaudioprocess = (event) => {
        if (!recordingActiveRef.current) {
          return
        }
        const channelData = event.inputBuffer.getChannelData(0)
        const chunk = new Float32Array(channelData)
        const { rms, peak } = analyzeAudioChunk(chunk)
        const pcm16 = new Int16Array(floatChunkToPcm16Buffer(chunk, audioSampleRateRef.current))
        audioChunkCountRef.current += 1
        audioMaxPeakRef.current = Math.max(audioMaxPeakRef.current, peak)
        audioMaxRmsRef.current = Math.max(audioMaxRmsRef.current, rms)
        audioRmsSumRef.current += rms
        pendingStreamingChunksRef.current.push(pcm16)
        if (audioChunkCountRef.current <= 3 || audioChunkCountRef.current % 20 === 0) {
          pushAsrDebug(`mic chunk stats; count=${audioChunkCountRef.current} rms=${rms.toFixed(4)} peak=${peak.toFixed(4)}`)
        }
      }

      source.connect(analyser)
      source.connect(processor)
      processor.connect(gain)
      gain.connect(audioContext.destination)

      audioContextRef.current = audioContext
      audioSourceRef.current = source
      audioProcessorRef.current = processor
      audioGainRef.current = gain
      audioAnalyserRef.current = analyser
      audioStreamRef.current = stream
      setIsRecordingAudio(true)
      pushAsrDebug(`rec started; audioContextSampleRate=${audioContext.sampleRate}; streaming batched by 600ms window`)
      startWaveformLoop()
    } catch (e) {
      console.error('Failed to start microphone recording:', e)
      setTranscribeError(e instanceof Error ? e.message : 'Failed to start microphone recording')
      pushAsrDebug(`rec start error; ${e instanceof Error ? e.message : 'Failed to start microphone recording'}`)
      streamingSessionRef.current?.cancel()
      streamingSessionRef.current = null
      await cleanupRecording()
      setIsRecordingAudio(false)
    }
  }, [analyzeAudioChunk, appendTranscriptToDraft, cleanupRecording, floatChunkToPcm16Buffer, flushPendingStreamingChunks, input, isRecordingAudio, onCreateStreamingTranscriber, pushAsrDebug, transcribingAudio])

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-4 pt-10"
    >
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 dark:bg-blue-900/40 pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-lg border border-blue-300 dark:border-blue-700 bg-white/90 dark:bg-gray-900/80 px-4 py-3 text-blue-700 dark:text-blue-200 text-base font-semibold shadow-sm">
            <Paperclip size={18} />
            <span>Drop files here to upload</span>
          </div>
        </div>
      )}

      <div
        className="pointer-events-auto mx-auto max-w-5xl"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {transcribeError && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/80 dark:bg-amber-900/20 dark:text-amber-200">
            ASR 实验入口失败：{transcribeError}
          </div>
        )}
        {(isRecordingAudio || transcribingAudio || liveTranscriptionPreview) && (
          <div className="mb-3 flex justify-start">
            <div className="max-w-[min(100%,32rem)] rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 shadow-sm dark:border-blue-800/80 dark:bg-blue-900/20 dark:text-blue-100">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-blue-700 dark:text-blue-300">
                <span>{isRecordingAudio ? 'Live ASR preview' : 'ASR finalizing'}</span>
              </div>
              <div className="whitespace-pre-wrap break-words">
                {liveTranscriptionPreview || (isRecordingAudio ? 'Listening…' : 'Waiting for final transcript…')}
              </div>
            </div>
          </div>
        )}

        {showSlashCommandMenu && (
          <div className="mb-2 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <span>Slash commands</span>
              <span className="text-[11px]">↑↓ select · Enter/Tab apply · Esc dismiss</span>
            </div>
            <div ref={slashMenuRef} className="max-h-64 overflow-y-auto">
              {commandsLoading && (
                <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">Loading commands...</div>
              )}
              {!commandsLoading && commandsError && slashCommandSuggestions.length === 0 && slashCommandHints.length === 0 && (
                <div className="px-3 py-2 text-sm text-red-600 dark:text-red-300">{commandsError}</div>
              )}
              {!commandsLoading && !commandsError && slashCommandSuggestions.length === 0 && slashCommandHints.length === 0 && (
                <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matching commands.</div>
              )}
              {slashCommandSuggestions.map((command, index) => {
                const isActive = index === highlightedCommandIndex
                return (
                  <button
                    key={command.key}
                    type="button"
                    data-active={isActive ? 'true' : 'false'}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applySlashCommand(command)
                    }}
                    onMouseEnter={() => setHighlightedCommandIndex(index)}
                    className={`w-full border-b border-gray-100 px-3 py-2 text-left transition last:border-b-0 dark:border-gray-800 ${isActive ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/80'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{command.label}</span>
                      {command.requiresSession === false && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">global</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{command.description}</div>
                    {command.usage && (
                      <div className="mt-1 font-mono text-[11px] text-gray-500 dark:text-gray-400">{command.usage}</div>
                    )}
                  </button>
                )
              })}
              {slashCommandHints.map((hint, index) => (
                <div
                  key={hint.key}
                  className={`px-3 py-2 text-left ${slashCommandSuggestions.length > 0 || index > 0 ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
                >
                  <div className="font-mono text-sm text-gray-700 dark:text-gray-200">{hint.label}</div>
                  {hint.description && (
                    <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{hint.description}</div>
                  )}
                  {hint.usage && (
                    <div className="mt-1 font-mono text-[11px] text-gray-500 dark:text-gray-400">{hint.usage}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {sessionMissing && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/80 dark:bg-amber-900/20 dark:text-amber-200">
            Session not found. Select an existing session from the list, or create a new session instead of opening a missing hash directly.
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className={`rounded-[30px] border border-gray-200/90 bg-gray-50/75 px-3.5 py-2 shadow-[0_4px_14px_rgba(15,23,42,0.06)] backdrop-blur-[5px] transition focus-within:border-gray-300 focus-within:bg-white/92 dark:border-gray-700/90 dark:bg-gray-800/70 dark:focus-within:border-gray-600 dark:focus-within:bg-gray-800/92 ${
            isDragging ? 'border-blue-400 dark:border-blue-500' : ''
          }`}
        >
        <input
          type="file"
          id="file-upload"
          multiple
          accept="image/*,text/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.sh"
          onChange={(e) => {
            if (e.target.files) {
              setAttachments(prev => [...prev, ...Array.from(e.target.files!)])
            }
          }}
          className="hidden"
        />
        <input
          type="file"
          id="audio-upload"
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
          onChange={(e) => {
            void handleAudioPick(e.target.files)
            e.currentTarget.value = ''
          }}
          className="hidden"
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            const draftKey = `draft_${sessionId}`
            if (input.trim()) {
              localStorage.setItem(draftKey, input)
            } else {
              localStorage.removeItem(draftKey)
            }
          }}
          disabled={loading || sessionMissing}
          rows={1}
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className="mb-1.5 min-h-[60px] w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-1 text-[16px] leading-6 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 dark:text-white dark:placeholder:text-gray-500"
          style={{ maxHeight: '200px', fontSize: '16px' }}
          placeholder={sessionMissing
            ? 'Session not found'
            : 'Ask Foxwarm anything, + to add files, / for commands'}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
            <label
              htmlFor="file-upload"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-200 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
              title="Attach files"
              aria-label="Attach files"
            >
              <Plus size={18} />
            </label>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              {attachments.length === 0 ? (
                <div className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-gray-500 dark:text-gray-400">
                  <Paperclip size={13} />
                  <span>No files</span>
                </div>
              ) : (
                attachments.map((file, idx) => (
                  <div
                    key={`${file.name}-${idx}`}
                    className="inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-2 rounded-full border border-gray-200 bg-white px-3 text-[13px] shadow-sm dark:border-gray-700 dark:bg-gray-800"
                  >
                    <Paperclip size={12} className="shrink-0 text-gray-400 dark:text-gray-500" />
                    <span className="truncate text-gray-700 dark:text-gray-300">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                      className="shrink-0 text-gray-400 transition hover:text-red-500"
                      title="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
            {asrAvailable && (
              <>
                <div className="inline-flex shrink-0 items-center rounded-full bg-transparent">
                  <button
                    type="button"
                    onClick={() => void handleRecordToggle()}
                    disabled={transcribingAudio}
                    className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-l-full rounded-r-none px-3 text-[13px] font-medium leading-none transition disabled:cursor-not-allowed ${isRecordingAudio ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/60' : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'} ${transcribingAudio ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : ''}`}
                    title={isRecordingAudio ? 'Stop recording and transcribe' : 'Start recording'}
                  >
                    {isRecordingAudio ? <Square size={13} className="shrink-0" /> : <Mic size={13} className="shrink-0" />}
                    {!isRecordingAudio && (
                      <span className="leading-none">Rec</span>
                    )}
                    {(isRecordingAudio || transcribingAudio) && (
                      <span className="ml-1 inline-flex h-[14px] items-center gap-[2px] self-center">
                        {waveformBars.map((value, index) => (
                          <span
                            key={index}
                            className={`w-[3px] rounded-full transition-all duration-75 ${isRecordingAudio ? 'bg-current opacity-90' : 'bg-current opacity-60'}`}
                            style={{ height: `${Math.max(4, Math.round(value * 14))}px` }}
                          />
                        ))}
                      </span>
                    )}
                  </button>
                  <label
                    htmlFor="audio-upload"
                    onClick={(e) => {
                      if (isRecordingAudio || transcribingAudio) {
                        e.preventDefault()
                      }
                    }}
                    className={`inline-flex h-8 shrink-0 items-center justify-center rounded-r-full rounded-l-none px-3 text-[13px] font-medium transition ${isRecordingAudio || transcribingAudio ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${transcribingAudio ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'} ${isRecordingAudio ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200' : ''}`}
                    title="Upload audio file and append transcript to draft"
                  >
                    <span>file</span>
                  </label>
                </div>
              </>
            )}
            <ModelSelector
              options={modelOptions}
              currentModelKey={currentModelKey}
              sessionModel={sessionModel}
              defaultModelKey={defaultModelKey}
              childModelDefault={childModelDefault}
              effectiveChildModelKey={effectiveChildModelKey}
              busy={modelBusy}
              error={modelError}
              onChangeModel={onChangeModel}
              onChangeChildModel={onChangeChildModel}
            />
          </div>
          <button
            type="submit"
            disabled={loading || sessionMissing || (!input.trim() && attachments.length === 0)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white transition hover:bg-black disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white dark:disabled:bg-gray-700 dark:disabled:text-gray-500"
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUp size={18} />
          </button>
        </div>
        </form>
      </div>
    </div>
  )
})

export default ChatComposer
