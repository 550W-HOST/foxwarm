import { projectSessionCommunications, receivedSessionCommunication, type SessionCommunication } from './sessionCommunications'
import { getSessionNotice } from '../sessionNotices'
import type { TimelineView } from '../chatPreferences'
import {
  formatToolLabel,
  getLlmErrorMessageDetails,
  getToolResponseStatus,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  parseFoxwarmMetadataLine,
  type Message,
  type ToolTagItem,
} from './chatShared'
import { readPersistedRequestTiming, deriveRequestTimings, type DerivedRequestTiming, type DurationSample } from '../usageTiming'
import { getContextScrollbarAnchorKey, getMessageStableKey, getMessageViewportAnchorKey } from '../chatViewportState'
import { parsePastedTextSegments } from '../pastedText'
import { deriveTimelineTimeMarkers, selectTimelineTimeMarker, type TimelineTimeMarker } from './timelineTime'
import { deriveReasoningPresentation, isReasoningPart, sameReasoningPresentation, type ReasoningPartPresentation, type ReasoningPresentation } from './reasoningParts'
import { getContextBlockMetaFromMessage } from './ContextBlockCard'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { buildConversationActivitySummary } from './conversationActivity'
import { applyConversationTiming, readConversationWorkInterval, getConversationActivityStart, getConversationLiveRequestStart, type ConversationTimingContext } from './conversationTiming'
import { isCompactCompletionMaintenanceMessage } from '../../../shared/src/sessionContinuation'
import { getWebSearchAction } from '../webSearchAction'

/**
 * Explicit view model for one `ChatTimeline` render pass.
 *
 * Grouping, visibility and layout are decided from the whole message list in a single pass so the
 * component only renders rows. Every value here is a pure function of the message list and the
 * view options, which is what lets `MessageRow`'s `memo` compare a row object by identity: the
 * builder reuses the previous pass's object whenever the newly derived values are equal, so a
 * streaming update that only touches the tail leaves every other row identical.
 */

interface TokenUsage {
  cost?: number
  cachedTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedContentTokenCount?: number | null
  promptTokenCount?: number | null
  candidatesTokenCount?: number | null
}

export type NormalizedTokenUsage = {
  cost?: number
  cachedTokens: number
  inputTokens: number
  outputTokens: number
}

export type UsageAttribution = {
  models: string[]
  timestamps: Array<number | null | 'invalid'>
  apiDurationsMs: DurationSample[]
  /** One persisted model-message sequence per usage-bearing model message, in source order. */
  messageSeqs: Array<number | null>
}

/** Shared per-group view: every row of one tool-call group carries the same object. */
export interface TimelineGroupView {
  readonly key: string
  /** Counted tag entries (`exec ×4`, failed calls in their own entry, folded reasoning last). */
  readonly summaryItems: ToolTagItem[]
  readonly usage: NormalizedTokenUsage | null
  readonly callCount: number
  readonly attribution: UsageAttribution
  /** The final standalone tool group stays expanded instead of collapsing into a summary row. */
  readonly keepExpanded: boolean
}

export interface TimelineUsageBadgeView {
  readonly usage: NormalizedTokenUsage
  readonly callCount?: number
  readonly attribution: UsageAttribution
}

export interface ConversationActivityView {
  readonly messages: Message[]
  readonly closedAt?: Message
  readonly sources?: Message[]
  readonly preview?: { message: Message; partIndex: number }
  readonly usage?: TimelineUsageBadgeView | null
  readonly missingRequests?: number
  readonly pendingRequests?: number
  readonly summary: string
  readonly dynamic?: boolean
  readonly runtimeOnly?: boolean
}

export interface TimelineRowView {
  readonly communication?: SessionCommunication
  readonly key: string
  readonly msg: Message
  readonly reasoningPresentation: readonly (ReasoningPartPresentation | undefined)[]
  /** Conversation body slice; original indices retain Search and streaming identity. */
  readonly conversationImageOnly?: boolean
  readonly conversationPartIndex?: number
  /** Undefined outside Conversation user rows; false retains legacy channel metadata rendering. */
  readonly literalUserText?: boolean
  /** Ordered technical and explicitly folded display fragments, without duplicated standalone output. */
  readonly activity?: ConversationActivityView
  readonly prevMsg: Message | null
  readonly nextMsg: Message | null
  readonly pairedToolResponse: Message | null
  readonly runningTool: boolean
  readonly requestTiming: DerivedRequestTiming
  /**
   * Null for rows outside any callable run (for example a direct user message), so `group` is the
   * only group prop a row needs. Group state is read by the model/tool render branch only, so such
   * rows deliberately carry no enclosing group.
   */
  readonly group: TimelineGroupView | null
  /** In a collapsed group: its tool surfaces and standalone thinking are hidden. */
  readonly collapsedGroup: boolean
  readonly renderSummary: boolean
  readonly hideFoldedThinking: boolean
  readonly suppressWebSearchCards: boolean
  readonly usageBadge: TimelineUsageBadgeView | null
  readonly timeMarker: TimelineTimeMarker | null
  readonly usageAnchorRelative: boolean
  readonly systemLikeMessage: boolean
  readonly interleavedToolGroup: boolean
  readonly marginClass: string
  readonly widthClass: string
  readonly anchorKey?: string
  readonly scrollbarAnchorKey?: string
}

export interface TimelineRowsInput {
  readonly messages: Message[]
  /** Original part ownership supplied to the nested Conversation detail timeline. */
  readonly reasoningPresentation?: ReasoningPresentation
  readonly isRunningTool?: boolean
  readonly isMobile: boolean
  readonly showInterAgentMessages?: boolean
  readonly showCommentary?: boolean
  readonly timelineView: TimelineView
  readonly showUsageBadge: boolean
  readonly showTimeDividers: boolean
  readonly nestedDepth: number
  readonly activityDetails?: boolean
  readonly timing?: ConversationTimingContext
  readonly currentHistoryMessages?: readonly Message[]
  readonly historyMessages?: readonly Message[]
  readonly expandedGroupKeys: ReadonlySet<string>
}

export interface TimelineRowsCache {
  readonly rows: Map<string, TimelineRowView>
  readonly groups: Map<string, TimelineGroupView>
  readonly reasoningPresentation: ReasoningPresentation
}

export interface TimelineRowsResult {
  readonly rows: TimelineRowView[]
  readonly cache: TimelineRowsCache
}

const toTokenCount = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

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
    ...(typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? { cost: raw.cost } : {}),
  }
}

const getModelMessageUsage = (msg: Message) => msg.role === 'model' ? normalizeMessageUsage(msg.__meta?.usage) : null

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

