import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { WebSocketServer } from 'ws'
import { createHostFixture, saveModelsInOriginalApp, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('responses-ws'), records = [], errors = [], held = new Map(), connections = [], clientFrames = [], upgrades = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const authority = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const textOf = item => (item.content || []).map(part => part.text || '').join('')
const inputOf = input => input.filter(item => item.role === 'user').map(textOf).join('\n')
const final = text => [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }]
const tool = (id, name, args) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const replay = output => output.map(item => { const projected = { ...item }; delete projected.id; delete projected.status; return projected })
let plannerRound = 0, compactMode = 'same', compactRanges, responseSequence = 0
const peer = createServer((request, response) => { response.writeHead(400); response.end('upgrade required') })
const server = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 } })
peer.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/upgrade-fail/')) { upgrades.push({ status: 400, path: request.url }); socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return }
  server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request))
})
server.on('connection', (ws, request) => {
  const connection = { id: connections.length + 1, headers: request.headers, path: request.url, ws, states: new Map(), close: null }; connections.push(connection)
  let bytes = Buffer.alloc(0)
  ws._socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk])
    while (bytes.length >= 2) {
      const opcode = bytes[0] & 15, compressed = !!(bytes[0] & 64), masked = !!(bytes[1] & 128); let size = bytes[1] & 127, offset = 2
      if (size === 126) { if (bytes.length < 4) return; size = bytes.readUInt16BE(2); offset = 4 }
      if (size === 127) { if (bytes.length < 10) return; size = Number(bytes.readBigUInt64BE(2)); offset = 10 }
      const end = offset + (masked ? 4 : 0) + size; if (bytes.length < end) return
      if (opcode === 1 || opcode === 0) clientFrames.push({ opcode, compressed, connection: connection.id })
      bytes = bytes.subarray(end)
    }
  })
  ws.on('close', code => { connection.close = code })
  ws.on('error', error => errors.push('peer socket: ' + error.message))
  ws.on('message', async raw => {
    try {
      const body = JSON.parse(raw), previous = body.previous_response_id, prefix = previous ? connection.states.get(previous) : []
      assert.equal(body.type, 'response.create'); assert(prefix, 'previous id belongs to this actual connection')
      const full = [...prefix, ...body.input], input = inputOf(full), planning = input.includes('COMPACTION STARTED:'), scenario = [...input.matchAll(/CASE:([a-z0-9-]+)/g)].at(-1)?.[1] || 'unknown'
      const record = { connection: connection.id, body, full, planning, scenario, headers: request.headers, at: Date.now() }; records.push(record)
      assert.equal(body.model, 'wire'); assert(!Object.hasOwn(body, 'stream')); assert.equal(Number(request.headers['content-length']), 0)
      assert.equal(request.headers['content-type'], 'application/json'); assert.equal(request.headers.originator, 'codex-tui')
      assert(request.headers['user-agent'].startsWith('codex-tui/')); assert(request.headers['sec-websocket-extensions'].includes('permessage-deflate'))
      const complete = output => {
        const id = 'response-' + (++responseSequence), response = { id, status: 'completed', output, usage: { input_tokens: 40, output_tokens: 3 } }
        connection.states.set(id, [...full, ...replay(output)]); ws.send(JSON.stringify({ type: 'response.completed', response }), { compress: true })
      }
      record.complete = complete
      if (planning) {
        plannerRound++; const ranges = [...input.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length)
        if (plannerRound % 2 === 1) {
          compactRanges = ranges; held.set('compact', record)
          record.invalid = () => complete([tool('invalid-plan-' + plannerRound, 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 999999, sourceEnd: 1000000, summary: 'Invalid.' }] })]); return
        }
        const rejected = [...full].reverse().find(item => item.type === 'function_call_output'); assert(rejected); assert.match(rejected.output, /\btype:\s*compact_plan_invalid\b/); assert.deepEqual(ranges, compactRanges)
        if (compactMode === 'same') { assert(previous, 'transient append enables invalid-feedback suffix'); assert(!Object.hasOwn(body, 'max_output_tokens')) }
        else { assert(!previous, 'changed catalog connection/invariant reconnects'); assert.equal(body.max_output_tokens, 713) }
        complete([tool('valid-plan-' + plannerRound, 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Ordered prefix and exact paired state evidence.' }] })]); return
      }
      if (scenario === 'failover') { ws.close(1011, 'synthetic active failure'); return }
      if (scenario === 'missing-id' && !records.some(other => other !== record && other.scenario === scenario)) { ws.send(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: final('discarded') } }), { compress: true }); return }
      if (scenario === 'refusal') { complete([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Refused safely.' }] }]); return }
      if (scenario === 'held-stop' || scenario === 'parallel-a' || scenario === 'parallel-b') {
        ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } }), { compress: true })
        ws.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'VISIBLE-' }), { compress: true })
        held.set(scenario, record); return
      }
      if (scenario === 'paired' && !full.some(item => item.type === 'function_call_output' && item.call_id === 'ws-write')) {
        complete([tool('ws-write', 'write', { filePath: 'ws-effect.txt', content: 'one effect' }), tool('ws-read', 'read', { filePath: 'ws-effect.txt' }), tool('ws-bad', 'write', '[]')]); return
      }
      complete(final('DONE-' + scenario))
    } catch (error) { errors.push(error.stack); ws.terminate() }
  })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const http = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); records.push({ label: 'http', body, headers: request.headers, scenario: 'failover', at: Date.now() })
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'http-response', output: final('HTTP-failover') } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
http.listen(0, '127.0.0.1'); await once(http, 'listening')
function configuration(generation = 'one', path = '') {
  return { default: 'a', providers: {
    a: { providerType: 'openai-ws', asyncCompact: false, baseUrl: `http://127.0.0.1:${peer.address().port}${path}`, apiKey: 'synthetic-' + generation, models: ['wire'], contextLimit: 19000, extraHeaders: { 'X-Generation': generation, 'X-Cache': '${SESSION_CACHE_KEY}' }, extraFields: { cache: '${SESSION_CACHE_KEY}' } },
    b: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${http.address().port}`, models: ['wire'], extraFields: { cache: '${SESSION_CACHE_KEY}' } },
    fail: { providerType: 'failover', targets: ['a', 'b'], failureThreshold: 1 }
  } }
}
const create = async () => { const value = await fixture.api('POST', '/api/sessions', {}); assert.equal(value.status, 200); return value.body.sessionId }
async function select(id, key) { assert.equal((await fixture.api('POST', route(id) + '/model', { model: key })).status, 200) }
async function send(id, scenario, expected, timeout = 22000) {
  const start = records.length; assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:' + scenario })).status, 202)
  await until(() => records.length > start, scenario + ' wire'); await until(async () => { const result = await history(id); return !result.session.busy && (!expected || result.messages.some(row => row.parts?.some(part => part.text?.includes(expected)))) }, scenario + ' canonical', timeout)
  assert.equal(errors.length, 0, errors.join('\n')); return records.slice(start)
}
try {
  await fixture.start(); const main = await create(); const page = await fixture.openApp(); await saveModelsInOriginalApp(page, yaml.dump(configuration()), fixture.modelPath)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), main); await page.click('.foxwarm-model-selector-trigger'); await page.waitForSelector('[data-model-column="current"] [data-model-option-key="a"]'); await page.click('[data-model-column="current"] [data-model-option-key="a"]')
  let wire = await send(main, 'first', 'DONE-first'); assert.equal(wire.length, 1); assert.equal(wire[0].body.max_output_tokens, 713); assert(!wire[0].body.previous_response_id)
  const cache = (await authority(main)).promptCacheKey, expectedCache = createHash('sha256').update(main).digest('hex')
  assert.notEqual(cache, expectedCache); assert.equal(wire[0].body.prompt_cache_key, expectedCache); assert.equal(wire[0].body.cache, expectedCache); assert.equal(wire[0].headers['x-cache'], expectedCache)
  wire = await send(main, 'next', 'DONE-next'); assert(wire[0].body.previous_response_id); assert.equal(wire[0].body.input.length, 1); assert(!Object.hasOwn(wire[0].body, 'max_output_tokens'))
  wire = await send(main, 'paired', 'DONE-paired'); assert.equal(wire.length, 2); assert.equal(await readFile(join(fixture.work, 'ws-effect.txt'), 'utf8'), 'one effect')
  assert(wire[0].body.previous_response_id); assert(!wire[1].body.previous_response_id, 'canonical array argument error discards prior completion despite ordinary paired errors')
  assert(JSON.stringify(wire[1].body.input).includes('invalid_tool_arguments')); assert(JSON.stringify(wire[1].body.input).includes('prevLLMReqTime'))
  const archive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [main]); const beforeSwitch = (await authority(main)).persistentMemorySnapshot
  await fixture.save(configuration('two')); wire = await send(main, 'config-change', 'DONE-config-change'); assert(!wire[0].body.previous_response_id); assert.equal(wire[0].headers.authorization, 'Bearer synthetic-two'); assert.equal((await authority(main)).promptCacheKey, cache); assert.equal((await authority(main)).persistentMemorySnapshot, beforeSwitch)
  assert.deepEqual(fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq LIMIT ?', [main, archive.length]), archive)
  await send(main, 'refusal', 'Refused safely.'); wire = await send(main, 'after-refusal', 'DONE-after-refusal'); assert(!wire[0].body.previous_response_id)
  wire = await send(main, 'missing-id', 'DONE-missing-id'); assert.equal(wire.length, 2); assert(!wire[1].body.previous_response_id, 'failed completion reconnects without ambiguous state'); assert.equal((await history(main)).messages.filter(row => row.__meta?.noticeType === 'llm-retry').length, 1)
  const failed = await create(); await select(failed, 'fail'); wire = await send(failed, 'failover', 'HTTP-failover'); assert.deepEqual(wire.map(record => record.label || 'ws'), ['ws', 'http']); assert.equal(wire[1].body.cache, (await authority(failed)).promptCacheKey)
  const upgrade = await create(); await fixture.save(configuration('upgrade', '/upgrade-fail')); await select(upgrade, 'fail'); wire = await send(upgrade, 'upgrade', 'HTTP-failover'); assert.equal(wire.length, 1); assert.equal(wire[0].label, 'http'); assert.equal(upgrades.length, 1); assert.equal(upgrades[0].status, 400); assert((await history(upgrade)).messages.some(row => row.__meta?.retry?.kind === 'request-error'))
  await fixture.save(configuration('two')); const stopped = await create(); await select(stopped, 'a'); await page.evaluate(id => window.foxwarmTest.switchToSession(id), stopped); await page.waitForSelector(`[data-workbench-content-tab=${JSON.stringify('chat:' + stopped)}] .foxwarm-chat-root[data-chat-connection-state="connected"]`, { visible: true }); await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:held-stop'))
  await until(() => held.has('held-stop'), 'actual held frame'); await until(async () => (await page.evaluate(() => document.body.innerText)).includes('VISIBLE-'), 'genuine original draft progress')
  assert.equal((await fixture.api('POST', route(stopped) + '/stop')).status, 200); await until(async () => !(await history(stopped)).session.busy, 'held Stop'); assert(!(await history(stopped)).messages.some(row => row.role === 'model' && row.modelVisible !== false)); await send(stopped, 'after-stop', 'DONE-after-stop')
  const parallelA = await create(), parallelB = await create(); await Promise.all([select(parallelA, 'a'), select(parallelB, 'a')]); await Promise.all(['a', 'b'].map((label, i) => fixture.api('POST', route([parallelA, parallelB][i]) + '/message', { text: 'CASE:parallel-' + label })))
  await until(() => held.has('parallel-a') && held.has('parallel-b'), 'two actual active leases'); assert.notEqual(held.get('parallel-a').connection, held.get('parallel-b').connection)
  await fixture.api('POST', route(parallelA) + '/stop'); held.get('parallel-b').complete(final('VISIBLE-DONE-parallel-b')); await until(async () => !(await history(parallelB)).session.busy, 'other lease finished'); assert((await history(parallelB)).messages.some(row => row.parts?.some(part => part.text?.includes('DONE-parallel-b'))))
  async function compact(mode) {
    compactMode = mode; held.delete('compact'); for (let i = 0; i < 12; i++) await send(main, `seed-${mode}-${i} ${('ordered-prefix-' + mode + '-' + i + '-').repeat(110)}`, `DONE-seed-${mode}-${i}`)
    const snapshot = await history(main), original = snapshot.messages; let split = Math.floor(original.length * .7); if (original[split]?.role === 'tool') { while (split > 0 && original[split].role === 'tool') split--; if (original[split]?.role !== 'model') throw new Error('unexpected atomic split') }
    const tail = original.slice(split), tailTexts = tail.flatMap(row => row.parts?.map(part => part.text).filter(Boolean) || []); const firstPrefixText = original[0].parts.find(part => typeof part.text === 'string')?.text || original[0].parts.find(part => typeof part.system === 'string')?.system
    const persisted = (await authority(main)).persistentMemorySnapshot; assert.equal((await fixture.api('POST', route(main) + '/message', { text: '/compact' })).status, 200)
    await until(() => held.has('compact'), 'planner prefix held'); const first = held.get('compact'); assert(!first.body.previous_response_id); assert.equal(first.body.max_output_tokens, 713)
    const serialized = first.full.map(textOf).join('\n'); assert(serialized.includes(firstPrefixText)); for (const text of tailTexts) assert(!serialized.includes(text), 'forced tail excluded')
    assert.equal((await fixture.api('POST', route(main) + '/message', { text: 'CASE:after-compact-' + mode })).status, 202)
    if (mode === 'changed') await fixture.save(configuration('compact-new'))
    first.invalid(); await until(async () => !(await history(main)).session.busy && (await history(main)).messages.some(row => row.__meta?.contextBlock), 'actual compact feedback reused/committed')
    await until(async () => (await history(main)).messages.some(row => row.parts?.some(part => part.text === 'DONE-after-compact-' + mode)), 'legal later ingress survives compact commit')
    const after = await history(main); for (const row of tail) assert(after.messages.some(current => current.__meta?.seq === row.__meta?.seq), 'live tail preserved'); assert.equal((await authority(main)).persistentMemorySnapshot, persisted)
  }
  await compact('same'); await compact('changed')
  assert.equal(errors.length, 0, errors.join('\n')); assert(clientFrames.length > 0); assert(clientFrames.every(frame => !frame.compressed), 'all actual client create frames DisableCompression')
  const beforeRestart = records.length, finalHistory = await history(main); await fixture.stop(); await fixture.start(); assert.deepEqual((await history(main)).messages, finalHistory.messages)
  wire = await send(main, 'restart', 'DONE-restart'); assert(!wire[0].body.previous_response_id); assert.equal(wire[0].body.max_output_tokens, 713); assert.equal(records.length, beforeRestart + 1)
  await fixture.stop(); console.log(JSON.stringify({ result: 'ok', hostPids: fixture.hostPids, requests: records.length, connections: connections.length, plannerRounds: plannerRound, clientFrames: clientFrames.length, originalAppStatefulWs: true, clientCompressionDisabled: true, compressedResponses: true, exactPrefixCompact: true, transientInvalidFeedbackReuse: true, selectiveStop: true, failoverUpgrade: true, restart: true }))
} finally {
  await fixture.cleanup(); for (const connection of connections) connection.ws.terminate(); server.close(); await Promise.all([peer, http].map(socket => new Promise(done => socket.close(done))))
}
