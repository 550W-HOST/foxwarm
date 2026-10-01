#!/usr/bin/env node
// Real original-App Anthropic-compatible Messages requests, paired effects, compaction and restart.
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
import yamlReader from 'js-yaml'
import { saveModelsInOriginalApp } from './experimentHostFixture.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, label, timeout = 22000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await sleep(25) } throw new Error('Timed out: ' + label) }
async function freePort() { const socket = tcpServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(done => socket.close(done)); return port }
const root = await mkdtemp(join(tmpdir(), 'foxwarm-anthropic-')), data = join(root, 'data'), work = join(root, 'work')
await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work)
await writeFile(join(data, 'state/config.yaml'), 'llm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n')
const apiToken = 'synthetic-messages-api', oldToken = 'synthetic-messages-old', newToken = 'synthetic-messages-new'
const dotnet = join(process.env.DOTNET_ROOT, 'dotnet'), hostPort = await freePort(), origin = `http://127.0.0.1:${hostPort}`
const modelPath = join(data, 'state/models.yaml'), effectPath = join(work, 'note.txt')
let host, browser, page, current, flowHold, stopHold, plannerRound = 0
const requests = [], hostPids = [], errors = [], closed = new Set(), intervals = new Set()
const opaque = { signature: 'synthetic-opaque-signature', vendor: { nested: [null, 17, 'kept'] } }
const textOf = content => typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('\n')
const inputOf = body => body.messages.map(message => textOf(message.content)).join('\n')
async function api(method, path, body) { const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + apiToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => ({})) } }
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function history() { return (await api('GET', route(current) + '/history')).body }
async function state() { return (await api('GET', route(current) + '/state')).body.session }
async function start() {
  const child = spawn(dotnet, [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_DATA_DIR: data, FOXWARM_EXPERIMENT_TOOL_ROOT: work, FOXWARM_EXPERIMENT_PORT: String(hostPort), FOXWARM_EXPERIMENT_API_TOKEN: apiToken, FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist') } }); let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000) }); host = { child, get output() { return output } }; hostPids.push(child.pid)
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await api('GET', '/health')).status === 200 } catch { return false } }, 'host ready')
}
async function save(raw) { assert.equal((await api('POST', '/api/setup/models', { yaml: raw })).status, 200); assert.equal(await readFile(modelPath, 'utf8'), raw) }
async function send(text, expected, timeout = 22000) {
  const count = requests.length, previous = (await state()).failureCount
  assert.equal((await api('POST', route(current) + '/message', { text })).status, 202)
  await until(async () => requests.length > count || (await state()).failureCount > previous, 'request entered')
  await until(async () => { const value = await history(); return !value.session.busy && (!expected || value.messages.some(row => row.parts?.some(part => part.text === expected))) }, expected || 'settled failure', timeout)
  assert.equal(errors.length, 0, errors.join('\n')); return requests.slice(count)
}
async function stopHost() { assert.equal((await api('POST', '/admin/shutdown')).status, 202); const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(12000).then(() => 'timeout')]); assert.equal(code, 0, host.output) }
const signature = 'synthetic-native-signature'
function finish(response, content, usage = { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 12, cache_creation_input_tokens: 99 }) { response.end(JSON.stringify({ content, usage })) }
const text = value => ({ type: 'text', text: value })
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
function peer(label) {
  return createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const wire = Buffer.concat(chunks), encoding = request.headers['content-encoding']; const raw = encoding === 'gzip' ? gunzipSync(wire) : encoding === 'br' ? brotliDecompressSync(wire) : wire
      const body = JSON.parse(raw)
      if (request.url === '/v1/responses') {
        const input = JSON.stringify(body.input); requests.push({ body, headers: request.headers, label, user: 'cross-openai' })
        assert(!input.includes(signature)); assert(!body.input.some(item => item.type === 'reasoning')); assert(input.includes('FLOW-DONE'))
        assert(body.input.some(item => item.call_id === 'call_write')); assert(body.input.some(item => item.call_id === 'call_read'))
        response.setHeader('content-type', 'text/event-stream'); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'cross', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OPENAI-CROSS-DONE' }] }], usage: { input_tokens: 12, output_tokens: 3 } } }) + '\n\n'); return
      }
      const input = JSON.stringify(body.messages)
      const userTexts = body.messages.filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text))
      const latest = userTexts.findLast(value => value.trim()) || '', planning = userTexts.findLast(value => value.includes('COMPACTION STARTED:'))
      const record = { body, headers: request.headers, label, user: latest }; requests.push(record)
      const repeatedFailure = ['empty-array-guard', 'http-error', 'held-headers-default'].find(name => latest.includes(name))
      if (repeatedFailure && requests.filter(item => item.user.includes(repeatedFailure)).length > 1) { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"synthetic terminal after observed first failure"}'); return }
      assert.equal(request.url, '/v1/messages'); assert.equal(body.model, 'same-wire'); assert.equal(body.max_tokens, 911); assert(!('stream' in body)); assert(!('prompt_cache_key' in body))
      assert.equal(request.headers['anthropic-version'], '2023-06-01'); assert.equal(request.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14'); assert.equal(request.headers['user-agent'], 'foxwarm/1.0'); assert(!request.headers.authorization)
      assert.equal(Number(request.headers['content-length']), wire.length); assert(body.tools.every(tool => tool.input_schema && !('parameters' in tool) && !('strict' in tool)))
      if (latest.includes('none-effort')) { assert.equal(body.thinking.type, 'disabled'); assert(!('effort' in body.output_config)); assert.equal(body.output_config.vendor, 'preserved'); response.setHeader('content-type', 'application/json'); finish(response, [text('NONE-DONE')]); return }
      assert.equal(body.output_config.effort, 'high'); assert.equal(body.output_config.vendor, 'preserved'); assert.equal(body.thinking.type, 'enabled'); assert(body.system.length > 0)
      response.setHeader('content-type', 'application/json')
      if (planning) {
        plannerRound++; assert.equal(body.tools.length, 23)
        if (plannerRound === 1) { finish(response, [tool('plan-invalid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 99999, sourceEnd: 100000, summary: 'Invalid range.' }] })]); return }
        assert(input.includes('COMPACT PLAN INVALID.'))
        const ranges = [...planning.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length)
        finish(response, [tool('plan-valid', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Messages source-bound summary preserving the accepted synthetic local workflow.' }] })]); return
      }
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : [])
      if (latest.includes('tool-flow') && !results.some(result => result.tool_use_id === 'call_write')) {
        assert.equal(request.headers['x-api-key'], oldToken); response.flushHeaders()
        flowHold = { record, response, finish: () => finish(response, [{ type: 'thinking', thinking: 'Signed A thinking', signature }, text('before\n<thinking>\nUnsigned tagged thought\n</thinking>\nafter'), tool('call_write', 'write', { filePath: 'note.txt', content: 'héllo' }), tool('call_read', 'read', { filePath: 'note.txt' }), tool('call_bad', 'write', { filePath: 17, content: 'must fail' })]) }; return
      }
      if (latest.includes('tool-flow')) {
        assert.equal(label, 'second'); assert.equal(request.headers['x-api-key'], newToken); assert.equal(body.cache, flowHold.record.body.cache); assert.equal(body.turn, flowHold.record.body.turn)
        const replay = body.messages.filter(message => message.role === 'assistant').flatMap(message => Array.isArray(message.content) ? message.content : []); assert(replay.some(block => block.type === 'thinking' && block.signature === signature)); assert(!replay.some(block => block.type === 'thinking' && block.thinking === 'Unsigned tagged thought'))
        assert.deepEqual(results.slice(-3).map(result => result.tool_use_id), ['call_write', 'call_read', 'call_bad']); assert(results.at(-3).content.includes('<foxwarm-system kind="time"')); assert(results.at(-2).content.includes('héllo')); assert(results.at(-1).content.includes('invalid_tool_arguments')); assert.equal(await readFile(effectPath, 'utf8'), 'héllo')
        const authority = JSON.parse(await readFile(join(data, 'state/sessions', current + '.json'), 'utf8')); assert.equal(authority.history.at(-1).role, 'tool'); assert.equal(authority.history.at(-1).parts.length, 3)
        finish(response, [text('FLOW-DONE')]); return
      }
      if (latest.includes('cross-concrete')) { assert(!input.includes(signature)); assert(!body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'thinking'))); assert(input.includes('FLOW-DONE') && results.some(result => result.tool_use_id === 'call_read')); finish(response, [text('CROSS-DONE')]); return }
      if (latest.includes('same-concrete')) { assert(input.includes(signature)); finish(response, [text('REPLAY-DONE')]); return }
      if (latest.includes('empty-block')) { finish(response, [text('')]); return }
      if (latest.includes('empty-array')) { finish(response, []); return }
      if (latest.includes('raw-non-json')) { response.end('not-json'); return }
      if (latest.includes('http-error')) { response.writeHead(429); response.end(newToken); return }
      if (latest.includes('stop-headers')) { stopHold = response; response.on('close', () => closed.add('stop')); return }
      if (latest.includes('held-headers-default')) { response.on('close', () => closed.add('deadline')); return }
      if (latest.includes('compact-trigger')) { finish(response, [text('COMPACT-TRIGGER')], { input_tokens: 30000, output_tokens: 2, cache_read_input_tokens: 12 }); return }
      finish(response, [text(latest.includes('after-restart') ? 'RESTART-DONE' : 'PLAIN-DONE')])
    } catch (error) { errors.push(error.stack); response.destroy(error) }
  })
}
const first = peer('first'), second = peer('second'); first.listen(0, '127.0.0.1'); second.listen(0, '127.0.0.1'); await Promise.all([once(first, 'listening'), once(second, 'listening')])
function configuration(server, token, compression = 'gzip') {
  const leaf = (server, token, providerType) => ({ providerType, baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: token, contextLimit: 20000, requestCompression: compression,
    extraHeaders: { 'Content-Encoding': 'overridden', 'Content-Length': '1', 'X-Captured': token }, extraFields: { max_tokens: 911, thinking: { type: 'enabled', budget_tokens: 600 }, output_config: { effort: 'max', vendor: 'preserved' }, cache: '${SESSION_CACHE_KEY}', turn: '${TURN_ID}' }, models: ['same-wire'] })
  const responses = { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${second.address().port}/v1`, apiKey: newToken, contextLimit: 20000, requestCompression: compression,
    extraFields: { max_output_tokens: 911, cache: '${SESSION_CACHE_KEY}', turn: '${TURN_ID}' }, models: ['same-wire'] }
  return yamlReader.dump({ default: 'a', providers: { a: leaf(server, token, 'anthropic'), b: leaf(second, newToken, 'custom-messages'), c: responses } }).replaceAll('\n', '\r\n')
}
try {
  await start(); current = (await api('POST', '/api/sessions', {})).body.sessionId
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(root, 'browser') }); page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'networkidle0' }); await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', apiToken); await page.click('button[type="submit"]'); await page.waitForSelector('.foxwarm-chat-root')
  const original = configuration(first, oldToken); await saveModelsInOriginalApp(page, original, modelPath)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), current)
  await page.waitForSelector('.foxwarm-model-selector-trigger'); await page.click('.foxwarm-model-selector-trigger'); await page.waitForSelector('[data-model-column="current"] [data-model-option-key="a"]'); await page.click('[data-model-column="current"] [data-model-option-key="a"]')
  await until(async () => (await history()).session.modelKey === 'a', 'original leaf selected'); await page.evaluate(() => window.foxwarmTest.sendMessage('tool-flow')); await until(() => flowHold, 'real nonstream body held')
  assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, 0); assert.equal(await readFile(effectPath, 'utf8').catch(() => null), null); assert(!(await page.evaluate(() => document.body.innerText)).includes('Signed A thinking'))
  const captured = flowHold.record; assert.match(captured.body.cache, /^[0-9a-f-]{36}$/); assert.match(captured.body.turn, /^[0-9a-f-]{36}$/)
  await save(configuration(second, newToken, 'br')); flowHold.finish(); await until(async () => (await history()).messages.some(row => row.parts?.some(part => part.text === 'FLOW-DONE')), 'actual paired loop'); await until(async () => !(await state()).busy, 'idle')
  assert.equal(errors.length, 0, errors.join('\n')); const rows = (await history()).messages, assistant = rows.find(row => row.parts?.some(part => part.functionCall?.id === 'call_write'))
  assert.deepEqual(assistant.__meta.usage, { inputTokens: 40, outputTokens: 4, cachedTokens: 12 }); assert(assistant.parts.some(part => part.thinking === 'Unsigned tagged thought')); assert.equal(assistant.parts[0].providerMeta.signature, signature)
  const pair = rows.find(row => row.role === 'tool'); assert.equal(pair.parts.length, 3); assert(pair.parts[0].functionResponse.previousLlmRequest); assert(pair.parts[2].functionResponse.response.error)
  const db = join(data, 'state/archive-store.sqlite'), sql = (statement, params) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', db, statement, JSON.stringify(params)], { encoding: 'utf8' }))
  const archived = sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq]); assert.equal(sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', [current])[0][0], rows.length)
  if (!(await page.$('[data-model-selector-popup="true"]'))) await page.click('.foxwarm-model-selector-trigger'); await page.click('[data-model-column="current"] [data-model-option-key="b"]'); await until(async () => (await history()).session.modelKey === 'b', 'custom concrete selected'); await send('cross-concrete', 'CROSS-DONE')
  assert.deepEqual((await history()).messages.find(row => row.__meta?.seq === assistant.__meta.seq), assistant); assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq]), archived)
  await api('POST', route(current) + '/model', { model: 'c' }); await send('cross-openai', 'OPENAI-CROSS-DONE'); assert.deepEqual((await history()).messages.find(row => row.__meta?.seq === assistant.__meta.seq), assistant); assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [current, assistant.__meta.seq]), archived)
  await api('POST', route(current) + '/model', { model: 'a' }); await send('same-concrete', 'REPLAY-DONE')
  await api('POST', route(current) + '/model', { model: 'a', effort: 'none' }); await send('none-effort', 'NONE-DONE'); await api('POST', route(current) + '/model', { model: 'a', effort: 'high' })
  for (const value of ['empty-array', 'raw-non-json']) { const count = (await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length; await send(value); assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, count) }
  await send('empty-block'); assert.equal((await history()).messages.at(-1).parts[0].text, '')
  const strict = yamlReader.load(configuration(second, newToken, 'br')); strict.providers.a.disallowEmptyResponse = true; await save(JSON.stringify(strict)); let failures = (await state()).failureCount; await send('empty-array-guard'); assert.equal((await state()).failureCount, failures + 1); await save(configuration(second, newToken, 'br'))
  failures = (await state()).failureCount; await send('http-error'); assert.equal((await state()).failureCount, failures + 1); assert(!(await state()).lastError.includes(newToken))
  const stopRows = (await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length; await api('POST', route(current) + '/message', { text: 'stop-headers' }); await until(() => stopHold, 'held Stop request'); assert.equal((await api('POST', route(current) + '/stop')).status, 200); await until(async () => !(await state()).busy && closed.has('stop'), 'Stop closed own headers wait'); assert.equal((await history()).messages.filter(row => row.role === 'model' && row.modelVisible !== false).length, stopRows)
  await stopHost(); await start(); await send('after-restart', 'RESTART-DONE'); assert.equal(await readFile(effectPath, 'utf8'), 'héllo')
  current = (await api('POST', '/api/sessions', {})).body.sessionId
  for (let index = 0; index < 15; index++) await send('compact-seed-' + index + ' ' + ('retained-context-' + index + '-').repeat(100), 'PLAIN-DONE')
  await send('compact-trigger', 'COMPACT-TRIGGER'); await until(async () => (await history()).messages.some(row => row.__meta?.contextBlock), 'same-protocol automatic compact'); assert.equal(plannerRound, 2)
  const block = (await history()).messages.find(row => row.__meta?.contextBlock).__meta.contextBlock; assert(sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', [current])[0][0] > (await history()).messages.length)
  assert.equal((await api('GET', route(current) + '/context-blocks/' + block.id + '/expand?previewLength=6000')).status, 200)
  const began = Date.now(); await send('held-headers-default', null, 315000); const elapsed = Date.now() - began; assert(elapsed >= 298000 && elapsed < 313000, elapsed); await until(() => closed.has('deadline'), 'five-minute default peer closed')
  await stopHost(); assert.equal(errors.length, 0, errors.join('\n')); console.log(JSON.stringify({ result: 'ok', hostPids, requests: requests.length, plannerRounds: plannerRound, headerTimeoutElapsedMs: elapsed, originalNonstreamSetupChat: true, sourceSignatureTagsUsage: true, pairedEffectsAndRestart: true, customConcreteFallback: true }))
} catch (error) { console.error('OWNED_ROOT', root); if (host) console.error('HOST_OUTPUT', host.output); console.error('PEER_ERRORS', errors); if (page) console.error('BROWSER_TEXT', await page.evaluate(() => document.body.innerText).catch(() => 'closed')); throw error }
finally {
  if (browser) await browser.close().catch(() => {})
  if (host && host.child.exitCode === null) { host.child.kill('SIGKILL'); await once(host.child, 'exit').catch(() => {}) }
  for (const server of [first, second]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await rm(root, { recursive: true, force: true }); else console.log('Retained owned root: ' + root)
}
