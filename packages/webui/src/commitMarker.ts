import { normalizeCodePath, type CodeCommitTarget } from './vscodeWeb'
export type { CodeCommitTarget } from './vscodeWeb'

export type CommitMarkerSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'commit'; raw: string; target: CodeCommitTarget }
  | { kind: 'invalid'; raw: string }

const NODE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const COMMIT_ID_RE = /^[0-9a-f]{7,64}$/i
const ATTRIBUTE_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*/
const MAX_COMMIT_PATH_LENGTH = 4096

function decodeXmlAttribute(value: string): string | null {
  if (/[<>]/.test(value) || /&(?!(?:amp|quot|apos|lt|gt);)/.test(value)) return null
  return value.replace(/&([^;]+);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'lt': return '<'
      case 'gt': return '>'
      default: return ''
    }
  })
}

export function parseCommitMarkerLine(line: string): CodeCommitTarget | null {
  line = line.replace(/\r$/, '')
  if (!line.startsWith('<foxwarm-commit')) return null
  const outer = line.match(/^<foxwarm-commit\b([\s\S]*?)\/>\s*$/)
  if (!outer) return null

  const source = outer[1]
  const attrs = new Map<string, string>()
  let offset = 0
  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/)
    if (!whitespace) return null
    offset += whitespace[0].length
    if (offset >= source.length) break

    const nameMatch = source.slice(offset).match(ATTRIBUTE_NAME_RE)
    if (!nameMatch) return null
    const name = nameMatch[0]
    offset += name.length
    const equalsMatch = source.slice(offset).match(/^\s*=\s*"/)
    if (!equalsMatch) return null
    offset += equalsMatch[0].length
    const quoteIndex = source.indexOf('"', offset)
    if (quoteIndex < 0) return null
    const decoded = decodeXmlAttribute(source.slice(offset, quoteIndex))
    if (decoded === null || attrs.has(name)) return null
    attrs.set(name, decoded)
    offset = quoteIndex + 1
  }

  if (attrs.size !== 3 || !attrs.has('node') || !attrs.has('path') || !attrs.has('id')) return null
  const nodeId = attrs.get('node') || ''
  const rawPath = attrs.get('path') || ''
  const commitId = (attrs.get('id') || '').toLowerCase()
  if (!NODE_ID_RE.test(nodeId) || rawPath.length > MAX_COMMIT_PATH_LENGTH || !COMMIT_ID_RE.test(commitId)) return null
  const normalizedPath = normalizeCodePath(rawPath)
  if (!normalizedPath || rawPath.includes('\0')) return null
  return { nodeId, path: normalizedPath, commitId }
}

function getFence(line: string): { character: '`' | '~'; length: number; rest: string } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
    rest: match[2],
  }
}

export function splitCommitMarkers(text: string): CommitMarkerSegment[] {
  const lines = text.split('\n')
  const segments: CommitMarkerSegment[] = []
  let markdownLines: string[] = []
  let openFence: { character: '`' | '~'; length: number } | null = null

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return
    const value = markdownLines.join('\n')
    if (value) segments.push({ kind: 'markdown', text: value })
    markdownLines = []
  }

  for (const sourceLine of lines) {
    const line = sourceLine.replace(/\r$/, '')
    const fence = getFence(line)
    if (openFence) {
      markdownLines.push(sourceLine)
      if (fence && fence.character === openFence.character && fence.length >= openFence.length && !fence.rest.trim()) {
        openFence = null
      }
      continue
    }
    if (fence) {
      openFence = { character: fence.character, length: fence.length }
      markdownLines.push(sourceLine)
      continue
    }
    if (!line.startsWith('<foxwarm-commit')) {
      markdownLines.push(sourceLine)
      continue
    }

    flushMarkdown()
    const target = parseCommitMarkerLine(line)
    if (target) segments.push({ kind: 'commit', raw: line, target })
    else segments.push({ kind: 'invalid', raw: line })
  }
  flushMarkdown()
  return segments
}
