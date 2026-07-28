import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, Code, FileJson, Copy, Check } from 'lucide-react'
import {
  IconToggleButton,
  copyTextToClipboard,
  clampContentStyle,
  formatToolLabel,
  formatStructuredSystemText,
  getSystemMessagePreviewDescriptor,
  isCollapsibleSystemText,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  isSystemLikeText,
  renderMarkdown,
  handleMarkdownLinkClick,
  renderSystemTextWithSessionLinks,
  SessionHashLink,
  THREAD_CARD_HEADER_PREVIEW_CLASS,
  THREAD_CARD_HEADER_ROW_CLASS,
  ToolTag,
  type Message,
  type ToolTagItem,
  type ViewMode,
} from './chatShared'
import ImageParts from './ImageParts'
import ReasoningCard from './ReasoningCard'
import ContextBlockCard, { getContextBlockMetaFromMessage } from './ContextBlockCard'
import CommitMarkerCard, { type OpenCodeCommitHandler } from './CommitMarkerCard'
import { splitCommitMarkers } from '../commitMarker'
import {
  InterleavedToolGroup,
  ToolCallsBlock,
  ToolGroupSummaryCard,
  ToolResponsesBlock,
  getToolResponseStatus,
  type OpenCodeFileHandler,
} from './ToolTimelineItems'
import { getContextScrollbarAnchorKey, getMessageStableKey, getMessageViewportAnchorKey } from '../chatViewportState'
import ThreadLineButton from './ThreadLineButton'

interface ChatTimelineProps {
  sessionId: string
  messages: Message[]
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
  onRetryFinalFailure?: () => void
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  nestedDepth?: number
}

const EMPTY_TOOL_TAG_ITEMS: ToolTagItem[] = []

interface TokenUsage {
  cachedTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedContentTokenCount?: number | null
  promptTokenCount?: number | null
  candidatesTokenCount?: number | null
}

type NormalizedTokenUsage = {
  cachedTokens: number
  inputTokens: number
  outputTokens: number
}

type UsageAttribution = {
  models: string[]
  timestamps: Array<number | null | 'invalid'>
}

const toTokenCount = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const normalizeMessageUsage = (value: unknown): NormalizedTokenUsage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const raw = value as TokenUsage
  const cached = toTokenCount(raw.cachedTokens) ?? toTokenCount(raw.cachedContentTokenCount)
  const input = toTokenCount(raw.inputTokens) ?? toTokenCount(raw.promptTokenCount)
  const output = toTokenCount(raw.outputTokens) ?? toTokenCount(raw.candidatesTokenCount)

  if (cached === null && input === null && output === null) return null

  return {
    cachedTokens: cached ?? 0,
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  }
}

const getModelMessageUsage = (msg: Message) => msg.role === 'model' ? normalizeMessageUsage(msg.__meta?.usage) : null

const getUsageTotalTokens = (usage: NormalizedTokenUsage) => (
  usage.cachedTokens + usage.inputTokens + usage.outputTokens
)

