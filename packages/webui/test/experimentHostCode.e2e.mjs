// Main Code through the original App, official workbench and real browser extensions.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTlsServer, request as tlsRequest } from 'node:https'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import { writeModelFixture } from './experimentModelFixture.mjs'

const workbenchDir = resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web')
await access(join(workbenchDir, 'out/vs/workbench/workbench.web.main.internal.js'))
const options = { env: {} }, owned = await createHostFixture('code', options)
options.cwd = owned.root
options.env = { HOME: join(owned.root, 'home') }
await mkdir(options.env.HOME)
const git = (...args) => execFileSync('git', ['-C', owned.work, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Code Fixture'); git('config', 'user.email', 'code@example.invalid')
await writeFile(join(owned.work, 'old.txt'), 'first\nselected second\nselected third\nlast\n')
git('add', 'old.txt'); git('commit', '-qm', 'root fixture')
const rootCommit = git('rev-parse', 'HEAD')
git('mv', 'old.txt', 'notes.txt'); await writeFile(join(owned.work, 'binary.bin'), Buffer.from([0, 17, 255])); git('add', '.'); git('commit', '-qm', 'rename and binary fixture')
const commit = git('rev-parse', 'HEAD'), requests = [], failures = [], browserErrors = [], codeResponses = []
await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
let appPage, extraPage, prefixProxy, declaredProxy; const declaredMode = process.env.FOXWARM_CODE_DECLARED_PROXY; let proxyUpgrades = 0
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
  options.publicRoot = declaredMode + '://127.0.0.1:' + declaredProxy.address().port + prefix; options.normalStartup = true
  if (declaredMode === 'https') options.chromeArgs = ['--ignore-certificate-errors']
  await writeFile(join(owned.data, 'state/token'), owned.token, { mode: 0o600 })
  await writeFile(join(owned.data, 'state/config.yaml'), 'url: ' + options.publicRoot + '\nbot:\n  httpPort: ' + owned.port + '\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n')
}
options.onPage = page => { appPage = page; page.on('pageerror', error => browserErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400) codeResponses.push({ url: response.url(), status: response.status() }) }) }
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
const workspaceFile = join(owned.data, 'state/vscode-web/foxwarm.code-workspace')
const workspaceHas = async path => { try { return (JSON.parse(await readFile(workspaceFile, 'utf8')).folders || []).some(folder => (folder.uri ? resolve(decodeURIComponent(new URL(folder.uri).pathname)) : resolve(dirname(workspaceFile), folder.path)) === resolve(path)) } catch (error) { if (error instanceof SyntaxError) return false; throw error } }
async function palette(frame, command) {
  await frame.click('.monaco-workbench')
  const page = frame.page(); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await frame.waitForSelector('.quick-input-widget input'); await frame.type('.quick-input-widget input', command); await page.keyboard.press('Enter')
}
async function codeFrame(page) {
  return until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname.endsWith('/vscode-web/') && frame.parentFrame() === page.mainFrame()), 'actual Code iframe', 30000)
}
async function frameText(page, pattern) {
  for (const frame of page.frames()) { try { const text = await frame.evaluate(() => document.body.innerText); if (pattern.test(text)) return frame } catch {} }
  return null
}
try {
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions/main/cwd', { cwd: owned.work })).status, 200); const page = await owned.openApp()
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="foxwarm-host"]')?.content), 'dotnet')
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), owned.token)
  const loginCookie = (await page.cookies()).find(cookie => cookie.name === 'foxwarm_token'); assert(loginCookie.httpOnly); assert.notEqual(loginCookie.value, owned.token); assert.equal(loginCookie.secure, declaredMode === 'https'); assert.equal(loginCookie.path, declaredMode ? '/published/main/' : '/')
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('response', response => { if (response.url().includes('/vscode-web/')) codeResponses.push({ url: response.url(), status: response.status() }) })
  await page.evaluate(() => window.foxwarmTest.sendMessage('CODE-TURN'))
  await until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await authority(); return !state.busy && state.history.some(row => row.parts?.some(part => part.text?.includes('CODE-TURN-DONE'))) }, 'native turn')
  const state = await authority(), native = state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'code-read').functionResponse
  assert.equal(native.__meta.resolvedPaths[0].resolved, join(owned.work, 'notes.txt'))
  await page.waitForSelector('button[title="Open notes.txt in Code"]'); await page.click('button[title="Open notes.txt in Code"]')
  let code = await codeFrame(page); await code.waitForSelector('.editor-instance .view-lines', { timeout: 40000 })
  await code.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('selected second'))
  await page.evaluate(() => { document.querySelector('iframe[src*="vscode-web"]').dataset.codeProof = 'same-frame' })
  await code.waitForFunction(() => [...document.querySelectorAll('.statusbar-item')].some(item => item.textContent.replaceAll('\u00a0', ' ').includes('(30 selected)')))
  await palette(code, 'Foxwarm: New Terminal')
  await until(async () => (await owned.api('GET', '/api/terminals')).body.terminals.length === 1, 'official Code terminal backend', 30000)
  await code.waitForSelector('.xterm-screen canvas', { timeout: 30000 }); await code.click('.xterm-screen'); await code.page().keyboard.type("printf 'CODE-PTY\\n' > ui-pty.txt"); await code.page().keyboard.press('Enter')
  await until(async () => (await readFile(join(owned.work, 'ui-pty.txt'), 'utf8').catch(() => '')) === 'CODE-PTY\n', 'official Code keyboard reached PTY', 30000)
  await code.click('.xterm-screen'); await code.page().keyboard.type("code --goto notes.txt:2:1"); await code.page().keyboard.press('Enter'); await code.waitForFunction(() => document.body.innerText.includes('Ln 2, Col 1'))
  // Editing uses Code's real model, browser FS provider and authenticated write route.
  await code.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type('\nCode saved line'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
  await until(async () => (await readFile(join(owned.work, 'notes.txt'), 'utf8')).includes('Code saved line'), 'actual Code save')
  await palette(code, 'Foxwarm: Open Foxwarm data folder')
  await until(() => workspaceHas(owned.data), 'data workspace command')
  code = await codeFrame(page); await code.waitForFunction(() => document.body.innerText.includes('Foxwarm Data'))
  await palette(code, 'Foxwarm: Open Foxwarm app folder')
  const roots = (await owned.api('GET', '/api/vscode-web/fs/workspace-roots')).body
  await until(() => workspaceHas(roots.roots.app.path), 'app workspace command')
  assert.equal(await page.evaluate(() => document.querySelector('iframe[src*="vscode-web"]').dataset.codeProof), 'same-frame')
  // Clicking the real marker is the commit bridge producer, not a direct test-only command.
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('button[title="Open commit details in Code"]'); await page.click('button[title="Open commit details in Code"]')
  const detailsFrame = await until(() => frameText(page, /rename and binary fixture[\s\S]*Changed files/), 'real SCM commit webview', 45000)
  assert((await detailsFrame.evaluate(() => document.body.innerText)).includes(owned.work)); assert((await detailsFrame.evaluate(() => document.body.innerText)).includes('binary'))
  const diffButton = await detailsFrame.$('button.file:not([disabled])'); assert(diffButton); await diffButton.click()
  code = await codeFrame(page); await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
  assert(codeResponses.some(row => row.url.includes('/api/vscode-web/git/content') && row.url.includes('ref=')))
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('code[title="' + rootCommit + '"]')
  await page.evaluate(id => document.querySelector('code[title="' + id + '"]').parentElement.parentElement.querySelector('button').click(), rootCommit)
  const rootDetails = await until(() => frameText(page, /root fixture[\s\S]*Changed files/), 'real root commit webview', 30000)
  await (await rootDetails.$('button.file:not([disabled])')).click(); code = await codeFrame(page)
  await code.waitForFunction(() => document.body.innerText.includes('old.txt'))
  await until(() => codeResponses.some(row => row.url.includes('/api/vscode-web/git/content') && row.url.includes('ref=' + rootCommit)), 'root immutable file content')
  // Original Foxwarm sidebar and Setup run in the actual official webview bootstrap.
  await code.click('[aria-label="Foxwarm"]')
  let sidebar = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'sidebar'), 'actual nested Foxwarm sidebar', 30000)
  await sidebar.waitForSelector('[data-session-id="main"]'); assert(await sidebar.$('button[title="Create terminal tab"]'))
  assert(sidebar.parentFrame() !== code && sidebar.parentFrame().parentFrame() !== page.mainFrame(), 'Sidebar leaf must live inside the official webview frame.')
  await sidebar.click('[data-session-id="main"]')
  const chat = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'chat'), 'actual nested Chat editor', 30000)
  await chat.waitForFunction(() => document.body.innerText.includes('CODE-TURN-DONE')); assert(!await chat.$('button[title="Open terminal"]'))
  await sidebar.click('button[title="UI settings"]'); await sidebar.waitForFunction(() => document.body.innerText.includes('WebUI: Open setup'))
  await sidebar.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'WebUI: Open setup').click())
  const setup = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'setup'), 'actual nested Setup editor', 30000)
  await setup.waitForFunction(() => document.body.innerText.includes('Models') && document.body.innerText.includes('Setup'))
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('button[title="Open terminal"]')
  const appTerminalsBefore = (await owned.api('GET', '/api/terminals')).body.terminals
  await page.click('button[title="Open terminal"]')
  await until(async () => (await owned.api('GET', '/api/terminals')).body.terminals.length === appTerminalsBefore.length + 1, 'original App terminal backend', 30000)
  const appTerminal = (await owned.api('GET', '/api/terminals')).body.terminals.find(row => !appTerminalsBefore.some(old => old.id === row.id)); assert(appTerminal)
  await page.waitForSelector('.xterm-screen, .xterm-rows', { timeout: 30000 }); await page.click('.xterm-screen, .xterm-rows'); await page.keyboard.type("printf 'APP-PTY\\n' > app-pty.txt"); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(owned.work, 'app-pty.txt'), 'utf8').catch(() => '')) === 'APP-PTY\n', 'original App keyboard reached PTY', 30000)
  await page.keyboard.type("cd ..; pwd > app-cwd.txt"); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(owned.root, 'app-cwd.txt'), 'utf8').catch(() => '')).trim() === owned.root, 'original App cwd tracking', 30000)
  const appCwd = await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`); assert.equal(appCwd.body.terminal.pid, appTerminal.pid); assert.equal(appCwd.body.terminal.cwd, owned.root)
  const persistedTabId = await until(async () => page.evaluate(id => { try { const saved = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4') || '{}'); const state = saved.state || saved; return Object.entries(state.tabsById || {}).find(([, tab]) => tab.terminalId === id && !tab.createMode)?.[0] || false } catch { return false } }, appTerminal.id), 'original App terminal tab persistence', 30000)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await page.evaluate(id => { window.location.hash = '#tab/' + encodeURIComponent(id) }, persistedTabId); await page.waitForSelector('.xterm-screen, .xterm-rows', { timeout: 30000 })
  const appAfterReload = await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`); assert.equal(appAfterReload.body.terminal.pid, appTerminal.pid); assert.equal(appAfterReload.body.terminal.cwd, owned.root)
  await page.evaluate(() => document.querySelector('[data-tab-id^="terminal:"] button[title="Close tab"], [data-tab-id^="terminal-draft:"] button[title="Close tab"]')?.click())
  await until(async () => (await owned.api('GET', `/api/terminals/${encodeURIComponent(appTerminal.id)}`)).status === 404, 'original App explicit terminal close', 30000)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main')); await page.waitForSelector('.foxwarm-chat-root')
  await page.click('button[title="Open notes.txt in Code"]'); code = await codeFrame(page); await code.waitForSelector('.monaco-workbench', { timeout: 30000 })
  const persisted = JSON.parse(await readFile(join(owned.data, 'state/vscode-web/foxwarm.code-workspace'), 'utf8')); assert(persisted.folders.length >= 3); assert.equal(persisted.settings['yaml.schemaStore.enable'], false)
  assert.equal((await owned.api('GET', '/api/vscode-web/git/commit?workspace=' + encodeURIComponent(owned.work) + '&id=' + rootCommit)).body.comparison.mode, 'empty-tree')
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('button[title="Open code in a new browser tab"]')
  const popupReady = once(page, 'popup'); await page.click('button[title="Open code in a new browser tab"]'); const [popup] = await popupReady; extraPage = popup; popup.on('pageerror', error => browserErrors.push(error.message))
  await popup.waitForSelector('.monaco-workbench', { timeout: 30000 }); const configuration = await popup.evaluate(() => JSON.parse(document.querySelector('#vscode-workbench-web-configuration').getAttribute('data-settings')))
  assert.equal(configuration.folderUri.authority, 'node+master'); assert.equal(resolve(decodeURIComponent(configuration.folderUri.path)), owned.work); assert(!configuration.workspaceUri)
  const rawApp = await readFile(roots.configFiles.app.path, 'utf8')
  const configUrl = new URL(popup.url()); configUrl.searchParams.set('openFilePath', roots.configFiles.app.path); configUrl.searchParams.set('openFileNodeId', 'master')
  await popup.goto(configUrl.toString(), { waitUntil: 'domcontentloaded' }); await popup.waitForSelector('.tab[aria-label*="config.yaml"]'); await popup.click('.tab[aria-label*="config.yaml"]'); await popup.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.includes('maxOutput'), { timeout: 30000 })
  await popup.click('.editor-instance .view-lines'); await popup.keyboard.down('Control'); await popup.keyboard.press('A'); await popup.keyboard.up('Control'); await popup.keyboard.type('llm:\n  maxOutput: "invalid"\n')
  await popup.waitForSelector('.squiggly-error', { timeout: 30000 }); await popup.keyboard.down('Control'); await popup.keyboard.press('S'); await popup.keyboard.up('Control')
  await until(async () => (await readFile(roots.configFiles.app.path, 'utf8')).includes('invalid'), 'human raw YAML save remains advisory')
  await page.evaluate(() => window.foxwarmTest.sendMessage('CONFIG-CAPTURE'))
  await until(() => requests.length === 3, 'unchanged startup app config after Code save'); assert.equal(requests[2].max_output_tokens, 713)
  await popup.click('.editor-instance .view-lines'); await popup.keyboard.down('Control'); await popup.keyboard.press('A'); await popup.keyboard.up('Control'); await popup.keyboard.sendCharacter(rawApp.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')); await popup.keyboard.down('Control'); await popup.keyboard.press('S'); await popup.keyboard.up('Control')
  await until(async () => (await readFile(roots.configFiles.app.path, 'utf8')).replaceAll('\r\n', '\n') === rawApp.replaceAll('\r\n', '\n'), 'restore owned YAML fixture')
  await popup.close()
  if (!declaredMode) {
  // Bootstrap preserves a public prefix without trusting forwarded headers.
  // The existing exact host Origin policy blocks module/PUT requests from the
  // different proxy port; this qualification records that limit, not a bypass.
  prefixProxy = createServer((request, response) => {
    if (!request.url.startsWith('/fixture/')) { response.writeHead(404); response.end(); return }
    const headers = { ...request.headers, host: new URL(owned.origin).host }; delete headers['x-forwarded-host']; delete headers['x-forwarded-proto']
    const upstream = httpRequest(owned.origin + request.url.slice('/fixture'.length), { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', error => response.destroy(error)); request.pipe(upstream)
  }); prefixProxy.listen(0, '127.0.0.1'); await once(prefixProxy, 'listening')
  const prefixed = await page.browser().newPage(); extraPage = prefixed; const prefixResponses = []; prefixed.on('response', response => prefixResponses.push({ url: response.url(), status: response.status() })); const prefixUrl = new URL('http://127.0.0.1:' + prefixProxy.address().port + '/fixture/vscode-web/')
  prefixUrl.searchParams.set('folderUri', configuration.folderUri.scheme + '://' + configuration.folderUri.authority + configuration.folderUri.path); prefixUrl.searchParams.set('openFilePath', join(owned.work, 'notes.txt'))
  assert.equal((await prefixed.goto(prefixUrl.toString(), { waitUntil: 'domcontentloaded' })).status(), 200)
  await until(() => prefixResponses.some(row => row.url.includes('/fixture/vscode-web/static/') && row.status === 403), 'existing Origin policy rejects proxy module request')
  assert(prefixResponses.some(row => row.url.includes('/fixture/vscode-web/static/') && row.status === 200), 'Relative Code CSS must retain the prefix.')
  assert.equal(await prefixed.evaluate(async file => (await fetch('/fixture/api/vscode-web/fs/write-file?path=' + encodeURIComponent(file) + '&overwrite=1', { method: 'PUT', body: 'must not write' })).status, join(owned.work, 'notes.txt')), 403)
  assert((await readFile(join(owned.work, 'notes.txt'), 'utf8')).includes('Code saved line')); await prefixed.close(); await new Promise(done => prefixProxy.close(done)); prefixProxy = null
  } else {
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
    // A browser path-shadow candidate cannot suppress the valid HttpOnly credential.
    await page.setCookie({ name: 'foxwarm_token', value: 'invalid-shadow', url: options.publicRoot, path: '/published/main/api/', httpOnly: false, secure: declaredMode === 'https' })
    assert.equal(await page.evaluate(async () => (await fetch(location.pathname + 'api/sessions')).status), 200)
    // Run queued uses the existing stop/admit/process path and live WebSocket updates.
    await page.evaluate(() => window.foxwarmTest.sendMessage('PUBLIC-HOLD')); await until(() => holdStarted, 'held normal request')
    await page.evaluate(() => window.foxwarmTest.sendMessage('PUBLIC-QUEUED')); await until(async () => (await authority()).queue.length > 0, 'actual queued browser input')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Run queued')))
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Run queued')).click())
    await until(async () => !(await authority()).busy && (await authority()).history.some(row => row.parts?.some(part => part.text === 'PUBLIC-QUEUED-DONE')), 'actual Run queued'); releaseHold()
    const publicOrigin = new URL(options.publicRoot).origin
    const probe = (path, origin, method = 'GET', extras = {}) => new Promise((resolve, reject) => {
      const url = new URL(path.replace(/^\//, ''), options.publicRoot), transport = declaredMode === 'https' ? tlsRequest : httpRequest
      const request = transport(url, { method, rejectUnauthorized: false, headers: { authorization: 'Bearer ' + owned.token, ...(origin === undefined ? {} : { origin }), ...extras } }, response => { let text = ''; response.on('data', data => { text += data }); response.on('end', () => resolve({ status: response.statusCode, text })) }); request.on('error', reject); request.end()
    })
    for (const foreign of ['null', 'not an origin', owned.origin, 'https://foreign.invalid', publicOrigin + ', ' + publicOrigin]) {
      for (const path of ['/api/sessions', blobPath, '/download?path=' + encodeURIComponent(join(owned.work, 'notes.txt')), '/vscode-web/', '/vscode-web/static/out/nls.messages.js']) assert.equal((await probe(path, foreign)).status, 403)
      assert.equal((await probe('/api/auth', foreign, 'POST')).status, 403)
      const socketUrl = options.publicRoot.replace(/^http/, 'ws') + 'api/webui/stream'
      assert.equal(await new Promise((resolve, reject) => { const socket = new WebSocket(socketUrl, { rejectUnauthorized: false, headers: { origin: foreign, authorization: 'Bearer ' + owned.token } }); socket.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.resume() }); socket.on('open', () => { socket.terminate(); reject(new Error('Foreign Origin opened WebSocket')) }); socket.on('error', reject) }), 403)
    }
    assert.equal((await probe('/api/sessions', undefined)).status, 200)
    assert.equal((await probe('/api/sessions', 'https://foreign.invalid', 'GET', { host: new URL(options.publicRoot).host, 'x-forwarded-host': new URL(options.publicRoot).host, 'x-forwarded-proto': declaredMode })).status, 403)
    const presentation = await probe('/vscode-web/', publicOrigin, 'GET', { host: 'untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid', 'x-forwarded-proto': 'http' }); assert.equal(presentation.status, 200); assert(!presentation.text.includes('untrusted.invalid'))
    // Same stored credentials work after a real clean restart; no token or config reload.
    const tokenBefore = await readFile(join(owned.data, 'state/token'), 'utf8'); await owned.stop(); await owned.start(); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
    assert.equal(await readFile(join(owned.data, 'state/token'), 'utf8'), tokenBefore); assert(!await page.$('#token'))
    assert.equal(await page.evaluate(async path => (await fetch(location.pathname + path.slice(1))).status, blobPath), 200)
    assert(proxyUpgrades > 0, 'Actual browser realtime must traverse the prefix proxy.')
    assert.equal(await page.evaluate(async file => (await fetch(location.pathname + 'download?path=' + encodeURIComponent(file))).status, join(owned.work, 'notes.txt')), 200)
  }
  assert.equal(git('rev-parse', 'HEAD'), commit); assert.equal(requests.length, declaredMode ? 6 : 3)
  assert(!codeResponses.some(row => row.status >= 500), JSON.stringify(codeResponses.filter(row => row.status >= 500)))
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', requests: requests.length, codeRequests: codeResponses.length, browserErrors, roots, folders: persisted.folders.length, prefixOriginBlocked: !declaredMode, declaredMode, proxyUpgrades }))
} catch (error) { console.error(JSON.stringify({ browserErrors, failedRequests: [...new Map(codeResponses.filter(row => row.status >= 500).map(row => [row.url, row])).values()], host: owned.output, frames: await Promise.all([...(appPage?.frames() || []), ...(extraPage?.isClosed() ? [] : extraPage?.frames() || [])].map(async frame => ({ url: frame.url(), text: await frame.evaluate(() => document.body.innerText.slice(0, 1800)).catch(() => '') }))) })); throw error }
finally { releaseHold(); await owned.cleanup(); if (declaredProxy) { declaredProxy.closeAllConnections(); await new Promise(done => declaredProxy.close(done)) } if (prefixProxy) await new Promise(done => prefixProxy.close(done)); await new Promise(done => peer.close(done)) }
