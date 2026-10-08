import type { MessagePart } from './chatShared'

export interface ReasoningRunPart {
  partIndex: number
  thinking: string
}

/** Known reasoning fields identify an item even when its visible summary is empty. */
export const isReasoningPart = (part: MessagePart): boolean => (
  typeof part.thinking === 'string'
  || (Array.isArray(part.providerMeta?.thinkingSummaries)
    && part.providerMeta.thinkingSummaries.every(summary => typeof summary === 'string'))
  || typeof part.providerMeta?.encryptedThinking === 'string'
)

export const getReasoningText = (part: MessagePart): string => (
  typeof part.thinking === 'string' ? part.thinking
    : Array.isArray(part.providerMeta?.thinkingSummaries) && part.providerMeta.thinkingSummaries.every(summary => typeof summary === 'string')
      ? part.providerMeta.thinkingSummaries.join('\n') : ''
)

const hasOtherContent = (part: MessagePart): boolean => (
  typeof part.text === 'string' || typeof part.system === 'string'
  || !!part.functionCall || !!part.functionResponse
  || !!part.inlineData || !!part.inlineDataRef || !!part.inlineDataUnavailable
  || !!part.providerMeta?.openaiResponses?.outputItem
)

/** Runs follow original part adjacency; even an invisible non-reasoning part is a barrier. */
export function getReasoningRuns(parts: MessagePart[]): ReasoningRunPart[][] {
  const runs: ReasoningRunPart[][] = []
  let current: ReasoningRunPart[] | null = null
  parts.forEach((part, partIndex) => {
    if (!isReasoningPart(part)) { current = null; return }
    const mixed = hasOtherContent(part)
    if (!current || mixed) { current = []; runs.push(current) }
    current.push({ partIndex, thinking: getReasoningText(part) })
    if (mixed) current = null
  })
  return runs
}
