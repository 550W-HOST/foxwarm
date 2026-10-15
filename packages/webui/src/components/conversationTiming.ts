import type { Message } from './chatShared'
import { getLlmErrorMessageDetails, parseFoxwarmMetadataLine } from './chatShared'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { isCompactCompletionMaintenanceMessage, isSessionTurnIncomplete } from '../sessionContinuation'
import type { SessionRuntimeState } from '../sessionRuntimeState'
import { formatCompactDuration } from '../usageTiming'
import type { TimelineRowView } from './timelineRows'

type Span = { start: number; end: number }
export type ConversationTimingContext = { runtimeState?: SessionRuntimeState; busyStartedAt?: number | null; now?: number }
const timestamp = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
export const readConversationWorkInterval = (value: any): Span | undefined => {
  const start = timestamp(value?.startedAt)
  const end = timestamp(value?.completedAt)
  return start !== undefined && end !== undefined && end >= start && Number.isFinite(value?.durationMs) && value.durationMs >= 0 ? { start, end } : undefined
}
const MIN_WAITING_GAP_MS = 2000
const measureIntervals = (spans: readonly Span[], start: number, end: number, waitingStart = start): { busy: number; waiting: number } => {
  const clipped = spans.map(span => ({ start: Math.max(start, span.start), end: Math.min(end, span.end) }))
    .filter(span => span.end > span.start).sort((a, b) => a.start - b.start)
  let busy = 0
  let waiting = 0
  let previousEnd = start
  for (const span of clipped) {
    const gap = span.start - Math.max(previousEnd, waitingStart)
    if (gap >= MIN_WAITING_GAP_MS) waiting += gap
    busy += Math.max(0, span.end - Math.max(span.start, previousEnd))
    previousEnd = Math.max(previousEnd, span.end)
  }
  const tailGap = end - Math.max(previousEnd, waitingStart)
  if (tailGap >= MIN_WAITING_GAP_MS) waiting += tailGap
  return { busy, waiting }
}

/** A trustworthy start for a boundary-free Activity, never a Session/maintenance creation timestamp. */
export function getConversationActivityStart(messages: readonly Message[], history: readonly Message[] = messages, liveStart?: number): number | undefined {
  const requests = new Map<string, Span>()
  for (const message of history) {
    if (message.__meta?.contextBlock) break
    if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview || message.__meta?.synthetic || isCompactCompletionMaintenanceMessage(message)) continue
    const span = readConversationWorkInterval(message.__meta?.llmRequestTiming)
    if (span && message.__meta?.llmRequestId) requests.set(message.__meta.llmRequestId, span)
  }
  let inputStart: number | undefined
  for (const message of messages) {
    if (message.__meta?.contextBlock) break
    if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview || message.__meta?.synthetic || isCompactCompletionMaintenanceMessage(message)) continue
    if (message.role === 'user') {
      const input = message.parts.some(part => {
        const tag = parseFoxwarmMetadataLine(part.system || part.text || '')
        return tag && !tag.closing && (tag.tagName === 'foxwarm-message' && tag.attrs.type
          || tag.tagName === 'foxwarm-system' && (tag.attrs.kind === 'external-input' || tag.attrs.kind === 'event' && tag.attrs.type))
      })
      if (input && inputStart === undefined) {
        inputStart = timestamp(message.__meta?.timestamp)
        if (inputStart === undefined) return undefined
      }
    } else if (message.role === 'model' || message.role === 'tool') {
      if ((message.__meta?.llmSegment?.outputStart ?? 0) > 0) return inputStart
      const spans = [
        readConversationWorkInterval(message.__meta?.llmRequestTiming) || requests.get(message.__meta?.llmRequestId),
        ...message.parts.map(part => readConversationWorkInterval(part.functionResponse?.executionTiming)),
      ].filter((span): span is Span => !!span)
      if (spans.length) return Math.min(inputStart ?? Infinity, ...spans.map(span => span.start))
      if (message.parts.length || message.__meta?.llmRequestId) {
        if (inputStart !== undefined) return inputStart
        return liveStart !== undefined && (timestamp(message.__meta?.timestamp) ?? -Infinity) >= liveStart ? liveStart : undefined
      }
    }
  }
  return inputStart ?? liveStart
}

/** Current requesting-model work is real even before a first provider output part exists. */
export function getConversationLiveRequestStart(context: ConversationTimingContext = {}): number | undefined {
  const runtime = context.runtimeState
  return runtime?.busy && runtime.state === 'requesting-model'
    ? timestamp(context.busyStartedAt) ?? timestamp(runtime.since) : undefined
}

