// Main Code through the original App, official workbench and real browser extensions.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTlsServer, request as tlsRequest } from 'node:https'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import { writeModelFixture } from './mainModelFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const startedAt = Date.now()
let currentStage
const nativeDialogPages = new WeakSet()
function stage(name) {
  currentStage = name
  console.error(JSON.stringify({ fixture: 'mainHostCode', stage: name, elapsedMs: Date.now() - startedAt }))
}
function observeNativeDialogs(page, surface) {
  page.on('dialog', dialog => {
    nativeDialogPages.add(page)
    console.error(JSON.stringify({ fixture: 'mainHostCode', stage: currentStage, event: 'native-dialog', surface, type: dialog.type(), message: dialog.message().slice(0, 2048), elapsedMs: Date.now() - startedAt }))
  })
}
function observePrefixNavigation(page) {
  const pending = new Map(), failed = [], events = [], responses = []
  const path = url => new URL(url || 'about:blank').pathname.slice(0, 256)
  const record = (list, value) => { list.push({ ...value, elapsedMs: Date.now() - startedAt }); if (list.length > 8) list.shift() }
  page.on('request', request => pending.set(request, { path: path(request.url()), type: request.resourceType(), elapsedMs: Date.now() - startedAt }))
  page.on('response', response => {
    const request = pending.get(response.request()); if (request) request.status = response.status()
    record(responses, { path: path(response.url()), status: response.status() })
  })
  page.on('requestfinished', request => pending.delete(request))
  page.on('requestfailed', request => {
    record(failed, { path: path(request.url()), type: request.resourceType(), error: request.failure()?.errorText.slice(0, 256) })
    pending.delete(request)
  })
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) record(events, { event: 'navigated', path: path(frame.url()) }) })
  for (const event of ['domcontentloaded', 'load']) page.on(event, () => record(events, { event }))
  return () => ({ events, responses, failed, pendingCount: pending.size, pending: [...pending.values()].slice(-16) })
}
stage('owned fixture preparation')

