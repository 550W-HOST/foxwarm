// Runs only against an explicitly prepared, caller-owned Core publish directory.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as socketServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { waitForWebUiReady } from './webuiReadiness.mjs'
import { until } from './experimentHostFixture.mjs'

const payload = process.env.FOXWARM_PUBLISHED_CORE
assert(payload, 'Set FOXWARM_PUBLISHED_CORE to an owned complete Core publish directory.')
const dotnet = process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, 'dotnet') : 'dotnet'
const root = await mkdtemp(join(tmpdir(), 'foxwarm-published-'))
const data = join(root, 'selected data'), cwd = join(root, 'unrelated cwd')
await mkdir(join(data, 'state'), { recursive: true }); await mkdir(cwd)
const listener = socketServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
const port = listener.address().port; await new Promise(done => listener.close(done))
const origin = `http://127.0.0.1:${port}`
const listening = `Main HTTP listening: http://0.0.0.0:${port}`
// The pointer belongs to this owned installation, not the unrelated shell cwd.
await writeFile(join(payload, 'data_dir'), data)
await writeFile(join(data, 'state/config.yaml'), `bot:\n  httpPort: ${port}\nvector:\n  enabled: false\n`)
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('FOXWARM_') || ['CONFIG_PATH', 'MCP_CONFIG_PATH', 'ASPNETCORE_URLS'].includes(key)) delete env[key]
env.NODE_OPTIONS = ''
let child, output = '', browser, token, qualificationHistory, lastProviderReply, mainBrowserReached = false, browserErrors = []
function startHost() {
  output = ''
  child = spawn(dotnet, [join(payload, 'Foxwarm.dll')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
}
startHost()
const requests = []
const peer = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/browser-fixture') {
      mainBrowserReached = true
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Packaged browser</title><h1>Published Main browser fixture</h1>')
      return
    }
    if (request.method === 'GET') { response.writeHead(204).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const outputRows = requests.length === 1
      ? [{ type: 'function_call', call_id: 'packaged-toolscript', name: 'run_script', arguments: JSON.stringify({
        code: "skill = call_tool('skill', {'action':'load','skillName':'code-index'})\nresource = call_tool('read', {'filePath': args['resource']})\ncall_tool('write', {'filePath':'packaged-native-effect.txt','content':'native packaged worker'})\nreturn {'skill':skill,'resource':resource,'answer':6*7}\n",
        args: { resource: join(payload, 'skills/code-index/INITIALIZATION.md') },
      }) }]
      : requests.length === 2
      ? [{ type: 'function_call', call_id: 'packaged-browser-open', name: 'browse_open', arguments: JSON.stringify({ url: `http://127.0.0.1:${peer.address().port}/browser-fixture` }) }]
      : requests.length === 3
      ? [{ type: 'function_call', call_id: 'packaged-browser-image', name: 'browse_get', arguments: JSON.stringify({ tabId: 'tab1', screenshot: true }) }]
      : requests.length === 4
      ? [{ type: 'function_call', call_id: 'packaged-react-artifact', name: 'artifact', arguments: JSON.stringify({ action: 'publish', filePath: join(payload, 'skills/react-artifacts/examples/sorting.json') }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PACKAGED-NATIVE-DONE' }] }]
    lastProviderReply = outputRows[0].name || outputRows[0].type
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'published-' + requests.length, output: outputRows, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { browserErrors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
async function api(method, route, body) {
  const response = await fetch(origin + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
try {
  await until(() => { assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output); return output.split(/\r?\n/).includes(listening) }, 'published Core listening')
  token = (await readFile(join(data, 'state/token'), 'utf8')).trim()
  assert.equal((await api('GET', '/health')).body.status, 'ready')
  assert.deepEqual((await api('GET', '/api/sessions')).body.sessions, [])
  assert.equal(requests.length, 0)
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage(); page.on('pageerror', error => browserErrors.push(error.message))
  await page.goto(origin, { waitUntil: 'networkidle0' })
  await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', token); await page.click('button[type="submit"]')
  await waitForWebUiReady(page)
  assert.equal((await api('GET', '/api/setup/status')).body.oobe, true)
  assert.deepEqual((await api('GET', '/api/sessions')).body.sessions, [])
  assert.equal(requests.length, 0)
  assert((await readFile(join(data, 'agents/00_SYSTEM.md'), 'utf8')).length > 0)
  assert((await readdir(join(data, 'agents/main/memory'))).length > 0)
  const version = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8')).version
  assert.equal(execFileSync(process.execPath, [join(payload, 'scripts/foxwarm.js'), '--version'], { cwd, env, encoding: 'utf8' }).trim(), version)
  assert.equal(execFileSync(dotnet, [join(payload, 'Foxwarm.dll'), '--version'], { cwd, env, encoding: 'utf8' }).trim(), version)
  const exported = join(root, 'cli-export')
  const cli = JSON.parse(execFileSync(process.execPath, [join(payload, 'scripts/foxwarm.js'), 'archive', 'export-jsonl', '-o', exported], { cwd, env, encoding: 'utf8' }))
  assert.equal(cli.sessions.records, 0); assert.equal(cli.llm.records, 0)
  const archiveResponse = await fetch(origin + '/node/source.tar.gz')
  assert.equal(archiveResponse.status, 200)
  const archive = join(root, 'node.tar.gz'), extracted = join(root, 'node-source')
  await writeFile(archive, Buffer.from(await archiveResponse.arrayBuffer())); await mkdir(extracted)
  execFileSync('tar', ['-xzf', archive, '-C', extracted])
  const nodeHelp = execFileSync(process.execPath, [join(extracted, 'packages/cli-node/dist/tui.bundle.js'), '--help'], { cwd, encoding: 'utf8' })
  assert.match(nodeHelp, /Foxwarm cli-node/)
  const runtime = JSON.parse(await readFile(join(extracted, 'packages/cli-node-runtime/package.json'), 'utf8'))
  assert.equal(runtime.dependencies['node-pty'], '1.1.0')
  assert((await readFile(join(extracted, 'packages/shared/src/codeHelperIpc.ts'), 'utf8')).length > 0)
  for (const name of ['run.sh', 'run-interactive.sh', 'run.ps1']) assert.equal((await fetch(origin + '/node/' + name)).status, 200)
  for (const name of ['foxwarm-fs', 'foxwarm-scm', 'foxwarm-webui', 'foxwarm-terminal']) {
    const base = `/vscode-web/extensions/${name}/`
    assert.equal((await api('GET', base + 'package.json')).body.browser, './dist/extension.js')
    const bundle = await fetch(origin + base + 'dist/extension.js', { headers: { authorization: 'Bearer ' + token } })
    assert.equal(bundle.status, 200); assert((await bundle.text()).length > 0)
  }
  const models = JSON.stringify({ default: 'fixture', providers: { fixture: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], asyncCompact: false } } }, null, 2) + '\n'
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-models'); await page.click('#setup-tab-models')
  const editor = '[aria-label="Models YAML editor"] [role="textbox"]'
  await page.waitForSelector(editor)
  await page.evaluate(async value => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(name => /(?:\/|^)(?:monaco-editor|editor\.main)(?:-[^/]+)?\.js(?:\?|$)/.test(new URL(name).pathname))
    const imported = await import(moduleUrl), monaco = imported.a ?? imported.default ?? imported
    const editor = monaco.editor.getEditors().find(candidate => candidate.getModel()?.uri.toString() === 'inmemory://foxwarm/setup/foxwarm-models.yaml')
    if (!editor) throw Error('Original Models editor is missing')
    editor.getModel().setValue(value)
  }, models)
  const saved = page.waitForResponse(response => response.url().endsWith('/api/setup/models') && response.request().method() === 'POST')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save models')?.click())
  const saveResponse = await saved
  assert.equal(saveResponse.status(), 200, await saveResponse.text())
  await until(async () => (await readFile(join(data, 'state/models.yaml'), 'utf8').catch(() => '')).replaceAll('\r\n', '\n') === models, 'original setup saves model configuration')
  assert.equal((await api('GET', '/api/setup/status')).body.oobe, false)
  assert.equal(requests.length, 0)
  const created = await api('POST', '/api/sessions', {})
  assert.equal(created.status, 200)
  const id = created.body.sessionId
  assert(id, JSON.stringify(created))
  assert.equal((await api('POST', '/api/sessions/' + encodeURIComponent(id) + '/message', { text: 'Run the owned delivery qualification.' })).status, 202)
  // Cover the full scripted turn, including cold browser startup and artifact preparation.
  await until(async () => {
    qualificationHistory = (await api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history')).body
    return JSON.stringify(qualificationHistory).includes('PACKAGED-NATIVE-DONE')
  }, 'packaged native/browser/image/artifact turn', 60_000)
  assert.equal(requests.length, 5)
  assert.match(JSON.stringify(requests[2].input), /Tab opened: tab1/)
  assert.match(JSON.stringify(requests[3].input), /input_image/)
  const history = (await api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history')).body
  const artifactIds = [...new Set(JSON.stringify(history).match(/art_[a-f0-9]{32}/g) || [])]
  assert.equal(artifactIds.length, 1)
  const artifact = await api('GET', `/api/sessions/${encodeURIComponent(id)}/artifacts/${artifactIds[0]}/1`)
  assert.equal(artifact.status, 200)
  assert.equal(artifact.body.receipt.type, 'react')
  assert.match(artifact.body.compiled, /Insertion sort/)
  await page.evaluate(session => window.foxwarmTest.switchToSession(session), id)
  await page.waitForSelector('.artifact-run-placeholder')
  assert.equal(await page.$('.artifact-react iframe'), null)
  await page.click('.artifact-run-placeholder')
  await page.waitForFunction(() => !!document.querySelector('iframe[data-ready="true"]'), { timeout: 15000 })
  const authority = JSON.parse(await readFile(join(data, 'state/sessions', id + '.json'), 'utf8'))
  const image = authority.history.flatMap(row => row.parts || []).find(part => part.inlineDataRef && part.toolUseId === 'packaged-browser-image')
  assert(image, 'Canonical browser screenshot must retain its paired durable image reference')
  assert(!image.inlineData, 'Canonical history does not store inline screenshot bytes')
  const blob = '/api/blobs/' + image.inlineDataRef.blobId
  assert.equal((await fetch(origin + blob)).status, 401)
  const bytes = Buffer.from(await (await fetch(origin + blob, { headers: { authorization: 'Bearer ' + token } })).arrayBuffer())
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const effects = JSON.stringify(requests[1].input)
  assert.match(effects, /completed/); assert.match(effects, /42/); assert.match(effects, /Source: global/); assert.match(effects, /INITIALIZATION.md/)
  assert.equal(await readFile(join(data, 'agents/main/packaged-native-effect.txt'), 'utf8'), 'native packaged worker')
  assert(!(await readdir(join(data, 'state'))).includes('db'), 'Disabled Vector stays lazy')
  assert(!/lance[^\n]*\.so/i.test(await readFile(`/proc/${child.pid}/maps`, 'utf8')), 'Disabled Vector does not load its native library')
  assert.deepEqual(browserErrors, [])
  const exited = once(child, 'exit')
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  const [code, signal] = await exited
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, output)
  startHost()
  await until(() => { assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output); return output.split(/\r?\n/).includes(listening) }, 'restarted published Core listening')
  assert.equal((await readFile(join(data, 'state/token'), 'utf8')).trim(), token)
  assert.match(JSON.stringify((await api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history')).body), /PACKAGED-NATIVE-DONE/)
  assert.equal(await readFile(join(data, 'agents/main/packaged-native-effect.txt'), 'utf8'), 'native packaged worker')
  assert.equal(requests.length, 5, 'Restart must not replay a completed tool turn')
  const stopped = once(child, 'exit')
  child.kill('SIGTERM')
  const [restartCode, restartSignal] = await stopped
  assert.deepEqual({ code: restartCode, signal: restartSignal }, { code: 0, signal: null }, output)
  console.log(JSON.stringify({ published: true, collectedReactCompiler: true, originalArtifactRun: true, mainBrowserImage: true, restartPreserved: true, browserLogin: true, noModelSetup: true, implicitSessions: 0, nodeArchive: true, extensionBundles: 4, nativeToolScript: true, globalSkillResource: true, vectorDisabledLazy: true, requests: requests.length }))
} catch (error) {
  console.error('Published Core output:\n' + output)
  // Main's launch policy is independent of the browser used to drive the App.
  const mainBrowserExecutable = { path: '/usr/bin/chromium' }
  mainBrowserExecutable.present = await stat(mainBrowserExecutable.path).then(() => true, () => false)
  if (mainBrowserExecutable.present) {
    try {
      mainBrowserExecutable.version = execFileSync(mainBrowserExecutable.path, ['--version'], {
        env, encoding: 'utf8', timeout: 2000, maxBuffer: 8192, stdio: 'pipe',
      }).trim()
    } catch (versionError) {
      mainBrowserExecutable.versionError = String(versionError.stderr || versionError.message).trim().slice(0, 1000)
    }
  }
  const messages = qualificationHistory?.messages || []
  const responses = messages.flatMap(row => row.parts || []).map(part => part.functionResponse).filter(Boolean)
  const toolState = response => {
    if (!response) return undefined
    const result = response.response
    const failure = result?.error
    return {
      id: response.tool_use_id, name: response.name, status: result?.status || (failure ? 'error' : 'completed'),
      ...(failure ? { error: { type: failure.type, message: String(failure.message || failure).slice(0, 1500) } } : {}),
    }
  }
  const lastCall = messages.flatMap(row => row.parts || []).findLast(part => part.functionCall)?.functionCall
  const lastNotice = messages.findLast(row => row.__meta?.sessionNotice || row.__meta?.retry?.final)
  console.error('Published qualification diagnostics:\n' + JSON.stringify({
    providerRequests: requests.length, lastProviderReply, mainBrowserReached, mainBrowserExecutable,
    session: qualificationHistory?.session && {
      busy: qualificationHistory.session.busy,
      runtimeState: {
        state: qualificationHistory.session.runtimeState?.state,
        activePhase: qualificationHistory.session.runtimeState?.active?.phase,
        stopping: qualificationHistory.session.runtimeState?.stopping,
      },
    },
    lastCall: lastCall && { id: lastCall.id, name: lastCall.name },
    lastTool: toolState(responses.at(-1)),
    lastToolFailure: toolState(responses.findLast(response => response.response?.error || response.response?.status === 'failed')),
    lastNotice: lastNotice && {
      type: lastNotice.__meta.noticeType,
      text: lastNotice.parts?.map(part => part.text || '').join('').slice(0, 1500),
    },
    browserErrors: browserErrors.slice(-3).map(value => String(value).slice(0, 1500)),
  }, null, 2))
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}) }
  peer.closeAllConnections(); await new Promise(done => peer.close(done))
  await rm(join(payload, 'data_dir'), { force: true })
  await rm(root, { recursive: true, force: true })
}
