// Merged original App on an owned normal .NET host; no substituted UI/API responses.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

assert(process.env.FOXWARM_VSCODE_WEB_ASSET_DIR, 'Set the separately prepared Code-OSS asset directory.')
const options = { normalStartup: true, env: {} }
const host = await createHostFixture('workbench-parity', options)
options.cwd = host.root
options.env = {
  FOXWARM_CONFIG_PATH: join(host.data, 'state/config.yaml'),
  FOXWARM_VSCODE_WEB_ASSET_DIR: resolve(process.env.FOXWARM_VSCODE_WEB_ASSET_DIR),
  FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN: '',
  // YAML assistance is a separate optional preparation contract, not implied by routes.
  FOXWARM_VSCODE_YAML_EXTENSION_DIR: join(host.root, 'unprepared-yaml'),
}
await writeFile(join(host.data, 'state/config.yaml'), `bot:\n  httpPort: ${host.port}\nllm:\n  maxOutput: 713\n`)
const requests = [], errors = [], http = [], browserErrors = []
let releaseFirst, page
const first = new Promise(done => { releaseFirst = done })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    if (requests.length === 1) await first
    await sleep(100)
    const output = body.input.some(row => row.type === 'function_call_output')
      ? [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `WORKBENCH-RESULT: inspected and completed.\n\n<foxwarm-commit node="master" path="${host.work}" id="${commit}" />` }] }]
      : [{ type: 'function_call', call_id: 'measured-exec', name: 'exec', arguments: JSON.stringify({ command: "sleep 0.15; printf 'MEASURED-TOOL-RESULT\\n'", timeout: 2 }) }, { type: 'function_call', call_id: 'read-notes', name: 'read', arguments: JSON.stringify({ filePath: 'notes.txt' }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'workbench-' + requests.length, output, usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
const git = (...args) => execFileSync('git', ['-C', host.work, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Workbench Fixture'); git('config', 'user.email', 'fixture@example.invalid')
await writeFile(join(host.work, 'notes.txt'), 'first\nselected second\nlast\n'); git('add', '.'); git('commit', '-qm', 'workbench fixture')
const commit = git('rev-parse', 'HEAD')
let sessionId
const route = suffix => '/api/sessions/' + encodeURIComponent(sessionId) + suffix
const state = async () => (await host.api('GET', route('/history'))).body
const savedLayout = () => page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state)
const panes = root => root.kind === 'pane' ? [root] : root.children.flatMap(panes)
const click = async selector => { await waitForWebUiReady(page); await page.waitForSelector(selector, { visible: true }); await page.locator(selector).click() }
const chat = async () => { await waitForWebUiReady(page); await page.evaluate(id => window.foxwarmTest.switchToSession(id), sessionId); await page.waitForSelector('.foxwarm-chat-root', { visible: true }) }
const codeFrame = () => until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname.endsWith('/vscode-web/') && frame.parentFrame() === page.mainFrame()), 'official Code iframe')
async function palette(frame, command) {
  await frame.click('.monaco-workbench'); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await frame.waitForSelector('.quick-input-widget input'); await frame.type('.quick-input-widget input', command); await page.keyboard.press('Enter')
}
async function closeJson() { await click('[data-json-inspector-dialog] [aria-label="Close"]'); await page.waitForSelector('[data-json-inspector-dialog]', { hidden: true }) }
try {
  await host.start()
  assert.equal((await host.api('POST', '/api/agents', { agentId: 'parity' })).status, 201)
  const created = await host.api('POST', '/api/sessions', { agentId: 'parity', sessionId: 'workbench' }); assert.equal(created.status, 200, JSON.stringify(created)); sessionId = created.body.sessionId
  assert.equal((await host.api('POST', route('/cwd'), { cwd: host.work })).status, 200)
  assert.equal((await host.api('POST', '/api/tasks', { title: 'Parity open task' })).status, 201)
  const active = await host.api('POST', '/api/tasks', { title: 'Parity active task', ownerSessionId: sessionId }); assert.equal(active.status, 201)
  assert.equal((await host.api('PATCH', '/api/tasks/' + active.body.task.id, { status: 'active', sessionId })).status, 200)
  options.publicRoot = host.origin + '/#session/' + encodeURIComponent(sessionId)
  page = await host.openApp(); await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('response', async response => http.push({ path: new URL(response.url()).pathname, status: response.status(), ...(response.status() >= 500 ? { error: await response.text().catch(() => '') } : {}) }))
  await page.evaluate(() => { localStorage.setItem('foxwarm_timeline_view_v1', 'conversation'); localStorage.setItem('foxwarm_code_open_new_window_v1', 'false') })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await chat()
  assert.equal(await page.$$eval('.foxwarm-chat-root button[title="Code"]', buttons => buttons.length), 1)
  assert.equal(await page.$('.foxwarm-chat-root button[title="Open code in a new browser tab"]'), null)
  await page.evaluate(() => window.foxwarmTest.sendMessage('WORKBENCH-PARITY'))
  await until(() => requests.length === 1, 'real model request')
  await page.waitForSelector('[aria-label="Running sessions: 1"]')
  releaseFirst()
  const history = await until(async () => { const value = await state(); return !value.session.busy && value.messages.some(row => row.parts?.some(part => part.text?.includes('WORKBENCH-RESULT'))) && value }, 'committed tool and final result')
  const modelRows = history.messages.filter(row => row.__meta?.llmRequestId)
  assert.equal(modelRows.length, 2)
  for (const row of modelRows) assert(row.__meta.llmRequestTiming.durationMs >= 90, JSON.stringify(row.__meta))
  const receipt = history.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'measured-exec').functionResponse
  assert(receipt.executionTiming.durationMs >= 100, JSON.stringify(receipt))
  assert.match(receipt.response.output, /MEASURED-TOOL-RESULT/)
  await page.waitForSelector('[data-conversation-statistics]')
  await page.waitForFunction(() => document.body.innerText.includes('WORKBENCH-RESULT'))
  assert.equal(await page.$('[data-activity-details]'), null, 'Result is visible without expanding process details')
  await click('[aria-label="Expand activity"]'); await page.waitForSelector('[data-activity-details]')
  assert.match(await page.$eval('[data-activity-details]', element => element.textContent), /exec/)
  const summary = (await host.api('GET', '/api/session-list/architecture?limit=10')).body
  assert.equal(summary.summary.cachedTokens, 20); assert.equal(summary.summary.inputTokens, 60); assert.equal(summary.summary.outputTokens, 10)
  await page.waitForFunction(() => document.querySelector('[aria-label="Current Session token usage"]')?.textContent.includes('90'))
  await click('[aria-label="Current Session token usage"]')
  assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /Cached20.*Input60.*Output10/)
  await page.keyboard.press('Escape')
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await chat()
  await page.waitForSelector('[aria-label="Tasks: 1 active, 2 unfinished"]')
  await click('[aria-label="Tasks: 1 active, 2 unfinished"]'); await page.waitForFunction(() => document.querySelector('[data-workbench-status-popup]')?.textContent.includes('Parity active task'))
  assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /Parity open task/); await page.keyboard.press('Escape')

  // The Debug endpoint and Timeline share the original lazy JSON inspector.
  await click('button[aria-label="Open session options"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'debug info'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info').click())
  await page.waitForSelector('[data-json-inspector-dialog] [data-editor-ready="true"]'); await closeJson()
  assert(http.some(row => row.path.endsWith('/debug-file') && row.status === 200))
  // Detailed view exposes a canonical message JSON action; this changes presentation only.
  await page.evaluate(() => localStorage.setItem('foxwarm_timeline_view_v1', 'detailed')); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await chat()
  await page.waitForSelector('.foxwarm-assistant-message-card [title="JSON"]')
  await page.$eval('.foxwarm-assistant-message-card [title="JSON"]', button => button.click())
  await page.waitForSelector('[data-json-inspector-dialog] [data-editor-ready="true"]'); await closeJson()
  // A real split preserves Chat DOM and draft without issuing another history initialization.
  await page.evaluate(() => { location.hash = 'architecture' }); await page.waitForSelector('.foxwarm-architecture-surface-tab'); await chat()
  await page.type('[role="textbox"][aria-label="Message"]', 'retained normal-host draft')
  await page.evaluate(() => { window.parityChat = document.querySelector('.foxwarm-chat-root') })
  const historyReads = http.filter(row => row.path.endsWith('/history')).length
  await click('button[title="Split right with active tab"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.kind === 'split')
  assert(await page.evaluate(() => window.parityChat === document.querySelector('.foxwarm-chat-root')))
  assert.equal(http.filter(row => row.path.endsWith('/history')).length, historyReads)
  assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', node => node.textContent), 'retained normal-host draft')

  // Normal history search remains Vector-disabled. Draft edits preserve that submitted error/title.
  await page.evaluate(() => { location.hash = 'tab/history:parity' })
  await page.waitForSelector('[data-history-query-input]'); await page.type('[data-history-query-input]', 'submitted query'); await page.keyboard.press('Enter')
  await page.waitForSelector('[data-history-search-view] [role="alert"]')
  const submittedError = await page.$eval('[data-history-search-view] [role="alert"]', node => node.textContent)
  const historyResponse = await host.api('GET', '/api/history/search?query=submitted%20query'); assert.equal(historyResponse.body.code, 'VECTOR_DISABLED')
  await page.type('[data-history-query-input]', ' draft only')
  assert((Object.values((await savedLayout()).tabsById).find(tab => tab.type === 'search')).title.includes('submitted query'))
  assert.equal(await page.$eval('[data-history-search-view] [role="alert"]', node => node.textContent), submittedError)

  // Desktop dock/reload/collapse retains the actual PTY; explicit pane Close deletes it.
  await chat(); await click('[aria-label="Toggle terminal"]'); await page.waitForSelector('[data-terminal-header]', { visible: true })
  const terminal = await until(async () => (await host.api('GET', '/api/terminals')).body.terminals[0], 'real docked terminal')
  assert.equal(terminal.cwd, host.work)
  await click('.xterm-screen'); await page.keyboard.type("printf 'DOCKED-PTY\\n' > docked.txt"); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(host.work, 'docked.txt'), 'utf8').catch(() => '')) === 'DOCKED-PTY\n', 'keyboard reached real PTY')
  let layout = await savedLayout(), terminalTab = Object.values(layout.tabsById).find(tab => tab.type === 'terminal')
  let terminalPane = panes(layout.root).find(pane => pane.tabIds.includes(terminalTab.id))
  assert(terminalPane && terminalPane.tabIds.length === 1)
  await click('[aria-label="Toggle terminal"]'); assert.equal((await host.api('GET', '/api/terminals/' + terminal.id)).body.terminal.pid, terminal.pid)
  await click('[aria-label="Toggle terminal"]'); await page.waitForSelector('[data-terminal-header]', { visible: true })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('[data-terminal-header]', { visible: true })
  assert.equal((await host.api('GET', '/api/terminals/' + terminal.id)).body.terminal.pid, terminal.pid)
  layout = await savedLayout(); terminalTab = Object.values(layout.tabsById).find(tab => tab.type === 'terminal'); terminalPane = panes(layout.root).find(pane => pane.tabIds.includes(terminalTab.id))
  assert.equal(terminalPane.tabIds.length, 1)
  await click(`[data-workbench-content-pane="${terminalPane.id}"] button[aria-label="Close pane"]`)
  await until(async () => (await host.api('GET', '/api/terminals/' + terminal.id)).status === 404, 'explicit terminal pane Close')

  // Original official Code-OSS and browser FS/SCM/terminal extensions, with 1.128 assets.
  await chat(); await click('.foxwarm-chat-root button[title="Code"]')
  let code = await codeFrame(); await code.waitForSelector('.monaco-workbench', { timeout: 45000 })
  await page.evaluate(() => { window.parityCode = document.querySelector('[data-foxwarm-vscode-web-frame]'); window.parityCodeWindow = window.parityCode.contentWindow })
  await chat(); await click('button[title="Open notes.txt in Code"]'); code = await codeFrame()
  await code.waitForSelector('.editor-instance .view-lines', { timeout: 45000 })
  await code.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type('\nOfficial Code saved'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
  await until(async () => (await readFile(join(host.work, 'notes.txt'), 'utf8')).includes('Official Code saved'), 'official browser FS saved')
  assert(await page.evaluate(() => window.parityCode === document.querySelector('[data-foxwarm-vscode-web-frame]') && window.parityCodeWindow === window.parityCode.contentWindow))
  await palette(code, 'Foxwarm: New Terminal')
  const codeTerminal = await until(async () => (await host.api('GET', '/api/terminals')).body.terminals[0], 'official Code terminal extension')
  await code.waitForSelector('.xterm-screen', { timeout: 30000 }); await code.click('.xterm-screen'); await page.keyboard.type("printf 'CODE-EXTENSION\\n' > code-extension.txt"); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(host.work, 'code-extension.txt'), 'utf8').catch(() => '')) === 'CODE-EXTENSION\n', 'official terminal extension keyboard')
  const details = await host.api('GET', '/api/vscode-web/git/commit?workspace=' + encodeURIComponent(host.work) + '&id=' + commit); assert.equal(details.body.commit.oid, commit)
  assert.equal((await host.api('GET', '/api/vscode-web/git/status?workspace=' + encodeURIComponent(host.work))).body.changes.some(row => row.path === 'notes.txt'), true)
  await host.api('DELETE', '/api/terminals/' + codeTerminal.id)
  await chat(); await click('button[title="Open commit details in Code"]')
  const scm = await until(async () => {
    for (const frame of page.frames()) {
      try {
        const text = await frame.evaluate(() => document.body.innerText)
        if (text.includes('workbench fixture') && text.includes('Changed files')) return frame
      } catch { /* A transient webview bootstrap frame may detach before its content loads. */ }
    }
  }, 'official SCM commit webview', 30000)
  await scm.click('button.file:not([disabled])'); code = await codeFrame()
  await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
  assert(http.some(row => row.path === '/api/vscode-web/git/content' && row.status === 200))
  await chat(); await page.evaluate(() => localStorage.setItem('foxwarm_code_open_new_window_v1', 'true'))
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession); await chat()
  const popupReady = once(page, 'popup'); await click('.foxwarm-chat-root button[title="Code"]'); const [popup] = await popupReady
  await popup.waitForSelector('.monaco-workbench', { timeout: 45000 })
  assert.equal(new URL(popup.url()).searchParams.get('embedded'), null)
  await popup.close()
  assert.deepEqual(errors, [])
  assert(!http.some(row => row.status >= 500 && row.path !== '/api/history/search'), JSON.stringify(http.filter(row => row.status >= 500)))
  const assets = JSON.parse(await readFile(join(options.env.FOXWARM_VSCODE_WEB_ASSET_DIR, 'foxwarm-vscode-web-assets.json'), 'utf8'))
  console.log(JSON.stringify({ result: 'passed', normalHost: true, originalApp: true, requests: requests.length, measuredRequests: modelRows.length, toolTiming: receipt.executionTiming, summary: summary.summary, codeAssets: assets, yamlAssistanceQualified: false, browserErrors, limits: ['No Vector search; real VECTOR_DISABLED response preserved.', 'Remote Node/OAuth/Anthropic use prior unchanged qualifications.', '1.141 runtime assets not prepared or qualified.'] }))
  await host.stop()
} catch (error) { console.error(JSON.stringify({ host: host.output, browserErrors, httpFailures: http.filter(row => row.status >= 400), terminals: (await host.api('GET', '/api/terminals')).body, text: await page?.evaluate(() => document.body.innerText).catch(() => ''), frames: page?.frames().map(frame => frame.url()) })); throw error }
finally { releaseFirst(); await host.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
