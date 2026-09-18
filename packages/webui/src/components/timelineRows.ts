import {
  formatToolLabel,
  getToolResponseStatus,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  type Message,
  type ToolTagItem,
} from './chatShared'
import { deriveRequestTimings, type DerivedRequestTiming, type DurationSample } from '../usageTiming'
import { getContextScrollbarAnchorKey, getMessageStableKey, getMessageViewportAnchorKey } from '../chatViewportState'
import { parsePastedTextSegments } from '../pastedText'

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
  cachedTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedContentTokenCount?: number | null
  promptTokenCount?: number | null
  candidatesTokenCount?: number | null
}

export type NormalizedTokenUsage = {
  cachedTokens: number
  inputTokens: number
  outputTokens: number
}

export type UsageAttribution = {
  models: string[]
  timestamps: Array<number | null | 'invalid'>
  apiDurationsMs: DurationSample[]
  betweenRequestsMs: DurationSample[]
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

export interface TimelineRowView {
  readonly key: string
  readonly msg: Message
  readonly prevMsg: Message | null
  readonly nextMsg: Message | null
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
  readonly isMobile: boolean
  readonly groupTools: boolean
  readonly showUsageBadge: boolean
  readonly nestedDepth: number
  readonly expandedGroupKeys: ReadonlySet<string>
}

export interface TimelineRowsCache {
  readonly rows: Map<string, TimelineRowView>
  readonly groups: Map<string, TimelineGroupView>
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

const getMessageUsageAttribution = (msg: Message, timing: DerivedRequestTiming): UsageAttribution => ({
  models: [formatUsageModel(msg)],
  timestamps: [getUsageTimestamp(msg)],
  apiDurationsMs: [timing.apiDurationMs],
  betweenRequestsMs: [timing.betweenRequestsMs],
})

const isToolGroupableMessage = (msg: Message): boolean => msg.role === 'model' || msg.role === 'tool'

const isHeavySystemLikeMessage = (message: Message): boolean => {
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

const hasTextContent = (msg: Message): boolean => msg.parts.some((part) => (
  (part.text && part.text.trim()) || (part.system && String(part.system).trim())
))

const hasToolCalls = (msg: Message): boolean => msg.parts.some((part) => part.functionCall)

const hasToolResponses = (msg: Message): boolean => msg.parts.some((part) => part.functionResponse)

const firstContentPartIndex = (msg: Message): number => msg.parts.findIndex((part) => (
  (part.text && part.text.trim()) || (part.system && String(part.system).trim())
))

/** A tool response that the preceding model call already renders stays in that call's card. */
const isHandledByPreviousGroup = (messages: Message[], index: number): boolean => (
  index > 0 && messages[index - 1].role === 'model' && hasToolCalls(messages[index - 1])
)

const getFinalStandaloneStartIdx = (messages: Message[]): number => {
  const lastIdx = messages.length - 1
  if (lastIdx < 0) return -1

  const lastMsg = messages[lastIdx]
  if (lastMsg.role === 'tool' && hasToolResponses(lastMsg)) {
    if (lastIdx > 0) {
      const prevMsg = messages[lastIdx - 1]
      if (prevMsg.role === 'model' && hasToolCalls(prevMsg)) return lastIdx - 1
    }
    return lastIdx
  }
  if (lastMsg.role === 'model' && hasToolCalls(lastMsg)) return lastIdx
  return -1
}

interface GroupScan {
  readonly start: number
  /** Exclusive end of the group's message range. */
  readonly end: number
  /** Index of the model text that ends this group, or -1 when the group ends any other way. */
  readonly textBreakIdx: number
}

/**
 * Resolves one group's message range. This single walk replaces the previous separate backward
 * start scan and the two forward summary/usage scans, which each repeated the same break rules.
 */
const scanGroup = (messages: Message[], start: number, finalStandaloneStartIdx: number): GroupScan => {
  const startMsg = messages[start]

  // A message that only carries text does not own the tool run that follows it: that run forms its
  // own group with the same messages, so counting them here would render the same summary twice.
  if (startMsg.role === 'model' && !hasToolCalls(startMsg) && firstContentPartIndex(startMsg) !== -1) {
    return { start, end: start + 1, textBreakIdx: -1 }
  }

  let end = start + 1
  for (let index = start + 1; index < messages.length; index++) {
    if (finalStandaloneStartIdx !== -1 && start < finalStandaloneStartIdx && index >= finalStandaloneStartIdx) break
    const msg = messages[index]
    if (!isToolGroupableMessage(msg)) break
    // A model text splits the group that contains it: the text and everything after it belong to
    // the next group, while thinking before the text stays with the group that ends here.
    if (msg.role === 'model' && hasTextContent(msg)) return { start, end: index, textBreakIdx: index }
    end = index + 1
  }
  return { start, end, textBreakIdx: -1 }
}

interface GroupDerivation {
  readonly items: ToolTagItem[]
  readonly usage: NormalizedTokenUsage | null
  readonly callCount: number
  readonly attribution: UsageAttribution
  readonly foldedThinkingIdx: number
}

const deriveGroup = (messages: Message[], scan: GroupScan, requestTimings: DerivedRequestTiming[]): GroupDerivation => {
  const { start, end, textBreakIdx } = scan

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
  const startFirstContentIdx = startMsg.role === 'model' ? firstContentPartIndex(startMsg) : -1
  // Only the parts from the start message's own text on belong to this group's summary.
  const startPartFrom = startFirstContentIdx > 0 ? startFirstContentIdx : 0

  const items: ToolTagItem[] = []
  const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
  const attribution: UsageAttribution = { models: [], timestamps: [], apiDurationsMs: [], betweenRequestsMs: [] }
  let callCount = 0
  let attributedCallCount = 0

  for (let index = start; index < end; index++) {
    const msg = messages[index]
    const parts = index === start ? msg.parts.slice(startPartFrom) : msg.parts
    parts.forEach((part) => {
      // Thinking folds into the summary whenever the group holds tool calls, including messages
      // that also carry text.
      if (part.thinking && part.thinking.trim() && groupHasToolCalls) {
        items.push({ name: 'reasoning', tone: 'neutral' })
      }
      if (part.functionCall) {
        const status = part.functionCall.id ? toolStatusById.get(part.functionCall.id) : undefined
        items.push({
          name: part.functionCall.name,
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
    callCount++
    const messageAttribution = getMessageUsageAttribution(msg, requestTimings[index])
    attribution.models.push(...messageAttribution.models)
    attribution.timestamps.push(...messageAttribution.timestamps)
    attribution.apiDurationsMs.push(...messageAttribution.apiDurationsMs)
    // The first request begins the collapsed group; only later gaps represent tool/orchestration
    // work performed inside that group.
    if (attributedCallCount > 0) attribution.betweenRequestsMs.push(...messageAttribution.betweenRequestsMs)
    attributedCallCount++
  }

  // The message whose text ends this group keeps its own group for everything after the text, but
  // the thinking before the text belongs here: it is counted in this summary and stays folded
  // while this group is collapsed.
  const trailing = textBreakIdx !== -1 ? messages[textBreakIdx] : undefined
  let foldedThinkingIdx = -1
  if (groupHasToolCalls && trailing) {
    const trailingFirstContentIdx = trailing.role === 'model' ? firstContentPartIndex(trailing) : -1
    const foldedThoughts = trailingFirstContentIdx === -1
      ? []
      : trailing.parts.slice(0, trailingFirstContentIdx).filter((part) => part.thinking && part.thinking.trim())
    if (foldedThoughts.length > 0) {
      foldedThinkingIdx = textBreakIdx
      foldedThoughts.forEach(() => items.push({ name: 'reasoning', tone: 'neutral' }))
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
  a === b || (a.apiDurationMs === b.apiDurationMs && a.betweenRequestsMs === b.betweenRequestsMs)
)

const sameTokenUsage = (a: NormalizedTokenUsage | null, b: NormalizedTokenUsage | null): boolean => (
  a === b || (!!a && !!b && a.cachedTokens === b.cachedTokens && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens)
)

const sameTagItems = (a: ToolTagItem[], b: ToolTagItem[]): boolean => (
  a === b || (a.length === b.length && a.every((item, index) => (
    item.name === b[index].name && item.label === b[index].label && item.tone === b[index].tone
  )))
)

const sameSampleList = (a: DurationSample[], b: DurationSample[]): boolean => (
  a === b || (a.length === b.length && a.every((sample, index) => sample === b[index]))
)

const sameStringList = (a: string[], b: string[]): boolean => (
  a === b || (a.length === b.length && a.every((value, index) => value === b[index]))
)

const sameAttribution = (a: UsageAttribution, b: UsageAttribution): boolean => (
  a === b || (
    sameStringList(a.models, b.models)
    && sameSampleList(a.timestamps, b.timestamps)
    && sameSampleList(a.apiDurationsMs, b.apiDurationsMs)
    && sameSampleList(a.betweenRequestsMs, b.betweenRequestsMs)
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
  && a.prevMsg === b.prevMsg
  && a.nextMsg === b.nextMsg
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
  && sameRequestTiming(a.requestTiming, b.requestTiming)
  && sameUsageBadge(a.usageBadge, b.usageBadge)
)

const reuseWhenEqual = <T,>(previous: T | undefined, next: T, isEqual: (a: T, b: T) => boolean): T => (
  previous !== undefined && isEqual(previous, next) ? previous : next
)

export const buildTimelineRows = (input: TimelineRowsInput, previous: TimelineRowsCache | null): TimelineRowsResult => {
  const { messages, isMobile, groupTools, showUsageBadge, nestedDepth, expandedGroupKeys } = input
  const requestTimings = deriveRequestTimings(messages)
  const messageKeys = messages.map((msg, index) => getMessageStableKey(msg, index))
  const finalStandaloneStartIdx = getFinalStandaloneStartIdx(messages)

  const rows: TimelineRowView[] = []
  const rowCache = new Map<string, TimelineRowView>()
  const groupCache = new Map<string, TimelineGroupView>()
  let previousIsThreadLike = false
  let foldedThinkingOwnerKey: string | null = null

  const emitRow = (index: number, group: TimelineGroupView | null, isGroupStart: boolean, foldedOwnerKey: string | null): void => {
    const msg = messages[index]
    const prevMsg = index > 0 ? messages[index - 1] : null
    const nextMsg = index < messages.length - 1 ? messages[index + 1] : null
    const systemLikeMessage = isHeavySystemLikeMessage(msg)
    const threadLikeMessage = systemLikeMessage || msg.role === 'model' || msg.role === 'tool'
    const shouldSkipMargin = threadLikeMessage && previousIsThreadLike
    previousIsThreadLike = threadLikeMessage

    if (msg.role === 'tool' && isHandledByPreviousGroup(messages, index)) {
      // The preceding call's card already renders this response.
      return
    }

    const activeGroup = group !== null && group.summaryItems.length > 0 ? group : null
    const groupExpanded = group !== null && expandedGroupKeys.has(group.key)
    const collapsedGroup = groupTools && activeGroup !== null && !groupExpanded && !activeGroup.keepExpanded
    const requestTiming = requestTimings[index]
    const ownUsage = getModelMessageUsage(msg)
    const usageBadge: TimelineUsageBadgeView | null = !showUsageBadge
      ? null
      : collapsedGroup
        ? (isGroupStart && activeGroup !== null && activeGroup.usage
          ? { usage: activeGroup.usage, ...(activeGroup.callCount > 0 ? { callCount: activeGroup.callCount } : {}), attribution: activeGroup.attribution }
          : null)
        : ownUsage
          ? { usage: ownUsage, attribution: getMessageUsageAttribution(msg, requestTiming) }
          : null

    const key = messageKeys[index]
    const next: TimelineRowView = {
      key,
      msg,
      prevMsg,
      nextMsg,
      requestTiming,
      group,
      collapsedGroup,
      renderSummary: groupTools && isGroupStart && activeGroup !== null && !groupExpanded && !activeGroup.keepExpanded,
      hideFoldedThinking: groupTools && foldedOwnerKey !== null && !expandedGroupKeys.has(foldedOwnerKey),
      // Web-search cards are content of the group, so they are hidden exactly while the group is
      // collapsed into its summary row. Reusing `collapsedGroup` keeps the keep-expanded tail group
      // from hiding its own cards.
      suppressWebSearchCards: collapsedGroup,
      usageBadge,
      usageAnchorRelative: usageBadge !== null && !isMobile,
      systemLikeMessage,
      interleavedToolGroup: !!(nextMsg && nextMsg.role === 'tool' && nextMsg.parts.some((part) => part.functionResponse) && msg.parts.some((part) => part.functionCall)),
      marginClass: nestedDepth > 0 ? 'mt-2' : (shouldSkipMargin ? '' : 'mt-4'),
      widthClass: systemLikeMessage
        ? (isMobile || nestedDepth > 0 ? 'w-full' : 'w-full max-w-[80%]')
        : msg.role === 'user'
          ? (nestedDepth > 0 ? 'max-w-[85%]' : 'max-w-[80%]')
          : isMobile || nestedDepth > 0
            ? 'w-full'
            : 'w-full max-w-[80%]',
      ...(nestedDepth === 0 ? { anchorKey: getMessageViewportAnchorKey(msg) || undefined } : {}),
      ...(nestedDepth === 0 ? { scrollbarAnchorKey: getContextScrollbarAnchorKey(msg) || undefined } : {}),
    }

    const cached = reuseWhenEqual(previous?.rows.get(key), next, sameRowView)
    rowCache.set(key, cached)
    rows.push(cached)
  }

  let cursor = 0
  while (cursor < messages.length) {
    if (!isToolGroupableMessage(messages[cursor])) {
      emitRow(cursor, null, false, null)
      foldedThinkingOwnerKey = null
      cursor += 1
      continue
    }

    const scan = scanGroup(messages, cursor, finalStandaloneStartIdx)
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
      emitRow(index, group, index === scan.start, index === scan.start ? foldedThinkingOwnerKey : null)
    }

    foldedThinkingOwnerKey = derivation.foldedThinkingIdx !== -1 ? groupKey : null
    cursor = scan.textBreakIdx !== -1 ? scan.textBreakIdx : scan.end
  }

  return { rows, cache: { rows: rowCache, groups: groupCache } }
}
