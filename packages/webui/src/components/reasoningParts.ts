import { getLlmErrorMessageDetails, type Message, type MessagePart } from './chatShared'

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

export interface ReasoningBadgeInfo {
  reasoningTokens?: number
}

export interface ReasoningPartPresentation {
  hidden?: boolean
  badges?: ReasoningBadgeInfo[]
  target?: 'text' | 'tool'
}

/** Render-only ownership, keyed by original parts so Conversation fragments share the same plan. */
export type ReasoningPresentation = Map<MessagePart, ReasoningPartPresentation>

export function deriveReasoningPresentation(
  messages: readonly Message[],
  isBoundary: (message: Message) => boolean,
): ReasoningPresentation {
  const presentation: ReasoningPresentation = new Map()
  let pending: Array<{ part: MessagePart; badge: ReasoningBadgeInfo }> = []
  for (const message of messages) {
    if (isBoundary(message)) {
      pending = []
      continue
    }
    if (message.role !== 'model' || getLlmErrorMessageDetails(message)) continue
    const runs = getReasoningRuns(message.parts)
    const runsByStart = new Map(runs.map(run => [run[0].partIndex, run]))
    const tokens = message.__meta?.usage?.reasoningTokens
    for (const [partIndex, part] of message.parts.entries()) {
      const run = runsByStart.get(partIndex)
      if (run && run.every(item => !item.thinking.trim())) {
        pending.push({ part, badge: partIndex === runs[0][0].partIndex
          && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
            ? { reasoningTokens: tokens } : {} })
      }
      // Only actual model prose or a tool invocation can receive the empty card's information.
      if (pending.length && (typeof part.text === 'string' && !!part.text.trim() && !part.system || part.functionCall)) {
        for (const item of pending) presentation.set(item.part, { ...presentation.get(item.part), hidden: true })
        presentation.set(part, { ...presentation.get(part), badges: pending.map(item => item.badge), target: part.text?.trim() && !part.system ? 'text' : 'tool' })
        pending = []
      }
    }
  }
  return presentation
}

export const sameReasoningPresentation = (
  a: readonly (ReasoningPartPresentation | undefined)[],
  b: readonly (ReasoningPartPresentation | undefined)[],
): boolean => a.length === b.length && a.every((item, index) => {
  const other = b[index]
  return item === other || item?.hidden === other?.hidden && item?.target === other?.target
    && (item?.badges?.length ?? 0) === (other?.badges?.length ?? 0)
    && (item?.badges || []).every((badge, badgeIndex) => badge.reasoningTokens === other?.badges?.[badgeIndex].reasoningTokens)
})
