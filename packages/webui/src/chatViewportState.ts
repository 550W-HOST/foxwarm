import type { HistoryMode } from './continuousHistory'
import type { Message } from './components/chatShared'

export const CHAT_MESSAGE_ANCHOR_ATTRIBUTE = 'data-chat-message-anchor-key'
export const CHAT_MESSAGE_ANCHOR_SELECTOR = `[${CHAT_MESSAGE_ANCHOR_ATTRIBUTE}]`
export const CONTEXT_SCROLLBAR_ANCHOR_ATTRIBUTE = 'data-context-scrollbar-anchor-key'
export const CONTEXT_SCROLLBAR_ANCHOR_SELECTOR = `[${CONTEXT_SCROLLBAR_ANCHOR_ATTRIBUTE}]`
export const PERSISTENT_MEMORY_SNAPSHOT_CONTEXT_SCROLLBAR_ANCHOR_KEY = 'persistent-memory-snapshot'
export const CHAT_VIEWPORT_BOTTOM_THRESHOLD_PX = 200
export const CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX = 4
// Leaves room for the row's time separator above an opening message.
const OPENING_MESSAGE_OFFSET_PX = 48

export type ChatViewportState =
  | { kind: 'bottom' }
  | { kind: 'anchor'; messageKey: string; offsetPx: number }

export interface ChatViewportAnchorMeasurement {
  messageKey: string
  top: number
  bottom: number
}

export interface ChatBottomFollowState {
  following: boolean
  pendingUserLeave: boolean
}

export function updateChatBottomFollow(options: ChatBottomFollowState & {
  distanceFromBottom: number
  userIntent?: 'none' | 'leave' | 'toward-bottom'
  rejoinThresholdPx?: number
}): ChatBottomFollowState {
  const threshold = options.rejoinThresholdPx ?? CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX
  const distanceFromBottom = Math.max(0, options.distanceFromBottom)

  if (options.userIntent === 'leave') {
    return {
      following: false,
      pendingUserLeave: distanceFromBottom <= threshold,
    }
  }

  if (options.pendingUserLeave && options.userIntent !== 'toward-bottom') {
    return distanceFromBottom > threshold
      ? { following: false, pendingUserLeave: false }
      : { following: false, pendingUserLeave: true }
  }

  if (!options.following && distanceFromBottom <= threshold) {
    return { following: true, pendingUserLeave: false }
  }

  return { following: options.following, pendingUserLeave: false }
}

const viewportStateBySession = new Map<string, ChatViewportState>()

const hasStableMetaValue = (value: unknown): boolean => (
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'number' && Number.isFinite(value))
)

export function getMessageStableKey(message: Message, fallbackIndex: number): string {
  const meta = message.__meta || {}
  const contextBlockId = meta.contextBlock?.id
  if (hasStableMetaValue(contextBlockId)) {
    return `ctx-block-${String(meta.contextBlock?.sourceSessionId || 'local')}-${String(contextBlockId)}`
  }
  // A live model draft and its one canonical provider message share this ID,
  // so the final commit can reuse the mounted timeline row.
  if (message.role === 'model' && hasStableMetaValue(meta.llmRequestId)) {
    const start = meta.llmSegment?.outputStart
    return typeof start === 'number' && Number.isSafeInteger(start) && start > 0
      ? `llm-request-${String(meta.llmRequestId)}-output-${String(start)}`
      : `llm-request-${String(meta.llmRequestId)}`
  }
  if (hasStableMetaValue(meta.synthetic)) return `synthetic-${String(meta.synthetic)}`
  if (hasStableMetaValue(meta.clientMessageId)) return `client-${String(meta.clientMessageId)}`
  if (hasStableMetaValue(meta.seq)) {
    return `seq-${String(meta.contextArchiveItem?.sourceSessionId || 'local')}-${String(meta.seq)}`
  }
  if (hasStableMetaValue(meta.id)) return `id-${String(meta.id)}`
  if (hasStableMetaValue(meta.timestamp)) return `ts-${String(meta.timestamp)}`
  return `idx-${fallbackIndex}`
}

