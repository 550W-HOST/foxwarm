import * as Diff from 'diff'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Brain,
  BookOpen,
  Pencil,
  Wrench,
  Terminal,
} from 'lucide-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
export { formatCompactObjectPreview } from '../../../shared/src/toolResponseFormatting'
import { formatCompactObjectPreview } from '../../../shared/src/toolResponseFormatting'

export const formatObject = formatCompactObjectPreview

export interface SlashCommandOption {
  name: string
  description: string
  usage?: string | null
  requiresSession?: boolean
  showInTelegram?: boolean
  autocomplete?: SlashCommandAutocomplete | null
}

export interface SlashCommandAutocompleteNode {
  value: string
  kind?: 'literal' | 'placeholder'
  description?: string
  usage?: string | null
  insertValue?: string
  children?: SlashCommandAutocompleteNode[]
}

export interface SlashCommandAutocomplete {
  children?: SlashCommandAutocompleteNode[]
}

export interface SlashCommandSuggestion {
  key: string
  label: string
  description?: string
  usage?: string | null
  insertValue: string
  requiresSession?: boolean
}

export interface SlashCommandHint {
  key: string
  label: string
  description?: string
  usage?: string | null
}

export interface SlashCommandCompletion {
  suggestions: SlashCommandSuggestion[]
  hints: SlashCommandHint[]
  tokens: string[]
  currentIndex: number
  trailingSpace: boolean
}

export type ViewMode = 'rendered' | 'raw' | 'json'

export type ToolViewMode = 'default' | 'json'

export interface FunctionCall {
  id?: string
  name: string
  args: any
}

const normalizeToolLabelValue = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (value === undefined || value === null) return null
  return String(value)
}

export const formatToolLabel = (name: string, args?: any): string => {
  if (name === 'remote_node') {
    const nodeId = normalizeToolLabelValue(args?.nodeId)
    const tool = normalizeToolLabelValue(args?.tool)
    if (nodeId && tool) {
      return `node:${nodeId}:${tool}`
    }
  }

  if (name === 'call_mcp') {
    const tool = normalizeToolLabelValue(args?.tool)
    if (tool) {
      const server = normalizeToolLabelValue(args?.server) || 'default'
      return `mcp:${server}:${tool}`
    }
  }

  if (name === 'call_tool') {
    const toolId = normalizeToolLabelValue(args?.toolId)
    if (toolId) {
      return `tool:${toolId}`
    }

    const source = normalizeToolLabelValue(args?.source)
    const tool = normalizeToolLabelValue(args?.name)
    if (source && tool) {
      const scope = normalizeToolLabelValue(args?.server) || normalizeToolLabelValue(args?.nodeId)
      return scope ? `tool:${source}:${scope}:${tool}` : `tool:${source}:${tool}`
    }
  }

  if (name === 'search_tools') {
    const sources = Array.isArray(args?.sources) ? args.sources.join(',') : normalizeToolLabelValue(args?.sources)
    const scope = normalizeToolLabelValue(args?.server) || normalizeToolLabelValue(args?.nodeId)
    const query = normalizeToolLabelValue(args?.query)
    return ['search_tools', sources, scope, query].filter(Boolean).join(':')
  }

  return name
}

export interface FunctionResponse {
  tool_use_id?: string
  name: string
  response: any
}

export interface MessagePart {
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

export interface SessionStreamEvent {
  type: 'reasoning-summary' | 'reasoning-summary-reset'
  text?: string
}

export type PatchPreviewHunk = {
  anchors: string[]
  lines: string[]
}

export type PatchPreviewOperation =
  | { action: 'update'; filePath: string; hunks: PatchPreviewHunk[] }
  | { action: 'add'; filePath: string; lines: string[] }
  | { action: 'delete'; filePath: string }

export interface Message {
  role: 'user' | 'model' | 'tool'
  parts: MessagePart[]
  __meta?: {
    timestamp?: number
    [key: string]: any
  }
}

marked.setOptions({
  breaks: true,
  gfm: true,
})

const sanitizeHtml = (html: string): string => {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'embed', 'object', 'script', 'style'],
    FORBID_ATTR: ['src', 'href', 'xlink:href', 'action', 'formaction'],
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['class'],
  })
}

export const renderMarkdown = (text: string): string => {
  const html = marked(text) as string
  return sanitizeHtml(html)
}

