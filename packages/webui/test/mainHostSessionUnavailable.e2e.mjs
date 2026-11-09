// Real Main + browser: a Session whose saved state cannot be loaded shows why in Chat, retries with backoff
// instead of a tight reconnect loop, and recovers once the state is readable again.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const fixture = await createHostFixture('session-unavailable', {
  onPage: page => page.evaluateOnNewDocument(() => {
    window.__streamSockets = 0
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        super(url, protocols)
        if (String(url).includes('/webui/stream')) window.__streamSockets += 1
      }
    }
  }),
})
const authorityFile = join(fixture.data, 'state', 'sessions', 'broken.json')
const banner = '[data-chat-connection-status]'
const bannerText = page => page.$eval(banner, element => element.textContent).catch(() => '')
let page
try {
  await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'], contextLimit: 20000 } } })
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'broken' })).status, 200)
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'healthy' })).status, 200)
  await fixture.stop()
  const authority = await readFile(authorityFile, 'utf8')
  await writeFile(authorityFile, '{bad')
  await fixture.start()

  page = await fixture.openApp()
  await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
  await page.evaluate(() => window.foxwarmTest.switchToSession('broken'))
  await until(async () => (await bannerText(page)).includes('Session state is unavailable. Retrying...'), 'unavailable banner')
  assert.equal(await page.$eval('[data-chat-state-unavailable-reason]', element => element.textContent), "This Session's data file is damaged.")
  assert(!(await bannerText(page)).includes('/'), 'the reason does not expose paths')
  // The precise diagnostic stays in Main's log instead of the frame.
  assert.match(fixture.output, /Session state unavailable for "broken".*not valid JSON/)

  // Failed initialization must back off (about 1s, 2s, 4s, ...) rather than reconnect every second.
  const before = await page.evaluate(() => window.__streamSockets)
  await new Promise(done => setTimeout(done, 6000))
  const attempts = (await page.evaluate(() => window.__streamSockets)) - before
  assert(attempts >= 1 && attempts <= 3, 'backoff limits reconnects, saw ' + attempts)

  // Repairing the state lets the next retry succeed; the banner and reason disappear.
  await writeFile(authorityFile, authority)
  await until(async () => (await page.$(banner)) === null, 'banner clears after recovery', 40000)
  assert.equal(await page.$eval('.foxwarm-chat-root', element => element.getAttribute('data-chat-connection-state')), 'connected')
  assert.equal(await page.$('[data-chat-state-unavailable-reason]'), null)
  await page.evaluate(() => window.foxwarmTest.switchToSession('healthy'))
  await until(async () => (await page.$eval('.foxwarm-chat-root', element => element.getAttribute('data-chat-connection-state'))) === 'connected', 'healthy Chat connected')
  assert.equal(await page.$(banner), null)
  await fixture.stop()
  console.log(JSON.stringify({ ok: true, backoffAttempts: attempts }))
} catch (error) { console.error(fixture.output, await page?.evaluate(() => document.body.innerText.slice(0, 600) + ' | ' + (document.querySelector('[data-chat-connection-status]')?.outerHTML || 'no banner')).catch(() => '')); throw error } finally { await fixture.cleanup() }
