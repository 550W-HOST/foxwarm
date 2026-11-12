// macOS-only acceptance against an extracted Desktop ZIP. No checkout or user state is used.
// The native shell is observed through the Accessibility API (System Events), which the
// runner must allow for osascript; WKWebView offers no remote debugging protocol.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { runCleanup } from './desktop-cleanup.mjs'

const run = promisify(execFile)
assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64', 'macOS Desktop qualification requires Apple Silicon macOS')
assert.equal(process.argv.length, 4, 'Usage: node dotnet/scripts/qualify-desktop-mac-package.mjs EXTRACTED_APP REPORT_FILE')
const app = resolve(process.argv[2]), report = resolve(process.argv[3])
const repository = resolve(fileURLToPath(import.meta.url), '../../..')
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version
const resources = join(app, 'Contents/MonoBundle')
const plist = async key => (await run('plutil', ['-extract', key, 'raw', join(app, 'Contents/Info.plist')])).stdout.trim()

// Every load command of the executable must name a system library or a bundled .NET runtime library.
const SYSTEM_LIBRARY = /^\/(?:usr\/lib|System\/Library)\//
const RUNTIME_LIBRARY = /^@(?:rpath|executable_path|loader_path)\/(?:.*\/)?libSystem\.[A-Za-z.]+\.dylib$/
function unexpectedLibraries(otoolOutput) {
  return otoolOutput.split('\n').slice(1).map(line => line.trim().replace(/ \(compatibility version .*\)$/, ''))
    .filter(name => name && !SYSTEM_LIBRARY.test(name) && !RUNTIME_LIBRARY.test(name))
}

