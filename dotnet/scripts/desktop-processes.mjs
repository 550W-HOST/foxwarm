import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Windows process identity for the Desktop acceptance.
//
// Win32_Process.ParentProcessId is the PID the parent had when the process was created. Windows
// never updates it and reuses PIDs, so a process whose parent has exited, such as a build server
// left running by an earlier step, can name a newer, unrelated process as its parent, and a PID can
// later belong to a different process. A process is therefore identified by its PID and creation
// time, and a process is a child only of a process created no later than itself.

// One row per process: pid, ppid, image name, command line ('' when unreadable) and creation time
// as a fixed-width UTC ISO string, which orders as text (null for the idle process).
export async function listProcesses(run = promisify(execFile)) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; ' +
    'name = $_.Name; args = $_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') } else { $null } } } ' +
    '| ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 60_000, maxBuffer: 64 << 20 })
  return JSON.parse(stdout).map(row => ({ pid: row.pid, ppid: row.ppid, name: row.name || '', args: row.args || '', created: row.created }))
}

export const sameProcess = (a, b) => a.pid === b.pid && a.created === b.created

// The processes started, directly or through other descendants, by the running process `pid`.
export function processTree(rows, pid) {
  const root = rows.find(row => row.pid === pid)
  if (!root?.created) return []
  const found = []
  for (let parents = [root]; parents.length;) {
    const next = rows.filter(row => row.created && !found.some(seen => sameProcess(seen, row)) &&
      parents.some(parent => parent.pid === row.ppid && parent.created <= row.created))
    found.push(...next)
    parents = next
  }
  return found
}

// The captured processes that are still running.
export const survivors = (rows, captured) => captured.filter(row => rows.some(current => sameProcess(current, row)))

// One line per process for failure reports.
export function describeProcesses(captured, rows = []) {
  return captured.map(row => {
    const parent = rows.find(current => current.pid === row.ppid && current.created && current.created <= row.created)
    return `pid ${row.pid} ${row.name} started ${row.created}, parent ${row.ppid}${parent ? ` (${parent.name})` : ''}: ${row.args}`
  }).join('\n')
}
