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

export type ContextScrollbarTone = 'user' | 'assistant' | 'tool-neutral' | 'tool-success' | 'tool-error' | 'system' | 'context-block'

export type ContextScrollbarSegment = {
  key: string
  anchorKey: string | null
  startTokens: number
  endTokens: number
  estimatedTokens: number
  tone: ContextScrollbarTone
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

/**
 * Browser-safe approximation of the server's compaction-preview input.  It
 * deliberately uses the shared estimator rather than a second tokenizer and
 * omits reasoning/ephemeral display metadata, matching context compaction's
 * high-level treatment.
 */
export const formatMessageForContextEstimate = (message: Message): string => {
  if (message.modelVisible === false) return ''

  return message.parts.flatMap((part) => {
    const lines: string[] = []
    if (typeof part.system === 'string' && !isLightweightStructuredSystem(part.system)) {
      lines.push(`[system] ${part.system}`)
    }
    if (typeof part.text === 'string' && !part.text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) {
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

export const buildContextScrollbarSegments = (messages: Message[]): ContextScrollbarSegment[] => {
  let cursor = 0
  return messages
    .filter(message => !message.__meta?.temporary && !message.__meta?.synthetic)
    .map((message, index, committed) => {
      const estimatedTokens = estimateTokenCount(formatMessageForContextEstimate(message))
      const startTokens = cursor
      cursor += estimatedTokens
      return {
        key: getMessageStableKey(message, index),
        anchorKey: getPairedAnchorKey(committed, index),
        startTokens,
        endTokens: cursor,
        estimatedTokens,
        tone: getContextScrollbarMessageTone(message),
      }
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
  const estimatedTail = committed.slice(usageIndex + 1).reduce((total, message) => total + estimateTokenCount(formatMessageForContextEstimate(message)), 0)
  const fallback = committed.reduce((total, message) => total + estimateTokenCount(formatMessageForContextEstimate(message)), 0)
  const usedTokens = Math.min(capacityTokens, Math.max(0, (promptTokens ?? 0) + (usageIndex >= 0 ? estimatedTail : fallback)))
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