const workbenchDir = resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web')
await access(join(workbenchDir, 'out/vs/workbench/workbench.web.main.internal.js'))
const options = { env: {} }, owned = await createHostFixture('code', options)
options.cwd = owned.root
options.env = { HOME: join(owned.root, 'home') }
await mkdir(options.env.HOME)
const git = (...args) => execFileSync('git', ['-C', owned.work, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Code Fixture'); git('config', 'user.email', 'code@example.invalid')
const remoteRoot = join(owned.root, 'remote-project'), remoteOutside = join(owned.root, 'remote-outside')
for (const folder of [join(remoteRoot, 'src'), join(remoteRoot, 'tests'), remoteOutside]) await mkdir(folder, { recursive: true })
await writeFile(join(remoteRoot, 'src/remote.txt'), 'remote project file\n')
await writeFile(join(remoteOutside, 'outside.txt'), 'remote outside file\n')
await mkdir(join(owned.data, 'state/vscode-web'), { recursive: true })
await writeFile(join(owned.data, 'state/vscode-web/foxwarm.code-workspace'), JSON.stringify({ folders: [
  { uri: 'foxwarm://node+master' + owned.work },
  { uri: 'foxwarm://node+code-peer' + remoteRoot + '/src', name: 'Remote source' },
  { uri: 'foxwarm://node+code-peer' + remoteRoot + '/tests' },
], settings: { 'editor.fontSize': 15 } }))
let remoteCli, remoteOutput = ''
const committedNotes = 'first\nselected second\nselected third\nlast\n'
await writeFile(join(owned.work, 'old.txt'), committedNotes)
git('add', 'old.txt'); git('commit', '-qm', 'root fixture')
const rootCommit = git('rev-parse', 'HEAD')
git('mv', 'old.txt', 'notes.txt'); await writeFile(join(owned.work, 'binary.bin'), Buffer.from([0, 17, 255])); git('add', '.'); git('commit', '-qm', 'rename and binary fixture')
const commit = git('rev-parse', 'HEAD'), requests = [], failures = [], browserErrors = [], codeResponses = []
await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
let appPage, extraPage, prefixProxy, declaredProxy, prefixNavigation, browserVersion; const declaredMode = process.env.FOXWARM_CODE_DECLARED_PROXY; let proxyUpgrades = 0
if (declaredMode) {
  const prefix = '/published/main/'
  const forward = (request, response) => {
    if (!request.url.startsWith(prefix)) { response.writeHead(404); response.end(); return }
    const upstream = httpRequest(owned.origin + '/' + request.url.slice(prefix.length), { method: request.method, headers: { ...request.headers, host: new URL(owned.origin).host } }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', error => response.destroy(error)); request.pipe(upstream)
  }
  declaredProxy = declaredMode === 'https' ? createTlsServer({ key: await readFile(process.env.FOXWARM_CODE_TLS_KEY), cert: await readFile(process.env.FOXWARM_CODE_TLS_CERT) }, forward) : createServer(forward)
  declaredProxy.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith(prefix)) { socket.destroy(); return }
    proxyUpgrades++
    const upstream = httpRequest(owned.origin + '/' + request.url.slice(prefix.length), { headers: { ...request.headers, host: new URL(owned.origin).host } })
    upstream.on('upgrade', (response, peer, initial) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n')
      if (head.length) peer.write(head); if (initial.length) socket.write(initial); socket.pipe(peer); peer.pipe(socket)
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy()); socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy())
    })
    upstream.on('response', response => { socket.end('HTTP/1.1 ' + response.statusCode + ' Rejected\r\nContent-Length: 0\r\n\r\n') }); upstream.on('error', () => socket.destroy()); upstream.end()
  })
  declaredProxy.listen(0, '127.0.0.1'); await once(declaredProxy, 'listening')
  options.publicRoot = declaredMode + '://127.0.0.1:' + declaredProxy.address().port + prefix
  if (declaredMode === 'https') options.chromeArgs = ['--ignore-certificate-errors']
  await writeFile(join(owned.data, 'state/token'), owned.token, { mode: 0o600 })
  await writeFile(join(owned.data, 'state/config.yaml'), 'url: ' + options.publicRoot + '\nbot:\n  httpPort: ' + owned.port + '\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n')
}
options.onPage = page => { appPage = page; observeNativeDialogs(page, 'app'); page.on('pageerror', error => browserErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400) codeResponses.push({ url: response.url(), status: response.status() }) }) }
let releaseHold, holdStarted = false; const hold = new Promise(done => { releaseHold = done })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const latest = body.input.filter(row => row.type === 'message' && row.role === 'user').at(-1)?.content?.map(part => part.text || '').join(' ') || ''
    if (latest.includes('PUBLIC-HOLD') && !latest.includes('PUBLIC-QUEUED')) { holdStarted = true; await hold }
    const publicTask = /PUBLIC-(IMAGE|QUEUED)/.exec(latest)?.[0]
    const output = publicTask ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: publicTask + '-DONE' }] }] : body.input.some(row => row.type === 'function_call_output' && row.call_id === 'code-read')
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `CODE-TURN-DONE\n\n<foxwarm-commit node="master" path="${owned.work}" id="${commit}" />\n\n<foxwarm-commit node="master" path="${owned.work}" id="${rootCommit}" />` }] }]
      : [{ type: 'function_call', call_id: 'code-read', name: 'read', arguments: JSON.stringify({ filePath: 'notes.txt', startLine: 2, endLine: 3 }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'code-' + requests.length, output, usage: { input_tokens: 30, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const authority = async () => JSON.parse(await readFile(join(owned.data, 'state/sessions/main.json'), 'utf8'))
const workspaceFile = join(owned.data, 'state/vscode-web/node-master.code-workspace')
const workspaceHas = async path => { try { return (JSON.parse(await readFile(workspaceFile, 'utf8')).folders || []).some(folder => (folder.uri ? resolve(decodeURIComponent(new URL(folder.uri).pathname)) : resolve(dirname(workspaceFile), folder.path)) === resolve(path)) } catch (error) { if (error instanceof SyntaxError) return false; throw error } }
async function palette(frame, command) {
  await frame.click('.monaco-workbench')
  const page = frame.page(); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await frame.waitForSelector('.quick-input-widget input', { visible: true })
  await frame.type('.quick-input-widget input', command)
  try {
    await frame.waitForFunction(command => [...document.querySelectorAll('.quick-input-list .monaco-list-row.focused')].some(row => row.textContent.includes(command)), {}, command)
  } catch (error) {
    let state
    // Native dialogs can block CDP evaluation; their existing event log is the evidence.
    if (!nativeDialogPages.has(page)) {
      try {
        state = await frame.evaluate(() => {
          const describe = element => element ? {
            tag: element.tagName, role: element.getAttribute('role'),
            label: element.getAttribute('aria-label')?.slice(0, 200),
            className: String(element.className).slice(0, 200),
          } : null
          const input = document.querySelector('.quick-input-widget input')
          return {
            input: input?.value.slice(0, 200), inputVisible: !!input?.getClientRects().length,
            documentFocused: document.hasFocus(), activeElement: describe(document.activeElement),
            selectedResult: input?.getAttribute('aria-activedescendant'),
            results: [...document.querySelectorAll('.quick-input-list .monaco-list-row')].slice(0, 5).map(row => ({
              text: row.textContent.slice(0, 200), focused: row.classList.contains('focused'),
              selected: row.getAttribute('aria-selected'),
            })),
            otherFocusedRows: [...document.querySelectorAll('.monaco-list-row.focused')].filter(row => !row.closest('.quick-input-widget')).slice(0, 4).map(row => row.textContent.slice(0, 200)),
          }
        })
      } catch (diagnosticError) { state = { unavailable: String(diagnosticError).slice(0, 300) } }
    }
    console.error(JSON.stringify({ fixture: 'mainHostCode', stage: currentStage, event: 'palette-failure', command, nativeDialog: nativeDialogPages.has(page), state }))
    throw error
  }
  await page.keyboard.press('Enter')
}
// Root commands end by focusing their revealed root in Explorer. The root becomes
// visible earlier, so input sent before this point races the command's own focus.
function explorerFocusedOn(frame, label) {
  return frame.waitForFunction(label => {
    const list = document.activeElement
    return !!list?.closest('.explorer-folders-view') && [...list.querySelectorAll('.monaco-list-row.focused')].some(row => row.textContent.includes(label))
  }, {}, label)
}
async function codeFrame(page, nodeId = 'master') {
  return until(() => page.frames().find(frame => { const url = new URL(frame.url() || 'about:blank'); return url.pathname.endsWith('/vscode-web/') && url.searchParams.get('nodeId') === nodeId && frame.parentFrame() === page.mainFrame() }), 'actual Code iframe', 30000)
}
async function frameText(page, pattern) {
  for (const frame of page.frames()) { try { const text = await frame.evaluate(() => document.body.innerText); if (pattern.test(text)) return frame } catch {} }
  return null
}
try {
  stage('host startup and App login')
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); assert.equal((await owned.api('POST', '/api/sessions/main/cwd', { cwd: owned.work })).status, 200); const page = await owned.openApp(); browserVersion = await page.browser().version()
  const approval = await owned.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: owned.origin, nodeId: 'code-peer' })
  assert.equal(approval.status, 200)
  remoteCli = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', owned.origin, '--id', 'code-peer', '--auth-token', approval.body.authToken, '--credentials-file', join(owned.root, 'peer-credentials.json'), '--no-local-trigger'], { cwd: remoteRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: options.env.HOME, FOXWARM_DATA_DIR: join(owned.root, 'peer-data'), FOXWARM_AGENTS_DIR: join(owned.root, 'peer-agents') } })
  for (const stream of [remoteCli.stdout, remoteCli.stderr]) stream.on('data', bytes => { remoteOutput = (remoteOutput + bytes).slice(-4000) })
  await until(async () => (await owned.api('GET', '/api/nodes')).body.nodes.some(node => node.id === 'code-peer' && node.online), 'second Node connected', 40000)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('.foxwarm-chat-root')
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="foxwarm-host"]')?.content), 'dotnet')
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), owned.token)
  const loginCookie = (await page.cookies()).find(cookie => cookie.name === 'foxwarm_token'); assert.equal(loginCookie.httpOnly, false); assert.equal(loginCookie.value, owned.token); assert.equal(loginCookie.secure, declaredMode === 'https'); assert.equal(loginCookie.path, declaredMode ? '/published/main/' : '/')
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('response', response => { if (response.url().includes('/vscode-web/')) codeResponses.push({ url: response.url(), status: response.status() }) })
  stage('native tool turn')
  await page.evaluate(() => window.foxwarmTest.sendMessage('CODE-TURN'))
  await until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await authority(); return !state.busy && state.history.some(row => row.parts?.some(part => part.text?.includes('CODE-TURN-DONE'))) }, 'native turn')
  const state = await authority(), native = state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'code-read').functionResponse
  assert.equal(native.__meta.resolvedPaths[0].resolved, join(owned.work, 'notes.txt'))
  stage('embedded workbench file and selection')
  await page.waitForSelector('[aria-label="Expand activity"]'); await page.click('[aria-label="Expand activity"]')
  await page.waitForFunction(() => document.querySelector('[data-activity-expanded="true"]')?.style.height === '')
  await page.waitForSelector('button[title="Open notes.txt in Code"]'); await page.click('button[title="Open notes.txt in Code"]')
  let code = await codeFrame(page); await code.waitForSelector('.editor-instance .view-lines', { timeout: 40000 })
  await code.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('selected second'))
  await page.evaluate(() => { document.querySelector('iframe[src*="vscode-web"]').dataset.codeProof = 'same-frame' })
  await code.waitForFunction(() => [...document.querySelectorAll('.statusbar-item')].some(item => item.textContent.replaceAll('\u00a0', ' ').includes('(30 selected)')))
  stage('per-Node migration, folder merge, reveal and close/reopen')
  const remoteWorkspaceFile = join(owned.data, 'state/vscode-web/node-code-peer.code-workspace')
  const remoteWorkspace = async () => JSON.parse(await readFile(remoteWorkspaceFile, 'utf8'))
  assert.equal((await remoteWorkspace()).folders.length, 2)
  assert.equal((await remoteWorkspace()).settings['editor.fontSize'], 15)
  assert.equal((JSON.parse(await readFile(workspaceFile, 'utf8'))).folders.length, 1)
  await page.evaluate(() => {
    window.codeOpenResults = []
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.data?.channel !== 'foxwarm-code-bridge' || event.data.version !== 1 || event.data.type !== 'response') return
      const frame = [...document.querySelectorAll('iframe[data-code-node]')].find(frame => frame.contentWindow === event.source)
      if (frame) window.codeOpenResults.push({ nodeId: frame.dataset.codeNode, ...event.data })
    })
  })
  const launch = async (nodeId, path) => {
    const firstResult = await page.evaluate(() => window.codeOpenResults.length)
    await page.click('button[aria-label="Open code options"]')
    await page.waitForFunction(nodeId => [...document.querySelectorAll('select option')].some(option => option.value === nodeId && !option.disabled), {}, nodeId)
    await page.select('select', nodeId)
    await page.click('input[placeholder="/"]', { clickCount: 3 }); await page.type('input[placeholder="/"]', path)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Open code')?.click())
    // Completion includes the workspace write and Explorer focus. Starting the next
    // launcher interaction during that focus transition can redirect its typing.
    await page.waitForFunction(({ nodeId, firstResult }) => window.codeOpenResults.slice(firstResult).some(result => result.nodeId === nodeId), { timeout: 30000 }, { nodeId, firstResult })
    const result = await page.evaluate(({ nodeId, firstResult }) => window.codeOpenResults.slice(firstResult).find(result => result.nodeId === nodeId), { nodeId, firstResult })
    assert.equal(result.ok, true, result.error)
    assert.equal(decodeURIComponent(new URL(result.result.uri).pathname), path)
  }
  const mergedWorkspaceWrite = page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'PUT' && url.pathname === '/api/vscode-web/fs/write-file'
      && url.searchParams.get('path') === remoteWorkspaceFile
  }, { timeout: 30000 })
  const [, mergedResponse] = await Promise.all([launch('code-peer', remoteRoot), mergedWorkspaceWrite])
  assert.equal(mergedResponse.status(), 200)
  let remoteCode = await codeFrame(page, 'code-peer')
  await remoteCode.waitForSelector('.monaco-workbench', { timeout: 30000 })
  assert.equal((await remoteWorkspace()).folders.length, 1)
  assert.equal(await page.$$eval('iframe[data-code-node]', frames => frames.length), 2)
  assert.equal(await page.$eval('iframe[data-code-node="master"]', frame => frame.dataset.codeProof), 'same-frame')
  assert((await remoteWorkspace()).folders.every(folder => folder.uri.startsWith('foxwarm://node+code-peer')))
  await launch('code-peer', join(remoteRoot, 'src'))
  await remoteCode.waitForFunction(() => [...document.querySelectorAll('.monaco-list-row.focused')].some(row => row.innerText.includes('src')))
  assert.equal((await remoteWorkspace()).folders.length, 1)
  await palette(remoteCode, 'Foxwarm: New Terminal')
  const remoteTerminal = await until(async () => (await owned.api('GET', '/api/terminals')).body.terminals.find(terminal => terminal.nodeId === 'code-peer'), 'remote terminal')
  await remoteCode.waitForSelector('.xterm-screen canvas', { timeout: 30000 })
  await remoteCode.click('.xterm-screen'); await page.keyboard.type('code ' + join(remoteOutside, 'outside.txt')); await page.keyboard.press('Enter')
  await remoteCode.waitForFunction(() => [...document.querySelectorAll('.monaco-list-row.focused')].some(row => row.innerText.includes('outside.txt')))
  assert.equal((await remoteWorkspace()).folders.length, 2)
  await remoteCode.click('.xterm-screen'); await page.keyboard.type('code ' + join(remoteRoot, 'src/remote.txt')); await page.keyboard.press('Enter')
  await remoteCode.waitForFunction(() => [...document.querySelectorAll('.monaco-list-row.focused')].some(row => row.innerText.includes('remote.txt')))
  assert.equal((await remoteWorkspace()).folders.length, 2)
  await page.click('[data-tab-id="vscode-web:code-peer"] button[title="Close tab"]')
  await page.waitForFunction(() => !document.querySelector('iframe[data-code-node="code-peer"]'))
  assert.equal(await page.$eval('iframe[data-code-node="master"]', frame => frame.dataset.codeProof), 'same-frame')
  await launch('code-peer', remoteRoot)
  remoteCode = await codeFrame(page, 'code-peer'); await remoteCode.waitForSelector('.monaco-workbench', { timeout: 30000 })
  assert.equal((await remoteWorkspace()).folders.length, 2)
  await page.click('[data-tab-id="vscode-web:code-peer"] button[title="Close tab"]')
  await owned.api('DELETE', '/api/terminals/' + encodeURIComponent(remoteTerminal.id))
  await page.click('[data-tab-id="vscode-web:master"]')
  stage('official Code terminal and helper')
  await palette(code, 'Foxwarm: New Terminal')
  await until(async () => (await owned.api('GET', '/api/terminals')).body.terminals.length === 1, 'official Code terminal backend', 30000)
  await code.waitForSelector('.xterm-screen canvas', { timeout: 30000 }); await code.click('.xterm-screen'); await code.page().keyboard.type("printf 'CODE-PTY\\n' > ui-pty.txt"); await code.page().keyboard.press('Enter')
  await until(async () => (await readFile(join(owned.work, 'ui-pty.txt'), 'utf8').catch(() => '')) === 'CODE-PTY\n', 'official Code keyboard reached PTY', 30000)
  await code.click('.xterm-screen'); await code.page().keyboard.type("code --goto notes.txt:2:1"); await code.page().keyboard.press('Enter'); await code.waitForFunction(() => document.body.innerText.includes('Ln 2, Col 1'))
  stage('official Code file save')
  // Editing uses Code's real model, browser FS provider and authenticated write route.
  await code.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type('\nCode saved line'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
  await until(async () => (await readFile(join(owned.work, 'notes.txt'), 'utf8')).includes('Code saved line'), 'actual Code save')
  stage('persistent workspace root commands')
  await palette(code, 'Foxwarm: Open Foxwarm data folder')
  await until(() => workspaceHas(owned.data), 'data workspace command')
  code = await codeFrame(page); await explorerFocusedOn(code, 'Foxwarm Data')
  await palette(code, 'Foxwarm: Open Foxwarm app folder')
  const roots = (await owned.api('GET', '/api/vscode-web/fs/workspace-roots')).body
  await until(() => workspaceHas(roots.roots.app.path), 'app workspace command')
  await explorerFocusedOn(code, 'Foxwarm App')
  assert.equal(await page.evaluate(() => document.querySelector('iframe[src*="vscode-web"]').dataset.codeProof), 'same-frame')
  stage('commit details and immutable diffs')
  // Clicking the real marker is the commit bridge producer, not a direct test-only command.
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('button[title="Open commit details in Code"]'); await page.click('button[title="Open commit details in Code"]')
  const detailsFrame = await until(() => frameText(page, /rename and binary fixture[\s\S]*Changed files/), 'real SCM commit webview', 45000)
  assert((await detailsFrame.evaluate(() => document.body.innerText)).includes(owned.work)); assert((await detailsFrame.evaluate(() => document.body.innerText)).includes('binary'))
  const diffButton = await detailsFrame.$('button.file:not([disabled])'); assert(diffButton)
  // The editor shell mounts before its asynchronous immutable content has loaded.
  const diffDeadline = Date.now() + 30000
  const [gitContent] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/api/vscode-web/git/content') && url.searchParams.get('nodeId') === 'master'
        && url.searchParams.get('workspace') === owned.work && url.searchParams.get('path') === 'notes.txt'
        && url.searchParams.get('side') === 'base' && url.searchParams.get('ref') === commit
    }, { timeout: 30000 }),
    (async () => {
      await diffButton.click(); code = await codeFrame(page)
      await code.waitForSelector('.monaco-diff-editor', { timeout: Math.max(1, diffDeadline - Date.now()) })
    })(),
  ])
  assert.equal(gitContent.status(), 200); assert.equal(await gitContent.text(), committedNotes)
  await code.waitForFunction(() => [...document.querySelectorAll('.monaco-diff-editor .modified .view-lines')].some(node => node.textContent.replaceAll('\u00a0', ' ').includes('selected second')), { timeout: Math.max(1, diffDeadline - Date.now()) })
  assert.doesNotMatch(await code.$$eval('.monaco-diff-editor .modified .view-lines', nodes => nodes.map(node => node.textContent).join('')), /Code saved line/)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('code[title="' + rootCommit + '"]')
  await page.evaluate(id => document.querySelector('code[title="' + id + '"]').parentElement.parentElement.querySelector('button').click(), rootCommit)
  const rootDetails = await until(() => frameText(page, /root fixture[\s\S]*Changed files/), 'real root commit webview', 30000)
  await (await rootDetails.$('button.file:not([disabled])')).click(); code = await codeFrame(page)
  await code.waitForFunction(() => document.body.innerText.includes('old.txt'))
  await until(() => codeResponses.some(row => row.url.includes('/api/vscode-web/git/content') && row.url.includes('ref=' + rootCommit)), 'root immutable file content')
  stage('official webview sidebar, Chat and Setup')
  // Original Foxwarm sidebar and Setup run in the actual official webview bootstrap.
  await palette(code, 'View: Show Foxwarm')
  let sidebar = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'sidebar'), 'actual nested Foxwarm sidebar', 30000)
  await sidebar.waitForSelector('[data-session-id="main"]'); assert(await sidebar.$('button[title="Create terminal tab"]'))
  assert(sidebar.parentFrame() !== code && sidebar.parentFrame().parentFrame() !== page.mainFrame(), 'Sidebar leaf must live inside the official webview frame.')
  await sidebar.click('[data-session-id="main"]')
  const chat = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'chat'), 'actual nested Chat editor', 30000)
  await chat.waitForFunction(() => document.body.innerText.includes('CODE-TURN-DONE')); assert(!await chat.$('button[title="Terminal"], button[aria-label="Toggle terminal panel"]'))
  await sidebar.click('button[title="UI settings"]'); await sidebar.waitForFunction(() => document.body.innerText.includes('Open setup'))
  await sidebar.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Open setup').click())
  const setup = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'setup'), 'actual nested Setup editor', 30000)
  await setup.waitForFunction(() => document.body.innerText.includes('Models') && document.body.innerText.includes('Setup'))
  stage('original App terminal and cwd')
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('[data-workbench-status-bar] button[aria-label="Toggle terminal panel"]')
  const appTerminalsBefore = (await owned.api('GET', '/api/terminals')).body.terminals
  await page.click('[data-workbench-status-bar] button[aria-label="Toggle terminal panel"]')
  await until(async () => (await owned.api('GET', '/api/terminals')).body.terminals.length === appTerminalsBefore.length + 1, 'original App terminal backend', 30000)
  const appTerminal = (await owned.api('GET', '/api/terminals')).body.terminals.find(row => !appTerminalsBefore.some(old => old.id === row.id)); assert(appTerminal)
  await page.waitForSelector('.xterm-screen, .xterm-rows', { timeout: 30000 }); await page.click('.xterm-screen, .xterm-rows'); await page.keyboard.type("printf 'APP-PTY\\n' > app-pty.txt"); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(owned.work, 'app-pty.txt'), 'utf8').catch(() => '')) === 'APP-PTY\n', 'original App keyboard reached PTY', 30000)
  await page.keyboard.type("cd ..; pwd > app-cwd.txt"); await page.keyboard.press('Enter')
  // The command's file effect precedes the prompt hook that publishes terminal cwd.
  await until(async () => {
    if ((await readFile(join(dirname(owned.work), 'app-cwd.txt'), 'utf8').catch(() => '')).trim() !== dirname(owned.work)) return false
    const appCwd = await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`)
    assert.equal(appCwd.body.terminal.pid, appTerminal.pid)
    return appCwd.body.terminal.cwd === dirname(owned.work)
  }, 'original App cwd tracking', 30000)
  const persistedTabId = await until(async () => page.evaluate(id => { try { const saved = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4') || '{}'); const state = saved.state || saved; return Object.entries(state.tabsById || {}).find(([, tab]) => tab.terminalId === id && !tab.createMode)?.[0] || false } catch { return false } }, appTerminal.id), 'original App terminal tab persistence', 30000)
  stage('original App terminal reload and close')
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitForWebUiReady(page); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await page.evaluate(id => { window.location.hash = '#tab/' + encodeURIComponent(id) }, persistedTabId); await page.waitForSelector('.xterm-screen, .xterm-rows', { timeout: 30000 })
  const appAfterReload = await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`); assert.equal(appAfterReload.body.terminal.pid, appTerminal.pid); assert.equal(appAfterReload.body.terminal.cwd, dirname(owned.work))
  const terminalClose = '[data-workbench-tab-close="' + persistedTabId + '"], [data-tab-id="' + persistedTabId + '"] button[title="Close tab"]'
  await page.waitForSelector(terminalClose, { visible: true })
  await page.locator(terminalClose).click()
  await until(async () => (await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`)).status === 404, 'original App explicit terminal close', 30000)
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitForWebUiReady(page); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('.foxwarm-chat-root')
  stage('workbench and workspace restore')
  // The retained Chat can match before asynchronous Session navigation commits.
  await page.waitForFunction(() => decodeURIComponent(location.hash) === '#tab/chat:main' && !document.querySelector('[data-pane-navigation-pending]'))
  // The terminal stage left Chat in a short upper pane whose composer covers the lower half
  // of the message list. Wheel both Activity and its file action into the readable band.
  const clickReadableAction = async selector => {
    await page.waitForSelector(selector)
    await until(async () => {
      const { button, list, composer } = await page.$eval(selector, element => {
        const rect = node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, width: box.width } }
        return { button: rect(element), list: rect(element.closest('.foxwarm-chat-messages')), composer: rect(document.querySelector('.foxwarm-chat-composer-form')) }
      })
      if (button.top >= list.top && button.bottom <= composer.top) return true
      await page.mouse.move(list.left + list.width / 2, list.top + 8)
      await page.mouse.wheel({ deltaY: button.top < list.top ? -40 : 40 })
      return false
    }, selector + ' above the composer')
    await page.click(selector)
  }
  await clickReadableAction('[aria-label="Expand activity"]')
  await page.waitForFunction(() => document.querySelector('[data-activity-expanded="true"]')?.style.height === '')
  await clickReadableAction('button[title="Open notes.txt in Code"]'); code = await codeFrame(page)
  await code.waitForFunction(() => document.querySelector('.monaco-workbench')
    && document.querySelector('.tab.active')?.getAttribute('aria-label')?.includes('notes.txt')
    && document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('selected second'), { timeout: 30000 })
  const persisted = JSON.parse(await readFile(join(owned.data, 'state/vscode-web/node-master.code-workspace'), 'utf8')); assert(persisted.folders.length >= 2); assert.equal(persisted.settings['yaml.schemaStore.enable'], false)
  assert.equal((await owned.api('GET', '/api/vscode-web/git/commit?workspace=' + encodeURIComponent(owned.work) + '&id=' + rootCommit)).body.comparison.mode, 'empty-tree')
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.click('button[aria-label="Open code options"]')
  await page.evaluate(() => {
    const option = [...document.querySelectorAll('label')].find(label => label.textContent.trim() === 'Open in new browser tab').querySelector('input')
    if (!option.checked) option.click()
  })
  await page.click('button[aria-label="Open code options"]')
  stage('standalone Code popup')
  const popupReady = once(page, 'popup'); await page.click('.foxwarm-chat-root button[title="Code"]'); const [popup] = await popupReady; extraPage = popup; observeNativeDialogs(popup, 'code-popup'); popup.on('pageerror', error => browserErrors.push(error.message))
  await popup.waitForSelector('.monaco-workbench', { timeout: 30000 }); const configuration = await popup.evaluate(() => JSON.parse(document.querySelector('#vscode-workbench-web-configuration').getAttribute('data-settings')))
  assert.equal(configuration.workspaceUri.authority, 'node+master'); assert.equal(resolve(decodeURIComponent(configuration.workspaceUri.path)), workspaceFile); assert(!configuration.folderUri)
  stage('standalone config navigation')
  const rawApp = await readFile(roots.configFiles.app.path, 'utf8')
  const configUrl = new URL(popup.url()); configUrl.searchParams.set('openFilePath', roots.configFiles.app.path); configUrl.searchParams.set('openFileNodeId', 'master')
  await popup.goto(configUrl.toString(), { waitUntil: 'domcontentloaded' }); await popup.waitForSelector('.tab[aria-label*="config.yaml"]'); await popup.click('.tab[aria-label*="config.yaml"]'); await popup.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.includes('maxOutput'), { timeout: 30000 })
  stage('official YAML diagnostics and advisory save')
  await popup.click('.editor-instance .view-lines'); await popup.keyboard.down('Control'); await popup.keyboard.press('A'); await popup.keyboard.up('Control'); await popup.keyboard.type('llm:\n  maxOutput: "invalid"\n')
  await popup.waitForSelector('.squiggly-error', { timeout: 30000 }); await popup.keyboard.down('Control'); await popup.keyboard.press('S'); await popup.keyboard.up('Control')
  await until(async () => (await readFile(roots.configFiles.app.path, 'utf8')).includes('invalid'), 'human raw YAML save remains advisory')
  stage('startup config capture evaluation')
  await page.evaluate(() => window.foxwarmTest.sendMessage('CONFIG-CAPTURE'))
  stage('startup config capture request')
  await until(() => requests.length === 3, 'unchanged startup app config after Code save'); assert.equal(requests[2].max_output_tokens, 713)
  stage('YAML restoration editor input')
  await popup.click('.editor-instance .view-lines'); await popup.keyboard.down('Control'); await popup.keyboard.press('A'); await popup.keyboard.up('Control'); await popup.keyboard.sendCharacter(rawApp.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
  stage('YAML restoration save')
  await popup.keyboard.down('Control'); await popup.keyboard.press('S'); await popup.keyboard.up('Control')
  stage('YAML restoration file verification')
  await until(async () => (await readFile(roots.configFiles.app.path, 'utf8')).replaceAll('\r\n', '\n') === rawApp.replaceAll('\r\n', '\n'), 'restore owned YAML fixture')
  stage('standalone popup close')
  await popup.close()
  if (!declaredMode) {
  // Bootstrap preserves a public prefix without trusting forwarded headers.
  // A stripping proxy keeps relative assets and authenticated writes on its prefix.
  // Ordinary Origin headers do not replace the token/cookie boundary.
  stage('prefixed workbench and authenticated file writes')
  prefixProxy = createServer((request, response) => {
    if (!request.url.startsWith('/fixture/')) { response.writeHead(404); response.end(); return }
    const headers = { ...request.headers, host: new URL(owned.origin).host }; delete headers['x-forwarded-host']; delete headers['x-forwarded-proto']
    const upstream = httpRequest(owned.origin + request.url.slice('/fixture'.length), { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', error => response.destroy(error)); request.pipe(upstream)
  }); prefixProxy.listen(0, '127.0.0.1'); await once(prefixProxy, 'listening')
  const prefixed = await page.browser().newPage(); extraPage = prefixed; observeNativeDialogs(prefixed, 'prefixed-code'); prefixed.on('pageerror', error => browserErrors.push(error.message)); prefixNavigation = observePrefixNavigation(prefixed); const prefixResponses = []; prefixed.on('response', response => prefixResponses.push({ url: response.url(), status: response.status() })); const prefixUrl = new URL('http://127.0.0.1:' + prefixProxy.address().port + '/fixture/vscode-web/')
  prefixUrl.searchParams.set('embedded', 'true'); prefixUrl.searchParams.set('nodeId', 'master'); prefixUrl.searchParams.set('initialFolderUri', 'foxwarm://node+master' + owned.work); prefixUrl.searchParams.set('openFilePath', join(owned.work, 'notes.txt'))
  assert.equal((await prefixed.goto(prefixUrl.toString(), { waitUntil: 'domcontentloaded' })).status(), 200)
  await prefixed.waitForSelector('.monaco-workbench', { timeout: 30000 })
  assert(prefixResponses.some(row => row.url.includes('/fixture/vscode-web/static/') && row.status === 200), 'Relative Code assets must retain the prefix.')
  const prefixWrite = join(owned.work, 'prefix-write.txt')
  assert.equal(await prefixed.evaluate(async file => (await fetch('/fixture/api/vscode-web/fs/write-file?path=' + encodeURIComponent(file) + '&create=1&overwrite=1', { method: 'PUT', body: 'authenticated prefix write' })).status, prefixWrite), 200)
  assert.equal(await readFile(prefixWrite, 'utf8'), 'authenticated prefix write')
  assert.equal(await prefixed.evaluate(async file => (await fetch('/fixture/api/vscode-web/fs/write-file?path=' + encodeURIComponent(file) + '&create=1&overwrite=1', { method: 'PUT', credentials: 'omit', body: 'unauthenticated overwrite' })).status, prefixWrite), 401)
  assert.equal(await readFile(prefixWrite, 'utf8'), 'authenticated prefix write')
  assert((await readFile(join(owned.work, 'notes.txt'), 'utf8')).includes('Code saved line')); await prefixed.close(); await new Promise(done => prefixProxy.close(done)); prefixProxy = null
  } else {
    stage('declared proxy image and queued input')
    await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('.foxwarm-chat-root')
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 190, g: 20, b: 80, alpha: 1 } } }).png().toBuffer()
    await page.type('[role="textbox"][aria-label="Message"]', 'PUBLIC-IMAGE')
    await page.$eval('#file-upload', (input, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'public.png', { type: 'image/png' })); Object.defineProperty(input, 'files', { configurable: true, value: transfer.files }); input.dispatchEvent(new Event('change', { bubbles: true })) }, bytes.toString('base64'))
    await page.waitForSelector('.foxwarm-composer-attachment-chip'); await page.click('button[aria-label="Send message"]')
    await until(async () => (await authority()).history.some(row => row.parts?.some(part => part.text === 'PUBLIC-IMAGE-DONE')), 'public image turn')
    await page.waitForSelector('.foxwarm-image-item img'); assert.equal(await page.$eval('.foxwarm-image-item img', image => image.naturalWidth), 3)
    const reference = (await authority()).history.flatMap(row => row.parts || []).find(part => part.inlineDataRef).inlineDataRef
    const blobPath = '/api/blobs/' + reference.blobId
    assert.equal(await page.evaluate(async path => (await fetch(location.pathname + path.slice(1))).status, blobPath), 200)
    // A browser path-shadow candidate cannot suppress the valid login credential.
    await page.setCookie({ name: 'foxwarm_token', value: 'invalid-shadow', url: options.publicRoot, path: '/published/main/api/', httpOnly: false, secure: declaredMode === 'https' })
    assert.equal(await page.evaluate(async () => (await fetch(location.pathname + 'api/sessions')).status), 200)
    // Run queued uses the existing stop/admit/process path and live WebSocket updates.
    await page.evaluate(() => window.foxwarmTest.sendMessage('PUBLIC-HOLD')); await until(() => holdStarted, 'held normal request')
    await page.evaluate(() => window.foxwarmTest.sendMessage('PUBLIC-QUEUED')); await until(async () => (await authority()).queue.length > 0, 'actual queued browser input')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Run queued')))
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Run queued')).click())
    await until(async () => !(await authority()).busy && (await authority()).history.some(row => row.parts?.some(part => part.text === 'PUBLIC-QUEUED-DONE')), 'actual Run queued'); releaseHold()
    const publicOrigin = new URL(options.publicRoot).origin
    const probe = (path, origin, method = 'GET', extras = {}, body) => new Promise((resolve, reject) => {
      const url = new URL(path.replace(/^\//, ''), options.publicRoot), transport = declaredMode === 'https' ? tlsRequest : httpRequest
      const request = transport(url, { method, rejectUnauthorized: false, headers: { authorization: 'Bearer ' + owned.token, ...(origin === undefined ? {} : { origin }), ...extras } }, response => { let text = ''; response.on('data', data => { text += data }); response.on('end', () => resolve({ status: response.statusCode, text })) }); request.on('error', reject); request.end(body)
    })
    const socketStatus = (origin, token) => new Promise((resolve, reject) => {
      const socket = new WebSocket(options.publicRoot.replace(/^http/, 'ws') + 'api/webui/stream', { rejectUnauthorized: false, headers: { origin, authorization: 'Bearer ' + token } })
      socket.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.resume() })
      socket.on('open', () => { socket.close(); resolve(101) }); socket.on('error', reject)
    })
    stage('declared proxy authentication boundary')
    for (const foreign of ['null', 'not an origin', owned.origin, 'https://foreign.invalid', publicOrigin + ', ' + publicOrigin]) {
      for (const path of ['/api/sessions', blobPath, '/download?path=' + encodeURIComponent(join(owned.work, 'notes.txt')), '/vscode-web/', '/vscode-web/static/out/nls.messages.js']) {
        assert.equal((await probe(path, foreign)).status, 200)
        assert.equal((await probe(path, foreign, 'GET', { authorization: 'Bearer invalid' })).status, 401)
      }
      assert.equal((await probe('/api/auth', foreign, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ token: owned.token }))).status, 200)
      assert.equal((await probe('/api/auth', foreign, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ token: 'invalid' }))).status, 401)
      assert.equal(await socketStatus(foreign, owned.token), 101)
      assert.equal(await socketStatus(foreign, 'invalid'), 401)
    }
    assert.equal((await probe('/api/sessions', undefined)).status, 200)
    assert.equal((await probe('/api/sessions', 'https://foreign.invalid', 'GET', { host: new URL(options.publicRoot).host, 'x-forwarded-host': new URL(options.publicRoot).host, 'x-forwarded-proto': declaredMode })).status, 200)
    const presentation = await probe('/vscode-web/', publicOrigin, 'GET', { host: 'untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid', 'x-forwarded-proto': 'http' }); assert.equal(presentation.status, 200); assert(!presentation.text.includes('untrusted.invalid'))
    // Same stored credentials work after a real clean restart; no token or config reload.
    stage('declared proxy clean restart')
    const tokenBefore = await readFile(join(owned.data, 'state/token'), 'utf8'); await owned.stop(); await owned.start(); await page.reload({ waitUntil: 'domcontentloaded' }); await waitForWebUiReady(page); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
    assert.equal(await readFile(join(owned.data, 'state/token'), 'utf8'), tokenBefore); assert(!await page.$('#token'))
    assert.equal(await page.evaluate(async path => (await fetch(location.pathname + path.slice(1))).status, blobPath), 200)
    assert(proxyUpgrades > 0, 'Actual browser realtime must traverse the prefix proxy.')
    assert.equal(await page.evaluate(async file => (await fetch(location.pathname + 'download?path=' + encodeURIComponent(file))).status, join(owned.work, 'notes.txt')), 200)
  }
  stage('final effects and host shutdown')
  assert.equal(git('rev-parse', 'HEAD'), commit); assert.equal(requests.length, declaredMode ? 6 : 3)
  assert(!codeResponses.some(row => row.status >= 500), JSON.stringify(codeResponses.filter(row => row.status >= 500)))
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', requests: requests.length, codeRequests: codeResponses.length, browserErrors, roots, folders: persisted.folders.length, prefixedWorkbench: !declaredMode, originHeaderIsNotAuthentication: Boolean(declaredMode), declaredMode, proxyUpgrades }))
} catch (error) {
  // Cached frame URLs remain available when the initiating browser operation cannot respond.
  const path = url => new URL(url || 'about:blank').pathname.slice(0, 256)
  console.error(JSON.stringify({ stage: currentStage, browserVersion, prefixNavigation: prefixNavigation?.(), browserErrors: browserErrors.slice(-8).map(value => value.slice(0, 512)), failedRequests: codeResponses.filter(row => row.status >= 500).slice(-8).map(row => ({ path: path(row.url), status: row.status })), host: owned.output, frames: [...(appPage?.frames() || []), ...(extraPage?.isClosed() ? [] : extraPage?.frames() || [])].slice(-16).map(frame => ({ path: path(frame.url()) })) }))
  throw error
}
finally { remoteCli?.kill(); releaseHold(); await owned.cleanup(); if (declaredProxy) { declaredProxy.closeAllConnections(); await new Promise(done => declaredProxy.close(done)) } if (prefixProxy) await new Promise(done => prefixProxy.close(done)); await new Promise(done => peer.close(done)) }