export function getMessageViewportAnchorKey(message: Message): string | null {
  const meta = message.__meta || {}
  const contextBlockId = meta.contextBlock?.id
  if (meta.temporary || hasStableMetaValue(meta.synthetic)) return null
  if (hasStableMetaValue(contextBlockId)) {
    return `ctx-block-${String(meta.contextBlock?.sourceSessionId || 'local')}-${String(contextBlockId)}`
  }
  if (hasStableMetaValue(meta.seq)) {
    return `seq-${String(meta.contextArchiveItem?.sourceSessionId || 'local')}-${String(meta.seq)}`
  }
  if (hasStableMetaValue(meta.id)) return `id-${String(meta.id)}`
  if (hasStableMetaValue(meta.timestamp)) return `ts-${String(meta.timestamp)}`
  return null
}

/**
 * First view of a Session without a saved position. A Session whose timeline is only
 * one assistant message, such as the first-run welcome, opens at the start of that
 * message instead of its end; any other Session follows the latest message.
 */
export function getOpeningChatViewportState(timeline: readonly Message[]): ChatViewportState | null {
  if (timeline.length !== 1 || timeline[0].role !== 'model') return null
  const messageKey = getMessageViewportAnchorKey(timeline[0])
  return messageKey ? { kind: 'anchor', messageKey, offsetPx: OPENING_MESSAGE_OFFSET_PX } : null
}

export function getContextScrollbarAnchorKey(message: Message): string | null {
  if (message.__meta?.synthetic === 'persistentMemorySnapshot') return PERSISTENT_MEMORY_SNAPSHOT_CONTEXT_SCROLLBAR_ANCHOR_KEY
  return getMessageViewportAnchorKey(message)
}

export function chooseChatViewportState(options: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  viewportTop: number
  viewportBottom: number
  anchors: ChatViewportAnchorMeasurement[]
  bottomThresholdPx?: number
}): ChatViewportState | null {
  const distanceFromBottom = options.scrollHeight - options.scrollTop - options.clientHeight
  if (distanceFromBottom <= (options.bottomThresholdPx ?? CHAT_VIEWPORT_BOTTOM_THRESHOLD_PX)) {
    return { kind: 'bottom' }
  }

  const anchor = options.anchors.find((candidate) => (
    candidate.bottom > options.viewportTop && candidate.top < options.viewportBottom
  ))
  if (!anchor) return null

  return {
    kind: 'anchor',
    messageKey: anchor.messageKey,
    offsetPx: anchor.top - options.viewportTop,
  }
}

export function getChatViewportAnchorAdjustment(currentOffsetPx: number, savedOffsetPx: number): number {
  return currentOffsetPx - savedOffsetPx
}

/** Continuous history anchors carry their canonical Archive sequence in the row key. */
export function getChatViewportAnchorSeq(state: ChatViewportState | null): number | undefined {
  const match = state?.kind === 'anchor' ? /^seq-.+-(\d+)$/.exec(state.messageKey) : null
  const seq = match ? Number(match[1]) : 0
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined
}

export function getStoredChatViewportState(sessionId: string, historyMode: HistoryMode = 'active'): ChatViewportState | null {
  return viewportStateBySession.get(`${sessionId}\0${historyMode}`) || null
}

export function storeChatViewportState(sessionId: string, state: ChatViewportState, historyMode: HistoryMode = 'active'): void {
  viewportStateBySession.set(`${sessionId}\0${historyMode}`, state)
}

export function clearStoredChatViewportStatesForTests(): void {
  viewportStateBySession.clear()
}

/** Opens a Session positioned at one of its messages. */
export function openSessionAtSeq(sessionId: string, seq: number | undefined, open: (sessionId: string) => void) {
  if (seq !== undefined && Number.isSafeInteger(seq) && seq > 0) {
    const anchor = { kind: 'anchor' as const, messageKey: `seq-local-${seq}`, offsetPx: 48 }
    storeChatViewportState(sessionId, anchor, 'continuous')
    storeChatViewportState(sessionId, anchor, 'active')
  }
  open(sessionId)
}
