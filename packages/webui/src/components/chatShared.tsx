import * as Diff from 'diff'
import {
  Brain,
  BookOpen,
  Bell,
  BellRing,
  Bot,
  Camera,
  GitFork,
  Info,
  Inbox,
  MessagesSquare,
  Pencil,
  Power,
  SeparatorHorizontal,
  ScrollText,
  Search,
  Target,
  Timer,
  Wrench,
  Workflow,
  Terminal,
  Zap,
} from 'lucide-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
export { formatCompactObjectPreview } from '../../../shared/src/toolResponseFormatting'
import { formatCompactObjectPreview } from '../../../shared/src/toolResponseFormatting'
import { parseSessionLinkText } from '../../../shared/src/webuiToolRendering'
export {
  renderAssistantMarkdownSegments,
  renderAssistantMarkdownSegmentsWithSanitizer,
  renderMarkdown,
  renderMarkdownWithSanitizer,
  type MarkdownRenderSegment,
} from './markdownRenderer'

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

/** Shared semantic status for tool cards and non-card timeline summaries. */
export const getToolResponseStatus = (resp: FunctionResponse): 'success' | 'error' => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return 'error'
  }
  if (resp.name === 'edit') {
    return resp.response?.output === 'File edited successfully' ? 'success' : 'error'
  }
  return 'success'
}

export interface OpenAIResponsesAnnotation {
  type?: string
  start_index?: number
  end_index?: number
  url?: string
  title?: string
  url_citation?: {
    url?: string
    title?: string
    start_index?: number
    end_index?: number
  }
}

export interface MessagePartProviderMeta {
  openaiResponses?: {
    annotations?: OpenAIResponsesAnnotation[]
    outputItem?: Record<string, unknown>
    sourceModelId?: string
  }
}

export interface MessagePart {
  text?: string
  system?: string
  thinking?: string
  providerMeta?: MessagePartProviderMeta
  functionCall?: FunctionCall
  functionResponse?: FunctionResponse
  toolUseId?: string
  inlineData?: {
    data: string
    mimeType: string
  }
  inlineDataUnavailable?: {
    mimeType?: string
    mime_type?: string
    unavailable: true
  }
  inlineDataRef?: {
    mimeType?: string
    imageId?: string
    blobId?: string
    apiPath?: string
    byteLength?: number
    width?: number
    height?: number
  }
}

export interface ToolScriptSubCall {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  durationMs?: number
  error?: string
  argsSummary?: string
}

export interface ModelStreamToolCall {
  index: number
  id?: string
  name?: string
}

export interface ContextBlockMessageMeta {
  id: number
  level: number
  rawStartSeq: number
  rawEndSeq: number
  sourceKind?: 'message' | 'block'
  sourceStart?: number
  sourceEnd?: number
  sourceBlockIds?: number[]
  rawStartTimestamp?: number
  rawEndTimestamp?: number
  createdAt?: number
  sourceSessionId?: string
  inherited?: boolean
}

export interface SessionStreamEvent {
  type: 'model-stream-reset' | 'model-stream-update' | 'toolscript-progress'
  streamId?: string
  iteration?: number
  reasoning?: string
  text?: string
  toolCalls?: ModelStreamToolCall[]
  runId?: string
  toolUseId?: string
  subCalls?: ToolScriptSubCall[]
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
  modelVisible?: boolean
  parts: MessagePart[]
  __meta?: {
    timestamp?: number
    llmRequestTiming?: {
      startedAt: number
      completedAt: number
      durationMs: number
    }
    contextBlock?: ContextBlockMessageMeta
    preservedFromBlockId?: number
    [key: string]: any
  }
}

export interface SystemMessageKind {
  /** Stable lower-case metadata value used as the visual thread-card tag. */
  kind: string
  source: 'foxwarm-system' | 'foxwarm-message' | 'legacy'
}

export interface SystemMessagePreviewDescriptor extends SystemMessageKind {
  /** Optional metadata prefix for the collapsed card preview only. */
  previewPrefix: string
  /** Session identity represented by the inter-agent collapsed-preview prefix. */
  previewSessionId?: string
}

