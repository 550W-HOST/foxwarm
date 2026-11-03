// Temporary hosted diagnosis only: observe descendants of the fixture-owned Main.
import { open, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

async function prefix(path, limit = 4096) {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(limit)
    const { bytesRead } = await file.read(bytes, 0, limit, 0)
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}

async function endpoint(profile) {
  const result = { profile }
  try {
    const text = await prefix(join(profile, 'DevToolsActivePort'), 512)
    const [port, browserPath] = text.trim().split('\n')
    result.activePort = { port, browserPath }
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return result
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: 'error' })
    result.httpStatus = response.status
    const reader = response.body.getReader()
    let body = '', size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 4096) throw Error('Endpoint response exceeds 4096 bytes')
        body += Buffer.from(value).toString('utf8')
      }
    } finally { await reader.cancel().catch(() => {}) }
    const value = JSON.parse(body)
    result.version = { browser: value.Browser, webSocketDebuggerUrl: value.webSocketDebuggerUrl }
  } catch (error) { result.error = String(error.message).slice(0, 300) }
  return result
}

export async function observePublishedBrowser(mainPid) {
  const result = { at: new Date().toISOString(), mainPid, processes: [] }
  const pending = [mainPid], seen = new Set()
  while (pending.length && seen.size < 32) {
    const pid = pending.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    try {
      const base = `/proc/${pid}`
      const status = await prefix(join(base, 'stat'))
      const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
      const executable = await readlink(join(base, 'exe')).catch(() => null)
      const argv = (await prefix(join(base, 'cmdline'))).split('\0')
      // Never retain arbitrary command arguments (e.g. tool scripts or credentials).
      const flags = argv.filter(arg => /^--(?:user-data-dir|remote-debugging-port|headless)(?:=|$)/.test(arg)).slice(0, 8)
      const row = { pid, parentPid: Number(fields[1]), state: fields[0], executable, flags }
      result.processes.push(row)
      const profile = flags.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
      if (profile && flags.some(arg => arg.startsWith('--remote-debugging-port='))) row.endpoint = await endpoint(profile)
      // .NET may spawn on any thread; the main thread's children file alone misses it.
      const threads = (await readdir(join(base, 'task'))).slice(0, 256)
      for (const thread of threads) {
        const children = await readFile(join(base, 'task', thread, 'children'), 'utf8').catch(() => '')
        for (const child of children.trim().split(/\s+/)) if (/^\d+$/.test(child)) pending.push(Number(child))
      }
    } catch (error) { result.processes.push({ pid, error: String(error.message).slice(0, 300) }) }
  }
  result.truncated = pending.length > 0
  return result
}
