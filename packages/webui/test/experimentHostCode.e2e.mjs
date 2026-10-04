// Main Code through the original App, official workbench and real browser extensions.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

assert(process.env.FOXWARM_VSCODE_WEB_ASSET_DIR, 'Prepare the pinned official Code workbench assets first.')
const options = { env: {} }, owned = await createHostFixture('code', options)
options.cwd = owned.root
options.env = { HOME: join(owned.root, 'home'), FOXWARM_CONFIG_PATH: join(owned.data, 'state/config.yaml'), FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN: '', FOXWARM_VSCODE_WEB_ASSET_DIR: resolve(process.env.FOXWARM_VSCODE_WEB_ASSET_DIR) }
await mkdir(options.env.HOME)
const git = (...args) => execFileSync('git', ['-C', owned.work, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Code Fixture'); git('config', 'user.email', 'code@example.invalid')
await writeFile(join(owned.work, 'old.txt'), 'first\nselected second\nselected third\nlast\n')
git('add', 'old.txt'); git('commit', '-qm', 'root fixture')
const rootCommit = git('rev-parse', 'HEAD')
git('mv', 'old.txt', 'notes.txt'); await writeFile(join(owned.work, 'binary.bin'), Buffer.from([0, 17, 255])); git('add', '.'); git('commit', '-qm', 'rename and binary fixture')
const commit = git('rev-parse', 'HEAD'), requests = [], failures = [], browserErrors = [], codeResponses = []
await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
let appPage, extraPage, prefixProxy
options.onPage = page => { appPage = page; page.on('pageerror', error => browserErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400) codeResponses.push({ url: response.url(), status: response.status() }) }) }
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const output = body.input.some(row => row.type === 'function_call_output' && row.call_id === 'code-read')
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
  return until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname === '/vscode-web/' && frame.parentFrame() === page.mainFrame()), 'actual Code iframe', 30000)
}
async function frameText(page, pattern) {
  for (const frame of page.frames()) { try { const text = await frame.evaluate(() => document.body.innerText); if (pattern.test(text)) return frame } catch {} }
  return null
}
try {
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions/main/cwd', { cwd: owned.work })).status, 200); const page = await owned.openApp()
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
  assert(!codeResponses.some(row => /foxwarm-terminal/.test(row.url)))
  assert(!await page.$('button[title="Open terminal"]'))
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
  const sidebar = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'sidebar'), 'actual nested Foxwarm sidebar', 30000)
  await sidebar.waitForSelector('[data-session-id="main"]'); assert(!await sidebar.$('button[title="Create terminal tab"]'))
  assert(sidebar.parentFrame() !== code && sidebar.parentFrame().parentFrame() !== page.mainFrame(), 'Sidebar leaf must live inside the official webview frame.')
  await sidebar.click('[data-session-id="main"]')
  const chat = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'chat'), 'actual nested Chat editor', 30000)
  await chat.waitForFunction(() => document.body.innerText.includes('CODE-TURN-DONE')); assert(!await chat.$('button[title="Open terminal"]'))
  await sidebar.click('button[title="UI settings"]'); await sidebar.waitForFunction(() => document.body.innerText.includes('WebUI: Open setup'))
  await sidebar.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'WebUI: Open setup').click())
  const setup = await until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').searchParams.get('foxwarmEmbed') === 'setup'), 'actual nested Setup editor', 30000)
  await setup.waitForFunction(() => document.body.innerText.includes('Models') && document.body.innerText.includes('Setup'))
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
  assert.equal(git('rev-parse', 'HEAD'), commit); assert.equal(requests.length, 3)
  assert(!codeResponses.some(row => row.status >= 500), JSON.stringify(codeResponses.filter(row => row.status >= 500)))
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', requests: requests.length, codeRequests: codeResponses.length, browserErrors, roots, folders: persisted.folders.length, prefixOriginBlocked: true }))
} catch (error) { console.error(JSON.stringify({ browserErrors, failedRequests: [...new Map(codeResponses.filter(row => row.status >= 500).map(row => [row.url, row])).values()], host: owned.output, frames: await Promise.all([...(appPage?.frames() || []), ...(extraPage?.isClosed() ? [] : extraPage?.frames() || [])].map(async frame => ({ url: frame.url(), text: await frame.evaluate(() => document.body.innerText.slice(0, 1800)).catch(() => '') }))) })); throw error }
finally { if (prefixProxy) await new Promise(done => prefixProxy.close(done)); await owned.cleanup(); await new Promise(done => peer.close(done)) }
