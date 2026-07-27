import { estimateTokenCount } from '../../../shared/src/tokenCount'
import {
  getMessageViewportAnchorKey,
  getMessageStableKey,
} from '../chatViewportState'
import {
  getSystemMessagePreviewDescriptor,
  getToolResponseStatus,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  type Message,
} from './chatShared'

export type ContextScrollbarTone = 'user' | 'assistant' | 'reasoning' | 'tool-neutral' | 'tool-success' | 'tool-error' | 'system' | 'context-block'
export type ContextScrollbarCategory = 'snapshot' | 'system' | 'tools' | 'user' | 'reasoning' | 'model'
export type ContextScrollbarVerticalScale = 'tokens' | 'tokens-logarithmic' | 'rendered-height'

export const CONTEXT_SCROLLBAR_LEGEND_ORDER: ContextScrollbarCategory[] = ['snapshot', 'system', 'tools', 'user', 'reasoning', 'model']

export type ContextScrollbarSegment = {
  key: string
  anchorKey: string | null
  startTokens: number
  endTokens: number
  estimatedTokens: number
  estimatedRenderedHeight: number
  tone: ContextScrollbarTone
  category: ContextScrollbarCategory
}

export type ContextScrollbarLegendStat = {
  category: ContextScrollbarCategory
  estimatedTokens: number
  percentage: number
}

export type ContextScrollbarContextUsage = {
  usedTokens: number
  freeTokens: number
  capacityTokens: number
  usageAnchorKey: string | null
}

const stringify = (value: unknown): string => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? {})
  } catch {
    return '[unserializable]'
  }
}

const estimateRenderedMessageHeight = (message: Message, pairedResponse?: Message): number => {
  const text = [message, pairedResponse].filter(Boolean).map(candidate => `${candidate!.parts.map(part => part.thinking || '').join('\n')}\n${formatMessageForContextEstimate(candidate!)}`).join('\n')
  const visualLines = text.split('\n').reduce((total, line) => {
    const visualUnits = Array.from(line).reduce((units, character) => units + (/[\u0000-\u00ff]/.test(character) ? 1 : 1.7), 0)
    return total + Math.max(1, Math.ceil(visualUnits / 68))
  }, 0)
  const isThreadCard = message.__meta?.contextBlock || message.role === 'tool' || message.parts.some(part => !!part.functionCall || !!part.functionResponse || !!part.system) || !!pairedResponse
  const imageCount = [message, pairedResponse].filter(Boolean).reduce((count, candidate) => count + candidate!.parts.filter(part => !!part.inlineData || !!part.inlineDataRef).length, 0)
  // Collapsed thread cards preview at most three lines. Ordinary prose keeps
  // its line/wrap estimate (with only a generous safety ceiling).
  const representedLines = isThreadCard ? Math.min(3, visualLines) : Math.min(80, visualLines)
  return Math.max(30, (isThreadCard ? 34 : 28) + representedLines * 20 + imageCount * 96)
}

