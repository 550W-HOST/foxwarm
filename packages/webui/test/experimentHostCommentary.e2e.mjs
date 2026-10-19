// Original App with an owned normal Main and actual request/tool metadata.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } }
const host = await createHostFixture('commentary', options)
options.cwd = host.root
const requests = [], errors = []
let release
const resumed = new Promise(done => { release = done })
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (name, args) => ({ type: 'function_call', call_id: name + '-call', name, arguments: JSON.stringify(args) })
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const index = requests.length - 1
    let output
    if (index === 0) output = [message('UNMARKED_EARLIER'), message('UNMARKED_LATEST'), call('read', { filePath: join(host.work, 'known.txt') }), call('wait', { waitForInput: true })]
    else {
      event(response, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } })
      event(response, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'TOOL_FREE_LIVE' })
      await resumed
      output = [message('TOOL_FREE_LIVE final answer')]
    }
    event(response, { type: 'response.completed', response: { id: 'commentary-' + index, status: 'completed', output } })
    response.end()
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify({ bot: { httpPort: host.port }, channels: { webui: {} } }))
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await writeFile(join(host.work, 'known.txt'), 'actual read effect')
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
const menu = '[data-session-ui-settings-menu]'
let page
const choose = async label => {
  if (!await page.$(menu)) await page.$eval('[aria-label="Open session options"]', button => button.click())
  await page.waitForSelector(menu)
  await page.$eval(menu, (root, label) => {
    const button = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === label)
    if (!button) throw new Error('Missing menu choice ' + label)
    button.click()
  }, label)
  if (await page.$(menu)) await page.keyboard.press('Escape')
}
const search = async (term, hits) => {
  if (!await page.$('[data-chat-search]')) {
    if (await page.$('[aria-label="Find in chat"]')) await page.click('[aria-label="Find in chat"]')
    else await choose('Find in chat')
  }
  const input = '[data-chat-search] input[aria-label="Search messages"]'
  await page.click(input, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(input, term)
  await page.waitForFunction(hits => document.querySelector('[role="search"] [aria-live]')?.textContent === hits, {}, hits)
  await page.click('[aria-label="Close search"]')
}
try {
  await host.start()
  const created = await host.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'commentary' })
  assert.equal(created.status, 200)
  const id = created.body.sessionId, route = '/api/sessions/' + encodeURIComponent(id)
  page = await host.openApp()
  const loaded = page.waitForResponse(response => response.url().includes(route + '/history'))
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await loaded
  await page.waitForSelector('[aria-label="Open session options"]')
  await choose('Conversation')
  await page.evaluate(() => window.foxwarmTest.sendMessage('inspect then wait'))
  await until(async () => (await host.api('GET', route + '/history')).body.session.runtimeState?.state === 'waiting', 'actual wait batch')
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages')?.textContent.includes('UNMARKED_EARLIER'))
  await search('UNMARKED_EARLIER', '1/1')
  const history = (await host.api('GET', route + '/history')).body.messages
  const model = history.find(row => row.parts.some(part => part.functionCall))
  assert(model.__meta.llmRequestId)
  assert(model.parts.some(part => part.text === 'UNMARKED_EARLIER' && !part.phase))
  assert(history.some(row => row.parts.some(part => part.functionResponse?.name === 'read' && JSON.stringify(part).includes('actual read effect'))))
  await choose('Show commentary')
  await page.waitForFunction(() => document.querySelector('[data-conversation-preview]')?.textContent.includes('UNMARKED_LATEST'))
  assert.equal(await page.$eval('.foxwarm-chat-messages', root => root.textContent.includes('UNMARKED_EARLIER')), false)
  await search('UNMARKED_EARLIER', '0/0'); await search('UNMARKED_LATEST', '1/1')
  await page.$$eval('[aria-label="Expand activity"]', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelector('[data-activity-details]')?.textContent.includes('UNMARKED_EARLIER'))
  await choose('Show commentary')
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-conversation-reply')].some(node => node.textContent.includes('UNMARKED_EARLIER')))
  await search('UNMARKED_EARLIER', '1/1')
  await choose('Show commentary')
  await page.$$eval('[aria-label="Collapse activity"]', buttons => buttons.forEach(button => button.click()))
  await page.evaluate(() => window.foxwarmTest.sendMessage('resume without tools'))
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-conversation-reply')].some(node => node.textContent.includes('TOOL_FREE_LIVE')))
  assert.equal(requests.length, 2)
  assert(requests[1].input.some(row => row.type === 'function_call_output'))
  release()
  await until(async () => !(await host.api('GET', route + '/history')).body.session.busy, 'actual final completion')
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages')?.textContent.includes('TOOL_FREE_LIVE final answer'))
  const finalHistory = (await host.api('GET', route + '/history')).body.messages
  const final = finalHistory.find(row => row.parts.some(part => part.text === 'TOOL_FREE_LIVE final answer'))
  assert(final.__meta.llmRequestId && final.__meta.llmRequestId !== model.__meta.llmRequestId)
  assert(final.parts.every(part => !part.functionCall && !part.phase))
  // The resumed user starts another turn; the earlier reply-free turn keeps its last-readable preview.
  await search('UNMARKED_EARLIER', '0/0'); await search('UNMARKED_LATEST', '1/1'); await search('TOOL_FREE_LIVE final answer', '1/1')
  assert.equal(errors.length, 0, errors.join('\n'))
  await host.stop()
  console.log(JSON.stringify({ qualified: 'normal Main request/tool metadata, default-on and off/on inference, actual waiting preview/Search/disclosure, unmarked tool-free live and final visibility', requests: requests.length }))
} catch (error) { console.error(host.output); throw error }
finally { release(); await host.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
