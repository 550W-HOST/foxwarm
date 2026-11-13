// Windows-only acceptance against an extracted ZIP. No checkout or user state is used.
// The window and notification icon are driven through dotnet/scripts/desktop-window.ps1, which
// needs the runner's interactive desktop and Explorer.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { validateDesktopPackage } from './validate-desktop-package.mjs'
import { missingImports } from '../../scripts/release/windows-imports.mjs'
import { killProcessTree, runCleanup } from './desktop-cleanup.mjs'
import { waitForWebUiReady } from '../../packages/webui/test/webuiReadiness.mjs'

assert.equal(process.platform, 'win32', 'Desktop runtime qualification requires Windows and WebView2')
assert.equal(process.argv.length, 4, 'Usage: node dotnet/scripts/qualify-desktop-package.mjs EXTRACTED_DIRECTORY REPORT_FILE')
const payload = resolve(process.argv[2]), report = resolve(process.argv[3])
const executable = join(payload, 'Foxwarm.Desktop.exe')
const run = promisify(execFile)
const windowScript = fileURLToPath(new URL('./desktop-window.ps1', import.meta.url))
// The Desktop's own window and notification icon, see desktop-window.ps1.
async function desktop(action, pid) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowScript,
    '-Action', action, '-ProcessId', String(pid)], { windowsHide: true, timeout: 60_000, maxBuffer: 16 << 20 })
  return JSON.parse(stdout.trim().split(/\r?\n/).pop())
}
const modules = async pid => (await desktop('modules', pid)).modules.map(name => name.toLowerCase())
async function processes() {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 60_000, maxBuffer: 64 << 20 })
  return JSON.parse(stdout).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, args: row.CommandLine || '' }))
}
async function descendants(pid) {
  const all = await processes(), found = []
  for (let parents = [pid]; parents.length;) {
    const next = all.filter(row => parents.includes(row.ppid) && !found.some(seen => seen.pid === row.pid))
    found.push(...next)
    parents = next.map(row => row.pid)
  }
  return found
}
const alive = async pid => (await processes()).some(row => row.pid === pid)
const sql = async (statement, parameters = []) => JSON.parse((await run('python', ['-c',
  'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))',
  join(data, 'state/archive-store.sqlite'), statement, JSON.stringify(parameters)], { windowsHide: true })).stdout)

