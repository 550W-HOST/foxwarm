import { getMessageStableKey } from '../chatViewportState'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { formatCompactDuration } from '../usageTiming'
import { parseFoxwarmMetadataLine, type FunctionCall, type FunctionResponse, type Message } from './chatShared'

type Interval = { startedAt: number; completedAt: number; durationMs: number }
const interval = (value: unknown): Interval | undefined => {
  const timing = value as Partial<Interval> | undefined
  return timing && Number.isFinite(timing.startedAt) && Number.isFinite(timing.completedAt) && Number.isFinite(timing.durationMs)
    && timing.startedAt! >= 0 && timing.completedAt! >= timing.startedAt! && timing.durationMs! >= 0
    ? timing as Interval : undefined
}
const mergeIntervals = (values: readonly Interval[]): Interval[] => {
  const result: Interval[] = []
  for (const value of [...values].sort((a, b) => a.startedAt - b.startedAt)) {
    const previous = result[result.length - 1]
    if (previous && value.startedAt <= previous.completedAt) previous.completedAt = Math.max(previous.completedAt, value.completedAt)
    else result.push({ ...value })
  }
  return result
}
const intervalDuration = (values: readonly Interval[]) => values.reduce((sum, value) => sum + value.completedAt - value.startedAt, 0)
const scriptNames = new Set(['run_script', 'continue_script', 'start_toolscript_run'])
const argsObject = (value: unknown): Record<string, any> | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try { return argsObject(JSON.parse(value)) } catch { return undefined }
  }
  return undefined
}
const target = (call: FunctionCall) => {
  if (call.name !== 'call_tool') return { source: 'builtin', name: call.name, args: argsObject(call.args) }
  const descriptor = argsObject(call.args)
  const builtin = typeof descriptor?.toolId === 'string' ? descriptor.toolId.match(/^builtin:(.+)$/)?.[1] : undefined
  return {
    source: builtin ? 'builtin' : descriptor?.source,
    name: builtin || descriptor?.name,
    args: argsObject(descriptor?.args ?? descriptor?.argsJson),
  }
}
const subCalls = (response: FunctionResponse | undefined) => response?.__meta?.toolScriptSubCalls ?? response?.response?.subCalls

