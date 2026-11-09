// System › Activity over a real C# Main: tool calls of a real turn indexed from the Archive,
// the default Changes view, filters, details, live refresh and opening the Session at the call.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('system-activity', options)
options.cwd = process.cwd()
const errors = [], counts = new Map()
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const key = [...JSON.stringify(JSON.parse(raw).input).matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary'
    const n = counts.get(key) || 0; counts.set(key, n + 1)
    let output = [text('done')]
    if (key === 'work' && n === 0) output = [call('note', 'write', { filePath: 'note.txt', content: 'hello' }), call('look', 'read', { filePath: 'note.txt' })]
    if (key === 'work' && n === 1) output = [call('shell', 'exec', { command: 'echo activity-check' })]
    if (key === 'more' && n === 0) output = [call('again', 'write', { filePath: 'later.txt', content: 'x' })]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'activity-' + key + n, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'a/wire', providers: { a: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name), fullPage: false }) }
const route = id => '/api/sessions/' + encodeURIComponent(id)
const activity = async (filters = {}) => (await fixture.api('POST', '/api/activity', filters)).body
const rows = page => page.$$eval('[data-activity-list] [data-activity-row-kind]', items => items.map(item => item.getAttribute('data-activity-row-kind')))

try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'worker' })
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body))
  const id = created.body.sessionId || created.body.id || 'worker'
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:work' })).status, 202)
  await until(async () => (await activity({ kind: 'all' })).items?.length === 3, 'three calls indexed')

  const all = (await activity({ kind: 'all' })).items
  const exec = all.find(item => item.tool === 'exec')
  assert.equal(exec.node, 'master'); assert.equal(exec.kind, 'exec'); assert.equal(exec.outcome, 'ok')
  assert.equal(exec.summary, 'echo activity-check'); assert.equal(exec.agent, 'main')
  assert.ok(exec.seq > 0)
  assert.deepEqual((await activity()).items.map(item => item.tool).sort(), ['exec', 'write'])

  const page = await fixture.openApp()
  await page.setViewport({ width: 1500, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => { location.hash = 'activity' })
  await page.waitForSelector('[data-system-section="activity"] [data-system-activity][data-activity-kind="changes"]')
  await until(async () => (await rows(page)).join() === 'exec,files', 'Changes view hides the read')
  await shot(page, 'system-activity-changes.png')

  await page.select('select[aria-label="Kind of activity"]', 'all')
  await until(async () => (await rows(page)).length === 3, 'all calls')
  await page.select('select[aria-label="Kind of activity"]', 'changes')
  await until(async () => (await rows(page)).length === 2, 'back to changes')

  // Details of a call.
  const execRow = `[data-activity-row="${exec.key}"]`
  await page.click(`${execRow} button[aria-expanded]`)
  await page.waitForSelector('[data-activity-detail]')
  const detail = await page.$eval('[data-activity-detail]', element => element.textContent)
  assert.match(detail, /echo activity-check/)
  assert.match(detail, /Nodemaster/)
  await shot(page, 'system-activity-detail.png')

  // Clicking a tool narrows the list; the chip removes the filter.
  await page.$eval(execRow, row => [...row.querySelectorAll('button')].find(button => button.textContent.startsWith('exec')).click())
  await page.waitForSelector('[data-activity-filter="tool"]')
  await until(async () => (await rows(page)).join() === 'exec', 'tool filter')
  await page.click('[data-activity-filter="tool"] button')
  await until(async () => (await rows(page)).length === 2, 'tool filter removed')

  // New calls appear without a reload.
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:more' })).status, 202)
  await until(async () => (await rows(page)).length === 3, 'live refresh')

  // Opening a call opens its Session.
  await page.click(`${execRow} [data-activity-open]`)
  await page.waitForFunction(value => decodeURIComponent(location.hash).includes(value), {}, id)

  assert.deepEqual(browserErrors, [])
  assert.deepEqual(errors, [])
  console.log('System activity e2e passed')
} finally {
  await fixture.cleanup()
  peer.close()
}
