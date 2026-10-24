#!/usr/bin/env node
// One original-App workflow over the real three HTTP adapters and shared route/attempt owner.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import yamlReader from 'js-yaml'
import { createHostFixture, saveModelsInOriginalApp, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('routing'), requests = [], errors = [], held = new Map(), closed = new Set()
let page, plannerRound = 0
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const state = async id => (await fixture.api('GET', route(id) + '/state')).body.session
const authority = async id => JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
const textOf = content => typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('\n')
function inputOf(body) {
  return body.input ? body.input.filter(item => item.role === 'user').map(item => textOf(item.content)).join('\n')
    : body.messages.filter(item => item.role === 'user').map(item => textOf(item.content)).join('\n')
}
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
function finish(response, protocol, content, usage = 30) {
  if (protocol === 'openai-responses') {
    response.setHeader('content-type', 'text/event-stream')
    const output = content.map(part => part.tool ? { type: 'function_call', id: part.id, call_id: part.id, name: part.name, arguments: JSON.stringify(part.args) }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: part.text }] })
    event(response, { type: 'response.completed', response: { id: 'response-' + requests.length, status: 'completed', output, usage: { input_tokens: usage, output_tokens: 3 } } })
  } else if (protocol === 'openai-completions') {
    response.setHeader('content-type', 'text/event-stream')
    const delta = {}, calls = content.filter(part => part.tool)
    if (calls.length) delta.tool_calls = calls.map((part, index) => ({ index, id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.args) } }))
    const text = content.filter(part => !part.tool).map(part => part.text).join(''); if (text) delta.content = text
    event(response, { choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
    event(response, { choices: [], usage: { prompt_tokens: usage, completion_tokens: 3 } })
  } else {
    response.setHeader('content-type', 'application/json')
    response.write(JSON.stringify({ content: content.map(part => part.thinking ? { type: 'thinking', thinking: part.thinking, signature: part.signature } : part.tool ? { type: 'tool_use', id: part.id, name: part.name, input: part.args } : { type: 'text', text: part.text }), usage: { input_tokens: usage, output_tokens: 3 } }))
  }
  response.end()
}
const output = text => [{ text }]
const tool = (id, name, args) => ({ tool: true, id, name, args })
function failure(response, status, text = 'synthetic request failure') { response.writeHead(status, { 'content-type': 'application/json' }); response.end(text) }
const protocols = { a: 'openai-responses', b: 'openai-completions', c: 'anthropic' }
function peer(label) {
  return createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const wire = Buffer.concat(chunks), encoding = request.headers['content-encoding']
      const bytes = encoding === 'gzip' ? gunzipSync(wire) : encoding === 'br' ? brotliDecompressSync(wire) : wire
      const body = JSON.parse(bytes), input = inputOf(body), planning = input.includes('COMPACTION STARTED:')
      const scenario = [...input.matchAll(/CASE:([a-z0-9-]+)/g)].at(-1)?.[1] || 'unknown'
      const record = { label, protocol: protocols[label], scenario, planning, body, headers: request.headers, at: Date.now() }; requests.push(record)
      assert.equal(request.url, label === 'a' ? '/v1/responses' : label === 'b' ? '/v1/chat/completions' : '/v1/messages')
      assert.equal(body.model, 'wire'); assert.equal(Number(request.headers['content-length']), wire.length)
      assert(body.cache && body.turn); assert(!JSON.stringify(body).includes('display-only message hidden'))
      if (planning) {
        plannerRound++; if (label === 'a') { assert(!JSON.stringify(body).includes('C-SIGNED-THOUGHT')); assert(!JSON.stringify(body).includes('synthetic-c-signature')) }
        const ranges = [...input.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
        assert(ranges.length); record.ranges = ranges
        if (plannerRound === 1) {
          held.set('compact-old', { record, finish: () => finish(response, protocols[label], [tool('plan-invalid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 999999, sourceEnd: 1000000, summary: 'Invalid.' }] })]) }); return
        }
        assert(JSON.stringify(body).includes('compact_plan_invalid')); assert.equal(request.headers['x-generation'], 'new-compact')
        assert.deepEqual(ranges, held.get('compact-old').record.ranges)
        finish(response, protocols[label], [tool('plan-valid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Source-owned route, paired local effects and immutable history evidence.' }] })]); return
      }
      if (scenario === 'default' && label === 'a') { failure(response, 429); return }
      if (scenario === 'default' && label === 'b' && !JSON.stringify(body).includes('default-write')) { finish(response, protocols[label], [tool('default-write', 'write', { filePath: 'default.txt', content: 'default-effect' })]); return }
      if (scenario === 'secret-cutoff' && label === 'a') { failure(response, 400, 'p'.repeat(236) + request.headers.authorization.replace('Bearer ', '') + ' tail'); return }
      if (scenario === 'terminal' && label === 'a') { failure(response, 400, '{"error":{"message":"invalid input"}}'); return }
      if (scenario === 'not-found' && label === 'a') { failure(response, 400, '{"error":{"details":["{\\"error\\":{\\"type\\":\\"model_not_found_error\\"}}"]}}'); return }
      if (scenario === 'old-held' && label === 'a') { held.set('old', { record, fail: () => failure(response, 503) }); return }
      if (scenario === 'old-held' && label === 'b') { failure(response, 503); return }
      if ((scenario === 'new-failure' || scenario === 'exhaust' || scenario === 'backoff-stop' || scenario === 'cool-probe') && label === 'a') { failure(response, 503); return }
      if (scenario === 'exhaust' && label === 'b') { failure(response, 503); return }
      if (scenario === 'held-stop') { response.on('close', () => closed.add('held-stop')); held.set('stop', { record, response }); return }
      if (scenario === 'paired' && !JSON.stringify(body).includes('route-write')) {
        finish(response, protocols[label], [{ thinking: 'C-SIGNED-THOUGHT', signature: 'synthetic-c-signature' }, tool('route-write', 'write', { filePath: 'route.txt', content: 'route-effect' }), tool('route-read', 'read', { filePath: 'route.txt' }), tool('route-bad', 'write', { filePath: 17, content: 'invalid' })]); return
      }
      if (scenario === 'paired') {
        assert.equal(await readFile(join(fixture.work, 'route.txt'), 'utf8'), 'route-effect')
        assert(JSON.stringify(body).includes('invalid_tool_arguments')); assert(JSON.stringify(body).includes('previous') || JSON.stringify(body).includes('prevLLMReqTime'))
      }
      finish(response, protocols[label], output('DONE-' + scenario + '-' + label), scenario === 'compact-trigger' ? 30000 : 30)
    } catch (error) { errors.push(error.stack); response.destroy(error) }
  })
}
const peers = Object.fromEntries(Object.keys(protocols).map(label => [label, peer(label)]))
for (const server of Object.values(peers)) server.listen(0, '127.0.0.1')
await Promise.all(Object.values(peers).map(server => once(server, 'listening')))
function configuration(generation = 'old', fastThreshold = 1) {
  const providers = {}
  for (const [label, protocol] of Object.entries(protocols)) providers[label] = {
    providerType: protocol, baseUrl: `http://127.0.0.1:${peers[label].address().port}${label === 'c' ? '' : '/v1'}`,
    apiKey: 'synthetic-' + generation + '-' + label, contextLimit: 20000, requestCompression: generation === 'old' ? 'gzip' : 'br',
    effort: label === 'a' ? { allowed: ['none', 'low'], default: 'low' } : label === 'b' ? { allowed: ['high', 'max'], default: 'high' } : { allowed: ['medium'], default: 'medium' },
    extraHeaders: { 'X-Generation': generation }, extraFields: { ...(label === 'c' ? { stream: false } : {}), cache: '${SESSION_CACHE_KEY}', turn: '${TURN_ID}' }, models: ['wire']
  }
  providers.route = { providerType: 'failover', targets: ['a', 'b/wire'], failureThreshold: 5, cooldownMs: 600000 }
  providers.fast = { providerType: 'failover', targets: ['a/wire', 'b'], failureThreshold: fastThreshold, cooldownMs: 600000 }
  providers.pool = { providerType: 'session-hash', targets: ['a', 'b/wire', 'c'] }
  providers.messages = { providerType: 'session-hash', targets: ['c/wire'] }
  return { default: 'route', providers }
}
async function newSession() { const response = await fixture.api('POST', '/api/sessions', {}); assert.equal(response.status, 200); return response.body.sessionId }
async function select(id, model, effort) { assert.equal((await fixture.api('POST', route(id) + '/model', { model, ...(effort === undefined ? {} : { effort }) })).status, 200) }
async function send(id, scenario, expected, timeout = 22000) {
  const start = requests.length; assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:' + scenario })).status, 202)
  await until(() => requests.length > start, scenario + ' entered')
  await until(async () => { const value = await history(id); return !value.session.busy && (!expected || value.messages.some(row => row.parts?.some(part => part.text === expected))) }, scenario + ' settled', timeout)
  assert.equal(errors.length, 0, errors.join('\n')); return requests.slice(start)
}
function hashTarget(key, targets) {
  return targets.map(target => [target, createHash('sha256').update('pool\0' + key + '\0' + target).digest()]).sort((a, b) => Buffer.compare(b[1], a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0]
}
try {
  await fixture.start(); const main = await newSession(); page = await fixture.openApp()
  await saveModelsInOriginalApp(page, yamlReader.dump(configuration()), fixture.modelPath)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), main)
  await page.click('.foxwarm-model-selector-trigger'); await page.waitForSelector('[data-model-column="current"] [data-model-option-key="route"]')
  await page.click('[data-model-column="current"] [data-model-option-key="route"]')
  assert.equal((await history(main)).session.effectiveEffort, null)
  const catalog = (await fixture.api('GET', '/api/models')).body
  assert.deepEqual(catalog.models.find(model => model.key === 'route').targets, ['a/wire', 'b/wire'])
  assert.equal(catalog.models.find(model => model.key === 'route').defaultEffort, null)
  assert(!JSON.stringify(catalog).includes('synthetic-old-a'))
  await select(main, 'route', 'max'); const beginning = requests.length, began = Date.now()
  await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:default'))
  await page.waitForSelector('[data-runtime-presentation="retry"]', { visible: true })
  await until(async () => !(await state(main)).busy && (await history(main)).messages.some(row => row.parts?.some(part => part.text === 'DONE-default-b')), 'real default sixth attempt', 100000)
  const defaults = requests.slice(beginning), elapsed = Date.now() - began
  assert.deepEqual(defaults.slice(0, 6).map(record => record.label), ['a', 'a', 'a', 'a', 'a', 'b'])
  assert.equal(defaults.length, 7); assert(elapsed >= 76500 && elapsed < 95000, elapsed)
  for (const record of defaults.slice(0, 5)) assert.equal(record.body.reasoning.effort, 'low')
  assert.equal(defaults[5].body.reasoning_effort, 'max')
  assert(defaults.slice(0, 6).every(record => record.body.cache === defaults[0].body.cache && record.body.turn === defaults[0].body.turn))
  const rows = (await history(main)).messages, notice = rows.find(row => row.__meta?.noticeType === 'llm-retry')
  assert.equal(rows.filter(row => row.__meta?.noticeType === 'llm-retry').length, 1); assert.equal(notice.modelVisible, false)
  assert.equal(notice.__meta.retry.attempt, 5); assert.equal(notice.parts[0].text.split('\n').length, 5); assert(notice.parts[0].text.includes('(same error)'))
  assert.equal(JSON.parse(fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [main, notice.__meta.seq])[0][0]).__meta.retry.attempt, 1)
  const call = rows.find(row => row.parts?.some(part => part.functionCall?.id === 'default-write')), pair = rows.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'default-write'))
  assert.equal(call.__meta.modelId, 'b/wire'); assert.equal(call.__meta.virtualModelKey, 'route')
  assert(call.__meta.llmRequestTiming.durationMs >= 76500); assert(pair.parts[0].functionResponse.previousLlmRequest.durationMs >= 76500)
  assert(defaults[6].body.messages.some(message => textOf(message.content).includes('prevLLMReqTime="77.')))
  assert.equal(await readFile(join(fixture.work, 'default.txt'), 'utf8'), 'default-effect')
  assert((await authority(main)).persistentMemorySnapshot.includes('b/wire'))

  const fast = await newSession(); await select(fast, 'fast')
  assert.deepEqual((await send(fast, 'terminal')).map(record => record.label), ['a'])
  assert.deepEqual((await send(fast, 'healthy', 'DONE-healthy-a')).map(record => record.label), ['a'])
  await send(fast, 'secret-cutoff'); const secretNotice = (await history(fast)).messages.at(-1)
  assert.equal(secretNotice.__meta.retry.reason, 'Configured model request failed.')
  assert(!JSON.stringify(secretNotice).includes('synthetic-old-a')); assert(!JSON.stringify(secretNotice).includes('synt…'))
  const secretArchive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [fast, secretNotice.__meta.seq])[0][0]
  assert(!secretArchive.includes('synthetic-old-a')); assert(!secretArchive.includes('synt…'))
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), fast)
  await page.waitForSelector('[data-runtime-presentation="error"]', { visible: true })
  assert(!(await page.evaluate(() => document.body.innerText)).includes('synthetic-old-a'))
  assert.deepEqual((await send(fast, 'not-found', 'DONE-not-found-b')).map(record => record.label), ['a', 'b'])

  await fixture.save(configuration('old-2')); const oldSession = await newSession(); await select(oldSession, 'fast')
  assert.equal((await fixture.api('POST', route(oldSession) + '/message', { text: 'CASE:old-held' })).status, 202)
  await until(() => held.get('old'), 'old request physically held'); const oldRecord = held.get('old').record
  await fixture.save(configuration('new')); const newer = await newSession(); await select(newer, 'fast')
  assert.deepEqual((await send(newer, 'new-failure', 'DONE-new-failure-b')).map(record => record.label), ['a', 'b'])
  // Isolate catalog reload: an explicit owner model change intentionally replaces its selection snapshot.
  held.get('old').fail()
  await until(async () => !(await state(oldSession)).busy, 'stale final target fails')
  const oldAttempts = requests.filter(record => record.scenario === 'old-held')
  assert.deepEqual(oldAttempts.map(record => record.label), ['a', 'b']); assert(oldAttempts.every(record => record.headers['x-generation'] === 'old-2'))
  assert(oldAttempts.every(record => record.body.cache === oldRecord.body.cache && record.body.turn === oldRecord.body.turn))
  assert.deepEqual((await send(newer, 'new-probe', 'DONE-new-probe-b')).map(record => record.label), ['b'])
  await fixture.save(configuration('old-2')); assert.deepEqual((await send(newer, 'rollback', 'DONE-rollback-a')).map(record => record.label), ['a'])
  assert.deepEqual((await send(newer, 'exhaust')).map(record => record.label), ['a', 'b'])
  assert.deepEqual((await send(newer, 'reset', 'DONE-reset-a')).map(record => record.label), ['a'])

  await fixture.save(configuration('stop', 2)); await select(newer, 'fast')
  const beforeStop = requests.length; assert.equal((await fixture.api('POST', route(newer) + '/message', { text: 'CASE:backoff-stop' })).status, 202)
  await until(async () => (await history(newer)).messages.at(-1)?.__meta?.noticeType === 'llm-retry', 'real backoff notice')
  assert.equal((await fixture.api('POST', route(newer) + '/stop', {})).status, 200)
  await until(async () => !(await state(newer)).busy, 'stop backoff idle'); await sleep(2100)
  assert.equal(requests.slice(beforeStop).length, 1)
  assert.deepEqual((await send(newer, 'cool-probe', 'DONE-cool-probe-b')).map(record => record.label), ['a', 'b'])
  await select(oldSession, 'messages'); assert.equal((await fixture.api('POST', route(oldSession) + '/message', { text: 'CASE:held-stop' })).status, 202)
  await until(() => held.get('stop'), 'Messages header held'); await fixture.api('POST', route(oldSession) + '/stop', {})
  await until(async () => !(await state(oldSession)).busy && closed.has('held-stop'), 'held HTTP Stop closed')

  await select(main, 'messages', null); await send(main, 'paired', 'DONE-paired-c')
  const paired = (await history(main)).messages.find(row => row.parts?.some(part => part.functionCall?.id === 'route-write'))
  assert.equal(paired.__meta.modelId, 'c/wire'); assert.equal(paired.__meta.virtualModelKey, 'messages')
  const pairedRows = (await history(main)).messages.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'route-write'))
  assert.equal(pairedRows.parts.length, 3); assert(pairedRows.parts[2].functionResponse.response.error)
  assert.equal((await history(main)).session.modelKey, 'messages')
  await fixture.api('POST', route(main) + '/child-model', { model: 'pool', childEffortDefault: 'max' })
  const childResponse = await fixture.api('POST', route(main) + '/children', { suffix: 'routing-child' }); assert.equal(childResponse.status, 200)
  const child = childResponse.body.sessionId, childMeta = (await history(child)).session
  assert.equal(childMeta.modelKey, 'pool'); assert.equal(childMeta.effort, 'max'); assert.equal(childMeta.effortDefault, null)
  const childKey = (await authority(child)).promptCacheKey; assert.notEqual(childKey, (await authority(main)).promptCacheKey)
  const expectedHash = hashTarget(childKey, ['a/wire', 'b/wire', 'c/wire']).split('/')[0]
  assert.equal((await send(child, 'hash', 'DONE-hash-' + expectedHash))[0].label, expectedHash)
  const reversed = configuration('stop', 2); reversed.providers.pool.targets.reverse(); await fixture.save(reversed)
  assert.equal((await send(child, 'hash-reordered', 'DONE-hash-reordered-' + expectedHash))[0].label, expectedHash)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), child); await page.waitForSelector(`[data-workbench-content-tab=${JSON.stringify('chat:' + child)}] .foxwarm-chat-root[data-chat-connection-state="connected"]`, { visible: true }); await page.locator('.foxwarm-model-selector-trigger').click()
  await page.waitForSelector('[data-model-column="current"] [data-model-option-key="pool"]')
  assert((await page.evaluate(() => document.body.innerText)).toLowerCase().includes('model'))

  await select(main, 'messages');
  for (let index = 0; index < 15; index++) await send(main, 'seed-' + index + ' ' + ('retained-routing-context-' + index + '-').repeat(100), 'DONE-seed-' + index + '-c')
  const snapshot = (await authority(main)).persistentMemorySnapshot
  assert.equal((await fixture.api('POST', route(main) + '/message', { text: 'CASE:compact-trigger' })).status, 202)
  await until(() => held.get('compact-old'), 'detached first compact request held')
  const archiveBefore = fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [main])
  const nextCompact = configuration('new-compact'); nextCompact.providers.messages.targets = ['a/wire'];
  await fixture.save(nextCompact); held.get('compact-old').finish()
  await until(async () => (await history(main)).messages.some(row => row.__meta?.contextBlock), 'real compact plan committed')
  await until(async () => !(await state(main)).busy, 'compact idle')
  const planning = requests.filter(record => record.planning); assert.equal(planning.length, 2)
  assert.equal(planning[0].headers['x-generation'], 'stop'); assert.equal(planning[1].headers['x-generation'], 'new-compact')
  assert.equal(planning[0].body.cache, planning[1].body.cache); assert.equal(planning[0].body.turn, planning[1].body.turn)
  assert.equal((await authority(main)).persistentMemorySnapshot, snapshot)
  assert.deepEqual(fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id=? AND seq<=? ORDER BY seq', [main, archiveBefore.at(-1)[0]]), archiveBefore)
  const block = (await history(main)).messages.find(row => row.__meta?.contextBlock).__meta.contextBlock
  assert.equal((await fixture.api('GET', route(main) + '/context-blocks/' + block.id + '/expand')).status, 200)
  const persistedKey = (await authority(main)).promptCacheKey, persistedRows = (await history(main)).messages
  await fixture.stop(); await fixture.start()
  assert.equal((await authority(main)).promptCacheKey, persistedKey); assert.deepEqual((await history(main)).messages, persistedRows)
  assert.equal(await readFile(join(fixture.work, 'route.txt'), 'utf8'), 'route-effect')
  await select(newer, 'fast'); assert.deepEqual((await send(newer, 'after-restart', 'DONE-after-restart-a')).map(record => record.label), ['a'])
  await fixture.stop(); assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ result: 'ok', hostPids: fixture.hostPids, requests: requests.length, plannerRounds: plannerRound, defaultRetryElapsedMs: elapsed, outerTimingMs: call.__meta.llmRequestTiming.durationMs, originalAppRouting: true, generationDetachment: true, immutableNoticeArchive: true, compactRoundReload: true }))
} catch (error) {
  console.error('OWNED_ROOT', fixture.root); console.error('HOST_OUTPUT', fixture.output); console.error('PEER_ERRORS', errors)
  if (page) console.error('BROWSER_TEXT', await page.evaluate(() => document.body.innerText).catch(() => 'closed'))
  throw error
} finally {
  await fixture.cleanup()
  for (const server of Object.values(peers)) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
}