/** One derivation-local ledger: facts belong to their first containing Activity, never each request fragment. */
export function buildConversationActivitySummary(messages: readonly Message[], history: readonly Message[] = messages) {
  const calls = new Map<string, FunctionCall>()
  const responses = new Map<string, FunctionResponse>()
  const countedCalls = new Set<string>()
  const countedCallObjects = new WeakSet<FunctionCall>()
  const countedResponses = new WeakSet<FunctionResponse>()
  const countedOutcomes = new Set<string>()
  const countedRequests = new Set<string>()
  const countedInputs = new Set<string>()
  let workIntervals: Interval[] = []
  for (const message of history) {
    if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview) continue
    for (const part of message.parts) {
      if (part.functionCall?.id) calls.set(part.functionCall.id, part.functionCall)
      if (part.functionResponse?.tool_use_id) responses.set(part.functionResponse.tool_use_id, part.functionResponse)
    }
  }
  const requestKey = (message: Message, timing: Interval) => message.__meta?.llmRequestId
    ? `request:${message.__meta.llmRequestId}` : `request:${timing.startedAt}:${timing.completedAt}:${timing.durationMs}`
  // A clipped viewport must not recount requests/calls already represented by an earlier history record.
  const visibleMessages = new Set(messages)
  const firstHistoryIndex = history.findIndex(message => visibleMessages.has(message))
  for (const message of history.slice(0, Math.max(0, firstHistoryIndex))) {
    const timing = interval(message.__meta?.llmRequestTiming)
    if (timing) { countedRequests.add(requestKey(message, timing)); workIntervals.push(timing) }
    for (const part of message.parts) {
      if (part.functionCall?.id) countedCalls.add(part.functionCall.id)
      const response = part.functionResponse
      const toolTiming = interval(response?.executionTiming)
      if (toolTiming) workIntervals.push(toolTiming)
      if (response?.tool_use_id) countedOutcomes.add(response.tool_use_id)
      const call = response?.tool_use_id ? calls.get(response.tool_use_id) : undefined
      const tool = call ? target(call) : { source: 'builtin', name: response?.name }
      const recordedSubCalls = subCalls(response)
      if (tool.source === 'builtin' && scriptNames.has(tool.name) && Array.isArray(recordedSubCalls)) {
        for (const subCall of recordedSubCalls) {
          if (subCall?.id) countedCalls.add(`script:${response?.response?.runId || response?.tool_use_id}:${subCall.id}`)
        }
      }
    }
  }
  workIntervals = mergeIntervals(workIntervals)

  return (activity: readonly Message[]): string => {
    let called = 0
    let created = 0
    let sent = 0
    let received = 0
    const intervals: Interval[] = []
    const countCall = (call: FunctionCall | undefined, response: FunctionResponse | undefined, containedResponse = false) => {
      const tool = call ? target(call) : { source: 'builtin', name: response?.name }
      const id = call?.id || response?.tool_use_id
      const recordedSubCalls = subCalls(response)
      if (tool.source === 'builtin' && scriptNames.has(tool.name) && Array.isArray(recordedSubCalls) && recordedSubCalls.length) {
        if (!containedResponse) return
        for (const subCall of recordedSubCalls) {
          if (!subCall?.id || !subCall.name || !['running', 'completed', 'failed'].includes(subCall.status)) continue
          const key = `script:${response?.response?.runId || id}:${subCall.id}`
          if (!countedCalls.has(key)) { countedCalls.add(key); called++ }
        }
      } else if (id) {
        if (!countedCalls.has(id)) { countedCalls.add(id); called++ }
      } else if (call && !countedCallObjects.has(call)) {
        countedCallObjects.add(call)
        called++
      }
    }
    for (const message of activity) {
      if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview) continue
      const timing = interval(message.__meta?.llmRequestTiming)
      if (timing && !countedRequests.has(requestKey(message, timing))) {
        countedRequests.add(requestKey(message, timing))
        intervals.push(timing)
      }
      if (message.role === 'user') {
        const communication = message.parts.some(part => {
          const tag = parseFoxwarmMetadataLine(part.system || part.text || '')
          return tag && !tag.closing && (tag.tagName === 'foxwarm-message' && ['inter-agent', 'task', 'mcp'].includes(tag.attrs.type)
            || tag.tagName === 'foxwarm-system' && tag.attrs.kind === 'external-input' && (tag.attrs.server || tag.attrs.endpoint))
        })
        const key = getMessageStableKey(message, history.indexOf(message))
        if (communication && !countedInputs.has(key)) { countedInputs.add(key); received++ }
      }
      for (const part of message.parts) {
        if (part.functionCall) countCall(part.functionCall, part.functionCall.id ? responses.get(part.functionCall.id) : undefined)
        const response = part.functionResponse
        if (!response) continue
        const toolTiming = interval(response.executionTiming)
        if (toolTiming) intervals.push(toolTiming)
        const call = response.tool_use_id ? calls.get(response.tool_use_id) : undefined
        countCall(call, response, true)
        if (countedResponses.has(response) || response.tool_use_id && countedOutcomes.has(response.tool_use_id)) continue
        countedResponses.add(response)
        if (response.tool_use_id) countedOutcomes.add(response.tool_use_id)
        if (response.response?.error !== undefined && response.response?.error !== null) continue
        const tool = call ? target(call) : { source: 'builtin', name: response.name, args: undefined }
        if (tool.source !== 'builtin') continue
        const output = typeof response.response?.output === 'string' ? response.response.output : ''
        if (tool.name === 'create_child_session' && /^Child session created: `[^`]+`/.test(output)) {
          created++
          if (/\. Task assignment sent(?: with warning:|\.)/.test(output)
            || ['wait', 'finish'].includes(tool.args?.afterSend) && /\. Initial message sent\.$/.test(output)) sent++
        }
        if (tool.name === 'send_to_session' && /^Message sent to session `[^`]+`/.test(output)
          || tool.name === 'send_to_channel' && /^Message sent to channel target `[^`]+`/.test(output)) sent++
      }
    }
    const previousWork = intervalDuration(workIntervals)
    workIntervals = mergeIntervals([...workIntervals, ...intervals])
    const worked = intervalDuration(workIntervals) - previousWork
    const facts: string[] = []
    if (worked > 0) facts.push(`Worked for ${formatCompactDuration(worked)}`)
    if (created) facts.push(`Created ${created} child session${created === 1 ? '' : 's'}`)
    if (sent) facts.push(`Sent ${sent} message${sent === 1 ? '' : 's'}`)
    if (received) facts.push(`Received ${received} message${received === 1 ? '' : 's'}`)
    if (called) facts.push(`Called ${called} tool${called === 1 ? '' : 's'}`)
    return facts.join(' · ') || 'Activity'
  }
}
