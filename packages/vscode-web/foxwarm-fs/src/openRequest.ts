export type FoxwarmOpenRequest =
  | { kind: 'addFolder'; nodeId: string; path: string }
  | { kind: 'openFile'; nodeId: string; path: string; startLine?: number; startColumn?: number; endLine?: number }

export type NormalizedFoxwarmOpenRequest =
  | { kind: 'addFolder'; nodeId: string; path: string }
  | { kind: 'openFile'; nodeId: string; path: string; startLine?: number; startColumn?: number; endLine?: number }

export function normalizeFoxwarmAbsolutePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Foxwarm path must be a string.')
  }
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) {
    throw new Error('Foxwarm path must be an absolute POSIX path.')
  }

  const segments: string[] = []
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function normalizeLine(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Number(value)
}

export function normalizeFoxwarmOpenRequest(value: unknown): NormalizedFoxwarmOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Foxwarm open request.')
  }
  const request = value as Record<string, unknown>
  if (typeof request.nodeId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(request.nodeId)) {
    throw new Error('Foxwarm node id is invalid.')
  }
  const nodeId = request.nodeId
  const path = normalizeFoxwarmAbsolutePath(request.path)

  if (request.kind === 'addFolder') {
    return { kind: 'addFolder', nodeId, path }
  }
  if (request.kind === 'openFile') {
    const startLine = normalizeLine(request.startLine, 'startLine')
    const startColumn = normalizeLine(request.startColumn, 'startColumn')
    const endLine = normalizeLine(request.endLine, 'endLine')
    if (startColumn !== undefined && startLine === undefined) {
      throw new Error('startColumn requires startLine.')
    }
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new Error('endLine must not be before startLine.')
    }
    return {
      kind: 'openFile',
      nodeId,
      path,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(startColumn !== undefined ? { startColumn } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    }
  }
  throw new Error('Unsupported Foxwarm open request kind.')
}
