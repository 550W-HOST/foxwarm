import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, Code, FileJson, Copy, Check, Hourglass, Cloud } from 'lucide-react'
import {
  IconToggleButton,
  copyTextToClipboard,
  clampContentStyle,
  formatStructuredSystemText,
  getSystemMessagePreviewDescriptor,
  isCollapsibleSystemText,
  isLightweightSystemTextLine,
  isSystemLikeText,
  parseFoxwarmMetadataLine,
  renderAssistantMarkdownSegments,
  handleMarkdownLinkClick,
  renderSystemTextWithSessionLinks,
  SessionHashLink,
  THREAD_CARD_HEADER_PREVIEW_CLASS,
  THREAD_CARD_HEADER_ROW_CLASS,
  ToolTag,
  type Message,
  type OpenAIResponsesAnnotation,
  type ViewMode,
} from './chatShared'
import ImageParts, { ImageItem } from './ImageParts'
import ReasoningCard from './ReasoningCard'
import MarkdownHtmlSegment from './MarkdownHtmlSegment'
import WebSearchCard from './WebSearchCard'
import { getWebSearchAction, type WebSearchAction } from '../webSearchAction'
import ContextBlockCard, { getContextBlockMetaFromMessage } from './ContextBlockCard'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'
import CommitMarkerCard, { type OpenCodeCommitHandler } from './CommitMarkerCard'
import { splitCommitMarkers } from '../commitMarker'
import {
  InterleavedToolGroup,
  ToolCallsBlock,
  ToolGroupSummaryCard,
  ToolResponsesBlock,
  type OpenCodeFileHandler,
} from './ToolTimelineItems'
import ThreadLineButton from './ThreadLineButton'
import SpecialBlock, { MermaidDiagram } from './SpecialBlock'
import PastedTextBlock from './PastedTextBlock'
import { PASTED_TEXT_CLOSE, PASTED_TEXT_OPEN, parsePastedTextSegments, type PastedTextSegment } from '../pastedText'
import { splitGeneratedAttachmentName } from '../attachmentRefs'
import {
  formatCompactDuration,
  formatDetailedDuration,
  summarizeDurationSamples,
  type DurationSample,
} from '../usageTiming'
import {
  buildTimelineRows,
  type NormalizedTokenUsage,
  type TimelineRowView,
  type TimelineRowsCache,
  type UsageAttribution,
} from './timelineRows'

interface ChatTimelineProps {
  sessionId: string
  messages: Message[]
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
  showUserMessageMetadata?: boolean
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  nestedDepth?: number
}

const getUsageTotalTokens = (usage: NormalizedTokenUsage) => (
  usage.cachedTokens + usage.inputTokens + usage.outputTokens
)

