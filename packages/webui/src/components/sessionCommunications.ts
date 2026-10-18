import { parseFoxwarmMetadataLine, type Message, type FunctionCall } from './chatShared'

export interface SessionCommunication {
  key: string
  direction: 'sent' | 'received'
  peerSessionId: string
  message: string
  truncated?: boolean
}

export function receivedSessionCommunication(message: Message): SessionCommunication | null {
  if (message.role !== 'user' || !message.parts.some(part => typeof part.system === 'string')) return null
  const source = message.parts.map(part => part.system ?? part.text ?? '').join('\n').trimStart()
  const firstEnd = source.search(/\r?\n/)
  if (firstEnd < 0) return null
  const opening = parseFoxwarmMetadataLine(source.slice(0, firstEnd).trim())
  if (opening?.tagName !== 'foxwarm-message' || opening.attrs.type !== 'inter-agent' || !opening.attrs.sourceSessionId?.trim()) return null
  const body = source.slice(firstEnd).replace(/^\r?\n/, '').replace(/\r?\n?<\/foxwarm-message>\s*$/, '')
  return { key: 'received', direction: 'received', peerSessionId: opening.attrs.sourceSessionId.trim(), message: body }
}

function sendArguments(call: FunctionCall) {
  if (call.argsParseError) return null
  if (call.name === 'send_to_session' || call.name === 'functions.send_to_session') return call.args
  if (call.name === 'call_tool' && (call.args?.toolId === 'builtin:send_to_session' || call.args?.source === 'builtin' && call.args.name === 'send_to_session')) return call.args.args
  return null
}

/** Only paired successful calls or persisted first-party delivery metadata; never parse tool prose/stdout. */
export function projectSessionCommunications(messages: readonly Message[], history: readonly Message[] = messages): Map<Message, SessionCommunication[]> {
  const calls = new Map<string, FunctionCall>()
  for (const message of [...history, ...messages]) for (const part of message.parts) if (part.functionCall?.id) calls.set(part.functionCall.id, part.functionCall)
  const projection = new Map<Message, SessionCommunication[]>()
  for (const message of messages) {
    const received = receivedSessionCommunication(message)
    if (received) { projection.set(message, [received]); continue }
    if (message.role === 'model') continue
    const deliveries: SessionCommunication[] = [], seen = new Set<string>()
    const add = (value: unknown, fallbackKey: string) => {
      if (!value || typeof value !== 'object') return
      const item = value as Record<string, unknown>
      if (typeof item.targetSessionId !== 'string' || !item.targetSessionId || item.targetSessionId.length > 512 || typeof item.message !== 'string') return
      const key = typeof item.id === 'string' ? item.id : fallbackKey
      if (seen.has(key)) return
      seen.add(key)
      deliveries.push({key,direction:'sent',peerSessionId:item.targetSessionId,message:item.message,...(item.truncated === true ? {truncated:true} : {})})
    }
    for (const part of message.parts) {
      const response = part.functionResponse
      if (!response) continue
      const responseId = response.tool_use_id || `part-${message.parts.indexOf(part)}`
      for (const item of response.__meta?.sessionMessages || []) add(item, responseId)
      for (const subCall of response.__meta?.toolScriptSubCalls || []) if (subCall.status === 'completed' && subCall.sessionMessage) add(subCall.sessionMessage, `${response.tool_use_id}:${subCall.id}`)
      const call = calls.get(responseId)
      const args = call && sendArguments(call)
      const bounded = deliveries.find(item => item.key === responseId && item.truncated)
      if (bounded && typeof args?.message === 'string') { bounded.message = args.message; delete bounded.truncated }
      if (response.response && !response.response.error && response.response.canceled !== true && args && typeof args.sessionId === 'string' && typeof args.message === 'string' && !deliveries.some(item => item.key === responseId)) add({targetSessionId:args.sessionId,message:args.message}, responseId)
    }
    if (deliveries.length) projection.set(message, deliveries)
  }
  return projection
}
