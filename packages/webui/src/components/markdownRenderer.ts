import { parseArtifactMarker, type ArtifactReference } from '../../../shared/src/artifacts/marker'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked } from 'marked'
import type { Token, Tokens, TokenizerAndRendererExtension } from 'marked'

type MathToken = Tokens.Generic & {
  text: string
  displayMode: boolean
}

type MathPlaceholder = {
  marker: string
  html: string
}

export type MarkdownRenderSegment =
  | { kind: 'html'; tokenIndex: number; html: string }
  | { kind: 'latex'; tokenIndex: number; raw: string; source: string; html: string }
  | { kind: 'mermaid'; tokenIndex: number; raw: string; source: string }
  | { kind: 'artifact'; tokenIndex: number; reference: ArtifactReference }

type MathRenderContext = {
  markerPrefix: string
  placeholders: MathPlaceholder[]
}

type DisplayMathBlockMatch = {
  index: number
  raw: string
  text: string
}

export type HtmlSanitizer = (html: string) => string

let activeMathRenderContext: MathRenderContext | null = null
let mathRenderContextCounter = 0

const createMathMarkerPrefix = (): string => {
  mathRenderContextCounter += 1
  return `\uE000FOXWARM_MATH_${Date.now().toString(36)}_${mathRenderContextCounter}_`
}

const escapeHtml = (value: string): string => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
)

const findClosingDelimiter = (src: string, delimiter: string, startIndex: number): number => {
  return src.indexOf(delimiter, startIndex)
}

const renderKatexHtml = (text: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(text, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
    })
  } catch {
    const fallback = displayMode ? `\\[${text}\\]` : `\\(${text}\\)`
    return `<code class="foxwarm-math-error">${escapeHtml(fallback)}</code>`
  }
}

const renderMathToken = (token: Tokens.Generic): string => {
  const mathToken = token as MathToken
  const html = renderKatexHtml(mathToken.text, mathToken.displayMode)
  const context = activeMathRenderContext

  if (!context) {
    return html
  }

  const marker = `${context.markerPrefix}${context.placeholders.length}\uE001`
  context.placeholders.push({ marker, html })
  return marker
}

const inlineMathExtension: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src: string) {
    const index = src.indexOf('\\(')
    return index >= 0 ? index : undefined
  },
  tokenizer(src: string) {
    if (!src.startsWith('\\(')) return undefined
    const end = findClosingDelimiter(src, '\\)', 2)
    if (end < 0) return undefined

    const text = src.slice(2, end).trim()
    if (!text) return undefined

    return {
      type: 'inlineMath',
      raw: src.slice(0, end + 2),
      text,
      displayMode: false,
    }
  },
  renderer: renderMathToken,
}

const displayMathExtension: TokenizerAndRendererExtension = {
  name: 'displayMath',
  level: 'inline',
  tokenizer(src: string) {
    if (!src.startsWith('\\[')) return undefined

    const end = findClosingDelimiter(src, '\\]', 2)
    if (end < 0) return undefined

    const text = src.slice(2, end).trim()
    if (!text) return undefined

    return {
      type: 'displayMath',
      raw: src.slice(0, end + 2),
      text,
      displayMode: true,
    }
  },
  renderer: renderMathToken,
}