const root = await mkdtemp(join(tmpdir(), 'foxwarm-desktop-'))
const data = join(root, 'selected data'), cwd = join(root, 'unrelated cwd')
const agents = join(root, 'configured agents')
await mkdir(join(data, 'state'), { recursive: true })
await mkdir(cwd)
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('FOXWARM_') || key.startsWith('WEBVIEW2_') || ['CONFIG_PATH', 'MCP_CONFIG_PATH', 'ASPNETCORE_URLS', 'NODE_OPTIONS'].includes(key)) delete env[key]
}
env.FOXWARM_DATA_DIR = data
// WebView2 chooses the debugging port and records it in the owned browser profile.
// Elevated Windows runners set the equivalent app-specific HKLM test policy because
// WebView2 ignores environment overrides at high integrity. Neither is shipped.
env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=0'
let child, exited, browser, origin, token, stage = 'package validation', requests = 0, embeddings = 0, acceptanceFailed = false
const failures = []
const peer = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') { response.writeHead(204).end(); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.url === '/v1/embeddings') {
      embeddings++
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: Array(1024).fill(0.01) })) }))
      return
    }
    requests++
    const replied = body.input.some(row => row.type === 'function_call_output' && row.call_id === 'desktop-native')
    const output = !replied
      ? [{ type: 'function_call', call_id: 'desktop-native', name: 'run_script', arguments: JSON.stringify({
        code: "call_tool('write', {'filePath':'desktop-native-effect.txt','content':'packaged Windows Monty'})\ncall_tool('exec', {'summary':'Check packaged exec helper','command':\"[IO.File]::WriteAllText('desktop-exec-effect.txt','packaged helper')\"})\nreturn {'answer':6*7}\n",
      }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DESKTOP-NATIVE-DONE' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: `desktop-${requests}`, output, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500).end() }
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
const provider = `http://127.0.0.1:${peer.address().port}`
await writeFile(join(data, 'state/config.yaml'), JSON.stringify({
  paths: { agentsDir: agents }, vector: { baseUrl: provider + '/v1' }, dbWorkers: true, vectorMaintenance: false,
}))
async function until(check, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (child) assert(child.exitCode === null && child.signalCode === null, `Desktop exited during ${label}`)
    assert.deepEqual(failures, [])
    const result = await check()
    if (result) return result
    await new Promise(done => setTimeout(done, 250))
  }
  throw new Error(`Timed out: ${label}`)
}
async function api(method, route, body) {
  const response = await fetch(origin + route, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
  }).catch(error => { throw new Error(`${method} ${route.split('?')[0]}: ${error.message}`) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
async function start() {
  child = spawn(executable, [], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000) })
  exited = new Promise(done => {
    child.once('exit', (code, signal) => done({ code, signal, stderr }))
    child.once('error', error => done({ error }))
  })
  await once(child, 'spawn')
  // Read only the fixture's state, which the ordinary Desktop entry creates.
  await until(async () => {
    const port = Number(await readFile(join(data, 'state/desktop-port'), 'utf8').catch(() => '0'))
    if (!port) return false
    origin = `http://127.0.0.1:${port}`
    token = (await readFile(join(data, 'state/token'), 'utf8')).trim()
    return (await api('GET', '/health').catch(() => null))?.body.status === 'ready'
  }, 'extracted Desktop loopback startup')
  let debugPort
  await until(async () => {
    const active = await readFile(join(data, 'webview2/EBWebView/DevToolsActivePort'), 'utf8').catch(() => '')
    debugPort = Number(active.split(/\r?\n/)[0])
    if (!debugPort) return false
    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    return version?.ok
  }, 'WebView2 debugging endpoint')
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null })
  let page
  await until(async () => {
    page = (await browser.pages()).find(candidate => candidate.url().startsWith(origin + '/'))
    return !!page
  }, 'embedded WebUI navigation')
  await waitForWebUiReady(page)
  const identity = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session')
    return { status: response.status, role: (await response.json()).role, visibleCookies: document.cookie }
  })
  assert.equal(identity.status, 200)
  assert.equal(identity.role, 'admin')
  assert(!identity.visibleCookies.includes('foxwarm_token'), 'Desktop authentication cookie must be HttpOnly')
  const cookies = await page.cookies()
  const auth = cookies.find(cookie => cookie.name === 'foxwarm_token')
  assert(auth?.httpOnly && auth.sameSite === 'Strict', 'Native WebView2 authentication cookie is missing')
  return page
}
async function stopped(label) {
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Desktop did not exit after ${label}`)), 60_000); timer.unref() }),
  ])
  assert.equal(result.code, 0, `Desktop exit after ${label}: ${JSON.stringify(result)}`)
  child = undefined
}
async function stop() {
  browser?.disconnect(); browser = undefined
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  await stopped('Main shutdown')
}
const summary = { result: 'passed' }
try {
  await validateDesktopPackage(payload)
  stage = 'imported DLLs'
  // Every DLL a packaged binary imports is beside it or part of Windows; the Visual C++ runtime is not.
  assert.deepEqual(missingImports(payload), [], 'The package lacks imported DLLs')
  stage = 'artifact dependencies'
  // Resolve from the package, not the test runner's source dependencies.
  const require = createRequire(join(payload, 'package.json'))
  assert.match(require('esbuild').transformSync('const n: number = 42', { loader: 'ts' }).code, /42/)
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  assert.equal((await require('sharp')(png).metadata()).width, 2)
  stage = 'Desktop startup and native WebView2 authentication'
  const page = await start()
  const mainPid = child.pid
  assert.equal((await fetch(origin + '/api/auth/session')).status, 401)
  await access(join(agents, 'main/memory'))
  assert.match(await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8'), /Main HTTP listening:/)

  stage = 'native process'
  // The NativeAOT executable hosts Main without CoreCLR; LanceDB loads only in the Vector child.
  const loaded = await modules(mainPid)
  for (const name of ['coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll', 'clrjit.dll']) assert(!loaded.includes(name), `Desktop loaded ${name}`)
  assert(!loaded.includes('lancedb_ffi.dll'), 'Main loaded LanceDB')
  assert(loaded.includes('microsoft.ui.xaml.dll') && loaded.includes('microsoft.web.webview2.core.dll'), 'WinUI and WebView2 are not loaded:\n' + loaded.join(', '))
  stage = 'notification icon and window'
  assert.equal((await desktop('tray', mainPid)).registered, true, 'Explorer has no Foxwarm notification icon')
  const shown = await desktop('window', mainPid)
  assert.equal(shown.visible, true)
  assert.match(shown.title, /Foxwarm/)
  assert.equal(await page.evaluate(() => new Promise((resolve, reject) => {
    const url = new URL('api/webui/stream', location.href)
    url.protocol = 'ws:'
    const socket = new WebSocket(url)
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket timeout')) }, 10000)
    socket.onmessage = event => {
      if (JSON.parse(event.data).type === 'connected') {
        clearTimeout(timer); socket.close(); resolve(true)
      }
    }
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('WebSocket failed')) }
  })), true)

  assert.equal((await api('GET', '/api/setup/status')).body.oobe, true)
  assert.deepEqual((await api('GET', '/api/sessions')).body.sessions, [])
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-models')
  for (const name of ['foxwarm-fs', 'foxwarm-scm', 'foxwarm-terminal', 'foxwarm-webui']) {
    const base = `/vscode-web/extensions/${name}/`
    assert.equal((await api('GET', base + 'package.json')).body.browser, './dist/extension.js')
    assert.equal((await api('GET', base + 'dist/extension.js')).status, 200)
  }
  assert.equal((await fetch(origin + '/node/run.ps1')).status, 200)
  stage = 'Setup save and native ToolScript turn'
  const models = JSON.stringify({ default: 'fixture', providers: { fixture: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], asyncCompact: false } } })
  assert.equal((await api('POST', '/api/setup/models', { yaml: models })).status, 200)
  assert.equal((await api('GET', '/api/setup/status')).body.oobe, false)
  const created = await api('POST', '/api/sessions', {})
  assert.equal(created.status, 200)
  const session = created.body.sessionId
  assert(session)
  const route = '/api/sessions/' + encodeURIComponent(session)
  assert.equal((await api('POST', route + '/message', { text: 'Run the owned desktop qualification.' })).status, 202)
  await until(async () => JSON.stringify((await api('GET', route + '/history')).body).includes('DESKTOP-NATIVE-DONE'), 'native ToolScript turn')
  assert.equal(requests, 2)
  assert.equal(await readFile(join(agents, 'main/desktop-native-effect.txt'), 'utf8'), 'packaged Windows Monty')
  assert.equal(await readFile(join(agents, 'main/desktop-exec-effect.txt'), 'utf8'), 'packaged helper')
  assert.equal((await api('POST', '/api/agents', { agentId: 'research' })).status, 201)
  await access(join(agents, 'research'))

  stage = 'Vector child indexing and search'
  // 8000 or more tokens make indexing start at once rather than after minutes.
  assert.equal((await api('POST', route + '/message', { text: 'desktop-index-marker ' + 'v'.repeat(40000) })).status, 202)
  await until(async () => !(await api('GET', route + '/history')).body.session.busy, 'large exchange committed')
  await until(async () => (await sql('SELECT raw_last_indexed_seq FROM archive_checkpoints WHERE session_id=?', [session]))[0]?.[0] >= 1,
    'committed messages indexed by the Vector child', 180_000)
  await until(async () => {
    const found = await api('GET', '/api/history/search?query=desktop&sessionId=' + encodeURIComponent(session))
    assert(found.status === 200 || found.body.code === 'VECTOR_UNAVAILABLE', JSON.stringify(found))
    return found.status === 200 && found.body.results.length > 0
  }, 'indexed history search results', 180_000)
  assert(embeddings > 0, 'The Vector child must request embeddings')
  const owned = await descendants(mainPid)
  const vector = owned.filter(row => row.args.includes('--foxwarm-vector-child') && row.args.toLowerCase().includes('foxwarm.desktop.exe'))
  assert.equal(vector.length, 1, 'Main must run exactly one packaged Vector child:\n' + JSON.stringify(owned))
  assert((await modules(vector[0].pid)).includes('lancedb_ffi.dll'), 'The Vector child must own LanceDB')
  assert(!(await modules(mainPid)).includes('lancedb_ffi.dll'), 'Main must not load LanceDB')

  stage = 'close to the notification area and reopen'
  await desktop('close', mainPid)
  await until(async () => !(await desktop('window', mainPid)).visible, 'window hidden by close')
  assert.equal((await api('GET', '/health')).body.status, 'ready', 'Main must keep running while the window is hidden')
  assert.equal((await desktop('tray', mainPid)).registered, true, 'The notification icon must stay while the window is hidden')
  await desktop('open', mainPid)
  await until(async () => (await desktop('window', mainPid)).visible, 'window reopened from the notification icon')

  stage = 'notification icon Exit'
  const savedToken = token, savedOrigin = origin
  const savedModels = await readFile(join(data, 'state/models.yaml'), 'utf8')
  browser?.disconnect(); browser = undefined
  const children = await descendants(mainPid)
  const menu = await desktop('exit', mainPid)
  assert.deepEqual(menu.items, ['Open', 'Exit'])
  await stopped('the notification icon Exit item')
  assert.match(await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8'), /Main stopped\./)
  await until(async () => {
    for (const row of children) if (await alive(row.pid) && !/msedgewebview2\.exe/i.test(row.args)) return false
    return true
  }, 'Desktop child processes ended', 30_000)

  stage = 'restart with retained data'
  await start()
  assert(origin === savedOrigin, 'Desktop did not retain its origin')
  assert(token === savedToken, 'Desktop did not retain its administrator token')
  assert.equal(await readFile(join(data, 'state/models.yaml'), 'utf8'), savedModels)
  assert(JSON.stringify((await api('GET', route + '/history')).body).includes('DESKTOP-NATIVE-DONE'))
  stage = 'Main shutdown'
  await stop()
  Object.assign(summary, {
    extractedDesktop: true, importsComplete: true, noCoreClr: true, nativeWebView2Cookie: true, setup: true, nativeToolScript: true,
    nativeExecHelper: true, canonicalAgentRoot: true, configuredAgentRoot: true, webSocketCookie: true, artifactDependencies: true,
    extensionBundles: 4, vectorChild: true, mainLoadsNoLanceDb: true, trayIcon: true, closeToTray: true, trayOpen: true, trayExit: true,
    restartPreserved: true, mainShutdown: true,
  })
  await writeFile(report, JSON.stringify(summary, null, 2) + '\n')
  console.log('Extracted native Desktop startup, WebView2, ToolScript, Vector, notification icon, Exit and restart acceptance passed.')
} catch (error) {
  acceptanceFailed = true
  // Keep diagnostics useful without uploading tokens, state, profiles or request bodies.
  await writeFile(report, JSON.stringify({ result: 'failed', stage }, null, 2) + '\n')
  // Main's own log carries no credentials; it records the failing component.
  const log = await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8').catch(() => '')
  console.error('Main log (end):\n' + log.slice(-6000))
  if (child && child.exitCode !== null) console.error('Desktop exit:\n' + JSON.stringify(await exited))
  throw error
} finally {
  // Each step runs even if another fails, and none replaces the acceptance error.
  await runCleanup([
    ['disconnect the browser', () => browser?.disconnect()],
    ['end Desktop', async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        killProcessTree(child)
        await exited
      }
    }],
    ['close the model fixture', async () => {
      peer.closeAllConnections()
      await new Promise(done => peer.close(done))
    }],
    ['remove the temporary directory', () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })],
  ], acceptanceFailed)
}