const getValidMessageSeq = (msg: Message): number | null => {
  const seq = msg.__meta?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : null
}

const getMessageUsageAttribution = (msg: Message, timing: DerivedRequestTiming): UsageAttribution => ({
  models: [formatUsageModel(msg)],
  timestamps: [getUsageTimestamp(msg)],
  apiDurationsMs: [timing.apiDurationMs],
  messageSeqs: [getValidMessageSeq(msg)],
})

/** Whole event/reminder wrappers and metadata-classified display-only LLM retry notices may join a tool run; quoted content does not. */
const getGroupableSystemKind = (msg: Message): 'event' | 'goal-reminder' | 'llm-error' | null => {
  if (getSessionNotice(msg) && !getLlmErrorMessageDetails(msg)) return null
  if (getLlmErrorMessageDetails(msg)) return 'llm-error'
  if (msg.role !== 'user' || msg.parts.length !== 1) return null
  const part = msg.parts[0]
  const value = part.system || part.text || ''
  const opening = value.match(/^\s*(<foxwarm-system\b[^>]*>)/i)?.[1]
  if (!opening) return null
  const tag = parseFoxwarmMetadataLine(opening)
  const kind = tag?.attrs.kind
  if (tag?.tagName !== 'foxwarm-system' || tag.closing || (kind !== 'event' && kind !== 'goal-reminder')) return null
  const wrapper = value.trim()
  if (/\/\s*>$/.test(opening)) return wrapper === opening ? kind : null
  // Text-backed history uses standalone wrapper lines. A direct-user inline quote is not one.
  if (part.text && !/^\r?\n/.test(wrapper.slice(opening.length))) return null
  return wrapper.slice(opening.length).trimEnd().endsWith('</foxwarm-system>') ? kind : null
}

const isGroupableSystemMessage = (msg: Message): boolean => getGroupableSystemKind(msg) !== null

const isToolGroupableMessage = (msg: Message): boolean => (!getSessionNotice(msg) || !!getLlmErrorMessageDetails(msg)) && (msg.role === 'model' || msg.role === 'tool' || isGroupableSystemMessage(msg))

const isHeavySystemLikeMessage = (message: Message): boolean => {
  if (getSessionNotice(message)) return true
  if (getLlmErrorMessageDetails(message)) return true
  if (message.role === 'model') return false
  return (
    message.parts.some((part) => !!part.system && !isLightweightStructuredSystem(part.system)) ||
    message.parts.some((part) => !!part.text && (
      message.role === 'user'
        ? parsePastedTextSegments(part.text).some((segment) => segment.kind === 'text' && segment.text.split('\n').some(isHeavySystemTextLine))
        : part.text.split('\n').some(isHeavySystemTextLine)
    ))
  )
}

/** Structured ingress wins; legacy recognition is restricted to whole standalone wrappers. */
const getConversationInputKind = (message: Message): 'activity' | 'user' | 'legacy-user' => {
  if (receivedSessionCommunication(message)) return 'legacy-user'
  if (message.__meta?.queuedPreview && message.__meta.queueType !== 'user') return 'activity'
  let direct = !!message.__meta?.clientMessageId || message.__meta?.queueType === 'user'
  for (const part of message.parts) {
    if (!part.system) continue
    const tag = parseFoxwarmMetadataLine(part.system)
    if (tag?.tagName === 'foxwarm-message' && !tag.closing) {
      if (tag.attrs.type !== 'channel') return 'activity'
      direct = true
    } else if (!isLightweightStructuredSystem(part.system)) return 'activity'
    if (part.system.startsWith('The following message is a direct user message via channel;')) direct = true
  }
  if (direct) return 'user'
  const textParts = message.parts.filter(part => part.text?.trim())
  if (textParts.length === 0) return message.parts.some(part => part.inlineData || part.inlineDataRef || part.inlineDataUnavailable) ? 'user' : 'activity'
  if (textParts.length !== 1) return 'user'
  const text = textParts[0].text!.trim()
  // Pasted blocks and inline/fenced/quoted examples are ordinary user content.
  if (parsePastedTextSegments(text).some(segment => segment.kind === 'pasted-text')) return 'user'
  const opening = text.match(/^(<foxwarm-(?:system|message)\b[^>]*>)(?:\r?\n|$)/i)?.[1]
  const tag = opening ? parseFoxwarmMetadataLine(opening) : null
  if (tag && !tag.closing && (text === opening || text.endsWith(`</${tag.tagName}>`))) {
    return tag.tagName === 'foxwarm-message' && tag.attrs.type === 'channel' ? 'legacy-user' : 'activity'
  }
  return /^\[SYSTEM:[\s\S]*\]$/.test(text) && isHeavySystemTextLine(text.split('\n')[0]) ? 'activity' : 'user'
}

/** Select a retry/error from complete active history, never a viewport or nested slice. */
export function getHistoryTailLlmError(messages: readonly Message[]): Message | undefined {
  const tail = messages.findLast(message => isCommittedHistoryMessage(message) && !message.__meta?.queuedPreview)
  return tail && getLlmErrorMessageDetails(tail) ? tail : undefined
}

const hasConversationText = (part: Message['parts'][number]): boolean => (
  !!part.text?.trim() && !part.toolUseId && !part.functionResponse
)
const hasConversationImage = (part: Message['parts'][number]): boolean => (
  !!(part.inlineData || part.inlineDataRef || part.inlineDataUnavailable) && !part.toolUseId && !part.functionResponse
)

type ConversationRequest = { messages: Message[]; tools: boolean; complete: boolean }

/** Link only loaded segments within one CTX scope; never infer a work ID or change history. */
const conversationRequests = (history: readonly Message[], visible: readonly Message[]) => {
  const byMessage = new Map<Message, ConversationRequest>()
  let requests = new Map<string, ConversationRequest>()
  const loaded = new Set(history)
  for (const message of [...history, ...visible.filter(message => !loaded.has(message))]) {
    if (getContextBlockMetaFromMessage(message)) { requests = new Map(); continue }
    if (message.role !== 'model' || getLlmErrorMessageDetails(message)) continue
    const id = message.__meta?.llmRequestId
    const request = id ? requests.get(id) || { messages: [], tools: false, complete: false } : { messages: [], tools: false, complete: false }
    if (id) requests.set(id, request)
    request.messages.push(message)
    request.tools ||= message.parts.some(part => !!part.functionCall || !!getWebSearchAction(part.providerMeta?.openaiResponses?.outputItem))
    request.complete ||= !message.__meta?.streaming && isCommittedHistoryMessage(message) && message.__meta?.llmSegment?.complete !== false
    byMessage.set(message, request)
  }
  return byMessage
}

