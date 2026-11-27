import { parseFoxwarmMetadataLine, type Message, type FunctionCall } from './chatShared'
import { ctlAsUnified } from '../ctlCall'

/** The recipient's role in a Task notification: the owner it hands work or a note to, a previous owner, or the creator it reports to. */
export type TaskRecipientRole = 'owner' | 'previous-owner' | 'creator'

export interface SessionCommunicationTask {
  taskId: string
  event: string
  recipient: TaskRecipientRole
  title?: string
}

export interface SessionCommunication {
  key: string
  direction: 'sent' | 'received'
  /** Empty for a notice from the user, who has no Session. */
  peerSessionId: string
  message: string
  truncated?: boolean
  task?: SessionCommunicationTask
  /** `user`: a Task notice the user sent. `background`: delivered by a background run after its hand-off. */
  origin?: 'user' | 'background'
}

const ROLES = new Set<TaskRecipientRole>(['owner', 'previous-owner', 'creator'])
const ASSIGNMENT_HINT = 'Task assignment from Foxwarm'

/** Envelopes before the `recipient` attribute: the event names the role, except a transfer, whose trusted hint tells the new owner from the previous one. */
function taskRecipient(attrs: Record<string, string>): TaskRecipientRole | null {
  if (ROLES.has(attrs.recipient as TaskRecipientRole)) return attrs.recipient as TaskRecipientRole
  switch (attrs.event) {
    case 'assigned': case 'note': return 'owner'
    case 'completed': return 'creator'
    case 'released': return 'previous-owner'
    case 'transferred': return attrs.sourceKind === 'user' ? null : attrs.hint?.startsWith(ASSIGNMENT_HINT) ? 'owner' : 'previous-owner'
    default: return null
  }
}

/** A Task delivery that hands over work, a note or a result is communication; a notice to a previous owner stays process detail. */
export const isTaskCommunication = (task: SessionCommunicationTask | undefined): boolean =>
  !task || task.recipient !== 'previous-owner' && ['assigned', 'transferred', 'note', 'completed'].includes(task.event)

export function taskEventLabel(task: SessionCommunicationTask): string {
  switch (task.event) {
    case 'assigned': return 'Task assigned'
    case 'transferred': return 'Task reassigned'
    case 'completed': return 'Task completed'
    case 'note': return 'Task note'
    default: return 'Task'
  }
}

/** The generated first line of a Task notification body by event, followed by `<taskId> — <title>`. */
function taskLead(task: SessionCommunicationTask): { lead: string, status: boolean } | null {
  switch (task.event) {
    case 'assigned': case 'transferred': return { lead: 'You have been assigned a task: ', status: true }
    case 'completed': return { lead: 'Task completed: ', status: true }
    case 'note': return { lead: 'Note on task ', status: false }
    default: return null
  }
}

export interface TaskMessageLayout {
  /** The Task title, for the card header. */
  title: string
  /** The body after the generated lead lines, for the collapsed preview; null when nothing follows them. */
  preview: string | null
}

/**
 * Splits the first-party Task notification body into its title and the content after the generated
 * lead (`<lead><taskId> — <title>`, then `Status: …` for assignments and completions). A body in any
 * other form, or naming another Task, has no layout and is shown unchanged.
 */
export function taskMessageLayout(communication: SessionCommunication): TaskMessageLayout | null {
  const task = communication.task
  const shape = task && taskLead(task)
  if (!task || !shape || communication.truncated) return null
  const lines = communication.message.split('\n')
  const prefix = `${shape.lead}${task.taskId} — `
  if (!lines[0].startsWith(prefix)) return null
  const parsed = lines[0].slice(prefix.length).trim()
  if (!parsed || shape.status && !/^Status: \S+$/.test(lines[1] || '')) return null
  const rest = lines.slice(shape.status ? 2 : 1).join('\n').replace(/^\s*\n/, '')
  return { title: communication.direction === 'sent' && task.title?.trim() || parsed, preview: rest.trim() ? rest : null }
}

// The Session tag and Session-opening boundaries share a Session's first input with its envelope.
const OPENING_EVENTS = new Set(['new-child', 'history-inherited', 'user-child-created'])
function isSessionOpeningTag(text: string): boolean {
  const trimmed = text.trim()
  if (/\r|\n/.test(trimmed) || !trimmed.endsWith('/>')) return false
  const tag = parseFoxwarmMetadataLine(trimmed)
  return tag?.tagName === 'foxwarm-system' && !tag.closing
    && (tag.attrs.kind === 'session' || tag.attrs.kind === 'session-boundary' && OPENING_EVENTS.has(tag.attrs.event))
}

