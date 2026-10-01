import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { WebSocketServer } from 'ws'
import { createHostFixture, saveModelsInOriginalApp, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('async-compact'), records = [], errors = [], held = new Map(), connections = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const authority = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const textOf = item => (item.content || []).map(part => part.text || '').join('')
const inputText = input => input.filter(item => item.role === 'user').map(textOf).join('\n')
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const tool = (id, name, args) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: JSON.stringify(args) })
const replay = output => output.map(item => { const value = { ...item }; delete value.id; delete value.status; return value })
const sha = value => createHash('sha256').update(value).digest('hex')
let responseSequence = 0, plans = 0, mode = 'hold', crossTarget
function record(body, full, kind, headers, complete) {
  const input = inputText(full), planning = input.includes('COMPACTION STARTED:'), scenario = [...input.matchAll(/CASE:([a-z0-9-]+)/g)].at(-1)?.[1] || 'unknown'
  const value = { body, full, kind, headers, planning, scenario, complete }; records.push(value)
  if (planning) {
    value.ranges = [...input.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
    assert(value.ranges.length, 'genuine frozen candidates'); value.valid = () => complete([tool('valid-plan-' + (++plans), 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: value.ranges[0][0], sourceEnd: value.ranges.at(-1)[1], summary: 'Exact ordered prior dialogue and paired effects.' }] })])
    value.invalid = () => complete([tool('invalid-plan-' + (++plans), 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 999999, sourceEnd: 1000000, summary: 'Invalid range.' }] })])
    if (input.includes('COMPACT PLAN INVALID.')) {
      if (mode === 'reload') { assert(!body.previous_response_id); assert.equal(headers['x-generation'], 'two') }
      else assert(body.previous_response_id, 'real background transient suffix')
      value.valid(); return value
    }
    held.set('plan', value); if (mode === 'immediate') value.valid(); return value
  }
  if (scenario.startsWith('held-') && !input.includes('QUEUED-B')) { held.set(scenario, value); value.partial?.(); return value }
  if (scenario === 'self-tool' && !full.some(item => item.type === 'function_call_output' && item.call_id === 'self-compact')) {
    complete([tool('self-compact', 'compact_session', { keepPercent: 0, summary: 'Summarize the older context only.' }), tool('held-exec', 'exec', { command: 'printf started > gate-started; while [ ! -f gate-release ]; do sleep 0.05; done; printf paired-finished', timeout: 15 })]); return value
  }
  if (scenario === 'cross-tool' && !full.some(item => item.type === 'function_call_output' && item.call_id === 'cross-compact')) { complete([tool('cross-compact', 'compact_session', { sessionId: crossTarget })]); return value }
  if (scenario === 'missing-tool' && !full.some(item => item.type === 'function_call_output' && item.call_id === 'missing-compact')) { complete([tool('missing-compact', 'compact_session', { sessionId: 'missing-target' })]); return value }
  if (scenario === 'auto-tool' && !full.some(item => item.type === 'function_call_output' && item.call_id === 'auto-read')) { complete([tool('auto-read', 'read', { filePath: 'gate-started' })]); return value }
  complete(final('DONE-' + scenario))
  return value
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); response.writeHead(200, { 'content-type': 'text/event-stream' })
    let value
    const complete = output => { response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'http-' + (++responseSequence), status: 'completed', output, usage: { input_tokens: output.some(item => item.call_id === 'auto-read') ? 19000 : 40, output_tokens: 3 } } }) + '\n\n'); response.end() }
    value = record(body, body.input, 'http', request.headers, complete)
    value.partial = () => { response.write('data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }) + '\n\n'); response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'VISIBLE-FOREGROUND' }) + '\n\n') }
    if (value.scenario.startsWith('held-') && !value.planning && !inputText(value.full).includes('QUEUED-B')) value.partial()
    response.on('close', () => { value.closed = true })
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const server = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 } })
peer.on('upgrade', (request, socket, head) => server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request)))
server.on('connection', (ws, request) => {
  const connection = { ws, id: connections.length + 1, states: new Map(), closed: false }; connections.push(connection)
  ws.on('close', () => { connection.closed = true }); ws.on('error', error => errors.push(error.message))
  ws.on('message', raw => {
    try {
      const body = JSON.parse(raw), prefix = body.previous_response_id ? connection.states.get(body.previous_response_id) : []
      assert(prefix, 'response identity is connection-local'); const full = [...prefix, ...body.input]
      const complete = output => { const id = 'ws-' + (++responseSequence); connection.states.set(id, [...full, ...replay(output)]); ws.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: output.some(item => item.call_id === 'auto-read') ? 19000 : 40, output_tokens: 3 } } }), { compress: true }) }
      const value = record(body, full, 'ws', request.headers, complete); value.connection = connection
      value.partial = () => { ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }), { compress: true }); ws.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'VISIBLE-FOREGROUND' }), { compress: true }) }
      if (value.scenario.startsWith('held-') && !value.planning && !inputText(value.full).includes('QUEUED-B')) value.partial()
    } catch (error) { errors.push(error.stack); ws.close(1011) }
  })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening'); const baseUrl = 'http://127.0.0.1:' + peer.address().port
