import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Code, Copy, Eye, FileJson } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import {
  IconToggleButton,
  copyTextToClipboard,
  handleMarkdownLinkClick,
  renderMarkdown,
  type ContextBlockMessageMeta,
  type Message,
  type ViewMode,
} from './chatShared'

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

interface ContextBlockCardProps {
  sessionId: string
  messageKey: string
  block: ContextBlockMessageMeta
  text: string
  message: Message
  nestedDepth: number
  renderNestedMessages: (messages: Message[], keyPrefix: string, nestedDepth: number) => ReactNode
}

const ContextBlockCard = memo(function ContextBlockCard({
  sessionId,
  messageKey,
  block,
  text,
  message,
  nestedDepth,
  renderNestedMessages,
}: ContextBlockCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [expansion, setExpansion] = useState<ExpansionState>({})
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)

  const jsonText = useMemo(() => viewMode === 'json' ? JSON.stringify(message, null, 2) : '', [message, viewMode])
  const html = useMemo(() => viewMode === 'rendered' ? renderMarkdown(text) : '', [text, viewMode])
  const nestedMessages = useMemo(() => getExpansionMessages(expansion.response), [expansion.response])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

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

  const handleToggle = useCallback(() => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!expansion.response && !expansion.loading) {
      void loadExpansion()
    }
  }, [expanded, expansion.loading, expansion.response, loadExpansion])

  const handleCollapseExpansion = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setExpanded(false)
  }, [])

  const handleRetry = useCallback(() => {
    void loadExpansion()
  }, [loadExpansion])

  const handleCopy = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await copyTextToClipboard(text)
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy CTX-BLOCK text:', error)
    }
  }, [text])

  const nestedKey = `${messageKey}-ctx-block-${block.sourceSessionId || 'local'}-${block.id}`

  return (
    <div className="min-w-0">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 rounded-lg cursor-text relative group">
        <div className="absolute right-1 top-1 z-10 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconToggleButton onClick={() => setViewMode('rendered')} active={viewMode === 'rendered'} title="Rendered (Markdown)">
            <Eye size={12} />
          </IconToggleButton>
          <IconToggleButton onClick={() => setViewMode('raw')} active={viewMode === 'raw'} title="Raw Text">
            <Code size={12} />
          </IconToggleButton>
          <IconToggleButton onClick={() => setViewMode('json')} active={viewMode === 'json'} title="JSON">
            <FileJson size={14} />
          </IconToggleButton>
          <IconToggleButton onClick={handleCopy} active={copied} title={copied ? 'Copied' : 'Copy Raw Text'}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </IconToggleButton>
          <IconToggleButton onClick={handleToggle} active={expanded} title={expanded ? 'Collapse CTX-BLOCK' : `Expand CTX-BLOCK (${block.sourceKind === 'block' ? 'one level' : 'raw messages'})`}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </IconToggleButton>
        </div>

        {viewMode === 'rendered' ? (
          <div
            className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100 prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={handleMarkdownLinkClick}
          />
        ) : viewMode === 'raw' ? (
          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 py-2">{text}</pre>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto py-2">{jsonText}</pre>
        )}
      </div>

      {expanded && (
        <div className="relative mt-2 ml-3 min-w-0 pl-3 pr-1">
          <button
            type="button"
            aria-label={`Collapse CTX-BLOCK B#${block.id} expansion`}
            title="Collapse this CTX-BLOCK expansion"
            className="absolute bottom-0 left-0 top-0 w-3 cursor-pointer appearance-none border-0 border-l-2 border-blue-200 bg-transparent p-0 transition-colors hover:border-blue-400 focus:outline-none focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400 dark:border-blue-800 dark:hover:border-blue-500 dark:focus-visible:border-blue-400"
            onClick={handleCollapseExpansion}
          />
          <div className="min-w-0">
            {expansion.loading && (
              <div className="py-1 text-xs text-gray-500 dark:text-gray-400">Loading {block.sourceKind === 'block' ? 'child blocks' : 'raw messages'}…</div>
            )}
            {expansion.error && !expansion.loading && (
              <div className="py-1 text-xs text-red-600 dark:text-red-400">
                <div>{expansion.error}</div>
                <button type="button" className="mt-1 rounded border border-red-200 px-2 py-0.5 text-[11px] hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40" onClick={handleRetry}>
                  Retry
                </button>
              </div>
            )}
            {!expansion.loading && !expansion.error && expansion.response && nestedMessages.length === 0 && (
              <div className="py-1 text-xs text-gray-500 dark:text-gray-400">No {expansionKindLabel(expansion.response.expansionKind)} found for this block.</div>
            )}
            {!expansion.loading && nestedMessages.length > 0 && renderNestedMessages(nestedMessages, nestedKey, nestedDepth + 1)}
          </div>
        </div>
      )}
    </div>
  )
})

export default ContextBlockCard
