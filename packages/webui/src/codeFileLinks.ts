import type { FunctionResponse, Message } from './components/chatShared'
import { normalizeCodePath, resolveToolCodeFileTarget, type CodeFileTarget } from './vscodeWeb'

/** Where file links written after a tool call resolve: that call's Node and, when known, its Session cwd. */
export type CodeLinkBase = { nodeId: string; cwd?: string }

export type ParsedFileLink = { path: string; startLine?: number; endLine?: number }

const positiveLine = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

const decodePath = (value: string): string => {
  try { return decodeURIComponent(value) } catch { return value }
}

/**
 * Reads a Markdown link destination as a file path, or returns null for anything else.
 * A file link has no URL scheme (a Windows drive letter is a path) or uses `file:`.
 * `#L10`, `#L10-L20`, `:10`, `:10-20` and `:10:5` select lines; other fragments are dropped.
 */
export function parseFileLinkHref(href: string): ParsedFileLink | null {
  let value = href.trim()
  if (!value || value.startsWith('#') || value.startsWith('?') || value.startsWith('//')) return null
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]
  if (scheme && scheme.toLowerCase() === 'file') {
    value = value.slice(5)
    if (value.startsWith('//')) {
      const rest = value.slice(2)
      const slash = rest.indexOf('/')
      const host = slash < 0 ? rest : rest.slice(0, slash)
      if (host && host.toLowerCase() !== 'localhost') return null
      value = slash < 0 ? '/' : rest.slice(slash)
      // file:///C:/dir names a Windows drive path.
      if (/^\/[A-Za-z]:(?:\/|$)/.test(value)) value = value.slice(1)
    }
  } else if (scheme
    && !(scheme.length === 1 && /^[A-Za-z]:[\\/]/.test(value))
    // `README.md:10` is a file with a line, not a URL scheme.
    && !/^\d+(?:[-:]\d+)?(?:#.*)?$/.test(value.slice(scheme.length + 1))) {
    return null
  }
  let startLine: number | undefined
  let endLine: number | undefined
  const hash = value.indexOf('#')
  if (hash >= 0) {
    const fragment = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(value.slice(hash + 1))
    if (fragment) {
      startLine = positiveLine(fragment[1])
      endLine = positiveLine(fragment[2])
    }
    value = value.slice(0, hash)
  }
  let path = decodePath(value)
  if (startLine === undefined) {
    const suffix = /^(.*?[^:]):(\d+)(?:-(\d+)|:\d+)?$/.exec(path)
    // A bare drive letter (`C:1`) is not a path with a line.
    if (suffix && !/^[A-Za-z]$/.test(suffix[1])) {
      path = suffix[1]
      startLine = positiveLine(suffix[2])
      endLine = positiveLine(suffix[3])
    }
  }
  if (!path.trim()) return null
  return {
    path,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(startLine !== undefined && endLine !== undefined && endLine >= startLine ? { endLine } : {}),
  }
}

/**
 * Resolves a reply link against its base. Undefined: not a file link. Null: a file link
 * that cannot be resolved exactly (no base, or a relative path without a known cwd).
 */
export function resolveFileLink(href: string, base: CodeLinkBase | undefined): CodeFileTarget | null | undefined {
  const parsed = parseFileLinkHref(href)
  if (!parsed) return undefined
  if (!base) return null
  return resolveToolCodeFileTarget(parsed.path, base.nodeId, base.cwd, parsed)
}

type DisplayMeta = NonNullable<FunctionResponse['__meta']>

/** `@agent` is the Agent's own folder as a file endpoint: no Node to open in Code or link from. */
export const isAgentFolderNode = (nodeId: unknown): boolean => nodeId === '@agent'

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** An older native file call's own cwd: its resolved path minus its plain relative input. */
const resolvedPathCwd = (paths: DisplayMeta['resolvedPaths']): string | undefined => {
  for (const entry of paths || []) {
    const raw = text(entry?.raw)?.trim().replaceAll('\\', '/')
    const resolved = normalizeCodePath(entry?.resolved)
    if (!raw || !resolved || /^(?:\/|~|\$|[A-Za-z]:)/.test(raw)) continue
    const segments = raw.split('/').filter(segment => segment && segment !== '.')
    if (!segments.length || segments.includes('..')) continue
    const suffix = `/${segments.join('/')}`
    if (resolved.endsWith(suffix)) return resolved.slice(0, -suffix.length) || '/'
  }
  return undefined
}

/** The link base a tool response leaves for text written after it, if it records one. */
export function linkBaseAfter(response: FunctionResponse): CodeLinkBase | undefined {
  const meta = response.__meta
  if (!meta) return undefined
  const target = meta.target
  const named = target?.source === 'node' ? text(target.node) : undefined
  const targetNode = isAgentFolderNode(named) ? undefined : named
  const placement = meta.placementAfter
  const placementNode = text(placement?.node)
  if (placementNode) {
    const nodeId = targetNode || placementNode
    const cwd = nodeId === placementNode ? text(placement?.cwd) : undefined
    return { nodeId, ...(cwd ? { cwd } : {}) }
  }
  // Older history has no placement record; only Node-targeted calls name their Node, and
  // only the call's own metadata may supply a cwd.
  const exec = meta.exec
  const receipts = meta.resolvedPaths?.filter(entry => !isAgentFolderNode(entry?.nodeId))
  const nodeId = targetNode || text(exec?.nodeId) || text(receipts?.[0]?.nodeId)
  if (!nodeId) return undefined
  const cwd = exec && text(exec.nodeId) === nodeId
    ? text(exec.finalCwd) || text(exec.sessionCwd)
    : resolvedPathCwd(receipts?.filter(entry => entry?.nodeId === nodeId))
  return { nodeId, ...(cwd ? { cwd } : {}) }
}

const SEPARATOR = '\u0000'

export const encodeLinkBase = (base: CodeLinkBase | undefined): string => base ? `${base.nodeId}${SEPARATOR}${base.cwd ?? ''}` : ''

export const decodeLinkBase = (key: string): CodeLinkBase | undefined => {
  if (!key) return undefined
  const [nodeId, cwd] = key.split(SEPARATOR)
  return { nodeId, ...(cwd ? { cwd } : {}) }
}

/** Each model message's link base: the most recent tool response before it that records one. */
export function computeLinkBases(messages: Iterable<Message>): Map<Message, string> {
  const bases = new Map<Message, string>()
  let current = ''
  for (const message of messages) {
    if (message.role === 'model') bases.set(message, current)
    for (const part of message.parts || []) {
      const base = part.functionResponse ? linkBaseAfter(part.functionResponse) : undefined
      if (base) current = encodeLinkBase(base)
    }
  }
  return bases
}
