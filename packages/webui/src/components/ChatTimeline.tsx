import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Code, FileJson, Copy, Check } from 'lucide-react'
import {
  IconToggleButton,
  copyTextToClipboard,
  formatToolLabel,
  formatStructuredSystemText,
  isCollapsibleSystemText,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  isSystemLikeText,
  renderMarkdown,
  handleMarkdownLinkClick,
  renderSystemTextWithSessionLinks,
  type Message,
  type ToolTagItem,
  type ViewMode,
} from './chatShared'
import ImageParts from './ImageParts'
import ReasoningCard from './ReasoningCard'
import ContextBlockCard, { getContextBlockMetaFromMessage } from './ContextBlockCard'
import {
  InterleavedToolGroup,
  ToolCallsBlock,
  ToolGroupSummaryCard,
  ToolResponsesBlock,
  getToolResponseStatus,
} from './ToolTimelineItems'

const getMessageStableKey = (msg: Message, idx: number): string => {
  const meta = msg.__meta || {}
  if (meta.synthetic) return `synthetic-${String(meta.synthetic)}`
  if (meta.contextBlock?.id) return `ctx-block-${String(meta.contextBlock.sourceSessionId || 'local')}-${String(meta.contextBlock.id)}`
  if (meta.seq) return `seq-${String(meta.contextArchiveItem?.sourceSessionId || 'local')}-${String(meta.seq)}`
  if (meta.id) return `id-${String(meta.id)}`
  if (meta.timestamp !== undefined) return `ts-${String(meta.timestamp)}`
  return `idx-${idx}`
}

interface ChatTimelineProps {
  sessionId: string
  messages: Message[]
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
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

const ModelUsageBadge = memo(function ModelUsageBadge({ usage, isMobile, callCount }: { usage: NormalizedTokenUsage; isMobile: boolean; callCount?: number }) {
  return (
    <span
      className={`${isMobile ? 'gap-2' : 'gap-1.5'} inline-flex flex-row items-center rounded-md border border-slate-200 bg-white/85 px-2 py-1 font-mono leading-none shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/85`}
      title={formatUsageTitle(usage, callCount)}
    >
      {callCount ? <ModelUsageRow label="×" value={callCount} tone="normal" /> : null}
      <ModelUsageRow label="C" value={usage.cachedTokens} tone="muted" />
      <ModelUsageRow label="I" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
      <ModelUsageRow label="O" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
    </span>
  )
})

const ModelUsageAnchor = memo(function ModelUsageAnchor({ usage, isMobile, callCount }: { usage: NormalizedTokenUsage; isMobile: boolean; callCount?: number }) {
  if (isMobile) {
    return (
      <div className="pointer-events-none mb-2 mt-1 flex justify-end pr-1">
        <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} />
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute bottom-0 right-0 z-10 translate-x-[calc(100%+0.5rem)]">
      <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} />
    </div>
  )
})

const MarkdownContent = memo(function MarkdownContent({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} onClick={handleMarkdownLinkClick} />
})

