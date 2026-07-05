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

type MathRenderContext = {
  markerPrefix: string
  placeholders: MathPlaceholder[]
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

const markdown = new Marked({
  breaks: true,
  gfm: true,
  extensions: [displayMathExtension, inlineMathExtension],
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

export const renderMarkdownWithSanitizer = (text: string, sanitizer: HtmlSanitizer = sanitizeHtml): string => {
  const previousContext = activeMathRenderContext
  const context: MathRenderContext = {
    markerPrefix: createMathMarkerPrefix(),
    placeholders: [],
  }

  activeMathRenderContext = context
  let html = ''
  try {
    html = markdown.parse(text) as string
  } finally {
    activeMathRenderContext = previousContext
  }

  const sanitized = addLinkTargetAttrs(sanitizer(html))
  return replaceMathPlaceholders(sanitized, context.placeholders)
}

export const renderMarkdown = (text: string): string => renderMarkdownWithSanitizer(text)