/** Click handler for markdown containers: intercepts link clicks with a confirmation dialog */
export const handleMarkdownLinkClick = (e: MouseEvent<HTMLDivElement>) => {
  const target = e.target as HTMLElement
  const anchor = target.closest('a')
  if (!anchor) return

  const href = anchor.getAttribute('href')
  if (!href) return

  e.preventDefault()
  e.stopPropagation()

  if (window.confirm(`Open this link in a new tab?\n\n${href}`)) {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
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

export const FOXWARM_METADATA_LINE_RE = /^\s*<\/?foxwarm-(system|metadata|message|image|file)\b/i
const FOXWARM_TAG_LINE_RE = /^\s*<\/?foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)\/?\s*>\s*$/i

export const isFoxwarmMetadataLine = (text: string): boolean => FOXWARM_METADATA_LINE_RE.test(text)

export const parseFoxwarmMetadataLine = (text: string): { tagName: string; closing: boolean; attrs: Record<string, string> } | null => {
  const firstLine = text.split('\n')[0] || text
  const match = firstLine.match(FOXWARM_TAG_LINE_RE)
  if (!match) return null

  const attrs: Record<string, string> = {}
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g
  let attrMatch: RegExpExecArray | null
  while ((attrMatch = attrRe.exec(match[2] || '')) !== null) {
    attrs[attrMatch[1]] = attrMatch[2]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  return {
    tagName: `foxwarm-${match[1].toLowerCase()}`,
    closing: /^\s*<\//.test(firstLine),
    attrs,
  }
}

export const isLightweightFoxwarmMetadataLine = (text: string): boolean => {
  const tag = parseFoxwarmMetadataLine(text)
  if (!tag) return false
  if (tag.closing) return true
  if (tag.tagName === 'foxwarm-image' || tag.tagName === 'foxwarm-file') return true
  if (tag.tagName === 'foxwarm-message') return tag.attrs.type === 'channel'
  if (tag.tagName === 'foxwarm-metadata') return true
  if (tag.tagName !== 'foxwarm-system') return false

  const kind = tag.attrs.kind || ''
  return kind === 'time'
    || kind === 'session'
    || kind === 'channel-mode'
}

export const formatStructuredSystemText = (system: string): string => (
  isFoxwarmMetadataLine(system) ? system : (system.startsWith('FROM:') ? `[${system}]` : `[SYSTEM: ${system}]`)
)

export const isSystemLikeText = (text: string): boolean => (
  text.startsWith('[SYSTEM:') || text.startsWith('[FROM:') || isFoxwarmMetadataLine(text)
)

export const isLightweightStructuredSystem = (system: string): boolean => (
  (isFoxwarmMetadataLine(system) && isLightweightFoxwarmMetadataLine(system)) ||
  system.startsWith('FROM:') ||
  system.startsWith('The following message is a direct user message via channel;') ||
  system.startsWith('current time =') ||
  system.startsWith('current session ID =')
)

export const isLightweightSystemTextLine = (text: string): boolean => (
  (isFoxwarmMetadataLine(text) && isLightweightFoxwarmMetadataLine(text)) ||
  text.startsWith('[FROM:') ||
  text.startsWith('[SYSTEM: The following message is a direct user message via channel;') ||
  text.startsWith('[SYSTEM: current time') ||
  text.startsWith('[SYSTEM: current session ID =')
)

export const isHeavySystemTextLine = (text: string): boolean => (
  (text.startsWith('[SYSTEM:') || isFoxwarmMetadataLine(text)) && !isLightweightSystemTextLine(text)
)

export const isCollapsibleSystemText = (text: string): boolean => (
  (text.startsWith('[SYSTEM:') || isFoxwarmMetadataLine(text)) && !isLightweightSystemTextLine(text)
)

const normalizeSystemMessageKind = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized && normalized.length <= 80 ? normalized : null
}

const getSystemMessagePreviewAttribute = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
)

/**
 * Finds a heavy system card's stable kind plus its collapsed-preview metadata.
 * A real foxwarm-system kind wins over a direct channel wrapper or a
 * non-channel foxwarm-message type, keeping corrupted mixed history readable
 * as the actual event it contains.
 */
