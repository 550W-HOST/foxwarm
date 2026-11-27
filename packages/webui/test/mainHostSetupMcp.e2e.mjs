// Setup > MCP against a real Main server and real official-SDK MCP peers: opening the tab
// doesn't connect, Check, a Session's discovery as the last observation, adding a stdio server,
// a refused invalid save, an edit that keeps a hidden literal token, a save refused after an
// Agent's mcp_config changed the server, Reload, disable, delete, and administrator-only routes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { functionCall } from './ctlModelCalls.mjs'
import { chooseSelectOption } from './selectDriver.mjs'

const fixture = await createHostFixture('setup-mcp')
const peerFile = resolve(import.meta.dirname, 'mainHostMcp.peer.mjs')
const peerRoot = join(fixture.root, 'peer')
const mcpFile = join(fixture.data, 'state/mcp.json')
const scopedToken = 'synthetic-setup-mcp-viewer'
const literalToken = 'synthetic-explicit-auth'
const textOf = item => (item.content || []).map(part => part.text || '').join('')
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const scripts = new Map(), failures = []
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const key = [...body.input.filter(item => item.role === 'user').map(textOf).join('\n').matchAll(/MCP-TASK:([a-z0-9-]+)/g)].at(-1)?.[1]
    const calls = scripts.get(key) || []
    const answered = calls.every(call => body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'setup-mcp-' + Date.now(), output: answered ? final('DONE-' + key) : calls, usage: { input_tokens: 40, output_tokens: 5 } } }) + '\n\n')
    response.end()
  } catch (error) { failures.push(String(error.stack || error)); if (!response.headersSent) response.writeHead(500); response.end() }
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')