const formatTokenCount = (count: number): string => {
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`
  return String(count)
}

const formatUsageTitle = (usage: NormalizedTokenUsage, attribution: UsageAttribution, callCount?: number) => {
  const total = getUsageTotalTokens(usage)
  const api = summarizeDurationSamples(attribution.apiDurationsMs).totalMs
  const between = summarizeDurationSamples(attribution.betweenRequestsMs).totalMs
  return `Token usage: ${total} total • input ${usage.inputTokens} • output ${usage.outputTokens} • cached ${usage.cachedTokens}${callCount ? ` • calls ${callCount}` : ''}${between === null ? '' : ` • between ${formatDetailedDuration(between)}`}${api === null ? '' : ` • API ${formatDetailedDuration(api)}`}`
}

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

const formatDurationSummary = (samples: DurationSample[]): string => {
  const summary = summarizeDurationSamples(samples)
  const labels: string[] = []
  if (summary.totalMs !== null) labels.push(formatDetailedDuration(summary.totalMs))
  if (summary.unavailableCount > 0) labels.push('unavailable')
  if (summary.invalidCount > 0) labels.push('invalid timing')
  return labels.join(' • ') || 'unavailable'
}

const MIN_COLLAPSED_BETWEEN_REQUESTS_MS = 60_000

const ModelUsageRow = ({ label, value, tone }: { label: string; value: number; tone: 'normal' | 'warning' }) => {
  const colorClass = tone === 'warning'
    ? 'text-fw-warning dark:text-fw-warning'
    : 'text-fw-text-muted dark:text-fw-text-muted'

  return (
    <span className={`flex items-baseline justify-between gap-1 ${colorClass}`}>
      <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
      <span className="text-[10px] font-semibold tabular-nums">{formatTokenCount(value)}</span>
    </span>
  )
}

const ModelUsageTextRow = ({ label, value }: { label: string; value: string }) => (
  <span className="flex min-w-0 items-baseline justify-between gap-2 text-fw-text-muted">
    <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">{label}</span>
    <span className="min-w-0 break-all text-right text-[10px] font-semibold leading-snug tabular-nums">{value}</span>
  </span>
)

const ModelUsageBadge = memo(function ModelUsageBadge({ usage, isMobile, callCount, attribution, expanded, onToggle }: {
  usage: NormalizedTokenUsage
  isMobile: boolean
  callCount?: number
  attribution: UsageAttribution
  expanded: boolean
  onToggle: () => void
}) {
  const stopUsageBadgeEvent = (event: { stopPropagation: () => void }) => event.stopPropagation()
  const apiDurationMs = summarizeDurationSamples(attribution.apiDurationsMs).totalMs
  const betweenRequestsMs = summarizeDurationSamples(attribution.betweenRequestsMs).totalMs
  const collapsedBetweenRequestsMs = betweenRequestsMs !== null && betweenRequestsMs >= MIN_COLLAPSED_BETWEEN_REQUESTS_MS
    ? betweenRequestsMs
    : null

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide request usage and timing details' : 'Show request usage and timing details'}
      data-usage-badge
      className={`${expanded ? 'flex max-w-full flex-col items-stretch gap-1.5 text-left' : `${isMobile ? 'gap-2' : 'gap-1.5'} inline-flex flex-row items-center`} pointer-events-auto rounded-md border border-fw-border bg-fw-surface/85 px-2 py-1 font-mono leading-none shadow-sm backdrop-blur dark:border-fw-border dark:bg-fw-canvas/85 ${expanded ? 'w-fit' : ''} cursor-pointer appearance-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-focus-ring`}
      title={formatUsageTitle(usage, attribution, callCount)}
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
          <ModelUsageRow label="Cached" value={usage.cachedTokens} tone="normal" />
          <ModelUsageRow label="Input" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="Output" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
          <ModelUsageTextRow label="Between" value={formatDurationSummary(attribution.betweenRequestsMs)} />
          <ModelUsageTextRow label="API" value={formatDurationSummary(attribution.apiDurationsMs)} />
          <ModelUsageTextRow label="Time" value={formatUsageTimes(attribution.timestamps)} />
          <ModelUsageTextRow label="Model" value={formatUsageModels(attribution.models)} />
        </>
      ) : (
        <>
          {callCount ? <ModelUsageRow label="×" value={callCount} tone="normal" /> : null}
          <ModelUsageRow label="C" value={usage.cachedTokens} tone="normal" />
          <ModelUsageRow label="I" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="O" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
          {(collapsedBetweenRequestsMs !== null || apiDurationMs !== null) ? (
            <span
              data-usage-timing-summary
              className="inline-flex items-center gap-2 border-l border-fw-border pl-2"
            >
              {collapsedBetweenRequestsMs !== null ? (
                <span
                  data-usage-timing-kind="between"
                  className="inline-flex items-center gap-1 text-fw-text-subtle"
                  title={`Between requests: ${formatDetailedDuration(collapsedBetweenRequestsMs)}`}
                >
                  <Hourglass aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={1.8} />
                  <span className="text-[10px] font-semibold tabular-nums">{formatCompactDuration(collapsedBetweenRequestsMs)}</span>
                </span>
              ) : null}
              {apiDurationMs !== null ? (
                <span
                  data-usage-timing-kind="api"
                  className="inline-flex items-center gap-1 text-fw-text"
                  title={`API response: ${formatDetailedDuration(apiDurationMs)}`}
                >
                  <Cloud aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={1.8} />
                  <span className="text-[10px] font-semibold tabular-nums">{formatCompactDuration(apiDurationMs)}</span>
                </span>
              ) : null}
            </span>
          ) : null}
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
  const segments = useMemo(() => renderAssistantMarkdownSegments(text), [text])
  return (
    <div className={`min-w-0 max-w-full ${className}`} onClick={handleMarkdownLinkClick}>
      {segments.map((segment) => {
        if (segment.kind === 'html') {
          return <MarkdownHtmlSegment key={`markdown-token-${segment.tokenIndex}`} html={segment.html} />
        }
        if (segment.kind === 'latex') {
          return (
            <SpecialBlock key={`markdown-token-${segment.tokenIndex}`} kind="latex" label="LaTeX" raw={segment.raw}>
              <div className="foxwarm-special-block-latex min-w-0 max-w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: segment.html }} />
            </SpecialBlock>
          )
        }
        return (
          <SpecialBlock key={`markdown-token-${segment.tokenIndex}`} kind="mermaid" label="Mermaid" raw={segment.raw}>
            <MermaidDiagram source={segment.source} />
          </SpecialBlock>
        )
      })}
    </div>
  )
})

const isUserAttachmentMetadataLine = (line: string): boolean => {
  const tag = parseFoxwarmMetadataLine(line)
  return tag?.tagName === 'foxwarm-image' || tag?.tagName === 'foxwarm-file'
}

const shouldRenderUserLine = (line: string, showUserMessageMetadata: boolean): boolean => (
  showUserMessageMetadata || !isLightweightSystemTextLine(line) || isUserAttachmentMetadataLine(line)
)

const renderUserPreLines = (text: string, showUserMessageMetadata: boolean, metadataLineHeight: string, renderLine: (line: string, lineIndex: number) => ReactNode): ReactNode => {
  const visibleLines = text.split('\n')
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => shouldRenderUserLine(line, showUserMessageMetadata))
  return visibleLines.map(({ line, lineIndex }, visibleIndex) => (
    <span key={lineIndex} className="foxwarm-user-rendered-line">
      {renderLine(line, lineIndex)}
      {visibleIndex < visibleLines.length - 1 && (
        <span
          className="foxwarm-user-rendered-line-break"
          style={isSystemLikeText(line)
            ? { fontSize: '70%', lineHeight: metadataLineHeight, opacity: 0.7 }
            : { fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
          }
        >
          {'\n'}
        </span>
      )}
    </span>
  ))
}

const InlineMetaPart = memo(function InlineMetaPart({ systemText, isUser, showUserMessageMetadata = true }: { systemText: string; isUser: boolean; showUserMessageMetadata?: boolean }) {
  return (
    <pre
      className={`max-w-full whitespace-pre-wrap break-words font-sans ${isUser ? 'foxwarm-user-line-layout text-fw-user-text' : 'text-fw-text-muted'}`}
      style={{ lineHeight: isUser ? 0 : '1.3em' }}
    >
      {isUser
        ? renderUserPreLines(systemText, showUserMessageMetadata, '1.1em', (line) => {
            const isMetaLine = isSystemLikeText(line)
            return (
              <span
                className={isMetaLine ? 'foxwarm-lightweight-metadata-line' : undefined}
                style={isMetaLine
                  ? { fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }
                  : { fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
                }
              >
                {renderSystemTextWithSessionLinks(line)}
              </span>
            )
          })
        : systemText.split('\n').map((line, lineIdx) => {
            const isMetaLine = isSystemLikeText(line)
            return (
              <span
                key={lineIdx}
                className={isMetaLine ? 'foxwarm-lightweight-metadata-line' : undefined}
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

type AttachmentCorrelation = {
  ref: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  descriptorText: string
  imagePart?: Message['parts'][number]
}

function getPartDisplayText(part: Message['parts'][number]): string {
  return part.text || (part.system ? formatStructuredSystemText(part.system) : '')
}

function getStandaloneUserChannelWrapperBoundary(part: Message['parts'][number]): 'open' | 'close' | null {
  if (typeof part.system !== 'string' || part.system.includes('\n') || part.system.trim() !== part.system) return null
  const tag = parseFoxwarmMetadataLine(part.system)
  if (tag?.tagName !== 'foxwarm-message') return null
  if (tag.closing) return 'close'
  return tag.attrs.type === 'channel' ? 'open' : null
}

function getInlineUserWrapperBoundaries(parts: Message['parts']): { open: number; close: number } | null {
  const open = parts.findIndex(part => getStandaloneUserChannelWrapperBoundary(part) === 'open')
  if (open < 0) return null
  const closeOffset = parts.slice(open + 1).findIndex(part => getStandaloneUserChannelWrapperBoundary(part) === 'close')
  return closeOffset < 0 ? null : { open, close: open + closeOffset + 1 }
}

function UserWrapperBoundaryBreak({ afterMetadata }: { afterMetadata: boolean }) {
  return (
    <span
      data-user-wrapper-boundary={afterMetadata ? 'after-open' : 'before-close'}
      className="foxwarm-user-rendered-line-break"
      style={afterMetadata
        ? { whiteSpace: 'pre-wrap', fontSize: '70%', lineHeight: '1em', opacity: 0.7 }
        : { whiteSpace: 'pre-wrap', fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
      }
    >
      {'\n'}
    </span>
  )
}

function findAttachmentCorrelations(parts: Message['parts']): Map<string, AttachmentCorrelation> {
  const correlations = new Map<string, AttachmentCorrelation>()
  const activeRefs = new Set<string>()
  for (const part of parts) {
    for (const segment of parsePastedTextSegments(getPartDisplayText(part))) {
      if (segment.kind !== 'text') continue
      for (const match of segment.text.matchAll(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g)) activeRefs.add(match[1])
    }
  }
  parts.forEach((part, partIndex) => {
    for (const segment of parsePastedTextSegments(getPartDisplayText(part))) {
      if (segment.kind !== 'text') continue
      for (const line of segment.text.split('\n')) {
        const descriptorText = line.trim()
        const parsed = parseFoxwarmMetadataLine(descriptorText)
        if (!parsed || parsed.closing || (parsed.tagName !== 'foxwarm-image' && parsed.tagName !== 'foxwarm-file')) continue
        const generated = splitGeneratedAttachmentName(parsed.attrs.name || '')
        if (!generated || !activeRefs.has(generated.ref) || correlations.has(generated.ref)) continue
        const imagePart = parsed.tagName === 'foxwarm-image' ? parts[partIndex + 1] : undefined
        correlations.set(generated.ref, {
          ref: generated.ref,
          kind: parsed.tagName === 'foxwarm-image' ? 'image' : 'file',
          name: generated.originalName,
          mimeType: parsed.attrs.mime || imagePart?.inlineDataRef?.mimeType || imagePart?.inlineData?.mimeType || '',
          descriptorText,
          ...(imagePart && (imagePart.inlineData || imagePart.inlineDataRef || imagePart.inlineDataUnavailable) ? { imagePart } : {}),
        })
      }
    }
  })
  return correlations
}

function stripGeneratedDescriptorLines(text: string, correlations: Map<string, AttachmentCorrelation>): string {
  const descriptors = new Set([...correlations.values()].map(item => item.descriptorText))
  return parsePastedTextSegments(text).map(segment => segment.kind === 'pasted-text'
    ? `${PASTED_TEXT_OPEN}${segment.text}${PASTED_TEXT_CLOSE}`
    : segment.text.split('\n').filter(line => !descriptors.has(line.trim())).join('\n')).join('')
}

function AttachmentHistoryBlock({ correlation }: { correlation: AttachmentCorrelation }) {
  const { ref, kind, name, mimeType: mime, imagePart } = correlation
  return (
    <span className="foxwarm-inline-history-attachment my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-fw-border bg-fw-surface-raised px-2 py-1.5 align-middle text-sm shadow-sm" data-attachment-ref={ref}>
      {kind === 'image' && imagePart
        ? <ImageItem part={imagePart} label={name} imageClassName="h-12 w-12 shrink-0 object-cover" />
        : <span aria-hidden="true">{kind === 'image' ? '🖼' : '📎'}</span>}
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        {mime && <span className="block truncate text-xs text-fw-text-muted">{mime}</span>}
      </span>
    </span>
  )
}

const CollapsibleUserText = memo(function CollapsibleUserText({ part, showUserMessageMetadata, correlations, inlineFlow = false }: { part: Message['parts'][number]; showUserMessageMetadata: boolean; correlations: Map<string, AttachmentCorrelation>; inlineFlow?: boolean }) {
  const text = stripGeneratedDescriptorLines(getPartDisplayText(part), correlations)
  const segments = useMemo<Array<PastedTextSegment | { kind: 'attachment'; tagText: string; ref: string }>>(() => {
    const output: Array<PastedTextSegment | { kind: 'attachment'; tagText: string; ref: string }> = []
    for (const segment of parsePastedTextSegments(text)) {
      if (segment.kind === 'pasted-text') { output.push(segment); continue }
      let cursor = 0
      for (const match of segment.text.matchAll(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g)) {
        const index = match.index || 0
        if (index > cursor) output.push({ kind: 'text', text: segment.text.slice(cursor, index) })
        if (correlations.has(match[1])) output.push({ kind: 'attachment', tagText: match[0], ref: match[1] })
        else output.push({ kind: 'text', text: match[0] })
        cursor = index + match[0].length
      }
      if (cursor < segment.text.length) output.push({ kind: 'text', text: segment.text.slice(cursor) })
    }
    return output
  }, [correlations, text])
  const visibleClassificationText = useMemo(
    () => segments.filter((segment): segment is Extract<typeof segments[number], { kind: 'text' }> => segment.kind === 'text').map(segment => segment.text).join(''),
    [segments],
  )
  const isSystemMessage = isCollapsibleSystemText(visibleClassificationText)
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = isSystemMessage && !expanded

  return (
    <div className={inlineFlow ? 'contents' : undefined}>
      <div className={`${shouldCollapse ? 'overflow-hidden' : ''} ${inlineFlow ? 'contents' : ''}`} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}>
        <pre className={`foxwarm-user-message-text foxwarm-user-line-layout max-w-full whitespace-pre-wrap break-words font-sans ${inlineFlow ? 'inline' : ''}`} style={{ lineHeight: 0 }}>
          {segments.map((segment, segmentIndex) => segment.kind === 'attachment'
            ? <AttachmentHistoryBlock key={`attachment-${segmentIndex}`} correlation={correlations.get(segment.ref)!} />
            : segment.kind === 'pasted-text'
            ? <PastedTextBlock key={`pasted-${segmentIndex}`} text={segment.text} />
            : (
              <span key={`text-${segmentIndex}`}>
                {renderUserPreLines(segment.text, showUserMessageMetadata, '1em', (line) => {
                  const isPrefix = isSystemLikeText(line)
                  return (
                    <span
                      className={isPrefix ? 'foxwarm-lightweight-metadata-line' : undefined}
                      style={isPrefix
                        ? { fontSize: '70%', lineHeight: '1em', opacity: 0.7 }
                        : { fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
                      }
                    >
                      {line}
                    </span>
                  )
                })}
              </span>
            ))}
        </pre>
      </div>
      {isSystemMessage && (
        <button
          onClick={() => setExpanded(current => !current)}
          className="text-xs text-fw-accent hover:text-fw-text-inverse mt-1 text-left"
        >
          {expanded ? '▲ Show less' : '▼ Show more'}
        </button>
      )}
    </div>
  )
})

const SystemLikeMessageCard = memo(function SystemLikeMessageCard({ msg, messageKey }: { msg: Message; messageKey: string }) {
  const [expanded, setExpanded] = useState(false)
  const headerFade = useThreadCardOverflowFade<HTMLSpanElement>('right', !expanded)
  const resultFade = useThreadCardOverflowFade<HTMLDivElement>('bottom', !expanded)
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
  const surfaceClass = 'bg-fw-system-surface/55 dark:bg-fw-system-surface/10 text-fw-system-text'
  const threadLineClass = 'text-fw-system-accent hover:text-fw-system-accent focus-visible:text-fw-system-accent'
  const headerClass = 'bg-fw-system-surface-strong/80 dark:bg-fw-system-surface-strong/20'
  const headerHoverClass = 'hover:text-fw-system-accent'

  return (
    <div className="w-full min-w-0">
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
            <span ref={headerFade.ref} {...headerFade.overflowFadeProps} className={`foxwarm-system-message-preview ${THREAD_CARD_HEADER_PREVIEW_CLASS}`} title={messageKind.kind === 'inter-agent' && messageKind.previewSessionId ? `From ${messageKind.previewSessionId}:` : preview}>
              {messageKind.previewSessionId ? (
                <>From <span onClick={(event) => event.stopPropagation()}><SessionHashLink sessionId={messageKind.previewSessionId} /></span>:{messageKind.kind !== 'inter-agent' ? ` ${preview.slice(messageKind.previewPrefix.length)}` : null}</>
              ) : preview}
            </span>
          )}
        </div>
        {!expanded && interAgentPreview && (
          <div ref={resultFade.ref} {...resultFade.overflowFadeProps} className="foxwarm-system-message-result-preview mt-1 whitespace-pre-wrap break-all pr-2 text-fw-system-text" style={{ ...clampContentStyle(3), opacity: 0.92, ...resultFade.overflowFadeProps.style }}>
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
      <ImageParts imageParts={msg.parts.filter(p => p.inlineData || p.inlineDataRef || p.inlineDataUnavailable)} keyPrefix={messageKey} />
    </div>
  )
})

type WebSearchCitation = {
  url: string
  title: string
}

const normalizeWebSearchCitation = (annotation: OpenAIResponsesAnnotation): WebSearchCitation | null => {
  if (!annotation || typeof annotation !== 'object') return null
  const nested = annotation.url_citation && typeof annotation.url_citation === 'object' ? annotation.url_citation : annotation
  const url = typeof nested.url === 'string' ? nested.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) return null
  const title = typeof nested.title === 'string' && nested.title.trim() ? nested.title.trim() : url
  return { url, title }
}

const WebSearchCitationLinks = memo(function WebSearchCitationLinks({ annotations }: { annotations?: OpenAIResponsesAnnotation[] }) {
  const citations = useMemo(() => {
    const unique = new Map<string, WebSearchCitation>()
    for (const annotation of annotations || []) {
      const citation = normalizeWebSearchCitation(annotation)
      if (citation && !unique.has(citation.url)) unique.set(citation.url, citation)
    }
    return [...unique.values()]
  }, [annotations])

  if (citations.length === 0) return null
  return (
    <div className="my-2 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fw-text-muted" onClick={handleMarkdownLinkClick}>
      <span className="font-semibold">Sources:</span>
      {citations.map((citation, index) => (
        <a
          key={citation.url}
          data-web-search-citation
          href={citation.url}
          target="_blank"
          rel="noopener noreferrer"
          title={citation.title}
          className="max-w-full truncate text-fw-accent underline hover:text-fw-accent dark:text-fw-accent dark:hover:text-fw-accent"
        >
          [{index + 1}] {citation.title}
        </a>
      ))}
    </div>
  )
})

const AssistantTextCard = memo(function AssistantTextCard({ text, message, annotations, onOpenCodeCommit }: { text: string; message: Message; annotations?: OpenAIResponsesAnnotation[]; onOpenCodeCommit?: OpenCodeCommitHandler }) {
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

  return (
    <div className="foxwarm-assistant-message-card min-w-0 max-w-full bg-fw-assistant-surface text-fw-assistant-text border border-fw-border px-2 py-2 rounded-lg cursor-text relative group">
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
              className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-fw-assistant-code-surface prose-pre:text-fw-assistant-code-text prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
            />
          ) : segment.kind === 'commit' ? (
            <CommitMarkerCard key={`commit-${index}-${segment.target.commitId}`} target={segment.target} onOpen={onOpenCodeCommit} />
          ) : (
            <pre key={`invalid-commit-${index}`} className="my-2 whitespace-pre-wrap rounded border border-fw-warning-border bg-fw-warning-surface px-2 py-1.5 font-mono text-xs text-fw-warning dark:border-fw-warning-border dark:bg-fw-warning-surface-strong/30 dark:text-fw-warning" title="Invalid Foxwarm commit marker">
              {segment.raw}
            </pre>
          ))}
          <WebSearchCitationLinks annotations={annotations} />
        </div>
      ) : viewMode === 'raw' ? (
        <pre className="foxwarm-assistant-message-raw max-w-full whitespace-pre-wrap break-words font-mono text-sm text-fw-text-strong">{text}</pre>
      ) : (
        <pre className="foxwarm-assistant-message-raw max-w-full whitespace-pre-wrap break-words font-mono text-sm text-fw-text-strong">{jsonText}</pre>
      )}
    </div>
  )
})

interface MessageRowProps {
  row: TimelineRowView
  isMobile: boolean
  showUserMessageMetadata: boolean
  onExpandGroup: (groupKey: string) => void
  sessionId: string
  nestedDepth: number
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  renderNestedMessages: (messages: Message[], keyPrefix: string, nestedDepth: number) => ReactNode
}

const MessageRow = memo(function MessageRow({
  row,
  isMobile,
  showUserMessageMetadata,
  onExpandGroup,
  sessionId,
  nestedDepth,
  onOpenCodeFile,
  onOpenCodeCommit,
  renderNestedMessages,
}: MessageRowProps) {
  const {
    key: messageKey,
    msg,
    nextMsg,
    group,
    collapsedGroup,
    renderSummary,
    hideFoldedThinking,
    suppressWebSearchCards,
    usageBadge,
    usageAnchorRelative,
    systemLikeMessage,
    interleavedToolGroup,
    marginClass,
    widthClass,
    anchorKey,
    scrollbarAnchorKey,
  } = row
  const visibleModelParts = useMemo<Array<{ part: Message['parts'][number]; webSearchAction: WebSearchAction | null; partIndex: number }>>(() => {
    const visible: Array<{ part: Message['parts'][number]; webSearchAction: WebSearchAction | null; partIndex: number }> = []
    for (const [partIndex, part] of msg.parts.entries()) {
      if (part.text || part.system || part.thinking) {
        visible.push({ part, webSearchAction: null, partIndex })
        continue
      }
      const webSearchAction = msg.role === 'model'
        ? getWebSearchAction(part.providerMeta?.openaiResponses?.outputItem)
        : null
      if (webSearchAction) visible.push({ part, webSearchAction, partIndex })
    }
    return visible
  }, [msg.parts])
  const textLikeParts = useMemo(() => visibleModelParts.map(item => item.part), [visibleModelParts])
  const attachmentCorrelations = useMemo(() => findAttachmentCorrelations(msg.parts), [msg.parts])
  const associatedImageParts = useMemo(() => new Set([...attachmentCorrelations.values()].flatMap(item => item.imagePart ? [item.imagePart] : [])), [attachmentCorrelations])
  const hasInlineAttachmentFlow = msg.role === 'user' && attachmentCorrelations.size > 0
  const inlineUserWrapperBoundaries = useMemo(
    () => hasInlineAttachmentFlow ? getInlineUserWrapperBoundaries(textLikeParts) : null,
    [hasInlineAttachmentFlow, textLikeParts],
  )
  const imageParts = useMemo(() => msg.parts.filter(p => (
    p.inlineData || p.inlineDataRef || p.inlineDataUnavailable
  ) && !associatedImageParts.has(p)), [associatedImageParts, msg.parts])
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const contextBlock = useMemo(() => msg.role === 'model' ? getContextBlockMetaFromMessage(msg) : null, [msg])
  const firstTextPartIndex = useMemo(() => msg.parts.findIndex(p => typeof p.text === 'string' && p.text.trim()), [msg.parts])

  return (
    <div
      className={`flex w-full min-w-0 max-w-full ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${marginClass}`}
      data-chat-message-anchor-key={anchorKey}
      data-context-scrollbar-anchor-key={scrollbarAnchorKey}
    >
      <div
        className={`min-w-0 ${widthClass} ${
          !systemLikeMessage && msg.role === 'user'
            ? 'foxwarm-user-message-bubble bg-fw-user-surface text-fw-user-text px-3 py-2 rounded-lg'
            : ''
        }`}
      >
        {systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={messageKey} />
        ) : msg.role === 'user' ? (
          <div className={hasInlineAttachmentFlow ? 'min-w-0' : 'flex min-w-0 flex-col'}>
            {textLikeParts.map((part, partIdx) => (
              <div key={`user-part-${partIdx}`} className={hasInlineAttachmentFlow ? 'contents' : undefined}>
                {showUserMessageMetadata && inlineUserWrapperBoundaries?.close === partIdx && <UserWrapperBoundaryBreak afterMetadata={false} />}
                {part.system
                  && !hasInlineAttachmentFlow
                  ? <InlineMetaPart systemText={formatStructuredSystemText(part.system)} isUser={true} showUserMessageMetadata={showUserMessageMetadata} />
                  : <CollapsibleUserText part={part} showUserMessageMetadata={showUserMessageMetadata} correlations={attachmentCorrelations} inlineFlow={hasInlineAttachmentFlow} />}
                {showUserMessageMetadata && inlineUserWrapperBoundaries?.open === partIdx && <UserWrapperBoundaryBreak afterMetadata />}
              </div>
            ))}
            <ImageParts imageParts={imageParts} keyPrefix={`user-${messageKey}`} />
          </div>
        ) : (
          <div className={`flex min-w-0 max-w-full flex-col ${usageAnchorRelative ? 'relative' : ''}`}>
            {visibleModelParts.map(({ part, webSearchAction, partIndex }, partIdx) => {
              if (webSearchAction) {
                if (suppressWebSearchCards && !hasVisibleTextContent) {
                  return null
                }
                return <WebSearchCard key={`web-search-${partIdx}`} action={webSearchAction} />
              }
              if (part.system) {
                return <InlineMetaPart key={`model-system-${partIdx}`} systemText={formatStructuredSystemText(part.system)} isUser={false} />
              }
              if (part.thinking) {
                // A model text splits the group: thinking before the text belongs to the group
                // that ends there, so it follows that group's expansion, while thinking after
                // the text (and in text-free messages) follows this message's own group.
                const foldedIntoGroupAbove = firstTextPartIndex !== -1 && partIndex < firstTextPartIndex
                const folded = foldedIntoGroupAbove ? hideFoldedThinking : collapsedGroup
                if (folded) {
                  return null
                }
                return <ReasoningCard key={`thinking-${partIdx}`} thinking={part.thinking} tone="message" />
              }
              // Compare source part indices: `partIndex` indexes `msg.parts` like the folded-thinking
              // check above, while `partIdx` skips parts that are not rendered as model content.
              if (contextBlock && partIndex === firstTextPartIndex && part.text) {
                return <ContextBlockCard key={`ctx-block-${contextBlock.id}`} sessionId={sessionId} messageKey={messageKey} block={contextBlock} text={part.text} nestedDepth={nestedDepth} renderNestedMessages={renderNestedMessages} />
              }
              return <AssistantTextCard key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} annotations={part.providerMeta?.openaiResponses?.annotations} onOpenCodeCommit={onOpenCodeCommit} />
            })}
            <ImageParts imageParts={imageParts} keyPrefix={`message-${messageKey}`} />
            {renderSummary && group && (
              <ToolGroupSummaryCard items={group.summaryItems} onExpand={() => onExpandGroup(group.key)} />
            )}
            {collapsedGroup ? null : (interleavedToolGroup && nextMsg ? <InterleavedToolGroup msg={msg} nextMsg={nextMsg} messageKeyPrefix={messageKey} onOpenCodeFile={onOpenCodeFile} /> : <ToolCallsBlock msg={msg} onOpenCodeFile={onOpenCodeFile} />)}
            {collapsedGroup ? null : (interleavedToolGroup ? null : <ToolResponsesBlock msg={msg} />)}
            {usageBadge && <ModelUsageAnchor usage={usageBadge.usage} isMobile={isMobile} callCount={usageBadge.callCount} attribution={usageBadge.attribution} />}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => (
  prev.row === next.row &&
  prev.isMobile === next.isMobile &&
  (prev.row.msg.role !== 'user' || prev.row.systemLikeMessage || prev.showUserMessageMetadata === next.showUserMessageMetadata) &&
  prev.onExpandGroup === next.onExpandGroup &&
  prev.sessionId === next.sessionId &&
  prev.nestedDepth === next.nestedDepth &&
  prev.onOpenCodeFile === next.onOpenCodeFile &&
  prev.onOpenCodeCommit === next.onOpenCodeCommit &&
  (!getContextBlockMetaFromMessage(prev.row.msg) || prev.renderNestedMessages === next.renderNestedMessages)
))

const ChatTimeline = memo(function ChatTimeline({ sessionId, messages, isMobile, groupTools, showUsageBadge, showUserMessageMetadata = false, onOpenCodeFile, onOpenCodeCommit, nestedDepth = 0 }: ChatTimelineProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())
  const rowsCacheRef = useRef<TimelineRowsCache | null>(null)

  const renderNestedMessages = useCallback((nestedMessages: Message[], keyPrefix: string, nextNestedDepth: number) => (
    <ChatTimeline
      key={keyPrefix}
      sessionId={sessionId}
      messages={nestedMessages}
      isMobile={isMobile}
      groupTools={groupTools}
      showUsageBadge={nextNestedDepth > 0 ? false : showUsageBadge}
      showUserMessageMetadata={showUserMessageMetadata}
      onOpenCodeFile={onOpenCodeFile}
      onOpenCodeCommit={onOpenCodeCommit}
      nestedDepth={nextNestedDepth}
    />
  ), [groupTools, isMobile, onOpenCodeCommit, onOpenCodeFile, sessionId, showUsageBadge, showUserMessageMetadata])

  const rows = useMemo(() => {
    const result = buildTimelineRows(
      { messages, isMobile, groupTools, showUsageBadge, nestedDepth, expandedGroupKeys: expandedToolGroups },
      rowsCacheRef.current,
    )
    rowsCacheRef.current = result.cache
    return result.rows
  }, [expandedToolGroups, groupTools, isMobile, messages, nestedDepth, showUsageBadge])


  const handleExpandGroup = useCallback((groupKey: string) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev)
      next.add(groupKey)
      return next
    })
  }, [])

  return (
    <div className="foxwarm-chat-timeline min-w-0 max-w-full">
      {rows.map((row) => (
        <MessageRow
          key={row.key}
          row={row}
          isMobile={isMobile}
          showUserMessageMetadata={showUserMessageMetadata}
          onExpandGroup={handleExpandGroup}
          sessionId={sessionId}
          nestedDepth={nestedDepth}
          onOpenCodeFile={onOpenCodeFile}
          onOpenCodeCommit={onOpenCodeCommit}
          renderNestedMessages={renderNestedMessages}
        />
      ))}
    </div>
  )
})

export default ChatTimeline
