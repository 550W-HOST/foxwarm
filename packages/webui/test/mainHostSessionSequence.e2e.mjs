// Session sequence view over real C# deliveries: exact pairing, child creation, live append and navigation.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('session-sequence', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const failures = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const input = JSON.parse(raw).input
    const all = JSON.stringify(input)
    const answered = id => input.some(item => item.type === 'function_call_output' && item.call_id === id)
    let output
    if (all.includes('SEQ-AGAIN') && !answered('again')) output = [call('again', 'send_to_session', { sessionId: 'worker', message: 'second note' })]
    else if (all.includes('SEQ-START') && !answered('p1') && !all.includes('SEQ-AGAIN')) output = [
      call('p1', 'send_to_session', { sessionId: 'worker', message: 'please check the build' }),
      call('p2', 'create_child_session', { suffix: 'helper', message: 'help with the docs' }),
    ]
    else output = [text('DONE')]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'seq-' + Date.now(), output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port + '/r', models: ['wire'], contextLimit: 20000 } } })

const history = async id => (await fixture.api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history?tail=50')).body
const idle = async id => { const value = await history(id); return value.session && !value.session.busy && !(value.session.queueLength > 0) ? value : null }
try {
  await fixture.start()
  for (const id of ['lead', 'worker']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  assert.equal((await fixture.api('POST', '/api/sessions/lead/message', { text: 'SEQ-START' })).status, 202)
  await until(async () => {
    const lead = await idle('lead'), worker = await idle('worker')
    return lead?.messages.some(message => JSON.stringify(message).includes('DONE')) && worker?.messages.some(message => JSON.stringify(message).includes('DONE'))
  }, 'Lead and worker turns finish')
  const workerHistory = await history('worker')
  const wrapper = JSON.stringify(workerHistory.messages)
  assert.match(wrapper, /deliverySeq=\\"\d+\.1\\"/)

  const projected = (await fixture.api('POST', '/api/session-sequence', { since: Date.now() - 600_000 })).body
  const toWorker = projected.links.find(link => link.to.sessionId === 'worker' && link.kind === 'message')
  assert.equal(toWorker.pairing, 'exact')
  assert.ok(projected.links.some(link => link.kind === 'spawn' && link.pairing === 'exact'))

  const page = await fixture.openApp()
  await page.setViewport({ width: 1500, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => { location.hash = 'architecture' })
  await page.waitForSelector('.foxwarm-architecture-surface-tab')
  await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Sequence').click())
  await page.waitForSelector('[data-sequence-canvas]')
  const lanes = await page.$$eval('[data-sequence-lane]', items => items.map(item => item.getAttribute('data-sequence-lane')))
  assert.ok(lanes.includes('lead') && lanes.includes('worker'), lanes.join(','))
  assert.ok(lanes.some(id => id.endsWith('helper')), lanes.join(','))
  assert.ok(lanes.indexOf('lead') < lanes.findIndex(id => id.endsWith('helper')))
  // WebUI input is drawn from the user's lane.
  assert.ok(lanes.includes('@user') && !lanes.includes('@channel'), lanes.join(','))
  const exact = await page.$$eval('[data-sequence-arrow][data-pairing="exact"]', items => items.map(item => item.getAttribute('data-kind')))
  assert.ok(exact.includes('message') && exact.includes('spawn'), exact.join(','))
  assert.ok(await page.$('[data-sequence-bar][data-kind="llm"]'))
  assert.ok(await page.$('[data-sequence-bar][data-kind="tool"]'))
  if (process.env.FOXWARM_SEQUENCE_SCREENSHOT) await page.screenshot({ path: process.env.FOXWARM_SEQUENCE_SCREENSHOT })

  // Live: a later delivery appears without reloading the view.
  const before = (await page.$$('[data-sequence-arrow][data-kind="message"]')).length
  assert.equal((await fixture.api('POST', '/api/sessions/lead/message', { text: 'SEQ-AGAIN' })).status, 202)
  await until(async () => (await page.$$('[data-sequence-arrow][data-kind="message"]')).length > before, 'Live delivery appears', 20000)

  // Selecting the delivery shows its details and opens the receiver at the received message.
  await page.evaluate(key => document.querySelector(`[data-sequence-arrow="${CSS.escape(key)}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), toWorker.key)
  await page.waitForSelector('[data-sequence-details]')
  const details = await page.$eval('[data-sequence-details]', element => element.textContent)
  assert.match(details, /please check the build/)
  await page.evaluate(() => [...document.querySelectorAll('[data-sequence-details] button')].find(button => button.textContent.includes('Open receiver')).click())
  await page.waitForSelector('.foxwarm-chat-root')
  await until(async () => page.evaluate(() => document.body.textContent.includes('please check the build')), 'Receiver conversation opens')
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(failures, [])
  console.log('session sequence e2e passed')
} finally {
  await fixture.cleanup()
  peer.close()
}
