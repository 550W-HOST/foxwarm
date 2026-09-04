import type { Message, ModelStreamToolCall, SessionStreamEvent } from './components/chatShared'

export type StreamingAssistantDraft = {
  streamId: string
  iteration?: number
  reasoning: string
  text: string
  toolCalls: Array<ModelStreamToolCall & { displayArgs?: unknown }>
  sequence?: number
  startedAt?: number
  llmRequestId?: string
  incompletePrefix?: boolean
}

export const normalizeStreamingToolCalls = (toolCalls: ModelStreamToolCall[] | undefined): ModelStreamToolCall[] => {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((toolCall, fallbackIndex) => ({
    index: Number.isFinite(toolCall.index) ? toolCall.index : fallbackIndex,
    ...(typeof toolCall.id === 'string' && toolCall.id.trim() ? { id: toolCall.id.trim() } : {}),
    ...(typeof toolCall.name === 'string' && toolCall.name.trim() ? { name: toolCall.name.trim() } : {}),
    ...(typeof toolCall.arguments === 'string' ? {
      arguments: toolCall.arguments,
      displayArgs: parseStreamingToolArguments(toolCall.arguments),
    } : {}),
  }))
}

const applyTextDelta = (current: string, delta: { offset: number; text: string } | undefined) => {
  if (!delta || !Number.isSafeInteger(delta.offset) || delta.offset < 0 || typeof delta.text !== 'string') {
    return { value: current, incomplete: false }
  }
  if (delta.offset > current.length) return { value: delta.text, incomplete: true }
  return { value: `${current.slice(0, delta.offset)}${delta.text}`, incomplete: false }
}

export function applyModelStreamEvent(previous: StreamingAssistantDraft | null, event: SessionStreamEvent): StreamingAssistantDraft {
  const streamId = event.streamId || `stream-${event.iteration ?? 'current'}`
  const sequenceEnd = event.sequence
  const sequenceStart = event.sequenceStart ?? sequenceEnd
  if (event.streamVersion === 2 && previous?.streamId === streamId
    && sequenceEnd !== undefined && previous.sequence !== undefined && sequenceEnd <= previous.sequence) {
    return previous
  }
  if (event.type === 'model-stream-reset') {
    return {
      streamId,
      iteration: event.iteration,
      reasoning: '',
      text: '',
      toolCalls: [],
      sequence: sequenceEnd ?? 0,
      ...(event.streamVersion === 2 && Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}),
      ...(event.streamVersion === 2 && typeof event.llmRequestId === 'string' ? { llmRequestId: event.llmRequestId } : {}),
    }
  }

  if (event.streamVersion !== 2) {
    return {
      streamId,
      iteration: event.iteration ?? previous?.iteration,
      reasoning: event.reasoning ?? (previous?.streamId === streamId ? previous.reasoning : ''),
      text: event.text ?? (previous?.streamId === streamId ? previous.text : ''),
      toolCalls: event.toolCalls !== undefined
        ? normalizeStreamingToolCalls(event.toolCalls)
        : (previous?.streamId === streamId ? previous.toolCalls : []),
    }
  }

  const sameStream = previous?.streamId === streamId
  const base = sameStream ? previous : { streamId, iteration: event.iteration, reasoning: '', text: '', toolCalls: [] }
  const reasoning = applyTextDelta(base.reasoning, event.reasoningDelta)
  const text = applyTextDelta(base.text, event.textDelta)
  const calls = new Map(base.toolCalls.map(call => [call.index, { ...call }]))
  let incomplete = event.streamVersion === 2 && sequenceStart !== undefined
    ? (sameStream && base.sequence !== undefined ? sequenceStart > base.sequence + 1 : sequenceStart > 1)
    : false
  for (const delta of event.toolCallDeltas || []) {
    const call = calls.get(delta.index) || { index: delta.index }
    const args = applyTextDelta(call.arguments || '', delta.argumentsDelta)
    incomplete = incomplete || args.incomplete
    calls.set(delta.index, {
      ...call,
      ...(delta.id ? { id: delta.id } : {}),
      ...(delta.name ? { name: delta.name } : {}),
      ...(delta.argumentsDelta ? { arguments: args.value, displayArgs: parseStreamingToolArguments(args.value) } : {}),
    })
  }
  return {
    streamId,
    iteration: event.iteration ?? base.iteration,
    reasoning: reasoning.value,
    text: text.value,
    toolCalls: [...calls.values()].sort((left, right) => left.index - right.index),
    sequence: sequenceEnd,
    startedAt: event.startedAt ?? base.startedAt,
    llmRequestId: event.llmRequestId ?? base.llmRequestId,
    incompletePrefix: !!base.incompletePrefix || reasoning.incomplete || text.incomplete || incomplete,
  }
}

export function applyModelStreamSnapshot(snapshot: {
  streamId: string
  iteration: number
  sequence: number
  startedAt: number
  llmRequestId: string
  reasoning: string
  text: string
  toolCalls: ModelStreamToolCall[]
} | null): StreamingAssistantDraft | null {
  if (!snapshot) return null
  return {
    streamId: snapshot.streamId,
    iteration: snapshot.iteration,
    sequence: snapshot.sequence,
    startedAt: snapshot.startedAt,
    llmRequestId: snapshot.llmRequestId,
    reasoning: snapshot.reasoning || '',
    text: snapshot.text || '',
    toolCalls: normalizeStreamingToolCalls(snapshot.toolCalls),
  }
}

export function parseStreamingToolArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : raw
  } catch {
    return raw
  }
}

export function shouldClearDraftForCommittedModel(draft: StreamingAssistantDraft | null, messageTimestamp: unknown): boolean {
  if (!draft?.startedAt) return true
  const timestamp = Number(messageTimestamp)
  return !Number.isFinite(timestamp) || timestamp >= draft.startedAt
}

const snapshotHasCanonicalModelCoveringDraft = (messages: Message[], draft: StreamingAssistantDraft): boolean => {
  if (!draft.llmRequestId) return false
  return messages.some(message => {
    if (message.role !== 'model' || message.modelVisible === false || message.__meta?.updateExisting === true) return false
    return message.__meta?.llmRequestId === draft.llmRequestId
  })
}

export function shouldClearDraftAfterHistory(options: {
  draftAtRequestStart: StreamingAssistantDraft | null
  currentDraft: StreamingAssistantDraft | null
  hasNewerStreamEvent: boolean
  snapshotMessages: Message[]
}): boolean {
  const { draftAtRequestStart, currentDraft, hasNewerStreamEvent, snapshotMessages } = options
  if (!currentDraft) return !draftAtRequestStart && !hasNewerStreamEvent
  return snapshotHasCanonicalModelCoveringDraft(snapshotMessages, currentDraft)
}
