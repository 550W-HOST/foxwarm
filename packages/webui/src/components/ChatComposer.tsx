import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Paperclip, Plus } from 'lucide-react'
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
  sendKeyMode: SendKeyMode
  onToggleSendKeyMode: () => void
  onSend: (payload: { text: string; attachments: File[] }) => Promise<boolean>
}

const ChatComposer = memo(function ChatComposer({
  sessionId,
  sessionMissing,
  loading,
  sendKeyMode,
  onToggleSendKeyMode,
  onSend,
}: ChatComposerProps) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [availableCommands, setAvailableCommands] = useState<SlashCommandOption[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsError, setCommandsError] = useState<string | null>(null)
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  return (
    <div
      className={`sticky bottom-0 z-20 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md p-4 transition-colors ${
        isDragging ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400 dark:border-blue-500' : ''
      }`}
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

      {showSlashCommandMenu && (
        <div className="mb-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg overflow-hidden">
          <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
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
                  className={`w-full px-3 py-2 text-left border-b last:border-b-0 border-gray-100 dark:border-gray-800 transition ${isActive ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/80'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{command.label}</span>
                    {command.requiresSession === false && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">global</span>
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
        className="rounded-[30px] border border-gray-200 bg-gray-50/95 px-3.5 py-2 shadow-[0_4px_14px_rgba(15,23,42,0.06)] transition focus-within:border-gray-300 focus-within:bg-white dark:border-gray-700 dark:bg-gray-800/95 dark:focus-within:border-gray-600 dark:focus-within:bg-gray-800"
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
  )
})

export default ChatComposer
