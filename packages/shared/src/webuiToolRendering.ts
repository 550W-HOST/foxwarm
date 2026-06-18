export type SessionLinkSegment =
  | { type: 'text'; text: string }
  | { type: 'session-link'; text: string; sessionId: string; kind: 'sessionId' | 'session' | 'child-created' }

const SESSION_LINK_PATTERN = /(sessionId:\s*`([^`]+)`|session\s*`([^`]+)`|Child session created:\s*`([^`]+)`)/g

export function parseSessionLinkText(text: string): SessionLinkSegment[] {
  const segments: SessionLinkSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = SESSION_LINK_PATTERN.exec(text)) !== null) {
    const fullMatch = match[0]
    const sessionId = match[2] || match[3] || match[4]
    const prefix = text.slice(lastIndex, match.index)
    if (prefix) {
      segments.push({ type: 'text', text: prefix })
    }

    if (fullMatch.startsWith('sessionId:')) {
      segments.push({ type: 'session-link', text: 'sessionId: ', sessionId, kind: 'sessionId' })
    } else if (fullMatch.startsWith('Child session created:')) {
      segments.push({ type: 'session-link', text: 'Child session created: ', sessionId, kind: 'child-created' })
    } else {
      segments.push({ type: 'session-link', text: 'session ', sessionId, kind: 'session' })
    }

    lastIndex = match.index + fullMatch.length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }]
}

export function isStreamingAssistantDraftMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return false
  }
  const record = meta as { streaming?: unknown; synthetic?: unknown }
  return record.streaming === true || record.synthetic === 'streamingAssistantDraft'
}

export function shouldUseStreamingToolPlaceholder(options: {
  modelMessageMeta?: unknown
  hasCall?: boolean
  responseCount?: number
  imagePartCount?: number
}): boolean {
  return !!options.hasCall
    && (options.responseCount || 0) === 0
    && (options.imagePartCount || 0) === 0
    && isStreamingAssistantDraftMeta(options.modelMessageMeta)
}
