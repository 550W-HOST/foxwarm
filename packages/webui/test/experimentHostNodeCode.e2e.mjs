// Owned .NET hosts, unchanged official CLI services, original WebUI, and optional official Code assets.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const normalRuntime = process.env.FOXWARM_TEST_MAIN_RUNTIME
const sourceMain = normalRuntime === 'source'
const workbenchDir = sourceMain ? resolve('packages/vscode-web/assets/vscode-web') : resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web')
const hasCode = await access(join(workbenchDir, 'out/vs/workbench/workbench.web.main.internal.js')).then(() => true, () => false)
const options = { onPage: page => page.setViewport({ width: 1440, height: 1000 }), ...(normalRuntime ? { runtime: normalRuntime, normalStartup: true } : {}), env: {} }
const fixture = await createHostFixture('node-code', options)
if (normalRuntime) {
  Object.assign(options.env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '' })
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: terminal-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
}
const home = join(fixture.root, 'home'), runtime = join(fixture.root, 'cli'), repo = join(runtime, 'repository')
for (const path of [home, runtime, repo]) await mkdir(path, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Node Code Fixture'); git('config', 'user.email', 'fixture@example.invalid')
await writeFile(join(repo, 'notes.txt'), 'first\nselected second\nselected third\nlast\n')
git('add', '.'); git('commit', '-qm', 'remote root fixture'); const rootCommit = git('rev-parse', 'HEAD')
git('mv', 'notes.txt', 'renamed.txt'); await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 255])); git('add', '.'); git('commit', '-qm', 'remote rename and binary')
const commit = git('rev-parse', 'HEAD'); await writeFile(join(repo, 'renamed.txt'), 'first\nselected second\nselected third\nworking\n')
await writeFile(join(repo, 'spaces 雪.txt'), 'first\nsecond\nthird\n')
const wire = [], errors = [], connections = [], nodeSockets = new Set(), peers = []
const proxyServer = createServer(), proxy = new WebSocketServer({ server: proxyServer, maxPayload: 75 * 1024 * 1024 })
proxyServer.listen(0, '127.0.0.1'); await once(proxyServer, 'listening')
const nodeHost = `http://127.0.0.1:${proxyServer.address().port}`
proxy.on('connection', (downstream, request) => {
  const upstream = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url, { maxPayload: 75 * 1024 * 1024 }), waiting = []
  const connection = { downstream, upstream }; connections.push(connection); nodeSockets.add(downstream); nodeSockets.add(upstream)
  upstream.on('open', () => { for (const text of waiting) upstream.send(text) })
  downstream.on('message', bytes => {
    const text = bytes.toString(), value = JSON.parse(text); wire.push({ direction: 'reply', ...value, result: value.result?.contentBase64 ? { bytes: value.result.contentBase64.length } : value.result })
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else waiting.push(text)
  })
  upstream.on('message', bytes => {
    const value = JSON.parse(bytes); wire.push({ direction: 'request', ...value, args: value.args?.contentBase64 ? { ...value.args, contentBase64: `[${value.args.contentBase64.length} bytes]` } : value.args })
    if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes.toString())
  })
  for (const [source, target] of [[downstream, upstream], [upstream, downstream]]) {
    source.on('close', () => { nodeSockets.delete(source); if (target.readyState === WebSocket.OPEN) target.close() })
    source.on('error', () => {})
  }
})
let cli, cliOutput = '', modelRound = 0, page, masterWorkspaceWrite
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), round = modelRound++
    const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
    const output = round === 0 ? [call('select-code', 'node', { action: 'select', nodeId: 'official-code' })]
      : round === 1 ? [call('read-code', 'read', { filePath: join(repo, 'renamed.txt'), startLine: 2, endLine: 3 }), call('read-ambiguous', 'read', { filePath: '~/not-present.txt' })]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `NODE-CODE-DONE\n\n<foxwarm-commit node="official-code" path="${repo}" id="${commit}" />` }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
