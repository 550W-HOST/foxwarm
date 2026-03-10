import { useState, useEffect, useRef } from 'react'
import { API_BASE_PATH } from '../config'
import * as Diff from 'diff'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Eye,
  Code,
  FileJson,
  Menu,
  BookOpen,
  Pencil,
  Wrench,
  Terminal,
  Paperclip,
  Copy,
  Check,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface ChatProps {
  sessionId: string
  sessionDisplayName?: string
  onBack?: () => void
  themeMode: 'auto' | 'light' | 'dark'
  onThemeChange: (mode: 'auto' | 'light' | 'dark') => void
}

interface SlashCommandOption {
  name: string
  description: string
  usage?: string | null
  requiresSession?: boolean
  showInTelegram?: boolean
}

type SendKeyMode = 'mod-enter' | 'enter'

// View mode for assistant messages
type ViewMode = 'rendered' | 'raw' | 'json'

type ToolViewMode = 'default' | 'json'


interface FunctionCall {
  id?: string
  name: string
  args: any
}

interface FunctionResponse {
  tool_use_id?: string
  name: string
  response: any
}

interface MessagePart {
  text?: string
  system?: string
  thinking?: string
  functionCall?: FunctionCall
  functionResponse?: FunctionResponse
  toolUseId?: string
  inlineData?: {
    data: string
    mimeType: string
  }
}

type PatchPreviewHunk = {
  anchors: string[]
  lines: string[]
}

type PatchPreviewOperation =
  | { action: 'update'; filePath: string; hunks: PatchPreviewHunk[] }
  | { action: 'add'; filePath: string; lines: string[] }
  | { action: 'delete'; filePath: string }

const normalizePatchNewlines = (text: string) => text.replace(/\r\n/g, '\n')

const extractPatchEnvelope = (input: string): string => {
  const normalized = normalizePatchNewlines(input)
  const beginIndex = normalized.indexOf('*** Begin Patch')
  const endIndex = normalized.lastIndexOf('*** End Patch')

  if (beginIndex !== -1 && endIndex !== -1 && endIndex >= beginIndex) {
    return normalized.slice(beginIndex, endIndex + '*** End Patch'.length).trim()
  }

  return normalized.trim()
}

const parsePatchUpdateSection = (lines: string[], filePath: string): PatchPreviewHunk[] => {
  const hunks: PatchPreviewHunk[] = []
  let i = 0

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++
    if (i >= lines.length) break

    const anchors: string[] = []
    while (i < lines.length && lines[i].startsWith('@@')) {
      anchors.push(lines[i].slice(2).trim())
      i++
    }

    const hunkLines: string[] = []
    let sawChange = false

    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith('@@') && hunkLines.length > 0 && sawChange) {
        break
      }

      if (line.trim() === '' && sawChange) {
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        if (j >= lines.length || lines[j].startsWith('@@')) {
          i = j
          break
        }
      }

      if (line.startsWith('-') || line.startsWith('+')) {
        sawChange = true
      }

      hunkLines.push(line)
      i++
    }

    if (!sawChange) {
      throw new Error(`Invalid apply_patch input for ${filePath}: update hunk must include at least one changed line.`)
    }

    hunks.push({ anchors, lines: hunkLines })
  }

  if (hunks.length === 0) {
    throw new Error(`Invalid apply_patch input for ${filePath}: update section must include at least one hunk.`)
  }

  return hunks
}

const parsePatchAddSection = (lines: string[], filePath: string): string[] => {
  const contentLines: string[] = []

  for (const line of lines) {
    if (line === '') {
      contentLines.push('')
      continue
    }

    if (!line.startsWith('+')) {
      throw new Error(`Invalid apply_patch input for ${filePath}: add file lines must start with '+'.`)
    }

    contentLines.push(line.slice(1))
  }

  return contentLines
}

const parseApplyPatchPreview = (input?: string): PatchPreviewOperation[] => {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return []
  }

  const envelope = extractPatchEnvelope(input)
  const lines = envelope.split('\n')
  const hasEnvelope = lines[0] === '*** Begin Patch' && lines[lines.length - 1] === '*** End Patch'
  const body = hasEnvelope ? lines.slice(1, -1) : lines
  const operations: PatchPreviewOperation[] = []
  let i = 0

  const isFileHeader = (line: string) => (
    line.startsWith('*** Update File: ') ||
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ')
  )

  while (i < body.length) {
    while (i < body.length && body[i].trim() === '') i++
    if (i >= body.length) break

    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(body[i])
    if (!match) {
      throw new Error(`Invalid apply_patch input: expected file action header, got: ${body[i]}`)
    }

    const action = match[1].toLowerCase() as 'update' | 'add' | 'delete'
    const filePath = match[2].trim()
    i++

    const sectionLines: string[] = []
    while (i < body.length && !isFileHeader(body[i])) {
      sectionLines.push(body[i])
      i++
    }

    if (action === 'update') {
      operations.push({ action, filePath, hunks: parsePatchUpdateSection(sectionLines, filePath) })
    } else if (action === 'add') {
      operations.push({ action, filePath, lines: parsePatchAddSection(sectionLines, filePath) })
    } else {
      operations.push({ action, filePath })
    }
  }

  if (operations.length === 0) {
    throw new Error('Invalid apply_patch input: patch contains no file operations.')
  }

  return operations
}

const buildPatchHunkSnippets = (hunk: PatchPreviewHunk): { oldText: string; newText: string } => {
  const oldLines: string[] = []
  const newLines: string[] = []

  for (const line of hunk.lines) {
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
      continue
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1))
      continue
    }

    oldLines.push(line)
    newLines.push(line)
  }

  return {
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
  }
}

interface Message {
  role: 'user' | 'model' | 'tool'
  parts: MessagePart[]
  __meta?: {
    timestamp?: number
    [key: string]: any
  }
}

// Configure marked for security
marked.setOptions({
  breaks: true,
  gfm: true,
})

// Configure DOMPurify to prevent XSS and auto-requests
const sanitizeHtml = (html: string): string => {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'embed', 'object', 'script', 'style'],
    FORBID_ATTR: ['src', 'href', 'xlink:href', 'action', 'formaction'],
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['class'],
  })
}