async function validateBundle() {
  assert.equal(await plist('CFBundleIdentifier'), 'net.foxwarm.desktop')
  assert.equal(await plist('CFBundleShortVersionString'), version)
  const executable = join(app, 'Contents/MacOS', await plist('CFBundleExecutable'))
  assert((await stat(executable)).mode & 0o111, 'The bundle executable is not executable')
  for (const file of [
    'webui-dist/index.html', 'packages/webui/login.html', 'templates/agents/00_SYSTEM.md', 'templates/models.example.yaml',
    'skills/code-index/SKILL.md', 'packages/cli-node/dist/client.bundle.js', 'lib/artifacts/managedPrepare.js',
    'ToolScript/native/monty', 'liblancedb_ffi.dylib', 'libfoxwarm-pty.dylib',
    'node_modules/esbuild/lib/main.js', 'node_modules/sharp/lib/index.js',
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node', 'foxwarm-pty-helper',
    'LICENSE.txt', 'LanceDB-LICENSE.txt', 'SkiaSharp-LICENSE.txt', 'ToolScript/MONTY-LICENSE',
    '../Resources/Foxwarm.icns', '../Resources/Foxwarm-icon-LICENSE.txt',
  ]) assert((await stat(join(resources, file))).size > 0, `Missing or empty bundle file: ${file}`)
  const contents = join(app, 'Contents')
  const files = (await readdir(contents, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => relative(contents, join(entry.parentPath, entry.name)))
  for (const file of files) {
    assert(!/\.(?:pdb|dll|pkg)$|\.dSYM(?:\/|$)/i.test(file), `Managed, debug or installer artifact in the NativeAOT bundle: ${file}`)
    assert(!/^MonoBundle\/(?:state|agents|workspace|logs|\.git|obj|bin)(?:\/|$)|(?:^|\/)(?:\.env|token|config\.yaml|models\.yaml)$/i.test(file), `Installation or build data in bundle: ${file}`)
  }
  await run('codesign', ['--verify', '--deep', '--strict', app])
  const linked = (await run('otool', ['-L', executable])).stdout
  assert.deepEqual(unexpectedLibraries(linked), [], 'The executable links bundled libraries:\n' + linked)
  // Bundled natives must not depend on the build machine's Homebrew installation.
  const natives = files.filter(file => /\.(?:dylib|node)$|(?:^|\/)(?:monty|esbuild)$/.test(file)).map(file => join(contents, file))
  const dependencies = (await run('otool', ['-L', executable, ...natives], { maxBuffer: 16 << 20 })).stdout
  assert(!/\/(?:opt\/homebrew|usr\/local)\/(?:opt|Cellar|lib)\//.test(dependencies), 'Bundled natives depend on Homebrew:\n' + dependencies)
  return { executable, linked: linked.split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean) }
}

// System Events reads the native window through the Accessibility API.
async function accessibility(script, ...args) {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', `function run(argv) {
    const matches = Application('System Events').processes.whose({ unixId: Number(argv[0]) })
    if (matches.length === 0) return JSON.stringify({ missing: true })
    const process = matches[0]
    ${script}
  }`, ...args.map(String)], { timeout: 120_000, maxBuffer: 16 << 20 })
  return JSON.parse(stdout)
}
const readWindow = pid => accessibility(`
    const windows = process.windows()
    const texts = []
    if (windows.length) for (const element of windows[0].entireContents()) {
      for (const read of ['name', 'description', 'value', 'title']) {
        try { const value = element[read](); if (typeof value === 'string' && value) texts.push(value) } catch (error) {}
      }
    }
    return JSON.stringify({ windows: windows.length, texts })`, pid)
const closeWindow = pid => accessibility(`
    process.windows[0].buttons.whose({ subrole: 'AXCloseButton' })[0].click()
    return 'true'`, pid)
const chooseQuit = pid => accessibility(`
    for (const item of process.menuBars[0].menuBarItems()) {
      const quit = item.menus[0].menuItems.whose({ name: 'Quit Foxwarm' })
      if (quit.length) { quit[0].click(); return 'true' }
    }
    throw new Error('Quit Foxwarm is not in the menu bar')`, pid)

// The Vector owner's pipe is a Unix socket under TMPDIR, whose path macOS limits to 104 bytes;
// the runner's per-user temporary directory plus this fixture's nesting would exceed it.
const root = await mkdtemp('/tmp/fwdm-')
const data = join(root, 'selected data'), cwd = join(root, 'unrelated cwd'), agents = join(root, 'configured agents')
await mkdir(join(data, 'state'), { recursive: true })
await mkdir(cwd)
await mkdir(join(root, 'tmp'))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('FOXWARM_') || ['CONFIG_PATH', 'MCP_CONFIG_PATH', 'ASPNETCORE_URLS', 'NODE_OPTIONS', 'DOTNET_ROOT'].includes(key)) delete env[key]
}
Object.assign(env, { FOXWARM_DATA_DIR: data, TMPDIR: join(root, 'tmp') + '/', SHELL: '/bin/bash' })
let child, exited, origin, token, executable, stage = 'bundle validation', requests = 0, embeddings = 0, acceptanceFailed = false
const sockets = [], failures = []
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
    const output = replied
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DESKTOP-NATIVE-DONE' }] }]
      : [{ type: 'function_call', call_id: 'desktop-native', name: 'run_script', arguments: JSON.stringify({
        code: "call_tool('write', {'filePath':'desktop-native-effect.txt','content':'packaged macOS Monty'})\ncall_tool('exec', {'summary':'Check packaged exec helper','command':\"printf 'packaged helper' > desktop-exec-effect.txt\"})\nreturn {'answer':6*7}\n",
      }) }]
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
    await new Promise(done => setTimeout(done, 500))
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
const processes = async () => (await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 << 20 })).stdout.split('\n')
  .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }))
async function descendants(pid) {
  const all = await processes(), found = []
  for (let parents = [pid]; parents.length;) {
    const next = all.filter(row => parents.includes(row.ppid))
    found.push(...next)
    parents = next.map(row => row.pid)
  }
  return found
}
const sql = async (statement, parameters = []) => JSON.parse((await run('python3', ['-c',
  'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))',
  join(data, 'state/archive-store.sqlite'), statement, JSON.stringify(parameters)])).stdout)
const mapped = async pid => (await run('lsof', ['-p', String(pid), '-Fn'], { maxBuffer: 16 << 20 })).stdout
const gone = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code !== 'ESRCH') throw error; return true } }

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
  // The web view navigates only to the owned origin. The original WebUI renders its application
  // (with the sidebar's "Open setup") only after /api/auth/session accepted the native cookie;
  // without it the page offers "Sign in again".
  let last
  const view = await until(async () => {
    last = await readWindow(child.pid)
    return last.texts?.includes('Open setup') ? last : null
  }, 'signed-in WebUI in the native window', 120_000).catch(error => {
    throw new Error(`${error.message}; last window: ${JSON.stringify(last)?.slice(0, 3000)}`)
  })
  console.log(`Native window: ${view.texts.length} accessible texts`)
  assert(!view.texts.some(text => text.includes('Sign in again')), 'The WebUI did not accept the native sign-in')
  assert(!view.texts.some(text => text.includes('Starting Foxwarm')), 'The startup label remains in the accessibility tree')
}
async function stopped(label) {
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Desktop did not exit after ${label}`)), 30_000); timer.unref() }),
  ])
  assert.equal(result.code, 0, `Desktop exit after ${label}: ${JSON.stringify(result)}`)
  child = undefined
}

