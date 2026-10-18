import { API_BASE_PATH } from './config'
import { getChatViewportAnchorSeq, getStoredChatViewportState } from './chatViewportState'
import type { HistoryResponse } from './components/useChatConversationSync'
import type { Message } from './components/chatShared'

export interface PreparedChatArchive {
  messages: Message[]
  firstSeq?: number
  lastSeq?: number
  hasEarlier: boolean
  hasLater: boolean
  anchorSeq?: number
}
const ready = new Map<string, { data: HistoryResponse; archive?: PreparedChatArchive; expires: number }>()
export const CHAT_BOOTSTRAP_TAIL_LENGTH = 100

/** A two-entry, short-lived handoff for explicit navigation, not a historical Session cache. */
export async function prepareChatHistory(sessionId: string, signal: AbortSignal, continuous = false): Promise<boolean> {
  const read = async (url: string) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('History unavailable')
    const text = await response.text()
    if (signal.aborted || text.length > 8 * 1024 * 1024) throw new Error('History handoff unavailable')
    return JSON.parse(text)
  }
  try {
    const base = `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history`
    const anchorSeq = continuous ? getChatViewportAnchorSeq(getStoredChatViewportState(sessionId, 'continuous')) : undefined
    const readArchive = async (): Promise<PreparedChatArchive | undefined> => {
      if (!continuous) return undefined
      if (anchorSeq !== undefined) {
        const [earlier, later] = await Promise.all([read(`${base}/continuous?beforeSeq=${anchorSeq + 1}`), read(`${base}/continuous?afterSeq=${anchorSeq}`)])
        return {messages:[...earlier.messages,...later.messages],firstSeq:earlier.firstSeq ?? later.firstSeq,lastSeq:later.lastSeq ?? earlier.lastSeq,
          hasEarlier:!!earlier.hasMore,hasLater:!!later.hasMore,anchorSeq}
      }
      const page = await read(`${base}/continuous`)
      return {messages:page.messages,firstSeq:page.firstSeq,lastSeq:page.lastSeq,hasEarlier:!!page.hasMore,hasLater:false}
    }
    const [data, archive] = await Promise.all([read(`${base}?tail=${CHAT_BOOTSTRAP_TAIL_LENGTH}`) as Promise<HistoryResponse>, readArchive()])
    if (signal.aborted || !Array.isArray(data.messages) || !data.session || data.session.id !== sessionId && !data.session.aliases?.includes(sessionId)) return false
    if (archive && !Array.isArray(archive.messages)) return false
    ready.delete(sessionId)
    ready.set(sessionId, { data, archive, expires: Date.now() + 30_000 })
    while (ready.size > 2) ready.delete(ready.keys().next().value!)
    return true
  } catch { return false }
}

/** Peek is deliberately non-destructive so React StrictMode may initialize twice. */
export function peekPreparedChatHistory(sessionId: string): HistoryResponse | null {
  const entry = ready.get(sessionId)
  if (!entry) return null
  if (entry.expires < Date.now()) { ready.delete(sessionId); return null }
  return entry.data
}
export function peekPreparedChatArchive(sessionId: string): PreparedChatArchive | undefined {
  return peekPreparedChatHistory(sessionId) ? ready.get(sessionId)?.archive : undefined
}
export function discardPreparedChatHistory(sessionId: string): void { ready.delete(sessionId) }