const getPersistedReasoningTokens = (message: Message): number | null => {
  if (message.role !== 'model') return null
  const usage = message.__meta?.usage as { reasoningTokens?: unknown } | undefined
  const value = usage?.reasoningTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Browser-safe approximation of model-visible context. It deliberately uses
 * the shared estimator rather than a second tokenizer. Reasoning is split by
 * the segment builder, while model-hidden rows remain out of the estimate.
 */
export const formatMessageForContextEstimate = (message: Message): string => {
  if (message.modelVisible === false) return ''

  return message.parts.flatMap((part) => {
    const lines: string[] = []
    if (typeof part.system === 'string') {
      lines.push(`[system] ${part.system}`)
    }
    if (typeof part.text === 'string') {
      lines.push(part.text)
    }
    if (part.functionCall) {
      lines.push(`[call:${part.functionCall.name}] ${stringify(part.functionCall.args)}`)
    }
    if (part.functionResponse) {
      lines.push(`[tool:${part.functionResponse.name || 'unknown'}] ${stringify(part.functionResponse.response)}`)
    }
    if (part.inlineData || part.inlineDataRef) {
      const mimeType = part.inlineData?.mimeType || part.inlineDataRef?.mimeType || 'application/octet-stream'
      lines.push(`[image:${mimeType}]`)
    }
    return lines
  }).filter(Boolean).join('\n')
}

export const getContextScrollbarMessageTone = (message: Message): ContextScrollbarTone => {
  if (message.__meta?.contextBlock) return 'context-block'
  const isHeavySystem = message.role !== 'model' && (
    message.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system || '')) ||
    message.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
  )
  if (isHeavySystem) {
    // Keep the descriptor in this pure classifier so system metadata stays in
    // the same semantic family as the actual timeline card.
    getSystemMessagePreviewDescriptor(message)
    return 'system'
  }
  if (message.role === 'user') return 'user'

  const responses = message.parts.flatMap(part => part.functionResponse ? [part.functionResponse] : [])
  if (responses.some(response => getToolResponseStatus(response) === 'error')) return 'tool-error'
  if (responses.length > 0 || message.parts.some(part => !!part.functionCall)) return responses.length ? 'tool-success' : 'tool-neutral'
  return 'assistant'
}

export const getContextScrollbarMessageCategory = (message: Message): ContextScrollbarCategory => {
  const tone = getContextScrollbarMessageTone(message)
  if (tone === 'system') return 'system'
  if (tone.startsWith('tool-')) return 'tools'
  if (tone === 'user') return 'user'
  return 'model'
}

const getPairedAnchorKey = (messages: Message[], index: number): string | null => {
  const message = messages[index]
  if (message.role === 'tool' && index > 0) {
    const previous = messages[index - 1]
    if (previous.role === 'model' && previous.parts.some(part => !!part.functionCall)) {
      return getMessageViewportAnchorKey(previous)
    }
  }
  return getMessageViewportAnchorKey(message)
}

