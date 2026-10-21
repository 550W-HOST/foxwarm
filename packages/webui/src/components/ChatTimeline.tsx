import ArtifactView from '../artifacts/ArtifactView'
import { buildArtifactGroups } from '../artifacts/projection'
import SessionMessageCard from './SessionMessageCard'
import SystemEventCard from './SystemEventCard'
import { getSessionNotice } from '../sessionNotices'
import ReplyFileGrid from './ReplyFileGrid'
import { buildReplyFileGroups } from './replyFiles'
import { useMobileChatViewport, type TimelineView } from '../chatPreferences'
import { getMessageViewportAnchorKey, getMessageStableKey } from '../chatViewportState'
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react'
import { File as FileIcon, Image as ImageIcon, Eye, Code, FileJson, Copy, Check, Cloud, ChevronRight } from 'lucide-react'
import {
  IconToggleButton,
  copyTextToClipboard,
  clampContentStyle,
  formatStructuredSystemText,
  getLlmErrorMessageDetails,
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
import { getReasoningRuns, type ReasoningRunPart, type ReasoningBadgeInfo, type ReasoningPresentation } from './reasoningParts'
import ReasoningTokenBadge from './ReasoningTokenBadge'
import MarkdownHtmlSegment from './MarkdownHtmlSegment'
import WebSearchCard from './WebSearchCard'
import { getWebSearchAction, type WebSearchAction } from '../webSearchAction'
import ContextBlockCard, { getContextBlockMetaFromMessage } from './ContextBlockCard'
import JsonInspectorDialog from './JsonInspectorDialog'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'
import { useThreadCardHeightTransition } from './useThreadCardHeightTransition'
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
import { formatTimelineTimeMarker, type TimelineTimeMarker } from './timelineTime'
import type { SessionSearchMatch } from './chatSessionSearch'
import { splitGeneratedAttachmentName } from '../attachmentRefs'
import {
  formatCompactDuration,
  formatDetailedDuration,
  summarizeDurationSamples,
  type DurationSample,
} from '../usageTiming'
import {
  buildTimelineRows,
  getGroupContentPartIndex,
  type NormalizedTokenUsage,
  type TimelineRowView,
  type TimelineGroupView,
  type TimelineRowsCache,
  type TimelineUsageBadgeView,
  type UsageAttribution,
} from './timelineRows'

interface ChatTimelineProps {
  sessionId: string
  messages: Message[]
  reasoningPresentation?: ReasoningPresentation
  isRunningTool?: boolean
  /** Supplied by Chat from full committed history, never inferred from a viewport or nested slice. */
  currentHistoryMessages?: readonly Message[]
  historyMessages?: readonly Message[]
  activityDetails?: boolean
  runtimeState?: import('../sessionRuntimeState').SessionRuntimeState
  busyStartedAt?: number | null
  isMobile: boolean
  showInterAgentMessages?: boolean
  showCommentary?: boolean
  timelineView: TimelineView
  showUsageBadge: boolean
  showTimeDividers?: boolean
  showUserMessageMetadata?: boolean
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  nestedDepth?: number
  searchTarget?: SessionSearchMatch | null
  renderMessageFooter?: (alignment: 'left' | 'right') => ReactNode
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
  return `Token usage: ${total} total • input ${usage.inputTokens} • output ${usage.outputTokens} • cached ${usage.cachedTokens}${callCount ? ` • calls ${callCount}` : ''}${api === null ? '' : ` • API ${formatDetailedDuration(api)}`}`
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

const formatUsageMessageSeq = (seqs: UsageAttribution['messageSeqs']): { label: string; target: string } | null => {
  if (seqs.length === 0) return null
  let first = Infinity
  let last = 0
  for (const seq of seqs) {
    // An incomplete aggregate cannot be attributed to just the known messages.
    if (seq === null) return null
    first = Math.min(first, seq)
    last = Math.max(last, seq)
  }
  return first === last
    ? { label: String(first), target: String(first) }
    : { label: `${first} ~ ${last}`, target: `${first}-${last}` }
}

const formatDurationSummary = (samples: DurationSample[]): string => {
  const summary = summarizeDurationSamples(samples)
  const labels: string[] = []
  if (summary.totalMs !== null) labels.push(formatDetailedDuration(summary.totalMs))
  if (summary.unavailableCount > 0) labels.push('unavailable')
  if (summary.invalidCount > 0) labels.push('invalid timing')
  return labels.join(' • ') || 'unavailable'
}

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

const ModelUsageBadge = memo(function ModelUsageBadge({ usage, isMobile, callCount, attribution, sessionId, expanded, onToggle }: {
  usage: NormalizedTokenUsage
  isMobile: boolean
  callCount?: number
  attribution: UsageAttribution
  sessionId: string
  expanded: boolean
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const messageSeq = formatUsageMessageSeq(attribution.messageSeqs)
  const reference = messageSeq ? `sessionId=${sessionId} msg#${messageSeq.target}` : null
  const currentReferenceRef = useRef(reference)
  currentReferenceRef.current = reference

  useEffect(() => {
    setCopied(false)
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
        copyResetTimeoutRef.current = null
      }
    }
  }, [reference])

  const copyReference = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!reference) return
    try {
      await copyTextToClipboard(reference)
      if (currentReferenceRef.current !== reference) return
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      setCopied(false)
      console.error('Failed to copy message reference:', error)
    }
  }

  const stopUsageBadgeEvent = (event: { stopPropagation: () => void }) => event.stopPropagation()
  const apiDurationMs = summarizeDurationSamples(attribution.apiDurationsMs).totalMs

  return (
    <div
      data-usage-badge
      role="group"
      aria-label="Request usage"
      className={`${expanded ? 'flex max-w-full flex-col items-stretch gap-1.5 text-left w-fit' : 'inline-flex flex-row items-center'} pointer-events-auto rounded-md border border-fw-border bg-fw-surface/85 px-2 py-1 font-mono leading-none shadow-sm backdrop-blur dark:border-fw-border dark:bg-fw-canvas/85`}
      onPointerDown={stopUsageBadgeEvent}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      <button
        type="button"
        data-usage-badge-toggle
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide request usage and timing details' : 'Show request usage and timing details'}
        className={`${expanded ? 'flex w-full flex-col items-stretch gap-1.5 text-left' : `${isMobile ? 'gap-2' : 'gap-1.5'} inline-flex flex-row items-center`} min-w-0 cursor-pointer appearance-none font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-focus-ring`}
        title={formatUsageTitle(usage, attribution, callCount)}
      >
        {expanded ? <>
          {callCount ? <ModelUsageRow label="Calls" value={callCount} tone="normal" /> : null}
          <ModelUsageRow label="Cached" value={usage.cachedTokens} tone="normal" />
          <ModelUsageRow label="Input" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="Output" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
          <ModelUsageTextRow label="API" value={formatDurationSummary(attribution.apiDurationsMs)} />
          <ModelUsageTextRow label="Time" value={formatUsageTimes(attribution.timestamps)} />
          <ModelUsageTextRow label="Model" value={formatUsageModels(attribution.models)} />
        </> : <>
          {callCount ? <ModelUsageRow label="×" value={callCount} tone="normal" /> : null}
          <ModelUsageRow label="C" value={usage.cachedTokens} tone="normal" />
          <ModelUsageRow label="I" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
          <ModelUsageRow label="O" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
          {apiDurationMs !== null ? (
            <span
              data-usage-timing-summary
              className="inline-flex items-center gap-2 border-l border-fw-border pl-2"
            >
              <span
                data-usage-timing-kind="api"
                className="inline-flex items-center gap-1 text-fw-text"
                title={`API response: ${formatDetailedDuration(apiDurationMs)}`}
              >
                <Cloud aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={1.8} />
                <span className="text-[10px] font-semibold tabular-nums">{formatCompactDuration(apiDurationMs)}</span>
              </span>
            </span>
          ) : null}
        </>}
      </button>
      {expanded && (
        <div data-usage-seq-row className="flex min-w-0 items-center justify-between gap-2 text-fw-text-muted">
          <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">Seq</span>
          <span data-usage-seq-value className="ml-auto min-w-0 break-all text-right text-[10px] font-semibold leading-snug tabular-nums">{messageSeq?.label || 'unavailable'}</span>
          {reference && (
            <button
              type="button"
              data-usage-seq-copy
              aria-label={copied ? 'Copied message reference' : 'Copy message reference'}
              title={copied ? 'Copied message reference' : 'Copy message reference'}
              className="shrink-0 rounded p-0.5 text-fw-text-muted hover:bg-fw-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-focus-ring"
              onPointerDown={stopUsageBadgeEvent}
              onClick={copyReference}
            >
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            </button>
          )}
        </div>
      )}
    </div>
  )
})

