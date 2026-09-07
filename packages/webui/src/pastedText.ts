export const PASTED_TEXT_OPEN = '<pasted-text>'
export const PASTED_TEXT_CLOSE = '</pasted-text>'

export type PastedTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pasted-text'; text: string }

const plain = (text: string): PastedTextSegment[] => [{ kind: 'text', text }]

export function parsePastedTextSegments(text: string): PastedTextSegment[] {
  if (!text.includes(PASTED_TEXT_OPEN)) return plain(text)

  const segments: PastedTextSegment[] = []
  let cursor = 0
  let found = false

  while (cursor < text.length) {
    const openIndex = text.indexOf(PASTED_TEXT_OPEN, cursor)
    if (openIndex < 0) {
      if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
      break
    }

    const contentStart = openIndex + PASTED_TEXT_OPEN.length
    const closeIndex = text.indexOf(PASTED_TEXT_CLOSE, contentStart)
    if (closeIndex < 0) return plain(text)

    const nestedOpenIndex = text.indexOf(PASTED_TEXT_OPEN, contentStart)
    if (nestedOpenIndex >= 0 && nestedOpenIndex < closeIndex) return plain(text)

    if (openIndex > cursor) segments.push({ kind: 'text', text: text.slice(cursor, openIndex) })
    segments.push({ kind: 'pasted-text', text: text.slice(contentStart, closeIndex) })
    found = true
    cursor = closeIndex + PASTED_TEXT_CLOSE.length
  }

  if (!found) return plain(text)
  return segments
}

export function getPastedTextPreview(text: string, maxCharacters = 72): string {
  const firstNonemptyLine = text.split(/\r\n|\r|\n/).find(line => line.trim().length > 0)?.trim() || 'Empty pasted text'
  const characters = Array.from(firstNonemptyLine)
  if (characters.length <= maxCharacters) return firstNonemptyLine
  return `${characters.slice(0, maxCharacters).join('')}…`
}

export function countPastedTextCharacters(text: string): number {
  return Array.from(text).length
}