function config(asyncCompact = true, generation = 'one') { return { default: 'a', providers: { a: { providerType: 'openai-ws', baseUrl: baseUrl + '/ws', apiKey: 'synthetic-ws', models: ['wire'], contextLimit: 20000, extraHeaders: { 'X-Generation': generation }, asyncCompact }, sync: { providerType: 'openai-responses', baseUrl: baseUrl + '/http', apiKey: 'synthetic-http', models: ['wire'], contextLimit: 20000, extraFields: { cache: '${SESSION_CACHE_KEY}' }, asyncCompact: false } } } }
const create = async model => { const result = await fixture.api('POST', '/api/sessions', {}); assert.equal(result.status, 200); if (model) await fixture.api('POST', route(result.body.sessionId) + '/model', { model }); return result.body.sessionId }
async function send(id, scenario, text = '') {
  const count = records.length; assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:' + scenario + ' ' + text })).status, 202)
  await until(async () => { const result = await history(id); return records.length > count && !result.session.busy && result.messages.some(row => row.parts?.some(part => part.text === 'DONE-' + scenario)) }, scenario)
  assert.deepEqual(errors, []); return records.slice(count)
}
async function seed(id, label) { for (let i = 0; i < 7; i++) await send(id, `seed-${label}-${i}`, ('ordered-' + label + '-' + i + '-').repeat(750)) }
const command = (id, text) => fixture.api('POST', route(id) + '/message', { text })
try {
  await fixture.start(); const main = await create(); const page = await fixture.openApp(); await saveModelsInOriginalApp(page, yaml.dump(config()), fixture.modelPath)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), main); await seed(main, 'paired')
  const originalArchive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [main]), cache = (await authority(main)).promptCacheKey
  await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:self-tool'))
  await until(() => held.has('plan'), 'busy-self real handler background planner'); const planner = held.get('plan')
  await until(async () => (await readFile(join(fixture.work, 'gate-started'), 'utf8').catch(() => '')) === 'started', 'actual held exec')
  assert.equal(planner.body.prompt_cache_key, sha(main + '--compact-plan')); assert(!planner.body.previous_response_id)
  assert(!JSON.stringify(planner.full).includes('"call_id":"self-compact"'), 'positive configured retention forces the active call tail; tool zero selects that configured default')
  assert((await history(main)).session.busy); assert(!(await history(main)).messages.some(row => row.__meta?.contextBlock))
  await command(main, 'QUEUED-A'); planner.invalid(); await until(() => records.filter(row => row.planning).length === 2, 'real invalid feedback round')
  await until(async () => (await authority(main)).queue.some(item => item.type === 'compact-commit'), 'ready signal saved behind A while tool held')
  await command(main, 'QUEUED-B'); assert.deepEqual((await authority(main)).queue.map(item => item.type), ['user', 'compact-commit', 'user'])
  assert(!(await history(main)).messages.some(row => row.__meta?.contextBlock), 'no apply inside executing call/result')
  await writeFile(join(fixture.work, 'gate-release'), 'release'); await until(async () => !(await history(main)).session.busy, 'paired effect and ready-first next request')
  const live = await history(main), a = live.messages.findIndex(row => row.parts?.some(part => part.text === 'QUEUED-A')), b = live.messages.findIndex(row => row.parts?.some(part => part.text === 'QUEUED-B')), paired = live.messages.findIndex(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'self-compact'))
  assert(live.messages.some(row => row.__meta?.contextBlock)); assert(a > paired && b === a + 1); assert(live.messages[paired - 1].parts.some(part => part.functionCall?.id === 'self-compact'))
  const next = records.filter(row => !row.planning && row.full.some(item => item.type === 'function_call_output' && item.call_id === 'self-compact'))
  assert.equal(next.length, 1); assert(inputText(next[0].full).includes('QUEUED-A')); assert(inputText(next[0].full).includes('QUEUED-B'))
  assert.equal((await authority(main)).promptCacheKey, cache); assert.equal((await authority(main)).queue.length, 0)
  assert.deepEqual(fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq LIMIT ?', [main, originalArchive.length]), originalArchive)

  const stopped = await create(); await seed(stopped, 'stopped'); await page.evaluate(id => window.foxwarmTest.switchToSession(id), stopped)
  await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:held-foreground')); await until(() => held.has('held-foreground'), 'held genuine foreground'); await until(async () => (await page.evaluate(() => document.body.innerText)).includes('VISIBLE-FOREGROUND'), 'original draft')
  held.delete('plan'); assert.equal((await command(stopped, '/compact')).status, 202); await until(() => held.has('plan'), 'independent busy manual planner'); const background = held.get('plan'), beforeStop = (await history(stopped)).messages
  assert.equal(background.body.prompt_cache_key, sha(stopped + '--compact-plan')); assert.notEqual(background.connection.id, held.get('held-foreground').connection.id)
  const time = Date.now(); assert.equal((await fixture.api('POST', route(stopped) + '/stop')).status, 200); assert(Date.now() - time < 2500, 'Stop does not wait for held background')
  assert(!background.connection.closed); assert(!(await history(stopped)).session.busy)
  assert.equal((await command(stopped, '/stop compact')).body.stoppedCompact, true); await until(() => background.connection.closed, 'compact-only provider cancellation'); assert.deepEqual((await history(stopped)).messages, beforeStop)
  held.delete('plan'); const beforeControl = records.length; await command(stopped, '/compact'); await until(() => held.has('plan'), 'new idle background'); held.get('plan').valid()
  await until(async () => (await history(stopped)).messages.some(row => row.__meta?.contextBlock) && !(await history(stopped)).session.busy, 'control-only apply')
  assert.equal(records.slice(beforeControl).filter(row => !row.planning).length, 0)

  const synced = await create('sync'); await seed(synced, 'sync'); await command(synced, 'CASE:held-sync'); await until(() => held.has('held-sync'), 'held HTTP foreground')
  const noDeferred = records.length; assert.equal((await command(synced, '/compact')).status, 409); assert(!(await authority(synced)).queue.some(item => item.type.includes('compact')))
  await fixture.api('POST', route(synced) + '/stop'); assert.equal(records.length, noDeferred)
  held.delete('plan'); assert.equal((await command(synced, '/compact')).status, 202); await until(() => held.has('plan'), 'awaited actual HTTP planner'); const awaited = held.get('plan'), busy = await history(synced)
  assert(busy.session.busy); assert.equal(awaited.body.cache, (await authority(synced)).promptCacheKey)
  assert.equal((await fixture.api('POST', route(synced) + '/stop')).body.stoppedCurrent, false); assert((await history(synced)).session.busy); assert(!(await authority(synced)).stopping)
  awaited.valid(); await until(async () => !(await history(synced)).session.busy && (await history(synced)).messages.some(row => row.__meta?.contextBlock), 'awaited owned release')

  const target = await create(); await seed(target, 'target'); const caller = await create(); crossTarget = target
  held.delete('plan'); await send(caller, 'cross-tool'); await until(() => held.has('plan'), 'cross idle existing target'); assert.equal(held.get('plan').body.prompt_cache_key, sha(target + '--compact-plan')); await command(target, '/stop compact')
  await command(target, 'CASE:held-target'); await until(() => held.has('held-target'), 'busy cross target'); const crossBefore = records.filter(row => row.planning).length
  const rejectedCaller = await create(); await send(rejectedCaller, 'cross-tool'); assert.equal(records.filter(row => row.planning).length, crossBefore); assert((await history(rejectedCaller)).messages.some(row => row.parts?.some(part => part.functionResponse?.response?.error?.message?.includes('must be idle')))); await fixture.api('POST', route(target) + '/stop')
  const countBeforeMissing = (await fixture.api('GET', '/api/sessions')).body.sessions.length; await send(caller, 'missing-tool'); assert.equal((await fixture.api('GET', '/api/sessions')).body.sessions.length, countBeforeMissing)

  const queued = await create(); await seed(queued, 'dequeue'); await page.evaluate(id => window.foxwarmTest.switchToSession(id), queued); await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:held-dequeue'))
  await until(() => held.has('held-dequeue'), 'dequeue active request'); held.delete('plan'); await command(queued, '/compact'); await until(() => held.has('plan'), 'dequeue planner')
  await command(queued, 'QUEUED-A'); held.get('plan').valid(); await until(async () => (await authority(queued)).queue.some(item => item.type === 'compact-commit'), 'dequeue ready signal'); await command(queued, 'QUEUED-B')
  await until(async () => (await page.evaluate(() => document.body.innerText)).includes('Run queued'), 'original Run queued affordance')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Run queued'))?.click())
  await until(async () => !(await history(queued)).session.busy && (await history(queued)).messages.some(row => row.parts?.some(part => part.text === 'QUEUED-B')), 'run queued actual request')
  assert(held.get('held-dequeue').connection.closed); assert((await history(queued)).messages.some(row => row.__meta?.contextBlock)); assert(!Object.hasOwn((await authority(queued)).meta, 'runQueuedAfterStop'))

  const passive = await create(); await seed(passive, 'passive'); await command(passive, 'CASE:held-passive'); await until(() => held.has('held-passive'), 'passive foreground')
  held.delete('plan'); await command(passive, '/compact'); await until(() => held.has('plan'), 'passive independent planner'); await command(passive, 'QUEUED-A'); held.get('plan').valid()
  await until(async () => (await authority(passive)).queue.some(item => item.type === 'compact-commit'), 'passive ready signal'); await command(passive, 'QUEUED-B'); const passiveCount = records.length
  await fixture.api('POST', route(passive) + '/stop'); await until(async () => !(await history(passive)).session.busy, 'passive stop finalizer')
  const passiveRows = (await history(passive)).messages; assert(passiveRows.some(row => row.__meta?.contextBlock)); const passiveA = passiveRows.findIndex(row => row.parts?.some(part => part.text === 'QUEUED-A'))
  assert.equal(passiveRows[passiveA + 1].parts[0].text, 'QUEUED-B'); assert.equal(records.length, passiveCount, 'passive Stop saves both inputs without new provider request')

  const captured = await create(); await seed(captured, 'captured'); await command(captured, 'CASE:held-captured'); await until(() => held.has('held-captured'), 'captured foreground')
  held.delete('plan'); await command(captured, '/compact'); await until(() => held.has('plan'), 'captured background admission'); const capturedPlan = held.get('plan'), capturedCount = records.filter(row => row.planning).length
  await fixture.save(config(false, 'two')); mode = 'reload'; capturedPlan.invalid(); await until(() => records.filter(row => row.planning).length > capturedCount, 'fresh planning outer after reload')
  const reloaded = records.filter(row => row.planning).at(-1); assert.equal(reloaded.body.prompt_cache_key, sha(captured + '--compact-plan')); assert.equal(reloaded.headers['x-generation'], 'two'); assert.equal((await history(captured)).session.runtimeState.state, 'requesting-model')
  await until(async () => (await authority(captured)).queue.some(item => item.type === 'compact-commit'), 'captured background ready'); await fixture.api('POST', route(captured) + '/stop')
  assert((await history(captured)).messages.some(row => row.__meta?.contextBlock)); mode = 'hold'

  const wsAwaited = await create(); await seed(wsAwaited, 'ws-awaited'); held.delete('plan'); await command(wsAwaited, '/compact'); await until(() => held.has('plan'), 'actual awaited WS operation')
  const awaitedWsPlan = held.get('plan'); assert.equal(awaitedWsPlan.body.prompt_cache_key, sha(wsAwaited)); assert.notEqual(awaitedWsPlan.body.prompt_cache_key, sha(wsAwaited + '--compact-plan')); assert((await history(wsAwaited)).session.busy)
  assert.equal((await fixture.api('POST', route(wsAwaited) + '/stop')).body.stoppedCurrent, false); assert(!awaitedWsPlan.connection.closed)
  assert.equal((await command(wsAwaited, '/stop compact')).body.stoppedCompact, true); await until(() => awaitedWsPlan.connection.closed, 'awaited compact-only cancellation'); assert(!(await history(wsAwaited)).session.busy)
  await fixture.save(config())

  const autoBackground = await create(); await seed(autoBackground, 'auto-background'); held.delete('plan'); await send(autoBackground, 'auto-tool'); await until(() => held.has('plan'), 'real usage-triggered tool-loop background planner')
  assert.equal(held.get('plan').body.prompt_cache_key, sha(autoBackground + '--compact-plan')); assert(!(await history(autoBackground)).session.busy, 'foreground tool continuation does not await background plan')
  held.get('plan').valid(); await until(async () => (await history(autoBackground)).messages.some(row => row.__meta?.contextBlock), 'automatic background ready apply')
  await fixture.save(config(false)); const autoAwaited = await create(); await seed(autoAwaited, 'auto-awaited'); held.delete('plan'); const awaitedStart = records.length
  await command(autoAwaited, 'CASE:auto-tool'); await until(() => held.has('plan'), 'real usage-triggered awaited tool-loop planner')
  assert.equal(held.get('plan').body.prompt_cache_key, sha(autoAwaited)); assert((await history(autoAwaited)).session.busy); assert((await history(autoAwaited)).session.runtimeState.active?.phase === 'compaction')
  assert.equal(records.slice(awaitedStart).filter(row => !row.planning).length, 1, 'paired tool result precedes planning and continuation waits for it')
  held.get('plan').valid(); await until(async () => !(await history(autoAwaited)).session.busy && (await history(autoAwaited)).messages.some(row => row.parts?.some(part => part.text === 'DONE-auto-tool')), 'automatic awaited continuation')
  await fixture.save(config())

  const shutdownSession = await create(); await seed(shutdownSession, 'shutdown'); await command(shutdownSession, 'CASE:held-shutdown'); await until(() => held.has('held-shutdown'), 'shutdown foreground')
  held.delete('plan'); await command(shutdownSession, '/compact'); await until(() => held.has('plan'), 'shutdown background'); const shutdownPlan = held.get('plan'), shutdownForeground = held.get('held-shutdown'), shutdownRows = (await history(shutdownSession)).messages
  const beforeRestart = (await history(main)).messages, effects = await readFile(join(fixture.work, 'gate-started'), 'utf8'); await fixture.stop(); assert(shutdownPlan.connection.closed); assert(shutdownForeground.connection.closed); await fixture.start()
  assert.deepEqual((await history(shutdownSession)).messages, shutdownRows); assert(!(await history(shutdownSession)).session.busy)
  assert.deepEqual((await history(main)).messages, beforeRestart); assert.equal(await readFile(join(fixture.work, 'gate-started'), 'utf8'), effects)
  assert.deepEqual(errors, []); await fixture.stop()
  console.log(JSON.stringify({ success: true, requests: records.length, planningRequests: records.filter(row => row.planning).length, plans, connections: connections.length, hostPids: fixture.hostPids, root: fixture.root }))
} catch (error) { console.error(error.stack, '\nErrors:', errors, '\nHost:', fixture.output, '\nRoot:', fixture.root, '\nRecords:', records.map(row => ({ kind: row.kind, scenario: row.scenario, planning: row.planning, previous: row.body.previous_response_id }))); throw error }
finally { for (const connection of connections) connection.ws.terminate(); await new Promise(done => server.close(done)); peer.closeAllConnections(); await new Promise(done => peer.close(done)); await fixture.cleanup() }
