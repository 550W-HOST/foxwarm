import { useSyncExternalStore } from 'react'

export type WorkspaceMode = 'classic' | 'project'
export const WORKSPACE_MODE_KEY = 'foxwarm_workspace_mode_v1'
const WORKSPACE_MODE_CHANGED = 'foxwarm-workspace-mode-changed'
let memoryMode: WorkspaceMode = 'classic'

export function getWorkspaceMode(): WorkspaceMode {
  try { const stored = localStorage.getItem(WORKSPACE_MODE_KEY); return stored === 'project' || stored === 'classic' ? stored : memoryMode } catch { return memoryMode }
}

export function setWorkspaceMode(mode: WorkspaceMode): void {
  memoryMode = mode
  try { localStorage.setItem(WORKSPACE_MODE_KEY, mode) } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new Event(WORKSPACE_MODE_CHANGED))
}

function subscribe(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === WORKSPACE_MODE_KEY) callback() }
  window.addEventListener(WORKSPACE_MODE_CHANGED, callback)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(WORKSPACE_MODE_CHANGED, callback)
    window.removeEventListener('storage', onStorage)
  }
}

export function useWorkspaceMode(): WorkspaceMode {
  return useSyncExternalStore(subscribe, getWorkspaceMode, () => 'classic')
}
