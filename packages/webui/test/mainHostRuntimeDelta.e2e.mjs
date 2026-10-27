// October runtime/control/notice/communication producers through an owned normal host and the built original App.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const options = { env: {}, onPage: page => page.evaluateOnNewDocument(() => {
  localStorage.setItem('foxwarm_timeline_view_v1', 'conversation')
  const Native = window.WebSocket
  window.runtimeSockets = []
  window.WebSocket = class extends Native { constructor(...args) { super(...args); window.runtimeSockets.push(this) } }
}) }
const fixture = await createHostFixture('runtime-delta', options)
options.cwd = fixture.work
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `url: ${fixture.origin}/nested\nbot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n`)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => { const value = await fixture.api('GET', route(id) + '/history?tail=100'); assert.equal(value.status, 200, JSON.stringify(value)); return value.body }
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const requests = [], errors = [], held = new Map(), scripts = new Map(), counts = new Map()
let planMode = 'retry-hold', planFailures = 0, usage = 30
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), input = JSON.stringify(body.input), planning = input.includes('COMPACTION STARTED:'), key = [...input.matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'incoming'
    assert(!input.includes('controlled planner rejection') && !input.includes('Tool authorization policy is unavailable'), 'notice diagnostics must not enter real provider replay')
    assert(!input.includes('sessionNotice') && !input.includes('toolScriptSubCalls') && body.input.every(item => item.__meta === undefined), 'trusted display metadata must not enter provider replay; authored metadata-looking values remain opaque')
    const n = counts.get(key) || 0; if (!planning) counts.set(key, n + 1)
    const record = { body, key, planning, n, response }; requests.push(record)
    const complete = (output, tokens = usage) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'runtime-' + requests.length, status: 'completed', output, usage: { input_tokens: tokens, output_tokens: 3 } } }) + '\n\n')
    }
    record.complete = complete
    if (planning) {
      if (planMode === 'retry-hold' && planFailures++ === 0) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'controlled compact backoff' } })); return }
      if (planMode === 'fail') { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'controlled planner rejection' } })); return }
      record.valid = () => {
        const matches = [...input.matchAll(/- M#(\d+)(?:-#(\d+))?\s/g)]
        assert(matches.length)
        complete([call('plan-' + requests.length, 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: Number(matches[0][1]), sourceEnd: Number(matches.at(-1)[2] || matches.at(-1)[1]), summary: 'Ordered earlier dialogue and paired effects.' }] })], 30)
      }
      held.set('plan', record); return
    }
    if (key === 'retry' && n === 0) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'controlled transient' } })); return }
    if (key === 'hold' || key === 'retry' && n >= 1 || key === 'authority') { held.set(key, record); return }
    const scripted = scripts.get(key)
    const output = scripted && !scripted.every(item => body.input.some(row => row.type === 'function_call_output' && row.call_id === item.call_id)) ? scripted : [text('DONE-' + key)]
    complete(output)
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } }))
const frames = [], clients = []
async function connect(id) {
  const ws = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/nested/api/webui/stream', { headers: { authorization: 'Bearer ' + fixture.token } })
  const received = []; clients.push(ws); ws.on('message', raw => { const frame = JSON.parse(String(raw)); received.push(frame); frames.push(frame) }); await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: [id], sessionListIds: [id], sessionListActive: true }))
  await until(() => received.some(frame => frame.type === 'subscriptions-applied'), 'real subscription')
  return received
}
const create = async (name, parentSessionId) => {
  const result = await fixture.api('POST', '/api/sessions', { agentId: 'delta', sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result))
  assert.equal((await fixture.api('POST', route(result.body.sessionId) + '/cwd', { cwd: fixture.work })).status, 200)
  if (parentSessionId) assert.equal((await fixture.api('POST', route(result.body.sessionId) + '/move', { parentSessionId, position: 'last' })).status, 200)
  return result.body.sessionId
}
const send = (id, value, extra = {}) => fixture.api('POST', route(id) + '/message', { text: value, ...extra })
const settled = id => until(async () => !(await history(id)).session.busy, 'actual idle ' + id)
async function turn(id, key, calls, payload = '') {
  if (calls) scripts.set(key, calls)
  assert.equal((await send(id, 'CASE:' + key + (payload ? ' ' + payload : ''), key === 'normal' ? { clientMessageId: 'composer-normal' } : {})).status, 202)
  await until(async () => { if (errors.length) throw new Error(errors.join('\n')); const value = await history(id); return !value.session.busy && value.messages.some(row => row.parts.some(part => part.text === 'DONE-' + key)) }, 'turn ' + key)
  return history(id)
}
const responseOf = (value, id) => value.messages.flatMap(row => row.parts).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse
async function control(id, command, status, action) {
  const requestId = 'control-' + Date.now() + '-' + Math.random()
  const result = await send(id, command, { controlRequestId: requestId })
  assert.notEqual(result.status, 400, JSON.stringify(result))
  const event = await until(() => frames.find(frame => frame.sessionId === id && frame.event?.requestId === requestId), 'correlated ' + command)
  assert.equal(event.event.type, 'session-control-feedback'); assert.equal(event.event.feedback.action, action); assert.equal(event.event.feedback.status, status)
  return result
}
async function projections(id, check) {
  const bootstrap = (await history(id)).session.runtimeState; check(bootstrap)
  const list = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); check(list.body.results[0].session.runtimeState)
  const architecture = await fixture.api('GET', '/api/session-list/architecture?limit=100'); assert.equal(architecture.status, 200)
  const find = value => { if (!value || typeof value !== 'object') return null; if (value.id === id && value.runtimeState) return value; for (const child of Object.values(value)) { const result = find(child); if (result) return result } return null }
  check(find(architecture.body).runtimeState)
  const snapshots = await connect(id); check(snapshots.find(frame => frame.type === 'session-state').session.runtimeState)
  return bootstrap
}
let page, source, target, child
try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'delta' })).status, 201)
  source = await create('source'); target = await create('target'); child = await create('child', source)
  const sourceFrames = await connect(source)
  // Generated standalone login is served by the real auth/prefix host, not a fake token endpoint.
  options.publicRoot = fixture.origin + '/nested/#session/' + encodeURIComponent(source)
  page = await fixture.openApp(); await page.setViewport({ width: 1440, height: 1000 }); await waitForWebUiReady(page)
  const cookies = await page.browserContext().cookies(); assert(cookies.some(cookie => cookie.name === 'foxwarm_token' && !cookie.httpOnly && cookie.value === fixture.token))
  assert.equal((await page.evaluate(async () => (await fetch('./api/auth/session')).json())).role, 'admin')
  const recovery = await page.browser().newPage()
  try {
    await recovery.goto(fixture.origin + '/nested/login.html', { waitUntil: 'domcontentloaded' })
    await recovery.type('#token', 'invalid-synthetic-token'); await recovery.click('#submit')
    await recovery.waitForFunction(() => document.querySelector('#token').getAttribute('aria-invalid') === 'true' && document.querySelector('#error').textContent.length > 0 && !document.querySelector('#submit').disabled)
    await recovery.$eval('#token', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await recovery.type('#token', fixture.token)
    let failAuth = true
    await recovery.setRequestInterception(true)
    recovery.on('request', request => {
      if (failAuth && request.method() === 'POST' && new URL(request.url()).pathname === '/nested/api/auth') { failAuth = false; void request.abort('failed') }
      else void request.continue()
    })
    await recovery.click('#submit'); await recovery.waitForFunction(() => document.querySelector('#error').textContent.length > 0 && !document.querySelector('#submit').disabled)
    await recovery.click('#submit')
    await waitForWebUiReady(recovery)
    await recovery.evaluate(id => window.foxwarmTest.switchToSession(id), source)
    await recovery.waitForFunction(id => document.querySelector('[data-session-header-subtitle]')?.textContent.includes('session ' + id), {}, source)
  } finally { await recovery.close() }
  const rootLogin = await fetch(fixture.origin + '/login.html'); const prefixLogin = await fetch(fixture.origin + '/nested/login.html'); assert.equal(rootLogin.status, 200); assert.equal(prefixLogin.status, 200)
  const generatedLogin = await readFile(resolve('packages/webui/public/login.html'), 'utf8'); assert.equal(await rootLogin.text(), generatedLogin); assert.equal(await prefixLogin.text(), generatedLogin)
  for (const value of ['', 1, 'x'.repeat(129)]) assert.equal((await send(source, '/stop', { controlRequestId: value })).status, 400)
  await control(source, '/stop', 'noop', 'stop'); await control(source, '/dequeue', 'noop', 'dequeue'); await control(source, '/continue', 'noop', 'continue'); await control(source, '/compact tools', 'noop', 'compact')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), source)
  await page.waitForFunction(id => document.querySelector('[data-session-header-subtitle]')?.textContent.includes('session ' + id), {}, source)
  assert.equal((await send(source, 'CASE:retry')).status, 202)
  const retry = await until(async () => { const state = (await history(source)).session.runtimeState; return state.retry ? state.retry : null }, 'physical backoff')
  assert.equal(retry.attempt, 1); assert.equal(retry.nextAttempt, 2); assert(retry.retryAt > Date.now())
  await projections(source, state => { assert.equal(state.retry?.attempt, 1); assert.equal(state.retry?.retryAt, retry.retryAt) })
  await page.waitForFunction(() => document.body.innerText.includes('Retrying'))
  await until(() => held.has('retry'), 'physical next attempt held')
  await projections(source, state => { assert.equal(state.state, 'requesting-model'); assert.equal(state.retry, undefined) })
  // Real App Stop acknowledges before request completion and settles from actual owner state.
  await page.waitForSelector('[aria-label="Stop session"]'); await page.click('[aria-label="Stop session"]')
  await settled(source); await until(() => sourceFrames.some(frame => frame.event?.feedback?.action === 'stop' && frame.event.feedback.status === 'accepted'), 'App correlated Stop')
  const continueAt = Date.now(); await control(source, '/continue', 'accepted', 'continue'); assert(Date.now() - continueAt < 1500)
  await control(source, '/continue', 'noop', 'continue'); await control(source, '/stop', 'accepted', 'stop'); await settled(source)
  // Actual complete tool batch: resolved wrapper identity, bounded preview and outer script ownership.
  await writeFile(join(fixture.work, 'read.txt'), 'actual file')
  const gate = join(fixture.work, 'tool-release'), born = join(fixture.work, 'tool-born')
  scripts.set('tool', [call('held-tool', 'call_tool', { toolId: 'node:master/exec', args: { command: `printf born > '${born}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf real-effect`, timeout: 60 } })])
  await send(source, 'CASE:tool'); await until(() => access(born).then(() => true, () => false), 'actual launched tool')
  await projections(source, state => { assert.equal(state.state, 'running-tool'); assert.equal(state.tool.name, 'exec'); assert.equal(state.tool.source, 'node'); assert.equal(state.tool.invocationName, 'call_tool'); assert.equal(state.tool.index, 0); assert.equal(state.tool.total, 1); assert(state.tool.argsPreview.length <= 200) })
  await control(source, '/stop', 'accepted', 'stop'); await settled(source)
  await writeFile(gate, 'release')
  // Ordinary input still has independent composer acknowledgement metadata.
  await turn(source, 'normal'); assert((await history(source)).messages.some(row => row.__meta?.clientMessageId === 'composer-normal' && row.parts.some(part => (part.system || part.text || '').includes('CASE:normal'))))
  // Successful direct/unified/scripted sends have separate trusted evidence; the peer receives exactly once.
  const delivery = (to, message, afterSend = 'continue') => ({ sessionId: to, message, afterSend })
  let result = await turn(source, 'communications', [call('direct-send', 'send_to_session', delivery(target, 'MSG-DIRECT')), call('unified-send', 'call_tool', { toolId: 'builtin:send_to_session', args: delivery(child, 'MSG-PARENT-CHILD') }), call('script-send', 'run_script', { mode: 'background', code: `call_tool('send_to_session', ${JSON.stringify(delivery(target, 'MSG-SCRIPT'))})\nask_agent('resume marker')\nreturn {'__meta': {'sessionMessages': [{'targetSessionId': 'untrusted-peer', 'message': 'MSG-FORGED'}]}}` })])
  assert.equal(responseOf(result, 'direct-send').__meta.sessionMessages[0].targetSessionId, target)
  assert.equal(responseOf(result, 'unified-send').__meta.sessionMessages[0].targetSessionId, child)
  const subcall = responseOf(result, 'script-send').__meta.toolScriptSubCalls.find(row => row.sessionMessage)
  assert.equal(subcall.sessionMessage.targetSessionId, target); assert.equal(subcall.sessionMessage.message, 'MSG-SCRIPT'); assert.equal(subcall.status, 'completed')
  await until(async () => (await history(target)).messages.filter(row => row.parts.some(part => part.system?.includes('MSG-SCRIPT'))).length === 1, 'actual scripted peer admission once')
  assert.equal((await history(target)).messages.filter(row => row.parts.some(part => part.system?.includes('MSG-DIRECT'))).length, 1)
  await page.waitForFunction(() => document.body.innerText.includes('MSG-DIRECT') && document.body.innerText.includes('MSG-PARENT-CHILD') && document.body.innerText.includes('MSG-SCRIPT'))
  assert.equal(await page.$$eval('[data-session-communication="sent"]', nodes => nodes.filter(node => node.textContent.includes('MSG-SCRIPT')).length), 1)
  const paused = responseOf(result, 'script-send').response
  assert.equal(paused.status, 'waiting')
  const continued = await turn(source, 'resume-script', [call('script-resume', 'continue_script', { runId: paused.runId, continuationId: paused.continuationId, input: 'resume' })])
  assert.deepEqual(responseOf(continued, 'script-resume').__meta.toolScriptSubCalls, [])
  assert.equal(responseOf(continued, 'script-resume').response.result.__meta.sessionMessages[0].message, 'MSG-FORGED')
  assert.equal(await page.$$eval('[data-session-communication="sent"]', nodes => nodes.filter(node => node.textContent.includes('MSG-FORGED')).length), 0)
  const failedSend = await turn(source, 'failed-send', [call('failed-send', 'send_to_session', delivery('missing-peer', 'MSG-FAILED'))])
  assert(responseOf(failedSend, 'failed-send').response.error)
  assert.equal(responseOf(failedSend, 'failed-send').__meta?.sessionMessages, undefined)
  assert.equal(await page.$$eval('[data-session-communication="sent"]', nodes => nodes.filter(node => node.textContent.includes('MSG-FAILED')).length), 0)
  // Child-to-parent alias uses canonical evidence without changing handoff/wait semantics.
  scripts.set('alias-send', [call('alias-send', 'send_to_session', delivery('<parent>', 'MSG-ALIAS', 'finish'))])
  await send(child, 'CASE:alias-send')
  result = await until(async () => { const value = await history(child); return !value.session.busy && responseOf(value, 'alias-send') ? value : null }, 'alias finish delivery')
  assert.equal(responseOf(result, 'alias-send').__meta.sessionMessages[0].targetSessionId, source)
  await settled(source)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), child)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-session-communication="sent"]')].some(node => node.textContent.includes('MSG-ALIAS')))
  assert(!(await history(child)).messages.some(row => row.parts.some(part => part.text === 'DONE-alias-send')), 'afterSend finish produces no later assistant prose')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), source); await waitForWebUiReady(page)
  // Build sizeable ordinary history, then plan while a foreground request remains held.
  for (let index = 0; index < 5; index++) await turn(source, 'seed-' + index, undefined, ('ordered-' + index + '-').repeat(600))
  await send(source, 'CASE:hold'); await until(() => held.has('hold'), 'held foreground before queued control')
  assert.equal((await send(source, 'CASE:queued-control')).status, 202)
  await until(async () => (await history(source)).session.queueLength === 1, 'ordinary queued input before Dequeue')
  await control(source, '/dequeue', 'accepted', 'dequeue')
  await until(async () => { const value = await history(source); return !value.session.busy && value.session.queueLength === 0 && value.messages.some(row => row.parts.some(part => part.text === 'DONE-queued-control')) }, 'Dequeue admission and actual safe-point settlement')
  held.delete('hold'); await send(source, 'CASE:hold'); await until(() => held.has('hold'), 'held foreground before compact')
  held.delete('plan'); await control(source, '/compact', 'accepted', 'compact')
  const compactRetry = await until(async () => (await history(source)).session.runtimeState.compaction?.retry, 'independent compact physical backoff')
  await projections(source, state => { assert.equal(state.active.phase, 'normal-turn'); assert.equal(state.compaction.retry.attempt, 1); assert.equal(state.compaction.retry.retryAt, compactRetry.retryAt); assert.equal(state.retry, undefined) })
  await until(() => held.has('plan'), 'independent compact next attempt'); assert.equal((await history(source)).session.runtimeState.compaction.retry, null)
  const compactState = await projections(source, state => { assert.equal(state.active.phase, 'normal-turn'); assert.equal(state.compaction.phase, 'planning'); assert.equal(state.compaction.background, true) })
  await control(source, '/stop compact', 'accepted', 'cancel-compaction'); await until(async () => !(await history(source)).session.runtimeState.compaction, 'compact cancellation settled')
  assert((await history(source)).session.busy)
  await control(source, '/stop', 'accepted', 'stop'); await settled(source)
  // A failed background plan becomes a durable typed owner notice, never planner prose.
  planMode = 'fail'; await control(source, '/compact', 'accepted', 'compact')
  const failed = await until(async () => (await history(source)).messages.find(row => row.__meta?.sessionNotice?.source === 'compaction'), 'typed compact failure')
  assert.equal(failed.modelVisible, false); assert.equal(failed.__meta.temporary, undefined)
  await page.waitForFunction(() => document.body.innerText.includes('Compaction failed'))
  planMode = 'hold'; await turn(source, 'after-notice')
  // A genuine policy-unavailable terminal failure uses the ordinary durable run-notice path.
  await writeFile(join(fixture.data, 'state/tool-authorization.yaml'), 'rules: [invalid:')
  await sleep(10100) // The existing policy reader caches successful loads for ten seconds.
  scripts.set('policy-fail', [call('policy-read', 'read', { filePath: 'read.txt' })]); await send(source, 'CASE:policy-fail')
  await until(async () => (await history(source)).messages.some(row => row.__meta?.sessionNotice?.source === 'session'), 'typed run failure')
  await rm(join(fixture.data, 'state/tool-authorization.yaml')); await settled(source); await turn(source, 'after-policy')
  // Fail the actual authority destination while a provider response is held. No second semantic append is attempted.
  held.delete('authority'); await send(source, 'CASE:authority'); await until(() => held.has('authority'), 'held before authority fault')
  const authorityPath = join(fixture.data, 'state/sessions', source + '.json'), backup = authorityPath + '.held'
  await rename(authorityPath, backup); await mkdir(authorityPath)
  held.get('authority').complete([text('cannot commit')])
  await until(() => sourceFrames.some(frame => frame.message?.__meta?.temporary && frame.message?.__meta?.sessionNotice?.source === 'session'), 'temporary typed authority failure')
  assert((await history(source)).session.busy, 'Failed strict finalization retains its busy checkpoint; presentation does not fabricate settlement.')
  await rm(authorityPath, { recursive: true }); await rename(backup, authorityPath)
  for (const client of clients) client.terminate()
  await fixture.stop(); await fixture.start() // Existing startup recovery, not a new notice recovery path.
  await until(() => requests.some(row => row.key === 'authority' && row.n >= 1), 'existing startup resume request')
  held.get('authority').complete([text('RECOVERED-AUTHORITY')]); await settled(source)
  assert(!(await history(source)).messages.some(row => row.parts.some(part => part.text === 'cannot commit')))
  await turn(source, 'after-authority')
  // Original App prepared navigation keeps using the existing tail/continuous APIs and preserves the resulting metadata.
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), target); await page.waitForFunction(() => document.body.innerText.includes('MSG-SCRIPT'))
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), source); await waitForWebUiReady(page)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.foxwarm-chat-root'); await page.waitForFunction(() => document.body.innerText.includes('Compaction failed'))
  const restored = await history(source); assert(responseOf(restored, 'script-send').__meta.toolScriptSubCalls.some(row => row.sessionMessage?.message === 'MSG-SCRIPT'))
  assert.deepEqual(errors, [])
  for (const client of clients) client.terminate()
  await fixture.stop(); await fixture.start()
  const reopened = await history(source)
  assert(responseOf(reopened, 'script-send').__meta.toolScriptSubCalls.some(row => row.sessionMessage?.message === 'MSG-SCRIPT'))
  assert(reopened.messages.some(row => row.__meta?.sessionNotice?.source === 'compaction'))
  assert(reopened.messages.some(row => row.__meta?.sessionNotice?.source === 'session'))
  assert(!reopened.messages.some(row => row.__meta?.temporary))
  await fixture.stop()
  console.log(JSON.stringify({ ok: true, originalApp: true, normalHost: true, hosts: fixture.hostPids, requests: requests.length, correlatedControls: true, sharedRuntimeProjections: true, typedDurableAndTemporaryNotices: true, trustedDirectUnifiedScriptDeliveries: true, realCookiePrefixLogin: true, preparedNavigation: true, cancelledOperation: compactState.compaction.operationId }))
} catch (error) { console.error('Owned host:', fixture.output, '\nSource:', source && await history(source).then(value => ({ session: value.session, messages: value.messages.map(row => ({ role: row.role, meta: row.__meta })) })).catch(() => null), '\nPage:', page && (await page.evaluate(() => document.body.innerText)).slice(-6000), '\nRequests:', requests.map(row => ({ key: row.key, n: row.n, planning: row.planning })), '\nErrors:', errors); throw error }
finally { for (const client of clients) client.terminate(); await writeFile(join(fixture.work, 'tool-release'), 'release').catch(() => {}); await fixture.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