/** Reads only the trusted outer envelope: one `foxwarm-message` system part, alone or beside the Session tag and opening boundary. */
export function receivedSessionCommunication(message: Message): SessionCommunication | null {
  if (message.role !== 'user' || !message.parts.length || message.parts.some(part => typeof part.system !== 'string')) return null
  const envelopes = message.parts.filter(part => part.system!.trimStart().startsWith('<foxwarm-message'))
  if (envelopes.length !== 1 || message.parts.some(part => part !== envelopes[0] && !isSessionOpeningTag(part.system!))) return null
  const source = envelopes[0].system!.trimStart()
  const firstEnd = source.search(/\r?\n/)
  if (firstEnd < 0) return null
  const opening = parseFoxwarmMetadataLine(source.slice(0, firstEnd).trim())
  if (opening?.tagName !== 'foxwarm-message' || opening.closing) return null
  const attrs = opening.attrs
  const body = source.slice(firstEnd).replace(/^\r?\n/, '').replace(/\r?\n?<\/foxwarm-message>\s*$/, '')
  const peer = attrs.sourceSessionId?.trim() || ''
  if (attrs.type === 'inter-agent') return peer ? { key: 'received', direction: 'received', peerSessionId: peer, message: body } : null
  if (attrs.type !== 'task' || !attrs.taskId || !attrs.event) return null
  const user = !peer && attrs.sourceKind === 'user'
  if (!peer && !user) return null
  const recipient = taskRecipient(attrs)
  if (!recipient) return null
  const task: SessionCommunicationTask = { taskId: attrs.taskId, event: attrs.event, recipient }
  if (!isTaskCommunication(task)) return null
  return { key: 'received', direction: 'received', peerSessionId: peer, message: body, task, ...(user ? { origin: 'user' as const } : {}) }
}

function sendArguments(original: FunctionCall) {
  if (original.argsParseError) return null
  const call = ctlAsUnified(original)
  if (call.name === 'send_to_session' || call.name === 'functions.send_to_session') return call.args
  if (call.name === 'call_tool' && (call.args?.toolId === 'builtin:send_to_session' || call.args?.source === 'builtin' && call.args.name === 'send_to_session')) return call.args.args
  return null
}

function recordTask(value: unknown): SessionCommunicationTask | undefined | null {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') return null
  const task = value as Record<string, unknown>
  if (typeof task.taskId !== 'string' || typeof task.event !== 'string' || !ROLES.has(task.recipient as TaskRecipientRole)) return null
  return { taskId: task.taskId, event: task.event, recipient: task.recipient as TaskRecipientRole, ...(typeof task.title === 'string' ? { title: task.title } : {}) }
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
    const add = (value: unknown, fallbackKey: string, origin?: 'background') => {
      if (!value || typeof value !== 'object') return
      const item = value as Record<string, unknown>
      if (typeof item.targetSessionId !== 'string' || !item.targetSessionId || item.targetSessionId.length > 512 || typeof item.message !== 'string') return
      const task = recordTask(item.task)
      if (task === null) return
      const key = typeof item.id === 'string' ? item.id : fallbackKey
      if (seen.has(key)) return
      seen.add(key)
      // A notice to a previous owner is kept as evidence but stays in Activity.
      if (!isTaskCommunication(task)) return
      deliveries.push({key,direction:'sent',peerSessionId:item.targetSessionId,message:item.message,...(item.truncated === true ? {truncated:true} : {}),...(task ? {task} : {}),...(origin ? {origin} : {})})
    }
    // A background run's deliveries after its hand-off arrive with its finish event.
    if (message.role === 'user') (message.__meta?.sessionMessages as unknown[] | undefined)?.forEach((item, index) => add(item, `background-${index}`, 'background'))
    for (const part of message.parts) {
      const response = part.functionResponse
      if (!response) continue
      const responseId = response.tool_use_id || `part-${message.parts.indexOf(part)}`
      for (const item of response.__meta?.sessionMessages || []) add(item, responseId)
      for (const subCall of response.__meta?.toolScriptSubCalls || []) {
        // Every committed delivery of the subcall; older rows kept one, valid for a completed subcall.
        if (Array.isArray(subCall.sessionMessages)) subCall.sessionMessages.forEach((item, index) => add(item, `${response.tool_use_id}:${subCall.id}:${index}`))
        else if (subCall.status === 'completed' && subCall.sessionMessage) add(subCall.sessionMessage, `${response.tool_use_id}:${subCall.id}`)
      }
      const call = calls.get(responseId)
      const args = call && sendArguments(call)
      const bounded = deliveries.find(item => item.key === responseId && item.truncated)
      if (bounded && typeof args?.message === 'string') { bounded.message = args.message; delete bounded.truncated }
      if (response.response && !response.response.error && response.response.canceled !== true && args && typeof args.sessionId === 'string' && typeof args.message === 'string' && !seen.has(responseId)) add({targetSessionId:args.sessionId,message:args.message}, responseId)
    }
    if (deliveries.length) projection.set(message, deliveries)
  }
  return projection
}
