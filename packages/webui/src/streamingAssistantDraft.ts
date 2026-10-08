import type { Message, ModelStreamPart, ModelStreamToolCall, SessionStreamEvent } from './components/chatShared'

export type StreamingAssistantDraft = {
  streamId: string
  iteration?: number
  reasoning: string
  text: string
  toolCalls: Array<ModelStreamToolCall & { displayArgs?: unknown }>
  parts?: ModelStreamPart[]
  committedThrough?: number
  sequence?: number
  startedAt?: number
  llmRequestId?: string
  incompletePrefix?: boolean
}

export function buildStreamingAssistantMessage(draft: StreamingAssistantDraft | null): Message | null {
  if (!draft) return null

  const parts: Message['parts'] = []
  if (draft.incompletePrefix) {
    parts.push({ system: 'Live stream joined after generation began; earlier content is unavailable.' })
  }
  const toolPart = (toolCall: StreamingAssistantDraft['toolCalls'][number]) => ({
    functionCall: {
      id: toolCall.id || `stream-${draft.streamId}-${toolCall.index}`,
      name: toolCall.name || 'tool call',
      args: toolCall.displayArgs ?? parseStreamingToolArguments(toolCall.arguments),
    },
  })
  if (draft.parts) {
    const ordered: Array<ModelStreamPart | { kind: 'reasoning-group'; summaries: ModelStreamPart[] }> = []
    const reasoningGroups = new Map<number, { kind: 'reasoning-group'; summaries: ModelStreamPart[] }>()
    for (const part of draft.parts) {
      if (part.kind === 'reasoning') {
        let group = reasoningGroups.get(part.outputIndex)
        if (!group) {
          group = { kind: 'reasoning-group', summaries: [] }
          reasoningGroups.set(part.outputIndex, group)
          ordered.push(group)
        }
        group.summaries.push(part)
      } else {
        ordered.push(part)
      }
    }
    for (const part of ordered) {
      if (part.kind === 'reasoning-group') {
        const text = part.summaries.sort((a, b) => (a.summaryIndex ?? 0) - (b.summaryIndex ?? 0))
          .map(summary => summary.text).filter(Boolean).join('\n')
        parts.push({ thinking: text })
      } else if (part.kind === 'text' && part.text) {
        parts.push({ text: part.text, ...(part.phase ? { phase: part.phase } : {}) })
      } else if (part.kind === 'tool-call') {
        const call = draft.toolCalls.find(call => call.index === part.outputIndex)
        if (call) parts.push(toolPart(call))
      } else if (part.kind === 'image-generation') {
        parts.push({ system: part.status === 'completed' ? 'Image ready' : 'Generating image…' })
      }
    }
  } else {
    if (draft.reasoning.trim()) parts.push({ thinking: draft.reasoning })
    if (draft.text) parts.push({ text: draft.text })
    for (const toolCall of draft.toolCalls) parts.push(toolPart(toolCall))
  }

  if (parts.length === 0) return null
  return {
    role: 'model',
    parts,
    __meta: {
      synthetic: 'streamingAssistantDraft',
      temporary: true,
      streaming: true,
      streamId: draft.streamId,
      iteration: draft.iteration,
      ...(draft.llmRequestId ? { llmRequestId: draft.llmRequestId } : {}),
      ...(draft.committedThrough ? { llmSegment: {
        outputStart: draft.committedThrough, outputEndExclusive: draft.committedThrough, complete: false,
      } } : {}),
      timestamp: Number.MAX_SAFE_INTEGER,
    },
  }
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
  const orderedParts = event.partDeltas
    ? [...(base.parts || [])]
    : event.trimBeforeOutputIndex !== undefined ? [...(base.parts || [])] : base.parts
  if (orderedParts && event.partDeltas) {
    for (const delta of event.partDeltas) {
      const index = orderedParts.findIndex(part => part.outputIndex === delta.outputIndex && part.kind === delta.kind
        && part.contentIndex === delta.contentIndex && part.summaryIndex === delta.summaryIndex)
      const previousPart = index >= 0 ? orderedParts[index] : undefined
      const nextText = applyTextDelta(previousPart?.text || '', delta.textDelta)
      incomplete = incomplete || nextText.incomplete
      const next: ModelStreamPart = {
        ...(previousPart || { outputIndex: delta.outputIndex, kind: delta.kind }),
        ...(delta.contentIndex !== undefined ? { contentIndex: delta.contentIndex } : {}),
        ...(delta.summaryIndex !== undefined ? { summaryIndex: delta.summaryIndex } : {}),
        ...(delta.textDelta ? { text: nextText.value } : {}),
        ...(delta.phase ? { phase: delta.phase } : {}),
        ...(delta.status ? { status: delta.status } : {}),
      }
      if (index < 0) {
        if (next.outputIndex >= (base.committedThrough || 0)) orderedParts.push(next)
      } else orderedParts[index] = next
    }
    orderedParts.sort((left, right) => left.outputIndex - right.outputIndex
      || (left.contentIndex ?? left.summaryIndex ?? 0) - (right.contentIndex ?? right.summaryIndex ?? 0))
  }
  const committedThrough = Math.max(base.committedThrough || 0, event.trimBeforeOutputIndex || 0)
  const remainingParts = event.trimBeforeOutputIndex !== undefined
    ? orderedParts?.filter(part => part.outputIndex >= committedThrough) : orderedParts
  return {
    streamId,
    iteration: event.iteration ?? base.iteration,
    reasoning: reasoning.value,
    text: text.value,
    toolCalls: [...calls.values()].filter(call => call.index >= committedThrough).sort((left, right) => left.index - right.index),
    ...(remainingParts ? { parts: remainingParts } : {}),
    ...(committedThrough ? { committedThrough } : {}),
    sequence: sequenceEnd,
    startedAt: event.startedAt ?? base.startedAt,
    llmRequestId: event.llmRequestId ?? base.llmRequestId,
    incompletePrefix: !!base.incompletePrefix || incomplete || (!remainingParts && (reasoning.incomplete || text.incomplete)),
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
  parts?: ModelStreamPart[]
  committedThrough?: number
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
    ...(snapshot.parts ? { parts: snapshot.parts } : {}),
    ...(snapshot.committedThrough ? { committedThrough: snapshot.committedThrough } : {}),
  }
}

