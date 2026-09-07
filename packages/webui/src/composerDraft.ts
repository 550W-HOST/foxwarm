import { PASTED_TEXT_CLOSE, PASTED_TEXT_OPEN } from './pastedText'

export type ComposerTextSegment = { type: 'text'; text: string }
export type ComposerPastedTextSegment = { type: 'pasted-text'; id: string; text: string }
export type ComposerDraftSegment = ComposerTextSegment | ComposerPastedTextSegment
export type ComposerDraft = { version: 1; segments: ComposerDraftSegment[] }

const DRAFT_VERSION = 1
const STRUCTURED_DRAFT_PREFIX = 'composer_draft_v1_'
const LEGACY_DRAFT_PREFIX = 'draft_'

export function normalizeComposerDraftSegments(segments: readonly ComposerDraftSegment[]): ComposerDraftSegment[] {
  const normalized: ComposerDraftSegment[] = []
  for (const segment of segments) {
    if (segment.type === 'text') {
      const previous = normalized[normalized.length - 1]
      if (previous?.type === 'text') previous.text += segment.text
      else normalized.push({ type: 'text', text: segment.text })
      continue
    }
    normalized.push({ type: 'pasted-text', id: segment.id, text: segment.text })
  }
  return normalized.length > 0 ? normalized : [{ type: 'text', text: '' }]
}

export function makePlainComposerDraft(text = ''): ComposerDraft {
  return { version: DRAFT_VERSION, segments: [{ type: 'text', text }] }
}

export function makeComposerDraft(segments: readonly ComposerDraftSegment[]): ComposerDraft {
  return { version: DRAFT_VERSION, segments: normalizeComposerDraftSegments(segments) }
}

export function serializeComposerDraft(draft: ComposerDraft): string {
  return draft.segments.map(segment => segment.type === 'text'
    ? segment.text
    : `${PASTED_TEXT_OPEN}${segment.text}${PASTED_TEXT_CLOSE}`
  ).join('')
}

export function getPlainComposerDraftText(draft: ComposerDraft): string | null {
  return draft.segments.length === 1 && draft.segments[0].type === 'text'
    ? draft.segments[0].text
    : null
}

export function appendTextToComposerDraft(draft: ComposerDraft, text: string): ComposerDraft {
  const trimmed = text.trim()
  if (!trimmed) return draft
  const segments = draft.segments.map(segment => ({ ...segment }))
  const previousText = serializeComposerDraft(draft).trim().length > 0
  const suffix = previousText ? `\n\n${trimmed}` : trimmed
  const last = segments[segments.length - 1]
  if (last?.type === 'text') last.text = `${last.text.replace(/\s+$/u, '')}${suffix}`
  else segments.push({ type: 'text', text: suffix })
  return makeComposerDraft(segments)
}

export function canConvertPasteToBlock(text: string): boolean {
  if (text.includes(PASTED_TEXT_CLOSE)) return false
  const characterCount = Array.from(text).length
  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length
  return characterCount >= 2000 || lineCount >= 20
}

function isStructuredDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<ComposerDraft>
  if (candidate.version !== DRAFT_VERSION || !Array.isArray(candidate.segments)) return false
  return candidate.segments.every(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const item = segment as Partial<ComposerDraftSegment>
    if (item.type === 'text') return typeof item.text === 'string'
    return item.type === 'pasted-text'
      && typeof item.id === 'string'
      && item.id.length > 0
      && item.id.length <= 160
      && typeof item.text === 'string'
  })
}

export function loadComposerDraft(sessionId: string): ComposerDraft {
  const structuredKey = `${STRUCTURED_DRAFT_PREFIX}${sessionId}`
  const rawStructured = localStorage.getItem(structuredKey)
  if (rawStructured) {
    try {
      const parsed: unknown = JSON.parse(rawStructured)
      if (isStructuredDraft(parsed)) return makeComposerDraft(parsed.segments)
    } catch {
      // Fall through to the legacy plain-text draft.
    }
  }
  return makePlainComposerDraft(localStorage.getItem(`${LEGACY_DRAFT_PREFIX}${sessionId}`) || '')
}

export function persistComposerDraft(sessionId: string, draft: ComposerDraft): void {
  const structuredKey = `${STRUCTURED_DRAFT_PREFIX}${sessionId}`
  const legacyKey = `${LEGACY_DRAFT_PREFIX}${sessionId}`
  const serialized = serializeComposerDraft(draft)
  if (serialized.length === 0) {
    localStorage.removeItem(structuredKey)
    localStorage.removeItem(legacyKey)
    return
  }
  localStorage.setItem(structuredKey, JSON.stringify(makeComposerDraft(draft.segments)))
  localStorage.removeItem(legacyKey)
}

export function clearComposerDraft(sessionId: string): void {
  localStorage.removeItem(`${STRUCTURED_DRAFT_PREFIX}${sessionId}`)
  localStorage.removeItem(`${LEGACY_DRAFT_PREFIX}${sessionId}`)
}
