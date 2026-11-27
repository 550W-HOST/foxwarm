import { API_BASE_PATH } from './config'

/** One running terminal as listed by `/terminals`, across Nodes. */
export type TerminalRegistryRecord = {
  id: string
  cwd: string
  nodeId: string
  shell: string
  pid: number
  createdAt: number
}

export function parseTerminalRegistry(data: unknown): TerminalRegistryRecord[] {
  const rows = data && typeof data === 'object' && Array.isArray((data as { terminals?: unknown }).terminals)
    ? (data as { terminals: unknown[] }).terminals
    : []
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const value = row as Record<string, unknown>
    if (typeof value.id !== 'string' || !value.id) return []
    return [{
      id: value.id,
      cwd: typeof value.cwd === 'string' && value.cwd ? value.cwd : '/',
      nodeId: typeof value.nodeId === 'string' && value.nodeId ? value.nodeId : 'master',
      shell: typeof value.shell === 'string' ? value.shell : '',
      pid: typeof value.pid === 'number' ? value.pid : 0,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    }]
  })
}

/** Program name of a shell path on either path convention: `/bin/bash` and `C:\…\pwsh.exe` give `bash` and `pwsh`. */
export function terminalShellName(shell: string): string {
  const name = shell.trim().split(/[\\/]/).filter(Boolean).pop() || ''
  return name.replace(/\.exe$/i, '')
}

/** Compact age of a terminal for list rows: `now`, `5m`, `3h`, `2d`. */
export function formatTerminalAge(createdAt: number, now: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function terminalKillConfirmation(terminal: { cwd?: string; nodeId?: string }): string {
  const where = [terminal.cwd, terminal.nodeId ? `on ${terminal.nodeId}` : ''].filter(Boolean).join(' ')
  return `Kill the terminal${where ? ` in ${where}` : ''}? Programs running in it will stop.`
}

/** Ends a terminal's process. A terminal that is already gone counts as ended. */
export async function requestTerminalKill(terminalId: string): Promise<void> {
  const response = await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' })
  if (response.ok || response.status === 404) return
  const data = await response.json().catch(() => ({}))
  throw new Error(typeof data.error === 'string' && data.error ? data.error : `Failed to kill terminal (${response.status})`)
}