/** Ordinary model output breaks a tool run; tool-linked images stay with their tool response. */
export const getGroupContentPartIndex = (msg: Message): number => msg.parts.findIndex((part) => (
  (part.text && part.text.trim()) || (part.system && String(part.system).trim()) ||
  (msg.role === 'model' && !part.toolUseId && !part.functionResponse &&
    (part.inlineData || part.inlineDataRef || part.inlineDataUnavailable))
))

const hasToolCalls = (msg: Message): boolean => msg.parts.some((part) => part.functionCall)

const hasToolResponses = (msg: Message): boolean => msg.parts.some((part) => part.functionResponse)

/** Whole system event/reminder rows may sit between a call and result without changing pairing. */
const nextPairedToolResponse = (messages: Message[], index: number): Message | null => {
  if (messages[index].role !== 'model' || !hasToolCalls(messages[index])) return null
  let nextIndex = index + 1
  while (nextIndex < messages.length && isGroupableSystemMessage(messages[nextIndex])) nextIndex++
  const next = messages[nextIndex]
  return next?.role === 'tool' && hasToolResponses(next) ? next : null
}

const precedingPairedModelCallIndex = (messages: Message[], index: number): number => {
  let previousIndex = index - 1
  while (previousIndex >= 0 && isGroupableSystemMessage(messages[previousIndex])) previousIndex--
  return previousIndex >= 0 && messages[previousIndex].role === 'model' && hasToolCalls(messages[previousIndex])
    ? previousIndex
    : -1
}

/** A tool response that the preceding model call already renders stays in that call's card. */
const isHandledByPreviousGroup = (messages: Message[], index: number): boolean => (
  index > 0 && precedingPairedModelCallIndex(messages, index) !== -1
)

const getFinalStandaloneStartIdx = (messages: Message[]): number => {
  let lastIdx = messages.length - 1
  while (lastIdx >= 0 && isGroupableSystemMessage(messages[lastIdx])) lastIdx--
  if (lastIdx < 0) return -1

  const lastMsg = messages[lastIdx]
  if (lastMsg.role === 'tool' && hasToolResponses(lastMsg)) {
    const callIndex = precedingPairedModelCallIndex(messages, lastIdx)
    if (callIndex !== -1) return callIndex
    return lastIdx
  }
  if (lastMsg.role === 'model' && hasToolCalls(lastMsg)) return lastIdx
  return -1
}

interface GroupScan {
  readonly start: number
  /** Exclusive end of the group's message range. */
  readonly end: number
  /** Index of the model message whose ordinary content ends this group, or -1 for any other boundary. */
  readonly contentBreakIdx: number
}

/**
 * Resolves one group's message range. This single walk replaces the previous separate backward
 * start scan and the two forward summary/usage scans, which each repeated the same break rules.
 */
const scanGroup = (messages: Message[], start: number, finalStandaloneStartIdx: number, timeMarkers: readonly (TimelineTimeMarker | null)[]): GroupScan => {
  const startMsg = messages[start]

  // A standalone system notice cannot capture a later tool run; it only joins an existing one.
  if (isGroupableSystemMessage(startMsg)) return { start, end: start + 1, contentBreakIdx: -1 }

  // A message that only carries ordinary output does not own the tool run that follows it: that run forms its
  // own group with the same messages, so counting them here would render the same summary twice.
  if (startMsg.role === 'model' && !hasToolCalls(startMsg) && getGroupContentPartIndex(startMsg) !== -1) {
    return { start, end: start + 1, contentBreakIdx: -1 }
  }

  let end = start + 1
  for (let index = start + 1; index < messages.length; index++) {
    if (finalStandaloneStartIdx !== -1 && start < finalStandaloneStartIdx && index >= finalStandaloneStartIdx) break
    const msg = messages[index]
    if (!isToolGroupableMessage(msg)) break
    // Ordinary model output splits the group: content and everything after it belong to the
    // next group, while thinking before that content stays with the group that ends here.
    if (msg.role === 'model' && !getLlmErrorMessageDetails(msg) && getGroupContentPartIndex(msg) !== -1) {
      return { start, end: index, contentBreakIdx: index }
    }
    // A visible time marker belongs outside the group, after any complete call/result pair.
    if (msg.role === 'model' && hasToolCalls(msg) && timeMarkers[index]) break
    end = index + 1
  }
  return { start, end, contentBreakIdx: -1 }
}

interface GroupDerivation {
  readonly items: ToolTagItem[]
  readonly usage: NormalizedTokenUsage | null
  readonly callCount: number
  readonly attribution: UsageAttribution
  readonly foldedThinkingIdx: number
}