export const buildContextScrollbarSegments = (messages: Message[], persistentMemorySnapshot?: Message | null): ContextScrollbarSegment[] => {
  let cursor = 0
  const committed = messages.filter(message => !message.__meta?.temporary && !message.__meta?.synthetic)
  const segments: ContextScrollbarSegment[] = []
  const firstCommittedAnchorKey = committed.length > 0 ? getMessageViewportAnchorKey(committed[0]) : null
  if (persistentMemorySnapshot) {
    const estimatedTokens = estimateTokenCount(formatMessageForContextEstimate(persistentMemorySnapshot))
    segments.push({
      key: 'persistent-memory-snapshot',
      anchorKey: firstCommittedAnchorKey,
      startTokens: cursor,
      endTokens: cursor + estimatedTokens,
      estimatedTokens,
      estimatedRenderedHeight: 36,
      tone: 'system',
      category: 'snapshot',
    })
    cursor += estimatedTokens
  }
  for (let index = 0; index < committed.length; index += 1) {
    const message = committed[index]
    const next = committed[index + 1]
    const hasToolCalls = message.role === 'model' && message.parts.some(part => !!part.functionCall)
    const immediateToolResponse = hasToolCalls && next?.role === 'tool' && next.parts.some(part => !!part.functionResponse)
    const responses = immediateToolResponse ? next.parts.flatMap(part => part.functionResponse ? [part.functionResponse] : []) : []
    const key = getMessageStableKey(message, index)
    const anchorKey = getPairedAnchorKey(committed, index)
    const rowStartIndex = segments.length
    const appendSegment = (suffix: string, estimatedTokens: number, tone: ContextScrollbarTone, category: ContextScrollbarCategory) => {
      if (estimatedTokens <= 0) return
      segments.push({ key: `${key}-${suffix}`, anchorKey, startTokens: cursor, endTokens: cursor + estimatedTokens, estimatedTokens, estimatedRenderedHeight: 0, tone, category })
      cursor += estimatedTokens
    }

    if (message.role === 'model') {
      const estimatedReasoningTokens = message.parts.reduce((sum, part) => sum + estimateTokenCount(part.thinking || ''), 0)
      // Persisted provider reasoning usage represents a component of output
      // tokens. It replaces the often-abbreviated visible summary estimate;
      // it must never be added to aggregate context usage separately.
      const reasoningTokens = getPersistedReasoningTokens(message) ?? estimatedReasoningTokens
      appendSegment('reasoning', reasoningTokens, 'reasoning', 'reasoning')
      const contentOnly: Message = {
        ...message,
        parts: message.parts.map(({ thinking: _thinking, functionCall: _functionCall, functionResponse: _functionResponse, ...part }) => part),
      }
      appendSegment('content', estimateTokenCount(formatMessageForContextEstimate(contentOnly)), getContextScrollbarMessageTone(contentOnly), 'model')
      const callOnly: Message = {
        ...message,
        parts: message.parts.filter(part => !!part.functionCall).map(part => ({ functionCall: part.functionCall! })),
      }
      const responseOnly: Message = immediateToolResponse ? {
        ...next,
        parts: next.parts.filter(part => !!part.functionResponse).map(part => ({ functionResponse: part.functionResponse! })),
      } : { role: 'tool', parts: [] }
      const toolTokens = estimateTokenCount(formatMessageForContextEstimate(callOnly)) + estimateTokenCount(formatMessageForContextEstimate(responseOnly))
      if (toolTokens > 0) {
        appendSegment('tools', toolTokens, responses.some(response => getToolResponseStatus(response) === 'error') ? 'tool-error' : responses.length > 0 ? 'tool-success' : 'tool-neutral', 'tools')
      }
    } else {
      appendSegment('message', estimateTokenCount(formatMessageForContextEstimate(message)), getContextScrollbarMessageTone(message), getContextScrollbarMessageCategory(message))
    }
    // A lightweight/display-only committed row can legitimately estimate to
    // zero. Keep an anchor boundary for viewport interpolation, but no visual
    // height or legend weight.
    if (!segments.some(segment => segment.anchorKey === anchorKey)) {
      segments.push({
        key: `${key}-boundary`,
        anchorKey,
        startTokens: cursor,
        endTokens: cursor,
        estimatedTokens: 0,
        estimatedRenderedHeight: 0,
        tone: getContextScrollbarMessageTone(message),
        category: getContextScrollbarMessageCategory(message),
      })
    }
    const rowSegments = segments.slice(rowStartIndex)
    const totalWeight = rowSegments.reduce((sum, segment) => sum + segment.estimatedTokens, 0)
    const renderedHeight = estimateRenderedMessageHeight(message, immediateToolResponse ? next : undefined)
    for (const [rowIndex, segment] of rowSegments.entries()) {
      segment.estimatedRenderedHeight = totalWeight > 0
        ? renderedHeight * segment.estimatedTokens / totalWeight
        : rowIndex === 0 ? renderedHeight : 0
    }
    if (immediateToolResponse) index += 1
  }
  return segments
}

