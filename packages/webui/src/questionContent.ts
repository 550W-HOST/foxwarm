import { Lexer, Marked, walkTokens, type Token, type Tokens } from 'marked'
import { unescapeFoxwarmAttributeValue } from '../../shared/src/foxwarmMarkup'
import { splitGeneratedAttachmentName } from './attachmentRefs'
import { parsePastedTextSegments } from './pastedText'

export interface QuestionAttachment {
  ref: string
  name: string
  kind: 'image' | 'file'
  node: string
  path?: string
  mimeType: string
}

export interface QuestionContentProjection {
  markdown: string
  attachments: QuestionAttachment[]
}

const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}\[\]()<>!#|]/g, '\\$&')

// Transport tags must not start Markdown's open-ended raw-HTML blocks: a
// standalone attachment-ref before a fence otherwise hides that fence from the lexer.
const literalMarkdown = new Marked({ tokenizer: { html(source) {
  const tag = /^ {0,3}<\/?(?:foxwarm-(?:message|system|metadata|image|file)|attachment-ref|pasted-text)\b(?:[^">]|"[^"]*")*>[ \t]*(?:\r?\n)?/.exec(source)
  return tag ? { type: 'html', raw: tag[0], text: tag[0], block: true, pre: false } : false
} } })

/** Presentation-only projection, including old via-message answers that contain transport tags.
 * Never rewrite code or pasted literals, and never turn a descriptor into executable HTML.
 */
export function projectQuestionContent(text: string, viaMessage = false): QuestionContentProjection {
  if (!viaMessage) return { markdown: text, attachments: [] }
  const attachments = new Map<string, QuestionAttachment>()
  const protectedText: string[] = []
  let prefix = 'FOXWARMQUESTIONLITERAL'
  while (text.includes(prefix)) prefix += 'X'
  const protect = (literal: string) => `${prefix}${protectedText.push(literal) - 1}END`
  let markdown = text
  // Unwrap only a complete outer envelope, before lexing: otherwise Markdown
  // treats the entire message as raw HTML and cannot identify its code spans.
  const envelope = /^\s*<foxwarm-(message|system|metadata)\b[^>]*>\r?\n([\s\S]*)\r?\n[ \t]*<\/foxwarm-\1>[ \t\r\n]*$/
  for (let match = envelope.exec(markdown); match; match = envelope.exec(markdown)) markdown = match[2]
  const codeRanges = (source: string) => {
    const ranges: Array<{ start: number; end: number; literal: string }> = []
    const tokens = literalMarkdown.lexer(source)
    const add = (raw: string) => {
      if (raw.includes(prefix)) return
      for (let start = source.indexOf(raw); start >= 0; start = source.indexOf(raw, start + raw.length)) {
        ranges.push({ start, end: start + raw.length, literal: raw })
      }
    }
    walkTokens(tokens, token => { if (['code', 'codespan'].includes(token.type)) add(token.raw) })
    for (const token of tokens) {
      if (token.type !== 'blockquote' && token.type !== 'list') continue
      let nestedCode = false
      walkTokens([token], child => { if (child.type === 'code') nestedCode = true })
      // Nested code.raw has lost quote/list indentation and is not a source
      // substring. Keep its authored container intact rather than accidentally
      // activating descriptors from a quoted example. Markdown still renders it normally.
      if (nestedCode) add(token.raw)
    }
    return ranges
  }
  const ranges = codeRanges(markdown)
  let offset = 0
  for (const segment of parsePastedTextSegments(markdown)) {
    if (segment.kind === 'text') { offset += segment.text.length; continue }
    const rawLength = '<pasted-text>'.length + segment.text.length + '</pasted-text>'.length
    const longest = Math.max(0, ...[...segment.text.matchAll(/`+/g)].map(match => match[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    ranges.push({ start: offset, end: offset + rawLength, literal: `\n\n${fence}\n${segment.text}\n${fence}\n\n` })
    offset += rawLength
  }
  // Whichever opens first owns nested syntax: pasted blocks can quote broken
  // fences, and code can quote pasted tags. Neither may consume the other's delimiters.
  const protectRanges = (source: string, candidates: ReturnType<typeof codeRanges>) => {
    let cursor = 0, result = ''
    for (const range of candidates.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (range.start < cursor) continue
      result += source.slice(cursor, range.start) + protect(range.literal)
      cursor = range.end
    }
    return result + source.slice(cursor)
  }
  markdown = protectRanges(markdown, ranges)
  // An unclosed fence inside a now-protected pasted block may have hidden later
  // real code during the first lex. Scan again without touching existing placeholders.
  markdown = protectRanges(markdown, codeRanges(markdown))
  markdown = markdown.replace(/<foxwarm-(image|file)\b((?:[^">]|"[^"]*")*)\s*\/>/g, (raw, kind: 'image' | 'file', attributes: string) => {
    const attrs: Record<string, string> = {}
    for (const match of attributes.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = unescapeFoxwarmAttributeValue(match[2])
    const generated = splitGeneratedAttachmentName(attrs.name || '')
    if (!generated) return raw
    if (!attachments.has(generated.ref)) {
      const extension = generated.originalName.split('.').at(-1)?.toLowerCase() || ''
      const imageMime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension]
      attachments.set(generated.ref, {
        ref: generated.ref, name: generated.originalName, kind, node: attrs.node || 'master',
        ...(attrs.path ? { path: attrs.path } : {}), mimeType: attrs.mime || (kind === 'image' ? imageMime : '') || 'application/octet-stream',
      })
    }
    return ''
  })
  markdown = markdown.replace(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g, (_raw, ref: string) => {
    const attachment = attachments.get(ref)
    return escapeMarkdown(attachment ? `[${attachment.kind === 'image' ? 'Image' : 'File'}: ${attachment.name}]` : `[Attachment ${ref.slice('attachment'.length)}]`)
  })
  // These are message envelopes, not content. Normal answers have already lost them,
  // but older records and channel inputs may still carry opening/closing lines.
  markdown = markdown.replace(/^\s*<\/?foxwarm-(?:message|system|metadata)\b[^>]*>\s*$/gm, '')
  for (let index = protectedText.length - 1; index >= 0; index--) markdown = markdown.split(`${prefix}${index}END`).join(protectedText[index])
  return { markdown: markdown.trim(), attachments: [...attachments.values()] }
}

/** Compact plain-text summary; formatting belongs in the expanded answer, never in a button. */
export function questionContentSummary(text: string, viaMessage = false): string {
  const { markdown } = projectQuestionContent(text, viaMessage)
  const plain = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === 'html') return ''
    if (token.type === 'list') return token.items.map((item: Tokens.ListItem) => plain(item.tokens)).join('\n') + '\n'
    if (token.type === 'table') return [...token.header, ...token.rows.flat()].map(cell => plain(cell.tokens)).join(' ') + '\n'
    if ('tokens' in token && Array.isArray(token.tokens)) return plain(token.tokens) + (['paragraph', 'heading', 'blockquote', 'text'].includes(token.type) ? '\n' : '')
    return 'text' in token && typeof token.text === 'string' ? token.text : ' '
  }).join('')
  const summary = plain(Lexer.lex(markdown)).replace(/\s+/g, ' ').trim()
  return summary || (markdown ? 'Answer received' : '')
}
