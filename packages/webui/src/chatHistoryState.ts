import type { Message, MessagePart } from './components/chatShared'

export function getClientMessageId(message: Message): string | null {
  const value = message.__meta?.clientMessageId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function hasStableHistoryIdentity(message: Message): boolean {
  return getClientMessageId(message) !== null
    || message.__meta?.seq !== undefined
    || message.__meta?.id !== undefined
}

function findStableMessageIndex(messages: Message[], incoming: Message): number {
  const clientMessageId = getClientMessageId(incoming)
  if (clientMessageId) {
    const index = messages.findIndex(message => getClientMessageId(message) === clientMessageId)
    if (index !== -1) return index
  }

  const seq = incoming.__meta?.seq
  if (seq !== undefined) {
    const index = messages.findIndex(message => message.__meta?.seq === seq)
    if (index !== -1) return index
  }

  const id = incoming.__meta?.id
  if (id !== undefined) {
    return messages.findIndex(message => message.__meta?.id === id)
  }

  return -1
}

export function reconcileHistoryMessage(messages: Message[], incoming: Message): Message[] {
  const stableIndex = findStableMessageIndex(messages, incoming)
  if (stableIndex !== -1) {
    const next = [...messages]
    next[stableIndex] = incoming
    return next
  }

  if (!hasStableHistoryIdentity(incoming)) {
    const timestamp = incoming.__meta?.timestamp
    if (timestamp !== undefined && messages.some(message => message.__meta?.timestamp === timestamp)) {
      return messages
    }
  }

  return [...messages, incoming]
}

export function mergeHistorySnapshot(options: {
  snapshot: Message[]
  concurrentMessages: Message[]
  currentMessages: Message[]
  pendingClientMessageIds: ReadonlySet<string>
}): Message[] {
  let merged = [...options.snapshot]

  for (const message of options.concurrentMessages) {
    merged = reconcileHistoryMessage(merged, message)
  }

  for (const message of options.currentMessages) {
    const clientMessageId = getClientMessageId(message)
    if (!message.__meta?.optimistic || !clientMessageId || !options.pendingClientMessageIds.has(clientMessageId)) {
      continue
    }
    merged = reconcileHistoryMessage(merged, message)
  }

  return merged
}

export function buildOptimisticUserMessage(options: {
  clientMessageId: string
  parts: MessagePart[]
  timestamp: number
}): Message {
  return {
    role: 'user',
    parts: options.parts,
    __meta: {
      clientMessageId: options.clientMessageId,
      optimistic: true,
      temporary: true,
      timestamp: options.timestamp,
    },
  }
}