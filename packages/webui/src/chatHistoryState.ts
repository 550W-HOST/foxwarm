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

function findMessageIndex(messages: Message[], incoming: Message): number {
  const stableIndex = findStableMessageIndex(messages, incoming)
  if (stableIndex !== -1) return stableIndex
  if (hasStableHistoryIdentity(incoming)) return -1
  const timestamp = incoming.__meta?.timestamp
  if (timestamp === undefined) return -1
  return messages.findIndex(message => (
    !hasStableHistoryIdentity(message)
    && message.__meta?.timestamp === timestamp
  ))
}

export function isRetainedBrowserLocalMessage(message: Message): boolean {
  return message.__meta?.temporary === true && message.__meta?.isCommandResponse === true
}

function hasSameBrowserLocalIdentity(messages: Message[], incoming: Message): boolean {
  if (!isRetainedBrowserLocalMessage(incoming)) return false
  return messages.some(message => (
    isRetainedBrowserLocalMessage(message)
    && message.__meta?.timestamp === incoming.__meta?.timestamp
    && message.parts.map(part => part.text || '').join('') === incoming.parts.map(part => part.text || '').join('')
  ))
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

  const retainedMessages = options.currentMessages.filter(message => {
    const clientMessageId = getClientMessageId(message)
    const retainedPendingOptimistic = message.__meta?.optimistic
      && clientMessageId
      && options.pendingClientMessageIds.has(clientMessageId)
    if (!retainedPendingOptimistic && !isRetainedBrowserLocalMessage(message)) return false
    if (retainedPendingOptimistic) return findMessageIndex(merged, message) === -1
    return !hasSameBrowserLocalIdentity(options.concurrentMessages, message)
  })

  const beforeGroups = new Map<number, Message[]>()
  const afterGroups = new Map<number, Message[]>()
  const trailing: Message[] = []
  for (const message of retainedMessages) {
    const currentIndex = options.currentMessages.indexOf(message)
    let nextAnchor = -1
    for (let index = currentIndex + 1; index < options.currentMessages.length; index += 1) {
      nextAnchor = findMessageIndex(merged, options.currentMessages[index])
      if (nextAnchor !== -1) break
    }
    if (nextAnchor !== -1) {
      beforeGroups.set(nextAnchor, [...(beforeGroups.get(nextAnchor) || []), message])
      continue
    }

    let previousAnchor = -1
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      previousAnchor = findMessageIndex(merged, options.currentMessages[index])
      if (previousAnchor !== -1) break
    }
    if (previousAnchor !== -1) {
      afterGroups.set(previousAnchor, [...(afterGroups.get(previousAnchor) || []), message])
    } else {
      trailing.push(message)
    }
  }

  return merged.flatMap((message, index) => [
    ...(beforeGroups.get(index) || []),
    message,
    ...(afterGroups.get(index) || []),
  ]).concat(trailing)
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