const InlineMetaPart = memo(function InlineMetaPart({ systemText, isUser }: { systemText: string; isUser: boolean }) {
  return (
    <pre
      className={`whitespace-pre-wrap font-sans ${isUser ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}
      style={{ fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }}
    >
      {systemText.split('\n').map((line, lineIdx) => (
        <span key={lineIdx} style={{ display: 'block' }}>{renderSystemTextWithSessionLinks(line)}</span>
      ))}
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
        <pre className="whitespace-pre-wrap font-sans" style={{ lineHeight: '1.5em' }}>
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
  const shouldCollapse = !expanded

  return (
    <div className="w-full overflow-x-hidden">
      <div className="bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-700 dark:text-slate-300">
        <div className={shouldCollapse ? 'overflow-hidden' : ''} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : undefined}>
          <pre className="whitespace-pre-wrap font-sans text-sm" style={{ lineHeight: '1.5em' }}>
            {renderedText.split('\n').map((line, lineIdx) => {
              const isPrefix = isSystemLikeText(line)
              return (
                <span
                  key={`${messageKey}-${lineIdx}`}
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
            onClick={() => setExpanded(current => !current)}
            className="text-xs mt-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 text-left"
          >
            {expanded ? '▲ Show less' : '▼ Show more'}
          </button>
        )}
      </div>
      <ImageParts imageParts={msg.parts.filter(p => p.inlineData)} keyPrefix={messageKey} />
    </div>
  )
})

const AssistantTextCard = memo(function AssistantTextCard({ text, message }: { text: string; message: Message }) {
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const jsonText = useMemo(() => viewMode === 'json' ? JSON.stringify(message, null, 2) : '', [message, viewMode])

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
    <div className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${paddingClass} rounded-lg cursor-text relative group`}>
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
        <MarkdownContent
          text={text}
          className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100 prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
        />
      ) : viewMode === 'raw' ? (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100">{text}</pre>
      ) : (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto">{jsonText}</pre>
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
  keepToolGroupExpanded: boolean
  showToolGroupSummary: boolean
  groupExpanded: boolean
  onExpandGroup: (groupKey: string) => void
  sessionId: string
  nestedDepth: number
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
  keepToolGroupExpanded,
  showToolGroupSummary,
  groupExpanded,
  onExpandGroup,
  sessionId,
  nestedDepth,
  renderNestedMessages,
}: MessageRowProps) {
  const textLikeParts = useMemo(() => msg.parts.filter(p => p.text || p.system || p.thinking), [msg.parts])
  const imageParts = useMemo(() => msg.parts.filter(p => p.inlineData), [msg.parts])
  const usage = useMemo(() => getModelMessageUsage(msg), [msg])
  const isInToolGroup = summaryTagItems.length > 0
  const hasToolParts = useMemo(() => msg.parts.some(p => p.functionCall || p.functionResponse || p.thinking), [msg.parts])
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const systemLikeMessage = useMemo(() => {
    if (msg.role === 'model') return false
    return (
      msg.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
      msg.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
    )
  }, [msg])
  const shouldSkipMargin = !systemLikeMessage && (msg.role === 'model' || msg.role === 'tool') && (prevMsg?.role === 'model' || prevMsg?.role === 'tool')
  const isCollapsedToolGroup = groupTools && isInToolGroup && !groupExpanded && !keepToolGroupExpanded
  const hasInterleavedToolGroup = !!(nextMsg && nextMsg.role === 'tool' && nextMsg.parts.some(p => p.functionResponse) && msg.parts.some(p => p.functionCall))
  const displayUsage = showUsageBadge
    ? (isCollapsedToolGroup ? (showToolGroupSummary ? groupUsage : null) : usage)
    : null
  const displayUsageCallCount = isCollapsedToolGroup && showToolGroupSummary && groupUsageCallCount > 0 ? groupUsageCallCount : undefined
  const allowOverflow = (displayUsage && !isMobile) || hasToolParts || isInToolGroup
  const contextBlock = useMemo(() => msg.role === 'model' ? getContextBlockMetaFromMessage(msg) : null, [msg])
  const firstTextPartIndex = useMemo(() => msg.parts.findIndex(p => typeof p.text === 'string' && p.text.trim()), [msg.parts])
  const marginClass = nestedDepth > 0 ? 'mt-2' : (shouldSkipMargin ? '' : 'mt-4')
  const widthClass = systemLikeMessage
    ? (nestedDepth > 0 ? 'w-full max-w-full' : 'w-full max-w-[80%]')
    : msg.role === 'user'
      ? (nestedDepth > 0 ? 'max-w-[85%]' : 'max-w-[80%]')
      : isMobile || nestedDepth > 0
        ? 'w-full'
        : 'w-full max-w-[80%]'

  return (
    <div className={`flex ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${marginClass}`}>
      <div
        className={`${widthClass} ${
          !systemLikeMessage && msg.role === 'user'
            ? 'bg-blue-500 dark:bg-blue-600 text-white px-4 py-2 rounded-lg'
            : ''
        } ${allowOverflow ? 'overflow-visible' : 'overflow-x-hidden'}`}
      >
        {systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={messageKey} />
        ) : msg.role === 'user' ? (
          <div className="flex flex-col">
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
          <div className={`flex flex-col ${displayUsage && !isMobile ? 'relative' : ''}`}>
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
              return <AssistantTextCard key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} />
            })}
            <ImageParts imageParts={imageParts} keyPrefix={`message-${messageKey}`} />
            {groupTools && showToolGroupSummary && !groupExpanded && !keepToolGroupExpanded && (
              <ToolGroupSummaryCard items={summaryTagItems} onExpand={() => onExpandGroup(groupKey)} />
            )}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup && nextMsg ? <InterleavedToolGroup msg={msg} nextMsg={nextMsg} messageKeyPrefix={messageKey} /> : <ToolCallsBlock msg={msg} />)}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup ? null : <ToolResponsesBlock msg={msg} />)}
            {displayUsage && <ModelUsageAnchor usage={displayUsage} isMobile={isMobile} callCount={displayUsageCallCount} />}
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
  prev.keepToolGroupExpanded === next.keepToolGroupExpanded &&
  prev.showToolGroupSummary === next.showToolGroupSummary &&
  prev.groupExpanded === next.groupExpanded &&
  prev.sessionId === next.sessionId &&
  prev.nestedDepth === next.nestedDepth &&
  prev.renderNestedMessages === next.renderNestedMessages
))