const summary = { result: 'passed' }
try {
  ;({ executable, linked: summary.linkedLibraries } = await validateBundle())
  stage = 'artifact dependencies'
  // Resolve from the bundle, not the test runner's source dependencies.
  const require = createRequire(join(resources, 'package.json'))
  assert.match(require('esbuild').transformSync('const n: number = 42', { loader: 'ts' }).code, /42/)
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer()
  assert.equal((await require('sharp')(png).metadata()).width, 2)

  stage = 'Desktop startup and native sign-in'
  await start()
  const mainPid = child.pid
  assert.equal((await fetch(origin + '/api/auth/session')).status, 401)
  await access(join(agents, 'main/memory'))
  assert.equal((await api('GET', '/api/setup/status')).body.oobe, true)
  assert.match(await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8'), /Main HTTP listening:/)
  // Main loads its native libraries when a feature needs them, not at process start.
  assert(!/liblancedb_ffi|libvips/.test(await mapped(mainPid)), 'Main mapped LanceDB or libvips at startup')

  stage = 'packaged PTY'
  const created = await api('POST', '/api/terminals', { nodeId: 'master', cwd, cols: 80, rows: 24 })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const terminal = created.body.terminal
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/terminals/stream?terminalId=${encodeURIComponent(terminal.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  sockets.push(socket)
  let ready = false, output = ''
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString())
    if (event.type === 'ready') { ready = true; output += event.backlog || '' }
    if (event.type === 'output') output += event.data || ''
  })
  await once(socket, 'open')
  await until(() => ready, 'packaged terminal ready')
  socket.send(JSON.stringify({ type: 'resize', cols: 95, rows: 39 }))
  // Split the marker so that echoed input cannot satisfy it.
  socket.send(JSON.stringify({ type: 'input', data: "stty -echo; printf 'DESKTOP_%s\\n' PTY; stty size\n" }))
  await until(() => output.includes('DESKTOP_PTY') && output.includes('39 95'), 'packaged PTY input, output and resize')
  assert.equal((await api('DELETE', '/api/terminals/' + encodeURIComponent(terminal.id))).status, 200)
  await until(() => gone(terminal.pid), 'PTY shell ended and reaped')
  socket.terminate()

  stage = 'Setup save and native ToolScript turn'
  const models = JSON.stringify({ default: 'fixture', providers: { fixture: { providerType: 'openai-responses', baseUrl: provider, models: ['wire'], asyncCompact: false } } })
  assert.equal((await api('POST', '/api/setup/models', { yaml: models })).status, 200)
  assert.equal((await api('GET', '/api/setup/status')).body.oobe, false)
  const session = (await api('POST', '/api/sessions', {})).body.sessionId
  assert(session)
  const route = '/api/sessions/' + encodeURIComponent(session)
  assert.equal((await api('POST', route + '/message', { text: 'Run the owned desktop qualification.' })).status, 202)
  await until(async () => JSON.stringify((await api('GET', route + '/history')).body).includes('DESKTOP-NATIVE-DONE'), 'native ToolScript turn')
  assert.equal(await readFile(join(agents, 'main/desktop-native-effect.txt'), 'utf8'), 'packaged macOS Monty')
  assert.equal(await readFile(join(agents, 'main/desktop-exec-effect.txt'), 'utf8'), 'packaged helper')

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
  const vector = owned.filter(row => row.args.startsWith(executable + ' --foxwarm-vector-child'))
  assert.equal(vector.length, 1, 'Main must run exactly one packaged Vector child:\n' + JSON.stringify(owned))
  assert(/liblancedb_ffi/.test(await mapped(vector[0].pid)), 'The Vector child must own LanceDB')
  assert(!/liblancedb_ffi|libvips/.test(await mapped(mainPid)), 'Main must not load LanceDB or libvips')

  stage = 'menu Quit'
  const savedToken = token, savedOrigin = origin
  const savedModels = await readFile(join(data, 'state/models.yaml'), 'utf8')
  await chooseQuit(mainPid)
  await stopped('Quit Foxwarm')
  for (const row of owned) assert(gone(row.pid), `A Desktop child survived Quit: ${row.args}`)
  assert.match(await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8'), /Main stopped\./)

  stage = 'restart with retained data'
  await start()
  assert(origin === savedOrigin, 'Desktop did not retain its origin')
  assert(token === savedToken, 'Desktop did not retain its administrator token')
  assert.equal(await readFile(join(data, 'state/models.yaml'), 'utf8'), savedModels)
  assert(JSON.stringify((await api('GET', route + '/history')).body).includes('DESKTOP-NATIVE-DONE'))

  stage = 'second launch reopens the running window'
  await closeWindow(child.pid)
  await until(async () => (await readWindow(child.pid)).windows === 0, 'window closed while Main keeps running')
  assert.equal((await api('GET', '/health')).body.status, 'ready')
  const second = spawn(executable, [], { cwd, env, stdio: 'ignore' })
  const [secondExit] = await Promise.race([
    once(second, 'exit'),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('A second launch kept running')), 30_000); timer.unref() }),
  ])
  assert.equal(secondExit, 0)
  await until(async () => (await readWindow(child.pid)).windows === 1, 'running instance reopened its window', 30_000)

  stage = 'Main shutdown'
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  await stopped('Main shutdown')
  Object.assign(summary, {
    extractedApp: true, codesignVerified: true, nativeSignIn: true, startupLabelRemoved: true, setup: true,
    nativeToolScript: true, nativeExecHelper: true, ptyInputOutput: true, artifactDependencies: true, canonicalAgentRoot: true,
    vectorChild: true, mainLoadsNoLanceDb: true, menuQuit: true, restartPreserved: true, secondLaunchReopens: true, mainShutdown: true,
  })
  await writeFile(report, JSON.stringify(summary, null, 2) + '\n')
  console.log('Extracted macOS Desktop startup, native sign-in, ToolScript, Vector, Quit and restart acceptance passed.')
} catch (error) {
  acceptanceFailed = true
  // Keep diagnostics useful without uploading tokens, state or request bodies.
  await writeFile(report, JSON.stringify({ result: 'failed', stage }, null, 2) + '\n')
  // Main's own log carries no credentials; it records the failing component.
  const log = await readFile(join(data, 'state/logs/foxwarm.log'), 'utf8').catch(() => '')
  console.error('Main log (end):\n' + log.slice(-6000))
  if (child?.pid) console.error('Desktop processes:\n' + JSON.stringify(await descendants(child.pid).catch(() => [])))
  if (child && child.exitCode !== null) console.error('Desktop stderr:\n' + (await exited).stderr)
  throw error
} finally {
  await runCleanup([
    ['close sockets', () => { for (const socket of sockets) socket.terminate() }],
    ['end Desktop', async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        for (const row of await descendants(child.pid)) try { process.kill(row.pid, 'SIGKILL') } catch {}
        child.kill('SIGKILL')
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