const formatTokenCount = (count: number): string => {
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`
  return String(count)
}

const formatUsageTitle = (usage: NormalizedTokenUsage, callCount?: number) => {
  const total = getUsageTotalTokens(usage)
  return `Token usage: ${total} total • input ${usage.inputTokens} • output ${usage.outputTokens} • cached ${usage.cachedTokens}${callCount ? ` • calls ${callCount}` : ''}`
}

const formatUsageModel = (msg: Message): string => {
  const modelId = typeof msg.__meta?.modelId === 'string' && msg.__meta.modelId.trim()
    ? msg.__meta.modelId.trim()
    : null
  const virtualModelKey = typeof msg.__meta?.virtualModelKey === 'string' && msg.__meta.virtualModelKey.trim()
    ? msg.__meta.virtualModelKey.trim()
    : null

  if (virtualModelKey) return `${virtualModelKey} → ${modelId || 'unavailable'}`
  return modelId || 'unavailable'
}

const getUsageTimestamp = (msg: Message): number | null | 'invalid' => {
  const timestamp = msg.__meta?.timestamp
  if (timestamp === undefined || timestamp === null) return null
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return 'invalid'
  return timestamp
}

const getMessageUsageAttribution = (msg: Message): UsageAttribution => ({
  models: [formatUsageModel(msg)],
  timestamps: [getUsageTimestamp(msg)],
})

const formatUsageTime = (timestamp: number): string => new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).format(new Date(timestamp))

const formatUsageModels = (models: string[]): string => [...new Set(models)].join(' • ')

const formatUsageTimes = (timestamps: UsageAttribution['timestamps']): string => {
  const valid = [...new Set(timestamps.filter((timestamp): timestamp is number => typeof timestamp === 'number'))].sort((a, b) => a - b)
  const labels = valid.length > 1
    ? [`${formatUsageTime(valid[0])} – ${formatUsageTime(valid[valid.length - 1])}`]
    : valid.map(formatUsageTime)
  if (timestamps.includes(null)) labels.push('unavailable')
  if (timestamps.includes('invalid')) labels.push('invalid timestamp')
  return labels.join(' • ') || 'unavailable'
}

const ModelUsageRow = ({ label, value, tone }: { label: string; value: number; tone: 'muted' | 'normal' | 'warning' }) => {
  const colorClass = tone === 'warning'
    ? 'text-orange-600 dark:text-orange-400'
    : tone === 'muted'
      ? 'text-slate-400 dark:text-slate-500'
      : 'text-slate-500 dark:text-slate-400'

  return (
    <span className={`flex items-baseline justify-between gap-1 ${colorClass}`}>
      <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
      <span className="text-[10px] font-semibold tabular-nums">{formatTokenCount(value)}</span>
    </span>
  )
}

const ModelUsageBadge = memo(function ModelUsageBadge({ usage, isMobile, callCount, attribution, expanded, onToggle }: {
  usage: NormalizedTokenUsage
  isMobile: boolean
  callCount?: number
  attribution: UsageAttribution
  expanded: boolean
  onToggle: () => void
}) {
  const stopUsageBadgeEvent = (event: { stopPropagation: () => void }) => event.stopPropagation()

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide token usage details' : 'Show token usage details'}
      data-usage-badge
      className={`${expanded ? 'flex max-w-full flex-col items-stretch gap-1.5 text-left' : `${isMobile ? 'gap-2' : 'gap-1.5'} inline-flex flex-row items-center`} pointer-events-auto rounded-md border border-slate-200 bg-white/85 px-2 py-1 font-mono leading-none shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/85 ${expanded ? 'w-fit' : ''} cursor-pointer appearance-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500`}
      title={formatUsageTitle(usage, callCount)}
      onPointerDown={stopUsageBadgeEvent}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? (
        <>
          {callCount ? <ModelUsageRow label="Calls" value={callCount} tone="normal" /> : null}
          <ModelUsageRow label="Cached" value={usage.cachedTokens} tone="muted" />
          <ModelUsageRow label="Input" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="Output" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
          <span className="flex min-w-0 items-baseline justify-between gap-2 text-slate-500 dark:text-slate-400">
            <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">Time</span>
            <span className="min-w-0 break-all text-right text-[10px] font-semibold leading-snug">{formatUsageTimes(attribution.timestamps)}</span>
          </span>
          <span className="flex min-w-0 items-baseline justify-between gap-2 text-slate-500 dark:text-slate-400">
            <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">Model</span>
            <span className="min-w-0 break-all text-right text-[10px] font-semibold leading-snug">{formatUsageModels(attribution.models)}</span>
          </span>
        </>
      ) : (
        <>
          {callCount ? <ModelUsageRow label="×" value={callCount} tone="normal" /> : null}
          <ModelUsageRow label="C" value={usage.cachedTokens} tone="muted" />
          <ModelUsageRow label="I" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="O" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
        </>
      )}
    </button>
  )
})

const ModelUsageAnchor = memo(function ModelUsageAnchor({ usage, isMobile, callCount, attribution }: {
  usage: NormalizedTokenUsage
  isMobile: boolean
  callCount?: number
  attribution: UsageAttribution
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandedClampOffset, setExpandedClampOffset] = useState(0)
  const anchorRef = useRef<HTMLDivElement>(null)
  const toggleExpanded = useCallback(() => setExpanded(current => !current), [])

  useLayoutEffect(() => {
    if (!expanded || isMobile) {
      setExpandedClampOffset(0)
      return
    }

    const anchor = anchorRef.current
    const timeline = anchor?.closest<HTMLElement>('.foxwarm-chat-timeline')
    if (!anchor || !timeline) return

    const clampToTimeline = () => {
      const anchorRect = anchor.getBoundingClientRect()
      const timelineRight = timeline.getBoundingClientRect().right
      // The inline offset has already moved this rect left; restore the preferred
      // external position before calculating the minimum required clamp.
      const preferredRight = anchorRect.right + expandedClampOffset
      const nextOffset = Math.max(0, preferredRight - timelineRight)
      setExpandedClampOffset(current => Math.abs(current - nextOffset) < 0.5 ? current : nextOffset)
    }

    clampToTimeline()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampToTimeline)
    observer?.observe(anchor)
    observer?.observe(timeline)
    window.addEventListener('resize', clampToTimeline)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampToTimeline)
    }
  }, [expanded, expandedClampOffset, isMobile])

  if (isMobile) {
    return (
      <div data-usage-badge-anchor className="pointer-events-none mb-2 mt-1 flex justify-end pr-1">
        <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} attribution={attribution} expanded={expanded} onToggle={toggleExpanded} />
      </div>
    )
  }

  return (
    <div
      ref={anchorRef}
      data-usage-badge-anchor
      className={`pointer-events-none absolute bottom-0 right-0 z-10 translate-x-[calc(100%+0.5rem)] ${expanded ? 'max-w-full' : ''}`}
      style={expanded ? { transform: `translateX(calc(100% + 0.5rem - ${expandedClampOffset}px))` } : undefined}
    >
      <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} attribution={attribution} expanded={expanded} onToggle={toggleExpanded} />
    </div>
  )
})

const MarkdownContent = memo(function MarkdownContent({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={`min-w-0 max-w-full ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={handleMarkdownLinkClick} />
})

