// Real C# owners, disposable providers/state, and the original shared React App.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { createHostFixture, until } from './mainHostFixture.mjs'

const fixture = await createHostFixture('search-sources')
const marker = '\uE200cite\uE202turn0search3\uE201', prefix = '😀 中文 claim '
const annotation = { type: 'url_citation', start_index: [...prefix].length, end_index: [...prefix].length + marker.length, url: 'https://example.com/exact', title: 'Exact sentence source' }
const message = (text, phase = 'final_answer', annotations = []) => ({ type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations }] })
const search = { type: 'web_search_call', id: 'search-reused-id', status: 'completed', action: { type: 'search', query: 'synthetic search', sources: [{ type: 'url', url: 'https://example.com/consulted', title: 'Consulted source only' }, { type: 'url', url: 'javascript:bad', title: 'Unsafe source' }] } }
const call = { type: 'function_call', call_id: 'read-evidence', name: 'read', arguments: JSON.stringify({ filePath: join(fixture.work, 'known.txt') }) }
const records = [], errors = [], held = new Map(), sockets = new Set(), sessions = []
let sequence = 0, page
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
async function respond(body, transport, send) {
  const record = { body, transport }; records.push(record)
  if (body.messages) {
    assert(JSON.stringify(body.messages).includes('hosted_web_search_sources'))
    assert(JSON.stringify(body.messages).includes('https://example.com/consulted'))
    assert(!JSON.stringify(body.messages).includes('outputItem'))
    return { completions: true }
  }
  assert(body.include.includes('custom'))
  assert(body.include.includes('web_search_call.action.sources'))
  assert.equal(body.include.includes('reasoning.encrypted_content'), transport === 'ws')
  const outputText = JSON.stringify(body.input)
  const first = !outputText.includes('function_call_output')
  const complete = output => send({ type: 'response.completed', response: { id: 'r-' + (++sequence), status: 'completed', output, usage: { input_tokens: 12, output_tokens: 3 } } })
  if (first) {
    const early = message('EARLY-' + transport, 'commentary')
    await send({ type: 'response.output_item.done', output_index: 0, item: early })
    const sparse = structuredClone(search); delete sparse.action.sources
    await send({ type: 'response.output_item.done', output_index: 1, item: sparse })
    await send({ type: 'response.output_item.done', output_index: 2, item: message(prefix + marker, 'commentary') })
    await new Promise(resolve => held.set(transport, async () => {
      await send({ type: 'response.output_item.done', output_index: 3, item: call })
      await complete([early, search, message(prefix + marker, 'commentary', [annotation]), call]); resolve()
    }))
  } else {
    assert(!body.previous_response_id, 'hosted search completion forces full evidence replay')
    assert(outputText.includes('hosted_web_search_sources'))
    assert(outputText.includes('https://example.com/consulted'))
    const evidenceIndex = body.input.findIndex(item => item.content?.some(part => part.text?.startsWith('Historical hosted web-search source data')))
    assert(evidenceIndex >= 0 && evidenceIndex < body.input.findIndex(item => item.type === 'function_call'))
    assert(body.input.some(item => item.type === 'web_search_call' && item.action.sources.length === 2))
    await complete([message('Unmapped later claim ' + marker)])
  }
}
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.messages) {
      await respond(body, 'completions', () => {})
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Switched model kept URLs.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      await respond(body, 'http', async event => { response.write('data: ' + JSON.stringify(event) + '\n\n') })
      response.end()
    }
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const wsServer = new WebSocketServer({ server: peer })
wsServer.on('connection', ws => {
  sockets.add(ws); ws.on('close', () => sockets.delete(ws))
  ws.on('message', raw => { respond(JSON.parse(raw), 'ws', async event => ws.send(JSON.stringify(event))).catch(error => { errors.push(error.stack); ws.terminate() }) })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(join(fixture.work, 'known.txt'), 'Owned actual local tool result')
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const provider = (providerType, effort) => ({ providerType, baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false, webSearch: { enabled: true }, effort: { allowed: ['none', 'high'], default: effort }, extraFields: { include: ['custom', 'reasoning.encrypted_content'] } })
await writeFile(fixture.modelPath, JSON.stringify({ default: 'http', providers: { http: provider('openai-responses', 'none'), ws: provider('openai-ws', 'high'), switched: { providerType: 'openai-completions', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['other'] } } }))
async function select(id, model) { assert.equal((await fixture.api('POST', route(id) + '/model', { model })).status, 200) }
async function openSession(id) {
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await page.waitForSelector('[aria-label="Open session options"]')
  await page.$eval('[aria-label="Open session options"]', element => element.click())
  await page.waitForSelector('[data-session-ui-settings-menu]')
  await page.$eval('[data-session-ui-settings-menu]', root => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === 'Detailed')?.click())
  if (await page.$('[data-session-ui-settings-menu]')) await page.keyboard.press('Escape')
}
async function assertRendered() {
  await page.waitForSelector('[data-web-search-ref="resolved"]')
  const refs = await page.$$eval('[data-web-search-ref]', nodes => nodes.map(node => ({ kind: node.dataset.webSearchRef, href: node.getAttribute('href'), title: node.title })))
  assert.equal(refs.filter(ref => ref.kind === 'resolved').length, 1)
  assert.equal(refs.find(ref => ref.kind === 'resolved').href, annotation.url)
  assert(refs.some(ref => ref.kind !== 'resolved' && ref.title === 'turn0search3'))
  await page.$eval('[data-model-thread-card="web-search"]', element => element.click())
  await page.waitForSelector('[data-web-search-source]')
  assert.deepEqual(await page.$$eval('[data-web-search-source]', nodes => nodes.map(node => node.getAttribute('href'))), ['https://example.com/consulted'])
  assert.equal((await page.$$('[data-web-search-citation]')).length, 1)
  assert.equal(await page.$('a[href^="javascript:"]'), null)
}
try {
  await fixture.start(); page = await fixture.openApp()
  for (const transport of ['http', 'ws']) {
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main' }); assert.equal(created.status, 200)
    const id = created.body.sessionId; sessions.push(id)
    await select(id, transport); await openSession(id)
    assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'Return controlled search evidence.' })).status, 202)
    await until(() => held.has(transport), 'provider held after search')
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages')?.textContent.includes('中文 claim'))
    const during = await until(async () => {
      const snapshot = await history(id)
      return snapshot.messages.some(row => row.parts?.some(part => part.text === 'EARLY-' + transport)) && snapshot
    }, 'pre-search canonical prefix')
    assert(!JSON.stringify(during.messages).includes('web_search_call'), 'source suffix is not published before final enrichment')
    const release = held.get(transport); held.delete(transport); await release()
    await until(async () => { const snapshot = await history(id); return !snapshot.session.busy && snapshot.messages.some(row => row.parts?.some(part => part.text === 'Unmapped later claim ' + marker)) }, 'search and actual tool continuation')
    const saved = (await history(id)).messages
    const cited = saved.flatMap(row => row.parts || []).find(part => part.text === prefix + marker)
    assert.deepEqual(cited.providerMeta.openaiResponses.annotations, [annotation])
    assert(saved.some(row => row.parts?.some(part => part.functionResponse?.name === 'read' && JSON.stringify(part).includes('Owned actual local tool result'))))
    assert(!JSON.stringify(saved).includes('hosted_web_search_sources'), 'request projection never enters history')
    const authority = JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
    assert(JSON.stringify(authority).includes('https://example.com/consulted'))
    await assertRendered()
    await select(id, 'switched')
    assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'Carry URLs to another protocol.' })).status, 202)
    await until(async () => { const snapshot = await history(id); return !snapshot.session.busy && JSON.stringify(snapshot.messages).includes('Switched model kept URLs.') }, 'switched protocol result')
  }
  const before = await history(sessions[0]); await fixture.stop(); await fixture.start()
  assert.deepEqual((await history(sessions[0])).messages, before.messages)
  await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
  await openSession(sessions[0]); await assertRendered()
  assert.equal(errors.length, 0, errors.join('\n'))
  assert.equal(records.length, 6)
  await fixture.stop()
  console.log(JSON.stringify({ result: 'ok', requests: records.length, httpAndWsOwners: true, localToolContinuation: true, switchedProtocolEvidence: true, exactUnicodeAnnotationsInReact: true, unknownReferencesIsolated: true, persistedReload: true }))
} catch (error) { console.error(fixture.output); console.error(JSON.stringify({ errors, records: records.map(({ body, ...record }) => ({ ...record, input: body.input || body.messages, include: body.include })), messages: await Promise.all(sessions.map(async id => (await history(id)).messages)) }, null, 2)); throw error }
finally {
  for (const release of held.values()) await release().catch(() => {})
  await fixture.cleanup(); for (const socket of sockets) socket.terminate(); wsServer.close(); peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
