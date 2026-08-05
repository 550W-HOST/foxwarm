import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked } from 'marked'
import type { Tokens, TokenizerAndRendererExtension } from 'marked'

type MathToken = Tokens.Generic & {
  text: string
  displayMode: boolean
}

type MathPlaceholder = {
  marker: string
  html: string
}

export type MarkdownRenderSegment =
  | { kind: 'html'; html: string }
  | { kind: 'latex'; raw: string; source: string; html: string }
  | { kind: 'mermaid'; raw: string; source: string }

type SpecialBlockPlaceholder = Exclude<MarkdownRenderSegment, { kind: 'html' }> & {
  marker: string
}

type MathRenderContext = {
  markerPrefix: string
  placeholders: MathPlaceholder[]
  specialBlocks: SpecialBlockPlaceholder[]
  extractSpecialBlocks: boolean
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

  if (context.extractSpecialBlocks && token.type === 'displayMathBlock') {
    const marker = `${context.markerPrefix}SPECIAL_${context.specialBlocks.length}\uE001`
    context.specialBlocks.push({
      kind: 'latex',
      marker,
      raw: token.raw,
      source: mathToken.text,
      html,
    })
    return marker
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
  const singleLine = /^ {0,3}\\\[([^\r\n]*?)\\\][\t ]*(?:\r?\n|$)/.exec(candidate)
  if (singleLine) {
    const text = singleLine[1].trim()
    if (!text) return undefined
    return {
      index,
      raw: singleLine[0],
      text,
    }
  }

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
  const openingPattern = /^ {0,3}\\\[/gm
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

const mermaidCodeExtension: TokenizerAndRendererExtension = {
  name: 'code',
  renderer(token: Tokens.Generic) {
    const codeToken = token as Tokens.Code
    const language = codeToken.lang?.trim().toLowerCase()
    const context = activeMathRenderContext
    if (!context?.extractSpecialBlocks || language !== 'mermaid') return false

    const marker = `${context.markerPrefix}SPECIAL_${context.specialBlocks.length}\uE001`
    context.specialBlocks.push({
      kind: 'mermaid',
      marker,
      raw: codeToken.raw,
      source: codeToken.text,
    })
    return marker
  },
}

const markdown = new Marked({
  breaks: true,
  gfm: true,
  extensions: [mermaidCodeExtension, displayMathBlockExtension, displayMathPrefixExtension, displayMathExtension, inlineMathExtension],
})

const sanitizeHtml = (html: string): string => {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'embed', 'object', 'script', 'style'],
    FORBID_ATTR: ['src', 'xlink:href', 'action', 'formaction'],
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
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

const parseMarkdown = (text: string, sanitizer: HtmlSanitizer, extractSpecialBlocks: boolean): {
  html: string
  specialBlocks: SpecialBlockPlaceholder[]
} => {
  const previousContext = activeMathRenderContext
  const context: MathRenderContext = {
    markerPrefix: createMathMarkerPrefix(),
    placeholders: [],
    specialBlocks: [],
    extractSpecialBlocks,
  }

  activeMathRenderContext = context
  let html = ''
  try {
    html = markdown.parse(text) as string
  } finally {
    activeMathRenderContext = previousContext
  }

  const sanitized = addLinkTargetAttrs(sanitizer(html))
  return {
    html: replaceMathPlaceholders(sanitized, context.placeholders),
    specialBlocks: context.specialBlocks,
  }
}

export const renderMarkdownWithSanitizer = (text: string, sanitizer: HtmlSanitizer = sanitizeHtml): string => {
  return parseMarkdown(text, sanitizer, false).html
}

export const renderMarkdown = (text: string): string => renderMarkdownWithSanitizer(text)

export const renderAssistantMarkdownSegmentsWithSanitizer = (
  text: string,
  sanitizer: HtmlSanitizer = sanitizeHtml,
): MarkdownRenderSegment[] => {
  const { html, specialBlocks } = parseMarkdown(text, sanitizer, true)
  if (specialBlocks.length === 0) return html ? [{ kind: 'html', html }] : []

  const segments: MarkdownRenderSegment[] = []
  let cursor = 0
  for (const specialBlock of specialBlocks) {
    const markerIndex = html.indexOf(specialBlock.marker, cursor)
    if (markerIndex < 0) continue
    if (markerIndex > cursor) segments.push({ kind: 'html', html: html.slice(cursor, markerIndex) })
    const { marker: _marker, ...segment } = specialBlock
    segments.push(segment)
    cursor = markerIndex + specialBlock.marker.length
  }
  if (cursor < html.length) segments.push({ kind: 'html', html: html.slice(cursor) })
  return segments
}

export const renderAssistantMarkdownSegments = (text: string): MarkdownRenderSegment[] => (
  renderAssistantMarkdownSegmentsWithSanitizer(text)
)
