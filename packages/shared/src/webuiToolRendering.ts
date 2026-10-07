export type SessionLinkSegment =
  | { type: 'text'; text: string }
  | { type: 'session-link'; text: string; sessionId: string; kind: 'sessionId' | 'session' | 'child-created' | 'inter-agent-source' | 'session-field' }

type SessionLinkMatch = {
  start: number
  end: number
  text: string
  sessionId: string
  kind: Exclude<SessionLinkSegment, { type: 'text' }>['kind']
}

const LEGACY_SESSION_LINK_PATTERN = /(sessionId:\s*`([^`]+)`|session\s*`([^`]+)`|Child session created:\s*`([^`]+)`)/g
const SESSION_REFERENCE_FIELDS = [
  'sessionId',
  'sourceSessionId',
  'targetSessionId',
  'parentSessionId',
  'currentSessionId',
  'childSessionId',
  'replyTargetSessionId',
  'managedSessionId',
  'createdBySessionId',
  'ownerSessionId',
  'previousOwnerSessionId',
  'attachedSessionId',
] as const
const SESSION_REFERENCE_FIELD_PATTERN = SESSION_REFERENCE_FIELDS.join('|')
const SESSION_FIELD_PATTERN = new RegExp(
  `(?<![\\w.:-])["']?(${SESSION_REFERENCE_FIELD_PATTERN})["']?\\s*[:=]\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|\x60([^\x60\\r\\n]*)\x60|([^\\s,;<>}\\]"'\x60]+))`,
  'g',
)
const SESSION_ALIAS_VALUES = new Set(['<main>', '<parent>'])

const isLinkableSessionId = (value: string): boolean => {
  const normalized = value.trim()
  return normalized.length > 0
    && !SESSION_ALIAS_VALUES.has(normalized)
}

const getLegacySessionLinkMatches = (text: string): SessionLinkMatch[] => {
  const matches: SessionLinkMatch[] = []
  let match: RegExpExecArray | null
  LEGACY_SESSION_LINK_PATTERN.lastIndex = 0

  while ((match = LEGACY_SESSION_LINK_PATTERN.exec(text)) !== null) {
    const fullMatch = match[0]
    const sessionId = match[2] || match[3] || match[4]
    if (!isLinkableSessionId(sessionId)) continue
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

const getSessionFieldLinkMatches = (text: string): SessionLinkMatch[] => {
  const matches: SessionLinkMatch[] = []
  let match: RegExpExecArray | null
  SESSION_FIELD_PATTERN.lastIndex = 0

  while ((match = SESSION_FIELD_PATTERN.exec(text)) !== null) {
    const fieldName = match[1]
    const sessionId = match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
    if (!isLinkableSessionId(sessionId)) continue
    if (match[5] !== undefined && ['null', 'undefined', 'true', 'false'].includes(sessionId)) continue
    const valueStart = match.index + match[0].length - sessionId.length - (match[5] === undefined ? 1 : 0)
    matches.push({
      start: match.index,
      end: valueStart + sessionId.length,
      text: text.slice(match.index, valueStart),
      sessionId,
      kind: fieldName === 'sourceSessionId' ? 'inter-agent-source' : 'session-field',
    })
  }

  return matches
}

export function parseSessionLinkText(text: string): SessionLinkSegment[] {
  const segments: SessionLinkSegment[] = []
  let lastIndex = 0
  const matches = [...getLegacySessionLinkMatches(text), ...getSessionFieldLinkMatches(text)]
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