const isFinalLlmRetryNotice = (message: Message): boolean => (
  message.__meta?.noticeType === 'llm-retry' && message.__meta?.retry?.final === true
)

const isHeavySystemLikeMessage = (message: Message): boolean => {
  if (message.role === 'model') return false
  return (
    message.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
    message.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
  )
}

const InlineMetaPart = memo(function InlineMetaPart({ systemText, isUser }: { systemText: string; isUser: boolean }) {
  return (
    <pre
      className={`max-w-full whitespace-pre-wrap break-words font-sans ${isUser ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}
      style={{ lineHeight: '1.3em' }}
    >
      {systemText.split('\n').map((line, lineIdx) => {
        const isMetaLine = isSystemLikeText(line)
        return (
          <span
            key={lineIdx}
            style={isMetaLine
              ? { display: 'block', fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }
              : { display: 'block', fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
            }
          >
            {renderSystemTextWithSessionLinks(line)}
          </span>
        )
      })}
    </pre>
  )
})

const CollapsibleUserText = memo(function CollapsibleUserText({ text }: { text: string }) {
  const isSystemMessage = isCollapsibleSystemText(text)
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = isSystemMessage && !expanded

  return (
    <div>
      <div className={shouldCollapse ? 'overflow-hidden' : ''} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}>
        <pre className="foxwarm-user-message-text max-w-full whitespace-pre-wrap break-words font-sans" style={{ lineHeight: '1.5em' }}>
          {text.split('\n').map((line, lineIdx) => {
            const isPrefix = isSystemLikeText(line)
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
          onClick={() => setExpanded(current => !current)}
          className="text-xs text-blue-200 hover:text-white mt-1 text-left"
        >
          {expanded ? '▲ Show less' : '▼ Show more'}
        </button>
      )}
    </div>
  )
})

const SystemLikeMessageCard = memo(function SystemLikeMessageCard({ msg, messageKey }: { msg: Message; messageKey: string }) {
  const [expanded, setExpanded] = useState(false)
  const allLines = useMemo(() => msg.parts.flatMap((part) => {
    if (part.system) {
      return formatStructuredSystemText(part.system).split('\n')
    }
    if (part.text) {
      return part.text.split('\n')
    }
    return []
  }), [msg.parts])

  const renderedText = allLines.join('\n')
  const messageKind = useMemo(() => getSystemMessagePreviewDescriptor(msg), [msg])
  const interAgentPreview = useMemo(() => (
    messageKind.kind === 'inter-agent' && messageKind.previewSessionId
      ? allLines.filter((line) => !isSystemLikeText(line)).join('\n').trim()
      : ''
  ), [allLines, messageKind.kind, messageKind.previewSessionId])
  const preview = useMemo(() => {
    const bodyLine = allLines.find((line) => line.trim() && !isSystemLikeText(line))
    const body = bodyLine?.trim() || renderedText.trim() || messageKind.kind
    return `${messageKind.previewPrefix}${body}`
  }, [allLines, messageKind.kind, messageKind.previewPrefix, renderedText])
  const surfaceClass = 'bg-blue-50/55 dark:bg-blue-900/10 text-slate-700 dark:text-slate-300'
  const threadLineClass = 'text-blue-300 hover:text-blue-500 focus-visible:text-blue-500 dark:text-blue-700 dark:hover:text-blue-400 dark:focus-visible:text-blue-400'
  const headerClass = 'bg-blue-100/80 dark:bg-blue-800/20'
  const headerHoverClass = 'hover:text-blue-950 dark:hover:text-white'

  return (
    <div className="w-full min-w-0 overflow-x-hidden">
      <div
        data-system-message-card
        data-system-message-kind={messageKind.kind}
        data-system-message-tone="system"
        className={`foxwarm-system-message-card relative group min-w-0 max-w-full pl-2 pr-2 text-xs ${surfaceClass} ${expanded || interAgentPreview ? 'pb-1' : ''} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''} my-0.5`}
        onClick={!expanded ? () => setExpanded(true) : undefined}
      >
        <ThreadLineButton
          expanded={expanded}
          onToggle={() => setExpanded(current => !current)}
          label={expanded ? `Collapse ${messageKind.kind} message` : `Expand ${messageKind.kind} message`}
          className={`foxwarm-system-message-thread-line ${threadLineClass}`}
        />
        <div
          className={`foxwarm-system-message-header -ml-2 -mr-2 ${THREAD_CARD_HEADER_ROW_CLASS} px-2 py-1 ${headerClass} ${expanded ? `mb-1 cursor-pointer ${headerHoverClass}` : ''}`}
          onClick={expanded ? (event) => { event.stopPropagation(); setExpanded(false) } : undefined}
        >
          <ToolTag name="system" iconName={`system-${messageKind.kind}`} label={messageKind.kind} tone="system" className="foxwarm-system-message-tag" />
          {!expanded && (
            <span className={`foxwarm-system-message-preview ${THREAD_CARD_HEADER_PREVIEW_CLASS}`} title={messageKind.kind === 'inter-agent' && messageKind.previewSessionId ? `From ${messageKind.previewSessionId}:` : preview}>
              {messageKind.previewSessionId ? (
                <>From <span onClick={(event) => event.stopPropagation()}><SessionHashLink sessionId={messageKind.previewSessionId} /></span>:{messageKind.kind !== 'inter-agent' ? ` ${preview.slice(messageKind.previewPrefix.length)}` : null}</>
              ) : preview}
            </span>
          )}
        </div>
        {!expanded && interAgentPreview && (
          <div className="foxwarm-system-message-result-preview mt-1 whitespace-pre-wrap break-all pr-2 text-slate-700 dark:text-slate-300" style={{ ...clampContentStyle(3), opacity: 0.92 }}>
            {interAgentPreview}
          </div>
        )}
        {expanded && (
          <pre className="foxwarm-system-message-body max-w-full whitespace-pre-wrap break-words font-sans text-sm" style={{ lineHeight: '1.5em' }}>
            {renderedText.split('\n').map((line, lineIdx, lines) => {
              const isPrefix = isSystemLikeText(line)
              const nextIsPrefix = lineIdx < lines.length - 1 && isSystemLikeText(lines[lineIdx + 1])
              return (
                <span
                  key={`${messageKey}-${lineIdx}`}
                  style={isPrefix
                    ? { display: 'block', fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }
                    : { opacity: 0.92 }
                  }
                >
                  {renderSystemTextWithSessionLinks(line)}{!isPrefix && !nextIsPrefix ? '\n' : null}
                </span>
              )
            })}
          </pre>
        )}
      </div>
      <ImageParts imageParts={msg.parts.filter(p => p.inlineData)} keyPrefix={messageKey} />
    </div>
  )
})

const AssistantTextCard = memo(function AssistantTextCard({ text, message, showRetryButton, onRetry, onOpenCodeCommit }: { text: string; message: Message; showRetryButton?: boolean; onRetry?: () => void; onOpenCodeCommit?: OpenCodeCommitHandler }) {
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const jsonText = useMemo(() => viewMode === 'json' ? JSON.stringify(message, null, 2) : '', [message, viewMode])
  const renderedSegments = useMemo(() => splitCommitMarkers(text), [text])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

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
      console.error('Failed to copy raw text:', error)
    }
  }, [text])

  const paddingClass = viewMode === 'rendered' ? 'px-2' : 'px-2 py-2'

  return (
    <div className={`foxwarm-assistant-message-card min-w-0 max-w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${paddingClass} rounded-lg cursor-text relative group`}>
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
      </div>

      {viewMode === 'rendered' ? (
        <div className="foxwarm-assistant-message-markdown">
          {renderedSegments.map((segment, index) => segment.kind === 'markdown' ? (
            <MarkdownContent
              key={`markdown-${index}`}
              text={segment.text}
              className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100 prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
            />
          ) : segment.kind === 'commit' ? (
            <CommitMarkerCard key={`commit-${index}-${segment.target.commitId}`} target={segment.target} onOpen={onOpenCodeCommit} />
          ) : (
            <pre key={`invalid-commit-${index}`} className="my-2 whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 px-2 py-1.5 font-mono text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" title="Invalid Foxwarm commit marker">
              {segment.raw}
            </pre>
          ))}
        </div>
      ) : viewMode === 'raw' ? (
        <pre className="foxwarm-assistant-message-raw max-w-full whitespace-pre-wrap break-words font-mono text-sm text-gray-900 dark:text-gray-100">{text}</pre>
      ) : (
        <pre className="foxwarm-assistant-message-raw max-w-full whitespace-pre-wrap break-words font-mono text-sm text-gray-900 dark:text-gray-100">{jsonText}</pre>
      )}
      {showRetryButton && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRetry?.() }}
            className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50 dark:focus:ring-red-800"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
})

interface MessageRowProps {
  messageKey: string
  msg: Message
  prevMsg: Message | null
  nextMsg: Message | null
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
  groupKey: string
  summaryTagItems: ToolTagItem[]
  groupUsage: NormalizedTokenUsage | null
  groupUsageCallCount: number
  groupUsageAttribution: UsageAttribution
  keepToolGroupExpanded: boolean
  showToolGroupSummary: boolean
  groupExpanded: boolean
  onExpandGroup: (groupKey: string) => void
  sessionId: string
  nestedDepth: number
  onRetryFinalFailure?: () => void
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  renderNestedMessages: (messages: Message[], keyPrefix: string, nestedDepth: number) => ReactNode
}

const MessageRow = memo(function MessageRow({
  messageKey,
  msg,
  prevMsg,
  nextMsg,
  isMobile,
  groupTools,
  showUsageBadge,
  groupKey,
  summaryTagItems,
  groupUsage,
  groupUsageCallCount,
  groupUsageAttribution,
  keepToolGroupExpanded,
  showToolGroupSummary,
  groupExpanded,
  onExpandGroup,
  sessionId,
  nestedDepth,
  onRetryFinalFailure,
  onOpenCodeFile,
  onOpenCodeCommit,
  renderNestedMessages,
}: MessageRowProps) {
  const textLikeParts = useMemo(() => msg.parts.filter(p => p.text || p.system || p.thinking), [msg.parts])
  const imageParts = useMemo(() => msg.parts.filter(p => p.inlineData), [msg.parts])
  const usage = useMemo(() => getModelMessageUsage(msg), [msg])
  const isInToolGroup = summaryTagItems.length > 0
  const hasToolParts = useMemo(() => msg.parts.some(p => p.functionCall || p.functionResponse || p.thinking), [msg.parts])
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const systemLikeMessage = useMemo(() => isHeavySystemLikeMessage(msg), [msg])
  const isThreadLikeMessage = systemLikeMessage || msg.role === 'model' || msg.role === 'tool'
  const previousIsThreadLike = !!prevMsg && (isHeavySystemLikeMessage(prevMsg) || prevMsg.role === 'model' || prevMsg.role === 'tool')
  const shouldSkipMargin = isThreadLikeMessage && previousIsThreadLike
  const isCollapsedToolGroup = groupTools && isInToolGroup && !groupExpanded && !keepToolGroupExpanded
  const hasInterleavedToolGroup = !!(nextMsg && nextMsg.role === 'tool' && nextMsg.parts.some(p => p.functionResponse) && msg.parts.some(p => p.functionCall))
  const displayUsage = showUsageBadge
    ? (isCollapsedToolGroup ? (showToolGroupSummary ? groupUsage : null) : usage)
    : null
  const displayUsageCallCount = isCollapsedToolGroup && showToolGroupSummary && groupUsageCallCount > 0 ? groupUsageCallCount : undefined
  const displayUsageAttribution = isCollapsedToolGroup ? groupUsageAttribution : usage ? getMessageUsageAttribution(msg) : null
  const allowOverflow = (displayUsage && !isMobile) || hasToolParts || isInToolGroup
  const contextBlock = useMemo(() => msg.role === 'model' ? getContextBlockMetaFromMessage(msg) : null, [msg])
  const firstTextPartIndex = useMemo(() => msg.parts.findIndex(p => typeof p.text === 'string' && p.text.trim()), [msg.parts])
  const marginClass = nestedDepth > 0 ? 'mt-2' : (shouldSkipMargin ? '' : 'mt-4')
  const widthClass = systemLikeMessage
    ? (isMobile || nestedDepth > 0 ? 'w-full' : 'w-full max-w-[80%]')
    : msg.role === 'user'
      ? (nestedDepth > 0 ? 'max-w-[85%]' : 'max-w-[80%]')
      : isMobile || nestedDepth > 0
        ? 'w-full'
        : 'w-full max-w-[80%]'

  return (
    <div
      className={`flex w-full min-w-0 max-w-full ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${marginClass}`}
      data-chat-message-anchor-key={nestedDepth === 0 ? getMessageViewportAnchorKey(msg) || undefined : undefined}
      data-context-scrollbar-anchor-key={nestedDepth === 0 ? getContextScrollbarAnchorKey(msg) || undefined : undefined}
    >
      <div
        className={`min-w-0 ${widthClass} ${
          !systemLikeMessage && msg.role === 'user'
            ? 'foxwarm-user-message-bubble bg-blue-500 dark:bg-blue-600 text-white px-4 py-2 rounded-lg'
            : ''
        } ${allowOverflow ? 'overflow-visible' : 'overflow-x-hidden'}`}
      >
        {systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={messageKey} />
        ) : msg.role === 'user' ? (
          <div className="flex min-w-0 flex-col">
            {textLikeParts.map((part, partIdx) => (
              <div key={`user-part-${partIdx}`}>
                {part.system
                  ? <InlineMetaPart systemText={formatStructuredSystemText(part.system)} isUser={true} />
                  : <CollapsibleUserText text={part.text || ''} />}
              </div>
            ))}
            <ImageParts imageParts={imageParts} keyPrefix={`user-${messageKey}`} />
          </div>
        ) : (
          <div className={`flex min-w-0 max-w-full flex-col ${displayUsage && !isMobile ? 'relative' : ''}`}>
            {textLikeParts.map((part, partIdx) => {
              if (part.system) {
                return <InlineMetaPart key={`model-system-${partIdx}`} systemText={formatStructuredSystemText(part.system)} isUser={false} />
              }
              if (part.thinking) {
                if (groupTools && !hasVisibleTextContent && isInToolGroup && !groupExpanded) {
                  return null
                }
                return <ReasoningCard key={`thinking-${partIdx}`} thinking={part.thinking} tone="message" />
              }
              if (contextBlock && partIdx === firstTextPartIndex && part.text) {
                return <ContextBlockCard key={`ctx-block-${contextBlock.id}`} sessionId={sessionId} messageKey={messageKey} block={contextBlock} text={part.text} nestedDepth={nestedDepth} renderNestedMessages={renderNestedMessages} />
              }
              return <AssistantTextCard key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} showRetryButton={isFinalLlmRetryNotice(msg)} onRetry={onRetryFinalFailure} onOpenCodeCommit={onOpenCodeCommit} />
            })}
            <ImageParts imageParts={imageParts} keyPrefix={`message-${messageKey}`} />
            {groupTools && showToolGroupSummary && !groupExpanded && !keepToolGroupExpanded && (
              <ToolGroupSummaryCard items={summaryTagItems} onExpand={() => onExpandGroup(groupKey)} />
            )}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup && nextMsg ? <InterleavedToolGroup msg={msg} nextMsg={nextMsg} messageKeyPrefix={messageKey} onOpenCodeFile={onOpenCodeFile} /> : <ToolCallsBlock msg={msg} onOpenCodeFile={onOpenCodeFile} />)}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup ? null : <ToolResponsesBlock msg={msg} />)}
            {displayUsage && displayUsageAttribution && <ModelUsageAnchor usage={displayUsage} isMobile={isMobile} callCount={displayUsageCallCount} attribution={displayUsageAttribution} />}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => (
  prev.msg === next.msg &&
  prev.messageKey === next.messageKey &&
  prev.prevMsg === next.prevMsg &&
  prev.nextMsg === next.nextMsg &&
  prev.isMobile === next.isMobile &&
  prev.groupTools === next.groupTools &&
  prev.showUsageBadge === next.showUsageBadge &&
  prev.groupKey === next.groupKey &&
  prev.summaryTagItems === next.summaryTagItems &&
  prev.groupUsage === next.groupUsage &&
  prev.groupUsageCallCount === next.groupUsageCallCount &&
  prev.groupUsageAttribution === next.groupUsageAttribution &&
  prev.keepToolGroupExpanded === next.keepToolGroupExpanded &&
  prev.showToolGroupSummary === next.showToolGroupSummary &&
  prev.groupExpanded === next.groupExpanded &&
  prev.sessionId === next.sessionId &&
  prev.nestedDepth === next.nestedDepth &&
  prev.onRetryFinalFailure === next.onRetryFinalFailure &&
  prev.onOpenCodeFile === next.onOpenCodeFile &&
  prev.onOpenCodeCommit === next.onOpenCodeCommit &&
  prev.renderNestedMessages === next.renderNestedMessages
))

const ChatTimeline = memo(function ChatTimeline({ sessionId, messages, isMobile, groupTools, showUsageBadge, onRetryFinalFailure, onOpenCodeFile, onOpenCodeCommit, nestedDepth = 0 }: ChatTimelineProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())

  const renderNestedMessages = useCallback((nestedMessages: Message[], keyPrefix: string, nextNestedDepth: number) => (
    <ChatTimeline
      key={keyPrefix}
      sessionId={sessionId}
      messages={nestedMessages}
      isMobile={isMobile}
      groupTools={groupTools}
      showUsageBadge={nextNestedDepth > 0 ? false : showUsageBadge}
      onRetryFinalFailure={onRetryFinalFailure}
      onOpenCodeFile={onOpenCodeFile}
      onOpenCodeCommit={onOpenCodeCommit}
      nestedDepth={nextNestedDepth}
    />
  ), [groupTools, isMobile, onOpenCodeCommit, onOpenCodeFile, onRetryFinalFailure, sessionId, showUsageBadge])

  const toolGroupMeta = useMemo(() => {
    const messageKeys = messages.map((msg, idx) => getMessageStableKey(msg, idx))
    const hasTextContent = (msg: Message) => msg.parts.some((p) => (p.text && p.text.trim()) || (p.system && String(p.system).trim()))
    const hasToolCalls = (msg: Message) => msg.parts.some((p) => p.functionCall)
    const hasToolResponses = (msg: Message) => msg.parts.some((p) => p.functionResponse)

    const lastIdx = messages.length - 1
    const finalStandaloneStartIdx = (() => {
      if (lastIdx < 0) return -1

      const lastMsg = messages[lastIdx]
      if (!lastMsg) return -1

      if (lastMsg.role === 'tool' && hasToolResponses(lastMsg)) {
        if (lastIdx > 0) {
          const prevMsg = messages[lastIdx - 1]
          if (prevMsg?.role === 'model' && hasToolCalls(prevMsg)) {
            return lastIdx - 1
          }
        }
        return lastIdx
      }

      if (lastMsg.role === 'model' && hasToolCalls(lastMsg)) {
        return lastIdx
      }

      return -1
    })()

    const shouldStopAtIdx = (startIdx: number, idx: number) => (
      finalStandaloneStartIdx !== -1 && startIdx < finalStandaloneStartIdx && idx >= finalStandaloneStartIdx
    )

    const getToolGroupStartIdx = (idx: number) => {
      if (finalStandaloneStartIdx !== -1 && idx >= finalStandaloneStartIdx) {
        return finalStandaloneStartIdx
      }

      const currentMsg = messages[idx]
      if (currentMsg.role === 'model' && hasTextContent(currentMsg)) {
        return idx
      }

      let start = idx
      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m)) {
          return hasToolCalls(m) ? i : start
        }
        start = i
      }
      return start
    }

    const getToolGroupSummaryItems = (startIdx: number): ToolTagItem[] => {
      const items: ToolTagItem[] = []
      const toolStatusById = new Map<string, 'success' | 'error'>()

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        m.parts.forEach((p) => {
          if (p.functionResponse?.tool_use_id) {
            const nextStatus = getToolResponseStatus(p.functionResponse)
            const prevStatus = toolStatusById.get(p.functionResponse.tool_use_id)
            toolStatusById.set(
              p.functionResponse.tool_use_id,
              prevStatus === 'error' || nextStatus === 'error' ? 'error' : 'success'
            )
          }
        })
      }

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        m.parts.forEach((p) => {
          if (p.thinking && p.thinking.trim() && !hasTextContent(m)) {
            items.push({ name: 'reasoning', tone: 'neutral' })
          }
          if (p.functionCall) {
            const status = p.functionCall.id ? toolStatusById.get(p.functionCall.id) : undefined
            items.push({
              name: p.functionCall.name,
              label: formatToolLabel(p.functionCall.name, p.functionCall.args),
              tone: status === 'error' ? 'error' : status === 'success' ? 'success' : 'neutral',
            })
          }
        })
      }
      return items
    }

    const getToolGroupUsage = (startIdx: number): { usage: NormalizedTokenUsage | null; callCount: number; attribution: UsageAttribution } => {
      const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
      let callCount = 0
      const attribution: UsageAttribution = { models: [], timestamps: [] }

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        if (m.role === 'model') {
          const usage = getModelMessageUsage(m)
          if (usage) {
            total.cachedTokens += usage.cachedTokens
            total.inputTokens += usage.inputTokens
            total.outputTokens += usage.outputTokens
            callCount++
            const messageAttribution = getMessageUsageAttribution(m)
            attribution.models.push(...messageAttribution.models)
            attribution.timestamps.push(...messageAttribution.timestamps)
          }
        }
      }

      return { usage: callCount > 0 ? total : null, callCount, attribution }
    }

    const startIdxByIndex = messages.map((_, idx) => getToolGroupStartIdx(idx))
    const summaryTagItemsByStart = new Map<number, ToolTagItem[]>()
    const groupUsageByStart = new Map<number, NormalizedTokenUsage | null>()
    const groupUsageCallCountByStart = new Map<number, number>()
    const groupUsageAttributionByStart = new Map<number, UsageAttribution>()
    const keepExpandedByStart = new Map<number, boolean>()
    startIdxByIndex.forEach((startIdx) => {
      if (!summaryTagItemsByStart.has(startIdx)) {
        const items = getToolGroupSummaryItems(startIdx)
        const groupUsage = getToolGroupUsage(startIdx)
        summaryTagItemsByStart.set(startIdx, items)
        groupUsageByStart.set(startIdx, groupUsage.usage)
        groupUsageCallCountByStart.set(startIdx, groupUsage.callCount)
        groupUsageAttributionByStart.set(startIdx, groupUsage.attribution)
        keepExpandedByStart.set(startIdx, startIdx === finalStandaloneStartIdx)
      }
    })

    return {
      handledByPreviousGroup: messages.map((msg, idx) => {
        if (msg.role !== 'tool' || idx === 0) return false
        const prevMsg = messages[idx - 1]
        return prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)
      }),
      messageKeyByIndex: messageKeys,
      groupKeyByIndex: startIdxByIndex.map((startIdx) => `${messageKeys[startIdx] || `idx-${startIdx}`}-toolgroup`),
      summaryTagItemsByIndex: startIdxByIndex.map((startIdx) => summaryTagItemsByStart.get(startIdx) || EMPTY_TOOL_TAG_ITEMS),
      groupUsageByIndex: startIdxByIndex.map((startIdx) => groupUsageByStart.get(startIdx) || null),
      groupUsageCallCountByIndex: startIdxByIndex.map((startIdx) => groupUsageCallCountByStart.get(startIdx) || 0),
      groupUsageAttributionByIndex: startIdxByIndex.map((startIdx) => groupUsageAttributionByStart.get(startIdx) || { models: [], timestamps: [] }),
      keepExpandedByIndex: startIdxByIndex.map((startIdx) => keepExpandedByStart.get(startIdx) || false),
      shouldRenderSummary: startIdxByIndex.map((startIdx, idx) => idx === startIdx && (summaryTagItemsByStart.get(startIdx)?.length || 0) > 0),
    }
  }, [messages])

  const handleExpandGroup = useCallback((groupKey: string) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev)
      next.add(groupKey)
      return next
    })
  }, [])

  return (
    <div className="foxwarm-chat-timeline min-w-0 max-w-full overflow-x-hidden">
      {messages.map((msg, idx) => {
        if (toolGroupMeta.handledByPreviousGroup[idx]) {
          return null
        }

        const groupKey = toolGroupMeta.groupKeyByIndex[idx]
        const messageKey = toolGroupMeta.messageKeyByIndex[idx]
        return (
          <MessageRow
            key={messageKey}
            messageKey={messageKey}
            msg={msg}
            prevMsg={idx > 0 ? messages[idx - 1] : null}
            nextMsg={idx < messages.length - 1 ? messages[idx + 1] : null}
            isMobile={isMobile}
            groupTools={groupTools}
            showUsageBadge={showUsageBadge}
            groupKey={groupKey}
            summaryTagItems={toolGroupMeta.summaryTagItemsByIndex[idx]}
            groupUsage={toolGroupMeta.groupUsageByIndex[idx]}
            groupUsageCallCount={toolGroupMeta.groupUsageCallCountByIndex[idx]}
            groupUsageAttribution={toolGroupMeta.groupUsageAttributionByIndex[idx]}
            keepToolGroupExpanded={toolGroupMeta.keepExpandedByIndex[idx]}
            showToolGroupSummary={toolGroupMeta.shouldRenderSummary[idx]}
            groupExpanded={expandedToolGroups.has(groupKey)}
            onExpandGroup={handleExpandGroup}
            sessionId={sessionId}
            nestedDepth={nestedDepth}
            onRetryFinalFailure={onRetryFinalFailure}
            onOpenCodeFile={onOpenCodeFile}
      onOpenCodeCommit={onOpenCodeCommit}
            renderNestedMessages={renderNestedMessages}
          />
        )
      })}
    </div>
  )
})

export default ChatTimeline
