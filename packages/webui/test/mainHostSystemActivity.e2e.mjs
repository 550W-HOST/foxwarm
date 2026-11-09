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
    if (key === 'many' && n === 0) output = Array.from({ length: 110 }, (_, index) => call('many' + index, 'read', { filePath: 'note.txt' }))
    if (key === 'latest' && n === 0) output = [call('latest', 'write', { filePath: 'latest.txt', content: 'x' })]
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
  await page.setViewport({ width: 1440, height: 1000 })
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
  assert.match(detail, /Started byAdministrator/)
  assert.match(detail, /Global rules · Default action · Allow/)
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

  // Live refresh keeps pages loaded with "Show earlier activity".
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:many' })).status, 202)
  await until(async () => (await activity({ kind: 'all', limit: 200 })).items?.length === 114, 'many calls indexed')
  await page.select('select[aria-label="Kind of activity"]', 'all')
  await until(async () => (await rows(page)).length === 100, 'first page of all calls')
  await page.click('[data-activity-more]')
  await until(async () => (await rows(page)).length === 114, 'earlier page loaded')
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:latest' })).status, 202)
  await until(async () => (await rows(page)).length === 115, 'new call merged above loaded pages')
  assert.equal((await rows(page))[0], 'files')

  // Every width keeps the call readable; narrow lists stack each call.
  const layouts = {}
  for (const [width, height] of [[1440, 1000], [1024, 800], [768, 1000], [390, 844]]) {
    await page.setViewport({ width, height })
    await new Promise(resolve => setTimeout(resolve, 400))
    if (!await page.$('[data-system-activity]')) {
      // The phone layout shows one screen at a time; open the section again.
      await page.evaluate(() => { location.hash = 'activity' })
      await page.waitForSelector('[data-system-activity]', { timeout: 5000 }).catch(() => {})
      await page.select('select[aria-label="Kind of activity"]', 'all').catch(() => {})
      await until(async () => (await rows(page)).length > 0, 'rows after reopening')
    }
    if (!await page.$('[data-system-activity]')) {
      await shot(page, `missing-${width}.png`)
      throw new Error(`Activity not shown at ${width}: ${await page.evaluate(() => location.hash + ' ' + document.body.innerText.slice(0, 300))}`)
    }
    const measured = await page.evaluate(() => {
      const root = document.querySelector('[data-system-activity]')
      const list = document.querySelector('[data-activity-list]')
      const call = [...document.querySelectorAll('[data-activity-list] th')].find(cell => cell.textContent === 'Call')
      const first = document.querySelector('[data-activity-list] [data-activity-row] button[class*="font-medium"]')
      const rect = first?.getBoundingClientRect()
      return {
        layout: root.getAttribute('data-activity-layout'),
        listWidth: list.clientWidth,
        overflow: list.scrollWidth - list.clientWidth,
        callWidth: call ? call.getBoundingClientRect().width : null,
        toolWidth: rect ? rect.width : 0,
        toolRight: rect ? rect.right : 0,
        listRight: list.getBoundingClientRect().right,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    layouts[width] = measured
    assert.ok(measured.overflow <= 1, `list overflows at ${width}: ${JSON.stringify(measured)}`)
    assert.ok(measured.pageOverflow <= 1, `page overflows at ${width}: ${JSON.stringify(measured)}`)
    assert.ok(measured.toolWidth > 20 && measured.toolRight <= measured.listRight + 1, `call hidden at ${width}: ${JSON.stringify(measured)}`)
    if (measured.layout === 'table') assert.ok(measured.callWidth >= 200, `call column at ${width}: ${JSON.stringify(measured)}`)
    else assert.ok(measured.listWidth < 960, `stacked at ${width}: ${JSON.stringify(measured)}`)
    await page.evaluate(() => document.querySelector('[data-system-activity]').scrollIntoView({ block: 'start' }))
    await shot(page, `system-activity-${width}.png`)
  }
  assert.equal(layouts[1440].layout, 'table')
  assert.equal(layouts[390].layout, 'stacked')
  // Details stay inside a narrow list.
  const firstRow = '[data-activity-list] li[data-activity-row]'
  await page.click(`${firstRow} button[aria-expanded]`)
  await page.waitForSelector(`${firstRow} [data-activity-detail]`)
  const detailBox = await page.$eval(`${firstRow} [data-activity-detail]`, element => ({ right: element.getBoundingClientRect().right, list: document.querySelector('[data-activity-list]').getBoundingClientRect().right, overflow: element.scrollWidth - element.clientWidth }))
  assert.ok(detailBox.right <= detailBox.list + 1 && detailBox.overflow <= 1, JSON.stringify(detailBox))
  await page.$eval(firstRow, row => row.scrollIntoView({ block: 'start' }))
  await shot(page, 'system-activity-390-detail.png')
  console.log('Activity layouts ' + JSON.stringify(layouts))
  await page.setViewport({ width: 1440, height: 1000 })
  await new Promise(resolve => setTimeout(resolve, 300))
  await page.select('select[aria-label="Kind of activity"]', 'changes')
  await page.waitForSelector(`${execRow} [data-activity-open]`)

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