export const IconToggleButton = ({ active, title, onClick, children }: { active: boolean; title: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) => (
  <button
    onClick={onClick}
    title={title}
    className={`p-0.5 rounded ${active ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
  >
    {children}
  </button>
)

export const MiniToggleButton = ({ active, title, onClick, children }: { active: boolean; title: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) => (
  <button
    onClick={onClick}
    title={title}
    className={`px-1.5 py-0.5 text-[10px] rounded ${active ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
  >
    {children}
  </button>
)

export const copyTextToClipboard = async (text: string) => {
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

export const formatStructuredSystemText = (system: string): string => (
  system.startsWith('FROM:') ? `[${system}]` : `[SYSTEM: ${system}]`
)

export const isSystemLikeText = (text: string): boolean => (
  text.startsWith('[SYSTEM:') || text.startsWith('[FROM:')
)

export const isLightweightStructuredSystem = (system: string): boolean => (
  system.startsWith('FROM:') ||
  system.startsWith('The following message is a direct user message via channel;') ||
  system.startsWith('current time =') ||
  system.startsWith('current session ID =')
)

export const isLightweightSystemTextLine = (text: string): boolean => (
  text.startsWith('[FROM:') ||
  text.startsWith('[SYSTEM: The following message is a direct user message via channel;') ||
  text.startsWith('[SYSTEM: current time') ||
  text.startsWith('[SYSTEM: current session ID =')
)

export const isHeavySystemTextLine = (text: string): boolean => (
  text.startsWith('[SYSTEM:') && !isLightweightSystemTextLine(text)
)

export const isCollapsibleSystemText = (text: string): boolean => (
  text.startsWith('[SYSTEM:') && !isLightweightSystemTextLine(text)
)

export const clampContentStyle = (lines: number, extraHeightRem = 0): CSSProperties => ({
  maxHeight: extraHeightRem > 0
    ? `calc(1.5em * ${lines} + ${extraHeightRem}rem)`
    : `calc(1.5em * ${lines})`,
  overflow: 'hidden',
})

const isSlashCommandValue = (value: string): boolean => {
  if (!value || value.includes('\n') || /^\s/.test(value)) {
    return false
  }

  return value.trimStart().startsWith('/')
}

const findAutocompleteNodeMatch = (nodes: SlashCommandAutocompleteNode[], token: string): SlashCommandAutocompleteNode | null => {
  const normalizedToken = token.toLowerCase()
  const exactLiteral = nodes.find((node) => (node.kind ?? 'literal') === 'literal' && node.value.toLowerCase() === normalizedToken)
  if (exactLiteral) return exactLiteral

  return nodes.find((node) => (node.kind ?? 'literal') === 'placeholder') || null
}

export const getSlashCommandCompletion = (value: string, commands: SlashCommandOption[]): SlashCommandCompletion | null => {
  if (!isSlashCommandValue(value)) {
    return null
  }

  const trailingSpace = /\s$/.test(value)
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return null

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const currentIndex = trailingSpace ? tokens.length : tokens.length - 1
  const currentToken = trailingSpace ? '' : (tokens[currentIndex] || '')

  if (currentIndex === 0) {
    const normalizedPrefix = currentToken.toLowerCase()
    const suggestions = commands
      .filter((command) => command.name.toLowerCase().startsWith(normalizedPrefix))
      .map((command) => ({
        key: command.name,
        label: command.name,
        description: command.description,
        usage: command.usage,
        insertValue: command.name,
        requiresSession: command.requiresSession,
      }))

    return {
      suggestions,
      hints: [],
      tokens,
      currentIndex,
      trailingSpace,
    }
  }

  const command = commands.find((item) => item.name.toLowerCase() === tokens[0].toLowerCase())
  if (!command) {
    return {
      suggestions: [],
      hints: [],
      tokens,
      currentIndex,
      trailingSpace,
    }
  }

  let candidateNodes = command.autocomplete?.children || []
  let matchedNode: SlashCommandAutocompleteNode | null = null

  for (const token of tokens.slice(1, currentIndex)) {
    const nextNode = findAutocompleteNodeMatch(candidateNodes, token)
    if (!nextNode) {
      candidateNodes = []
      matchedNode = null
      break
    }
    matchedNode = nextNode
    candidateNodes = nextNode.children || []
  }

  const normalizedPrefix = currentToken.toLowerCase()
  const suggestions = candidateNodes
    .filter((node) => (node.kind ?? 'literal') === 'literal')
    .filter((node) => node.value.toLowerCase().startsWith(normalizedPrefix))
    .map((node) => ({
      key: `${tokens[0]}:${node.value}`,
      label: node.value,
      description: node.description,
      usage: node.usage || null,
      insertValue: node.insertValue || node.value,
    }))

  const placeholderHints = candidateNodes
    .filter((node) => (node.kind ?? 'literal') === 'placeholder')
    .map((node) => ({
      key: `${tokens[0]}:hint:${node.value}`,
      label: node.value,
      description: node.description,
      usage: node.usage || null,
    }))

  const fallbackHints = placeholderHints.length === 0 && suggestions.length === 0 && (matchedNode?.usage || command.usage)
    ? [{
        key: `${tokens[0]}:usage`,
        label: 'usage',
        description: matchedNode?.description || command.description,
        usage: matchedNode?.usage || command.usage || null,
      }]
    : []

  return {
    suggestions,
    hints: placeholderHints.length > 0 ? placeholderHints : fallbackHints,
    tokens,
    currentIndex,
    trailingSpace,
  }
}

export const applySlashCommandSuggestion = (completion: SlashCommandCompletion, suggestion: SlashCommandSuggestion): string => {
  const nextTokens = completion.trailingSpace
    ? [...completion.tokens, suggestion.insertValue]
    : [...completion.tokens.slice(0, completion.currentIndex), suggestion.insertValue]

  return `${nextTokens.join(' ')} `
}

export const resizeTextarea = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
}

export const getCollapsedReasoningPreview = (thinking: string): string => {
  const lines = thinking
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return lines.length > 0 ? lines[lines.length - 1] : thinking.trim()
}

export const parseAnsi = (text: string): ReactNode[] => {
  const ansiRegex = /\x1b\[([0-9;]+)m/g
  const parts: ReactNode[] = []
  let lastIndex = 0
  let currentStyles: string[] = []

  const ansiToStyle = (code: string): string[] => {
    const codes = code.split(';').map(Number)
    const styles: string[] = []

    for (const c of codes) {
      if (c === 0) return []
      if (c === 1) styles.push('font-weight: bold')
      if (c === 3) styles.push('font-style: italic')
      if (c === 4) styles.push('text-decoration: underline')

      if (c === 30) styles.push('color: #000')
      if (c === 31) styles.push('color: #e74c3c')
      if (c === 32) styles.push('color: #2ecc71')
      if (c === 33) styles.push('color: #f39c12')
      if (c === 34) styles.push('color: #3498db')
      if (c === 35) styles.push('color: #9b59b6')
      if (c === 36) styles.push('color: #1abc9c')
      if (c === 37) styles.push('color: #bdc3c7')
      if (c === 39) styles.push('color: inherit')

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

  let match: RegExpExecArray | null
  while ((match = ansiRegex.exec(text)) !== null) {
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

    const newStyles = ansiToStyle(match[1])
    currentStyles = newStyles.length === 0 ? [] : newStyles
    lastIndex = ansiRegex.lastIndex
  }

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
  reasoning: Brain,
  read: BookOpen,
  write: Pencil,
  edit: Pencil,
  apply_patch: Wrench,
  apply_patch_memory: Wrench,
  exec: Terminal,
}

const getToolIcon = (name: string) => toolIcons[name] || Wrench

export type ToolTagTone = 'neutral' | 'success' | 'error'

export interface ToolTagItem {
  name: string
  label?: string
  tone?: ToolTagTone
}

const toolTagToneClasses: Record<ToolTagTone, string> = {
  neutral: 'border-gray-200 dark:border-gray-600 bg-white/80 dark:bg-gray-900/60 text-gray-600 dark:text-gray-300',
  success: 'border-green-200 dark:border-green-800 bg-green-50/80 dark:bg-green-900/20 text-green-700 dark:text-green-300',
  error: 'border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 text-red-700 dark:text-red-300',
}

export const ToolTag = ({ name, label = name, tone = 'neutral', className = '' }: { name: string; label?: string; tone?: ToolTagTone; className?: string }) => {
  const Icon = getToolIcon(name)

  return (
    <span className={`inline-flex h-[18px] items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold uppercase tracking-wide leading-none align-middle ${toolTagToneClasses[tone]} ${className}`.trim()}>
      <Icon size={12} />
      <span>{label}</span>
    </span>
  )
}

export const ToolLabel = ({ name, label }: { name: string; label?: string }) => <ToolTag name={name} label={label} />

export const ToolTagList = ({ items }: { items: ToolTagItem[] }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    {items.map((item, idx) => (
      <ToolTag key={`${item.name}-${idx}`} name={item.name} label={item.label} tone={item.tone} />
    ))}
  </div>
)

export const SessionHashLink = ({ sessionId, className = '' }: { sessionId: string; className?: string }) => (
  <a
    href={`#session/${encodeURIComponent(sessionId)}`}
    className={`font-mono underline decoration-dotted underline-offset-2 hover:text-blue-600 dark:hover:text-blue-300 ${className}`.trim()}
    title={`Open session ${sessionId}`}
  >
    {sessionId}
  </a>
)

export const renderSystemTextWithSessionLinks = (text: string) => {
  const result: ReactNode[] = []
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

    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith('@@')) {
        break
      }

      if (line === '*** End of File') {
        i++
        break
      }

      if (line.trim() === '') {
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        if (j >= lines.length || lines[j].startsWith('@@')) {
          i = j
          break
        }
      }

      hunkLines.push(line)
      i++
    }

    if (anchors.length === 0 && hunkLines.length === 0) {
      throw new Error(`Invalid apply_patch input for ${filePath}: empty update hunk.`)
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

export const parseApplyPatchPreview = (input?: string): PatchPreviewOperation[] => {
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

export const buildPatchHunkSnippets = (hunk: PatchPreviewHunk): { oldText: string; newText: string } => {
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

    const contextLine = line.startsWith(' ') ? line.slice(1) : line
    oldLines.push(contextLine)
    newLines.push(contextLine)
  }

  return {
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
  }
}

export { Diff }
