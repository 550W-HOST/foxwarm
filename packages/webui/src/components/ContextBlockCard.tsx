import { memo, type ReactNode, useCallback, useMemo, useState } from 'react'
import { API_BASE_PATH } from '../config'
import {
  clampContentStyle,
  handleMarkdownLinkClick,
  renderMarkdown,
  ToolTag,
  type ContextBlockMessageMeta,
  type Message,
} from './chatShared'
import ThreadLineButton from './ThreadLineButton'

export type ContextBlockExpansionKind = 'child-blocks' | 'messages'

type ContextBlockExpansionItem = {
  kind: 'block' | 'message'
  message: Message
  block?: ContextBlockMessageMeta
  seq?: number
  timestamp?: number
  inherited?: boolean
  sourceSessionId?: string
}

type ContextBlockExpansionResponse = {
  sessionId: string
  blockId: number
  expansionKind: ContextBlockExpansionKind
  target: string
  previewLength: number
  text?: string
  items?: ContextBlockExpansionItem[]
  messages?: Message[]
  totalItems?: number
  block?: ContextBlockMessageMeta
}

type ExpansionState = {
  loading?: boolean
  error?: string | null
  response?: ContextBlockExpansionResponse
}

const EXPANSION_PREVIEW_LENGTH = 6000
const CTX_BLOCK_PREFIX_RE = /^\[CTX-BLOCK\s+L(\d+)\s+B#(\d+)\s+raw#(\d+)(?:-#?(\d+))?[^\]]*\]\s*/s

const contextBlockLineToneClasses = 'text-slate-300 hover:text-slate-500 focus-visible:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400 dark:focus-visible:text-slate-400'
const contextBlockSurfaceClasses = 'my-0.5 bg-slate-100/45 dark:bg-slate-800/20'
const contextBlockHeaderClasses = '-ml-2 -mr-2 bg-slate-200/80 px-2 py-1 dark:bg-slate-700/25'
const contextBlockHeaderHoverClasses = 'hover:text-slate-900 dark:hover:text-slate-100'
const contextBlockTextClasses = 'text-slate-700 dark:text-slate-300'
const contextBlockBodyClasses = 'prose-slate dark:prose-invert prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-headings:text-slate-800 dark:prose-headings:text-slate-200 prose-strong:text-slate-900 dark:prose-strong:text-white prose-li:text-slate-700 dark:prose-li:text-slate-300'

const toPositiveInteger = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

export const normalizeContextBlockMeta = (value: unknown): ContextBlockMessageMeta | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as ContextBlockMessageMeta
  const id = toPositiveInteger(raw.id)
  const level = toPositiveInteger(raw.level)
  const rawStartSeq = toPositiveInteger(raw.rawStartSeq)
  const rawEndSeq = toPositiveInteger(raw.rawEndSeq)
  if (id === null || level === null || rawStartSeq === null || rawEndSeq === null) return null

  return {
    id,
    level,
    rawStartSeq,
    rawEndSeq,
    ...(raw.sourceKind === 'message' || raw.sourceKind === 'block' ? { sourceKind: raw.sourceKind } : {}),
    ...(typeof raw.sourceStart === 'number' && Number.isFinite(raw.sourceStart) ? { sourceStart: Math.trunc(raw.sourceStart) } : {}),
    ...(typeof raw.sourceEnd === 'number' && Number.isFinite(raw.sourceEnd) ? { sourceEnd: Math.trunc(raw.sourceEnd) } : {}),
    ...(Array.isArray(raw.sourceBlockIds) ? { sourceBlockIds: raw.sourceBlockIds.filter((id) => Number.isFinite(id)).map((id) => Math.trunc(id)) } : {}),
    ...(typeof raw.rawStartTimestamp === 'number' && Number.isFinite(raw.rawStartTimestamp) ? { rawStartTimestamp: raw.rawStartTimestamp } : {}),
    ...(typeof raw.rawEndTimestamp === 'number' && Number.isFinite(raw.rawEndTimestamp) ? { rawEndTimestamp: raw.rawEndTimestamp } : {}),
    ...(typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.sourceSessionId === 'string' && raw.sourceSessionId ? { sourceSessionId: raw.sourceSessionId } : {}),
    ...(typeof raw.inherited === 'boolean' ? { inherited: raw.inherited } : {}),
  }
}