const deriveGroup = (messages: Message[], scan: GroupScan, requestTimings: DerivedRequestTiming[]): GroupDerivation => {
  const { start, end, contentBreakIdx } = scan

  // Call statuses are resolved over the whole range first, because a response can appear after the
  // call it answers, and the counted tags below need the final status.
  const toolStatusById = new Map<string, 'success' | 'error'>()
  let groupHasToolCalls = false
  for (let index = start; index < end; index++) {
    for (const part of messages[index].parts) {
      if (part.functionCall) groupHasToolCalls = true
      if (part.functionResponse?.tool_use_id) {
        const nextStatus = getToolResponseStatus(part.functionResponse)
        const prevStatus = toolStatusById.get(part.functionResponse.tool_use_id)
        toolStatusById.set(
          part.functionResponse.tool_use_id,
          prevStatus === 'error' || nextStatus === 'error' ? 'error' : 'success',
        )
      }
    }
  }

  const startMsg = messages[start]
  const startFirstContentIdx = startMsg.role === 'model' ? getGroupContentPartIndex(startMsg) : -1
  // Only the parts from the start message's own ordinary output on belong to this group's summary.
  const startPartFrom = startFirstContentIdx > 0 ? startFirstContentIdx : 0

  const items: ToolTagItem[] = []
  const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const attribution: UsageAttribution = { models: [], timestamps: [], apiDurationsMs: [], messageSeqs: [] }
  let callCount = 0

  for (let index = start; index < end; index++) {
    const msg = messages[index]
    const systemKind = groupHasToolCalls ? getGroupableSystemKind(msg) : null
    if (systemKind === 'llm-error') {
      const details = getLlmErrorMessageDetails(msg)
      for (let line = 0; line < (details?.lineCount || 0); line++) {
        items.push({ name: 'system-llm-error', label: 'LLM error', tone: 'system' })
      }
    } else if (systemKind) {
      items.push({ name: `system-${systemKind}`, label: systemKind === 'event' ? 'Event' : 'Goal reminder', tone: 'system' })
    }
    const parts = index === start ? msg.parts.slice(startPartFrom) : msg.parts
    parts.forEach((part) => {
      // Thinking folds into the summary whenever the group holds tool calls, including messages
      // that also carry text.
      if (isReasoningPart(part) && groupHasToolCalls) {
        items.push({ name: 'reasoning', label: 'Reasoning', tone: 'neutral' })
      }
      if (part.functionCall) {
        const status = part.functionCall.id ? toolStatusById.get(part.functionCall.id) : undefined
        items.push({
          name: part.functionCall.name,
          toolCall: true,
          label: formatToolLabel(part.functionCall.name, part.functionCall.args),
          tone: status === 'error' ? 'error' : status === 'success' ? 'success' : 'neutral',
        })
      }
    })

    if (msg.role !== 'model') continue
    const usage = getModelMessageUsage(msg)
    if (!usage) continue

    total.cachedTokens += usage.cachedTokens
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost
    callCount++
    const messageAttribution = getMessageUsageAttribution(msg, requestTimings[index])
    attribution.models.push(...messageAttribution.models)
    attribution.timestamps.push(...messageAttribution.timestamps)
    attribution.apiDurationsMs.push(...messageAttribution.apiDurationsMs)
    attribution.messageSeqs.push(...messageAttribution.messageSeqs)
  }

  // The message whose ordinary output ends this group keeps its own group for everything after that
  // content, but earlier thinking belongs here: it is counted in this summary and stays folded
  // while this group is collapsed.
  const trailing = contentBreakIdx !== -1 ? messages[contentBreakIdx] : undefined
  let foldedThinkingIdx = -1
  if (groupHasToolCalls && trailing) {
    const trailingFirstContentIdx = trailing.role === 'model' ? getGroupContentPartIndex(trailing) : -1
    const foldedThoughts = trailingFirstContentIdx === -1
      ? []
      : trailing.parts.slice(0, trailingFirstContentIdx).filter(isReasoningPart)
    if (foldedThoughts.length > 0) {
      foldedThinkingIdx = contentBreakIdx
      foldedThoughts.forEach(() => items.push({ name: 'reasoning', label: 'Reasoning', tone: 'neutral' }))
    }
  }

  return {
    items,
    usage: callCount > 0 ? total : null,
    callCount,
    attribution,
    foldedThinkingIdx,
  }
}

const sameRequestTiming = (a: DerivedRequestTiming, b: DerivedRequestTiming): boolean => (
  a === b || a.apiDurationMs === b.apiDurationMs
)

const sameTokenUsage = (a: NormalizedTokenUsage | null, b: NormalizedTokenUsage | null): boolean => (
  a === b || (!!a && !!b && a.cachedTokens === b.cachedTokens && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.cost === b.cost)
)

const sameTagItems = (a: ToolTagItem[], b: ToolTagItem[]): boolean => (
  a === b || (a.length === b.length && a.every((item, index) => (
    item.name === b[index].name && item.label === b[index].label && item.tone === b[index].tone && item.toolCall === b[index].toolCall
  )))
)

const sameSampleList = (a: DurationSample[], b: DurationSample[]): boolean => (
  a === b || (a.length === b.length && a.every((sample, index) => sample === b[index]))
)

const sameStringList = (a: string[], b: string[]): boolean => (
  a === b || (a.length === b.length && a.every((value, index) => value === b[index]))
)

const sameMessageSeqs = (a: Array<number | null>, b: Array<number | null>): boolean => (
  a === b || (a.length === b.length && a.every((seq, index) => seq === b[index]))
)

const sameAttribution = (a: UsageAttribution, b: UsageAttribution): boolean => (
  a === b || (
    sameStringList(a.models, b.models)
    && sameSampleList(a.timestamps, b.timestamps)
    && sameSampleList(a.apiDurationsMs, b.apiDurationsMs)
    && sameMessageSeqs(a.messageSeqs, b.messageSeqs)
  )
)

const sameUsageBadge = (a: TimelineUsageBadgeView | null, b: TimelineUsageBadgeView | null): boolean => (
  a === b || (!!a && !!b && a.callCount === b.callCount && sameTokenUsage(a.usage, b.usage) && sameAttribution(a.attribution, b.attribution))
)

const sameGroupView = (a: TimelineGroupView, b: TimelineGroupView): boolean => (
  a.key === b.key
  && a.keepExpanded === b.keepExpanded
  && a.callCount === b.callCount
  && sameTokenUsage(a.usage, b.usage)
  && sameTagItems(a.summaryItems, b.summaryItems)
  && sameAttribution(a.attribution, b.attribution)
)

const sameRowView = (a: TimelineRowView, b: TimelineRowView): boolean => (
  a.key === b.key
  && a.msg === b.msg
  && sameReasoningPresentation(a.reasoningPresentation, b.reasoningPresentation)
  && a.conversationPartIndex === b.conversationPartIndex
  && a.conversationImageOnly === b.conversationImageOnly
  && a.literalUserText === b.literalUserText
  && a.communication?.key === b.communication?.key && a.communication?.direction === b.communication?.direction
  && a.communication?.peerSessionId === b.communication?.peerSessionId && a.communication?.message === b.communication?.message && a.communication?.truncated === b.communication?.truncated
  && a.activity === b.activity
  && a.prevMsg === b.prevMsg
  && a.nextMsg === b.nextMsg
  && a.pairedToolResponse === b.pairedToolResponse
  && a.runningTool === b.runningTool
  && a.group === b.group
  && a.collapsedGroup === b.collapsedGroup
  && a.renderSummary === b.renderSummary
  && a.hideFoldedThinking === b.hideFoldedThinking
  && a.suppressWebSearchCards === b.suppressWebSearchCards
  && a.systemLikeMessage === b.systemLikeMessage
  && a.interleavedToolGroup === b.interleavedToolGroup
  && a.marginClass === b.marginClass
  && a.widthClass === b.widthClass
  && a.anchorKey === b.anchorKey
  && a.scrollbarAnchorKey === b.scrollbarAnchorKey
  && a.usageAnchorRelative === b.usageAnchorRelative
  && (a.timeMarker === b.timeMarker || a.timeMarker?.timestamp === b.timeMarker?.timestamp)
  && sameRequestTiming(a.requestTiming, b.requestTiming)
  && sameUsageBadge(a.usageBadge, b.usageBadge)
)

