import { memo, useCallback, useMemo, useState } from 'react'
import { API_BASE_PATH } from '../config'
import { copyTextToClipboard, type ContextBlockMessageMeta, type Message } from './chatShared'

export type ContextBlockExpansionMode = 'detail' | 'messages'

type ContextBlockExpansionResponse = {
  sessionId: string
  blockId: number
  mode: ContextBlockExpansionMode
  target: string
  previewLength: number
  text: string
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

const formatSeqRange = (start: number, end: number): string => (
  start === end ? `raw#${start}` : `raw#${start}-#${end}`
)

const modeLabel = (mode: ContextBlockExpansionMode): string => (
  mode === 'messages' ? 'Raw messages' : 'One level'
)

const modeDescription = (mode: ContextBlockExpansionMode): string => (
  mode === 'messages'
    ? 'Raw archived messages covered by this block.'
    : 'Immediate source: child block summaries for higher-level blocks, or source message previews for message-backed blocks.'
)

interface ContextBlockCardProps {
  sessionId: string
  messageKey: string
  block: ContextBlockMessageMeta
  text: string
}

const ContextBlockCard = memo(function ContextBlockCard({ sessionId, messageKey, block, text }: ContextBlockCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<ContextBlockExpansionMode>('detail')
  const [expansions, setExpansions] = useState<Record<ContextBlockExpansionMode, ExpansionState>>({
    detail: {},
    messages: {},
  })
  const [copied, setCopied] = useState(false)

  const summary = useMemo(() => getContextBlockSummaryText(text), [text])
  const current = expansions[mode] || {}
  const sourceLabel = block.sourceKind
    ? `${block.sourceKind}${typeof block.sourceStart === 'number' && typeof block.sourceEnd === 'number' ? ` ${block.sourceStart === block.sourceEnd ? `#${block.sourceStart}` : `#${block.sourceStart}-#${block.sourceEnd}`}` : ''}`
    : 'archive'

  const loadExpansion = useCallback(async (nextMode: ContextBlockExpansionMode) => {
    if (!sessionId || !block.id) return
    setExpansions(prev => ({
      ...prev,
      [nextMode]: { ...(prev[nextMode] || {}), loading: true, error: null },
    }))

    try {
      const params = new URLSearchParams({
        mode: nextMode,
        previewLength: String(EXPANSION_PREVIEW_LENGTH),
      })
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/context-blocks/${block.id}/expand?${params.toString()}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to expand CTX-BLOCK (${response.status})`)
      }
      if (!payload || typeof payload.text !== 'string') {
        throw new Error('Invalid CTX-BLOCK expansion response.')
      }
      setExpansions(prev => ({
        ...prev,
        [nextMode]: { loading: false, error: null, response: payload as ContextBlockExpansionResponse },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to expand CTX-BLOCK.'
      setExpansions(prev => ({
        ...prev,
        [nextMode]: { ...(prev[nextMode] || {}), loading: false, error: message },
      }))
    }
  }, [block.id, sessionId])

  const handleToggle = useCallback(() => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    const next = expansions[mode] || {}
    if (!next.response && !next.loading) {
      void loadExpansion(mode)
    }
  }, [expanded, expansions, loadExpansion, mode])

  const handleModeChange = useCallback((nextMode: ContextBlockExpansionMode) => {
    setMode(nextMode)
    const next = expansions[nextMode] || {}
    if (expanded && !next.response && !next.loading) {
      void loadExpansion(nextMode)
    }
  }, [expanded, expansions, loadExpansion])

  const handleRetry = useCallback(() => {
    void loadExpansion(mode)
  }, [loadExpansion, mode])

  const handleCopy = useCallback(async () => {
    const text = current.response?.text
    if (!text) return
    try {
      await copyTextToClipboard(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy CTX-BLOCK expansion:', error)
    }
  }, [current.response?.text])

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 text-amber-950 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-amber-200/70 px-3 py-2 text-xs dark:border-amber-900/50">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-semibold">
            <span>CTX-BLOCK B#{block.id}</span>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-100">L{block.level}</span>
            <span className="text-amber-700 dark:text-amber-300">{formatSeqRange(block.rawStartSeq, block.rawEndSeq)}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">
            source: {sourceLabel}{block.inherited && block.sourceSessionId ? ` · inherited from ${block.sourceSessionId}` : ''}
          </div>
        </div>
        <button
          type="button"
          className="rounded border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/50"
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-controls={`${messageKey}-ctx-block-${block.id}-expansion`}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <div className="px-3 py-2">
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{summary}</div>
      </div>

      {expanded && (
        <div id={`${messageKey}-ctx-block-${block.id}-expansion`} className="border-t border-amber-200/70 px-3 py-3 dark:border-amber-900/50">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex rounded-md border border-amber-300 bg-amber-100/60 p-0.5 text-[11px] dark:border-amber-800 dark:bg-amber-950/40">
              {(['detail', 'messages'] as ContextBlockExpansionMode[]).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={`rounded px-2 py-1 ${mode === entry ? 'bg-white text-amber-900 shadow-sm dark:bg-amber-900 dark:text-amber-50' : 'text-amber-700 hover:bg-white/60 dark:text-amber-300 dark:hover:bg-amber-900/50'}`}
                  onClick={() => handleModeChange(entry)}
                >
                  {modeLabel(entry)}
                </button>
              ))}
            </div>
            {current.response?.text && (
              <button
                type="button"
                className="rounded border border-amber-300 px-2 py-1 text-[11px] text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/50"
                onClick={handleCopy}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>

          <div className="mb-2 rounded border border-amber-200 bg-white/70 px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
            Temporary archive preview — not part of session history and not sent to the model. {modeDescription(mode)}
          </div>

          {current.loading && (
            <div className="rounded bg-white/70 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">Loading CTX-BLOCK preview…</div>
          )}

          {current.error && !current.loading && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              <div>{current.error}</div>
              <button type="button" className="mt-2 rounded border border-red-300 px-2 py-1 text-[11px] hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/50" onClick={handleRetry}>
                Retry
              </button>
            </div>
          )}

          {current.response?.text && !current.loading && (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded border border-amber-200 bg-white/80 p-3 font-mono text-xs leading-5 text-slate-800 dark:border-amber-900/60 dark:bg-slate-950/70 dark:text-slate-100">
              {current.response.text}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

export default ContextBlockCard
