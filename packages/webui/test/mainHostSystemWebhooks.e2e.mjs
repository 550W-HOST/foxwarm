// System › Webhooks over a real C# Main: configured webhooks, recent deliveries, handler run
// records, an unavailable target and live refresh.
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('system-webhooks', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
// No model turn is needed: alerts are recorded without waking the Session and CI runs a handler.
await appendFile(join(fixture.data, 'state/config.yaml'), `access:
  identities:
    alerts:
      token: synthetic-alerts-secret
      surfaces:
        webhook: { session: lead, verify: { header: cf-webhook-auth }, wake: false }
    ci:
      token: synthetic-ci-secret
      surfaces:
        webhook:
          session: worker
          verify: bearer
          action: toolscript
          script: { code: "print('handled', args['webhook']['payload']['run'])", timeoutSecs: 20 }
    orphan:
      token: synthetic-orphan-secret
      surfaces:
        webhook: { session: missing, verify: bearer }
`)
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const deliver = (id, headers, body) => fetch(`${fixture.origin}/webhooks/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const webhook = async id => (await fixture.api('GET', '/api/webhooks')).body.webhooks.find(row => row.id === id)
const settled = row => row.deliveries.every(entry => entry.outcome !== 'queued' && entry.outcome !== 'running')
const listed = page => page.$$eval('[data-system-webhook-list] [data-system-webhook-id]', rows => rows.map(row => row.getAttribute('data-system-webhook-id')))
const outcomes = page => page.$$eval('[data-system-webhook-deliveries] [data-system-webhook-delivery]', rows => rows.map(row => row.getAttribute('data-system-webhook-delivery')))

try {
  await fixture.start()
  for (const id of ['lead', 'worker']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  assert.equal((await deliver('alerts', { 'cf-webhook-auth': 'synthetic-alerts-secret' }, { alert: 'disk' })).status, 202)
  assert.equal((await deliver('ci', { authorization: 'Bearer synthetic-ci-secret' }, { run: 41 })).status, 202)
  assert.equal((await deliver('orphan', { authorization: 'Bearer synthetic-orphan-secret' }, {})).status, 503)
  assert.equal((await deliver('alerts', { 'cf-webhook-auth': 'wrong' }, {})).status, 401)
  await until(async () => { const row = await webhook('ci'); return row?.deliveries.length === 1 && settled(row) }, 'first handler run settled')

  const page = globalThis.webhooksPage = await fixture.openApp()
  await page.setViewport({ width: 1600, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => { location.hash = 'webhooks' })
  await page.waitForSelector('[data-system-section="webhooks"] [data-system-webhooks]')
  assert.equal(await page.$eval('[data-system-tab="webhooks"]', element => element.getAttribute('aria-selected')), 'true')
  await until(async () => (await listed(page)).join() === 'orphan,alerts,ci', 'webhooks needing attention first')
  assert.match(await page.$eval('[data-system-summary="webhooks"]', element => element.textContent), /3 webhooks · 1 need attention/)

  // The unavailable target is explained, and a loopback address points to the url setting.
  await page.waitForSelector('[data-system-webhook-inspector="orphan"] [data-system-webhook-target-missing]')
  assert.deepEqual(await outcomes(page), ['unavailable'])
  assert.ok(await page.$('[data-system-webhook-inspector="orphan"] [data-system-webhook-local]'))
  await shot(page, 'system-webhooks-orphan.png')

  // Passive alerts: header verification, no wake, one delivery; the wrong secret is only counted.
  await page.click('[data-system-webhook-id="alerts"]')
  await page.waitForSelector('[data-system-webhook-inspector="alerts"]')
  const alerts = await page.$eval('[data-system-webhook-inspector="alerts"]', element => element.textContent)
  assert.match(alerts, /Secret in cf-webhook-auth/)
  assert.match(alerts, /Message the session without waking it/)
  assert.match(alerts, /1 with a wrong secret or signature/)
  assert.match(await page.$eval('[data-system-webhook-url]', element => element.textContent), /\/webhooks\/alerts$/)
  assert.deepEqual(await outcomes(page), ['delivered'])
  await page.click('[data-system-webhook-target="lead"]')
  await page.waitForSelector('[data-system-section="sessions"] [data-architecture-inspector-session-id="lead"]')
  await page.evaluate(() => { location.hash = 'webhooks' })
  await page.waitForSelector('[data-system-section="webhooks"] [data-system-webhooks]')

  // Handler runs open their ToolScript record.
  await page.click('[data-system-webhook-id="ci"]')
  await page.waitForSelector('[data-system-webhook-inspector="ci"] [data-system-webhook-run]')
  assert.deepEqual(await outcomes(page), ['completed'])
  assert.match(await page.$eval('[data-system-webhook-inspector="ci"]', element => element.textContent), /Run a ToolScript handler/)
  await page.click('[data-system-webhook-inspector="ci"] [data-system-webhook-run]')
  // The run record view may render spaces as non-breaking spaces.
  await page.waitForFunction(() => /handled\s41/.test(document.querySelector('[data-json-inspector-dialog]')?.textContent || ''))
  await shot(page, 'system-webhooks-run.png')
  await page.click('[data-json-inspector-dialog] button[aria-label="Close"]')
  await page.waitForSelector('[data-json-inspector-dialog]', { hidden: true })

  // A new delivery refreshes the open section without a reload.
  assert.equal((await deliver('ci', { authorization: 'Bearer synthetic-ci-secret' }, { run: 42 })).status, 202)
  await until(async () => (await outcomes(page)).join() === 'completed,completed', 'live refresh')
  await shot(page, 'system-webhooks-ci.png')

  // Secrets never reach the page.
  const html = await page.content()
  for (const secret of ['synthetic-alerts-secret', 'synthetic-ci-secret', 'synthetic-orphan-secret']) assert.ok(!html.includes(secret), secret)

  // Narrow layout keeps the list and inspector usable.
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.waitForSelector('[data-fox-splash]', { hidden: true })
  await page.evaluate(() => { location.hash = 'webhooks' })
  await page.waitForSelector('[data-system-webhook-id="ci"]', { visible: true })
  const overflow = await page.evaluate(() => document.querySelector('[data-system-webhooks]').scrollWidth - document.querySelector('[data-system-webhooks]').clientWidth)
  assert.ok(overflow <= 1, `no horizontal overflow (${overflow}px)`)
  await shot(page, 'system-webhooks-narrow.png')

  assert.deepEqual(browserErrors, [])
  console.log('system webhooks e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT) await globalThis.webhooksPage?.screenshot({ path: process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
}
