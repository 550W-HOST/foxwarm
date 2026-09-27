export type SessionLinkSegment =
  | { type: 'text'; text: string }
  | { type: 'session-link'; text: string; sessionId: string; kind: 'sessionId' | 'session' | 'child-created' | 'inter-agent-source' }

type SessionLinkMatch = {
  start: number
  end: number
  text: string
  sessionId: string
  kind: Exclude<SessionLinkSegment, { type: 'text' }>['kind']
}

const LEGACY_SESSION_LINK_PATTERN = /(sessionId:\s*`([^`]+)`|session\s*`([^`]+)`|Child session created:\s*`([^`]+)`)/g
const INTER_AGENT_OPENING_TAG_PATTERN = /<foxwarm-message\b([^>]*)>/gi
const XML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g

const getLegacySessionLinkMatches = (text: string): SessionLinkMatch[] => {
  const matches: SessionLinkMatch[] = []
  let match: RegExpExecArray | null
  LEGACY_SESSION_LINK_PATTERN.lastIndex = 0

  while ((match = LEGACY_SESSION_LINK_PATTERN.exec(text)) !== null) {
    const fullMatch = match[0]
    const sessionId = match[2] || match[3] || match[4]
    const kind = fullMatch.startsWith('sessionId:')
      ? 'sessionId'
      : fullMatch.startsWith('Child session created:')
        ? 'child-created'
        : 'session'
    const prefix = kind === 'sessionId'
      ? 'sessionId: '
      : kind === 'child-created'
        ? 'Child session created: '
        : 'session '
    matches.push({ start: match.index, end: match.index + fullMatch.length, text: prefix, sessionId, kind })
  }

  return matches
}

const getInterAgentSourceLinkMatches = (text: string): SessionLinkMatch[] => {
  const matches: SessionLinkMatch[] = []
  let tagMatch: RegExpExecArray | null
  INTER_AGENT_OPENING_TAG_PATTERN.lastIndex = 0

  while ((tagMatch = INTER_AGENT_OPENING_TAG_PATTERN.exec(text)) !== null) {
    const attributesText = tagMatch[1] || ''
    const attributesOffset = tagMatch[0].length - attributesText.length - 1
    let type: string | null = null
    let source: { value: string; start: number } | null = null
    let attributeMatch: RegExpExecArray | null
    XML_ATTRIBUTE_PATTERN.lastIndex = 0

    while ((attributeMatch = XML_ATTRIBUTE_PATTERN.exec(attributesText)) !== null) {
      const name = attributeMatch[1]
      const value = attributeMatch[2]
      if (name === 'type') type = value
      if (name === 'sourceSessionId' && value) {
        const valueOffset = attributeMatch[0].indexOf('"') + 1
        source = { value, start: tagMatch.index + attributesOffset + attributeMatch.index + valueOffset }
      }
    }

    if (type === 'inter-agent' && source) {
      matches.push({
        start: tagMatch.index,
        end: source.start + source.value.length,
        text: text.slice(tagMatch.index, source.start),
        sessionId: source.value,
        kind: 'inter-agent-source',
      })
    }
  }

  return matches
}

export function parseSessionLinkText(text: string): SessionLinkSegment[] {
  const segments: SessionLinkSegment[] = []
  let lastIndex = 0
  const matches = [...getLegacySessionLinkMatches(text), ...getInterAgentSourceLinkMatches(text)]
    .sort((left, right) => left.start - right.start)

  for (const match of matches) {
    if (match.start < lastIndex) continue
    const prefix = text.slice(lastIndex, match.start)
    if (prefix) {
      segments.push({ type: 'text', text: prefix })
    }
    segments.push({ type: 'session-link', text: match.text, sessionId: match.sessionId, kind: match.kind })
    lastIndex = match.end
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