/** Read-only timing over visible boundaries; preserves visible boundaries and only infers a leading origin from real input/work evidence. */
export function applyConversationTiming(
  rows: readonly TimelineRowView[], history: readonly Message[],
  boundary: (message: Message, partIndex?: number) => 'visible' | 'context' | undefined,
  context: ConversationTimingContext = {},
): TimelineRowView[] {
  const result = [...rows]
  const liveRequestStart = getConversationLiveRequestStart(context)
  const indices = new Map(history.map((message, index) => [message, index]))
  const committed = (message: Message) => isCommittedHistoryMessage(message) && !message.__meta?.queuedPreview
  const timingEvidence = (message: Message) => committed(message) && !isCompactCompletionMaintenanceMessage(message)
  const sourceIndex = (message: Message) => indices.get(message) ?? (message.__meta ? history.findIndex(item => item.__meta === message.__meta) : -1)
  const firstIndex = rows.flatMap(row => [sourceIndex(row.msg), ...(row.activity?.messages.map(sourceIndex) || [])]).find(index => index >= 0) ?? 0
  let left: { time?: number; index: number } = { index: -1 }
  // The viewport does not own the left boundary. Preserve the preceding visible history boundary.
  for (let index = 0; index < firstIndex; index++) {
    if (committed(history[index]) && boundary(history[index])) left = { time: timestamp(history[index].__meta?.timestamp), index }
  }
  let pending: number[] = []
  const close = (right: { time?: number; index: number }, dynamic = false) => {
    if (!pending.length) return
    const timedRowIndex = pending.find(index => result[index].activity!.runtimeOnly || [...result[index].activity!.messages, ...result[index].activity!.sources || []].some(message => !isCompactCompletionMaintenanceMessage(message)))
    if (timedRowIndex === undefined) {
      pending = []
      return
    }
    const { time: end } = right
    // Never import execution evidence through a CTX summary, even for a split logical request.
    let segmentStart = left.index
    while (segmentStart > 0 && boundary(history[segmentStart]) !== 'context') segmentStart--
    let segmentEnd = right.index
    while (segmentEnd < history.length - 1 && boundary(history[segmentEnd]) !== 'context') segmentEnd++
    const segment = history.slice(Math.max(0, segmentStart), segmentEnd + 1).filter(timingEvidence)
    const leading = history.slice(0, right.index + 1).filter(message => boundary(message) !== 'visible' || message.role === 'model')
    const start = left.index < 0 ? getConversationActivityStart(leading, segment, liveRequestStart) : left.time
    if (start !== undefined && end !== undefined && (end > start || dynamic && liveRequestStart !== undefined && end === start)) {
      const requests = new Map<string, Span>()
      const spans: Span[] = []
      const responses = new Map()
      for (const message of segment) {
        if (boundary(message) === 'context') continue
        const timing = readConversationWorkInterval(message.__meta?.llmRequestTiming)
        if (timing) {
          spans.push(timing)
          if (message.__meta?.llmRequestId) requests.set(message.__meta.llmRequestId, timing)
        }
        for (const part of message.parts) {
          const timing = readConversationWorkInterval(part.functionResponse?.executionTiming)
          if (timing) spans.push(timing)
          if (part.functionResponse?.tool_use_id) responses.set(part.functionResponse.tool_use_id, part.functionResponse)
        }
      }
      const runtime = context.runtimeState
      const activeStart = timestamp(context.busyStartedAt) ?? timestamp(runtime?.since)
      const live = runtime?.busy && (runtime.state === 'requesting-model' || runtime.state === 'running-tool') && activeStart !== undefined && context.now !== undefined
        ? { start: activeStart, end: context.now } : undefined
      if (live) spans.push(live)
      const activeBatch = live && runtime?.state === 'running-tool' && runtime.tool?.id
        ? segment.filter(message => message.role === 'model' && message.parts.some(part => part.functionCall)).slice(-1)[0] : undefined
      const activeBatchConfirmed = activeBatch?.parts.some(part => part.functionCall?.id === runtime?.tool?.id)
      const covers = (time: number | undefined) => time !== undefined && spans.some(span => span.start <= time && span.end >= time)
      let complete = true
      const range = history.slice(Math.max(0, left.index), right.index + 1).filter(timingEvidence)
      for (const message of range) {
        if (boundary(message) === 'context') { if (message !== history[left.index]) complete = false; continue }
        const time = timestamp(message.__meta?.timestamp)
        const retry = getLlmErrorMessageDetails(message)
        if (retry && message === history[left.index]) continue
        const request = readConversationWorkInterval(message.__meta?.llmRequestTiming) || requests.get(message.__meta?.llmRequestId)
        const liveCovers = live && time !== undefined && live.start <= time && live.end >= time
        if (retry && !covers(time)) complete = false
        else if (message.role === 'model' && !retry && !request && !liveCovers) complete = false
        for (const part of message.parts) {
          if (part.functionResponse && !readConversationWorkInterval(part.functionResponse.executionTiming) && !liveCovers) complete = false
          if (part.functionCall) {
            const response = responses.get(part.functionCall.id)
            // The runner publishes one receipt after the whole batch, including adjacent parallel execs.
            // Runtime identity confirms this pending batch; only already-measured work/short dispatch gaps may precede it.
            const awaitingReceipt = !liveCovers && !response && live && activeBatchConfirmed && message === activeBatch && time !== undefined
              && measureIntervals(spans, time, Math.min(live.start, end)).waiting === 0
            if (!readConversationWorkInterval(response?.executionTiming) && !liveCovers && !awaitingReceipt) complete = false
          }
        }
      }
      // Multiple incoming inputs need evidence of processing before the next one, or continuous busy coverage.
      const inputs = range.filter(message => message.role === 'user' && boundary(message) !== 'visible' && !message.parts.some(part => {
        const tag = parseFoxwarmMetadataLine(part.system || part.text || '')
        return tag?.tagName === 'foxwarm-system' && ['time', 'goal-reminder', 'session-boundary'].includes(tag.attrs.kind)
      }))
      for (let index = 0; index < inputs.length; index++) {
        const time = timestamp(inputs[index].__meta?.timestamp)
        const nextTime = timestamp(inputs[index + 1]?.__meta?.timestamp) ?? end
        if (time === undefined || !covers(time) && !spans.some(span => span.start >= time && span.start < nextTime)) complete = false
      }
      const row = result[timedRowIndex]
      // A displayed divider bounds waiting only; work and evidence retain the full visible range.
      const waitingStart = Math.max(start, row.timeMarker?.timestamp ?? start)
      const { busy, waiting } = measureIntervals(spans, start, end, waitingStart)
      const labels = complete
        ? [busy > 0 || dynamic && liveRequestStart !== undefined ? `Worked ${formatCompactDuration(busy)}` : '', waiting > 0 ? `Waited ${formatCompactDuration(waiting)}` : ''].filter(Boolean)
        : [`Elapsed ${formatCompactDuration(end - start)}`]
      const counts = row.activity!.summary === 'Activity' ? '' : row.activity!.summary
      result[timedRowIndex] = { ...row, activity: { ...row.activity!, summary: [...labels, counts].filter(Boolean).join(' · ') || 'Activity', dynamic } }
    }
    pending = []
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row.activity) {
      pending.push(index)
      if (row.activity.closedAt) {
        const right = { time: timestamp(row.activity.closedAt.__meta?.timestamp), index: sourceIndex(row.activity.closedAt) }
        close(right)
        left = right
        continue
      }
      const error = row.activity.messages.find(message => getLlmErrorMessageDetails(message) && message.__meta?.retry?.final === true)
      if (error) {
        const right = { time: timestamp(error.__meta?.timestamp), index: sourceIndex(error) >= 0 ? sourceIndex(error) : sourceIndex(row.msg) }
        close(right)
        left = right
      }
      continue
    }
    const messageIndex = sourceIndex(row.msg)
    if (messageIndex < 0 || !committed(row.msg)) continue // Streaming text is not a permanent clock boundary.
    const kind = boundary(row.msg, row.conversationPartIndex)
    const terminalError = getLlmErrorMessageDetails(row.msg) && row.msg.__meta?.retry?.final === true
    if (kind || terminalError) {
      const right = { time: timestamp(row.msg.__meta?.timestamp), index: messageIndex }
      close(right)
      left = right
    }
  }
  if (pending.length) {
    const last = history.filter(timingEvidence).slice(-1)[0]
    const completedRequest = last?.role === 'model' && readConversationWorkInterval(last.__meta?.llmRequestTiming) && last.__meta?.llmSegment?.complete !== false && !last.parts.some(part => part.functionCall)
    const incompleteIdle = context.runtimeState?.state === 'idle' && isSessionTurnIncomplete(history) && !completedRequest
    // No recorded Stop time exists for an idle unfinished turn. Counts are safer than a growing guessed endpoint.
    const runtime = context.runtimeState
    const liveEndpoint = runtime?.state === 'waiting' || runtime?.busy && (runtime.state === 'requesting-model' || runtime.state === 'running-tool')
    const end = incompleteIdle ? undefined : liveEndpoint ? context.now : completedRequest ? timestamp(last.__meta?.timestamp) : undefined
    close({ time: end, index: history.length - 1 }, !!liveEndpoint && end !== undefined)
  }
  return result
}
