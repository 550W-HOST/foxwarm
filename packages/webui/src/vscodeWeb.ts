export const VSCODE_WEB_TAB_ID = 'vscode-web'
export const CODE_OPEN_NEW_WINDOW_STORAGE_KEY = 'foxwarm_code_open_new_window_v1'
export const CODE_WORKSPACE_PATH_STORAGE_KEY = 'foxwarm_code_workspace_path_v1'
export const CODE_BRIDGE_CHANNEL = 'foxwarm-code-bridge'
export const CODE_BRIDGE_VERSION = 1

export interface CodeTarget {
  nodeId: string
  path: string
}

export interface CodeCommitTarget extends CodeTarget {
  commitId: string
}

export type CodeOpenRequest =
  | { kind: 'addFolder'; nodeId: string; path: string }
  | { kind: 'openFile'; nodeId: string; path: string; startLine?: number; endLine?: number }
  | ({ kind: 'openCommit' } & CodeCommitTarget)

export type CodeFileTarget = Extract<CodeOpenRequest, { kind: 'openFile' }>

export type CodeOpenPlan = 'new-window' | 'start-embedded' | 'reuse-embedded'

export function planCodeOpen(frameStarted: boolean, preferredNewWindow: boolean, forceNewWindow = false): CodeOpenPlan {
  if (shouldOpenCodeInNewWindow(preferredNewWindow, forceNewWindow)) return 'new-window'
  return frameStarted ? 'reuse-embedded' : 'start-embedded'
}

export function getVscodeWebPath(apiBasePath: string): string {
  const normalizedApiBase = apiBasePath.replace(/\/+$/, '')
  const deploymentBase = normalizedApiBase.endsWith('/api')
    ? normalizedApiBase.slice(0, -'/api'.length)
    : normalizedApiBase
  return `${deploymentBase}/vscode-web/` || '/vscode-web/'
}

export function normalizeCodePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) return null

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

export function resolveToolCodeFileTarget(
  filePath: unknown,
  nodeId: unknown,
  cwd: unknown,
  lines: { startLine?: unknown; endLine?: unknown } = {},
): CodeFileTarget | null {
  const normalizedNodeId = typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : 'master'
  if (!/^[A-Za-z0-9._-]+$/.test(normalizedNodeId)) return null
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.trim().startsWith('~')) return null
  const rawPath = filePath.trim()
  const absolutePath = rawPath.startsWith('/')
    ? normalizeCodePath(rawPath)
    : (typeof cwd === 'string' && normalizeCodePath(cwd)
      ? normalizeCodePath(`${normalizeCodePath(cwd)}/${rawPath}`)
      : null)
  if (!absolutePath) return null

  const normalizeLine = (value: unknown): number | undefined => {
    const line = Number(value)
    return Number.isInteger(line) && line > 0 ? line : undefined
  }
  const startLine = normalizeLine(lines.startLine)
  const endLine = normalizeLine(lines.endLine)
  return {
    kind: 'openFile',
    nodeId: normalizedNodeId,
    path: absolutePath,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined && (startLine === undefined || endLine >= startLine) ? { endLine } : {}),
  }
}

export function parseCodeOpenInNewWindow(value: unknown): boolean {
  return value === 'true'
}

type CodePreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readCodeOpenInNewWindowPreference(storage: CodePreferenceStorage): boolean {
  try {
    return parseCodeOpenInNewWindow(storage.getItem(CODE_OPEN_NEW_WINDOW_STORAGE_KEY))
  } catch {
    return false
  }
}

export function writeCodeOpenInNewWindowPreference(storage: CodePreferenceStorage, enabled: boolean): void {
  try {
    storage.setItem(CODE_OPEN_NEW_WINDOW_STORAGE_KEY, String(enabled))
  } catch {}
}

export function readCodeWorkspacePathPreference(storage: CodePreferenceStorage): string {
  try {
    return normalizeCodePath(storage.getItem(CODE_WORKSPACE_PATH_STORAGE_KEY)) || '/'
  } catch {
    return '/'
  }
}

export function writeCodeWorkspacePathPreference(storage: CodePreferenceStorage, path: string): string {
  const normalized = normalizeCodePath(path) || '/'
  try {
    storage.setItem(CODE_WORKSPACE_PATH_STORAGE_KEY, normalized)
  } catch {}
  return normalized
}

export function shouldOpenCodeInNewWindow(preferred: boolean, forceNewWindow = false): boolean {
  return forceNewWindow || preferred
}

export function resolveSessionCodeTarget(nodeId: unknown, cwd: unknown): CodeTarget {
  const normalizedNodeId = typeof nodeId === 'string' && /^[A-Za-z0-9._-]+$/.test(nodeId) ? nodeId : 'master'
  return { nodeId: normalizedNodeId, path: normalizeCodePath(cwd) || '/' }
}

export function makeCodeWorkspaceUri(target: CodeTarget): string {
  const path = normalizeCodePath(target.path)
  if (!/^[A-Za-z0-9._-]+$/.test(target.nodeId) || !path) {
    throw new Error('Code workspace target must use a valid node and an absolute POSIX path')
  }
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `foxwarm://node+${encodeURIComponent(target.nodeId)}${encodedPath || '/'}`
}

export function makeVscodeWebUrl(apiBasePath: string, origin: string, target?: CodeTarget, options: { embedded?: boolean; openFile?: CodeFileTarget; openCommit?: CodeCommitTarget } = {}): URL {
  const url = new URL(getVscodeWebPath(apiBasePath), origin)
  const usePersistentWorkspace = options.embedded || Boolean(options.openCommit)
  if (usePersistentWorkspace) url.searchParams.set('embedded', 'true')
  if (target && !options.openCommit) url.searchParams.set(usePersistentWorkspace ? 'initialFolderUri' : 'folderUri', makeCodeWorkspaceUri(target))
  if (options.openFile) {
    url.searchParams.set('openFilePath', options.openFile.path)
    url.searchParams.set('openFileNodeId', options.openFile.nodeId)
    if (options.openFile.startLine !== undefined) url.searchParams.set('startLine', String(options.openFile.startLine))
    if (options.openFile.endLine !== undefined) url.searchParams.set('endLine', String(options.openFile.endLine))
  }
  if (options.openCommit) {
    url.searchParams.set('openCommitPath', options.openCommit.path)
    url.searchParams.set('openCommitNodeId', options.openCommit.nodeId)
    url.searchParams.set('openCommitId', options.openCommit.commitId)
  }
  return url
}
