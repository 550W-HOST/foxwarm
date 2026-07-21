import type { Message } from './components/chatShared'

export const CHAT_MESSAGE_ANCHOR_ATTRIBUTE = 'data-chat-message-anchor-key'
export const CHAT_MESSAGE_ANCHOR_SELECTOR = `[${CHAT_MESSAGE_ANCHOR_ATTRIBUTE}]`
export const CHAT_VIEWPORT_BOTTOM_THRESHOLD_PX = 200
export const CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX = 4

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
  userIntent?: 'none' | 'leave'
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

  if (options.pendingUserLeave) {
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
  if (hasStableMetaValue(meta.synthetic)) return `synthetic-${String(meta.synthetic)}`
  if (hasStableMetaValue(contextBlockId)) {
    return `ctx-block-${String(meta.contextBlock?.sourceSessionId || 'local')}-${String(contextBlockId)}`
  }
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

export function getStoredChatViewportState(sessionId: string): ChatViewportState | null {
  return viewportStateBySession.get(sessionId) || null
}

export function storeChatViewportState(sessionId: string, state: ChatViewportState): void {
  viewportStateBySession.set(sessionId, state)
}

export function clearStoredChatViewportStatesForTests(): void {
  viewportStateBySession.clear()
}
