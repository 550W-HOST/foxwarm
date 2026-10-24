#!/usr/bin/env node
// Anthropic streaming through the normal request owner, original App, tools, journal and durable history.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('anthropic-stream', { onPage: page => page.evaluateOnNewDocument(() => {
  const Native = window.WebSocket
  window.observedFrames = []
  window.WebSocket = class extends Native {
    constructor(...args) { super(...args); this.addEventListener('message', event => { if (typeof event.data === 'string') window.observedFrames.push(event.data) }) }
  }
}) })
const route = id => '/api/sessions/' + encodeURIComponent(id)
const records = [], errors = [], rounds = new Map(), holds = new Map(), closed = new Set(), intervals = new Set()
const exists = path => access(path).then(() => true, () => false)
const signature = 'synthetic-opaque-signature', redacted = 'synthetic-opaque-redacted'
const event = (response, data) => response.write('data: ' + JSON.stringify(data) + '\r\n\r\n')
const start = response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); event(response, { type: 'message_start', message: { id: 'local', role: 'assistant', usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 99, cache_read_input_tokens: 12 } } }) }
function block(response, index, content, rawInput) {
  event(response, { type: 'content_block_start', index, content_block: content.type === 'tool_use' ? { ...content, input: {} } : content })
  if (content.type === 'tool_use') event(response, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: rawInput ?? JSON.stringify(content.input) } })
  event(response, { type: 'content_block_stop', index })
}
function stop(response, reason = 'end_turn', end = true, blank = true) {
  event(response, { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } } })
  event(response, { type: 'message_delta', delta: {}, usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } } })
  response.write('data: ' + JSON.stringify({ type: 'message_stop' }) + (blank ? '\n\n' : ''))
  if (end) response.end()
}
function answer(response, value, end = true, blank = true) { start(response); block(response, 0, { type: 'text', text: value }); stop(response, 'end_turn', end, blank) }
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks), body = JSON.parse(request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes)
    assert.equal(request.url, '/v1/messages'); assert.equal(request.headers['x-api-key'], 'local-provider-token'); assert(!request.headers.authorization)
    assert.equal(body.max_tokens, 911); assert.equal(body.model, 'wire'); assert(!('prompt_cache_key' in body))
    assert(body.tools.every(tool => tool.input_schema && !('parameters' in tool)))
    const texts = body.messages.filter(row => row.role === 'user').flatMap(row => typeof row.content === 'string' ? [row.content] : row.content.filter(block => block.type === 'text').map(block => block.text))
    const key = texts.map(value => /^ANTH:([a-z-]+)$/m.exec(value)?.[1]).findLast(Boolean), round = (rounds.get(key) || 0) + 1
    assert(key, 'The current user marker is inside its canonical channel wrapper')
    rounds.set(key, round); records.push({ key, round, body }); response.on('close', () => closed.add(key + ':' + round))
    if (key === 'json') {
      assert.equal(body.stream, false); assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '1h' })
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'JSON-DONE' }], usage: { input_tokens: 1, output_tokens: 2 } })); return
    }
    assert.equal(body.stream, true); assert.deepEqual(body.cache_control, { type: 'ephemeral' })
    const replay = body.messages.filter(row => row.role === 'assistant').flatMap(row => Array.isArray(row.content) ? row.content : [])
    if (key === 'cross') { assert(!JSON.stringify(body.messages).includes(signature)); assert(!JSON.stringify(body.messages).includes(redacted)); assert(replay.some(block => block.type === 'tool_use')); answer(response, 'CROSS-DONE'); return }
    if (key === 'same' || key === 'restart') { assert(replay.some(block => block.type === 'thinking' && block.thinking === '' && block.signature === 'signed-empty')); assert(replay.some(block => block.type === 'redacted_thinking' && block.data === redacted)); answer(response, key.toUpperCase() + '-DONE'); return }
    if (key === 'flow' && round === 1) {
      start(response)
      block(response, 0, { type: 'thinking', thinking: '', signature: 'signed-empty' })
      block(response, 1, { type: 'redacted_thinking', data: redacted })
      event(response, { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } })
      event(response, { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'Visible streamed reasoning' } })
      event(response, { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature } })
      event(response, { type: 'content_block_stop', index: 2 })
      block(response, 3, { type: 'text', text: 'Live streamed answer' })
      block(response, 4, { type: 'tool_use', id: 'write-ok', name: 'write', input: { filePath: 'note.txt', content: 'héllo' } })
      block(response, 5, { type: 'tool_use', id: 'read-ok', name: 'read', input: { filePath: 'note.txt' } })
      block(response, 6, { type: 'tool_use', id: 'write-invalid', name: 'write' }, '{"filePath":"forbidden.txt","content":"must not execute"')
      block(response, 7, { type: 'tool_use', id: 'write-nonobject', name: 'write' }, '[{"filePath":"array-forbidden.txt","content":"never"}]')
      holds.set(key, () => stop(response, 'max_tokens', false)); return
    }
    if (key === 'flow') {
      assert(replay.some(block => block.signature === signature)); assert(replay.some(block => block.signature === 'signed-empty')); assert(replay.some(block => block.type === 'redacted_thinking' && block.data === redacted))
      const results = body.messages.flatMap(row => Array.isArray(row.content) ? row.content.filter(block => block.type === 'tool_result') : [])
      assert.deepEqual(results.slice(-4).map(result => result.tool_use_id), ['write-ok', 'read-ok', 'write-invalid', 'write-nonobject'])
      assert(results.at(-1).content.includes('invalid_tool_arguments')); assert(JSON.stringify(replay.find(block => block.id === 'write-invalid').input).includes('Invalid tool arguments JSON'))
      assert(!JSON.stringify(body.messages).includes('The response stopped at the output limit.'))
      assert.equal(await readFile(join(fixture.data, 'agents/team/note.txt'), 'utf8'), 'héllo'); assert(!await exists(join(fixture.data, 'agents/team/forbidden.txt'))); assert(!await exists(join(fixture.data, 'agents/team/array-forbidden.txt')))
      answer(response, 'FLOW-DONE'); return
    }
    if (key === 'image') {
      const images = body.messages.flatMap(row => Array.isArray(row.content) ? row.content.filter(block => block.type === 'image') : [])
      assert(images.length > 0); assert(images.every(block => block.source.media_type === 'image/webp')); answer(response, 'IMAGE-DONE'); return
    }
    if (key === 'refusal' || key === 'pause') { start(response); block(response, 0, { type: 'text', text: 'DO-NOT-COMMIT' }); stop(response, key === 'pause' ? 'pause_turn' : 'refusal'); return }
    if (key === 'server') { start(response); block(response, 0, { type: 'server_tool_use', id: 'server-call', name: 'write', input: {} }); stop(response); return }
    if (key === 'partial') {
      if (round > 1) { response.writeHead(400); response.end('local terminal after partial boundary'); return }
      start(response); block(response, 0, { type: 'text', text: 'DO-NOT-COMMIT' }); response.end(); return
    }
    if (key === 'watchdog') {
      if (round > 1) { response.writeHead(400); response.end('local terminal after watchdog'); return }
      start(response); block(response, 0, { type: 'text', text: 'DO-NOT-COMMIT' })
      const interval = setInterval(() => event(response, { type: 'ping' }), 25); intervals.add(interval)
      response.on('close', () => { clearInterval(interval); intervals.delete(interval) }); return
    }
    if (key === 'cancel') {
      start(response); block(response, 0, { type: 'text', text: 'Transient Stop output' }); block(response, 1, { type: 'tool_use', id: 'stop-write', name: 'write', input: { filePath: 'stopped.txt', content: 'never' } }); holds.set(key, () => {}); return
    }
    if (key === 'context') { start(response); block(response, 0, { type: 'text', text: 'CONTEXT-PARTIAL' }); stop(response, 'model_context_window_exceeded'); return }
    answer(response, key === 'eof-final' ? 'EOF-FINAL-DONE' : 'DONE', true, key !== 'eof-final')
  } catch (error) { errors.push(error.stack); response.destroy(error) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const leaf = extra => ({ providerType: 'anthropic', baseUrl: `http://127.0.0.1:${peer.address().port}`, apiKey: 'local-provider-token', requestCompression: 'gzip', maxOutput: 137, providerImageOutputFormat: 'webp', extraFields: { max_tokens: 911, ...extra }, streamContentInactivityTimeoutMs: 60000, models: ['wire'] })
await writeFile(fixture.modelPath, JSON.stringify({ default: 'a', providers: { a: leaf({}), b: leaf({}), json: leaf({ stream: false, cache_control: { type: 'ephemeral', ttl: '1h' } }), watchdog: { ...leaf({}), streamContentInactivityTimeoutMs: 200 } } }))
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
async function create(name, model = 'a') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: 'team', sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result.body)); const id = result.body.sessionId
  assert.equal((await fixture.api('POST', route(id) + '/model', { model })).status, 200); return id
}
async function send(id, key) {
  const before = records.length; assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'ANTH:' + key })).status, 202)
  await until(() => records.length > before, 'actual provider request ' + key)
  await until(async () => { if (errors.length) throw new Error(errors.join('\n')); return !(await history(id)).session.busy }, 'settled turn ' + key)
  return saved(id)
}
const journalSql = (sql, args = []) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', join(fixture.data, 'state/llm-request-journal.sqlite'), sql, JSON.stringify(args)], { encoding: 'utf8' }))
try {
  await fixture.start(); assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'team' })).status, 201)
  const actor = await create('stream'); const page = await fixture.openApp()
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForFunction(id => document.querySelector('[data-session-header-subtitle]')?.textContent.includes('session ' + id), {}, actor)
  await page.evaluate(() => window.foxwarmTest.sendMessage('ANTH:flow'))
  await until(() => holds.has('flow'), 'all blocks closed, terminal withheld')
  await until(async () => (await page.evaluate(() => document.body.innerText)).includes('Live streamed answer'), 'actual original App text progress')
  const frames = await page.evaluate(() => window.observedFrames.join('\n')); assert(frames.includes('reasoningDelta')); assert(frames.includes('toolCallDeltas')); assert(!frames.includes(signature)); assert(!frames.includes(redacted))
  assert(!(await saved(actor)).history.some(row => row.role === 'model' && row.modelVisible !== false)); assert(!await exists(join(fixture.data, 'agents/team/note.txt')))
  holds.get('flow')()
  await until(async () => (await saved(actor)).history.some(row => row.parts?.some(part => part.text === 'FLOW-DONE')) && !(await history(actor)).session.busy, 'message_stop settles held socket and normal tool continuation')
  await until(() => closed.has('flow:1'), 'owned socket closed without peer EOF')
  let state = await saved(actor); const assistant = state.history.find(row => row.parts?.some(part => part.functionCall?.id === 'write-ok'))
  assert.deepEqual(assistant.__meta.usage, { inputTokens: 139, outputTokens: 9, cachedTokens: 12, reasoningTokens: 4 })
  assert.deepEqual(assistant.parts.filter(part => part.functionCall).map(part => part.functionCall.id), ['write-ok', 'read-ok', 'write-invalid', 'write-nonobject'])
  assert(assistant.parts.at(-1).functionCall.argsParseError.includes('max_tokens')); assert(assistant.__meta.llmRequestId)
  const pair = state.history.find(row => row.role === 'tool'); assert(pair.parts.at(-1).functionResponse.response.error); assert(pair.parts[0].functionResponse.previousLlmRequest)
  assert(state.history.some(row => row.modelVisible === false && row.__meta.noticeType === 'llm-stop' && row.__meta.stopReason === 'max_tokens'))
  const archive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [actor, assistant.__meta.seq])
  const journalResult = JSON.parse(journalSql('SELECT result_json FROM llm_journal_attempt_results WHERE request_id=?', [assistant.__meta.llmRequestId])[0][0]); assert.deepEqual(journalResult.truncatedStop, { stopReason: 'max_tokens' }); assert.deepEqual(journalResult.allParts, assistant.parts)
  const order = journalSql('SELECT (SELECT created_at FROM llm_journal_requests WHERE request_id=s.request_id),started_at,semantic_payload_sha256 FROM llm_journal_attempt_starts s WHERE request_id=?', [assistant.__meta.llmRequestId])[0]; assert(order[0] <= order[1]); assert(order[2]); assert.equal(journalSql('SELECT message_count FROM llm_journal_requests WHERE request_id=?', [assistant.__meta.llmRequestId])[0][0], 1)
  await send(actor, 'same'); await fixture.api('POST', route(actor) + '/model', { model: 'b' }); await send(actor, 'cross')
  assert.deepEqual((await saved(actor)).history.find(row => row.__meta.seq === assistant.__meta.seq), assistant); assert.deepEqual(fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [actor, assistant.__meta.seq]), archive)
  await send(await create('json', 'json'), 'json'); await send(await create('eof'), 'eof-final')
  for (const key of ['refusal', 'pause', 'server', 'partial', 'watchdog']) {
    const id = await create(key, key === 'watchdog' ? 'watchdog' : 'a'), before = records.length; state = await send(id, key)
    assert(!state.history.some(row => row.role === 'model' && row.modelVisible !== false)); assert.equal(records.length - before, ['partial', 'watchdog'].includes(key) ? 2 : 1)
    assert(state.history.some(row => row.modelVisible === false && row.__meta.retry?.final)); assert(!JSON.stringify(state).includes('DO-NOT-COMMIT'))
  }
  const canceled = await create('cancel'); await fixture.api('POST', route(canceled) + '/message', { text: 'ANTH:cancel' }); await until(() => holds.has('cancel'), 'partial tool Stop')
  assert.equal((await fixture.api('POST', route(canceled) + '/stop')).status, 200); await until(async () => !(await history(canceled)).session.busy && closed.has('cancel:1'), 'Stop settles owned transport')
  assert(!(await saved(canceled)).history.some(row => row.role === 'model' && row.modelVisible !== false)); assert(!await exists(join(fixture.data, 'agents/team/stopped.txt')))
  state = await send(await create('context'), 'context'); assert(state.history.some(row => row.parts?.some(part => part.text === 'CONTEXT-PARTIAL'))); assert(state.history.some(row => row.modelVisible === false && row.__meta.stopReason === 'model_context_window_exceeded'))
  await sharp({ create: { width: 4097, height: 2, channels: 3, background: { r: 90, g: 80, b: 70 } } }).png().toFile(join(fixture.root, 'input.png'))
  const image = await create('image'), attachment = new FormData(); attachment.append('file', new Blob([await readFile(join(fixture.root, 'input.png'))], { type: 'image/png' }), 'input.png')
  const upload = await fetch(fixture.origin + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + fixture.token }, body: attachment }); const uploaded = await upload.json(); assert.equal(upload.status, 200, JSON.stringify(uploaded))
  // Use the normal staged-image admission route, not a result injected into Session history.
  const beforeImage = records.length; const imageSend = await fixture.api('POST', route(image) + '/message', { text: 'ANTH:image', uploadedFiles: [uploaded] }); assert.equal(imageSend.status, 202, JSON.stringify(imageSend.body)); await until(() => records.length > beforeImage, 'physical image request'); await until(async () => !(await history(image)).session.busy, 'image settled')
  await fixture.api('POST', route(actor) + '/model', { model: 'a' }); await fixture.stop(); await fixture.start(); await send(actor, 'restart')
  assert.equal(await readFile(join(fixture.data, 'agents/team/note.txt'), 'utf8'), 'héllo'); assert.equal(errors.length, 0, errors.join('\n'))
  await fixture.stop(); console.log(JSON.stringify({ result: 'ok', requests: records.length, originalAppStreaming: true, terminalWithoutSocketEOF: true, invalidToolNonexecution: true, signatureReplay: true, JSONOptOut: true, journalAndArchive: true, hostPids: fixture.hostPids }))
} catch (error) { console.error('OWNED_ROOT', fixture.root); console.error('HOST_OUTPUT', fixture.output); console.error('PEER_ERRORS', errors); throw error }
finally { for (const interval of intervals) clearInterval(interval); await fixture.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
