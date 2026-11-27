// Original App with an owned normal Main: a Responses stream commits its completed reasoning and
// commentary prefix while later reasoning is still streaming, for live and late subscribers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const options = { env: {} }
const host = await createHostFixture('ordered-draft', options)
options.cwd = host.root
const requests = [], errors = []
let release
const resumed = new Promise(done => { release = done })
const reasoning = text => ({ type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text }] })
const message = (text, phase) => ({ type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text }] })
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const think = (index, text) => {
      event(response, { type: 'response.output_item.added', output_index: index, item: { type: 'reasoning', summary: [] } })
      event(response, { type: 'response.reasoning_summary_text.delta', output_index: index, summary_index: 0, delta: text })
    }
    const say = (index, text, phase) => {
      event(response, { type: 'response.output_item.added', output_index: index, item: { type: 'message', role: 'assistant', phase, content: [] } })
      event(response, { type: 'response.output_text.delta', output_index: index, content_index: 0, delta: text })
      event(response, { type: 'response.output_item.done', output_index: index, item: message(text, phase) })
    }
    think(0, 'Before drawing')
    event(response, { type: 'response.output_item.done', output_index: 0, item: reasoning('Before drawing') })
    say(1, 'Drawing', 'commentary')
    think(2, 'After drawing')
    await resumed
    event(response, { type: 'response.output_item.done', output_index: 2, item: reasoning('After drawing') })
    say(3, 'Done', 'final_answer')
    event(response, { type: 'response.completed', response: { id: 'ordered-draft', status: 'completed',
      output: [reasoning('Before drawing'), message('Drawing', 'commentary'), reasoning('After drawing'), message('Done', 'final_answer')],
      usage: { input_tokens: 1, output_tokens: 2 } } })
    response.end()
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify({ bot: { httpPort: host.port }, channels: { webui: {} } }))
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
const menu = '[data-session-ui-settings-menu]'
async function detailed(page) {
  if (!await page.$(menu)) await page.$eval('[aria-label="Open session options"]', button => button.click())
  await page.waitForSelector(menu)
  await page.$eval(menu, root => {
    const button = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === 'Detailed')
    if (!button) throw new Error('Missing Detailed view')
    button.click()
  })
  if (await page.$(menu)) await page.keyboard.press('Escape')
}
async function open(page, id, route) {
  const loaded = page.waitForResponse(response => response.url().includes(route + '/history'))
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await loaded
  await page.waitForSelector('[aria-label="Open session options"]')
  await detailed(page)
}
const timeline = page => page.evaluate(() => ({
  reasoning: [...document.querySelectorAll('[data-model-thread-card="reasoning"]')].map(node => node.textContent.slice(0, 80)),
  messages: [...document.querySelectorAll('.foxwarm-assistant-message-card')].map(node => node.textContent.slice(0, 80)),
}))
// Two reasoning cards (one per reasoning item), the commentary once, and the final answer `done` times.
async function settled(page, done) {
  try { await page.waitForFunction(done => {
    const cards = [...document.querySelectorAll('[data-model-thread-card="reasoning"]')]
    const messages = [...document.querySelectorAll('.foxwarm-assistant-message-card')]
    return cards.length === 2 && cards.some(node => node.textContent.includes('Before drawing')) && cards.some(node => node.textContent.includes('After drawing'))
      && messages.filter(node => node.textContent.includes('Drawing')).length === 1 && messages.filter(node => node.textContent.includes('Done')).length === done
  }, { timeout: 15000 }, done) } catch (error) { throw new Error('Timeline: ' + JSON.stringify(await timeline(page)), { cause: error }) }
}
try {
  await host.start()
  const created = await host.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'ordered-draft' })
  assert.equal(created.status, 200)
  const id = created.body.sessionId, route = '/api/sessions/' + encodeURIComponent(id)
  const page = await host.openApp()
  page.on('pageerror', error => errors.push(error.message))
  await open(page, id, route)
  await page.evaluate(() => window.foxwarmTest.sendMessage('draw it'))
  // The completed reasoning and commentary items are canonical before the response ends.
  const committed = async () => (await host.api('GET', route + '/history')).body.messages.find(row => row.__meta?.llmSegment?.complete === false)
  await until(async () => !!await committed(), 'committed prefix')
  const prefix = await committed()
  assert.deepEqual(prefix.parts.map(part => part.thinking || part.text), ['Before drawing', 'Drawing'])
  assert.deepEqual([prefix.__meta.llmSegment.outputStart, prefix.__meta.llmSegment.outputEndExclusive], [0, 2])
  // The live draft keeps only the uncommitted reasoning; the committed prefix is not repeated.
  await settled(page, 0)
  // A late subscriber receives the committed row and only the uncommitted suffix of the owner snapshot.
  const late = await page.browser().newPage()
  late.on('pageerror', error => errors.push(error.message))
  await late.goto(page.url(), { waitUntil: 'networkidle0' })
  await late.waitForFunction(() => window.foxwarmTest)
  await open(late, id, route)
  await settled(late, 0)
  release()
  await until(async () => !(await host.api('GET', route + '/history')).body.session.busy, 'final completion')
  for (const view of [page, late]) await settled(view, 1)
  const history = (await host.api('GET', route + '/history')).body.messages
  const final = history.find(row => row.__meta?.llmSegment?.complete === true)
  assert.deepEqual(final.parts.map(part => part.thinking || part.text), ['After drawing', 'Done'])
  assert.equal(final.__meta.llmSegment.outputStart, 2)
  assert.equal(requests.length, 1)
  assert.deepEqual(errors, [])
  await host.stop()
  console.log(JSON.stringify({ qualified: 'Responses prefix commit with live and late WebUI subscribers', requests: requests.length }))
} catch (error) { console.error(host.output); throw error }
finally { release(); await host.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
