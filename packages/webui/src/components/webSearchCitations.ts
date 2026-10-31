import type { OpenAIResponsesAnnotation } from './chatShared'

export type WebSearchCitation = { url: string; title: string }
export type CitationRenderOptions = {
  annotations?: OpenAIResponsesAnnotation[]
  /** Offsets always refer to the original, complete current text part. */
  sourceText?: string
  sourceOffset?: number
  streaming?: boolean
}

export const safeWebSearchUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f\\]/.test(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname && !parsed.username && !parsed.password ? url : null
  } catch { return null }
}

export const normalizeWebSearchCitation = (annotation: OpenAIResponsesAnnotation): WebSearchCitation | null => {
  if (!annotation || typeof annotation !== 'object' || (annotation.type && annotation.type !== 'url_citation')) return null
  const nested = annotation.url_citation && typeof annotation.url_citation === 'object' ? annotation.url_citation : annotation
  const url = safeWebSearchUrl(nested.url)
  if (!url) return null
  return { url, title: typeof nested.title === 'string' && nested.title.trim() ? nested.title.trim() : url }
}

export const uniqueWebSearchCitations = (annotations: OpenAIResponsesAnnotation[] = []): WebSearchCitation[] => {
  const unique = new Map<string, WebSearchCitation>()
  for (const annotation of annotations) {
    const citation = normalizeWebSearchCitation(annotation)
    if (citation && !unique.has(citation.url)) unique.set(citation.url, citation)
  }
  return [...unique.values()]
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)
const markerPattern = () => /\uE200cite\uE202[^\uE200\uE201\r\n]*\uE201/g
const boundedDetail = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}…` : text

/** Resolve spans, never IDs: local reference names are not a global source registry. */
const annotatedMarkers = (source: string, annotations: OpenAIResponsesAnnotation[] = []): Map<number, WebSearchCitation[]> => {
  if (!annotations.length) return new Map()
  const markers = new Map(Array.from(source.matchAll(markerPattern()), match => [match.index, match[0]]))
  const result = new Map<number, WebSearchCitation[]>()
  // Providers can expose Unicode code-point or UTF-16 positions. Accept only an
  // exact whole-marker span and refuse a span ambiguous between the two units.
  const codePointOffsets = [0]
  for (const character of source) codePointOffsets.push(codePointOffsets[codePointOffsets.length - 1] + character.length)
  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation' && !annotation?.url_citation) continue
    const citation = normalizeWebSearchCitation(annotation)
    if (!citation) continue
    const nested = annotation.url_citation && typeof annotation.url_citation === 'object' ? annotation.url_citation : annotation
    const start = nested.start_index
    const end = nested.end_index
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) continue
    const candidates: Array<[number, number]> = []
    if (end <= source.length) candidates.push([start, end])
    if (end < codePointOffsets.length) candidates.push([codePointOffsets[start], codePointOffsets[end]])
    const matches = new Set(candidates.filter(([from, to]) => markers.get(from) === source.slice(from, to)).map(([from]) => from))
    if (matches.size !== 1) continue
    const position = [...matches][0]
    const citations = result.get(position) ?? []
    if (!citations.some(existing => existing.url === citation.url)) citations.push(citation)
    result.set(position, citations)
  }
  return result
}

export type CitationLexeme = { placeholder: string; raw: string; html: string }

/**
 * Position-bearing lexical placeholders keep exact provider offsets through
 * Markdown's list/quote normalization. The renderer restores literal fields
 * after lexing; code, HTML, math and special-block raw/copy text remain intact.
 */
export const prepareWebSearchCitations = (text: string, options: CitationRenderOptions = {}): { text: string; lexemes: CitationLexeme[]; prefix: string } => {
  const source = options.sourceText ?? text
  const offset = options.sourceOffset ?? 0
  const spans = source.slice(offset, offset + text.length) === text ? annotatedMarkers(source, options.annotations) : new Map<number, WebSearchCitation[]>()
  let prefix = '\uE000FOXWARMCITATION'
  while (text.includes(prefix)) prefix += 'X'
  const lexemes: CitationLexeme[] = []
  const replace = (raw: string, position: number, pending = false): string => {
    const references = boundedDetail(raw, 512).replace(/^\uE200cite\uE202/, '').replace(/\uE201$/, '').split('\uE202').filter(Boolean).join(', ')
    const citations = spans.get(offset + position) ?? []
    const title = escapeHtml(references || boundedDetail(raw, 512))
    // Full original source remains available in the message Raw/copy controls.
    const rawAttribute = escapeHtml(boundedDetail(raw, 2048))
    const html = pending && options.streaming ? '' : citations.length
      ? citations.map(citation => `<a class="foxwarm-citation" data-search-exclude="true" data-web-search-ref="resolved" data-citation-raw="${rawAttribute}" href="${escapeHtml(citation.url)}" title="${escapeHtml(boundedDetail(citation.title, 512))} — ${title}">[source]</a>`).join(' ')
      : `<span class="foxwarm-citation" data-search-exclude="true" data-web-search-ref="unresolved" data-citation-raw="${rawAttribute}" title="${title}">[source?]</span>`
    const placeholder = `${prefix}${lexemes.length}\uE001`
    lexemes.push({ placeholder, raw, html })
    return placeholder
  }
  // Handle the incomplete suffix separately so its original offset is retained.
  const pending = /\uE200(?:c(?:i(?:t(?:e(?:\uE202[A-Za-z0-9_.:\-\uE202]*)?)?)?)?)?$/.exec(text)
  const completeText = pending ? text.slice(0, pending.index) : text
  let prepared = completeText.replace(markerPattern(), (raw: string, position: number) => replace(raw, position))
  if (pending) prepared += replace(pending[0], pending.index, true)
  return { text: prepared, lexemes, prefix }
}