const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
async function run(id, key, calls) {
  scripts.set(key, calls)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'MCP-TASK:' + key })).status, 202)
  await until(async () => (await history(id)).messages.some(row => row.parts?.some(part => part.text === 'DONE-' + key)), key + ' final')
  await until(async () => !(await history(id)).session.busy, key + ' idle')
  const results = {}
  for (const call of calls) results[call.call_id] = (await history(id)).messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === call.call_id)?.functionResponse.response
  return results
}
const scoped = (method, path, body) => fetch(fixture.origin + path, {
  method, headers: { authorization: 'Bearer ' + scopedToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const stored = async () => JSON.parse(await readFile(mcpFile, 'utf8')).servers
const peerEvents = async () => (await readFile(join(peerRoot, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

let httpPeer, page
try {
  await mkdir(peerRoot, { recursive: true })
  httpPeer = spawn(process.execPath, [peerFile, 'http', peerRoot, 'http-label'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = ''; httpPeer.stdout.on('data', bytes => { ready += bytes }); httpPeer.stderr.on('data', bytes => failures.push('HTTP peer: ' + bytes))
  await until(() => ready.includes('\n'), 'HTTP peer')
  const httpPort = JSON.parse(ready.trim().split('\n')[0]).port

  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\naccess:\n  identities:\n    viewer:\n      token: ${scopedToken}\n      surfaces:\n        webui:\n          sessions: [main/*]\n`)
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'synthetic-setup-mcp', models: ['wire'] } } }))
  await writeFile(mcpFile, JSON.stringify({ servers: { remote: { transport: 'streamable-http', url: `http://127.0.0.1:${httpPort}/mcp`, token: literalToken, headers: { 'X-Trace': 'visible-header' } } } }))
  await fixture.start()
  const session = (await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'probe' })).body.sessionId

  // The Setup view of a stored server: values as stored, the literal token as a placeholder.
  const loaded = await fixture.api('GET', '/api/setup/mcp')
  assert.equal(loaded.status, 200, JSON.stringify(loaded))
  assert(!JSON.stringify(loaded.body).includes(literalToken), 'a literal token never reaches the browser')
  const remote = loaded.body.servers.find(entry => entry.name === 'remote')
  assert.deepEqual(remote.server.token, { hidden: 'token' })
  assert.deepEqual(remote.server.headers, { 'X-Trace': 'visible-header' })
  assert.equal(remote.observed, null)
  assert.match(remote.revision, /^sha256:[0-9a-f]{64}$/)

  // Administrator-only.
  assert.equal((await fetch(fixture.origin + '/api/sessions', { headers: { authorization: 'Bearer ' + scopedToken } })).status, 200)
  assert.equal((await scoped('GET', '/api/setup/mcp')).status, 403)
  assert.equal((await scoped('PUT', '/api/setup/mcp/remote', { server: { transport: 'auto', url: 'http://127.0.0.1:1/mcp' }, revision: remote.revision })).status, 403)
  assert.equal((await scoped('POST', '/api/setup/mcp/remote/check', {})).status, 403)
  assert.equal((await scoped('POST', '/api/setup/mcp/remote/delete', { revision: remote.revision })).status, 403)
  assert.equal((await stored()).remote.url, `http://127.0.0.1:${httpPort}/mcp`)

  page = await fixture.openApp()
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-mcp')
  await page.click('#setup-tab-mcp')
  const row = name => `[data-mcp-server="${name}"]`
  const status = async name => page.$eval(`${row(name)} [data-mcp-status]`, node => ({ state: node.getAttribute('data-mcp-status'), text: node.textContent }))
  const waitStatus = (name, state) => page.waitForFunction((selector, expected) => document.querySelector(selector)?.getAttribute('data-mcp-status') === expected, { timeout: 30000 }, `${row(name)} [data-mcp-status]`, state)
  const click = async selector => { await page.waitForSelector(selector, { visible: true }); await page.click(selector) }
  const typeInto = async (selector, text) => { await page.waitForSelector(selector, { visible: true }); await page.click(selector, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(selector, text) }
  const form = '[data-mcp-form]'
  const rowMenu = async (name, item) => {
    await click(`${row(name)} [data-mcp-action="more"]`)
    await page.waitForSelector('[role="menu"] [role="menuitem"]', { visible: true })
    for (const handle of await page.$$('[role="menu"] [role="menuitem"]')) if ((await handle.evaluate(node => node.textContent?.trim())) === item) { await handle.click(); return }
    throw new Error('Missing row menu item ' + item)
  }
  const formError = async () => until(async () => page.$eval(`${form} [data-mcp-form-error]`, node => node.textContent).catch(() => null), 'form error', 10000)

  // Opening the tab shows the last observation (none) and doesn't connect.
  await page.waitForSelector(row('remote'))
  assert.equal((await status('remote')).state, 'unknown')
  assert.equal((await peerEvents()).filter(event => event.event === 'http').length, 0, 'opening Setup made no MCP request')

  // Check connects once, with the hidden token, and reports the tool count.
  await click(`${row('remote')} [data-mcp-action="check"]`)
  await waitStatus('remote', 'connected')
  assert.match((await status('remote')).text, /21 tools/)
  assert.match((await status('remote')).text, /^Connected · 21 tools · (Now|\d+m ago)$/)
  assert.match(await page.$eval(`${row('remote')} [data-mcp-status]`, node => node.title), /\d/)
  assert((await peerEvents()).some(event => event.event === 'http' && event.authMatched))

  // A Session's discovery becomes the last observation too.
  const discovered = await run(session, 'discover', [functionCall('discover', 'search_tools', { query: 'echo_effect' })])
  assert.equal(discovered.discover?.error, undefined, JSON.stringify(discovered))
  const observed = (await fixture.api('GET', '/api/setup/mcp')).body.servers.find(entry => entry.name === 'remote').observed
  assert.equal(observed.ok, true); assert.equal(observed.toolCount, 21)

  // Add a stdio server through the form; saving checks it.
  await click('[data-mcp-add]')
  await typeInto(`${form} [data-mcp-field="name"]`, 'local')
  await chooseSelectOption(page, `${form} [data-mcp-field="transport"]`, 'stdio')
  await typeInto(`${form} [data-mcp-field="command"]`, process.execPath)
  for (const [index, value] of [peerFile, 'stdio', peerRoot, 'ui-label'].entries()) {
    await click(`${form} button::-p-text(Add argument)`)
    await typeInto(`${form} [aria-label="Argument ${index + 1}"]`, value)
  }
  await click(`${form} button::-p-text(Add variable)`)
  await typeInto(`${form} [aria-label="Variable name 1"]`, 'MCP_SYNTHETIC_ENV')
  await typeInto(`${form} [aria-label="Variable value 1"]`, 'configured-test-value')
  await click(`${form} button[type="submit"]`)
  await page.waitForSelector(row('local'))
  await waitStatus('local', 'connected')
  const added = (await stored()).local
  assert.deepEqual({ transport: added.transport, command: added.command, args: added.args, env: added.env }, { transport: 'stdio', command: process.execPath, args: [peerFile, 'stdio', peerRoot, 'ui-label'], env: { MCP_SYNTHETIC_ENV: 'configured-test-value' } })
  assert((await peerEvents()).some(event => event.label === 'ui-label' && event.event === 'list'))

  // An invalid save is refused with the validation error, and the file is unchanged.
  const before = await readFile(mcpFile, 'utf8')
  await click(`${row('remote')} [data-mcp-action="edit"]`)
  await chooseSelectOption(page, `${form} [data-mcp-field="transport"]`, 'stdio')
  await click(`${form} button[type="submit"]`)
  assert.match(await formError(), /stdio requires command/)
  assert.equal(await readFile(mcpFile, 'utf8'), before)
  await click(`${form} button::-p-text(Cancel)`)

  // An edit keeps the hidden token where it was stored.
  await click(`${row('remote')} [data-mcp-action="edit"]`)
  await page.waitForSelector(`${form} [data-mcp-hidden-value]`)
  await typeInto(`${form} [data-mcp-field="timeoutSeconds"]`, '30')
  await click(`${form} button[type="submit"]`)
  await page.waitForFunction(selector => !document.querySelector(selector), {}, form)
  await waitStatus('remote', 'connected')
  assert.deepEqual({ token: (await stored()).remote.token, timeoutSeconds: (await stored()).remote.timeoutSeconds, header: (await stored()).remote.headers['X-Trace'] }, { token: literalToken, timeoutSeconds: 30, header: 'visible-header' })

  // An Agent changes the server while the form is open: the save is refused, Reload shows the change.
  await click(`${row('remote')} [data-mcp-action="edit"]`)
  const changed = await run(session, 'agent-change', [functionCall('agent-change', 'mcp_config', { name: 'remote', timeoutSeconds: 45 })])
  assert.equal(changed['agent-change']?.error, undefined, JSON.stringify(changed))
  await typeInto(`${form} [aria-label="Header value 1"]`, 'stale-edit')
  await click(`${form} button[type="submit"]`)
  assert.match(await formError(), /This server changed after you opened it/)
  assert.equal((await stored()).remote.timeoutSeconds, 45)
  assert.equal((await stored()).remote.headers['X-Trace'], 'visible-header')
  await click(`${form} [data-mcp-reload]`)
  await page.waitForFunction(selector => document.querySelector(selector)?.value === '45', { timeout: 10000 }, `${form} [data-mcp-field="timeoutSeconds"]`)
  await click(`${form} button::-p-text(Cancel)`)

  // Disable, then delete.
  await rowMenu('local', 'Disable')
  await waitStatus('local', 'disabled')
  assert.equal((await stored()).local.enable, false)
  assert.equal(await page.$(`${row('local')} [data-mcp-action="check"]`), null)
  await rowMenu('local', 'Delete')
  await page.waitForSelector(`${row('local')} [data-mcp-confirm-delete]`)
  assert.match(await page.$eval(`${row('local')} [data-mcp-confirm-delete]`, node => node.textContent), /^Delete local\? Agents lose its tools, and its sign-in is removed\./)
  await click(`${row('local')} [data-mcp-action="confirm-delete"]`)
  await page.waitForFunction(selector => !document.querySelector(selector), { timeout: 10000 }, row('local'))
  assert.equal((await stored()).local, undefined)

  // A delete with an old revision is refused as well.
  const stale = await fixture.api('POST', '/api/setup/mcp/remote/delete', { revision: remote.revision })
  assert.equal(stale.status, 409, JSON.stringify(stale))
  assert.equal(stale.body.code, 'server_changed')
  assert.ok((await stored()).remote)

  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ result: 'ok', noConnectOnOpen: true, check: true, sessionObservation: true, added: true, invalidRefused: true, hiddenTokenKept: true, staleRefused: true, reloaded: true, disabled: true, deleted: true, scopedDenied: true }))
} finally {
  await fixture.cleanup()
  httpPeer?.kill()
  provider.closeAllConnections(); await new Promise(done => provider.close(done))
}
