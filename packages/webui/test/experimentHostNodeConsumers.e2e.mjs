// Real Main-private credentials, original composer selection, and process-duration consumers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const env = {  }
const options = { env, normalStartup: true }
const fixture = await createHostFixture('node-consumers', options)
options.cwd = fixture.root
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `bot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n`)
const prefix = '/consumer-proof'
await writeFile(join(fixture.data, 'state/config.yaml'), (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'url: ' + fixture.origin + prefix + '\n')
options.publicRoot = fixture.origin + prefix + '/'
const host = fixture.origin + prefix, plans = new Map(), requests = [], failures = [], clients = [], sockets = [], secrets = []
let releaseHeld
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CONSUMER-DONE-' + key }] }]
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    assert(!(body.tools || []).some(tool => tool.name === 'node_create_auth_token'), 'private credential tool stays default-hidden')
    const prompt = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/CONSUMER:([\w-]+)/g)].at(-1)?.[1] || 'completion'
    const calls = plans.get(key) || []
    const followup = calls.length && calls.every(call => body.input.some(row => row.type === 'function_call_output' && row.call_id === call.call_id))
    const complete = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: followup || !calls.length ? final(key) : calls, usage: { input_tokens: 35, output_tokens: 4 } } }) + '\n\n')
    }
    if (key === 'held') releaseHeld = complete
    else complete()
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
async function create(name, agent = 'main') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name })
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId
}
async function turn(id, key, calls) {
  plans.set(key, calls)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CONSUMER:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'CONSUMER-DONE-' + key)) ? state : null
  }, key)
}
const online = id => until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === id && node.online && node.executable), id + ' authenticated')
function client(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }), handle = { child, output: '' }
  child.stdout.on('data', bytes => { handle.output += bytes }); child.stderr.on('data', bytes => { handle.output += bytes }); clients.push(handle); return handle
}
async function stop(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) { const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM'); await exited }
}
async function privateCredential(actor, id, path, native = false) {
  const state = await turn(actor, 'credential-' + id, [native
    ? call('credential-' + id, 'run_script', { code: `return call_tool('builtin:node_create_auth_token', {'nodeId': '${id}', 'filePath': '${path}'})` })
    : call('credential-' + id, 'call_tool', { toolId: 'builtin:node_create_auth_token', args: { nodeId: id, filePath: path } })])
  const result = pair(state, 'credential-' + id), value = native ? result.result : result
  if (native) assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.deepEqual(value, { nodeId: id, filePath: path })
  const content = await readFile(path, 'utf8'); assert.match(content, /^[a-f0-9]{64}\n$/); secrets.push(content.trim())
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert(!JSON.stringify(state).includes(content.trim()))
  return content.trim()
}
try {
  await fixture.start()
  const actor = await create('consumer')
  assert.equal((await fetch(host + route(actor) + '/nodes')).status, 401)
  assert.equal((await fetch(host + route(actor) + '/node', { method: 'POST', body: JSON.stringify({ nodeId: 'master' }), headers: { 'content-type': 'application/json' } })).status, 401)
  assert.equal((await fixture.api('GET', route('missing') + '/nodes')).status, 404)
  assert.equal((await fixture.api('POST', route('missing') + '/node', { nodeId: 'master' })).status, 404)
  let state = await turn(actor, 'discover', [call('discover', 'search_tools', { sources: ['builtin'], query: 'node_create_auth_token', limit: 1 })])
  assert.match(pair(state, 'discover').output, /builtin:node_create_auth_token/)
  const cliToken = await privateCredential(actor, 'owned-cli', join(fixture.work, 'cli-token'))
  const remote = join(fixture.root, 'cli'); await mkdir(join(remote, 'agents/main'), { recursive: true })
  const credentials = join(remote, 'credentials.json'); await writeFile(credentials, JSON.stringify({ nodeId: 'owned-cli', authToken: cliToken }), { mode: 0o600 })
  const cli = client(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', host, '--credentials-file', credentials, '--no-local-trigger'], { cwd: remote, env: { ...process.env, FOXWARM_AGENTS_DIR: join(remote, 'agents') } })
  await online('owned-cli')
  const cwd = join(remote, 'project'); await mkdir(cwd)
  assert.equal((await fixture.api('POST', route(actor) + '/cwd', { cwd })).status, 200)
  const page = await fixture.openApp(); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForSelector('.foxwarm-node-picker-trigger'); await page.click('.foxwarm-node-picker-trigger')
  await page.waitForSelector('[data-node-option="owned-cli"]:not([disabled])'); await page.click('[data-node-option="owned-cli"]')
  await page.waitForSelector('.foxwarm-node-picker-trigger[aria-label="Execution node: owned-cli"]')
  state = await saved(actor); assert.equal(state.currentNode, 'owned-cli'); assert.equal(state.cwd, cwd)
  state = await turn(actor, 'remote-write', [call('remote-write', 'write', { filePath: 'picker-effect', content: 'real-composer-node' })])
  assert(!pair(state, 'remote-write').error); assert.equal(await readFile(join(cwd, 'picker-effect'), 'utf8'), 'real-composer-node')
  // Main-owned private builtin and native Monty remain reachable with a real remote execution placement.
  const shellToken = await privateCredential(actor, 'owned-shell', join(fixture.work, 'shell-token'), true)
  const offlineToken = await privateCredential(actor, 'offline-node', join(fixture.work, 'offline-token'))
  assert(offlineToken)
  const unsupported = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'upgrade-node' })).body
  const socket = new WebSocket(host.replace(/^http/, 'ws') + '/node_ws?id=upgrade-node&auth=' + unsupported.authToken); sockets.push(socket)
  await once(socket, 'open'); const registered = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'node_register', nodeType: 'owned-incompatible', nodeProtocol: { min: 99, max: 100 }, capabilities: { tools: [] } })); await registered
  await page.click('.foxwarm-node-picker-trigger'); await page.waitForSelector('[data-node-option="offline-node"][disabled]')
  assert.equal(await page.$eval('[data-node-option="offline-node"]', el => el.title), 'Offline')
  assert.equal(await page.$eval('[data-node-option="upgrade-node"]', el => el.title), 'Update this node to connect.')
  await page.keyboard.press('Escape')
  // The new production Nodes tab consumes the existing directory and onboarding services.
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.waitForSelector('[data-workbench-status-popup] [aria-label="Node directory"]')
  await page.evaluate(() => [...document.querySelectorAll('[data-workbench-status-popup] button')].find(button => button.textContent === 'Open Nodes').click())
  await page.waitForSelector('[data-node-surface]')
  await page.waitForFunction(() => document.querySelector('[data-node-surface]')?.textContent.includes('offline-node'))
  const cards = await page.$$eval('[data-node-surface] article', rows => rows.map(row => row.textContent))
  assert(cards.some(text => text.includes('owned-cli') && text.includes('Online')))
  assert(cards.some(text => text.includes('offline-node') && text.includes('Offline')))
  assert(cards.some(text => text.includes('upgrade-node') && text.includes('Upgrade required')))
  assert(cards.some(text => text.includes('master')))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'New nodes').click())
  await page.waitForSelector('[role="dialog"][aria-labelledby="node-onboarding-title"]')
  assert((await page.$eval('[role="dialog"][aria-labelledby="node-onboarding-title"]', node => node.textContent)).includes('Shell'))
  await page.waitForFunction(expected => document.querySelector('[aria-label="Reachable address"]')?.value === expected, {}, host)
  await page.keyboard.press('Escape')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForSelector('.foxwarm-node-picker-trigger[aria-label="Execution node: owned-cli"]')
  assert.equal((await fixture.api('POST', route(actor) + '/node', { nodeId: 'offline-node' })).status, 400)
  assert.equal((await fixture.api('POST', route(actor) + '/node', { nodeId: 'upgrade-node' })).status, 400)
  assert.equal((await fixture.api('POST', route(actor) + '/node', { nodeId: '' })).status, 400)
  const selected = await fixture.api('POST', route(actor) + '/node', { nodeId: 'owned-cli' }); assert.equal(selected.status, 200); assert.equal(selected.body.session.cwd, cwd)
  for (const renamed of [false, true]) {
    const fault = join(fixture.data, 'state/experiment-faults', 'id_' + Buffer.from(actor).toString('base64url') + (renamed ? '.settings-after-rename' : '.settings-before-rename'))
    await mkdir(join(fixture.data, 'state/experiment-faults'), { recursive: true }); await writeFile(fault, 'owned-fault')
    const result = await fixture.api('POST', route(actor) + '/node', { nodeId: 'master' }); assert.equal(result.status, 400)
    state = await saved(actor); assert.equal(state.currentNode, renamed ? 'master' : 'owned-cli'); assert.equal(state.cwd, cwd)
    assert.equal((await fixture.api('GET', route(actor) + '/history')).body.session.currentNode, state.currentNode)
  }
  // The original composer permits Node selection while busy; do not add an unrelated restriction.
  plans.set('held', []); assert.equal((await fixture.api('POST', route(actor) + '/message', { text: 'CONSUMER:held' })).status, 202)
  await until(() => releaseHeld, 'real held provider'); await page.waitForSelector('.foxwarm-node-picker-trigger:not([disabled])')
  await page.click('.foxwarm-node-picker-trigger'); await page.waitForSelector('[data-node-option="owned-cli"]:not([disabled])'); await page.click('[data-node-option="owned-cli"]')
  await until(async () => (await saved(actor)).currentNode === 'owned-cli', 'busy composer committed selection')
  releaseHeld(); releaseHeld = undefined; await until(async () => !(await fixture.api('GET', route(actor) + '/history')).body.session.busy, 'held settled')
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'bound', isolatedNode: 'owned-cli' })).status, 201)
  const bound = await create('bound-consumer', 'bound')
  const options = (await fixture.api('GET', route(bound) + '/nodes')).body
  assert.equal(options.nodes.length, 1); assert.equal(options.nodes[0].selectable, false); assert.match(options.lockedReason, /owned-cli/)
  assert.equal((await fixture.api('POST', route(bound) + '/node', { nodeId: 'owned-cli' })).status, 400)
  const boundHistory = page.waitForResponse(response => new URL(response.url()).pathname === prefix + route(bound) + '/history' && response.request().method() === 'GET')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), bound)
  assert.equal((await boundHistory).status(), 200)
  await page.locator('.foxwarm-node-picker-trigger').click()
  await page.waitForSelector('[data-node-option="owned-cli"][disabled]'); await page.keyboard.press('Escape')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  // Download and run the unchanged official POSIX client using the tool-created credential, never a model argument.
  const bootstrap = await fetch(host + '/node/run-shell.sh'); assert.equal(bootstrap.status, 200)
  const script = await bootstrap.text(); assert.equal(script, (await readFile('templates/node/run-shell.sh', 'utf8')).replace('__FOXWARM_DEFAULT_BASE_URL__', fixture.origin))
  const downloaded = join(fixture.root, 'run-shell.sh'); await writeFile(downloaded, script)
  const startup = join(fixture.root, 'shell'); await mkdir(startup)
  const shell = client('/bin/sh', [downloaded, '--host=' + host, '--node-id=owned-shell'], { cwd: startup, env: { ...process.env, NODE_AUTH_TOKEN: shellToken, TMPDIR: startup } })
  await online('owned-shell')
  assert.equal((await fixture.api('POST', route(actor) + '/node', { nodeId: 'owned-shell' })).status, 200)
  await fixture.api('POST', route(actor) + '/cwd', { cwd: startup })
  state = await turn(actor, 'shell-short', [call('shell-short', 'exec', { command: 'printf measured' })]); assert.match(pair(state, 'shell-short').output, /Duration: (?:<1s|~1s)/)
  state = await turn(actor, 'shell-seconds', [call('shell-seconds', 'exec', { command: 'sleep 2; printf measured' })]); assert.match(pair(state, 'shell-seconds').output, /Duration: ~[23]s/)
  state = await turn(actor, 'shell-background', [call('shell-background', 'exec', { command: 'sleep 3; printf one >> background-effect', timeout: 1 })])
  const background = pair(state, 'shell-background'); assert.match(background.output, /Elapsed: ~[12]s/)
  await fixture.api('POST', route(actor) + '/node', { nodeId: 'master' })
  await until(async () => (await saved(actor)).meta?.acceptedExternalEventIds?.includes('remote-exec-completion:' + background.execId), 'official client completion after Node switch')
  state = await saved(actor); assert.match(JSON.stringify(state), /Duration: ~[34]s/); assert.equal(await readFile(join(startup, 'background-effect'), 'utf8'), 'one')
  state = await turn(actor, 'local-short', [call('local-short', 'exec', { command: 'sleep 0.2; printf local' })]); assert.match(pair(state, 'local-short').output, /Duration: \d+ms/)
  // Composer placement and cwd survive a cold restart and the original App reload.
  assert.equal((await fixture.api('POST', route(actor) + '/node', { nodeId: 'owned-cli' })).status, 200)
  await stop(cli); await stop(shell)
  await until(async () => !(await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'owned-cli').online, 'CLI disconnected')
  assert.equal((await fixture.api('GET', route(actor) + '/history')).status, 200)
  await fixture.stop(); await fixture.start()
  assert.equal((await saved(actor)).currentNode, 'owned-cli'); assert.equal((await saved(actor)).cwd, startup)
  const afterRestart = (await fixture.api('GET', route(actor) + '/nodes')).body.nodes.find(node => node.id === 'owned-cli'); assert.equal(afterRestart.reason, 'Offline')
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForSelector('.foxwarm-node-picker-trigger[aria-label="Execution node: owned-cli"]')
  // Explicit tool selection retains its accepted cwd-clearing contract.
  state = await turn(actor, 'explicit-select', [call('explicit-select', 'node', { action: 'select', nodeId: 'master' })]); assert.equal(state.cwd, undefined)
  for (const secret of secrets) {
    assert(!JSON.stringify(await saved(actor)).includes(secret)); assert(!JSON.stringify((await fixture.api('GET', route(actor) + '/history')).body).includes(secret)); assert(!JSON.stringify(requests).includes(secret)); assert(!fixture.output.includes(secret))
    assert(!clients.some(client => client.output.includes(secret)))
  }
  assert.equal((await fixture.api('DELETE', route(actor))).status, 200)
  await fixture.stop()
  console.log('Real private credential/authentication, original picker/binding/busy/persistence, official Shell and local process durations passed.')
} finally {
  releaseHeld?.(); for (const socket of sockets) socket.terminate(); for (const handle of clients) await stop(handle).catch(() => {})
  model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
}
