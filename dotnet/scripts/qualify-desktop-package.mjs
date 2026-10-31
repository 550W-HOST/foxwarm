// Windows-only acceptance against an extracted ZIP. No checkout or user state is used.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { validateDesktopPackage } from './validate-desktop-package.mjs'
import { waitForWebUiReady } from '../../packages/webui/test/webuiReadiness.mjs'

assert.equal(process.platform, 'win32', 'Desktop runtime qualification requires Windows and WebView2')
assert.equal(process.argv.length, 4, 'Usage: node dotnet/scripts/qualify-desktop-package.mjs EXTRACTED_DIRECTORY REPORT_FILE')
const payload = resolve(process.argv[2]), report = resolve(process.argv[3])
const root = await mkdtemp(join(tmpdir(), 'foxwarm-desktop-'))
const data = join(root, 'selected data'), cwd = join(root, 'unrelated cwd')
await mkdir(join(data, 'state'), { recursive: true })
await mkdir(cwd)
await writeFile(join(data, 'state/config.yaml'), 'vector:\n  enabled: false\n')
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('FOXWARM_') || key.startsWith('WEBVIEW2_') || ['CONFIG_PATH', 'MCP_CONFIG_PATH', 'ASPNETCORE_URLS', 'NODE_OPTIONS'].includes(key)) delete env[key]
}
env.FOXWARM_DATA_DIR = data
// WebView2 chooses the debugging port and records it in the owned browser profile.
// Elevated Windows runners set the equivalent app-specific HKLM test policy because
// WebView2 ignores environment overrides at high integrity. Neither is shipped.
env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=0'
let child, exited, browser, origin, token, stage = 'package validation', requests = 0
const peer = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') { response.writeHead(204).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    JSON.parse(body)
    requests++
    assert(requests <= 2, 'Unexpected extra model request')
    const output = requests === 1
      ? [{ type: 'function_call', call_id: 'desktop-native', name: 'run_script', arguments: JSON.stringify({
        code: "call_tool('write', {'filePath':'desktop-native-effect.txt','content':'packaged Windows Monty'})\nreturn {'answer':6*7}\n",
      }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DESKTOP-NATIVE-DONE' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: `desktop-${requests}`, output, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch { response.writeHead(500).end() }
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
async function until(check, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (child) assert(child.exitCode === null && child.signalCode === null, `Desktop exited during ${label}`)
    if (await check()) return
    await new Promise(done => setTimeout(done, 250))
  }
  throw new Error(`Timed out: ${label}`)
}
async function api(method, route, body) {
  const response = await fetch(origin + route, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
async function start() {
  child = spawn(join(payload, 'Foxwarm.Desktop.exe'), [], { cwd, env, stdio: 'ignore' })
  exited = new Promise(done => {
    child.once('exit', (code, signal) => done({ code, signal }))
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
async function stop() {
  browser?.disconnect(); browser = undefined
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Desktop did not exit after ordinary shutdown')), 30_000); timer.unref() }),
  ])
  assert.equal(result.code, 0)
  child = undefined
}
try {
  await validateDesktopPackage(payload)
  stage = 'artifact dependencies'
  // Resolve from the package, not the test runner's source dependencies.
  const require = createRequire(join(payload, 'package.json'))
  assert.match(require('esbuild').transformSync('const n: number = 42', { loader: 'ts' }).code, /42/)
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  assert.equal((await require('sharp')(png).metadata()).width, 2)
  stage = 'Desktop startup and native WebView2 authentication'
  const page = await start()
  assert.equal((await fetch(origin + '/api/auth/session')).status, 401)
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
  assert.equal(await readFile(join(root, 'workspace/desktop-native-effect.txt'), 'utf8'), 'packaged Windows Monty')
  const savedToken = token, savedOrigin = origin
  const savedModels = await readFile(join(data, 'state/models.yaml'), 'utf8')
  stage = 'ordinary shutdown and restart'
  await stop()
  await start()
  assert(origin === savedOrigin, 'Desktop did not retain its origin')
  assert(token === savedToken, 'Desktop did not retain its administrator token')
  assert.equal(await readFile(join(data, 'state/models.yaml'), 'utf8'), savedModels)
  assert(JSON.stringify((await api('GET', route + '/history')).body).includes('DESKTOP-NATIVE-DONE'))
  await stop()
  await writeFile(report, JSON.stringify({ result: 'passed', extractedDesktop: true, nativeWebView2Cookie: true, setup: true, nativeToolScript: true, artifactDependencies: true, extensionBundles: 4, restartPreserved: true, vectorEnabled: false }, null, 2) + '\n')
  console.log('Extracted Desktop startup, WebView2, native ToolScript and restart acceptance passed.')
} catch (error) {
  // Keep diagnostics useful without uploading tokens, state, profiles or request bodies.
  await writeFile(report, JSON.stringify({ result: 'failed', stage }, null, 2) + '\n')
  throw error
} finally {
  browser?.disconnect()
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await exited
  }
  peer.closeAllConnections()
  await new Promise(done => peer.close(done))
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
}
