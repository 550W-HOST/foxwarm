export const VSCODE_WEB_TAB_ID = 'vscode-web'
export const CODE_OPEN_NEW_WINDOW_STORAGE_KEY = 'foxwarm_code_open_new_window_v1'
export const CODE_WORKSPACE_PATH_STORAGE_KEY = 'foxwarm_code_workspace_path_v1'
export const CODE_BRIDGE_CHANNEL = 'foxwarm-code-bridge'
export const CODE_BRIDGE_VERSION = 1

export interface CodeTarget {
  nodeId: 'master'
  path: string
}

export type CodeOpenRequest =
  | { kind: 'addFolder'; nodeId: 'master'; path: string }
  | { kind: 'openFile'; nodeId: 'master'; path: string; startLine?: number; endLine?: number }

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
  if (nodeId !== undefined && nodeId !== null && nodeId !== '' && nodeId !== 'master') return null
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
    nodeId: 'master',
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
  const path = nodeId === 'master' || nodeId == null || nodeId === ''
    ? normalizeCodePath(cwd)
    : null
  return { nodeId: 'master', path: path || '/' }
}

export function makeCodeWorkspaceUri(target: CodeTarget): string {
  const path = normalizeCodePath(target.path)
  if (target.nodeId !== 'master' || !path) {
    throw new Error('Code workspace target must use master and an absolute POSIX path')
  }
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `foxwarm://node+master${encodedPath || '/'}`
}

export function makeVscodeWebUrl(apiBasePath: string, origin: string, target?: CodeTarget, options: { embedded?: boolean; openFile?: CodeFileTarget } = {}): URL {
  const url = new URL(getVscodeWebPath(apiBasePath), origin)
  if (options.embedded) url.searchParams.set('embedded', 'true')
  if (target) url.searchParams.set(options.embedded ? 'initialFolderUri' : 'folderUri', makeCodeWorkspaceUri(target))
  if (options.openFile) {
    url.searchParams.set('openFilePath', options.openFile.path)
    if (options.openFile.startLine !== undefined) url.searchParams.set('startLine', String(options.openFile.startLine))
    if (options.openFile.endLine !== undefined) url.searchParams.set('endLine', String(options.openFile.endLine))
  }
  return url
}