const reuseWhenEqual = <T,>(previous: T | undefined, next: T, isEqual: (a: T, b: T) => boolean): T => (
  previous !== undefined && isEqual(previous, next) ? previous : next
)

/** Conversation disclosures and their immediately following ordinary text share one clock surface. */
const applyConversationTimeMarkers = (
  rows: readonly TimelineRowView[], messages: readonly Message[], history: readonly Message[],
  boundary: (message: Message) => 'visible' | 'context' | undefined,
  timing?: ConversationTimingContext,
): TimelineRowView[] => {
  const isBody = (row: TimelineRowView | undefined) => row?.msg.role === 'model'
    && !getContextBlockMetaFromMessage(row.msg) && row.conversationPartIndex !== undefined
    && hasConversationText(row.msg.parts[row.conversationPartIndex])
  const sources = new Set<Message>()
  const starts = new Set<TimelineRowView>()
  rows.forEach((row, index) => {
    if (rows[index - 1]?.activity && isBody(row)) return
    const pairedActivity = row.activity && isBody(rows[index + 1])
    if (!row.activity && !pairedActivity && (row.msg.role === 'tool' || isGroupableSystemMessage(row.msg))) return
    if (!sources.has(row.msg)) starts.add(row)
    sources.add(row.msg)
  })
  const activities = new Map(rows.filter(row => row.activity && !row.activity.runtimeOnly).map(row => [row.msg.__meta, row]))
  // Resolve each logical origin within its CTX scope, then date later units from their visible cut.
  const unitStarts = new Map<Message['__meta'], number | null>()
  let scope: Message[] = []
  let contextFloor: number | undefined
  let hasContext = false
  const finishScope = () => {
    const requestOrigins = new Map<string, number>()
    for (const message of scope) {
      if (message.role !== 'model' || !message.__meta?.llmRequestId) continue
      const timing = readPersistedRequestTiming(message.__meta.llmRequestTiming)
      if (timing && timing !== 'invalid') requestOrigins.set(message.__meta.llmRequestId, timing.startedAt)
    }
    const firstBoundary = scope.findIndex(message => !!boundary(message))
    const leading = scope.slice(0, firstBoundary < 0 ? undefined : firstBoundary + (scope[firstBoundary].role === 'model' ? 1 : 0))
    const liveStart = getConversationLiveRequestStart(timing)
    const scopedLiveStart = hasContext ? contextFloor !== undefined && liveStart !== undefined ? Math.max(contextFloor, liveStart) : undefined : liveStart
    const leadingStart = getConversationActivityStart(leading, scope, scopedLiveStart)
    let previousVisible: Message | undefined
    const seenRequests = new Set<string>()
    for (const message of scope) {
      const id = message.role === 'model' ? message.__meta?.llmRequestId : undefined
      if (id) {
        if (previousVisible && (previousVisible.role === 'model' && previousVisible.__meta?.llmRequestId === id
          || previousVisible.role !== 'model' && seenRequests.has(id))) {
          unitStarts.set(message.__meta, previousVisible.__meta?.timestamp ?? null)
        } else if (message.__meta?.llmSegment && (!requestOrigins.has(id) || message.__meta.llmSegment.outputStart > 0 && !seenRequests.has(id))) {
          unitStarts.set(message.__meta, null) // A missing prefix/origin cannot date this display segment.
        } else if (requestOrigins.has(id)) unitStarts.set(message.__meta, requestOrigins.get(id)!)
        seenRequests.add(id)
      }
      const row = activities.get(message.__meta)
      if (row) {
        const maintenanceOnly = row.activity!.messages.every(isCompactCompletionMaintenanceMessage)
        if (maintenanceOnly) unitStarts.set(message.__meta, null)
        else if (!previousVisible && (unitStarts.get(message.__meta) !== null || message.__meta?.llmSegment?.outputStart === 0 && scopedLiveStart !== undefined)) unitStarts.set(message.__meta, leadingStart ?? null)
        else if (!unitStarts.has(message.__meta) && (message.role === 'tool' || isGroupableSystemMessage(message))) {
          const executions = message.parts.map(part => readConversationWorkInterval(part.functionResponse?.executionTiming)).filter((value): value is NonNullable<typeof value> => !!value)
          const start = message.role === 'tool'
            ? executions.length ? Math.min(...executions.map(value => value.start)) : undefined
            : getConversationActivityStart([message], scope)
          const cut = previousVisible?.__meta?.timestamp
          const crossesCut = cut !== undefined && executions.some(value => value.start <= cut && value.end >= cut)
          if (start !== undefined) unitStarts.set(message.__meta, crossesCut ? Math.max(start, cut!) : start)
          else if (!isBody(rows[rows.indexOf(row) + 1])) unitStarts.set(message.__meta, null)
        }
      }
      if (boundary(message) === 'visible' || message.role === 'model' && message.parts.some(hasConversationImage)) previousVisible = message
    }
    scope = []
  }
  for (const message of history) {
    if (boundary(message) === 'context') {
      finishScope()
      hasContext = true
      contextFloor = typeof message.__meta?.timestamp === 'number' && Number.isFinite(message.__meta.timestamp) && message.__meta.timestamp > 0 ? message.__meta.timestamp : undefined
      continue
    }
    if (isCommittedHistoryMessage(message) && !message.__meta?.synthetic && !message.__meta?.queuedPreview) scope.push(message)
  }
  finishScope()
  // Keep every raw persisted baseline, but only visible unit starts can own a clock.
  const markers = deriveTimelineTimeMarkers(messages, isGroupableSystemMessage, message => sources.has(message),
    (message, fallback) => unitStarts.has(message.__meta) ? unitStarts.get(message.__meta)! : fallback)
  const byMessage = new Map(messages.map((message, index) => [message, markers[index]]))
  return rows.map(row => {
    if (row.activity?.runtimeOnly) return row
    const marker = starts.has(row) ? byMessage.get(row.msg) ?? null : null
    return row.timeMarker?.timestamp === marker?.timestamp ? row : { ...row, timeMarker: marker }
  })
}