const isInsideMarkdownCode = (src: string, index: number): boolean => {
  const prefix = src.slice(0, index)
  // Let Marked reach any fenced region through its native block tokenizer.
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(prefix)) return true

  const backtickRuns = Array.from(src.matchAll(/`+/g))

  for (let openingIndex = 0; openingIndex < backtickRuns.length; openingIndex += 1) {
    const opening = backtickRuns[openingIndex]
    if (opening.index >= index) break

    const closingOffset = backtickRuns
      .slice(openingIndex + 1)
      .findIndex((candidate) => candidate[0].length === opening[0].length)
    if (closingOffset < 0) continue

    const closingIndex = openingIndex + closingOffset + 1
    const closing = backtickRuns[closingIndex]
    if (index < closing.index + closing[0].length) return true
    openingIndex = closingIndex
  }

  return false
}

const matchDisplayMathBlock = (src: string, index: number): DisplayMathBlockMatch | undefined => {
  const candidate = src.slice(index)
  const opening = /^ {0,3}\\\[[\t ]*\r?\n/.exec(candidate)
  if (!opening) return undefined

  const closingPattern = /^ {0,3}\\\][\t ]*(?:\r?\n|$)/gm
  closingPattern.lastIndex = opening[0].length
  const closing = closingPattern.exec(candidate)
  if (!closing) return undefined

  const text = candidate.slice(opening[0].length, closing.index).trim()
  if (!text) return undefined

  return {
    index,
    raw: candidate.slice(0, closing.index + closing[0].length),
    text,
  }
}

const findDisplayMathBlock = (src: string): DisplayMathBlockMatch | undefined => {
  const openingPattern = /^ {0,3}\\\[[\t ]*\r?\n/gm
  let opening: RegExpExecArray | null

  while ((opening = openingPattern.exec(src))) {
    const match = matchDisplayMathBlock(src, opening.index)
    if (match && !isInsideMarkdownCode(src, opening.index)) return match
  }

  return undefined
}

const displayMathPrefixExtension: TokenizerAndRendererExtension = {
  name: 'displayMathPrefix',
  level: 'block',
  childTokens: ['tokens'],
  tokenizer(src: string) {
    const match = findDisplayMathBlock(src)
    if (!match || match.index === 0) return undefined

    // Marked checks Setext headings before paragraph start hints, so clip a
    // preceding Markdown prefix as its own nested block token first.
    const raw = src.slice(0, match.index)
    return {
      type: 'displayMathPrefix',
      raw,
      tokens: this.lexer.blockTokens(raw, []),
    }
  },
  renderer(token: Tokens.Generic) {
    return this.parser.parse(token.tokens ?? [])
  },
}

const displayMathBlockExtension: TokenizerAndRendererExtension = {
  name: 'displayMathBlock',
  level: 'block',
  tokenizer(src: string) {
    const match = matchDisplayMathBlock(src, 0)
    if (!match) return undefined

    return {
      type: 'displayMathBlock',
      raw: match.raw,
      text: match.text,
      displayMode: true,
    }
  },
  renderer: renderMathToken,
}

const artifactReferenceExtension: TokenizerAndRendererExtension = {
  name: 'artifactReference', level: 'block',
  start(src: string) {
    const pattern = /(?:^|\n\n)(<foxwarm-artifact\b|<foxwarm-a[a-z]*$)/g
    let found: RegExpExecArray | null
    while ((found = pattern.exec(src))) {
      const index = found.index + found[0].indexOf('<')
      if (!isInsideMarkdownCode(src, index)) return index
    }
    return undefined
  },
  tokenizer(src: string) {
    const line = src.split('\n', 1)[0].replace(/\r$/, '')
    if (!/^<foxwarm-artifact(?:\s|$)/.test(line) && !(line.length >= 10 && '<foxwarm-artifact'.startsWith(line))) return
    // A figure is its own Markdown block. Nested list/quote tokens stay literal.
    if (src.includes('\n') && src.slice(src.indexOf('\n') + 1).trim() && !/^\r?\n/.test(src.slice(src.indexOf('\n') + 1))) return
    const raw = src.slice(0, src.indexOf('\n') < 0 ? src.length : src.indexOf('\n') + 1)
    return { type: 'artifactReference', raw, reference: parseArtifactMarker(line), pending: !src.includes('\n') && !line.includes('>') }
  },
  renderer(token) { return `<pre><code>${escapeHtml(token.raw.trimEnd())}</code></pre>` },
}

const markdown = new Marked({
  breaks: true,
  gfm: true,
  extensions: [artifactReferenceExtension, displayMathBlockExtension, displayMathPrefixExtension, displayMathExtension, inlineMathExtension],
})

const sanitizeHtml = (html: string, allowTableScrollWrapper = false): string => {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'embed', 'object', 'script', 'style'],
    FORBID_ATTR: ['src', 'xlink:href', 'action', 'formaction'],
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a',
      ...(allowTableScrollWrapper ? ['div'] : []),
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['class', 'href', 'target', 'rel'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
  })
}

const addLinkTargetAttrs = (html: string): string => {
  // Add target="_blank" and rel="noopener noreferrer" to all sanitized <a> tags.
  return html.replace(/<a\s/g, '<a target="_blank" rel="noopener noreferrer" ')
}

const replaceMathPlaceholders = (html: string, placeholders: MathPlaceholder[]): string => {
  return placeholders.reduce((current, placeholder) => current.split(placeholder.marker).join(placeholder.html), html)
}

const renderMarkdownTokens = (tokens: Token[], sanitizer: HtmlSanitizer, wrapTables = false): string => {
  const previousContext = activeMathRenderContext
  const context: MathRenderContext = {
    markerPrefix: createMathMarkerPrefix(),
    placeholders: [],
  }
  const renderer = wrapTables ? new markdown.Renderer(markdown.defaults) : undefined

  if (renderer) {
    const renderTable = renderer.table
    renderer.table = function (token) {
      return `<div class="foxwarm-markdown-table-scroll">${renderTable.call(this, token)}</div>`
    }
  }

  activeMathRenderContext = context
  let html = ''
  try {
    html = markdown.parser(tokens, renderer ? { ...markdown.defaults, renderer } : undefined) as string
  } finally {
    activeMathRenderContext = previousContext
  }

  const sanitized = addLinkTargetAttrs(sanitizer(html))
  return replaceMathPlaceholders(sanitized, context.placeholders)
}

export const renderMarkdownWithSanitizer = (text: string, sanitizer: HtmlSanitizer = sanitizeHtml): string => {
  return renderMarkdownTokens(markdown.lexer(text), sanitizer)
}

const sanitizeAssistantHtml = (html: string): string => sanitizeHtml(html, true)

const tokenContainsTable = (token: Token): boolean => {
  if (token.type === 'table') return true
  if (token.type === 'list') return token.items.some((item: Tokens.ListItem) => item.tokens.some(tokenContainsTable))
  return 'tokens' in token && Array.isArray(token.tokens) && token.tokens.some(tokenContainsTable)
}

export const renderMarkdown = (text: string): string => renderMarkdownWithSanitizer(text)

export const renderMarkdownSegmentsWithSanitizer = (
  text: string,
  sanitizer: HtmlSanitizer = sanitizeHtml,
): Array<Extract<MarkdownRenderSegment, { kind: 'html' }>> => (
  markdown.lexer(text).flatMap((token, tokenIndex) => {
    const html = renderMarkdownTokens([token], sanitizer)
    return html ? [{ kind: 'html' as const, tokenIndex, html }] : []
  })
)

export const renderMarkdownSegments = (text: string): Array<Extract<MarkdownRenderSegment, { kind: 'html' }>> => (
  renderMarkdownSegmentsWithSanitizer(text)
)

// This parser-only wrapper groups preceding siblings, not authored nesting.
// Expose those siblings before projecting interactive blocks so later math
// cannot turn an already rendered artifact/Mermaid block into literal HTML.
const assistantTopLevelTokens = (tokens: Token[]): Token[] => tokens.flatMap(token =>
  token.type === 'displayMathPrefix' && Array.isArray(token.tokens)
    ? assistantTopLevelTokens(token.tokens)
    : [token],
)

export const renderAssistantMarkdownSegmentsWithSanitizer = (
  text: string,
  sanitizer?: HtmlSanitizer,
  artifacts?: { enabled: boolean; streaming?: boolean },
): MarkdownRenderSegment[] => {
  const segments: MarkdownRenderSegment[] = []

  for (const [tokenIndex, token] of assistantTopLevelTokens(markdown.lexer(text)).entries()) {
    if (artifacts?.enabled && token.type === 'artifactReference') {
      if (token.reference) { segments.push({ kind: 'artifact', tokenIndex, reference: token.reference }); continue }
      if (artifacts.streaming && token.pending) continue
    }
    if (token.type === 'code' && token.lang?.trim().toLowerCase() === 'mermaid') {
      segments.push({ kind: 'mermaid', tokenIndex, raw: token.raw, source: token.text })
      continue
    }
    if (token.type === 'displayMathBlock') {
      const mathToken = token as MathToken
      segments.push({
        kind: 'latex',
        tokenIndex,
        raw: token.raw,
        source: mathToken.text,
        html: renderKatexHtml(mathToken.text, true),
      })
      continue
    }
    const wrapTables = tokenContainsTable(token)
    const html = renderMarkdownTokens([token], sanitizer ?? (wrapTables ? sanitizeAssistantHtml : sanitizeHtml), wrapTables)
    if (html) segments.push({ kind: 'html', tokenIndex, html })
  }
  return segments
}

export const renderAssistantMarkdownSegments = (text: string, artifacts?: { enabled: boolean; streaming?: boolean }): MarkdownRenderSegment[] => (
  renderAssistantMarkdownSegmentsWithSanitizer(text, undefined, artifacts)
)
/** Reuse the same top-level lexer contract for reply-tail deduplication. */
export function assistantArtifactReferences(text: string): ArtifactReference[] {
  if (!text.includes('<foxwarm-artifact')) return []
  return assistantTopLevelTokens(markdown.lexer(text)).flatMap(token => token.type === 'artifactReference' && token.reference ? [token.reference as ArtifactReference] : [])
}
