// Text redaction observability over a real C# Main with a local fake detector and provider:
// the turn usage summary, System › Usage statistics and failures, and the memory-only sent
// version, including after a restart.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const PERSON = 'Alice Zhang'
const EMAIL = ['ming.zhang', 'example.test'].join('@')
const options = { env: {} }
const fixture = await createHostFixture('text-redaction', options)
options.cwd = process.cwd()
const errors = []
const read = async request => { let body = ''; for await (const chunk of request) body += chunk; return body }
const providerBodies = []
let detectorCalls = 0

// Flags the person and email; a text containing "again" reports only the email, so the person
// there is masked literally from the earlier find. "OVERSIZED" is rejected as too large.
const detector = createServer(async (request, response) => {
  try {
    const { text } = JSON.parse(await read(request))
    detectorCalls++
    if (text.includes('OVERSIZED')) { response.writeHead(413, { 'content-type': 'application/json' }); response.end('{"error":"too large"}'); return }
    const entities = []
    for (const [value, label] of [[PERSON, 'private_person'], [EMAIL, 'private_email']]) {
      if (label === 'private_person' && text.includes('again')) continue
      for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + value.length)) {
        const start = Buffer.byteLength(text.slice(0, index))
        entities.push({ start, end: start + Buffer.byteLength(value), score: 0.97, label })
      }
    }
    await new Promise(resolve => setTimeout(resolve, 15))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ entities, offset_unit: 'utf8_bytes', input_bytes: Buffer.byteLength(text), input_tokens: text.length }))
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const provider = createServer(async (request, response) => {
  try {
    providerBodies.push(await read(request))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done. I will follow up.' }] }]
    event(response, { type: 'response.completed', response: { id: 'r', status: 'completed', output, usage: { input_tokens: 800, input_tokens_details: { cached_tokens: 200 }, output_tokens: 40 } } })
    response.end()
  } catch (error) { errors.push(error.stack); response.destroy() }
})
for (const server of [detector, provider]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
const detectorUrl = `http://127.0.0.1:${detector.address().port}/classify`
await writeFile(fixture.modelPath, JSON.stringify({
  default: 'guarded/wire',
  providers: {
    guarded: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false, textRedaction: { enabled: true, endpoint: detectorUrl } },
  },
}))
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (target, name) => { if (shots) await target.screenshot({ path: join(shots, name) }) }
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body.messages
const replies = async id => (await history(id)).filter(message => message.role === 'model' && message.__meta?.usage)
const settle = async id => until(async () => !(await fixture.api('GET', route(id) + '/state')).body.session?.busy, 'idle ' + id)

