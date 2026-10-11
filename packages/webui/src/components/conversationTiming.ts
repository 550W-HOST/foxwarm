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
const measured = (value: any): Span | undefined => {
  const start = timestamp(value?.startedAt)
  const end = timestamp(value?.completedAt)
  return start !== undefined && end !== undefined && end >= start && Number.isFinite(value?.durationMs) && value.durationMs >= 0 ? { start, end } : undefined
}
const MIN_WAITING_GAP_MS = 2000
const measureIntervals = (spans: readonly Span[], start: number, end: number): { busy: number; waiting: number } => {
  const clipped = spans.map(span => ({ start: Math.max(start, span.start), end: Math.min(end, span.end) }))
    .filter(span => span.end > span.start).sort((a, b) => a.start - b.start)
  let busy = 0
  let waiting = 0
  let previousEnd = start
  for (const span of clipped) {
    const gap = span.start - previousEnd
    if (gap >= MIN_WAITING_GAP_MS) waiting += gap
    busy += Math.max(0, span.end - Math.max(span.start, previousEnd))
    previousEnd = Math.max(previousEnd, span.end)
  }
  const tailGap = end - previousEnd
  if (tailGap >= MIN_WAITING_GAP_MS) waiting += tailGap
  return { busy, waiting }
}

/** Read-only timing over visible boundaries; never derives an idle interval from the first hidden record. */
export function applyConversationTiming(
  rows: readonly TimelineRowView[], history: readonly Message[],
  boundary: (message: Message, partIndex?: number) => 'visible' | 'context' | undefined,
  context: ConversationTimingContext = {},
): TimelineRowView[] {
  const result = [...rows]
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
    const timedRowIndex = pending.find(index => result[index].activity!.messages.some(message => !isCompactCompletionMaintenanceMessage(message)))
    if (timedRowIndex === undefined) {
      pending = []
      return
    }
    const { time: start } = left
    const { time: end } = right
    if (start !== undefined && end !== undefined && end > start) {
      // Never import execution evidence through a CTX summary, even for a split logical request.
      let segmentStart = left.index
      while (segmentStart > 0 && boundary(history[segmentStart]) !== 'context') segmentStart--
      let segmentEnd = right.index
      while (segmentEnd < history.length - 1 && boundary(history[segmentEnd]) !== 'context') segmentEnd++
      const segment = history.slice(Math.max(0, segmentStart), segmentEnd + 1).filter(timingEvidence)
      const requests = new Map<string, Span>()
      const spans: Span[] = []
      const responses = new Map()
      for (const message of segment) {
        if (boundary(message) === 'context') continue
        const timing = measured(message.__meta?.llmRequestTiming)
        if (timing) {
          spans.push(timing)
          if (message.__meta?.llmRequestId) requests.set(message.__meta.llmRequestId, timing)
        }
        for (const part of message.parts) {
          const timing = measured(part.functionResponse?.executionTiming)
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
        const request = measured(message.__meta?.llmRequestTiming) || requests.get(message.__meta?.llmRequestId)
        const liveCovers = live && time !== undefined && live.start <= time && live.end >= time
        if (retry && !covers(time)) complete = false
        else if (message.role === 'model' && !retry && !request && !liveCovers) complete = false
        for (const part of message.parts) {
          if (part.functionResponse && !measured(part.functionResponse.executionTiming) && !liveCovers) complete = false
          if (part.functionCall) {
            const response = responses.get(part.functionCall.id)
            // The runner publishes one receipt after the whole batch, including adjacent parallel execs.
            // Runtime identity confirms this pending batch; only already-measured work/short dispatch gaps may precede it.
            const awaitingReceipt = !liveCovers && !response && live && activeBatchConfirmed && message === activeBatch && time !== undefined
              && measureIntervals(spans, time, Math.min(live.start, end)).waiting === 0
            if (!measured(response?.executionTiming) && !liveCovers && !awaitingReceipt) complete = false
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
      const { busy, waiting } = measureIntervals(spans, start, end)
      const labels = complete
        ? [busy > 0 ? `Worked for ${formatCompactDuration(busy)}` : '', waiting > 0 ? `Waited for ${formatCompactDuration(waiting)}` : ''].filter(Boolean)
        : [`Elapsed ${formatCompactDuration(end - start)}`]
      const row = result[timedRowIndex]
      const counts = row.activity!.summary === 'Activity' ? '' : row.activity!.summary
      result[timedRowIndex] = { ...row, activity: { ...row.activity!, summary: [...labels, counts].filter(Boolean).join(' · ') || 'Activity', dynamic } }
    }
    pending = []
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row.activity) {
      pending.push(index)
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
    const completedRequest = last?.role === 'model' && measured(last.__meta?.llmRequestTiming) && last.__meta?.llmSegment?.complete !== false && !last.parts.some(part => part.functionCall)
    const incompleteIdle = context.runtimeState?.state === 'idle' && isSessionTurnIncomplete(history) && !completedRequest
    // No recorded Stop time exists for an idle unfinished turn. Counts are safer than a growing guessed endpoint.
    const end = incompleteIdle ? undefined : context.now
    close({ time: end, index: history.length - 1 }, end !== undefined)
  }
  return result
}