const IconToggleButton = ({ active, title, onClick, children }: { active: boolean; title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) => (
  <button
    onClick={onClick}
    title={title}
    className={`p-0.5 rounded ${active ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
  >
    {children}
  </button>
)

const MiniToggleButton = ({ active, title, onClick, children }: { active: boolean; title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) => (
  <button
    onClick={onClick}
    title={title}
    className={`px-1.5 py-0.5 text-[10px] rounded ${active ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
  >
    {children}
  </button>
)


// Render markdown safely
const renderMarkdown = (text: string): string => {
  const html = marked(text) as string
  return sanitizeHtml(html)
}

const copyTextToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)

  if (!copied) {
    throw new Error('Copy command was rejected by the browser')
  }
}

// Helper to format object: if single key, return value; otherwise return "key: value" pairs
const formatObject = (obj: any): string => {
  if (!obj || typeof obj !== 'object') return String(obj)
  const keys = Object.keys(obj)
  if (keys.length === 1) {
    const value = obj[keys[0]]
    // If value is object, stringify it
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return keys.map(key => {
    const value = obj[key]
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : value
    return `${key}: ${valueStr}`
  }).join('\n')
}

const formatStructuredSystemText = (system: string): string => (
  system.startsWith('FROM:') ? `[${system}]` : `[SYSTEM: ${system}]`
)

const isSystemLikeText = (text: string): boolean => (
  text.startsWith('[SYSTEM:') || text.startsWith('[FROM:')
)

const isLightweightStructuredSystem = (system: string): boolean => (
  system.startsWith('FROM:') ||
  system.startsWith('current time =') ||
  system.startsWith('current session ID =')
)

const isLightweightSystemTextLine = (text: string): boolean => (
  text.startsWith('[FROM:') ||
  text.startsWith('[SYSTEM: current time') ||
  text.startsWith('[SYSTEM: current session ID =')
)

const isHeavySystemTextLine = (text: string): boolean => (
  text.startsWith('[SYSTEM:') && !isLightweightSystemTextLine(text)
)

const isCollapsibleSystemText = (text: string): boolean => (
  text.startsWith('[SYSTEM:') && !isLightweightSystemTextLine(text)
)

const clampContentStyle = (lines: number, extraHeightRem = 0): React.CSSProperties => ({
  maxHeight: extraHeightRem > 0
    ? `calc(1.5em * ${lines} + ${extraHeightRem}rem)`
    : `calc(1.5em * ${lines})`,
  overflow: 'hidden',
})

const getSlashCommandQuery = (value: string): string | null => {
  if (!value || value.includes('\n') || /^\s/.test(value)) {
    return null
  }

  const match = value.match(/^\/([^\s]*)$/)
  return match ? match[1] : null
}

const resizeTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
}

// ANSI color code parser
const parseAnsi = (text: string): React.ReactNode[] => {
  const ansiRegex = /\x1b\[([0-9;]+)m/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let currentStyles: string[] = []

  const ansiToStyle = (code: string): string[] => {
    const codes = code.split(';').map(Number)
    const styles: string[] = []
    
    for (const c of codes) {
      if (c === 0) return [] // Reset
      if (c === 1) styles.push('font-weight: bold')
      if (c === 3) styles.push('font-style: italic')
      if (c === 4) styles.push('text-decoration: underline')
      
      // Foreground colors
      if (c === 30) styles.push('color: #000')
      if (c === 31) styles.push('color: #e74c3c')
      if (c === 32) styles.push('color: #2ecc71')
      if (c === 33) styles.push('color: #f39c12')
      if (c === 34) styles.push('color: #3498db')
      if (c === 35) styles.push('color: #9b59b6')
      if (c === 36) styles.push('color: #1abc9c')
      if (c === 37) styles.push('color: #bdc3c7')
      if (c === 39) styles.push('color: inherit') // Default
      
      // Bright foreground colors
      if (c === 90) styles.push('color: #7f8c8d')
      if (c === 91) styles.push('color: #ff6b6b')
      if (c === 92) styles.push('color: #51cf66')
      if (c === 93) styles.push('color: #ffd43b')
      if (c === 94) styles.push('color: #74c0fc')
      if (c === 95) styles.push('color: #da77f2')
      if (c === 96) styles.push('color: #3bc9db')
      if (c === 97) styles.push('color: #f1f3f5')
    }
    
    return styles
  }

  let match
  while ((match = ansiRegex.exec(text)) !== null) {
    // Add text before the ANSI code
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index)
      if (currentStyles.length > 0) {
        parts.push(
          <span key={parts.length} style={{ display: 'inline' }}>
            {textBefore.split('\n').map((line, idx) => (
              <span key={idx}>{line}{idx < textBefore.split('\n').length - 1 ? <br /> : null}</span>
            ))}
          </span>
        )
      } else {
        parts.push(textBefore.split('\n').map((line, idx) => (
          <span key={`${parts.length}-${idx}`}>{line}{idx < textBefore.split('\n').length - 1 ? <br /> : null}</span>
        )))
      }
    }

    // Update current styles
    const newStyles = ansiToStyle(match[1])
    if (newStyles.length === 0) {
      currentStyles = []
    } else {
      currentStyles = newStyles
    }

    lastIndex = ansiRegex.lastIndex
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex)
    if (currentStyles.length > 0) {
      parts.push(
        <span key={parts.length} style={{ display: 'inline' }}>
          {remaining.split('\n').map((line, idx) => (
            <span key={idx}>{line}{idx < remaining.split('\n').length - 1 ? <br /> : null}</span>
          ))}
        </span>
      )
    } else {
      parts.push(remaining.split('\n').map((line, idx) => (
        <span key={`${parts.length}-${idx}`}>{line}{idx < remaining.split('\n').length - 1 ? <br /> : null}</span>
      )))
    }
  }

  return parts.length > 0 ? parts : [text]
}

const toolIcons: Record<string, LucideIcon> = {
  read: BookOpen,
  write: Pencil,
  edit: Pencil,
  apply_patch: Wrench,
  exec: Terminal,
}

const getToolIcon = (name: string) => toolIcons[name] || Wrench

const ToolTag = ({ name, className = '' }: { name: string, className?: string }) => {
  const Icon = getToolIcon(name)

  return (
    <span className={`inline-flex h-[18px] items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 bg-white/80 dark:bg-gray-900/60 px-1.5 text-[10px] font-semibold uppercase tracking-wide leading-none text-gray-600 dark:text-gray-300 align-middle ${className}`.trim()}>
      <Icon size={12} />
      <span>{name}</span>
    </span>
  )
}

const ToolLabel = ({ name }: { name: string }) => <ToolTag name={name} />

const ToolTagList = ({ names }: { names: string[] }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    {names.map((name, idx) => (
      <ToolTag key={`${name}-${idx}`} name={name} />
    ))}
  </div>
)

const SessionHashLink = ({ sessionId, className = '' }: { sessionId: string, className?: string }) => (
  <a
    href={`#${sessionId}`}
    className={`font-mono underline decoration-dotted underline-offset-2 hover:text-blue-600 dark:hover:text-blue-300 ${className}`.trim()}
    title={`Open session ${sessionId}`}
  >
    {sessionId}
  </a>
)