export const getContextBlockMetaFromMessage = (message: Message): ContextBlockMessageMeta | null => {
  const metaBlock = normalizeContextBlockMeta(message.__meta?.contextBlock)
  if (metaBlock) return metaBlock

  const text = message.parts.find((part) => typeof part.text === 'string' && part.text.trim().startsWith('[CTX-BLOCK'))?.text || ''
  const match = text.match(CTX_BLOCK_PREFIX_RE)
  if (!match) return null

  const level = Number(match[1])
  const id = Number(match[2])
  const rawStartSeq = Number(match[3])
  const rawEndSeq = match[4] ? Number(match[4]) : rawStartSeq
  return normalizeContextBlockMeta({ id, level, rawStartSeq, rawEndSeq })
}

export const getContextBlockSummaryText = (text: string): string => {
  const prefix = text.match(CTX_BLOCK_PREFIX_RE)
  return prefix ? text.slice(prefix[0].length).trim() || text.trim() : text.trim()
}

const getExpansionMessages = (response?: ContextBlockExpansionResponse): Message[] => {
  if (!response) return []
  if (Array.isArray(response.messages)) return response.messages
  if (Array.isArray(response.items)) return response.items.map((item) => item.message).filter(Boolean)
  return []
}

const expansionKindLabel = (kind?: ContextBlockExpansionKind): string => (
  kind === 'messages' ? 'raw messages' : 'child blocks'
)

const formatSeqRange = (start: number, end: number): string => (
  start === end ? `raw#${start}` : `raw#${start}-#${end}`
)

const pad2 = (value: number): string => String(value).padStart(2, '0')

const formatTimezoneOffset = (date: Date): string => {
  const totalMinutes = -date.getTimezoneOffset()
  const sign = totalMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(totalMinutes)
  const hours = Math.floor(absoluteMinutes / 60)
  const minutes = absoluteMinutes % 60
  return `${sign}${pad2(hours)}${pad2(minutes)}`
}