/** Reconcile a committed Responses range without discarding the still-live draft suffix. */
export function reconcileCommittedModelDraft(draft: StreamingAssistantDraft | null, message: Message): StreamingAssistantDraft | null {
  if (!draft || message.role !== 'model') return draft
  const segment = message.__meta?.llmSegment
  if (!segment || message.__meta?.llmRequestId !== draft.llmRequestId) {
    return shouldClearDraftForCommittedModel(draft, message.__meta?.timestamp) && !segment ? null : draft
  }
  if (segment.complete) return null
  const committedThrough = Math.max(draft.committedThrough || 0, segment.outputEndExclusive)
  if (!draft.parts) return { ...draft, committedThrough }
  const parts = draft.parts.filter(part => part.outputIndex >= committedThrough)
  const summaries = new Map<number, string[]>()
  for (const part of parts) {
    if (part.kind !== 'reasoning' || !part.text) continue
    const values = summaries.get(part.outputIndex) || []
    values[part.summaryIndex || 0] = part.text
    summaries.set(part.outputIndex, values)
  }
  return {
    ...draft, committedThrough, parts,
    reasoning: [...summaries.entries()].sort(([a], [b]) => a - b)
      .map(([, values]) => values.filter(Boolean).join('\n')).filter(Boolean).join('\n'),
    text: parts.filter(part => part.kind === 'text').map(part => part.text || '').join(''),
    toolCalls: draft.toolCalls.filter(call => call.index >= committedThrough),
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
    return message.__meta?.llmRequestId === draft.llmRequestId && (!message.__meta?.llmSegment || message.__meta.llmSegment.complete)
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
