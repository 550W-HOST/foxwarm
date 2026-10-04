// Ordinary retry admission through the original App, actual Main owner and four real wire transports.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const options = { env: {} }, fixture = await createHostFixture('retry-input', options), records = [], errors = [], held = new Map(), rounds = new Map(), sockets = []
const home = join(fixture.root, 'home'); await mkdir(home); options.env.HOME = home; options.cwd = fixture.root
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const route = id => '/api/sessions/' + encodeURIComponent(id), authority = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const final = value => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }], tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
let sequence = 0
function receive(body, full, protocol, headers, respond, fail, partial) {
  const serialized = JSON.stringify(full), planning = serialized.includes('COMPACTION STARTED:'), task = [...serialized.matchAll(/RCASE:([a-z0-9-]+)/g)].at(-1)?.[1] || 'seed'
  const record = { body, full, protocol, task, planning, headers, at: Date.now() }; records.push(record)
  if (planning) {
    const ranges = [...serialized.replaceAll('\\n', '\n').matchAll(/- M#(\d+)(?:-#(\d+))?\s/g)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length)
    record.valid = () => respond([tool('compact-' + (++sequence), 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Actual earlier paired dialogue, retained in order.' }] })]); held.set('plan', record); return
  }
  if (!task.startsWith('seed')) {
    const n = rounds.get(task) || 0; rounds.set(task, n + 1); record.n = n
    const failureIndex = task.startsWith('pair') ? 1 : 0
    if (task.startsWith('pair') && n === 0) { respond([{ ...final('COMMITTED-COMMENTARY')[0], phase: 'commentary' }, tool('paired-write', 'write', { filePath: '$fw_agentdir/paired-once.txt', content: 'Exactly one real paired write.' })]); return }
    if (n === failureIndex) { record.fail = () => { record.failedAt = Date.now(); fail() }; held.set(task, record); partial?.('UNCOMMITTED-STREAM-PROGRESS'); return }
  }
  respond(final('DONE-' + task + '-' + (record.n ?? 0)))
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw)
    const protocol = request.url.includes('/completions') ? 'completions' : request.url.includes('/anthropic') ? 'anthropic' : 'responses', full = body.input || body.messages
    const respond = output => {
      if (protocol === 'responses') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'http-' + (++sequence), output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n') }
      else if (protocol === 'completions') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: output[0].content[0].text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n') }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ content: [{ type: 'text', text: output[0].content[0].text }], usage: { input_tokens: 40, output_tokens: 4 } })) }
    }
    const partial = protocol === 'responses' ? value => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }) + '\n\n'); response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: value }) + '\n\n') } : undefined
    receive(body, full, protocol, request.headers, respond, () => { if (response.headersSent) response.end('data: ' + JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error', message: 'Owned synthetic stream failure.' } } }) + '\n\n'); else { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"message":"owned synthetic provider failure"}}') } }, partial)
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const wsServer = new WebSocketServer({ noServer: true }); peer.on('upgrade', (request, socket, head) => wsServer.handleUpgrade(request, socket, head, ws => wsServer.emit('connection', ws, request)))
wsServer.on('connection', (ws, request) => {
  const states = new Map(); sockets.push(ws); ws.on('error', error => errors.push(error.message))
  ws.on('message', raw => {
    try {
      const body = JSON.parse(raw), prefix = body.previous_response_id ? states.get(body.previous_response_id) : []; assert(prefix, 'Accepted prefix is connection-local')
      const full = [...prefix, ...body.input], respond = output => { const id = 'ws-' + (++sequence), replay = output.map(item => { const row = { ...item }; delete row.id; delete row.status; return row }); states.set(id, [...full, ...replay]); ws.send(JSON.stringify({ type: 'response.completed', response: { id, output, usage: { input_tokens: 40, output_tokens: 4 } } })) }
      receive(body, full, 'ws', request.headers, respond, () => ws.send(JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error', message: 'Owned synthetic stream failure.' } } })), value => { ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } })); ws.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: value })) })
    } catch (error) { errors.push(error.stack); ws.close(1011) }
  })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening'); const base = 'http://127.0.0.1:' + peer.address().port
const config = { default: 'responses', providers: Object.fromEntries([['responses', 'openai-responses'], ['completions', 'openai-completions'], ['anthropic', 'anthropic'], ['ws', 'openai-ws']].map(([key, providerType]) => [key, { providerType, baseUrl: base + '/' + key, models: ['wire'], contextLimit: 20000, asyncCompact: true, effort: { allowed: ['low', 'high'], default: 'low' }, extraFields: { test_cache: '${SESSION_CACHE_KEY}', ...(key === 'ws' ? {} : { test_turn: '${TURN_ID}' }) } }])) }
await writeModelFixture(fixture.data, config)
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#cc2277' } }).png().toBuffer()
async function create(id, model = 'responses') { assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200); assert.equal((await fixture.api('POST', route(id) + '/model', { model, effort: 'high' })).status, 200); return id }
async function post(id, text, extra = {}) { assert.equal((await fixture.api('POST', route(id) + '/message', { text, ...extra })).status, 202) }
async function done(id, task, n = 1) { await until(async () => { const state = await authority(id); return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + task + '-' + n)) }, task) }
async function upload() { const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), 'queued.png'); const response = await fetch(fixture.origin + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer synthetic-retry-input-api' }, body: form }); assert.equal(response.status, 200); return response.json() }
async function notice(id) { await until(async () => (await authority(id)).history.some(row => row.__meta?.noticeType === 'llm-retry'), 'committed retry notice') }
const marker = id => join(fixture.data, 'state/experiment-faults', 'id_' + Buffer.from(id).toString('base64url') + '.canonical-hold-before-rename')
try {
  await fixture.start(); const page = await fixture.openApp()
  for (const model of ['responses', 'completions', 'anthropic', 'ws']) {
    const id = await create('input-' + model, model), task = 'input-' + model
    if (model === 'responses') { await page.evaluate(id => window.foxwarmTest.switchToSession(id), id); await page.type('[role="textbox"][aria-label="Message"]', 'RCASE:' + task); await page.click('button[aria-label="Send message"]') }
    else { await post(id, 'RCASE:seed-' + model); await done(id, 'seed-' + model, 0); await post(id, 'RCASE:' + task) }
    await until(() => held.has(task), 'held provider ' + task); const before = await authority(id), initialKey = before.promptCacheKey; if (model === 'responses') await until(async () => (await page.evaluate(() => document.body.innerText)).includes('UNCOMMITTED-STREAM-PROGRESS'), 'Original App actual HTTP stream progress')
    const file = await upload(); await post(id, 'QUEUED-A-' + model); await post(id, 'QUEUED-B-' + model, { uploadedFiles: [file] }); await post(id, 'QUEUED-C-' + model)
    assert.equal((await fixture.api('POST', route(id) + '/model', { model, effort: 'low' })).status, 200)
    held.get(task).fail(); await done(id, task)
    const attempts = records.filter(row => row.task === task && !row.planning); assert.equal(attempts.length, 2); assert(attempts[1].at - held.get(task).failedAt >= 1900)
    const wire = JSON.stringify(attempts[1].full); for (const tag of ['A', 'B', 'C']) assert(wire.includes('QUEUED-' + tag + '-' + model)); assert.equal(wire.split(png.toString('base64')).length - 1, 1)
    assert(!wire.includes('UNCOMMITTED-STREAM-PROGRESS')); assert.equal(attempts[0].body.test_cache, attempts[1].body.test_cache); if (model !== 'ws') { assert(attempts[0].body.test_turn); assert.equal(attempts[0].body.test_turn, attempts[1].body.test_turn) }
    assert.equal(model === 'completions' ? attempts[1].body.reasoning_effort : model === 'anthropic' ? attempts[1].body.output_config.effort : attempts[1].body.reasoning.effort, 'high')
    if (model === 'ws') { assert(attempts[0].body.previous_response_id); assert(!attempts[1].body.previous_response_id); assert(wire.includes('DONE-seed-ws-0')) }
    const after = await authority(id); assert.equal(after.promptCacheKey, initialKey); assert.equal(after.queue.length, 0); assert(!JSON.stringify(after).includes(png.toString('base64')))
    const rows = after.history.filter(row => row.role === 'user' && row.parts?.some(part => part.text?.startsWith('QUEUED-'))); assert.equal(rows.length, 3); assert.deepEqual(rows.map(row => row.parts.find(part => part.text?.startsWith('QUEUED-')).text), ['A', 'B', 'C'].map(tag => 'QUEUED-' + tag + '-' + model))
  }
  const pair = await create('pair'), pairTask = 'pair-http'; await post(pair, 'RCASE:' + pairTask); await until(() => held.has(pairTask), 'error after actual pair'); await post(pair, 'QUEUED-AFTER-PAIR'); held.get(pairTask).fail(); await done(pair, pairTask, 2)
  const pairWire = records.find(row => row.task === pairTask && row.n === 2).full; const call = pairWire.findIndex(row => row.type === 'function_call' && row.call_id === 'paired-write'); assert(call >= 0); assert.equal(pairWire[call + 1].type, 'function_call_output'); assert.equal(pairWire[call + 1].call_id, 'paired-write'); assert.equal(JSON.stringify(pairWire).split('COMMITTED-COMMENTARY').length - 1, 1); assert.equal(await readFile(join(fixture.work, 'paired-once.txt'), 'utf8'), 'Exactly one real paired write.')
  for (const action of ['stop', 'dequeue']) {
    const id = await create('control-' + action), task = 'control-' + action; await post(id, 'RCASE:' + task); await until(() => held.has(task), task); await post(id, 'QUEUED-CONTROL'); held.get(task).fail(); await notice(id)
    await mkdir(join(fixture.data, 'state/experiment-faults'), { recursive: true }); await writeFile(marker(id), 'hold'); await until(async () => { try { await access(marker(id) + '.reached'); return true } catch { return false } }, 'real retry append held')
    const command = action === 'stop' ? fixture.api('POST', route(id) + '/stop') : fixture.api('POST', route(id) + '/message', { text: '/dequeue' }); await sleep(30); await rm(marker(id)); assert.equal((await command).status, 200)
    if (action === 'dequeue') await done(id, task); else await until(async () => !(await authority(id)).busy, 'stopped')
    const count = records.filter(row => row.task === task && !row.planning).length; assert.equal(count, action === 'stop' ? 1 : 2); assert.equal((await authority(id)).queue.length, 0)
  }
  const compact = await create('compact'); for (let i = 0; i < 6; i++) { const task = 'seed-compact-' + i; await post(compact, 'RCASE:' + task + '\n' + ('Earlier ordered paragraph ' + i + ' ').repeat(450)); await done(compact, task, 0) }
  const key = (await authority(compact)).promptCacheKey; await post(compact, 'RCASE:compact-only'); await until(() => held.has('compact-only'), 'foreground error held'); assert.equal((await fixture.api('POST', route(compact) + '/message', { text: '/compact' })).status, 202); await until(() => held.has('plan'), 'real background plan'); held.get('plan').valid(); await until(async () => (await authority(compact)).queue.some(row => row.type === 'compact-commit'), 'ready plan with zero ordinary queue'); held.get('compact-only').fail(); await done(compact, 'compact-only')
  const compactWire = records.find(row => row.task === 'compact-only' && row.n === 1); assert(JSON.stringify(compactWire.full).includes('CTX-BLOCK')); const compactState = await authority(compact); assert.equal(compactState.promptCacheKey, key); assert.equal(compactState.queue.length, 0)
  await fixture.stop(); assert.deepEqual(errors, []); console.log(JSON.stringify({ originalApp: true, requests: records.length, fourTransports: true, finiteOrderedInputs: true, freshImages: true, capturedEffortCacheTurn: true, committedPairCommentary: true, acceptedWsPrefixThenFailure: true, stopRunQueuedDuringRealAppend: true, readyCompactNoOrdinaryQueue: true, home, hosts: fixture.hostPids }))
} finally {
  await writeFile(join(fixture.root, 'retry-input-proof.json'), JSON.stringify({ records, errors, home, hosts: fixture.hostPids }, null, 2)).catch(() => {})
  await fixture.cleanup(); for (const ws of sockets) ws.terminate(); wsServer.close(); await new Promise(done => peer.close(done))
}
