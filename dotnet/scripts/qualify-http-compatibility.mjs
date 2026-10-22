#!/usr/bin/env node
// Retained public HTTP callers against an owned Main, a synthetic Responses peer,
// and the unchanged public Multica bin. No real installation data or listener.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { createHostFixture, until } from '../../packages/webui/test/experimentHostFixture.mjs'

const observe = process.argv.includes('--observe')
const source = process.argv.includes('--source')
const report = { runtime: source ? 'source' : 'managed', checks: [], evidence: {} }
async function check(name, action) {
  try { await action(); report.checks.push({ name, passed: true }) }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }) }
}
function templateText(origin, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part }); response.on('end', () => { try { assert.equal(response.statusCode, 200); resolve(text) } catch (error) { reject(error) } })
    }); req.on('error', reject); req.end()
  })
}
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function stream(f, path, token = f.token) {
  const controller = new AbortController(), events = [], comments = []
  const response = await fetch(f.origin + path, { headers: { authorization: 'Bearer ' + token }, signal: controller.signal })
  if (!response.ok) { controller.abort(); return { status: response.status, events, close() {} } }
  const done = (async () => {
    let pending = ''
    try {
      for await (const bytes of response.body) {
        pending += Buffer.from(bytes).toString('utf8')
        let index
        while ((index = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, index); pending = pending.slice(index + 2)
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)))
          else if (frame.startsWith(':')) comments.push(frame)
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error }
  })()
  return { status: response.status, events, comments, done, async close() { controller.abort(); await done } }
}
const f = await createHostFixture('http-compatibility', { runtime: source ? 'source' : undefined, normalStartup: !source, env: {} })
const hidden = ['set_session_child_model', 'set_session_compact_threshold', 'refresh_session_snapshot', 'compact_session', 'create_agent', 'create_session', 'set_agent_inherit']
const calls = [], errors = [], rounds = new Map()
let releaseQueue
const queued = new Promise(done => { releaseQueue = done })
const peer = createServer(async (req, res) => {
  try {
    let text = ''; for await (const bytes of req) text += bytes
    const body = JSON.parse(text)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = prompt.includes('COMPAT:failure') ? 'failure' : prompt.includes('COMPAT:queue') ? 'queue' : 'tools'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1); calls.push({ key, round, tools: (body.tools || []).map(tool => tool.name) })
    if (key === 'queue' && round === 0) await queued
    if (key === 'failure') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'owned terminal provider failure', type: 'invalid_request_error' } })); return }
    const output = key === 'tools' && round === 0 ? [
      { type: 'function_call', call_id: 'compat-read', name: 'read', arguments: JSON.stringify({ filePath: join(f.work, 'fixture.txt') }) },
      { type: 'function_call', call_id: 'compat-missing', name: 'read', arguments: JSON.stringify({ filePath: join(f.work, 'missing.txt') }) },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'COMPAT-DONE:' + key }] }]
    for (const call of output.filter(row => row.type === 'function_call')) assert(body.tools.some(tool => tool.name === call.name))
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'compat-' + key + '-' + round, output } }) + '\n\n')
  } catch (error) { errors.push(error.stack); res.writeHead(500); res.end('fixture error') }
})
let streams = [], socket
async function post(path, body, status = 200) { const response = await f.api('POST', path, body); assert.equal(response.status, source && status === 202 ? 200 : status, JSON.stringify(response)); return response.body }
async function create(id) { return (await post('/api/sessions', { agentId: 'main', sessionId: id })).sessionId }
async function bridge(id, prompt) {
  const bin = JSON.parse(await readFile('package.json', 'utf8')).bin['foxwarm-multica']
  const child = spawn(process.execPath, [resolve(bin), '--resume', id, '-p', prompt, '--output-format', 'stream-json'], { cwd: f.work, env: { ...process.env, FOXWARM_DATA_DIR: f.data, FOXWARM_MULTICA_BASE_URL: f.origin, FOXWARM_MULTICA_TOKEN: f.token, FOXWARM_MULTICA_AGENT: 'main' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 25000)
  try { const [code, signal] = await once(child, 'exit'); return { code, signal, stderr, events: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) } }
  finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}
try {
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  await writeFile(f.modelPath, JSON.stringify({ default: 'fixture', providers: { fixture: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['fixture-wire'] }, invalid: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, extraFields: { tool_choice: { type: 'image_generation' } }, models: ['invalid-wire'] } } }))
  await writeFile(join(f.data, 'state/config.yaml'), `bot:\n  httpPort: ${f.port}\nllm:\n  maxOutput: 713\naccess:\n  identities:\n    viewer:\n      token: synthetic-viewer\n      surfaces:\n        webui:\n          sessions: [compat-tools]\n`)
  await writeFile(join(f.work, 'fixture.txt'), 'owned-tool-result')
  await f.start()
  const id = await create('compat-tools'), failureId = await create('compat-failure'), queueId = await create('compat-queue')
  const state = (await f.api('GET', route(id) + '/state')).body.session
  report.evidence.initialState = state
  await check('administrator state uses WebUI model/placement/runtime/queue projection', () => {
    assert.equal(state.modelKey, 'fixture'); assert.equal(state.currentNode, 'master'); assert.equal(state.queueLength, 0); assert.equal(state.runtimeState.state, 'idle'); assert('cwd' in state)
  })
  const live = await stream(f, route(id) + '/stream'); streams.push(live)
  await until(() => live.events.some(row => row.type === 'session-state'), 'initial session SSE')
  const tools = await bridge(id, 'COMPAT:tools')
  report.evidence.toolsBridge = tools
  report.evidence.toolsWire = live.events
  await check('unchanged public bin initializes with the actual model', () => { assert.equal(tools.events.find(row => row.subtype === 'init')?.model, 'fixture') })
  await check('unchanged public bin receives real committed success and failure tool results', () => {
    assert.equal(tools.code, 0, tools.stderr)
    const results = tools.events.filter(row => row.type === 'user').flatMap(row => row.message.content)
    assert(results.some(row => row.tool_use_id === 'compat-read' && row.content.includes('owned-tool-result')))
    assert(results.some(row => row.tool_use_id === 'compat-missing' && /not found|exist|ENOENT/i.test(row.content)))
    assert(tools.events.some(row => row.subtype === 'success' && row.result.includes('COMPAT-DONE')))
  })
  await check('initial and live administrator SSE use WebUI state and committed message envelopes', () => {
    assert.equal(live.events[0].type, 'connected'); assert.equal(live.events[1].session.modelKey, 'fixture')
    assert(live.events.some(row => row.type === 'message' && row.message.role === 'tool'))
    assert(live.events.filter(row => row.type === 'session-state').every(row => 'runtimeState' in row.session && 'queueLength' in row.session))
  })
  const failureWire = await stream(f, route(failureId) + '/stream'); streams.push(failureWire)
  const failed = await bridge(failureId, 'COMPAT:failure')
  report.evidence.failureBridge = failed; report.evidence.failureWire = failureWire.events
  await check('real provider rejection remains visible through its committed notice', () => {
    assert(failureWire.events.some(row => row.type === 'message' && row.message.__meta?.retry?.final))
    assert(failed.events.some(row => row.type === 'assistant' && row.message.content.some(part => part.text?.includes('owned terminal provider failure'))))
  })
  const preparationId = await create('compat-preparation')
  await post(route(preparationId) + '/model', { model: 'invalid' })
  const preparationWire = await stream(f, route(preparationId) + '/stream'); streams.push(preparationWire)
  const preparation = await bridge(preparationId, 'COMPAT:preparation')
  report.evidence.preparationBridge = preparation; report.evidence.preparationWire = preparationWire.events
  await check('real model preparation failure commits a terminal error and the unchanged bin fails', () => {
    assert.equal(preparation.code, 1)
    assert(preparation.events.some(row => row.type === 'result' && row.is_error && row.error.type === 'execution_error'))
    assert(preparationWire.events.some(row => row.type === 'message' && row.message.__meta?.sessionNotice?.severity === 'error'))
  })
  report.evidence.ordinaryRequestTools = calls.find(row => row.key === 'tools').tools
  await check('ordinary real provider request omits Source-hidden management tools', () => {
    assert.deepEqual(hidden.filter(name => report.evidence.ordinaryRequestTools.includes(name)), [])
    assert(report.evidence.ordinaryRequestTools.includes('read'))
  })
  await post(route(queueId) + '/message', { text: 'COMPAT:queue' }, 202)
  await until(() => calls.some(row => row.key === 'queue'), 'real model request in flight')
  await post(route(queueId) + '/message', { text: 'queued followup' }, 202)
  const active = (await f.api('GET', route(queueId) + '/state')).body.session
  report.evidence.activeQueuedState = active
  await check('actual queued work and runtime are visible in state', () => { assert.equal(active.busy, true); assert.equal(active.queueLength, 1); assert.equal(active.runtimeState.state, 'requesting-model') })
  releaseQueue()
  await until(async () => !(await f.api('GET', route(queueId) + '/state')).body.session.busy, 'queue drained')

  await check('scoped identities cannot read administrator-only state', async () => {
    const response = await fetch(f.origin + route(failureId) + '/state', { headers: { authorization: 'Bearer synthetic-viewer' } }); assert.equal(response.status, 403); await response.body?.cancel()
  })
  await check('current multiplexed WebSocket still uses its existing subscription handshake', async () => {
    socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer ' + f.token } })
    const frames = []; socket.on('message', bytes => frames.push(JSON.parse(bytes)))
    await once(socket, 'open'); await until(() => frames.some(row => row.type === 'connected'), 'current connected')
    socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: true, sessionListIds: [failureId], sessionIds: [failureId] }))
    await until(() => frames.some(row => row.type === 'subscriptions-applied'), 'current applied')
    assert(frames.some(row => row.type === 'session-state' && row.session.modelKey === 'fixture'))
    assert(frames.some(row => row.type === 'session-list-delta' && row.sessions.length === 1))
    socket.close(); await once(socket, 'close'); socket = null
  })
  await check('browser-shaped commands use fallbackUrl and explicit override with prefix/escaping', async () => {
    const fallback = await post('/api/nodes/onboarding/commands', { fallbackUrl: 'https://browser.example/fox/' })
    report.evidence.browserCommands = fallback
    assert.equal(fallback.baseUrl, 'https://browser.example/fox')
    const explicit = await post('/api/nodes/onboarding/commands', { baseUrl: 'https://explicit.example/mount', fallbackUrl: 'https://browser.example/fox', installDir: "/opt/node's dir" })
    assert.equal(explicit.baseUrl, 'https://explicit.example/mount'); assert(explicit.commands.bareMetal.includes("'\"'\"'"))
    const shell = await post('/api/nodes/onboarding/create-shell', { nodeId: 'compat-shell', fallbackUrl: 'https://browser.example/fox' })
    assert(shell.command.includes('https://browser.example/fox/node/run-shell.sh'))
    for (const bad of ['https://user:pass@example.test', 'https://example.test/?', 'https://example.test/#', 'https://example.test/\\bad', '', 42]) assert.equal((await f.api('POST', '/api/nodes/onboarding/commands', { baseUrl: bad, fallbackUrl: 'https://browser.example' })).status, 400)
  })
  await check('every public template uses actual request/forwarded default, not startup address', async () => {
    for (const name of ['run-shell.sh', 'run.sh', 'run-docker.sh', 'run-interactive.sh', 'run-cli-node.sh', 'run.ps1', 'docker-compose.yaml']) {
      const response = await fetch(f.origin + '/node/' + name, { headers: { host: 'fetched.example:7788', 'x-forwarded-host': 'edge.example:8443, ignored.example', 'x-forwarded-proto': 'HTTPS, http' } })
      assert.equal(response.status, 200); const text = await response.text()
      const original = await readFile(join('templates/node', name === 'run-cli-node.sh' ? 'run-interactive.sh' : name), 'utf8')
      assert.equal(text, original.replaceAll('__FOXWARM_DEFAULT_BASE_URL__', 'https://edge.example:8443'), name)
    }
    const direct = await templateText(f.origin, '/node/run.sh', { host: 'direct.example:8800' }); assert(direct.includes('http://direct.example:8800'))
    const invalid = await templateText(f.origin, '/node/run.sh', { host: 'direct.example', 'x-forwarded-host': 'bad/host', 'x-forwarded-proto': 'javascript' }); assert(invalid.includes("HOST=''") || invalid.includes('HOST=""'))
  })
  assert.equal(errors.length, 0, errors.join('\n'))
  await f.stop()
} finally {
  releaseQueue(); socket?.terminate()
  for (const stream of streams) await stream.close()
  await f.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
// A configured public URL wins command suggestions but never downloaded defaults.
const configured = await createHostFixture('http-compatibility-configured', { runtime: source ? 'source' : undefined, normalStartup: !source, env: {} })
try {
  await writeFile(join(configured.data, 'state/config.yaml'), `bot:\n  httpPort: ${configured.port}\nurl: https://configured.example/mount\n`)
  await configured.start()
  await check('configured commands preserve prefix and explicit override; template defaults remain request-derived', async () => {
    const suggested = await configured.api('POST', (source ? '' : '/mount') + '/api/nodes/onboarding/commands', { fallbackUrl: 'https://browser.example/browser' })
    assert.equal(suggested.status, 200); assert.equal(suggested.body.baseUrl, 'https://configured.example/mount')
    const explicit = await configured.api('POST', (source ? '' : '/mount') + '/api/nodes/onboarding/commands', { baseUrl: 'https://override.example/explicit', fallbackUrl: 'https://browser.example/browser' })
    assert.equal(explicit.status, 200); assert.equal(explicit.body.baseUrl, 'https://override.example/explicit')
    const downloaded = await templateText(configured.origin, (source ? '' : '/mount') + '/node/run.sh', { host: 'fetch.example:9911', 'x-forwarded-proto': 'https' })
    assert(downloaded.includes('https://fetch.example:9911')); assert(!downloaded.includes('https://configured.example'))
  })
  await configured.stop()
} finally { await configured.cleanup() }
console.log(JSON.stringify(report, null, 2))
if (!observe && report.checks.some(row => !row.passed)) process.exitCode = 1
