// WebUI-only message projection and throttled model arguments through the built original App.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'

let browserPage
const options = { onPage: page => {
  browserPage = page
  page.on('pageerror', error => console.error('Original App error:', error))
  // The normal installation starts with an empty pane; focus this fixture's real Session after login.
  void page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    .then(() => page.evaluate(() => window.foxwarmTest.switchToSession('payload')))
    .catch(error => console.error('Original App Session selection:', error))
  return page.evaluateOnNewDocument(() => {
  localStorage.setItem('foxwarm_timeline_view_v1', 'detailed')
  const Native = window.WebSocket
  window.payloadFrames = []; window.payloadSockets = []
  window.WebSocket = class extends Native {
    constructor(...args) { super(...args); window.payloadSockets.push(this); this.addEventListener('message', event => window.payloadFrames.push({ at: Date.now(), frame: JSON.parse(event.data) })) }
  }
}) } }
const fixture = await createHostFixture('payload-stream', options)
const encrypted = 'encrypted-😀e\u0301-' + 'opaque'.repeat(20000)
const redacted = 'redacted-😀e\u0301', signature = 'signature-😀e\u0301'
const raw = '{' + ' '.repeat(16000) + '"filePath":"note.txt"}'
const malformed = '{"filePath":"never.txt","content":"must not execute"'
const errors = [], requests = []
let held, anthropicRequests = 0
const send = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const reasoning = { type: 'reasoning', id: 'reason', summary: [], encrypted_content: encrypted }
const call = { type: 'function_call', id: 'function-item', call_id: 'valid-call', name: 'read', arguments: raw }
const text = value => ({ type: 'message', id: 'text-item', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
const complete = (response, output) => {
  send(response, { type: 'response.completed', response: { id: 'response-' + requests.length, status: 'completed', output, usage: { input_tokens: 11, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } } } })
  response.end()
}
const peer = createServer(async (request, response) => {
  try {
    let bytes = ''; for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes); requests.push(body)
    if (request.url === '/v1/messages') {
      if (anthropicRequests++) {
        const replay = body.messages.filter(row => row.role === 'assistant').flatMap(row => row.content)
        assert(replay.some(block => block.type === 'thinking' && block.signature === signature))
        assert(replay.some(block => block.type === 'redacted_thinking' && block.data === redacted))
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature }, { type: 'redacted_thinking', data: redacted }, { type: 'text', text: 'REDACTED-DONE' }], usage: { input_tokens: 3, output_tokens: 2 } })); return
    }
    assert.equal(request.url, '/responses')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (body.input.some(item => item.type === 'function_call_output')) {
      assert.equal(body.input.find(item => item.type === 'reasoning').encrypted_content, encrypted)
      assert.equal(body.input.find(item => item.type === 'function_call' && item.call_id === 'valid-call').arguments, raw)
      complete(response, [text('PAYLOAD-DONE')]); return
    }
    send(response, { type: 'response.output_item.added', output_index: 0, item: reasoning })
    send(response, { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } })
    send(response, { type: 'response.output_item.added', output_index: 2, item: text('') })
    let offset = 0, visible = ''
    held = {
      get arguments() { return raw.slice(0, offset) },
      pump() {
        const chunk = raw.slice(offset, offset + 1000); offset += chunk.length
        send(response, { type: 'response.function_call_arguments.delta', output_index: 1, delta: chunk })
        const delta = 'Fast text ' + offset + '. '; visible += delta
        send(response, { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta })
      },
      finish() {
        const chunk = raw.slice(offset); offset = raw.length
        send(response, { type: 'response.function_call_arguments.delta', output_index: 1, delta: chunk })
        const invalid = { type: 'function_call', call_id: 'invalid-call', name: 'write', arguments: malformed }
        send(response, { type: 'response.output_item.added', output_index: 3, item: invalid })
        complete(response, [reasoning, call, text(visible), invalid])
      },
    }
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'responses', providers: {
  responses: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'] },
  anthropic: { providerType: 'anthropic', baseUrl: 'http://127.0.0.1:' + peer.address().port, extraFields: { stream: false }, models: ['wire'] },
} }))
await writeFile(join(fixture.work, 'note.txt'), 'owned read fixture')
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const saved = async id => JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
const create = async (id, model) => {
  const value = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id }); assert.equal(value.status, 200)
  id = value.body.sessionId
  assert.equal((await fixture.api('POST', route(id) + '/model', { model })).status, 200)
  assert.equal((await fixture.api('POST', route(id) + '/cwd', { cwd: fixture.work })).status, 200)
  return id
}
try {
  await fixture.start()
  const id = await create('payload', 'responses')
  options.publicRoot = fixture.origin + '/#session/' + encodeURIComponent(id)
  const page = await fixture.openApp()
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await page.evaluate(() => window.foxwarmTest.sendMessage('Qualify projected payload and argument presentation.'))
  await until(() => held, 'provider streaming request')
  for (let n = 0; n < 12; n++) { held.pump(); await sleep(90) }
  await page.waitForFunction(() => document.body.innerText.includes('Fast text 12000.'))
  const beforeReconnect = await page.evaluate(() => window.payloadFrames)
  const updates = beforeReconnect.filter(row => row.frame.event?.type === 'model-stream-update')
  const argumentUpdates = updates.filter(row => row.frame.event?.toolCallDeltas?.some(call => call.argumentsDelta))
  assert(argumentUpdates.length >= 1 && argumentUpdates.length <= 2, JSON.stringify(argumentUpdates))
  assert(updates.some(row => row.frame.event.toolCallDeltas?.some(call => call.name === 'read' && !call.argumentsDelta)), 'function identity is presented before raw arguments')
  assert(updates.filter(row => row.frame.event.textDelta).length > argumentUpdates.length, 'ordinary text stays faster than arguments')
  const snapshotsBefore = beforeReconnect.filter(row => row.frame.type === 'model-stream-snapshot').length
  await page.evaluate(() => window.payloadSockets.at(-1).close())
  await page.waitForFunction(count => window.payloadFrames.filter(row => row.frame.type === 'model-stream-snapshot').length > count && window.payloadFrames.findLast(row => row.frame.type === 'model-stream-snapshot')?.frame.draft?.toolCalls?.some(call => call.arguments.length === 12000), {}, snapshotsBefore)
  held.pump(); held.finish()
  await until(async () => { if (errors.length) throw new Error(errors.join('\n')); const value = await history(id); return !value.session.busy && value.messages.some(row => row.parts.some(part => part.text === 'PAYLOAD-DONE')) }, 'canonical tools and completed continuation')
  await page.waitForFunction(() => document.body.innerText.includes('PAYLOAD-DONE') && document.body.innerText.includes('note.txt'))
  assert(await page.$$eval('.foxwarm-tool-call-summary', (elements, raw) => elements.some(element => element.textContent.includes(raw)), malformed), 'the original tool card shows malformed raw arguments')
  const value = await history(id), canonical = await saved(id)
  const callOf = messages => messages.flatMap(row => row.parts).find(part => part.functionCall?.id === 'valid-call').functionCall
  const badOf = messages => messages.flatMap(row => row.parts).find(part => part.functionCall?.id === 'invalid-call').functionCall
  assert.equal(callOf(value.messages).rawArgsText, undefined)
  assert.equal(callOf(canonical.history).rawArgsText, raw)
  assert.equal(badOf(value.messages).rawArgsText, malformed)
  const projected = value.messages.flatMap(row => row.parts).find(part => part.providerMeta?.encryptedThinkingLength !== undefined)
  assert.equal(projected.providerMeta.encryptedThinkingLength, encrypted.length)
  assert.equal(projected.providerMeta.encryptedThinking, undefined)
  assert(canonical.history.some(row => row.parts.some(part => part.providerMeta?.encryptedThinking === encrypted)))
  const frames = await page.evaluate(() => window.payloadFrames.map(row => row.frame))
  assert(!JSON.stringify(frames).includes(encrypted))
  const committed = frames.findIndex(frame => frame.type === 'message' && frame.message.parts.some(part => part.functionCall?.id === 'valid-call'))
  const requestId = frames[committed].message.__meta.llmRequestId
  const finalArgs = frames.findLastIndex(frame => frame.event?.llmRequestId === requestId && frame.event.toolCallDeltas?.some(call => call.argumentsDelta))
  assert(finalArgs >= 0 && finalArgs < committed)
  assert(!frames.slice(committed + 1).some(frame => frame.event?.llmRequestId === requestId && frame.event.type === 'model-stream-update'), JSON.stringify(frames.map(frame => ({ type: frame.type, event: frame.event?.type, request: frame.event?.llmRequestId || frame.message?.__meta?.llmRequestId, trim: frame.event?.trimBeforeOutputIndex, sequence: frame.event?.sequence, segment: frame.message?.__meta?.llmSegment }))))
  assert(!(await page.evaluate(() => document.body.innerText)).includes('Live stream joined after generation began'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('PAYLOAD-DONE') && document.body.innerText.includes('note.txt'))
  const other = await create('redacted', 'anthropic')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), other)
  await page.waitForFunction(id => document.querySelector('[data-session-header-subtitle]')?.textContent.includes('session ' + id), {}, other)
  assert.equal((await fixture.api('POST', route(other) + '/message', { text: 'Qualify redacted reasoning projection.' })).status, 202)
  await until(async () => { const value = await history(other); return !value.session.busy && value.messages.some(row => row.parts.some(part => part.text === 'REDACTED-DONE')) }, 'redacted canonical response')
  await page.waitForSelector('[data-reasoning-handoff]')
  const anthropic = await history(other), parts = anthropic.messages.flatMap(row => row.parts)
  assert.equal(parts.find(part => part.providerMeta?.redactedThinkingLength !== undefined).providerMeta.redactedThinkingLength, redacted.length)
  assert.equal(parts.find(part => part.providerMeta?.signatureLength !== undefined).providerMeta.signatureLength, signature.length)
  assert(!JSON.stringify(anthropic).includes(redacted) && !JSON.stringify(anthropic).includes(signature))
  assert.equal(await page.$$eval('[data-reasoning-tokens]', elements => elements.length), 0, 'lengths are never displayed as tokens')
  assert.equal((await fixture.api('POST', route(other) + '/message', { text: 'Replay opaque blocks.' })).status, 202)
  await until(() => anthropicRequests === 2, 'second request preserves raw redacted/signature replay')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ argumentUpdatesBeforeReconnect: argumentUpdates.length, textUpdatesBeforeReconnect: updates.filter(row => row.frame.event.textDelta).length, encryptedThinkingLength: encrypted.length, rawArgumentLength: raw.length, anthropicRequests }))
  await fixture.stop()
} catch (error) {
  console.error('Original App state:', await browserPage?.evaluate(() => document.body.innerText).catch(() => 'unavailable'))
  console.error('Owned host:', fixture.output)
  throw error
} finally { await fixture.cleanup(); peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)) }