const ModelUsageAnchor = memo(function ModelUsageAnchor({ usage, isMobile, callCount, attribution, sessionId }: {
  usage: NormalizedTokenUsage
  isMobile: boolean
  callCount?: number
  attribution: UsageAttribution
  sessionId: string
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
        <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} attribution={attribution} sessionId={sessionId} expanded={expanded} onToggle={toggleExpanded} />
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
      <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} attribution={attribution} sessionId={sessionId} expanded={expanded} onToggle={toggleExpanded} />
    </div>
  )
})

const MarkdownContent = memo(function MarkdownContent({ text, className, artifactSessionId, streaming }: { text: string; className: string; artifactSessionId?: string; streaming?: boolean }) {
  const segments = useMemo(() => renderAssistantMarkdownSegments(text, { enabled: !!artifactSessionId, streaming }), [text, artifactSessionId, streaming])
  return (
    <div className={`min-w-0 max-w-full ${className}`} onClick={handleMarkdownLinkClick}>
      {segments.map((segment) => {
        if (segment.kind === 'artifact') return artifactSessionId ? <div key={`markdown-token-${segment.tokenIndex}-${segment.reference.artifactId}-${segment.reference.revision}`} data-search-exclude className="not-prose"><ArtifactView reference={segment.reference} sessionId={artifactSessionId} /></div> : null
        if (segment.kind === 'html') {
          return <MarkdownHtmlSegment key={`markdown-token-${segment.tokenIndex}`} html={segment.html} />
        }
        if (segment.kind === 'latex') {
          return (
            <div key={`markdown-token-${segment.tokenIndex}`} data-search-exclude className="contents">
              <SpecialBlock kind="latex" label="LaTeX" raw={segment.raw}>
                <div className="foxwarm-special-block-latex min-w-0 max-w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: segment.html }} />
              </SpecialBlock>
            </div>
          )
        }
        return (
          <div key={`markdown-token-${segment.tokenIndex}`} data-search-exclude className="contents">
            <SpecialBlock kind="mermaid" label="Mermaid" raw={segment.raw}>
              <MermaidDiagram source={segment.source} />
            </SpecialBlock>
          </div>
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

const renderUserPreLines = (text: string, showUserMessageMetadata: boolean, metadataLineHeight: string, renderLine: (line: string, lineIndex: number) => ReactNode, literalText = false): ReactNode => {
  const visibleLines = text.split('\n')
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => literalText || shouldRenderUserLine(line, showUserMessageMetadata))
  return visibleLines.map(({ line, lineIndex }, visibleIndex) => (
    <span key={lineIndex} className="foxwarm-user-rendered-line">
      {renderLine(line, lineIndex)}
      {visibleIndex < visibleLines.length - 1 && (
        <span
          className="foxwarm-user-rendered-line-break"
          style={!literalText && isSystemLikeText(line)
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

export function getPartDisplayText(part: Message['parts'][number]): string {
  return part.text || (part.system ? formatStructuredSystemText(part.system) : '')
}

function isWrappedDirectChannelText(system: string): boolean {
  const opening = parseFoxwarmMetadataLine(system)
  return opening?.tagName === 'foxwarm-message'
    && !opening.closing
    && opening.attrs.type === 'channel'
    && system.endsWith('\n</foxwarm-message>')
}

/** Only the trusted source envelope is metadata; never interpret another source inside its body. */
export function getConversationUserPartText(part: Message['parts'][number], literalUserText: boolean): {
  text: string
  literalText: boolean
  wrapper?: { opening: string; closing: string }
} {
  const source = part.text ? literalUserText ? undefined : part.text : part.system
  if (source && isWrappedDirectChannelText(source)) {
    const openingEnd = source.indexOf('\n')
    const closingStart = source.lastIndexOf('\n')
    return {
      text: source.slice(openingEnd + 1, closingStart),
      literalText: true,
      wrapper: { opening: source.slice(0, openingEnd), closing: source.slice(closingStart + 1) },
    }
  }
  return { text: getPartDisplayText(part), literalText: literalUserText && !!part.text }
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

function isOmittedAttachmentPreview(part: Message['parts'][number]): boolean {
  return typeof part.text === 'string' && /^\[[^\]\r\n]+ attachment preview omitted\]$/.test(part.text.trim())
}

export function findAttachmentCorrelations(parts: Message['parts']): Map<string, AttachmentCorrelation> {
  const correlations = new Map<string, AttachmentCorrelation>()
  const activeRefs = new Set<string>()
  for (const part of parts) {
    for (const segment of parsePastedTextSegments(getPartDisplayText(part))) {
      if (segment.kind !== 'text') continue
      for (const match of segment.text.matchAll(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g)) activeRefs.add(match[1])
    }
  }
  parts.forEach((part, partIndex) => {
    let attachmentOffset = 1
    for (const segment of parsePastedTextSegments(getPartDisplayText(part))) {
      if (segment.kind !== 'text') continue
      for (const line of segment.text.split('\n')) {
        const descriptorText = line.trim()
        const parsed = parseFoxwarmMetadataLine(descriptorText)
        if (!parsed || parsed.closing || (parsed.tagName !== 'foxwarm-image' && parsed.tagName !== 'foxwarm-file')) continue
        const generated = splitGeneratedAttachmentName(parsed.attrs.name || '')
        if (!generated || !activeRefs.has(generated.ref) || correlations.has(generated.ref)) continue
        const imagePart = parts[partIndex + attachmentOffset]
        if (imagePart && (imagePart.inlineData || imagePart.inlineDataRef || imagePart.inlineDataUnavailable || isOmittedAttachmentPreview(imagePart))) attachmentOffset++
        correlations.set(generated.ref, {
          ref: generated.ref,
          kind: parsed.tagName === 'foxwarm-image' ? 'image' : 'file',
          name: generated.originalName,
          mimeType: parsed.attrs.mime || imagePart?.inlineDataRef?.mimeType || imagePart?.inlineData?.mimeType || '',
          descriptorText,
          ...(imagePart && (imagePart.inlineData || imagePart.inlineDataRef || imagePart.inlineDataUnavailable || isOmittedAttachmentPreview(imagePart)) ? { imagePart } : {}),
        })
      }
    }
  })
  return correlations
}

export function stripGeneratedDescriptorLines(text: string, correlations: Map<string, AttachmentCorrelation>): string {
  const descriptors = new Set([...correlations.values()].map(item => item.descriptorText))
  return parsePastedTextSegments(text).map(segment => segment.kind === 'pasted-text'
    ? `${PASTED_TEXT_OPEN}${segment.text}${PASTED_TEXT_CLOSE}`
    : segment.text.split('\n').filter(line => !descriptors.has(line.trim())).join('\n')).join('')
}

function AttachmentHistoryGrid({ correlations, imageParts, pending }: { correlations: Map<string, AttachmentCorrelation>; imageParts: Message['parts']; pending: boolean }) {
  const files = [
    ...[...correlations.values()].map(item => ({ ...item, key: item.ref })),
    ...imageParts.map((imagePart, index) => ({ key: `image-${index}`, ref: undefined, kind: 'image' as const, name: `Image ${index + 1}`, mimeType: '', imagePart })),
  ]
  if (!files.length) return null
  return <div data-search-exclude role="list" aria-label="Message attachments" className="foxwarm-history-attachment-grid" style={{gridTemplateColumns: `repeat(${Math.min(files.length, 3)}, minmax(0, 96px))`}}>
    {files.map(({key, ref, kind, name, mimeType, imagePart}, index) => <div key={key} role="listitem" data-attachment-ref={ref} className="foxwarm-history-attachment" title={`${name}${mimeType ? ` · ${mimeType}` : ''}`}>
      {kind === 'image' && imagePart && !isOmittedAttachmentPreview(imagePart)
        ? <ImageItem part={imagePart} label={name} imageClassName="h-full w-full object-contain" />
        : <span className="flex flex-col items-center gap-1 text-fw-text-muted">{kind === 'image' ? <ImageIcon size={24} aria-hidden="true" /> : <FileIcon size={24} aria-hidden="true" />}{kind === 'image' && <span className="text-[10px]">{pending ? 'Queued' : 'Unavailable'}</span>}</span>}
      <span className="composer-attachment-number" aria-hidden="true">{index + 1}</span>
      <span className="composer-attachment-filename">{name}</span>
    </div>)}
  </div>
}

const CollapsibleUserText = memo(function CollapsibleUserText({ part, showUserMessageMetadata, correlations, inlineFlow = false, conversationText, searchReveal = false, searchSurface, searchPartIndex, searchPastedIndex }: { part: Message['parts'][number]; showUserMessageMetadata: boolean; correlations: Map<string, AttachmentCorrelation>; inlineFlow?: boolean; conversationText?: ReturnType<typeof getConversationUserPartText>; searchReveal?: boolean; searchSurface?: SessionSearchMatch['surface']; searchPartIndex?: number; searchPastedIndex?: number }) {
  const text = stripGeneratedDescriptorLines(conversationText?.text ?? getPartDisplayText(part), correlations)
  const literalText = conversationText?.literalText ?? false
  const wrapper = conversationText?.wrapper
  const segments = useMemo<Array<PastedTextSegment | {kind: 'attachment'; ref: string}>>(() => {
    const output: Array<PastedTextSegment | {kind: 'attachment'; ref: string}> = []
    for (const segment of parsePastedTextSegments(text)) {
      if (segment.kind === 'pasted-text') { output.push(segment); continue }
      let cursor = 0
      for (const match of segment.text.matchAll(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g)) {
        const index = match.index || 0
        if (index > cursor) output.push({ kind: 'text', text: segment.text.slice(cursor, index) })
        if (correlations.has(match[1])) output.push({kind: 'attachment', ref: match[1]})
        else output.push({ kind: 'text', text: match[0] })
        cursor = index + match[0].length
      }
      if (cursor < segment.text.length) output.push({ kind: 'text', text: segment.text.slice(cursor) })
    }
    return output
  }, [correlations, text])
  const pastedOrdinalBySegment = useMemo(() => {
    let ordinal = 0
    return segments.map(segment => segment.kind === 'pasted-text' ? ordinal++ : -1)
  }, [segments])
  const visibleClassificationText = useMemo(
    () => segments.filter((segment): segment is Extract<typeof segments[number], { kind: 'text' }> => segment.kind === 'text').map(segment => segment.text).join(''),
    [segments],
  )
  const isSystemMessage = !literalText && isCollapsibleSystemText(visibleClassificationText)
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = isSystemMessage && !expanded && !searchReveal

  return (
    <div className={inlineFlow ? 'contents' : undefined}>
      {wrapper && showUserMessageMetadata && <div data-search-exclude><InlineMetaPart systemText={wrapper.opening} isUser /></div>}
      <div className={`${shouldCollapse ? 'overflow-hidden' : ''} ${inlineFlow ? 'contents' : ''}`} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}>
        <pre data-search-surface="user" data-search-part-index={searchPartIndex} className={`foxwarm-user-message-text foxwarm-user-line-layout max-w-full whitespace-pre-wrap break-words font-sans ${inlineFlow ? 'inline' : ''}`} style={{ lineHeight: 0 }}>
          {segments.map((segment, segmentIndex) => segment.kind === 'attachment'
            ? <button key={`attachment-${segmentIndex}`} type="button" className="foxwarm-inline-file-ref" data-search-exclude aria-label={`Attachment ${[...correlations.keys()].indexOf(segment.ref) + 1}: ${correlations.get(segment.ref)?.name}`} data-attachment-ref-marker={segment.ref}
                title={correlations.get(segment.ref)?.name}
                onClick={event => {
                  const tile = event.currentTarget.closest('[data-search-row]')?.querySelector<HTMLElement>(`[data-attachment-ref="${segment.ref}"]`)
                  const open = tile?.querySelector<HTMLElement>('button, a')
                  if (open) open.click()
                  else tile?.scrollIntoView({block: 'nearest', inline: 'nearest'})
                }}>FILE {[...correlations.keys()].indexOf(segment.ref) + 1}</button>
            : segment.kind === 'pasted-text'
            ? <PastedTextBlock key={`pasted-${segmentIndex}`} text={segment.text} searchPartIndex={searchPartIndex} searchPastedIndex={pastedOrdinalBySegment[segmentIndex]} searchReveal={searchReveal && searchSurface === 'pasted' && searchPastedIndex === pastedOrdinalBySegment[segmentIndex]} />
            : (
              <span key={`text-${segmentIndex}`}>
                {renderUserPreLines(segment.text, showUserMessageMetadata, '1em', (line) => {
                  const isPrefix = !literalText && isSystemLikeText(line)
                  return (
                    <span
                      className={isPrefix ? 'foxwarm-lightweight-metadata-line' : undefined}
                      data-search-exclude={isPrefix || undefined}
                      style={isPrefix
                        ? { fontSize: '70%', lineHeight: '1em', opacity: 0.7 }
                        : { fontSize: '100%', lineHeight: '1.5em', opacity: 1 }
                      }
                    >
                      {line}
                    </span>
                  )
                }, literalText)}
              </span>
            ))}
        </pre>
      </div>
      {wrapper && showUserMessageMetadata && <div data-search-exclude><InlineMetaPart systemText={wrapper.closing} isUser /></div>}
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

const SystemLikeMessageCard = memo(function SystemLikeMessageCard({ msg, messageKey, searchReveal = false }: { msg: Message; messageKey: string; searchReveal?: boolean }) {
  const [manualExpanded, setExpanded] = useState(false)
  const expanded = manualExpanded || searchReveal
  const { ref: heightRef, prepare } = useThreadCardHeightTransition(expanded)
  const toggle = () => { prepare(); setExpanded(current => !current) }
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

  const messageKind = useMemo(() => getSystemMessagePreviewDescriptor(msg), [msg])
  const renderedText = messageKind.bodyText ?? allLines.join('\n')
  const renderedLines = useMemo(() => renderedText.split(/\r\n|\r|\n/), [renderedText])
  const interAgentPreview = useMemo(() => (
    messageKind.kind === 'inter-agent' && messageKind.previewSessionId
      ? allLines.filter((line) => !isSystemLikeText(line)).join('\n').trim()
      : ''
  ), [allLines, messageKind.kind, messageKind.previewSessionId])
  const preview = useMemo(() => {
    const bodyLine = allLines.find((line) => line.trim() && !isSystemLikeText(line))
    const body = messageKind.bodyText?.split(/\r\n|\r|\n/)[0]?.trim()
      || bodyLine?.trim()
      || renderedText.trim()
      || messageKind.kind
    return `${messageKind.previewPrefix}${body}`
  }, [allLines, messageKind.bodyText, messageKind.kind, messageKind.previewPrefix, renderedText])
  const surfaceClass = 'bg-fw-system-surface/55 dark:bg-fw-system-surface/10 text-fw-system-text'
  const threadLineClass = 'text-fw-system-accent hover:text-fw-system-accent focus-visible:text-fw-system-accent'
  const headerClass = 'bg-fw-system-surface-strong/80 dark:bg-fw-system-surface-strong/20'
  const headerHoverClass = 'hover:text-fw-system-accent'

  return (
    <div className="w-full min-w-0">
      <div
        ref={heightRef}
        data-system-message-card
        data-system-message-kind={messageKind.kind}
        data-system-message-tone="system"
        className={`foxwarm-system-message-card relative group min-w-0 max-w-full pl-2 pr-2 text-xs ${surfaceClass} ${expanded || interAgentPreview ? 'pb-1' : ''} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''} my-0.5`}
        onClick={!expanded ? toggle : undefined}
      >
        <ThreadLineButton
          expanded={expanded}
          onToggle={toggle}
          label={expanded ? `Collapse ${messageKind.kind} message` : `Expand ${messageKind.kind} message`}
          className={`foxwarm-system-message-thread-line ${threadLineClass}`}
        />
        <div
          className={`foxwarm-system-message-header -ml-2 -mr-2 ${THREAD_CARD_HEADER_ROW_CLASS} px-2 py-1 ${headerClass} ${expanded ? `mb-1 cursor-pointer ${headerHoverClass}` : ''}`}
          onClick={expanded ? (event) => { event.stopPropagation(); toggle() } : undefined}
        >
          <ToolTag name="system" iconName={`system-${messageKind.kind}`} label={messageKind.kind === 'llm error' ? `LLM error ×${messageKind.lineCount || 1}` : `${messageKind.kind}${messageKind.lineCount ? ` ×${messageKind.lineCount}` : ''}`} tone="system" className="foxwarm-system-message-tag" />
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
          <pre data-search-surface="system" className="foxwarm-system-message-body max-w-full whitespace-pre-wrap break-words font-sans text-sm" style={{ lineHeight: '1.5em' }}>
            {renderedLines.map((line, lineIdx, lines) => {
              const isPrefix = isSystemLikeText(line)
              const nextIsPrefix = lineIdx < lines.length - 1 && isSystemLikeText(lines[lineIdx + 1])
              return (
                <span
                  key={`${messageKey}-${lineIdx}`}
                  data-search-exclude={isPrefix || undefined}
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

const AssistantTextCard = memo(function AssistantTextCard({ text, message, sessionId, annotations, onOpenCodeCommit, searchReveal = false, searchPartIndex, conversation = false, reasoningBadges }: { reasoningBadges?: readonly ReasoningBadgeInfo[]; conversation?: boolean; text: string; message: Message; sessionId: string; annotations?: OpenAIResponsesAnnotation[]; onOpenCodeCommit?: OpenCodeCommitHandler; searchReveal?: boolean; searchPartIndex?: number }) {
  const mobileUi = useMobileChatViewport()
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const displayedViewMode = searchReveal ? 'rendered' : viewMode
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const [jsonSnapshot, setJsonSnapshot] = useState<string | null>(null)
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

  const actionButtons = (
    <div className={`foxwarm-assistant-action-buttons ${conversation ? 'order-last mt-1 self-start' : 'absolute right-1 top-1 z-10'} flex shrink-0 gap-0.5 opacity-0 transition-opacity`}>
      <IconToggleButton onClick={() => setViewMode('rendered')} active={displayedViewMode === 'rendered'} title="Rendered (Markdown)">
        <Eye size={12} />
      </IconToggleButton>
      <IconToggleButton onClick={() => setViewMode('raw')} active={displayedViewMode === 'raw'} title="Raw Text">
        <Code size={12} />
      </IconToggleButton>
      <IconToggleButton onClick={() => setJsonSnapshot(JSON.stringify(message, null, 2))} active={jsonSnapshot !== null} title="JSON">
        <FileJson size={14} />
      </IconToggleButton>
      <IconToggleButton onClick={handleCopy} active={copied} title={copied ? 'Copied' : 'Copy Raw Text'}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </IconToggleButton>
    </div>
  )

  return (
    <div className={`foxwarm-assistant-message-card ${conversation ? 'foxwarm-conversation-reply flex flex-col' : ''} min-w-0 max-w-full bg-fw-assistant-surface text-fw-assistant-text border border-fw-border px-2 py-2 rounded-lg cursor-text relative group`}
      style={message.__meta?.streaming ? { overflowAnchor: 'none' } : undefined}>
      {!mobileUi && actionButtons}
      <div className="flow-root min-w-0 max-w-full">
        {reasoningBadges?.length ? <div data-search-exclude className="float-right ml-2">
          <ReasoningTokenBadge badges={reasoningBadges} />
        </div> : null}

        {displayedViewMode === 'rendered' ? (
          <div data-search-surface="model" data-search-part-index={searchPartIndex} className="foxwarm-assistant-message-markdown">
            {renderedSegments.map((segment, index) => segment.kind === 'markdown' ? (
              <MarkdownContent
                key={`markdown-${index}`}
                text={segment.text}
                artifactSessionId={sessionId}
                streaming={!!message.__meta?.streaming}
                className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-fw-assistant-code-surface prose-pre:text-fw-assistant-code-text prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
              />
            ) : segment.kind === 'commit' ? (
              <div key={`commit-${index}-${segment.target.commitId}`} data-search-exclude className="contents"><CommitMarkerCard target={segment.target} onOpen={onOpenCodeCommit} /></div>
            ) : (
              <pre key={`invalid-commit-${index}`} className="my-2 whitespace-pre-wrap rounded border border-fw-warning-border bg-fw-warning-surface px-2 py-1.5 font-mono text-xs text-fw-warning dark:border-fw-warning-border dark:bg-fw-warning-surface-strong/30 dark:text-fw-warning" title="Invalid Foxwarm commit marker">
                {segment.raw}
              </pre>
            ))}
            <div data-search-exclude className="contents"><WebSearchCitationLinks annotations={annotations} /></div>
          </div>
        ) : (
          <pre className="foxwarm-assistant-message-raw max-w-full whitespace-pre-wrap break-words font-mono text-sm text-fw-text-strong">{text}</pre>
        )}
      </div>
      {jsonSnapshot !== null && <JsonInspectorDialog text={jsonSnapshot} onClose={() => setJsonSnapshot(null)} />}
    </div>
  )
})

type ExpandedTools = ReadonlyMap<string, ReadonlySet<string>>
type ToolToggleHandler = (messageKey: string, toolKey: string, expanded: boolean, groupKey?: string) => void
const EMPTY_TOOL_KEYS: ReadonlySet<string> = new Set()

interface MessageRowProps {
  expandedTools: ExpandedTools
  onToolToggle: ToolToggleHandler
  row: TimelineRowView
  hideMetrics: boolean
  isMobile: boolean
  showUserMessageMetadata: boolean
  sessionId: string
  nestedDepth: number
  onOpenCodeFile?: OpenCodeFileHandler
  onOpenCodeCommit?: OpenCodeCommitHandler
  renderNestedMessages: (messages: Message[], keyPrefix: string, nestedDepth: number, timelineView?: TimelineView, searchTarget?: SessionSearchMatch | null) => ReactNode
  conversationDetails?: boolean
  neutralToolSuccess?: boolean
  groupFirst?: boolean
  surface?: 'all' | 'ordinary' | 'grouped'
  searchTarget?: SessionSearchMatch | null
}

const MessageRow = memo(function MessageRow({
  row,
  isMobile,
  hideMetrics,
  showUserMessageMetadata,
  sessionId,
  nestedDepth,
  onOpenCodeFile,
  onOpenCodeCommit,
  renderNestedMessages,
  conversationDetails = false,
  neutralToolSuccess = false,
  groupFirst = false,
  surface = 'all',
  searchTarget,
  expandedTools,
  onToolToggle,
}: MessageRowProps) {
  const {
    key: messageKey,
    msg,
    pairedToolResponse,
    runningTool,
    collapsedGroup,
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
  const llmError = useMemo(() => getLlmErrorMessageDetails(msg), [msg])
  const sessionNotice = useMemo(() => getSessionNotice(msg), [msg])
  const toolDisclosure = {
    hideCollapsedContent: conversationDetails,
    neutralSuccess: conversationDetails || neutralToolSuccess,
    expandedToolKeys: expandedTools.get(messageKey) || EMPTY_TOOL_KEYS,
    reasoningBadges: hideMetrics ? [] : msg.parts.filter(part => part.functionCall).map(part => {
      const info = row.reasoningPresentation[msg.parts.indexOf(part)]
      return info?.target === 'tool' ? info.badges : undefined
    }),
    onToolToggle: useCallback((toolKey: string, expanded: boolean) => {
      onToolToggle(messageKey, toolKey, expanded, row.group?.key)
    }, [messageKey, onToolToggle, row.group?.key]),
  }
  const rowSearchTarget = searchTarget?.rowKey === messageKey ? searchTarget : null
  const reasoningRuns = useMemo(() => getReasoningRuns(msg.parts), [msg.parts])
  const reasoningTokens = msg.__meta?.usage?.reasoningTokens
  const visibleModelParts = useMemo(() => {
    const visible: Array<{ part: Message['parts'][number]; webSearchAction: WebSearchAction | null; partIndex: number; reasoningRun?: ReasoningRunPart[] }> = []
    const runsByStart = new Map(reasoningRuns.map(run => [run[0].partIndex, run]))
    for (const [partIndex, part] of msg.parts.entries()) {
      if (row.conversationPartIndex !== undefined) {
        if (!row.conversationImageOnly && partIndex === row.conversationPartIndex && part.text && !part.toolUseId && !part.functionResponse) visible.push({ part, webSearchAction: null, partIndex })
        continue
      }
      const reasoningRun = runsByStart.get(partIndex)
      if (reasoningRun) visible.push({ part, webSearchAction: null, partIndex, reasoningRun })
      // Mixed-field parts retain their ordinary output alongside their reasoning.
      if (part.text || part.system) visible.push({ part, webSearchAction: null, partIndex })
      const webSearchAction = msg.role === 'model'
        ? getWebSearchAction(part.providerMeta?.openaiResponses?.outputItem)
        : null
      if (webSearchAction) visible.push({ part, webSearchAction, partIndex })
    }
    return visible
  }, [msg.parts, msg.role, reasoningRuns, row.conversationPartIndex, row.conversationImageOnly])
  const attachmentCorrelations = useMemo(() => findAttachmentCorrelations(msg.parts), [msg.parts])
  const associatedImageParts = useMemo(() => new Set([...attachmentCorrelations.values()].flatMap(item => item.imagePart ? [item.imagePart] : [])), [attachmentCorrelations])
  const textLikeParts = useMemo(() => visibleModelParts.filter(item => !item.reasoningRun && !(msg.__meta?.queuedPreview && associatedImageParts.has(item.part) && isOmittedAttachmentPreview(item.part))).map(item => item.part), [visibleModelParts, associatedImageParts, msg.__meta?.queuedPreview])
  const hasInlineAttachmentFlow = msg.role === 'user' && attachmentCorrelations.size > 0
  const inlineUserWrapperBoundaries = useMemo(
    () => hasInlineAttachmentFlow ? getInlineUserWrapperBoundaries(textLikeParts) : null,
    [hasInlineAttachmentFlow, textLikeParts],
  )
  const imageParts = useMemo(() => msg.parts.filter((p, index) => (
    p.inlineData || p.inlineDataRef || p.inlineDataUnavailable
  ) && !associatedImageParts.has(p) && (row.conversationPartIndex === undefined || (index === row.conversationPartIndex && !p.toolUseId && !p.functionResponse))), [associatedImageParts, msg.parts, row.conversationPartIndex])
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const contextBlock = useMemo(() => msg.role === 'model' ? getContextBlockMetaFromMessage(msg) : null, [msg])
  const firstTextPartIndex = useMemo(() => msg.parts.findIndex(p => typeof p.text === 'string' && p.text.trim()), [msg.parts])
  const firstGroupContentPartIndex = useMemo(() => getGroupContentPartIndex(msg), [msg])
  // A row may contain both ordinary model content and a call in one persisted message.
  // Grouping the row does not make its text/images (or thinking owned by the previous
  // group) content of this group's card. The existing row flags still own visibility.
  const belongsToOrdinarySurface = (item: typeof visibleModelParts[number]) => {
    if (msg.role !== 'model') return false // Tool/result and event rows remain group content.
    if (llmError) return false
    if (item.webSearchAction) return hasVisibleTextContent // Preserve the text-bearing hosted-search exception.
    if (item.reasoningRun) return firstGroupContentPartIndex !== -1 && item.partIndex < firstGroupContentPartIndex
    return true
  }
  const ordinaryParts = surface === 'all' ? visibleModelParts : visibleModelParts.filter(belongsToOrdinarySurface)
  const groupedParts = surface === 'all' ? visibleModelParts : visibleModelParts.filter(item => !belongsToOrdinarySurface(item))
  const displayedParts = surface === 'ordinary' ? ordinaryParts : groupedParts
  const hasUserBody = textLikeParts.some(part => {
    const text = stripGeneratedDescriptorLines(getPartDisplayText(part), attachmentCorrelations)
    return parsePastedTextSegments(text).some(segment => segment.kind === 'pasted-text' || segment.text
      .replace(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g, (tag, ref: string) => attachmentCorrelations.has(ref) ? 'FILE' : tag)
      .split('\n').some(line => !!line.trim() && (row.literalUserText && !!part.text || showUserMessageMetadata || !parseFoxwarmMetadataLine(line.trim()))))
  })
  const ordinaryContent = msg.role === 'model' && (ordinaryParts.length > 0 || imageParts.length > 0)
  if (surface === 'ordinary' && (!ordinaryContent || sessionNotice)) return null
  if (surface === 'grouped' && msg.role === 'model' && groupedParts.length === 0 && !msg.parts.some(part => part.functionCall || part.functionResponse)) return null
  const suppressAnchor = groupFirst || (surface === 'grouped' && ordinaryContent)

  return (
    <div
      data-search-row={messageKey}
      data-chat-history-start-key={nestedDepth === 0 ? getMessageViewportAnchorKey(msg) || undefined : undefined}
      className={`flex w-full min-w-0 max-w-full ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${groupFirst ? '' : marginClass}`}
      data-chat-message-anchor-key={suppressAnchor ? undefined : anchorKey}
      data-context-scrollbar-anchor-key={suppressAnchor ? undefined : scrollbarAnchorKey}
    >
      <div
        className={`min-w-0 ${surface !== 'all' ? 'w-full' : widthClass} ${
          !systemLikeMessage && msg.role === 'user'
            ? 'flex flex-col items-end'
            : ''
        }`}
      >
        {row.communication ? <SessionMessageCard communication={row.communication} searchReveal={rowSearchTarget?.surface === 'communication'}><MarkdownContent text={row.communication.message} className="prose prose-sm dark:prose-invert max-w-none break-words text-fw-text" /></SessionMessageCard> : sessionNotice ? <SystemEventCard notice={sessionNotice} reveal={!!rowSearchTarget} /> : systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={messageKey} searchReveal={rowSearchTarget?.surface === 'system'} />
        ) : msg.role === 'user' ? (
          <>
          <AttachmentHistoryGrid correlations={attachmentCorrelations} imageParts={imageParts} pending={!!msg.__meta?.queuedPreview} />
          {hasUserBody && <div className={`${row.literalUserText !== undefined ? 'foxwarm-conversation-user' : ''} foxwarm-user-message-bubble min-w-0 max-w-full rounded-lg bg-fw-user-surface px-3 py-2 text-fw-user-text`}>
            {textLikeParts.map((part, partIdx) => (
              <div key={`user-part-${partIdx}`} className={hasInlineAttachmentFlow ? 'contents' : undefined}>
                {showUserMessageMetadata && inlineUserWrapperBoundaries?.close === partIdx && <UserWrapperBoundaryBreak afterMetadata={false} />}
                {part.system
                  && !hasInlineAttachmentFlow
                  && !isWrappedDirectChannelText(part.system)
                  ? <InlineMetaPart systemText={formatStructuredSystemText(part.system)} isUser={true} showUserMessageMetadata={showUserMessageMetadata} />
                  : <CollapsibleUserText part={part} conversationText={row.literalUserText === undefined ? undefined : getConversationUserPartText(part, row.literalUserText)} showUserMessageMetadata={showUserMessageMetadata} correlations={attachmentCorrelations} inlineFlow={hasInlineAttachmentFlow} searchPartIndex={msg.parts.indexOf(part)} searchSurface={rowSearchTarget?.surface} searchPastedIndex={rowSearchTarget?.pastedIndex} searchReveal={(rowSearchTarget?.surface === 'user' || rowSearchTarget?.surface === 'pasted') && rowSearchTarget.partIndex === msg.parts.indexOf(part)} />}
                {showUserMessageMetadata && inlineUserWrapperBoundaries?.open === partIdx && <UserWrapperBoundaryBreak afterMetadata />}
              </div>
            ))}
          </div>}
          </>
        ) : (
          <div className={`flex min-w-0 max-w-full flex-col ${usageAnchorRelative ? 'relative' : ''}`}>
            {displayedParts.map(({ part, webSearchAction, partIndex, reasoningRun }, partIdx) => {
              if (webSearchAction) {
                if (suppressWebSearchCards && !hasVisibleTextContent) {
                  return null
                }
                return <WebSearchCard key={`web-search-${partIdx}`} action={webSearchAction} />
              }
              if (reasoningRun) {
                if (row.reasoningPresentation[partIndex]?.hidden) return null
                // Ordinary output separates prior-group reasoning from this row's group.
                const foldedIntoGroupAbove = firstGroupContentPartIndex !== -1 && partIndex < firstGroupContentPartIndex
                const folded = foldedIntoGroupAbove ? hideFoldedThinking : collapsedGroup
                if (folded) return null
                const tokens = partIndex === reasoningRuns[0]?.[0].partIndex
                  && typeof reasoningTokens === 'number' && Number.isFinite(reasoningTokens) && reasoningTokens >= 0
                    ? reasoningTokens : undefined
                return <ReasoningCard key={`thinking-${partIndex}`} thinking={reasoningRun.map(item => item.thinking).join('\n')} parts={reasoningRun} reasoningTokens={hideMetrics ? undefined : tokens} tone="message" searchReveal={rowSearchTarget?.surface === 'reasoning' && reasoningRun.some(item => item.partIndex === rowSearchTarget.partIndex)} />
              }
              if (part.system) {
                return <InlineMetaPart key={`model-system-${partIdx}`} systemText={formatStructuredSystemText(part.system)} isUser={false} />
              }
              // Compare source part indices: `partIndex` indexes `msg.parts` like the folded-thinking
              // check above, while `partIdx` skips parts that are not rendered as model content.
              if (contextBlock && partIndex === firstTextPartIndex && part.text) {
                return <ContextBlockCard key={`ctx-block-${contextBlock.id}`} sessionId={sessionId} messageKey={messageKey} block={contextBlock} text={part.text} nestedDepth={nestedDepth} renderNestedMessages={renderNestedMessages} searchPartIndex={partIndex} searchReveal={rowSearchTarget?.surface === 'ctx' && rowSearchTarget.partIndex === partIndex} />
              }
              return <AssistantTextCard sessionId={sessionId} reasoningBadges={!hideMetrics && row.reasoningPresentation[partIndex]?.target === 'text' ? row.reasoningPresentation[partIndex]?.badges : undefined} conversation={conversationDetails || row.conversationPartIndex !== undefined} key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} annotations={part.providerMeta?.openaiResponses?.annotations} onOpenCodeCommit={onOpenCodeCommit} searchPartIndex={partIndex} searchReveal={rowSearchTarget?.surface === 'model' && rowSearchTarget.partIndex === partIndex} />
            })}
            {(surface !== 'grouped' || msg.role !== 'model') && <ImageParts imageParts={imageParts} keyPrefix={`message-${messageKey}`} />}
            {row.conversationPartIndex === undefined && surface !== 'ordinary' && !collapsedGroup && (interleavedToolGroup && pairedToolResponse ? <InterleavedToolGroup {...toolDisclosure} runningTool={runningTool} msg={msg} nextMsg={pairedToolResponse} messageKeyPrefix={messageKey} onOpenCodeFile={onOpenCodeFile} searchTarget={rowSearchTarget} /> : <ToolCallsBlock {...toolDisclosure} runningTool={runningTool} msg={msg} onOpenCodeFile={onOpenCodeFile} searchTarget={rowSearchTarget} />)}
            {row.conversationPartIndex === undefined && surface !== 'ordinary' && !collapsedGroup && (interleavedToolGroup ? null : <ToolResponsesBlock {...toolDisclosure} msg={msg} searchTarget={rowSearchTarget} />)}
            {surface !== 'ordinary' && usageBadge && <ModelUsageAnchor usage={usageBadge.usage} isMobile={isMobile} callCount={usageBadge.callCount} attribution={usageBadge.attribution} sessionId={sessionId} />}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => (
  prev.row === next.row &&
  prev.expandedTools.get(prev.row.key) === next.expandedTools.get(next.row.key) &&
  prev.onToolToggle === next.onToolToggle &&
  prev.isMobile === next.isMobile &&
  (prev.row.msg.role !== 'user' || prev.row.systemLikeMessage || prev.showUserMessageMetadata === next.showUserMessageMetadata) &&
  prev.conversationDetails === next.conversationDetails &&
  prev.neutralToolSuccess === next.neutralToolSuccess &&
  prev.groupFirst === next.groupFirst &&
  prev.surface === next.surface &&
  (prev.searchTarget?.rowKey === prev.row.key ? prev.searchTarget.id : null) === (next.searchTarget?.rowKey === next.row.key ? next.searchTarget.id : null) &&
  prev.sessionId === next.sessionId &&
  prev.nestedDepth === next.nestedDepth &&
  prev.hideMetrics === next.hideMetrics &&
  prev.onOpenCodeFile === next.onOpenCodeFile &&
  prev.onOpenCodeCommit === next.onOpenCodeCommit &&
  (!getContextBlockMetaFromMessage(prev.row.msg) || prev.renderNestedMessages === next.renderNestedMessages)
))

type TimelineGroupRows = { key: string; group: TimelineGroupView | null; rows: TimelineRowView[] }

interface TimelineGroupProps {
  group: TimelineGroupView
  rows: TimelineRowView[]
  rowProps: Omit<MessageRowProps, 'row'>
  onToggle: (key: string, expanded: boolean) => void
}

const TimelineGroup = memo(function TimelineGroup({ group, rows, rowProps, onToggle }: TimelineGroupProps) {
  const expanded = group.keepExpanded || !rows[0].collapsedGroup
  const { ref, prepare } = useThreadCardHeightTransition(expanded)
  const expand = useCallback(() => { prepare(); onToggle(group.key, true) }, [group.key, onToggle, prepare])
  const collapse = useCallback(() => { prepare(); onToggle(group.key, false) }, [group.key, onToggle, prepare])
  const first = rows[0]
  return (
    <div className="foxwarm-tool-group-slot min-w-0 max-w-full">
      <div
        ref={ref}
        className={`foxwarm-tool-group relative min-w-0 ${group.keepExpanded ? 'max-w-full' : first.widthClass} ${first.marginClass}`}
        data-tool-group={group.key}
        data-tool-group-expanded={expanded}
        data-chat-message-anchor-key={first.anchorKey}
        data-context-scrollbar-anchor-key={first.scrollbarAnchorKey}
      >
        {group.keepExpanded ? rows.map((row, index) => (
          <MessageRow key={row.key} row={row} {...rowProps} groupFirst={index === 0} />
        )) : (
          <>
            {rows.map((row, index) => <MessageRow key={`${row.key}-ordinary`} row={row} {...rowProps} groupFirst={index === 0} surface="ordinary" />)}
            <div className="foxwarm-tool-group-card-frame relative min-w-0 max-w-full">
              <ToolGroupSummaryCard items={group.summaryItems} onExpand={expanded ? collapse : expand} expanded={expanded}>
                {rows.map((row, index) => (
                  <MessageRow key={row.key} row={row} {...rowProps} groupFirst={index === 0} surface="grouped" />
                ))}
              </ToolGroupSummaryCard>
              {!expanded && first.usageBadge && (
                <ModelUsageAnchor usage={first.usageBadge.usage} isMobile={rowProps.isMobile} callCount={first.usageBadge.callCount} attribution={first.usageBadge.attribution} sessionId={rowProps.sessionId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
})

const ConversationUsage = memo(function ConversationUsage({ badge, pendingRequests, missingRequests, sessionId, children }: {
  children: ReactNode
  badge: TimelineUsageBadgeView | null | undefined
  pendingRequests: number
  missingRequests: number
  sessionId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const usage = badge?.usage
  const attribution = badge?.attribution
  const input = usage ? usage.cachedTokens + usage.inputTokens : 0
  const seq = attribution ? formatUsageMessageSeq(attribution.messageSeqs) : null
  const rows = usage && attribution ? [
    ['Requests', `${(badge.callCount || 0) + missingRequests + pendingRequests}${pendingRequests ? ` · ${pendingRequests} pending` : ''}${missingRequests ? ` · ${missingRequests} unavailable` : ''}`],
    ['Cached', usage.cachedTokens.toLocaleString()],
    ['Input', usage.inputTokens.toLocaleString()],
    ['Output', usage.outputTokens.toLocaleString()],
    ['Cache share', input ? `${(usage.cachedTokens / input * 100).toFixed(1)}%` : 'unavailable'],
    ['API time', formatDurationSummary(attribution.apiDurationsMs)],
    ['Time range', formatUsageTimes(attribution.timestamps)],
    ['Model', formatUsageModels(attribution.models)],
  ] : []
  return <div className="min-w-0 text-xs text-fw-text-muted" data-conversation-usage>
    <div className="foxwarm-conversation-statistics flex min-w-0 items-start justify-between gap-3" data-conversation-statistics>
      {children}
      {usage && <button type="button" aria-expanded={expanded} aria-label={expanded ? 'Hide process usage' : 'Show process usage'} className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-1 text-right tabular-nums hover:bg-fw-hover focus-visible:outline focus-visible:outline-fw-focus-ring"
      onClick={() => setExpanded(value => !value)}>
        {`${formatTokenCount(getUsageTotalTokens(usage))} tokens${missingRequests ? ' · partial' : ''}`}
      </button>}
    </div>
    {usage && expanded && <div className="flex min-w-0 justify-end"><div className="mt-1 grid w-fit min-w-0 max-w-full gap-1 rounded border border-fw-border px-3 py-2" data-conversation-usage-details>
      {rows.map(([label, value]) => <div key={label} className="flex min-w-0 justify-between gap-4"><span className="shrink-0">{label}</span><span className="min-w-0 break-words text-right tabular-nums">{value}</span></div>)}
      <div className="flex items-center justify-between gap-4"><span>Seq</span><span className="ml-auto">{seq?.label || 'unavailable'}</span>{seq && <button type="button" title="Copy message reference" aria-label="Copy message reference" onClick={async () => {
        await copyTextToClipboard(`sessionId=${sessionId} msg#${seq.target}`)
        setCopied(true)
      }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>}</div>
    </div></div>}
  </div>
})

const TimelineActivity = memo(function TimelineActivity({ row, identityKey, expanded, onToggle, rowProps }: {
  row: TimelineRowView
  identityKey: string
  expanded: boolean
  onToggle: (key: string, expanded: boolean) => void
  rowProps: Omit<MessageRowProps, 'row'>
}) {
  const { ref, prepare } = useThreadCardHeightTransition(expanded)
  const detailsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const activity = row.activity!
  const preview = activity.preview
  const showPreview = preview && !expanded
  const previewIndex = preview ? activity.messages.indexOf(preview.message) : -1
  const previewKey = previewIndex >= 0 ? getMessageStableKey(preview!.message, previewIndex) : undefined
  const previewSearch = previewKey && rowProps.searchTarget?.rowKey === row.key
    ? { ...rowProps.searchTarget, rowKey: previewKey } : null
  return (
    <div ref={ref} data-timeline-activity data-activity-expanded={expanded}
      data-chat-message-anchor-key={row.anchorKey} data-context-scrollbar-anchor-key={row.scrollbarAnchorKey}
      data-chat-history-start-key={rowProps.nestedDepth === 0 ? getMessageViewportAnchorKey(row.msg) || undefined : undefined}
      data-chat-history-end-key={getMessageViewportAnchorKey(activity.sources?.at(-1) || activity.messages.at(-1) || row.msg)}
      className={`min-w-0 ${row.widthClass} ${row.marginClass}`}>
      <ConversationUsage badge={activity.usage} pendingRequests={activity.pendingRequests || 0} missingRequests={activity.missingRequests || 0} sessionId={rowProps.sessionId}>
        {activity.runtimeOnly ? <div className="px-2 py-1 text-left text-xs text-fw-text-muted">{activity.summary}</div> : <button ref={toggleRef} data-activity-toggle="top" type="button" aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded ? 'Collapse activity' : 'Expand activity'}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline focus-visible:outline-fw-focus-ring"
          onClick={() => { prepare(); onToggle(identityKey, !expanded) }}>
          <ChevronRight size={13} aria-hidden="true" className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} /><span>{activity.summary}</span>
        </button>}
      </ConversationUsage>
      {expanded && !activity.runtimeOnly && <div id={detailsId} tabIndex={-1} role="region" aria-label="Activity details" className="foxwarm-conversation-process focus:outline-none min-w-0 border-l border-fw-border py-1 pl-2" data-activity-details data-search-row={previewKey ? row.key : undefined} data-search-message-key={previewKey}>
        {rowProps.renderNestedMessages(activity.messages, identityKey, rowProps.nestedDepth + 1, 'detailed', previewSearch)}
      </div>}
      {expanded && !activity.runtimeOnly && <button type="button" data-activity-toggle="bottom" aria-expanded="true" aria-controls={detailsId} aria-label="Collapse activity"
        className="mt-1 inline-flex items-center gap-2 rounded px-2 py-1 text-xs text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline focus-visible:outline-fw-focus-ring"
        onClick={() => { prepare(); onToggle(identityKey,false); requestAnimationFrame(() => toggleRef.current?.focus({preventScroll:true})) }}>
        <ChevronRight size={13} className="-rotate-90" aria-hidden="true"/>Collapse activity
      </button>}
      {showPreview && <div data-conversation-preview data-search-row={row.key} className="min-w-0">
        <AssistantTextCard sessionId={rowProps.sessionId} conversation text={preview.message.parts[preview.partIndex].text || ''} message={preview.message} searchPartIndex={preview.partIndex} searchReveal={rowProps.searchTarget?.rowKey === row.key} onOpenCodeCommit={rowProps.onOpenCodeCommit} />
      </div>}
    </div>
  )
})

const TimelineTimeSeparator = memo(function TimelineTimeSeparator({ marker }: { marker: TimelineTimeMarker }) {
  const { text, title } = formatTimelineTimeMarker(marker)
  return (
    <div data-timeline-time-separator className="my-3 w-full text-center text-[11px] text-fw-text-subtle">
      <time dateTime={new Date(marker.timestamp).toISOString()} title={title} className="tabular-nums">{text}</time>
    </div>
  )
})

const SessionTimeline = memo(function SessionTimeline({ sessionId, messages, reasoningPresentation, isRunningTool = false, isMobile, timelineView, showInterAgentMessages = true, showCommentary = true, showUsageBadge, showTimeDividers = true, showUserMessageMetadata = false, onOpenCodeFile, onOpenCodeCommit, nestedDepth = 0, searchTarget, historyMessages, currentHistoryMessages, activityDetails, runtimeState, busyStartedAt, renderMessageFooter }: ChatTimelineProps) {
  const hideMetrics = useMobileChatViewport()
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())
  const [expandedTools, setExpandedTools] = useState<ExpandedTools>(new Map())
  const rowsCacheRef = useRef<TimelineRowsCache | null>(null)
  const activityMembersRef = useRef(new Map<object | string, string>())
  const [clockTick, setClockTick] = useState(0)

  const renderNestedMessages = useCallback((nestedMessages: Message[], keyPrefix: string, nextNestedDepth: number, overrideView?: TimelineView, nestedSearchTarget?: SessionSearchMatch | null) => (
    <ChatTimeline
      key={keyPrefix}
      sessionId={sessionId}
      messages={nestedMessages}
      historyMessages={overrideView ? historyMessages || messages : undefined}
      reasoningPresentation={overrideView ? rowsCacheRef.current?.reasoningPresentation : undefined}
      isMobile={isMobile}
      timelineView={overrideView || timelineView}
      showInterAgentMessages={showInterAgentMessages}
      showCommentary={showCommentary}
      activityDetails={overrideView !== undefined}
      searchTarget={nestedSearchTarget}
      showUsageBadge={overrideView ? false : nextNestedDepth > 0 ? false : showUsageBadge}
      showTimeDividers={false}
      showUserMessageMetadata={showUserMessageMetadata}
      onOpenCodeFile={onOpenCodeFile}
      onOpenCodeCommit={onOpenCodeCommit}
      nestedDepth={nextNestedDepth}
    />
  ), [timelineView, showInterAgentMessages, showCommentary, historyMessages, messages, isMobile, onOpenCodeCommit, onOpenCodeFile, sessionId, showUsageBadge, showUserMessageMetadata])

  const rows = useMemo(() => {
    const input = { messages, reasoningPresentation, isRunningTool, isMobile, timelineView, showInterAgentMessages, showCommentary, showUsageBadge: showUsageBadge && !hideMetrics, showTimeDividers, nestedDepth, activityDetails, historyMessages, currentHistoryMessages, timing: { runtimeState, busyStartedAt, now: historyMessages && nestedDepth === 0 ? Date.now() : undefined }, expandedGroupKeys: expandedToolGroups }
    let result = buildTimelineRows(input, rowsCacheRef.current)
    // A search reveal is transient: include only its owning group without changing manual expansion state.
    if (searchTarget && timelineView === 'grouped' && nestedDepth === 0) {
      const targetIndex = result.rows.findIndex(row => row.key === searchTarget.rowKey)
      const targetRow = result.rows[targetIndex]
      const groupKey = searchTarget.surface === 'reasoning' && targetRow?.hideFoldedThinking
        ? result.rows.slice(0, targetIndex).reverse().find(row => row.group?.summaryItems.length)?.group?.key
        : targetRow?.group?.key || searchTarget.groupKey
      if (groupKey && !expandedToolGroups.has(groupKey)) {
        result = buildTimelineRows({ ...input, expandedGroupKeys: new Set([...expandedToolGroups, groupKey]) }, result.cache)
      }
    }
    rowsCacheRef.current = result.cache
    return result.rows
  }, [expandedToolGroups, timelineView, showInterAgentMessages, showCommentary, isMobile, isRunningTool, messages, reasoningPresentation, nestedDepth, activityDetails, historyMessages, currentHistoryMessages, clockTick, runtimeState, busyStartedAt, searchTarget, showUsageBadge, showTimeDividers, hideMetrics])


  // A loaded predecessor can change the projected first row without changing the process being read.
  // Retain its mounted identity (and nested disclosures), while Search keeps canonical row keys.
  const activityKeys = useMemo(() => {
    const keys = new Map<string, string>()
    const members = new Map([...activityMembersRef.current].filter(([key, identity]) => typeof key === 'string' && expandedToolGroups.has(identity)))
    const used = new Set<string>()
    for (const row of rows) {
      if (!row.activity) continue
      const parts = row.activity.messages.flatMap(message => message.parts.map(part => part.functionCall || part.functionResponse || part))
      const candidates = new Set([activityMembersRef.current.get(row.key), ...parts.map(part => activityMembersRef.current.get(part))].filter((key): key is string => !!key && !used.has(key)))
      const identity = [...candidates].find(key => expandedToolGroups.has(key)) || candidates.values().next().value || row.key
      used.add(identity)
      keys.set(row.key, identity)
      members.set(row.key, identity)
      for (const part of parts) members.set(part, identity)
    }
    activityMembersRef.current = members
    return keys
  }, [rows, expandedToolGroups])


  const dynamicTiming = rows.some(row => row.activity?.dynamic)
  useEffect(() => {
    if (!dynamicTiming) return
    const interval = window.setInterval(() => setClockTick(value => value + 1), 1000)
    return () => window.clearInterval(interval)
  }, [dynamicTiming])

  const groupedRows = useMemo(() => {
    const result: TimelineGroupRows[] = []
    for (const row of rows) {
      const group = timelineView === 'grouped' && row.group && row.group.summaryItems.length > 0 ? row.group : null
      const previous = result[result.length - 1]
      if (group && previous?.group?.key === group.key) {
        previous.rows.push(row)
      } else {
        result.push({ key: group?.key || row.key, group, rows: [row] })
      }
    }
    return result
  }, [timelineView, rows])

  const handleGroupToggle = useCallback((groupKey: string, expanded: boolean) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev)
      if (expanded) next.add(groupKey)
      else next.delete(groupKey)
      return next
    })
  }, [])

  const handleToolToggle = useCallback<ToolToggleHandler>((messageKey, toolKey, expanded, groupKey) => {
    setExpandedTools(previous => {
      const keys = new Set(previous.get(messageKey))
      if (expanded) keys.add(toolKey)
      else keys.delete(toolKey)
      const next = new Map(previous)
      if (keys.size) next.set(messageKey, keys)
      else next.delete(messageKey)
      return next
    })
    // Only the user's open action opts the containing run into staying open.
    // Later group collapse must win even while a member retains its own choice.
    if (expanded && groupKey) handleGroupToggle(groupKey, true)
  }, [handleGroupToggle])

  const replyFileSlots = useMemo(() => {
    const slots = new Map<number, ReturnType<typeof buildReplyFileGroups>>()
    if (nestedDepth > 0 || activityDetails) return slots
    const indices = new Map(messages.map((message, index) => [message, index]))
    const itemEnds = groupedRows.map(item => {
      const owned = item.rows.flatMap(row => row.activity?.sources || [row.msg]).map(message => indices.get(message)).filter((value): value is number => value !== undefined)
      return owned.length ? Math.max(...owned) : Infinity
    })
    let slot = -1
    for (const group of buildReplyFileGroups(messages, sessionId)) {
      while (slot + 1 < itemEnds.length && itemEnds[slot + 1] <= group.endIndex) slot++
      slots.set(slot, [...slots.get(slot) || [], group])
    }
    return slots
  }, [messages, groupedRows, sessionId, nestedDepth, activityDetails])
  const renderReplyFiles = (slot: number) => (replyFileSlots.get(slot) || []).map(group => <ReplyFileGrid key={group.key} files={group.files} />)

  const artifactSlots = useMemo(() => {
    const slots = new Map<number, ReturnType<typeof buildArtifactGroups>>()
    if (nestedDepth > 0 || activityDetails) return slots
    const indices = new Map(messages.map((message, index) => [message, index]))
    const ends = groupedRows.map(item => {
      const owned = item.rows.flatMap(row => row.activity?.sources || [row.msg]).map(m => indices.get(m)).filter((n): n is number => n !== undefined)
      return owned.length ? Math.max(...owned) : Infinity
    })
    let slot = -1
    for (const group of buildArtifactGroups(messages, sessionId)) {
      while (slot + 1 < ends.length && ends[slot + 1] <= group.endIndex) slot++
      slots.set(slot, [...slots.get(slot) || [], group])
    }
    return slots
  }, [messages, groupedRows, sessionId, nestedDepth, activityDetails])
  const renderArtifacts = (slot: number) => (artifactSlots.get(slot) || []).flatMap(group => group.artifacts.map(receipt => <ArtifactView key={`artifact:${receipt.artifactId}:${receipt.revision}`} receipt={receipt} />))

  const lastGroup = groupedRows[groupedRows.length - 1]
  const lastRow = lastGroup?.rows[lastGroup.rows.length - 1]
  const footerAlignment = lastRow?.msg.role === 'user' && !lastRow.systemLikeMessage && !lastRow.activity && !lastGroup.group ? 'right' : 'left'

  const rowProps = { hideMetrics, conversationDetails: activityDetails, neutralToolSuccess: timelineView === 'grouped', expandedTools, onToolToggle: handleToolToggle, isMobile, showUserMessageMetadata, sessionId, nestedDepth, onOpenCodeFile, onOpenCodeCommit, renderNestedMessages, searchTarget }

  return (
    <div className="foxwarm-chat-timeline min-w-0 max-w-full">
      {renderReplyFiles(-1)}
      {renderArtifacts(-1)}
      {groupedRows.flatMap((item, index) => [
        ...(item.rows[0].timeMarker ? [<TimelineTimeSeparator key={`${item.key}-time`} marker={item.rows[0].timeMarker} />] : []),
        item.rows[0].activity
          ? <TimelineActivity key={activityKeys.get(item.key) || item.key} identityKey={activityKeys.get(item.key) || item.key} row={item.rows[0]} rowProps={rowProps} expanded={expandedToolGroups.has(activityKeys.get(item.key) || item.key)} onToggle={handleGroupToggle} />
          : item.group
          ? <TimelineGroup key={item.key} group={item.group} rows={item.rows} rowProps={rowProps} onToggle={handleGroupToggle} />
          : <MessageRow key={item.key} row={item.rows[0]} {...rowProps} />,
        ...renderReplyFiles(index),
        ...renderArtifacts(index),
      ])}
      {renderMessageFooter?.(footerAlignment)}
    </div>
  )
})

const ChatTimeline = memo(function ChatTimeline(props: ChatTimelineProps) {
  return <SessionTimeline key={props.sessionId} {...props} />
})

export default ChatTimeline
