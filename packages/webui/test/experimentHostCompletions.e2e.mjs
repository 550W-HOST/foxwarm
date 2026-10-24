#!/usr/bin/env node
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
// Real original-App Chat Completions requests, paired effects, compaction and restart.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import puppeteer from 'puppeteer-core'
import { waitForWebUiReady } from './webuiReadiness.mjs'
import yamlReader from 'js-yaml'
import { saveModelsInOriginalApp } from './experimentHostFixture.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, label, timeout = 22000) { const end = Date.now() + timeout; while (Date.now() < end) { if (errors.length) throw new Error(errors.join('\n')); if (await check()) return; await sleep(25) } throw new Error('Timed out: ' + label) }
async function freePort() { const socket = tcpServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(done => socket.close(done)); return port }
const root = await mkdtemp(join(tmpdir(), 'foxwarm-completions-')), data = join(root, 'data'), work = join(data, 'agents', 'main')
await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work, { recursive: true })
await writeFile(join(data, 'state/config.yaml'), 'llm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n')
const apiToken = 'synthetic-completions-api', oldToken = 'synthetic-completions-old', newToken = 'synthetic-completions-new'
const dotnet = join(process.env.DOTNET_ROOT, 'dotnet'), hostPort = await freePort(), origin = `http://127.0.0.1:${hostPort}`
await writeFile(join(data, 'state/config.yaml'), (await readFile(join(data, 'state/config.yaml'), 'utf8')) + `bot: {httpPort: ${hostPort}}\n`)
await writeFile(join(data, 'state/token'), apiToken, { mode: 0o600 })
const modelPath = join(data, 'state/models.yaml'), effectPath = join(work, 'note.txt')
let host, browser, page, current, flowHold, stopHold, plannerRound = 0
const requests = [], hostPids = [], errors = [], closed = new Set(), intervals = new Set()
const opaque = { signature: 'synthetic-opaque-signature', vendor: { nested: [null, 17, 'kept'] } }
const textOf = content => typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('\n')
const inputOf = body => body.messages.map(message => textOf(message.content)).join('\n')
const event = (response, data) => response.write('data: ' + JSON.stringify(data) + '\r\n\r\n')
const delta = (response, value, finish = null) => event(response, { choices: [{ index: 0, delta: value, finish_reason: finish }] })
function complete(response, text, usage = { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 2 } }) {
  delta(response, { content: text }, 'stop'); event(response, { choices: [], usage }); response.write('data: [DONE]\n\n'); response.end()
}
function call(response, id, name, args) { delta(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls'); response.end() }
function noise(response, name) {
  const interval = setInterval(() => { response.write(': keepalive\n\n'); delta(response, { role: 'assistant' }); event(response, { choices: [], usage: { prompt_tokens: 1 } }); }, 30)
  intervals.add(interval); response.on('close', () => { clearInterval(interval); intervals.delete(interval); closed.add(name) })
}
function peer(label) {
  return createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const wire = Buffer.concat(chunks); let bytes = wire
      if (request.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes)
      if (request.headers['content-encoding'] === 'br') bytes = brotliDecompressSync(bytes)
      const body = JSON.parse(bytes)
      if (request.url === '/v1/responses') {
        const input = JSON.stringify(body.input); requests.push({ label, body, headers: request.headers, user: 'responses-destination' })
        assert.equal(body.model, 'same-wire'); assert(!body.input.some(item => item.type === 'reasoning'))
        assert(!input.includes('Preferred reasoning')); assert(!input.includes('synthetic-opaque-signature'))
        assert(input.includes('FLOW-DONE')); assert(body.input.some(item => item.call_id === 'call_write')); assert(body.input.some(item => item.call_id === 'call_read'))
        response.setHeader('content-type', 'text/event-stream')
        event(response, { type: 'response.completed', response: { id: 'cross-response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESPONSES-CROSS-DONE' }] }], usage: { input_tokens: 12, output_tokens: 3 } } }); response.end(); return
      }
      const user = body.messages.filter(message => message.role === 'user')
        .findLast(message => textOf(message.content).includes('<foxwarm-message type="channel"')), input = inputOf(body)
      const record = { label, body, headers: request.headers, wireBytes: wire.length, user: textOf(user?.content) }; requests.push(record)
      const repeatedFailure = ['malformed-sse', 'provider-error', 'http-error', 'empty-eof', 'whitespace-disallowed', 'inactivity', 'first-content'].find(name => record.user.includes(name))
      if (repeatedFailure && requests.filter(item => item.user.includes(repeatedFailure)).length > 1) { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"synthetic terminal after observed first failure"}'); return }
      assert.equal(request.url, '/v1/chat/completions'); assert.match(request.headers['user-agent'], /^foxwarm\//); assert.equal(body.model, 'same-wire'); assert.equal(body.max_tokens, 911); assert.deepEqual(body.stream_options, { include_usage: true }); assert.equal(body.stream, true)
      assert.equal(Number(request.headers['content-length']), wire.length); assert.equal(body.reasoning_effort, 'high'); assert.equal(body.messages[0].role, 'system')
      assert(body.tools?.every(tool => tool.type === 'function' && tool.function.strict === false))
      response.setHeader('content-type', 'text/event-stream')
      const plan = body.messages.map(message => textOf(message.content)).findLast(text => text.includes('COMPACTION STARTED:'))
      if (plan) {
        assert(!input.includes('COMPACT A THOUGHT')); assert(!input.includes('compact-a-opaque')); plannerRound++; assert(body.tools.find(tool => tool.function.name === 'submit_compact_plan'))
        if (plannerRound === 1) { call(response, 'plan-invalid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 99999, sourceEnd: 100000, summary: 'Invalid range.' }] }); return }
        assert(input.includes('compact_plan_invalid'))
        const ranges = [...plan.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
        assert(ranges.length > 0, plan)
        call(response, 'plan-valid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Source-bound Completions summary retaining the accepted local workflow.' }] }); return
      }
      if (record.user.includes('tool-flow') && !body.messages.some(message => message.tool_call_id === 'call_write')) {
        assert.equal(request.headers.authorization, 'Bearer ' + oldToken)
        delta(response, { role: 'assistant', reasoning_content: 'Preferred reasoning ', reasoning: 'Compatibility reasoning', provider_specific_fields: { obsolete: true } })
        event(response, { choices: [{ index: 1, delta: { content: 'ignored choice' } }] })
        delta(response, { provider_specific_fields: opaque, tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'wri', arguments: '{"filePath":"note.txt",' } }] })
        delta(response, { tool_calls: [{ index: 0, id: 'write', function: { name: '', arguments: '' } }] })
        flowHold = { record, response, finish: async () => {
          const payload = Buffer.from('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'te', arguments: '"content":"héllo"}' } }] } }] }) + '\n\n')
          for (let offset = 0; offset < payload.length; offset++) response.write(payload.subarray(offset, offset + 1))
          delta(response, { tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: '{"filePath":"note.txt"}' } }] })
          delta(response, { tool_calls: [{ index: 2, id: 'call_bad', type: 'function', function: { name: 'write', arguments: '{"filePath":' } }] }, 'tool_calls')
          event(response, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 2 } } }); response.write('data: [DONE]\n\n'); response.end()
        } }; return
      }
      if (record.user.includes('tool-flow')) {
        assert.equal(label, 'second'); assert.equal(request.headers.authorization, 'Bearer ' + newToken)
        const model = body.messages.findLast(message => message.tool_calls?.some(call => call.id === 'call_write'))
        assert.equal(model.reasoning, 'Preferred reasoning '); assert(!('reasoning_content' in model)); assert.deepEqual(model.provider_specific_fields, opaque)
        assert.deepEqual(model.tool_calls.map(call => call.id), ['call_write', 'call_read', 'call_bad'])
        const toolRows = body.messages.filter(message => message.role === 'tool'); assert.deepEqual(toolRows.slice(-3).map(message => message.tool_call_id), ['call_write', 'call_read', 'call_bad'])
        assert(Array.isArray(toolRows.at(-3).content)); assert.match(textOf(toolRows.at(-3).content), /<foxwarm-system kind="time"/); assert(textOf(toolRows.at(-2).content).includes('héllo')); assert(textOf(toolRows.at(-1).content).includes('invalid_tool_arguments'))
        const authority = JSON.parse(await readFile(join(data, 'state/sessions', current + '.json'), 'utf8')); const pair = authority.history.at(-1)
        assert.equal(pair.role, 'tool'); assert.equal(pair.parts.length, 3); assert(pair.parts[0].functionResponse.previousLlmRequest); assert.equal(await readFile(effectPath, 'utf8'), 'héllo')
        assert.equal(record.body.turn, flowHold.record.body.turn); assert.equal(record.body.cache, flowHold.record.body.cache)
        complete(response, 'FLOW-DONE'); return
      }
      if (record.user.includes('cross-concrete')) {
        assert(body.messages.filter(message => message.role === 'assistant').every(message => !message.provider_specific_fields && !('reasoning' in message) && !('reasoning_content' in message)))
        assert(input.includes('FLOW-DONE')); assert(body.messages.some(message => message.tool_calls?.some(call => call.id === 'call_write'))); assert(body.messages.some(message => message.tool_call_id === 'call_read'))
        complete(response, 'CROSS-DONE'); return
      }
      if (record.user.includes('same-concrete-replay')) {
        const replay = body.messages.find(message => message.tool_calls?.some(call => call.id === 'call_write'))
        assert.equal(replay.reasoning, 'Preferred reasoning '); assert.deepEqual(replay.provider_specific_fields, opaque); complete(response, 'REPLAY-DONE'); return
      }
      if (record.user.includes('seed-compact-0 ')) delta(response, { reasoning_content: 'COMPACT A THOUGHT', provider_specific_fields: { value: 'compact-a-opaque' } })
      if (record.user.includes('seed-compact-trigger')) { assert(!input.includes('COMPACT A THOUGHT')); assert(!input.includes('compact-a-opaque')) }
      if (record.user.includes('malformed-sse')) { response.end('data: {broken}\n\n'); return }
      if (record.user.includes('provider-error')) { event(response, { error: { message: 'Provider error ' + newToken } }); response.end(); return }
      if (record.user.includes('http-error')) { response.writeHead(429, { 'content-type': 'text/plain' }); response.end('secret ' + newToken); return }
      if (record.user.includes('empty-eof')) { response.end(': empty\n\n'); return }
      if (record.user.includes('usage-only')) { event(response, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } }); response.end(); return }
      if (record.user.includes('whitespace')) { complete(response, ' \t'); return }
      if (record.user.includes('no-terminal')) { delta(response, { content: 'EOF-DONE' }); response.end(); return }
      if (record.user.includes('missing-id')) { delta(response, { tool_calls: [{ index: 0, type: 'function', function: { name: 'write', arguments: '{"filePath":"must-not-exist","content":"bad"}' } }] }); response.end(); return }
      if (record.user.includes('inactivity')) { delta(response, { content: 'one meaningful delta' }); noise(response, 'inactivity'); return }
      if (record.user.includes('first-content')) { await sleep(110000); noise(response, 'first-content'); return }
      if (record.user.includes('stop-stream')) { delta(response, { reasoning: 'Transient only' }); stopHold = response; response.on('close', () => closed.add('stop')); return }
      if (record.user.includes('seed-compact-trigger')) { complete(response, 'COMPACT-TRIGGER', { prompt_tokens: 30000, completion_tokens: 2 }); return }
      complete(response, record.user.includes('after-restart') ? 'RESTART-DONE' : 'PLAIN-DONE')
    } catch (error) { errors.push(error.stack); response.destroy(error) }
  })
}
const first = peer('first'), second = peer('second'); first.listen(0, '127.0.0.1'); second.listen(0, '127.0.0.1'); await Promise.all([once(first, 'listening'), once(second, 'listening')])
function configuration(server, token, compression = 'gzip') {
  const url = server => `http://127.0.0.1:${server.address().port}/v1`
  const leaf = (server, token, field) => ({ providerType: 'openai-completions', asyncCompact: false, baseUrl: url(server), apiKey: token, contextLimit: 20000, historyReasoningField: field,
    requestCompression: compression, webSearch: true, keepReasoningOnError: true, extraHeaders: { 'Content-Encoding': 'overridden', 'Content-Length': '1', 'X-Captured': token },
    extraFields: { max_tokens: 911, reasoning_effort: 'none', cache: '${SESSION_CACHE_KEY}', turn: '${TURN_ID}', nested: { kept: null } }, models: ['same-wire'] })
  const responses = { ...leaf(second, newToken, 'reasoning_content'), providerType: 'openai-responses', webSearch: false, keepReasoningOnError: false,
    extraFields: { max_output_tokens: 911, cache: '${SESSION_CACHE_KEY}', turn: '${TURN_ID}' } }
  delete responses.historyReasoningField
  return yamlReader.dump({ default: 'a', providers: { a: leaf(server, token, 'reasoning'), b: leaf(second, newToken, 'reasoning_content'), c: responses } }).replaceAll('\n', '\r\n')
}
async function api(method, path, body) { const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + apiToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => ({})) } }
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function history() { return (await api('GET', route(current) + '/history')).body }
async function state() { return (await api('GET', route(current) + '/state')).body.session }
const notices = value => value.messages.filter(row => ['system-event', 'llm-retry'].includes(row.__meta?.noticeType))
const terminalFailure = row => row.__meta?.sessionNotice?.source === 'session' || row.__meta?.retry?.final === true
async function start() {
  const child = spawn(dotnet, [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...testEnvironment.isolatedApplicationEnv(data), FOXWARM_DATA_DIR: data, FOXWARM_EXPERIMENT_API_TOKEN: apiToken, } }); let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000) }); host = { child, get output() { return output } }; hostPids.push(child.pid)
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await api('GET', '/health')).status === 200 } catch { return false } }, 'host ready')
}
async function save(raw) { assert.equal((await api('POST', '/api/setup/models', { yaml: raw })).status, 200); assert.equal(await readFile(modelPath, 'utf8'), raw) }
async function send(text, expected, timeout = 22000) {
  const count = requests.length, previous = (await history()).latestSeq
  assert.equal((await api('POST', route(current) + '/message', { text })).status, 202)
  await until(async () => requests.length > count || notices(await history()).some(row => row.__meta.seq > previous && terminalFailure(row)), 'request entered')
  await until(async () => { const value = await history(); return !value.session.busy && (!expected || value.messages.some(row => row.parts?.some(part => part.text === expected))) }, expected || 'settled failure', timeout)
  assert.equal(errors.length, 0, errors.join('\n')); return requests.slice(count)
}
async function stopHost() { assert.equal((await api('POST', '/admin/shutdown')).status, 202); const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(12000).then(() => 'timeout')]); assert.equal(code, 0, host.output) }
try {
  await start(); current = (await api('POST', '/api/sessions', {})).body.sessionId
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(root, 'browser') })
  page = await browser.newPage(); await page.evaluateOnNewDocument(() => { const Native = window.WebSocket; window.observedFrames = []; window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => { if (typeof event.data !== 'string') return; window.observedFrames.push(event.data); if (window.observedFrames.length > 600) window.observedFrames.shift() }) } } }); await page.goto(origin, { waitUntil: 'networkidle0' }); await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', apiToken); await page.click('button[type="submit"]'); await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession); await waitForWebUiReady(page)
  const original = configuration(first, oldToken); await saveModelsInOriginalApp(page, original, modelPath)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), current); await page.waitForFunction(id => document.querySelector('[data-session-header-subtitle]')?.textContent.includes('session ' + id), {}, current); await page.waitForSelector('.foxwarm-model-selector-trigger'); await page.click('.foxwarm-model-selector-trigger'); await page.waitForSelector('button[title="Refresh models"]'); await page.click('button[title="Refresh models"]'); await page.waitForSelector('[data-model-column="current"] [data-model-option-key="a"]'); await page.click('[data-model-column="current"] [data-model-option-key="a"]')
  await until(async () => (await history()).session.modelKey === 'a', 'original model selected')
  await page.evaluate(() => window.foxwarmTest.sendMessage('tool-flow'))
  await until(() => flowHold, 'real fragmented tool stream'); await until(async () => (await page.evaluate(() => document.body.innerText)).includes('Compatibility reasoning') && (await page.evaluate(() => window.observedFrames.join('\n'))).includes('Preferred reasoning'), 'original live reasoning and complete real stream payload')
  assert.equal(await readFile(effectPath, 'utf8').catch(() => null), null); assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, 0)
  const captured = flowHold.record; assert.equal(captured.headers['x-captured'], oldToken); assert.match(captured.body.cache, /^[0-9a-f-]{36}$/); assert.match(captured.body.turn, /^[0-9a-f-]{36}$/)
  await save(configuration(second, newToken, 'br')); await flowHold.finish(); await until(async () => (await history()).messages.some(row => row.parts?.some(part => part.text === 'FLOW-DONE')), 'whole tool loop completed'); await until(async () => !(await state()).busy, 'tool flow idle')
  assert.equal(errors.length, 0, errors.join('\n'))
  const flowHistory = (await history()).messages; const assistant = flowHistory.find(row => row.parts?.some(part => part.functionCall?.id === 'call_write'))
  assert.equal(assistant.__meta.modelId, 'a/same-wire'); assert.deepEqual(assistant.__meta.usage, { inputTokens: 28, outputTokens: 4, cachedTokens: 12, reasoningTokens: 2 }); assert.equal(assistant.parts[0].thinking, 'Preferred reasoning '); assert.deepEqual(assistant.providerMeta, { providerSpecificFields: opaque, sourceModelId: 'a/same-wire' })
  const pair = flowHistory.find(row => row.role === 'tool'); assert.equal(pair.parts.length, 3); assert(pair.parts[2].functionResponse.response.error); assert.equal(pair.parts[0].functionResponse.previousLlmRequest.durationMs, assistant.__meta.llmRequestTiming.durationMs)
  const db = join(data, 'state/archive-store.sqlite'), sql = (statement, parameters) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', db, statement, JSON.stringify(parameters)], { encoding: 'utf8' }))
  assert.equal(sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', [current])[0][0], flowHistory.length)
  if (!(await page.$('[data-model-selector-popup="true"]'))) await page.click('.foxwarm-model-selector-trigger'); await page.waitForSelector('[data-model-column="current"] [data-model-option-key="b"]'); await page.click('[data-model-column="current"] [data-model-option-key="b"]'); await until(async () => (await history()).session.modelKey === 'b', 'same wire other concrete selected')
  const originalArchive = sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq])
  await send('cross-concrete', 'CROSS-DONE')
  assert.deepEqual((await history()).messages.find(row => row.__meta?.seq === assistant.__meta.seq), assistant); assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq]), originalArchive)
  await api('POST', route(current) + '/model', { model: 'c' }); await send('cross-responses-destination', 'RESPONSES-CROSS-DONE')
  assert.deepEqual((await history()).messages.find(row => row.__meta?.seq === assistant.__meta.seq), assistant); assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq]), originalArchive)
  await api('POST', route(current) + '/model', { model: 'a' }); await send('same-concrete-replay', 'REPLAY-DONE')
  const plain = await send('no-terminal', 'EOF-DONE'); assert.equal(plain.length, 1); assert.notEqual(plain[0].body.turn, captured.body.turn); assert.equal(plain[0].body.cache, captured.body.cache)
  for (const name of ['malformed-sse', 'provider-error', 'http-error', 'empty-eof', 'missing-id']) {
    const before = await history(), models = before.messages.filter(row => row.role === 'model' && row.modelVisible !== false).length
    await send(name); assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, models); const failures = notices(await history()).filter(row => row.__meta.seq > before.latestSeq); assert(failures.some(terminalFailure)); assert(!JSON.stringify(failures).includes(newToken))
  }
  assert.equal(await readFile(join(work, 'must-not-exist'), 'utf8').catch(() => null), null)
  await send('usage-only'); assert.equal((await history()).messages.at(-1).role, 'model'); assert.equal((await history()).messages.at(-1).parts[0].text, '')
  await send('whitespace'); assert.equal((await history()).messages.at(-1).parts[0].text, ' \t')
  const strict = yamlReader.load(configuration(second, newToken, 'br')); strict.providers.a.disallowEmptyResponse = true; await save(JSON.stringify(strict)); const strictBefore = (await history()).latestSeq; await send('whitespace-disallowed'); assert(notices(await history()).some(row => row.__meta.seq > strictBefore && terminalFailure(row)))
  const inactivity = yamlReader.load(configuration(second, newToken, 'br')); inactivity.providers.a.streamContentInactivityTimeoutMs = 200; await save(JSON.stringify(inactivity)); const began = Date.now(); await send('inactivity'); assert(Date.now() - began < 4000); await until(() => closed.has('inactivity'), 'inactivity closes peer')
  await save(configuration(second, newToken, 'br')); const stopModels = (await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length; await api('POST', route(current) + '/message', { text: 'stop-stream' }); await until(() => stopHold, 'held Stop stream'); assert.equal((await api('POST', route(current) + '/stop')).status, 200); await until(async () => !(await state()).busy && closed.has('stop'), 'Stop released stream'); assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, stopModels)
  // Source-visible historical wrapper fixture, never a substitute for provider dispatch/effects.
  const beforeRestart = JSON.parse(await readFile(join(data, 'state/sessions', current + '.json'), 'utf8')); const historical = beforeRestart.history.find(row => row.role === 'user'); historical.parts.push({ system: 'Session goal reminder:\nHistorical persisted goal.' }); await stopHost(); await writeFile(join(data, 'state/sessions', current + '.json'), JSON.stringify(beforeRestart)); await start()
  const restarted = await send('after-restart', 'RESTART-DONE'); assert.equal(restarted.length, 1); assert(inputOf(restarted[0].body).includes('<foxwarm-system kind="goal-reminder">\nHistorical persisted goal.\n</foxwarm-system>')); assert.equal(await readFile(effectPath, 'utf8'), 'héllo')
  const compactId = (await api('POST', '/api/sessions', {})).body.sessionId; current = compactId
  for (let index = 0; index < 15; index++) await send('seed-compact-' + index + ' ' + ('unique-context-' + index + '-').repeat(100), 'PLAIN-DONE')
  const compactSource = (await history()).messages.find(row => row.parts?.some(part => part.thinking === 'COMPACT A THOUGHT')); assert(compactSource)
  const compactArchive = sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, compactSource.__meta.seq]); await api('POST', route(current) + '/model', { model: 'b' })
  await send('seed-compact-trigger', 'COMPACT-TRIGGER'); await until(async () => (await history()).messages.some(row => row.__meta?.contextBlock), 'real Completions automatic compaction')
  assert.equal(plannerRound, 2); assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, compactSource.__meta.seq]), compactArchive); const block = (await history()).messages.find(row => row.__meta?.contextBlock).__meta.contextBlock; assert(sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', [current])[0][0] > (await history()).messages.length)
  const expanded = await api('GET', route(current) + '/context-blocks/' + block.id + '/expand?previewLength=6000'); assert.equal(expanded.status, 200); assert(expanded.body.messages.length > 0)
  // Held headers beyond 100 seconds and later nonmeaningful frames share one source three-minute deadline.
  const firstContentStart = Date.now(); await send('first-content', null, 195000); const elapsed = Date.now() - firstContentStart; assert(elapsed >= 178000 && elapsed < 193000, elapsed); await until(() => closed.has('first-content'), 'three-minute first-content peer closed')
  await stopHost(); assert.equal(errors.length, 0, errors.join('\n')); console.log(JSON.stringify({ result: 'ok', hostPids, providerRequests: requests.length, plannerRounds: plannerRound, firstContentElapsedMs: elapsed, originalSetupChat: true, pairedEffects: true, opaqueModelFiltering: true, stopAndRestart: true }))
} catch (error) { console.error('OWNED_ROOT', root); if (host) console.error('HOST_OUTPUT', host.output); console.error('PEER_ERRORS', errors); if (page) console.error('BROWSER_TEXT', await page.evaluate(() => document.body.innerText).catch(() => 'closed')); throw error }
finally {
  if (browser) await browser.close().catch(() => {})
  if (host && host.child.exitCode === null) { host.child.kill('SIGKILL'); await once(host.child, 'exit').catch(() => {}) }
  for (const interval of intervals) clearInterval(interval)
  for (const server of [first, second]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await rm(root, { recursive: true, force: true }); else console.log('Retained owned root: ' + root)
}
