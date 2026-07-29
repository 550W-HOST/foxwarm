import type { Message } from './components/chatShared'

export function getRetryableLlmRetryNotice(messages: Message[], sessionBusy: boolean): Message | null {
  if (sessionBusy) return null

  const lastMessage = messages[messages.length - 1]
  return lastMessage?.__meta?.noticeType === 'llm-retry' ? lastMessage : null
}