export const buildTimelineRows = (input: TimelineRowsInput, previous: TimelineRowsCache | null): TimelineRowsResult => {
  // Planner transcripts remain diagnostics; never render them as ordinary replies or inflate foreground usage.
  const preview = (message: Message) => message.__meta?.compactPreview === true && message.__meta?.temporary === true
  if (input.messages.some(preview) || input.historyMessages?.some(preview)) input = { ...input,
    messages: input.messages.filter(message => !preview(message)),
    ...(input.historyMessages ? { historyMessages: input.historyMessages.filter(message => !preview(message)) } : {}),
  }
  const { messages, isRunningTool = false, isMobile, timelineView, showInterAgentMessages = true, showCommentary = true, showUsageBadge, showTimeDividers, nestedDepth, expandedGroupKeys, activityDetails, historyMessages } = input
  const grouped = timelineView === 'grouped'
  const reasoningPresentation = input.reasoningPresentation || deriveReasoningPresentation(messages, message => (
    !!getContextBlockMetaFromMessage(message) || message.role === 'user' && !isGroupableSystemMessage(message)
  ))
  const requestTimings = deriveRequestTimings(messages)
  const timeMarkers = showTimeDividers && nestedDepth === 0 && timelineView !== 'conversation' ? deriveTimelineTimeMarkers(messages, isGroupableSystemMessage) : []
  const messageKeys = messages.map((msg, index) => getMessageStableKey(msg, index))
  const finalStandaloneStartIdx = getFinalStandaloneStartIdx(messages)

  const rows: TimelineRowView[] = []
  const rowCache = new Map<string, TimelineRowView>()
  const groupCache = new Map<string, TimelineGroupView>()
  let previousIsThreadLike = false
  let foldedThinkingOwnerKey: string | null = null

  const anchoredMessages = new Set<number>()
  const emitRow = (index: number, group: TimelineGroupView | null, isGroupStart: boolean, foldedOwnerKey: string | null, conversation?: { key: string; partIndex?: number; imageOnly?: boolean; literalUserText?: boolean; activity?: TimelineRowView['activity']; communication?: SessionCommunication }): void => {
    const msg = messages[index]
    const prevMsg = index > 0 ? messages[index - 1] : null
    const nextMsg = index < messages.length - 1 ? messages[index + 1] : null
    const systemLikeMessage = !!conversation?.communication || (conversation && !conversation.activity && msg.role === 'user' ? false : isHeavySystemLikeMessage(msg))
    const threadLikeMessage = systemLikeMessage || msg.role === 'model' || msg.role === 'tool'
    const shouldSkipMargin = threadLikeMessage && previousIsThreadLike
    previousIsThreadLike = threadLikeMessage

    if (!conversation && msg.role === 'tool' && isHandledByPreviousGroup(messages, index)) {
      // The preceding call's card already renders this response.
      return
    }

    const activeGroup = group !== null && group.summaryItems.length > 0 ? group : null
    const groupExpanded = group !== null && expandedGroupKeys.has(group.key)
    const collapsedGroup = grouped && activeGroup !== null && !groupExpanded && !activeGroup.keepExpanded
    if (collapsedGroup && isGroupableSystemMessage(msg)) return
    const requestTiming = requestTimings[index]
    const ownUsage = getModelMessageUsage(msg)
    const usageBadge: TimelineUsageBadgeView | null = !showUsageBadge || conversation
      ? null
      : collapsedGroup
        ? (isGroupStart && activeGroup !== null && activeGroup.usage
          ? { usage: activeGroup.usage, ...(activeGroup.callCount > 0 ? { callCount: activeGroup.callCount } : {}), attribution: activeGroup.attribution }
          : null)
        : ownUsage
          ? { usage: ownUsage, attribution: getMessageUsageAttribution(msg, requestTiming) }
          : null

    const key = conversation?.key || messageKeys[index]
    const ownsAnchor = !anchoredMessages.has(index)
    anchoredMessages.add(index)
    const pairedToolResponse = nextPairedToolResponse(messages, index)
    const next: TimelineRowView = {
      key,
      msg,
      reasoningPresentation: msg.parts.map(part => reasoningPresentation.get(part)),
      ...(conversation ? { conversationPartIndex: conversation.partIndex, conversationImageOnly: conversation.imageOnly, literalUserText: conversation.literalUserText, activity: conversation.activity } : {}),
      prevMsg,
      nextMsg,
      pairedToolResponse,
      runningTool: isRunningTool && index === finalStandaloneStartIdx,
      requestTiming,
      group,
      ...(conversation?.communication ? { communication: conversation.communication } : {}),
      collapsedGroup,
      renderSummary: grouped && isGroupStart && activeGroup !== null && !groupExpanded && !activeGroup.keepExpanded,
      hideFoldedThinking: grouped && foldedOwnerKey !== null && !expandedGroupKeys.has(foldedOwnerKey),
      // Web-search cards are content of the group, so they are hidden exactly while the group is
      // collapsed into its summary row. Reusing `collapsedGroup` keeps the keep-expanded tail group
      // from hiding its own cards.
      suppressWebSearchCards: collapsedGroup,
      usageBadge,
      timeMarker: ownsAnchor ? timeMarkers[index] ?? null : null,
      usageAnchorRelative: usageBadge !== null && !isMobile,
      systemLikeMessage,
      interleavedToolGroup: pairedToolResponse !== null,
      marginClass: activityDetails ? '' : nestedDepth > 0 ? 'mt-2' : (shouldSkipMargin ? '' : 'mt-4'),
      widthClass: systemLikeMessage
        ? (isMobile || nestedDepth > 0 ? 'w-full' : 'w-full max-w-[80%]')
        : msg.role === 'user'
          ? (nestedDepth > 0 ? 'max-w-[85%]' : 'max-w-[80%]')
          : isMobile || nestedDepth > 0
            ? 'w-full'
            : 'w-full max-w-[80%]',
      ...(nestedDepth === 0 && ownsAnchor ? { anchorKey: getMessageViewportAnchorKey(msg) || undefined } : {}),
      ...(nestedDepth === 0 && ownsAnchor ? { scrollbarAnchorKey: getContextScrollbarAnchorKey(msg) || undefined } : {}),
    }

    const cached = reuseWhenEqual(previous?.rows.get(key), next, sameRowView)
    rowCache.set(key, cached)
    rows.push(cached)
  }

  if (timelineView === 'conversation') {
    const authoritativeHistory = input.currentHistoryMessages ?? historyMessages
    const historyTailLlmError = authoritativeHistory ? getHistoryTailLlmError(authoritativeHistory) : undefined
    const requests = conversationRequests(historyMessages || messages, messages)
    const summaryForActivity = buildConversationActivitySummary(messages, historyMessages)
    const communications = projectSessionCommunications([...new Set([...(historyMessages || messages), ...messages])])
    // Retry cards use the active-history tail rule, not the general event escape hatch.
    const isStandaloneNotice = (msg: Message): boolean => !!getSessionNotice(msg) && !getLlmErrorMessageDetails(msg)
    // Explicit phase wins; otherwise only this loaded logical request's actual tools justify folding.
    const visibleText = (msg: Message, part: Message['parts'][number]) => hasConversationText(part)
      && (showCommentary || (part.phase ? part.phase !== 'commentary' : !requests.get(msg)?.tools))
    const boundary = (msg: Message, partIndex?: number): 'visible' | 'context' | undefined => {
      if (communications.has(msg)) return showInterAgentMessages ? 'visible' : undefined
      if (isStandaloneNotice(msg)) return 'visible'
      if (getContextBlockMetaFromMessage(msg)) return 'context'
      if (msg.role === 'user' && getConversationInputKind(msg) !== 'activity') return 'visible'
      if (msg.role === 'model' && !getLlmErrorMessageDetails(msg) && (partIndex === undefined ? msg.parts.some(part => visibleText(msg, part)) : visibleText(msg, msg.parts[partIndex]))) return 'visible'
      return undefined
    }
    let activityStart = -1
    let activityKey = ''
    let activityMessages: Message[] = []
    let activitySources = new Set<Message>()
    let lastActivitySource = -1
    const requestOwners = new Map<ConversationRequest, string>()
    const flushActivity = (hasReply = false, closedAt?: Message) => {
      if (activityStart < 0) return
      const summary = summaryForActivity(activityMessages)
      const sources = [...activitySources]
      const old = previous?.rows.get(activityKey)?.activity
      // Reuse unchanged fragments as well as rows; a clock tick must not remount their disclosures.
      activityMessages = activityMessages.map((message, index) => {
        const prior = old?.messages[index]
        return prior && prior.__meta === message.__meta && prior.role === message.role && prior.parts.length === message.parts.length
          && prior.parts.every((part, partIndex) => part === message.parts[partIndex]) ? prior : message
      })
      let preview: ConversationActivityView['preview']
      if (!hasReply) {
        for (const message of activityMessages) {
          message.parts.forEach((part, partIndex) => { if (message.role === 'model' && !getLlmErrorMessageDetails(message) && hasConversationText(part)) preview = { message, partIndex } })
        }
      }
      for (const source of sources) {
        const request = requests.get(source)
        if (request && !requestOwners.has(request)) requestOwners.set(request, activityKey)
      }
      const activity = old && old.summary === summary && old.closedAt === closedAt && old.preview?.message === preview?.message && old.preview?.partIndex === preview?.partIndex
        && old.messages.length === activityMessages.length && old.messages.every((msg, i) => msg === activityMessages[i])
        && old.sources?.length === sources.length && old.sources.every((msg, i) => msg === sources[i])
        ? old : { messages: activityMessages, sources, preview, summary, closedAt }
      emitRow(activityStart, null, false, null, { key: activityKey, activity })
      activityStart = -1
      activityMessages = []
      activitySources = new Set()
      lastActivitySource = -1
    }
    const beginActivity = (index: number, partIndex = 0) => {
      if (activityStart < 0) {
        activityStart = index
        activityKey = `${messageKeys[index]}-activity-${partIndex}`
      }
      activitySources.add(messages[index])
    }
    const addActivity = (index: number, fragment: Message, partIndex = 0) => {
      if (messages[index].__meta?.queuedPreview) return
      const previousRow = rows.at(-1)
      if (activityStart < 0 && isCompactCompletionMaintenanceMessage(fragment) && previousRow?.activity?.closedAt) {
        const members = [...previousRow.activity.messages, fragment]
        rows[rows.length - 1] = { ...previousRow, activity: { ...previousRow.activity, messages: members, sources: [...previousRow.activity.sources || [], messages[index]] } }
        return
      }
      beginActivity(index, partIndex)
      if (lastActivitySource === index) {
        const last = activityMessages[activityMessages.length - 1]
        activityMessages[activityMessages.length - 1] = { ...last, parts: [...last.parts, ...fragment.parts] }
      } else activityMessages.push(fragment)
      lastActivitySource = index
    }
    messages.forEach((msg, index) => {
      const contextBlock = msg.role === 'model' && getContextBlockMetaFromMessage(msg)
      if (isStandaloneNotice(msg) || contextBlock || nestedDepth === 0 && (msg === historyTailLlmError || historyTailLlmError?.__meta?.seq !== undefined && msg.__meta?.seq === historyTailLlmError.__meta.seq)) {
        flushActivity()
        emitRow(index, null, false, null, { key: messageKeys[index] })
        return
      }
      const deliveries = communications.get(msg)
      if (deliveries?.[0]?.direction === 'received') {
        if (!showInterAgentMessages) { addActivity(index, msg); return }
        flushActivity()
        emitRow(index, null, false, null, { key: messageKeys[index], communication: deliveries[0] })
        return
      }
      if (msg.role === 'user') {
        const inputKind = getConversationInputKind(msg)
        if (inputKind === 'activity') addActivity(index, msg)
        else {
          flushActivity()
          emitRow(index, null, false, null, { key: messageKeys[index], literalUserText: inputKind === 'user' })
        }
        return
      }
      if (msg.role === 'tool' || getLlmErrorMessageDetails(msg)) {
        addActivity(index, msg)
        if (showInterAgentMessages && deliveries?.length) {
          flushActivity()
          for (const communication of deliveries) emitRow(index, null, false, null, { key: `${messageKeys[index]}-communication-${communication.key}`, communication })
        }
        if (msg.__meta?.retry?.final === true) flushActivity()
        return
      }
      const request = requests.get(msg)
      // A metadata-only completion contributes usage to its prefix's process, not an empty second process.
      if (!msg.parts.length && request && (requestOwners.has(request) || request.messages.some(message => message.parts.some(hasConversationText)))) return
      if (activityStart >= 0) activitySources.add(msg)
      let visiblePartCount = 0
      msg.parts.forEach((part, partIndex) => {
        const textBody = visibleText(msg, part)
        const foldedText = hasConversationText(part) && !textBody
        const image = hasConversationImage(part)
        const technical = foldedText || part.system || part.functionCall || part.functionResponse || part.toolUseId || isReasoningPart(part) || getWebSearchAction(part.providerMeta?.openaiResponses?.outputItem) || !hasConversationText(part) && !image && part.text === undefined && Object.keys(part).length > 0
        if (technical) {
          const fragment = textBody || image ? { ...part, text: foldedText ? part.text : undefined, inlineData: undefined, inlineDataRef: undefined, inlineDataUnavailable: undefined } : part
          // Mixed-field technical fragments keep the original part's presentation ownership.
          if (fragment !== part && reasoningPresentation.has(part)) {
            const info = reasoningPresentation.get(part)!
            reasoningPresentation.set(fragment, info.target === 'text' ? { hidden: info.hidden } : info)
          }
          addActivity(index, { ...msg, parts: [fragment] }, partIndex)
        }
        if (textBody || image) {
          // Include the final request before its reply, even when the final message has no technical parts.
          if (textBody && (activityStart >= 0 || !requestOwners.has(request!) && showUsageBadge && request?.messages.some(message => getModelMessageUsage(message)))) beginActivity(index, partIndex)
          if (textBody) flushActivity(true)
          else flushActivity()
          emitRow(index, null, false, null, {
            key: visiblePartCount++ === 0 ? messageKeys[index] : `${messageKeys[index]}-part-${partIndex}`,
            partIndex, imageOnly: image && !textBody,
          })
        }
      })
      if (!msg.parts.length && activityStart >= 0) activitySources.add(msg)
      if (!visiblePartCount && getModelMessageUsage(msg) && !requestOwners.has(request!)) beginActivity(index)
    })
    flushActivity()
    if (showUsageBadge) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        if (!row.activity) continue
        const owned = [...requestOwners].filter(([, key]) => key === row.key).map(([request]) => request)
        const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
        const attribution: UsageAttribution = { models: [], timestamps: [], apiDurationsMs: [], messageSeqs: [] }
        let callCount = 0
        let pendingRequests = 0
        let missingRequests = 0
        for (const request of owned) {
          const candidates = request.messages.filter(message => !isCompactCompletionMaintenanceMessage(message) && !message.__meta?.synthetic)
          const sample = candidates.findLast(message => getModelMessageUsage(message))
          if (!candidates.length && request.complete) continue
          if (!sample) { if (request.complete) missingRequests++; else pendingRequests++; continue }
          const usage = getModelMessageUsage(sample)!
          total.cachedTokens += usage.cachedTokens
          total.inputTokens += usage.inputTokens
          total.outputTokens += usage.outputTokens
          if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost
          callCount++
          const details = getMessageUsageAttribution(sample, deriveRequestTimings([sample])[0])
          attribution.models.push(...details.models)
          attribution.timestamps.push(...details.timestamps)
          attribution.apiDurationsMs.push(...details.apiDurationsMs)
          attribution.messageSeqs.push(...details.messageSeqs)
        }
        const usage = callCount ? { usage: total, callCount, attribution } : null
        const old = previous?.rows.get(row.key)?.activity
        const activity = old && old.messages === row.activity.messages && old.summary === row.activity.summary
          && old.pendingRequests === pendingRequests && old.missingRequests === missingRequests && sameUsageBadge(old.usage || null, usage) ? old : { ...row.activity, usage, pendingRequests, missingRequests }
        rows[index] = { ...row, activity }
      }
    }
    const liveStart = getConversationLiveRequestStart(input.timing)
    if (nestedDepth === 0 && historyMessages && input.timing?.now !== undefined && liveStart !== undefined && messages.length
      && !rows.at(-1)?.activity?.messages.some(message => !isCompactCompletionMaintenanceMessage(message))) {
      emitRow(messages.length - 1, null, false, null, { key: 'conversation-live-request', activity: { messages: [], summary: 'Activity', runtimeOnly: true } })
      const row = rows.at(-1)!
      const last = historyMessages.findLast(message => isCommittedHistoryMessage(message) && !isCompactCompletionMaintenanceMessage(message))
      const lastBoundary = historyMessages.findLast(message => isCommittedHistoryMessage(message) && !!boundary(message))
      const baseline = last?.__meta?.contextBlock ? last.__meta.contextBlock.rawStartTimestamp : last?.__meta?.timestamp
      const boundaryTime = lastBoundary?.__meta?.timestamp
      const start = typeof boundaryTime === 'number' && Number.isFinite(boundaryTime) && boundaryTime > 0 ? Math.max(liveStart, boundaryTime) : liveStart
      rows[rows.length - 1] = { ...row, anchorKey: undefined, scrollbarAnchorKey: undefined, timeMarker: showTimeDividers ? selectTimelineTimeMarker(start, typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : null) : null }
    }
    const markedRows = showTimeDividers && nestedDepth === 0 ? applyConversationTimeMarkers(rows, messages, historyMessages || messages, boundary, input.timing).map(row => {
      const cached = reuseWhenEqual(previous?.rows.get(row.key), row, sameRowView)
      rowCache.set(row.key, cached)
      return cached
    }) : rows
    return { rows: applyConversationTiming(markedRows, historyMessages || messages, boundary, input.timing), cache: { rows: rowCache, groups: groupCache, reasoningPresentation } }
  }

  // Activity reuses the native technical timeline while retaining delivery bodies absent from tool stdout.
  const foldedCommunications = activityDetails && !showInterAgentMessages
    ? projectSessionCommunications(messages, historyMessages || messages) : null
  const emitDetailedRow = (index: number, group: TimelineGroupView | null, isGroupStart: boolean, foldedOwner: string | null) => {
    const deliveries = foldedCommunications?.get(messages[index])
    if (deliveries?.[0]?.direction !== 'received') emitRow(index, group, isGroupStart, foldedOwner)
    for (const communication of deliveries || []) emitRow(index, null, false, null, {
      key: `${messageKeys[index]}-communication-${communication.key}`, communication,
    })
  }
  let cursor = 0
  while (cursor < messages.length) {
    if (!isToolGroupableMessage(messages[cursor])) {
      emitDetailedRow(cursor, null, false, null)
      foldedThinkingOwnerKey = null
      cursor += 1
      continue
    }

    const scan = scanGroup(messages, cursor, finalStandaloneStartIdx, timeMarkers)
    const derivation = deriveGroup(messages, scan, requestTimings)
    const groupKey = `${messageKeys[scan.start]}-toolgroup`
    const nextGroup: TimelineGroupView = {
      key: groupKey,
      summaryItems: derivation.items,
      usage: derivation.usage,
      callCount: derivation.callCount,
      attribution: derivation.attribution,
      keepExpanded: scan.start === finalStandaloneStartIdx,
    }
    const group = reuseWhenEqual(previous?.groups.get(groupKey), nextGroup, sameGroupView)
    groupCache.set(groupKey, group)

    for (let index = scan.start; index < scan.end; index++) {
      emitDetailedRow(index, group, index === scan.start, index === scan.start ? foldedThinkingOwnerKey : null)
    }

    foldedThinkingOwnerKey = derivation.foldedThinkingIdx !== -1 ? groupKey : null
    cursor = scan.contentBreakIdx !== -1 ? scan.contentBreakIdx : scan.end
  }

  return { rows, cache: { rows: rowCache, groups: groupCache, reasoningPresentation } }
}
