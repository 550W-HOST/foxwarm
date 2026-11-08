// System › Usage and the status bar Total over a real C# Main: priced and unpriced requests
// recorded in the usage ledger, grouping, Agent drill-down, live refresh and navigation.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('system-usage', options)
options.cwd = process.cwd()
const errors = []
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const peer = createServer(async (request, response) => {
  try {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
    event(response, { type: 'response.completed', response: { id: 'usage', status: 'completed', output, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500 } } })
    response.end()
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const baseUrl = `http://127.0.0.1:${peer.address().port}`
await writeFile(fixture.modelPath, JSON.stringify({
  default: 'paid/wire',
  providers: {
    // $2 / $4 per million input / output tokens: 1,000 in + 500 out = $0.004 per request.
    paid: { providerType: 'openai-responses', baseUrl, models: [{ id: 'wire', pricing: { cached: 1, input: 2, output: 4 } }], contextLimit: 100000, asyncCompact: false },
    free: { providerType: 'openai-responses', baseUrl, models: ['open'], contextLimit: 100000, asyncCompact: false },
  },
}))
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name), fullPage: true }) }
const route = id => '/api/sessions/' + encodeURIComponent(id)
const day = () => { const now = new Date(); return [new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()] }
const usage = async (query = '') => (await fixture.api('GET', `/api/usage?boundaries=${day().join(',')}${query}`)).body
const send = async (id, text) => {
  const before = (await usage()).total.requests
  assert.equal((await fixture.api('POST', route(id) + '/message', { text })).status, 202)
  await until(async () => (await usage()).total.requests > before, 'request recorded for ' + id)
}
const rows = page => page.$$eval('[data-usage-groups] [data-usage-row-kind]', items => items.map(item => `${item.getAttribute('data-usage-row-kind')}:${item.getAttribute('data-usage-row')}`))

try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'research' })).status, 201)
  const ids = {}
  for (const [agentId, sessionId, parentSessionId] of [['main', 'lead'], ['main', 'helper', 'lead'], ['research', 'scan']]) {
    const created = await fixture.api('POST', '/api/sessions', { agentId, sessionId, ...(parentSessionId ? { parentSessionId: ids[parentSessionId] } : {}) })
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body))
    ids[sessionId] = created.body.sessionId || created.body.id || sessionId
  }
  const scanModel = await fixture.api('POST', route(ids.scan) + '/model', { model: 'free/open' })
  assert.equal(scanModel.status, 200, JSON.stringify(scanModel.body))
  await send(ids.lead, 'one')
  await send(ids.helper, 'two')
  await send(ids.scan, 'three')

  const page = await fixture.openApp()
  await page.setViewport({ width: 1500, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => localStorage.setItem('foxwarm.systemUsage.period', 'today'))

  // The status bar Total is today's installation-wide ledger total.
  const total = '[data-workbench-status-bar] button[aria-label="Total token usage"]'
  await page.waitForFunction(selector => /4\.5K/.test(document.querySelector(selector)?.textContent || ''), {}, total)
  await page.click(total)
  await page.waitForSelector('[data-workbench-status-popup]')
  const popup = await page.$eval('[data-workbench-status-popup]', element => element.textContent)
  assert.match(popup, /\$0\.008 USD/)
  assert.match(popup, /Model requests3/)
  assert.match(popup, /1 without a price count tokens only/)
  await page.click('[data-workbench-status-popup] [data-status-open]')

  // System › Usage opens on the same period, grouped by Agent.
  await page.waitForSelector('[data-system-section="usage"] [data-system-usage][data-usage-period="today"]')
  await page.waitForSelector('[data-usage-total-cost]')
  assert.equal(await page.$eval('[data-usage-total-cost]', element => element.textContent), '$0.008 USD')
  assert.equal(await page.$eval('[data-usage-total-requests]', element => element.textContent), '3')
  assert.match(await page.$eval('[data-usage-summary="cost"]', element => element.textContent), /1 request has no price/)
  await until(async () => (await rows(page)).join() === 'agent:main,agent:research', 'Agent rows ordered by cost')
  assert.match(await page.$eval('[data-usage-row="research"]', element => element.textContent), /Tokens only/)
  await shot(page, 'system-usage-agents.png')

  // Drill into an Agent: its Session trees, with the child counted under its root.
  await page.click('[data-usage-row="main"] button')
  await page.waitForSelector('[data-usage-agent-filter="main"]')
  await until(async () => (await rows(page)).join() === 'tree:' + ids.lead, 'main Session trees')
  assert.match(await page.$eval(`[data-usage-row="${ids.lead}"]`, element => element.textContent), /lead.*2.*\$0\.008 USD/)
  await page.click('[aria-label="Show usage for all agents"]')

  await page.select('select[aria-label="Group usage by"]', 'purpose')
  await until(async () => (await rows(page)).join() === 'purpose:normal-turn', 'purpose rows')
  assert.match(await page.$eval('[data-usage-row="normal-turn"]', element => element.textContent), /Conversation turns/)
  await page.select('select[aria-label="Group usage by"]', 'model')
  await until(async () => (await rows(page)).join() === 'model:paid/wire,model:free/open', 'model rows')
  await page.select('select[aria-label="Group usage by"]', 'session')
  await until(async () => (await rows(page)).length === 3, 'session rows')

  // New requests refresh the open view without a reload.
  await send(ids.lead, 'four')
  await page.waitForFunction(() => document.querySelector('[data-usage-total-requests]')?.textContent === '4')
  await page.waitForFunction(() => document.querySelector('[data-usage-total-cost]')?.textContent === '$0.012 USD')

  // Opening a Session row opens its Chat.
  await page.click(`[data-usage-row="${ids.helper}"] button[aria-label^="Open"]`)
  await page.waitForFunction(() => location.hash.includes('helper'))

  // Other periods and the route.
  await page.evaluate(() => { location.hash = 'usage' })
  await page.waitForSelector('[data-system-section="usage"]')
  await page.click('[data-usage-period-option="week"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-usage-chart] [data-usage-bucket]').length === 7)
  await page.click('[data-usage-period-option="custom"]')
  await page.waitForSelector('input[aria-label="Usage from"]')
  await page.waitForFunction(() => !document.querySelector('[data-usage-stale]') && document.querySelector('[data-usage-total-requests]')?.textContent === '4')
  // The chosen period survives switching sections; the status bar's earlier request is not reapplied.
  await page.click('[data-system-tab="timers"]')
  await page.waitForSelector('[data-system-section="timers"]')
  await page.click('[data-system-tab="usage"]')
  await page.waitForSelector('[data-system-usage][data-usage-period="custom"]')
  await page.waitForSelector('[data-usage-total-requests]')
  await shot(page, 'system-usage-custom.png')

  assert.deepEqual(browserErrors, [])
  assert.deepEqual(errors, [])
  console.log('System usage e2e passed')
} finally {
  await fixture.cleanup()
  peer.close()
}