try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'lead' })
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body))
  const id = created.body.sessionId || created.body.id || 'lead'
  assert.equal((await fixture.api('GET', route(id) + '/state')).body.session.textRedaction, true)

  for (const [text, count] of [[`Please email ${PERSON} at ${EMAIL} about Friday.`, 1], [`Remind ${PERSON} again tomorrow, cc ${EMAIL}.`, 2]]) {
    assert.equal((await fixture.api('POST', route(id) + '/message', { text })).status, 202)
    await until(async () => (await replies(id)).length >= count, 'reply ' + count)
    await settle(id)
  }
  // Nothing private reached the provider.
  assert.ok(providerBodies.length >= 2)
  for (const body of providerBodies) { assert.ok(!body.includes(PERSON)); assert.ok(!body.includes(EMAIL)) }
  // A detection failure: never sent, counted by kind.
  const sentBefore = providerBodies.length
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'OVERSIZED attachment text' })).status, 202)
  const day = () => { const now = new Date(); return [new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()] }
  await until(async () => (await fixture.api('GET', `/api/usage?boundaries=${day().join(',')}`)).body.total.redaction?.failures?.['too-large'] === 1, 'failure recorded')
  await settle(id)
  assert.equal(providerBodies.length, sentBefore)
  const report = (await fixture.api('GET', `/api/usage?boundaries=${day().join(',')}&groupBy=model`)).body
  const conversation = report.groups.find(group => group.key === 'guarded/wire').usage
  assert.equal(conversation.requests, report.total.requests)
  const turns = (await fixture.api('GET', `/api/usage?boundaries=${day().join(',')}&groupBy=purpose`)).body.groups.find(group => group.key === 'normal-turn').usage.redaction
  // Two sent turns: 2 ranges, then the cached first message's 2 plus 1 detected and 1 literal.
  assert.equal(turns.attempts, 2)
  assert.deepEqual(turns.labels, { private_email: 3, private_person: 3 })
  assert.equal(turns.literal, 1)
  assert.deepEqual(turns.failures, { 'too-large': 1 })

  const page = await fixture.openApp()
  await page.setViewport({ width: 1280, height: 900 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.waitForFunction(() => typeof window.foxwarmTest?.switchToSession === 'function')
  await page.evaluate(sessionId => window.foxwarmTest.switchToSession(sessionId), id)
  await page.waitForSelector('[data-conversation-usage] button[aria-label$="process usage"]')

  // Per-turn usage: the latest turn's details show its redaction summary.
  const toggle = async index => page.evaluate(position => {
    const items = [...document.querySelectorAll('[data-conversation-usage] button[aria-label$="process usage"]')]
    items.at(position).click()
  }, index)
  await toggle(-1)
  await page.waitForSelector('[data-conversation-usage-details]')
  const details = await page.$eval('[data-conversation-usage-details]', item => item.textContent)
  assert.match(details, /Redacted4 · email 2, person 2/)
  assert.match(details, /Detection[\d.]+m?s · \d+% cached/)
  const usageBox = await (await page.$('[data-conversation-usage-details]')).boundingBox()
  if (shots) await page.screenshot({ path: join(shots, 'turn-usage-popover.png'), clip: { x: Math.max(0, usageBox.x - 520), y: Math.max(0, usageBox.y - 90), width: usageBox.width + 540, height: usageBox.height + 110 } })
  // The first turn's details differ: a turn shows only its own requests.
  await toggle(-1)
  await page.waitForFunction(() => !document.querySelector('[data-conversation-usage-details]'))
  await toggle(0)
  await page.waitForFunction(() => /Redacted2 · email 1, person 1/.test(document.querySelector('[data-conversation-usage-details]')?.textContent || ''))
  await toggle(0)

  // Sent version of the second user message: one detected and one literal range.
  const userRows = await page.$$('.foxwarm-user-message-bubble')
  assert.ok(userRows.length >= 2)
  await userRows[1].hover()
  const buttons = await page.$$('.foxwarm-user-action-buttons button[title="Sent version"]')
  assert.ok(buttons.length >= 2)
  await buttons[1].click()
  await page.waitForSelector('[data-sent-version-dialog][data-sent-version-state="available"]')
  const marks = await page.$$eval('[data-sent-version-dialog] mark', items => items.map(item => [item.childNodes[0].textContent, item.getAttribute('data-sent-version-range'), item.getAttribute('title')]))
  assert.deepEqual(marks, [[PERSON, 'literal', 'person · known value'], [EMAIL, 'detected', 'email · detected']])
  assert.match(await page.$eval('[data-sent-version-summary]', item => item.textContent), /2 ranges were replaced before sending/)
  await shot(await page.$('[data-sent-version-dialog]'), 'sent-version.png')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-sent-version-dialog]'))
  // The reply was sent back unchanged in the next request.
  const modelButtons = await page.$$('.foxwarm-assistant-action-buttons button[title="Sent version"]')
  assert.ok(modelButtons.length >= 1)

  // System › Usage: the redaction section, grouped like the rest of the page.
  await page.evaluate(() => { localStorage.setItem('foxwarm.systemUsage.period', 'today'); location.hash = 'usage' })
  await page.waitForSelector('[data-usage-redaction]')
  await page.select('select[aria-label="Group usage by"]', 'model')
  await page.waitForSelector('[data-usage-redaction-row="guarded/wire"]')
  const section = await page.$eval('[data-usage-redaction]', item => item.textContent)
  assert.match(section, /Redacted requests2/)
  assert.match(section, /Replacements61 from known values/)
  assert.match(section, /email3person3/)
  assert.match(section, /Detection failures1/)
  assert.match(section, /Text too long1/)
  const sectionHandle = await page.$('[data-usage-redaction]')
  await sectionHandle.evaluate(item => item.scrollIntoView({ block: 'center' }))
  await shot(sectionHandle, 'usage-overview-redaction.png')

  // After a restart the in-memory cache is gone; the view says so instead of guessing.
  await fixture.stop()
  await fixture.start()
  const callsBefore = detectorCalls
  const restarted = page
  await restarted.evaluate(() => { location.hash = 'chat' })
  await restarted.reload()
  await waitForWebUiReady(restarted)
  await restarted.waitForFunction(() => typeof window.foxwarmTest?.switchToSession === 'function')
  await restarted.evaluate(sessionId => window.foxwarmTest.switchToSession(sessionId), id)
  await restarted.waitForSelector('.foxwarm-user-message-bubble')
  await until(async () => {
    await restarted.evaluate(() => document.querySelector('.foxwarm-user-action-buttons button[title="Sent version"]')?.click())
    return restarted.waitForSelector('[data-sent-version-dialog]', { timeout: 2000 }).then(() => true, () => false)
  }, 'sent version dialog after restart')
  await restarted.waitForSelector('[data-sent-version-dialog][data-sent-version-state="unavailable"]')
  assert.match(await restarted.$eval('[data-sent-version-summary]', item => item.textContent), /^The sent version is no longer available\.$/)
  await shot(await restarted.$('[data-sent-version-dialog]'), 'sent-version-unavailable.png')
  // Rendering the view never asks the detector.
  assert.equal(detectorCalls, callsBefore)

  assert.deepEqual(browserErrors, [])
  assert.deepEqual(errors, [])
  console.log('Text redaction e2e passed')
} finally {
  await fixture.cleanup()
  detector.close()
  provider.close()
}
