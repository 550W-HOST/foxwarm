import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Mic, Paperclip, Plus, Square } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import {
  applySlashCommandSuggestion,
  getSlashCommandCompletion,
  resizeTextarea,
  type SendKeyMode,
  type SlashCommandOption,
  type SlashCommandSuggestion,
} from './chatShared'

interface ChatComposerProps {
  sessionId: string
  sessionMissing: boolean
  loading: boolean
  asrAvailable: boolean
  sendKeyMode: SendKeyMode
  onToggleSendKeyMode: () => void
  onSend: (payload: { text: string; attachments: File[] }) => Promise<boolean>
  onTranscribeAudio: (file: File, context: string) => Promise<string>
  onCreateStreamingTranscriber: (options: {
    draftText: string
    onPartial: (text: string) => void
    onFinal: (text: string) => void
    onError: (message: string) => void
  }) => Promise<{
    sendAudioChunk: (chunk: ArrayBuffer) => void
    stop: () => void
    cancel: () => void
  }>
}

const ChatComposer = memo(function ChatComposer({
  sessionId,
  sessionMissing,
  loading,
  asrAvailable,
  sendKeyMode,
  onToggleSendKeyMode,
  onSend,
  onTranscribeAudio,
  onCreateStreamingTranscriber,
}: ChatComposerProps) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isRecordingAudio, setIsRecordingAudio] = useState(false)
  const [transcribingAudio, setTranscribingAudio] = useState(false)
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const [liveTranscriptionPreview, setLiveTranscriptionPreview] = useState('')
  const [availableCommands, setAvailableCommands] = useState<SlashCommandOption[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsError, setCommandsError] = useState<string | null>(null)
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioGainRef = useRef<GainNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioSampleRateRef = useRef<number>(16000)
  const recordingActiveRef = useRef(false)
  const streamingSessionRef = useRef<{
    sendAudioChunk: (chunk: ArrayBuffer) => void
    stop: () => void
    cancel: () => void
  } | null>(null)

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
      const draftKey = `draft_${sessionId}`
      if (input.trim()) {
        localStorage.setItem(draftKey, input)
      } else {
        localStorage.removeItem(draftKey)
      }
    }, 2000)

    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current)
      }
    }
  }, [input, sessionId])

  const cleanupRecording = useCallback(async () => {
    recordingActiveRef.current = false
    audioProcessorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    audioGainRef.current?.disconnect()
    audioStreamRef.current?.getTracks().forEach(track => track.stop())

    audioProcessorRef.current = null
    audioSourceRef.current = null
    audioGainRef.current = null
    audioStreamRef.current = null

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

    if (sendKeyMode === 'mod-enter') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        void handleSubmit()
      }
      return
    }

    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }, [applySlashCommand, handleSubmit, highlightedCommandIndex, input, sendKeyMode, showSlashCommandMenu, slashCommandSuggestions])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value
    setInput(nextValue)
    setDismissedSlashQuery(null)
    resizeTextarea(e.target)
  }, [])

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
      return prefix ? `${prefix}\n\n${trimmed}` : trimmed
    })

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
        textareaRef.current.focus()
        const caret = textareaRef.current.value.length
        textareaRef.current.setSelectionRange(caret, caret)
      }
    })
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

  const handleAudioPick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const file = files[0]
    setTranscribeError(null)
    setTranscribingAudio(true)

    try {
      const transcript = await onTranscribeAudio(file, input)
      if (!transcript.trim()) {
        throw new Error('ASR returned empty text')
      }

      appendTranscriptToDraft(transcript)
    } catch (e) {
      console.error('ASR transcription failed:', e)
      setTranscribeError(e instanceof Error ? e.message : 'ASR transcription failed')
    } finally {
      setTranscribingAudio(false)
    }
  }, [appendTranscriptToDraft, input, onTranscribeAudio])

  const handleRecordToggle = useCallback(async () => {
    if (transcribingAudio) return

    if (isRecordingAudio) {
      setIsRecordingAudio(false)
      setTranscribingAudio(true)
      setTranscribeError(null)

      try {
        await cleanupRecording()
        streamingSessionRef.current?.stop()
      } catch (e) {
        console.error('Failed to stop streaming audio recording:', e)
        setTranscribeError(e instanceof Error ? e.message : 'Failed to stop streaming audio recording')
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const streamingSession = await onCreateStreamingTranscriber({
        draftText: input,
        onPartial: (text) => {
          setLiveTranscriptionPreview(text)
        },
        onFinal: (text) => {
          setLiveTranscriptionPreview(text)
          if (text.trim()) {
            appendTranscriptToDraft(text)
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
      })

      const audioContext = new AudioContext()
      await audioContext.resume().catch(() => {})
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const gain = audioContext.createGain()
      gain.gain.value = 0

      audioSampleRateRef.current = audioContext.sampleRate
      recordingActiveRef.current = true
      streamingSessionRef.current = streamingSession

      processor.onaudioprocess = (event) => {
        if (!recordingActiveRef.current) {
          return
        }
        const channelData = event.inputBuffer.getChannelData(0)
        const chunk = new Float32Array(channelData)
        streamingSession.sendAudioChunk(floatChunkToPcm16Buffer(chunk, audioSampleRateRef.current))
      }

      source.connect(processor)
      processor.connect(gain)
      gain.connect(audioContext.destination)

      audioContextRef.current = audioContext
      audioSourceRef.current = source
      audioProcessorRef.current = processor
      audioGainRef.current = gain
      audioStreamRef.current = stream
      setIsRecordingAudio(true)
    } catch (e) {
      console.error('Failed to start microphone recording:', e)
      setTranscribeError(e instanceof Error ? e.message : 'Failed to start microphone recording')
      streamingSessionRef.current?.cancel()
      streamingSessionRef.current = null
      await cleanupRecording()
      setIsRecordingAudio(false)
    }
  }, [appendTranscriptToDraft, cleanupRecording, floatChunkToPcm16Buffer, input, isRecordingAudio, onCreateStreamingTranscriber, transcribingAudio])

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 p-4 pt-10"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 dark:bg-blue-900/40 pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-lg border border-blue-300 dark:border-blue-700 bg-white/90 dark:bg-gray-900/80 px-4 py-3 text-blue-700 dark:text-blue-200 text-base font-semibold shadow-sm">
            <Paperclip size={18} />
            <span>Drop files here to upload</span>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-5xl">
        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((file, idx) => (
              <div key={`${file.name}-${idx}`} className="relative inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <span className="text-gray-700 dark:text-gray-300">{file.name}</span>
                <button
                  onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                  className="text-gray-400 transition hover:text-red-500"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {transcribeError && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/80 dark:bg-amber-900/20 dark:text-amber-200">
            ASR 实验入口失败：{transcribeError}
          </div>
        )}

        {(isRecordingAudio || transcribingAudio || liveTranscriptionPreview) && (
          <div className="mb-3 flex justify-start">
            <div className="max-w-[min(100%,36rem)] rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 shadow-sm dark:border-blue-800/80 dark:bg-blue-900/20 dark:text-blue-100">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-blue-700 dark:text-blue-300">
                <span>{isRecordingAudio ? 'Live ASR preview' : 'ASR finalizing'}</span>
              </div>
              <div className="whitespace-pre-wrap break-words">
                {liveTranscriptionPreview || (isRecordingAudio ? 'Listening…' : 'Waiting for final transcript…')}
              </div>
              <div className="mt-2 text-[11px] text-blue-600/90 dark:text-blue-300/80">
                Preview only — final text will be appended to the draft when recording ends. It will not auto-send.
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
            {asrAvailable && (
              <>
                <label
                  htmlFor="audio-upload"
                  className={`inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full px-3 text-[13px] font-medium transition ${transcribingAudio ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'}`}
                  title="Upload audio file and append transcript to draft"
                >
                  <span>{transcribingAudio ? 'ASR…' : 'ASR'}</span>
                </label>
                <button
                  type="button"
                  onClick={() => void handleRecordToggle()}
                  disabled={transcribingAudio}
                  className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium transition disabled:cursor-not-allowed ${isRecordingAudio ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/60' : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'} ${transcribingAudio ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : ''}`}
                  title={isRecordingAudio ? 'Stop recording and transcribe' : 'Start recording'}
                >
                  {isRecordingAudio ? <Square size={13} /> : <Mic size={13} />}
                  <span>{isRecordingAudio ? 'Stop' : 'Rec'}</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onToggleSendKeyMode}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
              title="Toggle send key"
            >
              <span>{sendKeyMode === 'enter' ? 'Enter to send' : 'Ctrl/Cmd+Enter'}</span>
              <ChevronDown size={13} />
            </button>
            <div className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-gray-500 dark:text-gray-400">
              <Paperclip size={13} />
              <span>{attachments.length > 0 ? `${attachments.length} file${attachments.length > 1 ? 's' : ''}` : 'No files'}</span>
            </div>
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