const renderSystemTextWithSessionLinks = (text: string) => {
  const result: React.ReactNode[] = []
  const pattern = /(sessionId:\s*`([^`]+)`|session\s*`([^`]+)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0]
    const sessionId = match[2] || match[3]
    const prefix = text.slice(lastIndex, match.index)

    if (prefix) result.push(prefix)

    if (fullMatch.startsWith('sessionId:')) {
      result.push(
        <span key={`session-link-${match.index}`}>
          sessionId: <SessionHashLink sessionId={sessionId} />
        </span>
      )
    } else {
      result.push(
        <span key={`session-link-${match.index}`}>
          session <SessionHashLink sessionId={sessionId} />
        </span>
      )
    }

    lastIndex = match.index + fullMatch.length
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex))
  }

  return result.length > 0 ? result : [text]
}

export default function Chat({ sessionId, sessionDisplayName, onBack, themeMode, onThemeChange }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionQueueLength, setSessionQueueLength] = useState(0)
  const [expandedTool, setExpandedTool] = useState<string | null>(null)
  const [expandedSystemMessages, setExpandedSystemMessages] = useState<Set<string>>(new Set())
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    return (localStorage.getItem('diffViewMode') as 'unified' | 'split') || 'unified'
  })
  const [attachments, setAttachments] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [connectionState, setConnectionState] = useState<'connected' | 'connecting' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0)
  const [showScrollButton, setShowScrollButton] = useState(false)
  // View mode for each assistant message (messageIndex -> ViewMode)
  const [messageViewModes, setMessageViewModes] = useState<Map<number, ViewMode>>(new Map())
  const [toolViewModes, setToolViewModes] = useState<Map<string, ToolViewMode>>(new Map())
  const [availableCommands, setAvailableCommands] = useState<SlashCommandOption[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsError, setCommandsError] = useState<string | null>(null)
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)
  const [sendKeyMode, setSendKeyMode] = useState<SendKeyMode>(() => {
    const saved = localStorage.getItem('sendKeyMode')
    return saved === 'enter' || saved === 'mod-enter' ? saved : 'mod-enter'
  })

  const setMessageView = (messageIdx: number, mode: ViewMode) => {
    setMessageViewModes(prev => {
      const next = new Map(prev)
      next.set(messageIdx, mode)
      return next
    })
  }

  const setToolView = (toolKey: string, mode: ToolViewMode) => {
    setToolViewModes(prev => {
      const next = new Map(prev)
      next.set(toolKey, mode)
      return next
    })

    if (mode === 'json') {
      setExpandedTool(toolKey)
    }
  }
  const [showScrollTopButton, setShowScrollTopButton] = useState(false)
  const [verbose, setVerbose] = useState<boolean>(() => {
    const saved = localStorage.getItem(`verbose_${sessionId}`)
    return saved !== null ? saved === 'true' : true
  })
  const [showMenu, setShowMenu] = useState(false)
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const copyResetTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('sendKeyMode', sendKeyMode)
  }, [sendKeyMode])

  const handleCopyRawText = async (messageKey: string, text: string) => {
    try {
      await copyTextToClipboard(text)
      setCopiedMessageKey(messageKey)

      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }

      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageKey(current => current === messageKey ? null : current)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy raw text:', error)
    }
  }

  // Helper to check if a message has text content
  const hasTextContent = (msg: any) => {
    return msg.parts.some((p: any) => (p.text && p.text.trim()) || (p.system && String(p.system).trim()))
  }

  // Helper to check if a message has tool calls
  const hasToolCalls = (msg: any) => {
    return msg.parts.some((p: any) => p.functionCall)
  }

  // Find the start index of a tool group
  // Tool groups are separated by model messages with text
  // A model message with text+calls starts a new group
  const getToolGroupStartIdx = (idx: number) => {
    const currentMsg = messages[idx]
    
    // Model messages with text always start a new group
    if (currentMsg.role === 'model' && hasTextContent(currentMsg)) {
      return idx
    }
    
    // Walk backward to find the group start
    let start = idx
    for (let i = idx - 1; i >= 0; i--) {
      const m = messages[i]
      
      // Stop at non-model/tool messages
      if (m.role !== 'model' && m.role !== 'tool') break
      
      // Model with text+call is a group start
      if (m.role === 'model' && hasTextContent(m)) {
        return hasToolCalls(m) ? i : start
      }
      
      start = i
    }
    return start
  }

  const getToolGroupKey = (idx: number) => `${getToolGroupStartIdx(idx)}-toolgroup`

  // Get all tool names in a group starting from startIdx
  const getToolGroupNames = (startIdx: number) => {
    const names: string[] = []
    
    for (let i = startIdx; i < messages.length; i++) {
      const m = messages[i]
      
      // Stop at non-model/tool messages
      if (m.role !== 'model' && m.role !== 'tool') break
      
      // Stop at model messages with text (except the start message)
      if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break
      
      // Collect function call names
      m.parts.forEach((p: any) => {
        if (p.functionCall) names.push(p.functionCall.name)
      })
    }
    
    return names
  }

  const shouldRenderToolGroupSummary = (idx: number) => {
    if (verbose) return false
    const startIdx = getToolGroupStartIdx(idx)
    if (idx !== startIdx) return false
    const names = getToolGroupNames(startIdx)
    return names.length > 0
  }

  const isInToolGroup = (idx: number) => {
    if (verbose) return false
    const startIdx = getToolGroupStartIdx(idx)
    return getToolGroupNames(startIdx).length > 0
  }
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const draftSaveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastKnownTimestampRef = useRef<number>(0)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectDelayRef = useRef<number>(1000) // Initial delay: 1s
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const shouldAutoScrollRef = useRef<boolean>(true) // Track if should auto-scroll
  const pendingSentMessagesRef = useRef<string[]>([]) // Track pending sent messages for deduplication
  
  // Refs for diff sync scroll
  const diffOldScrollRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const diffNewScrollRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const diffLastScrollSide = useRef<'old' | 'new' | null>(null)

  useEffect(() => {
    // Listen for window resize
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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

  const slashCommandQuery = getSlashCommandQuery(input)
  const slashCommandSuggestions = slashCommandQuery === null
    ? []
    : availableCommands.filter((command) => command.name.slice(1).toLowerCase().startsWith(slashCommandQuery.toLowerCase()))
  const showSlashCommandMenu = slashCommandQuery !== null && dismissedSlashQuery !== input && (commandsLoading || slashCommandSuggestions.length > 0 || !!commandsError)

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

  // Load draft from localStorage on mount
  useEffect(() => {
    const draftKey = `draft_${sessionId}`
    const savedDraft = localStorage.getItem(draftKey)
    if (savedDraft) {
      setInput(savedDraft)
      setDismissedSlashQuery(null)
      // Auto-resize textarea after loading draft
      setTimeout(() => {
        resizeTextarea(textareaRef.current)
      }, 0)
    }
  }, [sessionId])

  // Save draft to localStorage with debounce
  useEffect(() => {
    // Clear existing timer
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current)
    }

    // Set new timer to save after 2 seconds of no input
    draftSaveTimerRef.current = setTimeout(() => {
      const draftKey = `draft_${sessionId}`
      if (input.trim()) {
        localStorage.setItem(draftKey, input)
      } else {
        // Remove draft if input is empty
        localStorage.removeItem(draftKey)
      }
    }, 2000)

    // Cleanup on unmount or when input changes
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current)
      }
    }
  }, [input, sessionId])

  useEffect(() => {
    // Listen for scroll to show/hide scroll buttons
    const handleScroll = () => {
      const container = messagesContainerRef.current
      if (!container) return
      
      const scrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const clientHeight = container.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      
      // Show bottom button if more than 200px from bottom
      setShowScrollButton(distanceFromBottom > 200)
      
      // Show top button if scrolled down more than 200px
      setShowScrollTopButton(scrollTop > 200)
      
      // Update auto-scroll flag: if user scrolls up more than 200px, disable auto-scroll
      shouldAutoScrollRef.current = distanceFromBottom < 200
    }
    
    const container = messagesContainerRef.current
    if (container) {
      container.addEventListener('scroll', handleScroll)
      return () => container.removeEventListener('scroll', handleScroll)
    }
  }, [])

  const scrollToBottom = () => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }

  const scrollToTop = () => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = 0
    }
  }

  const toggleDiffView = () => {
    const newMode = diffViewMode === 'unified' ? 'split' : 'unified'
    setDiffViewMode(newMode)
    localStorage.setItem('diffViewMode', newMode)
  }

  const isSystemLikeMessage = (msg: Message) => (
    msg.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
    msg.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
  )

  const renderInlineMetaPart = (systemText: string, key: string, isUser: boolean) => (
    <pre
      key={key}
      className={`whitespace-pre-wrap font-sans ${isUser ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}
      style={{ fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }}
    >
      {systemText.split('\n').map((line, lineIdx) => (
        <span key={lineIdx} style={{ display: 'block' }}>{renderSystemTextWithSessionLinks(line)}</span>
      ))}
    </pre>
  )

  const renderSystemLikeMessage = (msg: Message, messageKey: string) => {
    const isExpanded = expandedSystemMessages.has(messageKey)
    const allLines = msg.parts.flatMap((part) => {
      if (part.system) {
        return formatStructuredSystemText(part.system).split('\n')
      }
      if (part.text) {
        return part.text.split('\n')
      }
      return []
    })

    const renderedText = allLines.join('\n')
    const shouldCollapse = !isExpanded

    return (
      <div className="w-full max-w-[80%] overflow-x-hidden">
        <div className="bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-700 dark:text-slate-300">
          <div
            className={shouldCollapse ? 'overflow-hidden' : ''}
            style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : undefined}
          >
            <pre className="whitespace-pre-wrap font-sans text-sm" style={{ lineHeight: '1.5em' }}>
              {renderedText.split('\n').map((line, lineIdx) => {
                const isPrefix = isSystemLikeText(line)
                return (
                  <span
                    key={lineIdx}
                    style={isPrefix
                      ? { display: 'block', fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }
                      : { display: 'block', opacity: 0.92 }
                    }
                  >
                    {renderSystemTextWithSessionLinks(line)}
                  </span>
                )
              })}
            </pre>
          </div>
          {allLines.length > 4 && (
            <button
              onClick={() => {
                const newExpanded = new Set(expandedSystemMessages)
                if (isExpanded) {
                  newExpanded.delete(messageKey)
                } else {
                  newExpanded.add(messageKey)
                }
                setExpandedSystemMessages(newExpanded)
              }}
              className="text-xs mt-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 text-left"
            >
              {isExpanded ? '▲ Show less' : '▼ Show more'}
            </button>
          )}
        </div>
        {renderImages(msg, messageKey)}
      </div>
    )
  }

  const renderDiff = (oldText: string, newText: string, diffIndex: number) => {
    const lineChanges = Diff.diffLines(oldText, newText)
    
    
    const handleOldScroll = (e: React.UIEvent<HTMLDivElement>) => {
      if (diffLastScrollSide.current === 'new') return
      diffLastScrollSide.current = 'old'
      const oldDiv = e.currentTarget
      const newDiv = diffNewScrollRefs.current.get(diffIndex)
      if (newDiv) {
        newDiv.scrollLeft = oldDiv.scrollLeft
        newDiv.scrollTop = oldDiv.scrollTop
      }
      // Reset after a short delay
      setTimeout(() => {
        diffLastScrollSide.current = null
      }, 50)
    }
    
    const handleNewScroll = (e: React.UIEvent<HTMLDivElement>) => {
      if (diffLastScrollSide.current === 'old') return
      diffLastScrollSide.current = 'new'
      const newDiv = e.currentTarget
      const oldDiv = diffOldScrollRefs.current.get(diffIndex)
      if (oldDiv) {
        oldDiv.scrollLeft = newDiv.scrollLeft
        oldDiv.scrollTop = newDiv.scrollTop
      }
      // Reset after a short delay
      setTimeout(() => {
        diffLastScrollSide.current = null
      }, 50)
    }
    
    if (diffViewMode === 'unified') {
      // Unified view with inline character-level diff
      const elements: React.ReactNode[] = []
      let i = 0
      
      while (i < lineChanges.length) {
        const change = lineChanges[i]
        
        if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
          // Pair of removed + added lines - show character-level diff
          const removed = change.value
          const added = lineChanges[i + 1].value
          const charDiff = Diff.diffWords(removed, added)
          
          elements.push(
            <div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2">
              {charDiff.map((part, j) => {
                if (part.removed) {
                  return (
                    <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">
                      {part.value}
                    </span>
                  )
                } else if (!part.added) {
                  return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                }
                return null
              })}
            </div>
          )
          
          elements.push(
            <div key={i + 1} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
              {charDiff.map((part, j) => {
                if (part.added) {
                  return (
                    <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">
                      {part.value}
                    </span>
                  )
                } else if (!part.removed) {
                  return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                }
                return null
              })}
            </div>
          )
          
          i += 2
        } else if (change.removed) {
          elements.push(
            <div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        } else if (change.added) {
          elements.push(
            <div key={i} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        } else {
          elements.push(
            <div key={i} className="pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        }
      }
      
      return (
        <div className="font-mono text-xs bg-gray-50 dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 whitespace-pre-wrap break-all cursor-text">
          {elements}
        </div>
      )
    } else {
      // Split view with inline character-level diff and aligned padding
      const oldElements: React.ReactNode[] = []
      const newElements: React.ReactNode[] = []
      let i = 0
      
      while (i < lineChanges.length) {
        const change = lineChanges[i]
        
        if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
          // Pair of removed + added lines
          const removed = change.value
          const added = lineChanges[i + 1].value
          // Split into individual lines
          const removedLinesSplit = removed.split('\n')
          const addedLinesSplit = added.split('\n')
          const removedLines = removed.endsWith('\n') ? removedLinesSplit.slice(0, -1) : removedLinesSplit
          const addedLines = added.endsWith('\n') ? addedLinesSplit.slice(0, -1) : addedLinesSplit
          
          
          const maxLines = Math.max(removedLines.length, addedLines.length)
          
          // Render each line with character-level diff
          for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
            const removedLine = removedLines[lineIdx]
            const addedLine = addedLines[lineIdx]
            
            if (removedLine !== undefined && addedLine !== undefined) {
              // Both sides have content - show char diff
              const charDiff = Diff.diffWords(removedLine, addedLine)
              
              oldElements.push(
                <div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 block">
                  {charDiff.map((part, j) => {
                    if (part.removed) {
                      return (
                        <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">
                          {part.value}
                        </span>
                      )
                    } else if (!part.added) {
                      return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                    }
                    return null
                  })}
                </div>
              )
              
              newElements.push(
                <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 block">
                  {charDiff.map((part, j) => {
                    if (part.added) {
                      return (
                        <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">
                          {part.value}
                        </span>
                      )
                    } else if (!part.removed) {
                      return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                    }
                    return null
                  })}
                </div>
              )
            } else if (removedLine !== undefined) {
              // Only removed line - add padding on new side
              oldElements.push(
                <div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">
                  {removedLine || '\u00A0'}
                </div>
              )
              newElements.push(
                <div key={`${i}-new-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
              )
            } else if (addedLine !== undefined) {
              // Only added line - add padding on old side
              oldElements.push(
                <div key={`${i}-old-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
              )
              newElements.push(
                <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">
                  {addedLine || '\u00A0'}
                </div>
              )
            }
          }
          
          i += 2
        } else if (change.removed) {
          
          // Split into individual lines for proper rendering
          const lines = change.value.split('\n')
          const actualLines = change.value.endsWith('\n') ? lines.slice(0, -1) : lines
          
          
          actualLines.forEach((line, lineIdx) => {
            oldElements.push(
              <div key={`${i}-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">
                {line || '\u00A0'}
              </div>
            )
            // Add padding line on the new side for each removed line
            newElements.push(
              <div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
            )
          })
          
          i++
        } else if (change.added) {
          
          // Split into individual lines for proper rendering
          const lines = change.value.split('\n')
          const actualLines = change.value.endsWith('\n') ? lines.slice(0, -1) : lines
          
          
          actualLines.forEach((line, lineIdx) => {
            // Add padding line on the old side for each added line
            oldElements.push(
              <div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
            )
            newElements.push(
              <div key={`${i}-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">
                {line || '\u00A0'}
              </div>
            )
          })
          
          i++
        } else {
          oldElements.push(
            <div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>
          )
          newElements.push(
            <div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>
          )
          i++
        }
      }
      
      return (
        <div className="font-mono text-xs border border-gray-300 dark:border-gray-600 rounded overflow-hidden cursor-text">
          <div className="grid grid-cols-2">
            <div className="bg-gray-50 dark:bg-gray-900">
              <div className="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">- Old</div>
              <div 
                ref={(el) => el && diffOldScrollRefs.current.set(diffIndex, el)} 
                onScroll={handleOldScroll} 
                className="p-2 whitespace-pre overflow-auto max-h-[80vh]"
              >
                <div className="inline-block min-w-full">
                  {oldElements}
                </div>
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 border-l border-gray-300 dark:border-gray-600">
              <div className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">+ New</div>
              <div 
                ref={(el) => el && diffNewScrollRefs.current.set(diffIndex, el)} 
                onScroll={handleNewScroll} 
                className="p-2 whitespace-pre overflow-auto max-h-[80vh]"
              >
                <div className="inline-block min-w-full">
                  {newElements}
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }
  }

  const connectSSE = () => {
    // Clear any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Clear countdown interval
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }

    setConnectionState('connecting')
    console.log('Connecting to SSE...')

    const es = new EventSource(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/stream`)
    
    es.onopen = () => {
      console.log('SSE connected')
      setConnectionState('connected')
      // Reset reconnect delay on successful connection
      reconnectDelayRef.current = 1000
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('SSE message received:', data)
        if (data.type === 'message') {
          const msgTimestamp = data.message.__meta?.timestamp
          const isCommandResponse = data.message.__meta?.isCommandResponse
          
          // Skip timestamp check for command responses (they are temporary and always fresh)
          if (!isCommandResponse) {
            // Skip if message is older than or equal to last known timestamp
            if (msgTimestamp && msgTimestamp <= lastKnownTimestampRef.current) {
              console.log('Message is old or duplicate, skipping:', msgTimestamp, '<=', lastKnownTimestampRef.current)
              return
            }
          }
          
          setMessages(prev => {
            // Double check if message already exists (skip for command responses)
            if (msgTimestamp && !isCommandResponse) {
              const exists = prev.some(m => 
                m.__meta?.timestamp === msgTimestamp
              )
              if (exists) {
                console.log('Message already exists in state, skipping')
                return prev
              }
            }
            
            // Check for duplicate user messages (deduplication)
            if (data.message.role === 'user') {
              const newMessageText = data.message.parts
                .map((p: MessagePart) => p.text || '')
                .join('')
                .trim()
              
              // Check if this matches any pending sent message
              const pendingIndex = pendingSentMessagesRef.current.findIndex(pending => 
                newMessageText.includes(pending) || pending.includes(newMessageText)
              )
              
              if (pendingIndex !== -1) {
                // Remove from pending list
                pendingSentMessagesRef.current.splice(pendingIndex, 1)
                
                // Remove the last user message (local fake one) and add the real one
                const filtered = prev.filter((m) => {
                  // Keep all non-user messages
                  if (m.role !== 'user') return true
                  // Keep user messages except the last one
                  const userMessages = prev.filter(msg => msg.role === 'user')
                  const isLastUser = m === userMessages[userMessages.length - 1]
                  return !isLastUser
                })
                
                // Update last known timestamp
                if (msgTimestamp && !isCommandResponse) {
                  lastKnownTimestampRef.current = msgTimestamp
                }
                
                return [...filtered, data.message]
              }
            }
            
            console.log('Adding new message to state')
            // Update last known timestamp (skip for command responses)
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
    
    es.onerror = (err) => {
      console.error('SSE error:', err)
      es.close()
      
      // Check if we should reconnect
      if (es.readyState === EventSource.CLOSED) {
        setConnectionState('reconnecting')
        
        // Calculate next delay (exponential backoff, max 30s)
        const delay = Math.min(reconnectDelayRef.current, 30000)
        console.log(`Reconnecting in ${delay}ms...`)
        
        // Set countdown
        setReconnectCountdown(Math.ceil(delay / 1000))
        
        // Update countdown every second
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
        
        // Schedule reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          // Refresh history before reconnecting
          fetchHistory().then(() => {
            connectSSE()
          })
          
          // Increase delay for next time (exponential backoff)
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
        }, delay)
      }
    }
    
    eventSourceRef.current = es
  }

  useEffect(() => {
    // Load history when entering session
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
  }, [sessionId])

  useEffect(() => {
    // Poll session busy status every 2 seconds
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

    fetchBusyStatus() // Initial fetch
    const interval = setInterval(fetchBusyStatus, 2000)

    return () => clearInterval(interval)
  }, [sessionId])

  useEffect(() => {
    // Scroll to bottom when entering a new session (after messages are loaded)
    if (messages.length > 0) {
      // Immediate scroll for better perceived speed
      scrollToBottom()
      // Delay to ensure all components are fully rendered
      setTimeout(() => {
        scrollToBottom()
      }, 100)
    }
  }, [sessionId, messages.length > 0])

  useEffect(() => {
    // Auto-scroll if flag is set (user was at bottom)
    if (shouldAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [messages])

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history`)
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages || [])
        // Update last known timestamp
        const lastMsg = data.messages?.[data.messages.length - 1]
        if (lastMsg?.__meta?.timestamp) {
          lastKnownTimestampRef.current = lastMsg.__meta.timestamp
        }
      }
    } catch (e) {
      console.error('Failed to fetch history:', e)
    }
  }

  const applySlashCommand = (command: SlashCommandOption) => {
    const nextValue = `${command.name} `
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
  }

  const sendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if ((!input.trim() && attachments.length === 0) || loading) return

    const userMessage = input.trim()
    const files = [...attachments]
    setInput('')
    setAttachments([])
    setLoading(true)
    setDismissedSlashQuery(null)

    // Clear draft from localStorage after sending
    const draftKey = `draft_${sessionId}`
    localStorage.removeItem(draftKey)

    // Reset textarea height after the controlled input clears
    requestAnimationFrame(() => {
      resizeTextarea(textareaRef.current)
      textareaRef.current?.focus()
    })

    // Record current timestamp before sending
    const sendTimestamp = Date.now()
    lastKnownTimestampRef.current = sendTimestamp

    // Prepare message parts
    const parts: any[] = []
    let messageText = userMessage
    const filePaths: string[] = []
    
    // Upload files first
    for (const file of files) {
      try {
        const formData = new FormData()
        formData.append('file', file)
        
        const uploadRes = await fetch(`${API_BASE_PATH}/upload`, {
          method: 'POST',
          body: formData
        })
        
        if (!uploadRes.ok) {
          throw new Error('Upload failed')
        }
        
        const { path: filePath } = await uploadRes.json()
        filePaths.push(filePath)
        
        // Add file reference to message text
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

    // Record sent message text for deduplication
    pendingSentMessagesRef.current.push(userMessage.trim())

    // Add user message immediately
    setMessages(prev => [...prev, { role: 'user', parts }])

    try {
      // Send message without waiting for response (SSE will handle updates)
      fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ parts, filePaths })
      }).catch(e => {
        console.error('Failed to send message:', e)
        setMessages(prev => [...prev, { role: 'model', parts: [{ text: 'Error: Failed to send message' }] }])
      })
      
      // Immediately allow next message
      setLoading(false)
    } catch (e) {
      console.error('Failed to send message:', e)
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        sendMessage()
      }
      return
    }

    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value
    setInput(nextValue)
    setDismissedSlashQuery(null)
    resizeTextarea(e.target)
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Check for images in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault() // Prevent default paste behavior for images
        
        const file = item.getAsFile()
        if (file) {
          // Add to attachments
          setAttachments(prev => [...prev, file])
        }
      }
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setAttachments(prev => [...prev, ...files])
    }
  }

  const renderImageParts = (imageParts: MessagePart[], keyPrefix: string) => {
    if (imageParts.length === 0) return null

    return (
      <div className="flex flex-wrap gap-2 mt-2">
        {imageParts.map((part, idx) => {
          const { data, mimeType } = part.inlineData!
          const src = `data:${mimeType};base64,${data}`
          return (
            <div key={`${keyPrefix}-${idx}`} className="relative group cursor-pointer" onClick={() => window.open(src, '_blank')}>
              <img
                src={src}
                alt={`Image ${idx + 1}`}
                className="max-w-[300px] max-h-[200px] rounded-lg border border-gray-200 dark:border-gray-600 hover:opacity-90 transition"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition rounded-lg pointer-events-none" />
            </div>
          )
        })}
      </div>
    )
  }

  // Render inline images from message parts
  const renderImages = (msg: Message, keyPrefix: string) => {
    const imageParts = msg.parts.filter(p => p.inlineData)
    return renderImageParts(imageParts, keyPrefix)
  }

  type ToolCallRendererParams = {
    call: FunctionCall
    isExpanded: boolean
    viewMode: ToolViewMode
    callIdx: number
  }

  type ToolResponseRendererParams = {
    resp: FunctionResponse
    isExpanded: boolean
  }

  const renderInlineToolSummary = (name: string, summary: React.ReactNode, summaryClassName = 'text-gray-700 dark:text-gray-200') => (
    <div className="flex items-center gap-2 min-w-0">
      <ToolLabel name={name} />
      <div className={`min-w-0 flex-1 ${summaryClassName}`}>
        {summary}
      </div>
    </div>
  )

  const defaultToolCallRenderer = ({ call, isExpanded }: ToolCallRendererParams) => {
    const argsFormatted = formatObject(call.args)
    const preview = argsFormatted.length > 200 ? argsFormatted.substring(0, 200) + '...' : argsFormatted
    return {
      content: (
        <div className="space-y-1">
          {isExpanded
            ? (
              <>
                <ToolLabel name={call.name} />
                <div className="whitespace-pre-wrap break-all">{argsFormatted}</div>
              </>
            )
            : renderInlineToolSummary(
              call.name,
              <div className="truncate break-all">{preview}</div>
            )}
        </div>
      )
    }
  }

  const formatToolResponseText = (resp: FunctionResponse): string => {
    if (resp.response?.error !== undefined && resp.response?.error !== null) {
      return typeof resp.response.error === 'string' ? resp.response.error : JSON.stringify(resp.response.error, null, 2)
    }
    if (resp.response?.output !== undefined && resp.response?.output !== null) {
      return typeof resp.response.output === 'string' ? resp.response.output : JSON.stringify(resp.response.output, null, 2)
    }
    if (resp.response?.content !== undefined && resp.response?.content !== null) {
      return typeof resp.response.content === 'string' ? resp.response.content : JSON.stringify(resp.response.content, null, 2)
    }
    return formatObject(resp.response)
  }

  const getToolResponseStatus = (resp: FunctionResponse): 'success' | 'error' => {
    if (resp.response?.error !== undefined && resp.response?.error !== null) {
      return 'error'
    }
    if (resp.name === 'edit') {
      return resp.response?.output === 'File edited successfully' ? 'success' : 'error'
    }
    return 'success'
  }

  const defaultToolResponseRenderer = ({ resp, isExpanded }: ToolResponseRendererParams) => {
    const respFormatted = formatToolResponseText(resp)
    const preview = respFormatted.length > 400 ? respFormatted.substring(0, 400) + '...' : respFormatted
    return { content: <div className="whitespace-pre-wrap break-all cursor-text">{isExpanded ? respFormatted : preview}</div> }
  }


  const toolCallRenderers: Record<string, (params: ToolCallRendererParams) => { content: React.ReactNode }> = {
    read: ({ call, isExpanded }) => {
      const extra = (call.args.startLine || call.args.endLine)
        ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
        : ''
      return {
        content: (
          isExpanded ? (
            <div className="space-y-1">
              {renderInlineToolSummary(
                call.name,
                <div className="whitespace-pre-wrap break-all">
                  <span>{call.args.filePath}</span>
                  {extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}
                </div>
              )}
            </div>
          ) : renderInlineToolSummary(
            call.name,
            <div className="truncate" title={`${call.args.filePath}${extra}`}>
              <span>{call.args.filePath}</span>
              {extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}
            </div>
          )
        )
      }
    },
    write: ({ call, isExpanded }) => {
      return {
        content: (
          <div className="space-y-1">
            {renderInlineToolSummary(
              call.name,
              isExpanded
                ? <div className="whitespace-pre-wrap break-all">{call.args.filePath}</div>
                : <div className="truncate" title={call.args.filePath}>{call.args.filePath}</div>
            )}
            {isExpanded && call.args.content && (
              <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
                {call.args.content}
              </pre>
            )}
          </div>
        )
      }
    },
    edit: ({ call, isExpanded, callIdx }) => {
      const hasLegacyDiff = typeof call.args.oldText === 'string' && typeof call.args.newText === 'string'
      const oldLines = hasLegacyDiff ? call.args.oldText.split('\n').length - (call.args.oldText.endsWith('\n') ? 1 : 0) : 0
      const newLines = hasLegacyDiff ? call.args.newText.split('\n').length - (call.args.newText.endsWith('\n') ? 1 : 0) : 0

      const stats = hasLegacyDiff ? (
        <span className="text-xs">
          <span className="text-orange-600 dark:text-orange-400">-{oldLines}</span>
          <span className="mx-1 text-gray-500">/</span>
          <span className="text-blue-600 dark:text-blue-400">+{newLines}</span>
        </span>
      ) : (
        <span className="text-xs text-gray-500">legacy payload unavailable</span>
      )
      const path = <span className="text-gray-600 dark:text-gray-400">{call.args.filePath}</span>

      return {
        content: (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 flex-wrap">
                <ToolLabel name={call.name} />
                {stats}
                {path}
              </span>
            </div>
            {isExpanded && (
              <div>
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  {hasLegacyDiff ? (
                    renderDiff(call.args.oldText, call.args.newText, callIdx)
                  ) : (
                    <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
                      {JSON.stringify(call.args, null, 2)}
                    </pre>
                  )}
                </div>
                <div className="mt-2 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedTool(null)
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    Collapse ▲
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }
    },
    apply_patch: ({ call, isExpanded, callIdx }) => {
      try {
        const operations = parseApplyPatchPreview(call.args.input)
        const totalHunks = operations.reduce((sum, operation) => sum + (operation.action === 'update' ? operation.hunks.length : 0), 0)
        const fileSummary = operations.length === 1
          ? operations[0].filePath
          : `${operations[0].filePath} +${operations.length - 1} more`

        return {
          content: (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 flex-wrap">
                  <ToolLabel name={call.name} />
                  <span className="ml-2 text-xs text-gray-500">{operations.length} op{operations.length > 1 ? 's' : ''}{totalHunks > 0 ? ` • ${totalHunks} hunk${totalHunks > 1 ? 's' : ''}` : ''}</span>
                  <span className="ml-2 text-gray-600 dark:text-gray-400">{fileSummary}</span>
                </span>
              </div>
              {isExpanded && (
                <div className="mt-2 space-y-4" onClick={(e) => e.stopPropagation()}>
                  {operations.map((operation, operationIdx) => {
                    if (operation.action === 'update') {
                      return (
                        <div key={operationIdx} className="space-y-3">
                          <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">Update {operation.filePath}</div>
                          {operation.hunks.map((hunk, hunkIdx) => {
                            const snippets = buildPatchHunkSnippets(hunk)
                            const diffKey = callIdx * 1000 + operationIdx * 100 + hunkIdx
                            return (
                              <div key={hunkIdx} className="space-y-1">
                                {hunk.anchors.length > 0 && (
                                  <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                    {hunk.anchors.map((anchor, anchorIdx) => (
                                      <div key={anchorIdx}>@@ {anchor}</div>
                                    ))}
                                  </div>
                                )}
                                {renderDiff(snippets.oldText, snippets.newText, diffKey)}
                              </div>
                            )
                          })}
                        </div>
                      )
                    }

                    if (operation.action === 'add') {
                      const diffKey = callIdx * 1000 + operationIdx * 100
                      return (
                        <div key={operationIdx} className="space-y-1">
                          <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Add {operation.filePath}</div>
                          {renderDiff('', operation.lines.join('\n'), diffKey)}
                        </div>
                      )
                    }

                    return (
                      <div key={operationIdx} className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        Delete {operation.filePath}
                      </div>
                    )
                  })}
                  <div className="mt-2 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedTool(null)
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      Collapse ▲
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        return {
          content: (
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <ToolLabel name={call.name} />
                <span className="text-xs text-red-500">invalid patch</span>
              </div>
              {isExpanded && (
                <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
                  {error}\n\n{call.args.input || JSON.stringify(call.args, null, 2)}
                </pre>
              )}
            </div>
          )
        }
      }
    },
    exec: ({ call, isExpanded }) => {
      const preview = call.args.command.length > 200 ? call.args.command.substring(0, 200) + '...' : call.args.command
      return {
        content: (
          <div className="space-y-1">
            {isExpanded
              ? (
                <>
                  <ToolLabel name={call.name} />
                  <div className="break-all">{call.args.command}</div>
                </>
              )
              : renderInlineToolSummary(
                call.name,
                <div className="truncate font-mono" title={call.args.command}>{preview}</div>
              )}
          </div>
        )
      }
    },
    send_to_session: ({ call, isExpanded }) => {
      const targetSessionId = String(call.args.sessionId || '')
      const message = typeof call.args.message === 'string'
        ? call.args.message
        : formatObject(call.args.message)
      const preview = message.length > 200 ? `${message.slice(0, 200)}...` : message

      return {
        content: (
          <div className="space-y-1">
            {isExpanded
              ? (
                <>
                  {renderInlineToolSummary(
                    call.name,
                    <div className="whitespace-pre-wrap break-all">
                      <SessionHashLink sessionId={targetSessionId} />
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-all">{message}</div>
                </>
              )
              : renderInlineToolSummary(
                call.name,
                <div className="truncate" title={`${targetSessionId}: ${message}`}>
                  <SessionHashLink sessionId={targetSessionId} />
                  <span>: {preview}</span>
                </div>
              )}
          </div>
        )
      }
    }
  }

  const toolResponseRenderers: Record<string, (params: ToolResponseRendererParams) => { content: React.ReactNode | null }> = {
    read: ({ resp, isExpanded }) => {
      const fileContent = resp.response.content || resp.response.output || JSON.stringify(resp.response)
      return {
        content: isExpanded ? (
          <pre className="whitespace-pre-wrap text-xs overflow-x-auto cursor-text">
            {fileContent}
          </pre>
        ) : null
      }
    },
    write: () => ({ content: null }),
    edit: ({ resp, isExpanded }) => {
      if (getToolResponseStatus(resp) === 'success') {
        return { content: null }
      }

      const raw = formatToolResponseText(resp)
      const preview = raw.length > 400 ? raw.substring(0, 400) + '...' : raw
      return {
        content: (
          <pre className="whitespace-pre-wrap break-all cursor-text text-red-700 dark:text-red-300">
            {isExpanded ? raw : preview}
          </pre>
        )
      }
    },
    exec: ({ resp, isExpanded }) => {
      const output = resp.response.output || ''
      const preview = output.length > 400 ? output.substring(0, 400) + '...' : output
      const displayStr = isExpanded ? output : preview
      return {
        content: (
          <div className="whitespace-pre-wrap break-all cursor-text">
            {parseAnsi(displayStr)}
          </div>
        )
      }
    }
  }

  const getToolGroupMessages = (idx: number) => {
    const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
    const functionCalls = messages[idx].parts.filter(p => p.functionCall).map(p => p.functionCall!)
    const functionResponses = nextMsg?.role === 'tool'
      ? nextMsg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!)
      : []

    return {
      nextMsg,
      functionCalls,
      functionResponses,
      hasFollowingToolMsg: nextMsg?.role === 'tool' && functionResponses.length > 0,
    }
  }

  const isToolMessageHandledByPreviousGroup = (idx: number) => {
    const msg = messages[idx]
    if (msg.role !== 'tool' || idx === 0) return false

    const prevMsg = messages[idx - 1]
    return prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)
  }

  const renderToolCallItem = (
    call: FunctionCall,
    idx: number,
    callIdx: number,
    options: { hasFollowingContent: boolean }
  ) => {
    const toolKey = `${idx}-call-${callIdx}`
    const isExpanded = expandedTool === toolKey
    const viewMode = toolViewModes.get(toolKey) || 'default'

    let content: React.ReactNode
    if (viewMode === 'json') {
      content = (
        <pre className="whitespace-pre-wrap break-all cursor-text text-gray-600 dark:text-gray-300">
          {JSON.stringify(call, null, 2)}
        </pre>
      )
    } else {
      const renderer = toolCallRenderers[call.name] || defaultToolCallRenderer
      content = renderer({ call, isExpanded, viewMode, callIdx }).content
    }

    const roundedClass = callIdx === 0 ? 'rounded-t' : ''
    const borderClass = options.hasFollowingContent ? 'border-b-0' : ''

    return (
      <div key={toolKey} className={`text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${roundedClass} p-2 ${borderClass} relative group`}>
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {call.name === 'edit' || call.name === 'apply_patch' ? (
            <>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  if (diffViewMode !== 'unified') toggleDiffView()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode !== 'json' && diffViewMode === 'unified'}
                title="Unified"
              >
                Unified
              </MiniToggleButton>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  if (diffViewMode !== 'split') toggleDiffView()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode !== 'json' && diffViewMode === 'split'}
                title="Split"
              >
                Split
              </MiniToggleButton>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'json')
                }}
                active={viewMode === 'json'}
                title="JSON"
              >
                JSON
              </MiniToggleButton>
            </>
          ) : (
            <>
              <IconToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode === 'default'}
                title="Default"
              >
                <Eye size={12} />
              </IconToggleButton>
              <IconToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'json')
                }}
                active={viewMode === 'json'}
                title="JSON"
              >
                <FileJson size={14} />
              </IconToggleButton>
            </>
          )}
        </div>
        <div
          className="font-mono text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
          onClick={() => setExpandedTool(isExpanded ? null : toolKey)}
        >
          <div style={isExpanded ? undefined : clampContentStyle(1, 0.25)}>
            {content}
          </div>
        </div>
      </div>
    )
  }

  const renderToolResponseItem = (
    resp: FunctionResponse,
    idx: number,
    respIdx: number,
    options: { hasPrecedingCall: boolean; isLast: boolean }
  ) => {
    const toolKey = `${idx}-resp-${respIdx}`
    const isExpanded = expandedTool === toolKey
    const viewMode = toolViewModes.get(toolKey) || 'default'
    const responseStatus = getToolResponseStatus(resp)
    const isError = responseStatus === 'error'

    let content: React.ReactNode | null
    if (viewMode === 'json') {
      content = (
        <pre className="whitespace-pre-wrap break-all cursor-text text-green-700 dark:text-green-300">
          {JSON.stringify(resp, null, 2)}
        </pre>
      )
    } else {
      const renderer = toolResponseRenderers[resp.name] || defaultToolResponseRenderer
      content = renderer({ resp, isExpanded }).content
    }

    const roundedClass = options.hasPrecedingCall ? '' : 'rounded-t'
    const roundedBottomClass = options.isLast ? 'rounded-b' : ''
    const borderClass = options.isLast ? '' : 'border-b-0'

    return (
      <div key={toolKey} className={`text-xs ${isError ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'} border ${roundedClass} ${roundedBottomClass} p-2 ${borderClass} relative group`}>
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconToggleButton
            onClick={(e) => {
              e.stopPropagation()
              setToolView(toolKey, 'default')
            }}
            active={viewMode === 'default'}
            title="Default"
          >
            <Eye size={12} />
          </IconToggleButton>
          <IconToggleButton
            onClick={(e) => {
              e.stopPropagation()
              setToolView(toolKey, 'json')
            }}
            active={viewMode === 'json'}
            title="JSON"
          >
            <FileJson size={14} />
          </IconToggleButton>
        </div>
        <div
          className={`font-mono cursor-pointer ${isError ? 'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300' : 'text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300'}`}
          onClick={() => setExpandedTool(isExpanded ? null : toolKey)}
        >
          <span className="inline-flex items-center gap-1.5">
            {isError ? <X size={12} /> : <Check size={12} />}
            <span>{resp.name}</span>
          </span>
        </div>
        {content && (
          <div
            className={`font-mono mt-1 ${isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
            style={isExpanded ? undefined : clampContentStyle(3)}
          >
            {content}
          </div>
        )}
      </div>
    )
  }

  const renderInterleavedToolGroup = (idx: number) => {
    const { nextMsg, functionCalls, functionResponses, hasFollowingToolMsg } = getToolGroupMessages(idx)
    if (!hasFollowingToolMsg || !nextMsg) return null

    const responseEntriesById = new Map<string, Array<{ resp: FunctionResponse; respIdx: number }>>()
    const unmatchedResponses: Array<{ resp: FunctionResponse; respIdx: number }> = []

    functionResponses.forEach((resp, respIdx) => {
      const toolId = resp.tool_use_id
      if (!toolId) {
        unmatchedResponses.push({ resp, respIdx })
        return
      }
      const entries = responseEntriesById.get(toolId) || []
      entries.push({ resp, respIdx })
      responseEntriesById.set(toolId, entries)
    })

    const imageEntriesById = new Map<string, MessagePart[]>()
    const unmatchedImageParts: MessagePart[] = []

    nextMsg.parts.filter(p => p.inlineData).forEach(part => {
      if (part.toolUseId) {
        const entries = imageEntriesById.get(part.toolUseId) || []
        entries.push(part)
        imageEntriesById.set(part.toolUseId, entries)
      } else {
        unmatchedImageParts.push(part)
      }
    })

    const renderedResponseIndexes = new Set<number>()

    return (
      <div>
        {functionCalls.map((call, callIdx) => {
          const toolId = call.id
          const responseEntries = toolId ? (responseEntriesById.get(toolId) || []) : []
          const imageParts = toolId ? (imageEntriesById.get(toolId) || []) : []
          const hasFollowingContent = responseEntries.length > 0 || imageParts.length > 0

          responseEntries.forEach(({ respIdx }) => renderedResponseIndexes.add(respIdx))

          return (
            <div key={`${idx}-group-${toolId || callIdx}`}>
              {renderToolCallItem(call, idx, callIdx, { hasFollowingContent })}
              {responseEntries.map(({ resp, respIdx }, entryIdx) =>
                renderToolResponseItem(resp, idx + 1, respIdx, {
                  hasPrecedingCall: true,
                  isLast: entryIdx === responseEntries.length - 1 && imageParts.length === 0,
                })
              )}
              {imageParts.length > 0 && (
                <div className="rounded-b border border-t-0 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2">
                  {renderImageParts(imageParts, `${idx + 1}-tool-image-${toolId || callIdx}`)}
                </div>
              )}
            </div>
          )
        })}
        {unmatchedResponses
          .filter(({ respIdx }) => !renderedResponseIndexes.has(respIdx))
          .map(({ resp, respIdx }, orphanIdx) =>
            renderToolResponseItem(resp, idx + 1, respIdx, {
              hasPrecedingCall: false,
              isLast: orphanIdx === unmatchedResponses.length - 1 && unmatchedImageParts.length === 0,
            })
          )}
        {Array.from(imageEntriesById.entries())
          .filter(([toolId]) => !functionCalls.some(call => call.id === toolId))
          .map(([toolId, imageParts], orphanIdx, orphaned) => (
            <div
              key={`${idx + 1}-orphan-matched-tool-image-${toolId}`}
              className={`border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2 ${orphanIdx === orphaned.length - 1 && unmatchedImageParts.length === 0 ? 'rounded-b' : ''}`}
            >
              {renderImageParts(imageParts, `${idx + 1}-orphan-matched-tool-image-${toolId}`)}
            </div>
          ))}
        {unmatchedImageParts.length > 0 && (
          <div className="rounded-b border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2">
            {renderImageParts(unmatchedImageParts, `${idx + 1}-orphan-tool-image`)}
          </div>
        )}
      </div>
    )
  }

  const renderToolCalls = (msg: Message, idx: number) => {
    const functionCalls = msg.parts.filter(p => p.functionCall).map(p => p.functionCall!)
    if (functionCalls.length === 0) return null

    // Check if next message is a tool response
    const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
    const hasFollowingToolMsg = nextMsg?.role === 'tool'

    return (
      <div>
        {functionCalls.map((call, callIdx) => renderToolCallItem(call, idx, callIdx, {
          hasFollowingContent: callIdx < functionCalls.length - 1 || hasFollowingToolMsg,
        }))}
      </div>
    )
  }

  const renderToolGroupSummary = (idx: number) => {
    const toolNames = getToolGroupNames(getToolGroupStartIdx(idx))
    if (toolNames.length === 0) return null

    return (
      <div
        className="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
        onClick={() => setExpandedToolGroups(prev => new Set(prev).add(getToolGroupKey(idx)))}
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-gray-400 dark:text-gray-500 shrink-0">
            <Wrench size={12} />
          </span>
          <ToolTagList names={toolNames} />
        </div>
      </div>
    )
  }

  const renderToolResponses = (msg: Message, idx: number) => {
    const functionResponses = msg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!)
    if (functionResponses.length === 0) return null
    
    // Check if previous message is an assistant message with function calls
    const prevMsg = idx > 0 ? messages[idx - 1] : null
    const hasPrecedingCallMsg = prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)

    // If not verbose and not expanded, hide tool responses
    if (!verbose) {
      const groupKey = getToolGroupKey(idx)
      if (!expandedToolGroups.has(groupKey)) {
        return null
      }
    }

    return (
      <div>
        {functionResponses.map((resp, respIdx) => renderToolResponseItem(resp, idx, respIdx, {
          hasPrecedingCall: respIdx === 0 && hasPrecedingCallMsg,
          isLast: respIdx === functionResponses.length - 1,
        }))}
      </div>
    )
  }

  const renderSlashCommandMenu = () => {
    if (!showSlashCommandMenu) return null

    return (
      <div className="mb-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg overflow-hidden">
        <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
          <span>Slash commands</span>
          <span className="text-[11px]">↑↓ select · Enter/Tab apply · Esc dismiss</span>
        </div>
        <div ref={slashMenuRef} className="max-h-64 overflow-y-auto">
          {commandsLoading && (
            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">Loading commands...</div>
          )}
          {!commandsLoading && commandsError && slashCommandSuggestions.length === 0 && (
            <div className="px-3 py-2 text-sm text-red-600 dark:text-red-300">{commandsError}</div>
          )}
          {!commandsLoading && !commandsError && slashCommandSuggestions.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matching commands.</div>
          )}
          {slashCommandSuggestions.map((command, index) => {
            const isActive = index === highlightedCommandIndex
            return (
              <button
                key={command.name}
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
                  <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{command.name}</span>
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
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header - Fixed at top */}
      <div className="sticky top-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between">
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

      {/* Connection Status - Fixed below header */}
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

      {/* Messages - With padding to avoid header and footer */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4">
        {messages.map((msg, idx) => {
          if (isToolMessageHandledByPreviousGroup(idx)) {
            return null
          }

          const textLikeParts = msg.parts.filter(p => p.text || p.system)
          const systemLikeMessage = isSystemLikeMessage(msg)
          const interleavedToolGroup = renderInterleavedToolGroup(idx)
          
          // If current message is model/tool and previous message is also model/tool, stick them together
          const prevMsg = idx > 0 ? messages[idx - 1] : null
          const shouldSkipMargin = !systemLikeMessage && (msg.role === 'model' || msg.role === 'tool') &&
            (prevMsg?.role === 'model' || prevMsg?.role === 'tool')
          
          return (
            <div
              key={idx}
              className={`flex ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${shouldSkipMargin ? '' : 'mt-4'}`}
            >
              <div
                className={`${
                  systemLikeMessage
                    ? 'w-full max-w-[80%]'
                    : msg.role === 'user'
                      ? 'max-w-[80%]'
                      : isMobile
                        ? 'w-full'
                        : 'w-full max-w-[80%]'
                } ${
                  !systemLikeMessage && msg.role === 'user'
                    ? 'bg-blue-500 dark:bg-blue-600 text-white px-4 py-2 rounded-lg'
                    : ''
                } overflow-x-hidden`}
              >
                {systemLikeMessage ? renderSystemLikeMessage(msg, `msg-${idx}`) : msg.role === 'user' ? (
                  <div className="flex flex-col">
                    {textLikeParts.map((part, partIdx) => {
                      const messageKey = `${idx}-${partIdx}`

                      if (part.system) {
                        return renderInlineMetaPart(formatStructuredSystemText(part.system), messageKey, true)
                      }

                      const text = part.text || ''
                      const isSystemMessage = isCollapsibleSystemText(text)
                      const isExpanded = expandedSystemMessages.has(messageKey)
                      const shouldCollapse = isSystemMessage && !isExpanded

                      return (
                        <div key={partIdx}>
                          <div
                            className={`${shouldCollapse ? 'overflow-hidden' : ''}`}
                            style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}
                          >
                            <pre className="whitespace-pre-wrap font-sans" style={{ lineHeight: '1.5em' }}>
                              {text.split('\n').map((line, lineIdx) => {
                                const isPrefix = /^\[(SYSTEM|FROM):/.test(line)
                                return (
                                  <span
                                    key={lineIdx}
                                    style={isPrefix
                                      ? { display: 'block', fontSize: '70%', lineHeight: '1em', opacity: 0.7 }
                                      : { display: 'block' }
                                    }
                                  >
                                    {line}
                                  </span>
                                )
                              })}
                            </pre>
                          </div>
                          {isSystemMessage && (
                            <button
                              onClick={() => {
                                const newExpanded = new Set(expandedSystemMessages)
                                if (isExpanded) {
                                  newExpanded.delete(messageKey)
                                } else {
                                  newExpanded.add(messageKey)
                                }
                                setExpandedSystemMessages(newExpanded)
                              }}
                              className="text-xs text-blue-200 hover:text-white mt-1 text-left"
                            >
                              {isExpanded ? '▲ Show less' : '▼ Show more'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                    {renderImages(msg, `user-${idx}`)}
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {textLikeParts.map((part, partIdx) => {
                      const messageKey = `${idx}-${partIdx}`
                      if (part.system) {
                        return renderInlineMetaPart(formatStructuredSystemText(part.system), messageKey, false)
                      }

                      const text = part.text || ''
                      const viewMode = messageViewModes.get(idx) || 'rendered'
                      const paddingClass = viewMode === 'rendered' ? 'px-2' : 'px-2 py-2'
                      const copied = copiedMessageKey === messageKey

                      return (
                        <div key={partIdx} className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${paddingClass} rounded-lg cursor-text relative group`}>
                          {/* View mode toggle buttons - hidden by default, show on hover */}
                          <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <IconToggleButton
                              onClick={() => setMessageView(idx, 'rendered')}
                              active={viewMode === 'rendered'}
                              title="Rendered (Markdown)"
                            >
                              <Eye size={12} />
                            </IconToggleButton>
                            <IconToggleButton
                              onClick={() => setMessageView(idx, 'raw')}
                              active={viewMode === 'raw'}
                              title="Raw Text"
                            >
                              <Code size={12} />
                            </IconToggleButton>
                            <IconToggleButton
                              onClick={() => setMessageView(idx, 'json')}
                              active={viewMode === 'json'}
                              title="JSON"
                            >
                              <FileJson size={14} />
                            </IconToggleButton>
                            <IconToggleButton
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void handleCopyRawText(messageKey, text)
                              }}
                              active={copied}
                              title={copied ? 'Copied' : 'Copy Raw Text'}
                            >
                              {copied ? <Check size={12} /> : <Copy size={12} />}
                            </IconToggleButton>
                          </div>

                          {/* Content based on view mode */}
                          {viewMode === 'rendered' ? (
                            <div
                              className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100 prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
                            />
                          ) : viewMode === 'raw' ? (
                            <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 pr-32">{text}</pre>
                          ) : (
                            <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto pr-32">
                              {JSON.stringify(msg, null, 2)}
                            </pre>
                          )}
                        </div>
                      )
                    })}
                    {renderImages(msg, `message-${idx}`)}
                    {!verbose && shouldRenderToolGroupSummary(idx) && !expandedToolGroups.has(getToolGroupKey(idx)) && renderToolGroupSummary(idx)}
                    {!verbose && isInToolGroup(idx) && !expandedToolGroups.has(getToolGroupKey(idx)) ? null : (
                      interleavedToolGroup || renderToolCalls(msg, idx)
                    )}
                    {!verbose && isInToolGroup(idx) && !expandedToolGroups.has(getToolGroupKey(idx)) ? null : (
                      interleavedToolGroup ? null : renderToolResponses(msg, idx)
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {sessionBusy && !loading && (
          <div className="flex justify-start mt-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-2 rounded-lg">
              <div className="flex items-center space-x-2">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                  <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                </div>
                <span className="text-sm text-blue-600 dark:text-blue-300">Processing{sessionQueueLength > 0 ? ` • ${sessionQueueLength} queued` : ''}...</span>
              </div>
            </div>
          </div>
        )}
        {!sessionBusy && !loading && sessionQueueLength > 0 && (
          <div className="flex justify-start mt-4">
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 rounded-lg text-sm text-amber-700 dark:text-amber-300">
              {sessionQueueLength} queued message{sessionQueueLength > 1 ? 's' : ''} pending
            </div>
          </div>
        )}
        {loading && (
          <div className="flex justify-start mt-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-4 py-2 rounded-lg">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
              </div>
            </div>
          </div>
        )}
        {/* Bottom spacing */}
        <div className="h-32"></div>
        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to top button */}
      {showScrollTopButton && (
        <button
          onClick={scrollToTop}
          className="absolute right-6 top-24 z-10 w-12 h-12 bg-blue-500 dark:bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-600 dark:hover:bg-blue-700 transition-all flex items-center justify-center"
          aria-label="Scroll to top"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        </button>
      )}

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute right-6 bottom-24 z-10 w-12 h-12 bg-blue-500 dark:bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-600 dark:hover:bg-blue-700 transition-all flex items-center justify-center"
          aria-label="Scroll to bottom"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}

      {/* Input - Fixed at bottom */}
      <div 
        className={`sticky bottom-0 z-20 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-4 transition-colors ${
          isDragging ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400 dark:border-blue-500' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-blue-100/80 dark:bg-blue-900/40 pointer-events-none">
            <div className="inline-flex items-center gap-2 rounded-lg border border-blue-300 dark:border-blue-700 bg-white/90 dark:bg-gray-900/80 px-4 py-3 text-blue-700 dark:text-blue-200 text-base font-semibold shadow-sm">
              <Paperclip size={18} />
              <span>Drop files here to upload</span>
            </div>
          </div>
        )}
        
        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((file, idx) => (
              <div key={idx} className="relative inline-flex items-center gap-2 px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded text-sm">
                <span className="text-gray-700 dark:text-gray-300">{file.name}</span>
                <button
                  onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                  className="text-gray-500 hover:text-red-500"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {renderSlashCommandMenu()}
        
        <form onSubmit={sendMessage} className="flex space-x-2">
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
          <label
            htmlFor="file-upload"
            className="px-3 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 cursor-pointer transition self-end inline-flex items-center justify-center"
            title="Attach files"
            aria-label="Attach files"
          >
            <Paperclip size={16} />
          </label>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              // Save draft immediately on blur
              const draftKey = `draft_${sessionId}`
              if (input.trim()) {
                localStorage.setItem(draftKey, input)
              } else {
                localStorage.removeItem(draftKey)
              }
            }}
            disabled={loading}
            rows={1}
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 resize-none overflow-y-auto"
            style={{ maxHeight: '200px', fontSize: '16px' }}
            placeholder={sendKeyMode === 'enter' ? 'Type a message... (Enter to send)' : 'Type a message... (Ctrl+Enter to send)'}
          />
          <button
            type="submit"
            disabled={loading || (!input.trim() && attachments.length === 0)}
            className="px-6 py-2 bg-blue-500 dark:bg-blue-600 text-white rounded-lg hover:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed transition self-end"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