export const buildContextScrollbarScaleSegments = (
  segments: ContextScrollbarSegment[],
  scale: ContextScrollbarVerticalScale,
  measuredAnchorHeights: Readonly<Record<string, number>> = {},
): ContextScrollbarSegment[] => {
  const groupEstimatedHeights = new Map<string, number>()
  for (const segment of segments) {
    if (segment.anchorKey && segment.category !== 'snapshot') groupEstimatedHeights.set(segment.anchorKey, (groupEstimatedHeights.get(segment.anchorKey) || 0) + segment.estimatedRenderedHeight)
  }
  let cursor = 0
  return segments.map(segment => {
    let weight = segment.estimatedTokens
    if (scale === 'tokens-logarithmic') weight = segment.estimatedTokens > 0 ? Math.log1p(segment.estimatedTokens) : 0
    if (scale === 'rendered-height') {
      const measuredHeight = segment.anchorKey ? measuredAnchorHeights[segment.anchorKey] : undefined
      const estimatedGroupHeight = segment.anchorKey ? groupEstimatedHeights.get(segment.anchorKey) || 0 : 0
      weight = segment.category === 'snapshot'
        ? segment.estimatedRenderedHeight
        : measuredHeight !== undefined && estimatedGroupHeight > 0
        ? measuredHeight * segment.estimatedRenderedHeight / estimatedGroupHeight
        : segment.estimatedRenderedHeight
    }
    const next = { ...segment, startTokens: cursor, endTokens: cursor + weight, estimatedTokens: weight }
    cursor += weight
    return next
  })
}

export const getContextScrollbarLegendStats = (segments: ContextScrollbarSegment[]): ContextScrollbarLegendStat[] => {
  const total = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0)
  return CONTEXT_SCROLLBAR_LEGEND_ORDER.map(category => {
    const estimatedTokens = segments.reduce((sum, segment) => sum + (segment.category === category ? segment.estimatedTokens : 0), 0)
    return { category, estimatedTokens, percentage: total > 0 ? estimatedTokens / total * 100 : 0 }
  })
}

const getMeasuredContextTokens = (message: Message): number | null => {
  if (message.role !== 'model') return null
  const usage = message.__meta?.usage as { cachedTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown; cachedContentTokenCount?: unknown; promptTokenCount?: unknown; candidatesTokenCount?: unknown } | undefined
  if (!usage || typeof usage !== 'object') return null
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : null
  const cached = typeof usage.cachedTokens === 'number' ? usage.cachedTokens : typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0
  return input !== null && Number.isFinite(input) && Number.isFinite(cached) && Number.isFinite(output) ? Math.max(0, input + cached + output) : null
}

export const getContextScrollbarContextUsage = (messages: Message[], capacityTokens: number | null | undefined): ContextScrollbarContextUsage | null => {
  if (!capacityTokens || !Number.isFinite(capacityTokens) || capacityTokens <= 0) return null
  const committed = messages.filter(message => !message.__meta?.temporary && !message.__meta?.synthetic)
  let usageIndex = -1
  let promptTokens: number | null = null
  for (let index = committed.length - 1; index >= 0; index -= 1) {
    const next = getMeasuredContextTokens(committed[index])
    if (next !== null) {
      usageIndex = index
      promptTokens = next
      break
    }
  }
  if (usageIndex < 0 || promptTokens === null) return null
  const estimatedTail = committed.slice(usageIndex + 1).reduce((total, message) => total + estimateTokenCount(formatMessageForContextEstimate(message)), 0)
  const usedTokens = Math.min(capacityTokens, Math.max(0, promptTokens + estimatedTail))
  return {
    usedTokens,
    freeTokens: Math.max(0, capacityTokens - usedTokens),
    capacityTokens,
    usageAnchorKey: usageIndex >= 0 ? getMessageStableKey(committed[usageIndex], usageIndex) : null,
  }
}

export const interpolateContextScrollbarBoundary = (segments: ContextScrollbarSegment[], anchorKey: string, fraction: number): number | null => {
  const matching = segments.filter(segment => segment.anchorKey === anchorKey)
  if (matching.length === 0) return null
  const start = matching[0].startTokens
  const end = matching[matching.length - 1].endTokens
  return start + (end - start) * Math.max(0, Math.min(1, fraction))
}

export const findContextScrollbarSegmentAt = (segments: ContextScrollbarSegment[], tokenPosition: number): ContextScrollbarSegment | null => (
  segments.find(segment => tokenPosition < segment.endTokens) || segments[segments.length - 1] || null
)