const formatBlockTimestamp = (timestamp?: number): string | null => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${formatTimezoneOffset(date)}`
}

const formatBlockTimeRange = (start?: number, end?: number): string | null => {
  const startText = formatBlockTimestamp(start)
  const endText = formatBlockTimestamp(end)
  if (!startText) return endText
  if (!endText || startText === endText) return startText
  return `${startText} -> ${endText}`
}

interface ContextBlockCardProps {
  sessionId: string
  messageKey: string
  block: ContextBlockMessageMeta
  text: string
  nestedDepth: number
  renderNestedMessages: (messages: Message[], keyPrefix: string, nestedDepth: number) => ReactNode
}

const ContextBlockCard = memo(function ContextBlockCard({
  sessionId,
  messageKey,
  block,
  text,
  nestedDepth,
  renderNestedMessages,
}: ContextBlockCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [expansion, setExpansion] = useState<ExpansionState>({})

  const summary = useMemo(() => getContextBlockSummaryText(text), [text])
  const summaryHtml = useMemo(() => renderMarkdown(summary), [summary])
  const nestedMessages = useMemo(() => getExpansionMessages(expansion.response), [expansion.response])

  const loadExpansion = useCallback(async () => {
    if (!sessionId || !block.id) return
    setExpansion(prev => ({ ...prev, loading: true, error: null }))

    try {
      const params = new URLSearchParams({ previewLength: String(EXPANSION_PREVIEW_LENGTH) })
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/context-blocks/${block.id}/expand?${params.toString()}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to expand CTX-BLOCK (${response.status})`)
      }
      if (!payload || (!Array.isArray(payload.messages) && !Array.isArray(payload.items))) {
        throw new Error('Invalid CTX-BLOCK expansion response.')
      }
      setExpansion({ loading: false, error: null, response: payload as ContextBlockExpansionResponse })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to expand CTX-BLOCK.'
      setExpansion(prev => ({ ...prev, loading: false, error: message }))
    }
  }, [block.id, sessionId])

  const expand = useCallback(() => {
    setExpanded(true)
    if (!expansion.response && !expansion.loading) {
      void loadExpansion()
    }
  }, [expansion.loading, expansion.response, loadExpansion])

  const toggleExpanded = useCallback(() => {
    if (expanded) {
      setExpanded(false)
      return
    }
    expand()
  }, [expand, expanded])

  const handleRetry = useCallback(() => {
    void loadExpansion()
  }, [loadExpansion])

  const nestedKey = `${messageKey}-ctx-block-${block.sourceSessionId || 'local'}-${block.id}`
  const blockRange = formatSeqRange(block.rawStartSeq, block.rawEndSeq)
  const blockTimeRange = formatBlockTimeRange(block.rawStartTimestamp, block.rawEndTimestamp)
  const blockMetaLabel = [`B#${block.id}`, `L${block.level}`, blockRange, blockTimeRange ? `time ${blockTimeRange}` : null].filter(Boolean).join(' · ')

  return (
    <div
      className={`relative group min-w-0 max-w-full pl-2 pr-2 text-xs ${contextBlockSurfaceClasses} ${expanded ? 'pb-1' : ''} ${contextBlockTextClasses} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''}`}
      onClick={!expanded ? expand : undefined}
    >
      <ThreadLineButton
        expanded={expanded}
        onToggle={toggleExpanded}
        label={expanded ? `Collapse CTX-BLOCK B#${block.id}` : `Expand CTX-BLOCK B#${block.id}`}
        className={contextBlockLineToneClasses}
      />
      <div
        className={`${expanded ? 'mb-1' : ''} flex min-w-0 items-center gap-2 ${contextBlockHeaderClasses} ${expanded ? `cursor-pointer ${contextBlockHeaderHoverClasses}` : ''}`}
        onClick={expanded ? (e) => { e.stopPropagation(); setExpanded(false) } : undefined}
      >
        <ToolTag name="ctx-block" label="CTX-BLOCK" tone="neutral" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-500 dark:text-slate-400" title={blockMetaLabel}>{blockMetaLabel}</span>
      </div>

      <div className="min-w-0 space-y-2">
        <div
          className={`foxwarm-markdown prose max-w-none text-[13px] prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 ${contextBlockBodyClasses}`}
          dangerouslySetInnerHTML={{ __html: summaryHtml }}
          onClick={expanded ? handleMarkdownLinkClick : undefined}
          style={expanded ? undefined : clampContentStyle(3)}
        />

        {expanded && expansion.loading && (
          <div className="py-1 text-xs text-gray-500 dark:text-gray-400">Loading {block.sourceKind === 'block' ? 'child blocks' : 'raw messages'}…</div>
        )}
        {expanded && expansion.error && !expansion.loading && (
          <div className="py-1 text-xs text-red-600 dark:text-red-400">
            <div>{expansion.error}</div>
            <button type="button" className="mt-1 rounded border border-red-200 px-2 py-0.5 text-[11px] hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40" onClick={handleRetry}>
              Retry
            </button>
          </div>
        )}
        {expanded && !expansion.loading && !expansion.error && expansion.response && nestedMessages.length === 0 && (
          <div className="py-1 text-xs text-gray-500 dark:text-gray-400">No {expansionKindLabel(expansion.response.expansionKind)} found for this block.</div>
        )}
        {expanded && !expansion.loading && nestedMessages.length > 0 && renderNestedMessages(nestedMessages, nestedKey, nestedDepth + 1)}
      </div>
    </div>
  )
})

export default ContextBlockCard
