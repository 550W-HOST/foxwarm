import { getMessageStableKey } from '../chatViewportState'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { getWebSearchAction } from '../webSearchAction'
import { parseFoxwarmMetadataLine, type FunctionCall, type FunctionResponse, type Message } from './chatShared'

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

/** One derivation-local ledger: facts belong to their first containing Activity, never each repeated call/result fragment. */
export function buildConversationActivitySummary(messages: readonly Message[], history: readonly Message[] = messages) {
  const calls = new Map<string, FunctionCall>()
  const countedCalls = new Set<string>()
  const countedCallObjects = new WeakSet<FunctionCall>()
  const countedResponses = new WeakSet<FunctionResponse>()
  const countedOutcomes = new Set<string>()
  const countedInputs = new Set<string>()
  const countedHosted = new Set<string>()
  const countedHostedObjects = new WeakSet<object>()
  const numberFact = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
  const hosted = (part: Message['parts'][number]) => {
    const item = part.providerMeta?.openaiResponses?.outputItem
    return getWebSearchAction(item) ? item as Record<string, any> : undefined
  }
  for (const message of history) {
    if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview) continue
    for (const part of message.parts) {
      if (part.functionCall?.id) calls.set(part.functionCall.id, part.functionCall)
    }
  }
  // A clipped viewport must not recount calls already represented by an earlier history record.
  const visibleMessages = new Set(messages)
  const firstHistoryIndex = history.findIndex(message => visibleMessages.has(message))
  for (const message of history.slice(0, Math.max(0, firstHistoryIndex))) {
    if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview) continue
    for (const part of message.parts) {
      if (part.functionCall?.id) countedCalls.add(part.functionCall.id)
      const item = hosted(part)
      if (item?.id) countedHosted.add(item.id)
      else if (item) countedHostedObjects.add(item)
      const response = part.functionResponse
      if (response?.tool_use_id) countedOutcomes.add(response.tool_use_id)
    }
  }

  return (activity: readonly Message[]): string => {
    let called = 0
    let created = 0
    let sent = 0
    let received = 0
    const countCall = (call: FunctionCall | undefined, response: FunctionResponse | undefined) => {
      const id = call?.id || response?.tool_use_id
      if (id) {
        if (!countedCalls.has(id)) { countedCalls.add(id); called++ }
      } else if (call && !countedCallObjects.has(call)) {
        countedCallObjects.add(call)
        called++
      }
    }
    for (const message of activity) {
      if (!isCommittedHistoryMessage(message) || message.__meta?.queuedPreview) continue
      if (message.role === 'user') {
        const communication = message.parts.some(part => {
          const tag = parseFoxwarmMetadataLine(part.system || part.text || '')
          return tag && !tag.closing && (tag.tagName === 'foxwarm-message' && ['inter-agent', 'task', 'mcp'].includes(tag.attrs.type)
            || tag.tagName === 'foxwarm-system' && tag.attrs.kind === 'external-input'
              && (tag.attrs.server || tag.attrs.endpoint || tag.attrs.externalId && tag.attrs.contextId))
        })
        const key = getMessageStableKey(message, history.indexOf(message))
        if (communication && !countedInputs.has(key)) { countedInputs.add(key); received++ }
      }
      for (const part of message.parts) {
        const item = hosted(part)
        if (item && (item.id ? !countedHosted.has(item.id) : !countedHostedObjects.has(item))) {
          if (item.id) countedHosted.add(item.id)
          else countedHostedObjects.add(item)
          called++
        }
        if (part.functionCall) countCall(part.functionCall, undefined)
        const response = part.functionResponse
        if (!response) continue
        const call = response.tool_use_id ? calls.get(response.tool_use_id) : undefined
        countCall(call, response)
        if (countedResponses.has(response) || response.tool_use_id && countedOutcomes.has(response.tool_use_id)) continue
        countedResponses.add(response)
        if (response.tool_use_id) countedOutcomes.add(response.tool_use_id)
        if (response.response?.error !== undefined && response.response?.error !== null) continue
        const tool = call ? target(call) : { source: 'builtin', name: response.name, args: undefined }
        if (tool.source !== 'builtin') continue
        const output = typeof response.response?.output === 'string' ? response.response.output : ''
        // Persisted historical Task receipts keep this fact in a JSON output envelope.
        const sentNotifications = response.response?.sentNotifications
          ?? (tool.name === 'task' ? argsObject(output)?.sentNotifications : undefined)
        if (tool.name === 'task') sent += numberFact(sentNotifications)
        if (tool.name === 'create_child_session' && /^Child session created: `[^`]+`/.test(output)) {
          created++
          if (typeof sentNotifications === 'number') sent += numberFact(sentNotifications)
          else if (/\. Task assignment sent(?: with warning:|\.)/.test(output)
            || ['wait', 'finish'].includes(tool.args?.afterSend) && /\. Initial message sent\.$/.test(output)) sent++
        }
        if (tool.name === 'send_to_session' && /^Message sent to session `[^`]+`/.test(output)
          || tool.name === 'send_to_channel' && /^Message sent to channel target `[^`]+`/.test(output)) sent++
      }
    }
    const facts: string[] = []
    if (called) facts.push(`${called} call${called === 1 ? '' : 's'}`)
    if (created) facts.push(`${created} child session${created === 1 ? '' : 's'}`)
    if (sent) facts.push(`${sent} sent`)
    if (received) facts.push(`${received} received`)
    return facts.join(' · ') || 'Activity'
  }
}