export const getSystemMessagePreviewDescriptor = (message: Message): SystemMessagePreviewDescriptor => {
  let messageType: { kind: string; attrs: Record<string, string> } | null = null

  for (const part of message.parts) {
    const text = part.system || part.text || ''
    for (const line of text.split('\n')) {
      const tag = parseFoxwarmMetadataLine(line)
      if (!tag || tag.closing) continue

      if (tag.tagName === 'foxwarm-system' && !isLightweightFoxwarmMetadataLine(line)) {
        const kind = normalizeSystemMessageKind(tag.attrs.kind)
        if (kind) {
          const previewValue = kind === 'session-boundary'
            ? getSystemMessagePreviewAttribute(tag.attrs.event)
            : kind === 'event'
              ? getSystemMessagePreviewAttribute(tag.attrs.type)
              : ''
          return { kind, source: 'foxwarm-system', previewPrefix: previewValue ? `${previewValue}: ` : '' }
        }
      }

      if (tag.tagName === 'foxwarm-message' && tag.attrs.type !== 'channel') {
        const kind = normalizeSystemMessageKind(tag.attrs.type)
        if (kind && !messageType) messageType = { kind, attrs: tag.attrs }
      }
    }
  }

  if (messageType) {
    const previewValue = messageType.kind === 'inter-agent'
      ? getSystemMessagePreviewAttribute(messageType.attrs.sourceSessionId)
      : ''
    return {
      kind: messageType.kind,
      source: 'foxwarm-message',
      previewPrefix: previewValue ? `From ${previewValue}: ` : '',
      ...(previewValue ? { previewSessionId: previewValue } : {}),
    }
  }
  return { kind: 'system', source: 'legacy', previewPrefix: '' }
}

export const getSystemMessageKind = (message: Message): SystemMessageKind => {
  const { kind, source } = getSystemMessagePreviewDescriptor(message)
  return { kind, source }
}

export const clampContentStyle = (lines: number, extraHeightRem = 0): CSSProperties => ({
  lineHeight: '1.3em',
  maxHeight: extraHeightRem > 0
    ? `calc(1.3em * ${lines} + ${extraHeightRem}rem)`
    : `calc(1.3em * ${lines})`,
  overflow: 'hidden',
})

/** Shared collapsed-header geometry for tool-like cards in the chat timeline. */
export const THREAD_CARD_HEADER_ROW_CLASS = 'flex min-w-0 items-center gap-2 leading-[18px]'
export const THREAD_CARD_HEADER_PREVIEW_CLASS = 'min-w-0 flex-1 truncate text-[13px] leading-[18px]'

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
  'web-search': Search,
  'ctx-block': BookOpen,
  read: BookOpen,
  write: Pencil,
  edit: Pencil,
  apply_patch: Wrench,
  apply_patch_memory: Wrench,
  exec: Terminal,
  send_to_session: MessagesSquare,
  'system-event': Bell,
  'system-inter-agent': MessagesSquare,
  'system-timer': Timer,
  'system-trigger': Zap,
  'system-background': Bot,
  'system-onboot': Power,
  'system-snapshot': Camera,
  'system-session-boundary': SeparatorHorizontal,
  'system-goal-reminder': Target,
  'system-child-reminder': BellRing,
  'system-system-prompt': ScrollText,
  'system-managed-session': Workflow,
  'system-session-event': GitFork,
  'system-btw': MessagesSquare,
  'system-system-delivered': Inbox,
  'system-system': Info,
}

const getToolIcon = (name: string, fallback: LucideIcon = Wrench) => toolIcons[name] || fallback

export type ToolTagTone = 'neutral' | 'success' | 'error' | 'system'

export interface ToolTagItem {
  name: string
  label?: string
  tone?: ToolTagTone
}

const toolTagToneClasses: Record<ToolTagTone, string> = {
  neutral: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-gray-600 dark:bg-gray-900/60 dark:text-gray-300',
  success: 'border-green-300 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300',
  error: 'border-red-300 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300',
  system: 'border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300',
}

export const ToolTag = ({ name, label = name, tone = 'neutral', className = '', iconName }: { name: string; label?: string; tone?: ToolTagTone; className?: string; iconName?: string }) => {
  const resolvedIconName = iconName || name
  const Icon = getToolIcon(resolvedIconName, iconName?.startsWith('system-') ? Bell : Wrench)

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
    className={`foxwarm-session-hash-link font-mono underline decoration-dotted underline-offset-2 hover:text-blue-600 dark:hover:text-blue-300 ${className}`.trim()}
    title={`Open session ${sessionId}`}
  >
    {sessionId}
  </a>
)

export const renderSystemTextWithSessionLinks = (text: string) => {
  return parseSessionLinkText(text).map((segment, index) => {
    if (segment.type === 'text') {
      return segment.text
    }
    return (
      <span key={`session-link-${index}`}>
        {segment.text}<SessionHashLink sessionId={segment.sessionId} />
      </span>
    )
  })
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
