// Fixed Code services through normal Source/.NET Main, original App and optional official Code extensions.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const assets = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR
for (const runtime of ['source', 'dotnet']) {
  const env = {}, fixture = await createHostFixture('cli-code-' + runtime, { runtime, normalStartup: true, env })
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '', FOXWARM_BIND_ADDRESS: '127.0.0.1', FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN: '', ...(assets ? { FOXWARM_VSCODE_WEB_ASSET_DIR: resolve(assets) } : {}) })
  const cwd = join(fixture.root, 'cli'), repo = join(cwd, 'repository'), wire = [], sockets = new Set(), errors = []
  for (const path of [cwd, repo]) await mkdir(path, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Code Service Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'notes.txt'), 'first\nselected second\nselected third\nlast\n'); git('add', '.'); git('commit', '-qm', 'remote root fixture'); const rootCommit = git('rev-parse', 'HEAD')
  git('mv', 'notes.txt', 'renamed.txt'); await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 255, 128])); git('add', '.'); git('commit', '-qm', 'remote rename and binary'); const commit = git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'renamed.txt'), 'first\nselected second\nselected third\nworking\n')
  const proxyHttp = createServer(), proxy = new WebSocketServer({ server: proxyHttp, maxPayload: 80 * 1024 * 1024 })
  proxyHttp.listen(0, '127.0.0.1'); await once(proxyHttp, 'listening')
  proxy.on('connection', (downstream, request) => {
    const upstream = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url, { maxPayload: 80 * 1024 * 1024 }), waiting = []
    sockets.add(downstream); sockets.add(upstream)
    upstream.on('open', () => { for (const text of waiting) upstream.send(text) })
    downstream.on('message', bytes => { const text = bytes.toString(), value = JSON.parse(text); wire.push({ direction: 'reply', type: value.type, requestId: value.requestId }); if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else waiting.push(text) })
    upstream.on('message', bytes => { const value = JSON.parse(bytes); wire.push({ direction: 'request', ...value, args: value.args?.contentBase64 ? { ...value.args, contentBase64: '[binary]' } : value.args }); if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes.toString()) })
    for (const [source, target] of [[downstream, upstream], [upstream, downstream]]) { source.on('close', () => { sockets.delete(source); if (target.readyState === WebSocket.OPEN) target.close() }); source.on('error', () => {}) }
  })
  let round = 0, page, cli, cliOutput = ''
  const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      JSON.parse(raw)
      const current = round++, output = current === 0 ? [call('select-code', 'node', { action: 'select', nodeId: 'code-cli' })] : current === 1 ? [call('read-code', 'read', { filePath: join(repo, 'renamed.txt'), startLine: 2, endLine: 3 })] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `CLI-CODE-DONE\n\n<foxwarm-commit node="code-cli" path="${repo}" id="${commit}" />` }] }]
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 8 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: cli-code-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, models: ['wire'] } } }))
  const online = () => until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(row => row.id === 'code-cli' && row.online), 'real CLI Code services online', 22000)
  const fsUrl = (operation, path) => '/api/vscode-web/fs/' + operation + '?nodeId=code-cli&path=' + encodeURIComponent(path)
  const gitUrl = operation => '/api/vscode-web/git/' + operation + '?nodeId=code-cli&workspace=' + encodeURIComponent(repo)
  async function rawApi(method, path, bytes) { const response = await fetch(fixture.origin + path, { method, headers: { authorization: 'Bearer ' + fixture.token }, ...(bytes === undefined ? {} : { body: bytes }) }); return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) } }
  const codeFrame = () => until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname.endsWith('/vscode-web/') && frame.parentFrame() === page.mainFrame()), 'original embedded official workbench', 30000)
  async function palette(code, command) {
    await code.click('.monaco-workbench'); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await code.waitForSelector('.quick-input-widget input'); await code.type('.quick-input-widget input', command); await page.keyboard.press('Enter')
  }
  try {
    await fixture.start()
    const executable = process.env.FOXWARM_CLI_EXECUTABLE
    cli = spawn(executable || join(process.env.DOTNET_ROOT, 'dotnet'), [...(executable ? [] : [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', `http://127.0.0.1:${proxyHttp.address().port}`, '--id', 'code-cli', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim(), '--no-local-trigger', '--credentials-file', join(cwd, 'credentials.json')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents') } })
    for (const stream of [cli.stdout, cli.stderr]) stream.on('data', bytes => { cliOutput = (cliOutput + bytes).slice(-20000) })
    const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'code-cli'), 'ordinary pairing pending')
    assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    const node = await online(); assert.deepEqual(node.services, { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1 })
    const actualTerminal = await fixture.api('POST', '/api/terminals', { nodeId: 'code-cli', cwd: repo }); assert.equal(actualTerminal.status, 200); assert.equal((await fixture.api('DELETE', '/api/terminals/' + actualTerminal.body.terminal.id)).status, 200)
    assert.equal((await fixture.api('GET', fsUrl('stat', repo))).body.type, 2)
    const binary = join(cwd, 'api.bin'), bytes = Buffer.from([0, 255, 1, 128])
    assert.equal((await rawApi('PUT', fsUrl('write-file', binary) + '&create=1', bytes)).status, 200); assert.deepEqual((await rawApi('GET', fsUrl('read-file', binary))).bytes, bytes)
    assert.equal((await rawApi('PUT', fsUrl('write-file', binary) + '&create=1', Buffer.from('no'))).status, 409); assert.deepEqual(await readFile(binary), bytes)
    const directory = join(cwd, 'api-directory'); assert.equal((await fixture.api('POST', fsUrl('create-directory', directory), {})).status, 200)
    const renamed = join(directory, 'new.bin'); assert.equal((await fixture.api('POST', '/api/vscode-web/fs/rename', { nodeId: 'code-cli', oldPath: binary, newPath: renamed })).status, 200)
    assert((await fixture.api('GET', fsUrl('read-directory', directory))).body.entries.some(row => row.name === 'new.bin'))
    assert.equal((await fixture.api('POST', fsUrl('delete', directory), { recursive: true })).status, 200); assert(!await access(directory).then(() => true, () => false))
    assert.equal((await fixture.api('GET', gitUrl('status'))).body.nodeId, 'code-cli')
    const details = (await fixture.api('GET', gitUrl('commit') + '&id=' + commit)).body; assert.equal(details.nodeId, 'code-cli'); assert.equal(details.commit.oid, commit); assert(details.files.some(row => row.binary)); assert(details.files.some(row => row.kind === 'renamed'))
    assert.equal((await fixture.api('GET', gitUrl('commit') + '&id=' + rootCommit)).body.comparison.mode, 'empty-tree')
    assert.equal((await fixture.api('GET', gitUrl('commit') + '&id=HEAD')).status, 422)
    assert.equal((await rawApi('GET', gitUrl('content') + '&path=renamed.txt&ref=' + commit)).bytes.toString(), 'first\nselected second\nselected third\nlast\n')
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'code-owner' }); assert.equal(created.status, 200); const id = created.body.sessionId
    page = await fixture.openApp(); page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(id => { window.codePreviousHelper = window.foxwarmTest; window.codeAlreadySelected = [...document.querySelectorAll('[data-session-header-subtitle]')].some(header => header.textContent.includes(id)); window.foxwarmTest.switchToSession(id) }, id)
    await page.waitForFunction(id => [...document.querySelectorAll('[data-session-header-subtitle]')].some(header => header.textContent.includes(id)) && (window.codeAlreadySelected || window.foxwarmTest !== window.codePreviousHelper), {}, id)
    await page.evaluate(() => window.foxwarmTest.sendMessage('CLI-CODE'))
    await until(async () => { const state = JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8')); return state.history.some(row => row.parts?.some(part => part.text?.includes('CLI-CODE-DONE'))) }, 'normal model remote file turn', 30000)
    await page.waitForSelector('button[title$="renamed.txt in Code"]')
    if (assets) {
      await page.click('button[title$="renamed.txt in Code"]'); let code = await codeFrame()
      await code.waitForSelector('.editor-instance .view-lines', { timeout: 45000 }); await code.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('selected second'))
      await code.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type('\nSaved through native-capable CLI Code service'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
      await until(async () => (await readFile(join(repo, 'renamed.txt'), 'utf8')).includes('Saved through native-capable CLI Code service'), 'official FS extension saved remotely')
      // Official read-only SCM discovers working changes and opens an ordinary diff.
      await palette(code, 'View: Show Source Control'); await code.waitForSelector('.scm-view .resource, .scm-view .monaco-list-row', { timeout: 30000 })
      const workingChange = await code.waitForFunction(() => [...document.querySelectorAll('.scm-view .monaco-list-row')].find(row => row.textContent.includes('renamed.txt'))); await workingChange.asElement().click(); await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
      await page.evaluate(id => window.foxwarmTest.switchToSession(id), id); await page.waitForSelector('button[title="Open commit details in Code"]'); await page.click('button[title="Open commit details in Code"]')
      const commitFrame = await until(async () => { for (const frame of page.frames()) { try { const text = await frame.evaluate(() => document.body.innerText); if (text.includes('remote rename and binary') && text.includes('Changed files')) return frame } catch {} } }, 'official immutable commit details webview', 45000)
      await (await commitFrame.$('button.file:not([disabled])')).click(); code = await codeFrame(); await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
      assert(wire.some(row => row.type === 'node_service_request' && row.service === 'vscode-git' && row.operation === 'content' && row.args.ref))
    }
    const requests = wire.filter(row => row.type === 'node_service_request' || row.type === 'node_service_command')
    for (const row of requests) { assert.equal(row.sessionId, undefined); assert.equal(row.agentName, undefined); assert.equal(row.owner, undefined) }
    assert.deepEqual(errors, []); assert.equal(git('rev-parse', 'HEAD'), commit)
    await fixture.stop(); await fixture.start(); await online(); assert.equal((await fixture.api('GET', gitUrl('commit') + '&id=' + commit)).body.commit.oid, commit)
    console.log(JSON.stringify({ pass: runtime, mainStarts: fixture.hostPids.length, originalApp: true, officialFsScmAndImmutableCommit: !!assets, actualPty: true, serviceRequests: requests.length }))
  } catch (error) {
    if (page) { await page.screenshot({ path: join(fixture.root, 'failure.png') }).catch(() => {}); await writeFile(join(fixture.root, 'browser-state.json'), JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.evaluate(() => document.body.innerText).catch(() => '') }))), null, 2)).catch(() => {}) }
    console.error(runtime, cliOutput, fixture.output); throw error
  } finally {
    for (const socket of sockets) socket.terminate()
    if (cli && cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await exited }
    proxy.close(); await new Promise(done => proxyHttp.close(done)); model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
  }
}