async function credential(nodeId) {
  if (!sourceMain) {
    const reply = await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId }); assert.equal(reply.status, 200); return reply.body
  }
  const reply = await fixture.api('POST', '/api/nodes/onboarding/create-shell', { nodeId, baseUrl: fixture.origin }); assert.equal(reply.status, 200)
  const token = /NODE_AUTH_TOKEN='([^']+)'/.exec(reply.body.command)?.[1]; assert(token)
  return { nodeId, authToken: token }
}
const nodes = async () => (await fixture.api('GET', '/api/nodes')).body.nodes
const online = () => until(async () => (await nodes()).find(row => row.id === 'official-code' && row.online), 'official CLI service connection', 40000)
const fsUrl = (operation, path) => '/api/vscode-web/fs/' + operation + '?nodeId=official-code&path=' + encodeURIComponent(path)
async function rawApi(method, path, bytes) {
  const response = await fetch(fixture.origin + path, { method, headers: { authorization: 'Bearer ' + fixture.token }, ...(bytes === undefined ? {} : { body: bytes }) })
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
}
const get = (operation, path) => fixture.api('GET', fsUrl(operation, path))
const ptyRequests = () => wire.filter(row => row.type === 'node_service_request' && row.service === 'vscode-pty')
async function terminal(nodeId = 'official-code') {
  const result = await fixture.api('POST', '/api/terminals', { nodeId, cwd: repo, cols: 100, rows: 30 }); assert.equal(result.status, 200, JSON.stringify(result)); assert(result.body.terminal.pid > 0); return result.body.terminal
}
async function attachBrowser(key, id, codeControl = false) {
  await page.evaluate(async ({ key, id, codeControl }) => {
    window.nodeCodeClients ||= {}
    const url = new URL('/api/terminals/stream', location.href); url.protocol = 'ws:'; url.searchParams.set('terminalId', id); if (codeControl) url.searchParams.set('control', 'code')
    const state = { events: [], closed: false, socket: new WebSocket(url) }; window.nodeCodeClients[key] = state
    state.socket.onmessage = event => state.events.push(JSON.parse(event.data)); state.socket.onclose = () => { state.closed = true }
    await new Promise((resolve, reject) => { state.socket.onopen = resolve; state.socket.onerror = reject })
  }, { key, id, codeControl })
  await until(() => page.evaluate(key => window.nodeCodeClients[key].events.some(event => event.type === 'ready'), key), 'browser PTY ready ' + key)
}
const events = key => page.evaluate(key => window.nodeCodeClients[key].events, key)
const input = (key, text) => page.evaluate(({ key, text }) => window.nodeCodeClients[key].socket.send(JSON.stringify({ type: 'input', data: text })), { key, text })
const output = async key => (await events(key)).filter(row => row.type === 'output').map(row => row.data).join('')
const live = id => fixture.api('GET', '/api/terminals/' + encodeURIComponent(id))
async function palette(frame, command) {
  await frame.click('.monaco-workbench'); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await frame.waitForSelector('.quick-input-widget input'); await frame.type('.quick-input-widget input', command); await page.keyboard.press('Enter')
}
const codeFrame = () => until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname.endsWith('/vscode-web/') && frame.parentFrame() === page.mainFrame()), 'original embedded official workbench', 30000)
try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  const approval = await credential('official-code')
  const cliExecutable = process.env.FOXWARM_CLI_EXECUTABLE
  cli = spawn(cliExecutable || process.execPath, [...(cliExecutable ? [] : [resolve('packages/cli-node/dist/client.js')]), '--host', nodeHost, '--id', 'official-code', '--auth-token', approval.authToken, '--credentials-file', join(runtime, 'credentials.json'), '--no-local-trigger'], { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolatedApplicationEnv(join(runtime, 'data')), HOME: home, FOXWARM_AGENTS_DIR: join(runtime, 'agents') } })
  for (const stream of [cli.stdout, cli.stderr]) stream.on('data', bytes => { cliOutput = (cliOutput + bytes).slice(-20000) })
  const node = await online(); assert.equal(node.services['vscode-fs'], 1); assert.equal(node.services['vscode-git'], 2); assert.equal(node.services['vscode-pty'], 1, cliOutput)
  // Real fixed filesystem and read-only Git APIs do not borrow model Session identity.
  assert.equal((await get('stat', repo)).body.type, 2)
  assert((await get('read-directory', repo)).body.entries.some(row => row.name === 'renamed.txt'))
  assert.equal((await rawApi('GET', fsUrl('read-file', join(repo, 'renamed.txt')))).bytes.toString(), await readFile(join(repo, 'renamed.txt'), 'utf8'))
  const directory = join(runtime, 'api-directory'); assert.equal((await fixture.api('POST', fsUrl('create-directory', directory), {})).status, 200)
  const binary = join(directory, '中文 file.bin'), bytes = Buffer.from([0, 1, 255, 128])
  assert.equal((await rawApi('PUT', fsUrl('write-file', binary) + '&create=1', bytes)).status, 200)
  assert.deepEqual((await rawApi('GET', fsUrl('read-file', binary))).bytes, bytes)
  assert.equal((await rawApi('PUT', fsUrl('write-file', binary) + '&create=1', Buffer.from('no'))).status, 409); assert.deepEqual(await readFile(binary), bytes)
  const renamed = join(directory, 'new.bin'); assert.equal((await fixture.api('POST', '/api/vscode-web/fs/rename', { nodeId: 'official-code', oldPath: binary, newPath: renamed })).status, 200)
  assert.equal((await fixture.api('POST', fsUrl('delete', directory), { recursive: true })).status, 200); assert(!await access(directory).then(() => true, () => false))
  const boundary = join(runtime, 'boundary.bin'), large = Buffer.alloc(50 * 1024 * 1024, 0x92)
  assert.equal((await rawApi('PUT', fsUrl('write-file', boundary) + '&create=1', large)).status, 200)
  assert.deepEqual((await rawApi('GET', fsUrl('read-file', boundary))).bytes, large)
  const beforeOversize = wire.filter(row => row.type === 'node_service_request' && row.operation === 'write-file').length
  assert.equal((await rawApi('PUT', fsUrl('write-file', boundary) + '&overwrite=1', Buffer.alloc(large.length + 1))).status, 413)
  assert.equal(wire.filter(row => row.type === 'node_service_request' && row.operation === 'write-file').length, beforeOversize)
  const gitUrl = operation => '/api/vscode-web/git/' + operation + '?nodeId=official-code&workspace=' + encodeURIComponent(repo)
  const status = (await fixture.api('GET', gitUrl('status'))).body; assert.equal(status.topLevel, repo); assert(status.changes.some(row => row.path === 'renamed.txt'))
  const details = (await fixture.api('GET', gitUrl('commit') + '&id=' + commit)).body; assert.equal(details.nodeId, 'official-code'); assert.equal(details.commit.oid, commit); assert(details.files.some(row => row.kind === 'renamed')); assert(details.files.some(row => row.binary))
  assert.equal((await fixture.api('GET', gitUrl('commit') + '&id=' + rootCommit)).body.comparison.mode, 'empty-tree')
  assert.equal((await rawApi('GET', gitUrl('content') + '&path=renamed.txt&ref=' + commit)).bytes.toString(), 'first\nselected second\nselected third\nlast\n')
  assert.equal((await fixture.api('GET', gitUrl('commit') + '&id=HEAD')).status, 422); assert.equal(git('rev-parse', 'HEAD'), commit)
  // Unsupported versions reject before any service request; no Master fallback for matching local paths.
  const oldCredential = await credential('old-services')
  const old = new WebSocket(fixture.origin.replace(/^http/, 'ws') + `/node_ws?id=old-services&auth=${oldCredential.authToken}`); peers.push(old); await once(old, 'open')
  old.send(JSON.stringify({ type: 'node_register', nodeType: 'protocol-fixture', capabilities: { tools: [], services: { 'vscode-git': 1 } }, nodeProtocol: { min: 1, max: 3 } })); await once(old, 'message')
  assert.equal((await fixture.api('GET', gitUrl('commit').replace('official-code', 'old-services') + '&id=' + commit)).status, 501)
  assert.equal((await fixture.api('GET', fsUrl('read-file', boundary).replace('official-code', 'old-services'))).status, 501)
  assert.equal((await fixture.api('POST', '/api/terminals', { nodeId: 'old-services', cwd: repo })).status, sourceMain ? 400 : 501)
  assert.equal((await fixture.api('POST', '/api/sessions/main/cwd', { cwd: repo })).status, 200)
  page = await fixture.openApp()
  page.on('pageerror', error => errors.push(error.stack))
  page.on('console', message => { if (message.type() === 'error') wire.push({ browserError: message.text() }) })
  page.on('request', request => { if (request.url().includes('/terminals')) wire.push({ browserRequest: request.url(), method: request.method(), body: request.postData() }) })
  const remote = await terminal(), id = remote.id
  await attachBrowser('owner', id, true); await attachBrowser('second', id, !sourceMain)
  assert.equal(ptyRequests().filter(row => row.operation === 'attach' && row.args.terminalId === id).length, 1)
  // An independently authenticated advertised peer cannot inject output or helper authority into another Node's terminal.
  const noiseCredential = await credential('wrong-connection')
  const noise = new WebSocket(fixture.origin.replace(/^http/, 'ws') + `/node_ws?id=wrong-connection&auth=${noiseCredential.authToken}`); peers.push(noise); await once(noise, 'open')
  noise.send(JSON.stringify({ type: 'node_register', nodeType: 'event-fault-peer', capabilities: { tools: [], services: { 'vscode-pty': 1 } }, nodeProtocol: { min: 1, max: 3 } })); await once(noise, 'message')
  noise.send(JSON.stringify({ type: 'node_service_event', service: 'vscode-pty', nodeId: 'official-code', event: { type: 'output', terminalId: id, data: 'WRONG-CONNECTION-OUTPUT' } }))
  noise.send(JSON.stringify({ type: 'node_service_event', service: 'vscode-pty', nodeId: 'official-code', event: { type: 'code-request', terminalId: id, requestId: 'wrong-connection-control', request: { kind: 'openFile', nodeId: 'master', path: join(repo, 'renamed.txt') } } }))
  noise.send(JSON.stringify({ type: 'session_list_request', requestId: 'event-order-barrier' })); assert.equal(JSON.parse((await once(noise, 'message'))[0]).type, 'cli_response')
  assert(!(await output('owner')).includes('WRONG-CONNECTION-OUTPUT')); assert(!(await events('owner')).some(row => row.type === 'control'))
  noise.terminate(); await until(async () => !(await nodes()).find(row => row.id === 'wrong-connection').online, 'adversarial event peer disconnected')
  await input('owner', "printf 'TWO-BROWSER-PTY\\n'; stty size\n")
  await until(async () => (await output('owner')).includes('30 100') && (await output('second')).includes('TWO-BROWSER-PTY'), 'real PTY output fanout')
  await page.evaluate(() => window.nodeCodeClients.owner.socket.send(JSON.stringify({ type: 'resize', cols: 91, rows: 37 })))
  await input('owner', "stty size\n"); await until(async () => (await output('owner')).includes('37 91'), 'real remote PTY resize')
  await input('owner', 'code --goto renamed.txt:3:1; printf "HELPER-ACK=%s\\n" "$?"\n')
  const control = await until(async () => (await events('owner')).find(row => row.type === 'control'), 'real official helper callback')
  assert.equal(control.request.nodeId, 'official-code'); assert.equal(control.request.path, join(repo, 'renamed.txt')); assert.equal(control.request.startLine, 3)
  assert(!(await events('second')).some(row => row.type === 'control'), 'second opt-in client cannot take over')
  await page.evaluate(requestId => window.nodeCodeClients.second.socket.send(JSON.stringify({ type: 'control-result', requestId, ok: true })), control.requestId)
  if (sourceMain) {
    await until(async () => (await events('second')).some(row => row.type === 'error' && row.message.includes('unauthorized')), 'Source rejects unauthorized helper ACK')
    await page.evaluate(() => window.nodeCodeClients.second.socket.close())
  }
  await until(() => page.evaluate(() => window.nodeCodeClients.second.closed), 'only second browser detached')
  await page.evaluate(requestId => window.nodeCodeClients.owner.socket.send(JSON.stringify({ type: 'control-result', requestId, ok: true, message: 'Owned browser handled open' })), control.requestId)
  await until(async () => (await output('owner')).includes('HELPER-ACK=0'), 'official helper received correlated ACK')
  await attachBrowser('ordinary', id)
  const detachBefore = wire.filter(row => row.type === 'node_service_command' && row.operation === 'detach').length
  await input('owner', 'code --goto renamed.txt:2:1; printf "HELPER-DETACH=%s\\n" "$?"\n')
  const detachControl = await until(async () => (await events('owner')).find(row => row.type === 'control' && row.requestId !== control.requestId), 'pending helper before owner detach')
  await page.evaluate(() => window.nodeCodeClients.owner.socket.close()); await until(() => page.evaluate(() => window.nodeCodeClients.owner.closed), 'first browser detached')
  assert.equal(wire.filter(row => row.type === 'node_service_command' && row.operation === 'detach').length, detachBefore)
  await until(async () => (await output('ordinary')).includes('HELPER-DETACH=1'), 'pending official helper rejected on control-owner detach')
  assert(wire.some(row => row.type === 'node_service_command' && row.operation === 'code-result' && row.args.requestId === detachControl.requestId && row.args.ok === false))
  await input('ordinary', 'code renamed.txt; printf "NO-CONTROL=%s\\n" "$?"\n')
  await until(async () => (await output('ordinary')).includes('NO-CONTROL=1'), 'ordinary browser has no helper authority')
  await page.evaluate(() => window.nodeCodeClients.ordinary.socket.close())
  await until(() => wire.filter(row => row.type === 'node_service_command' && row.operation === 'detach').length === detachBefore + 1, 'final detach sent without kill')
  assert.equal((await live(id)).body.terminal.pid, remote.pid)
  await attachBrowser('reconnect', id)
  const active = connections.at(-1); active.upstream.close()
  await until(() => page.evaluate(() => window.nodeCodeClients.reconnect.closed), 'Node disconnect closes browser stream')
  assert((await events('reconnect')).some(row => row.type === 'error')); assert(!(await events('reconnect')).some(row => row.type === 'exit'))
  await online(); assert.equal((await live(id)).body.terminal.pid, remote.pid)
  await attachBrowser('after', id); await input('after', "printf 'AFTER-RECONNECT\\n'\n"); await until(async () => (await output('after')).includes('AFTER-RECONNECT'), 'rediscovered same CLI process')
  await page.evaluate(() => window.nodeCodeClients.after.socket.close())
  await fixture.stop(); await fixture.start(); await online()
  const rediscovered = (await fixture.api('GET', '/api/terminals')).body.terminals.find(row => row.id === id); assert.equal(rediscovered.pid, remote.pid)
  await attachBrowser('restart', id); await input('restart', "printf 'RESTART-PID=%s\\n' \"$$\"\n"); await until(async () => (await output('restart')).includes('RESTART-PID=' + remote.pid), 'same live CLI shell after Main restart')
  await page.evaluate(() => window.nodeCodeClients.restart.socket.close())
  assert.equal((await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(id))).status, 200); assert.equal((await live(id)).status, 404)
  await until(() => { try { process.kill(remote.pid, 0); return false } catch { return true } }, 'explicit close killed real remote PTY')
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitForWebUiReady(page); await page.waitForFunction(() => window.foxwarmTest?.sendMessage)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('[role="textbox"][aria-label="Message"]')
  await page.type('[role="textbox"][aria-label="Message"]', 'NODE-CODE')
  const admitted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/main/message' && response.request().method() === 'POST')
  await page.click('button[aria-label="Send message"]')
  assert.equal((await admitted).status(), 202)
  await until(async () => { const state = JSON.parse(await readFile(join(fixture.data, 'state/sessions/main.json'), 'utf8').catch(() => 'null')); return state && !state.busy && state.history.some(row => row.parts?.some(part => part.text?.includes('NODE-CODE-DONE'))) }, 'real remote file turn')
  const state = JSON.parse(await readFile(join(fixture.data, 'state/sessions/main.json'), 'utf8')), fileResponse = state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'read-code').functionResponse
  assert.deepEqual(fileResponse.__meta.resolvedPaths, [{ raw: join(repo, 'renamed.txt'), resolved: join(repo, 'renamed.txt'), nodeId: 'official-code' }]); assert(!JSON.stringify(fileResponse.response).includes('__foxwarmResolvedToolPaths'))
  assert.equal((await fixture.api('POST', '/api/sessions/main/cwd', { cwd: repo })).status, 200)
  await page.waitForFunction(repo => [...document.querySelectorAll('[data-session-header-subtitle]')].some(header => header.textContent.includes(repo)), {}, repo)
  await page.waitForSelector('button[title="Create terminal tab"]:not([disabled])'); await page.click('button[title="Create terminal tab"]')
  const appTerminal = await until(async () => (await fixture.api('GET', '/api/terminals')).body.terminals.find(row => row.nodeId === 'official-code'), 'original App remote terminal')
  await page.waitForSelector('.xterm-screen, .xterm-rows'); await page.click('.xterm-screen, .xterm-rows'); await page.keyboard.type("printf 'APP-REMOTE\\n' > app-remote.txt"); await page.keyboard.press('Enter')
  assert.equal(appTerminal.cwd, repo)
  await until(async () => await access(join(appTerminal.cwd, 'app-remote.txt')).then(() => true, () => false), 'original App keyboard reached remote PTY')
  assert.equal(await readFile(join(appTerminal.cwd, 'app-remote.txt'), 'utf8'), 'APP-REMOTE\n')
  await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(appTerminal.id))
  if (hasCode) {
    await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('button[title$="renamed.txt in Code"]'); await page.click('button[title$="renamed.txt in Code"]')
    let code = await codeFrame(); await code.waitForSelector('.editor-instance .view-lines', { timeout: 45000 }); await code.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('selected second'))
    await code.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type('\nSaved remotely in original Code'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
    await until(async () => (await readFile(join(repo, 'renamed.txt'), 'utf8')).includes('Saved remotely in original Code'), 'official browser FS provider saved remotely')
    await palette(code, 'Foxwarm: New Terminal')
    const codeTerminal = await until(async () => (await fixture.api('GET', '/api/terminals')).body.terminals.find(row => row.nodeId === 'official-code'), 'official Code remote PTY')
    assert.equal(codeTerminal.cwd, repo); await palette(code, 'Terminal: Focus Terminal'); await code.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea')); await page.keyboard.type("code --goto 'spaces 雪.txt:3:1'", { delay: 20 }); await page.keyboard.press('Enter')
    await code.waitForFunction(() => document.body.innerText.includes('Ln 3, Col 1'), { timeout: 30000 })
    if (!normalRuntime) {
      await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('button[title="Open commit details in Code"]'); await page.click('button[title="Open commit details in Code"]')
      const commitFrame = await until(async () => { for (const frame of page.frames()) { try { if ((await frame.evaluate(() => document.body.innerText)).includes('remote rename and binary') && (await frame.evaluate(() => document.body.innerText)).includes('Changed files')) return frame } catch {} } }, 'official SCM immutable commit webview', 45000)
      await (await commitFrame.$('button.file:not([disabled])')).click(); code = await codeFrame(); await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
      assert(wire.some(row => row.type === 'node_service_request' && row.service === 'vscode-git' && row.operation === 'content' && row.args.ref))
      const workspaceFile = join(fixture.data, 'state/vscode-web/foxwarm.code-workspace')
      const workspaceWritten = page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'PUT' && url.pathname === '/api/vscode-web/fs/write-file' && url.searchParams.get('nodeId') === 'master' && url.searchParams.get('path') === workspaceFile
      }, { timeout: 22000 })
      const [workspaceResponse] = await Promise.all([workspaceWritten, palette(code, 'Foxwarm: Open Foxwarm data folder')])
      assert.equal(workspaceResponse.status(), 200, await workspaceResponse.text())
      assert.equal((await workspaceResponse.json()).success, true)
      const roots = (await fixture.api('GET', '/api/vscode-web/fs/workspace-roots')).body; assert.equal(roots.roots.data.nodeId, 'master')
      const workspace = JSON.parse(await readFile(workspaceFile, 'utf8'))
      assert(workspace.folders.some(folder => folder.uri ? folder.uri.startsWith('foxwarm://node+master') && decodeURIComponent(new URL(folder.uri).pathname) === fixture.data : typeof folder.path === 'string' && resolve(fixture.data, 'state/vscode-web', folder.path) === fixture.data), 'authoritative Master data command from remote workspace')
      masterWorkspaceWrite = { method: workspaceResponse.request().method(), url: workspaceResponse.url(), status: workspaceResponse.status(), workspace }
    }
    await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(codeTerminal.id))
  }
  for (const row of wire.filter(row => row.type === 'node_service_request' || row.type === 'node_service_command')) { assert.equal(row.sessionId, undefined); assert.equal(row.agentName, undefined) }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', cli: process.env.FOXWARM_CLI_EXECUTABLE ? 'configured-native-capable' : 'source', mainRuntime: normalRuntime || 'experiment', originalWebUi: true, officialWorkbench: hasCode, masterWorkspaceWrite, realRemoteFs: true, fiftyMiB: true, readOnlyGitV2: true, twoBrowserAttachments: true, remotePtyPid: remote.pid, actualResize: '37x91', detachDoesNotKill: true, explicitCloseKills: true, connectionRediscovery: true, hostRestartRediscovery: true, wrongConnectionEventsRejected: true, helperSingleOwner: true, pendingHelperDetachRejected: true, helperOriginalExtension: hasCode, serviceRequests: wire.filter(row => row.type === 'node_service_request').length, serviceCommands: wire.filter(row => row.type === 'node_service_command').length, serviceEvents: wire.filter(row => row.type === 'node_service_event').length, limits: hasCode ? [] : ['Official Code assets not configured; API and original WebUI qualified.'] }))
} catch (error) {
  if (page) { await page.screenshot({ path: join(fixture.root, 'failure.png') }).catch(() => {}); await writeFile(join(fixture.root, 'browser-state.json'), JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.evaluate(() => document.body.innerText).catch(() => '') }))), null, 2)).catch(() => {}) }
  console.error(JSON.stringify({ errors, browser: wire.filter(row => row.browserRequest || row.browserError) })); console.error(cliOutput); console.error(fixture.output); throw error
} finally {
  for (const peer of peers) peer.terminate()
  for (const socket of nodeSockets) socket.terminate()
  if (cli && cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, 'exit').catch(() => {}); cli.kill('SIGTERM'); await exited }
  proxy.close(); await new Promise(done => proxyServer.close(done)); model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
}