const ChatTimeline = memo(function ChatTimeline({ sessionId, messages, isMobile, groupTools, showUsageBadge, nestedDepth = 0 }: ChatTimelineProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())

  const renderNestedMessages = useCallback((nestedMessages: Message[], keyPrefix: string, nextNestedDepth: number) => (
    <ChatTimeline
      key={keyPrefix}
      sessionId={sessionId}
      messages={nestedMessages}
      isMobile={isMobile}
      groupTools={groupTools}
      showUsageBadge={nextNestedDepth > 0 ? false : showUsageBadge}
      nestedDepth={nextNestedDepth}
    />
  ), [groupTools, isMobile, sessionId, showUsageBadge])

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

    const getToolGroupUsage = (startIdx: number): { usage: NormalizedTokenUsage | null; callCount: number } => {
      const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
      let callCount = 0

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
          }
        }
      }

      return { usage: callCount > 0 ? total : null, callCount }
    }

    const startIdxByIndex = messages.map((_, idx) => getToolGroupStartIdx(idx))
    const summaryTagItemsByStart = new Map<number, ToolTagItem[]>()
    const groupUsageByStart = new Map<number, NormalizedTokenUsage | null>()
    const groupUsageCallCountByStart = new Map<number, number>()
    const keepExpandedByStart = new Map<number, boolean>()
    startIdxByIndex.forEach((startIdx) => {
      if (!summaryTagItemsByStart.has(startIdx)) {
        const items = getToolGroupSummaryItems(startIdx)
        const groupUsage = getToolGroupUsage(startIdx)
        summaryTagItemsByStart.set(startIdx, items)
        groupUsageByStart.set(startIdx, groupUsage.usage)
        groupUsageCallCountByStart.set(startIdx, groupUsage.callCount)
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
    <>
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
            keepToolGroupExpanded={toolGroupMeta.keepExpandedByIndex[idx]}
            showToolGroupSummary={toolGroupMeta.shouldRenderSummary[idx]}
            groupExpanded={expandedToolGroups.has(groupKey)}
            onExpandGroup={handleExpandGroup}
            sessionId={sessionId}
            nestedDepth={nestedDepth}
            renderNestedMessages={renderNestedMessages}
          />
        )
      })}
    </>
  )
})

export default ChatTimeline
