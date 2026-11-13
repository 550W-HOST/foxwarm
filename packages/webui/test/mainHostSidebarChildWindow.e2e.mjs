// Sidebar initial child window and descendant-activity ordering over a real C# Main.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('sidebar-child-window', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
const create = async (sessionId, parentSessionId) => assert.ok([200, 201].includes((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId, ...(parentSessionId ? { parentSessionId } : {}) })).status))
const childIds = (page, parent) => page.$$eval('[data-session-id]', (rows, prefix) => rows.map(row => row.getAttribute('data-session-id')).filter(id => id.startsWith(prefix)), parent + '-c')

try {
  await fixture.start()
  // Every new Session is active now, so each child is within the 24 hour window.
  for (const [parent, children] of [['one', 1], ['three', 3], ['seven', 7]]) {
    await create(parent)
    for (let index = 0; index < children; index++) await create(`${parent}-c${index}`, parent)
  }
  const page = await fixture.openApp()
  await page.setViewport({ width: 1400, height: 900 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.waitForSelector('[data-session-id="seven"]')

  for (const [parent, expected] of [['one', 1], ['three', 3], ['seven', 5]]) {
    await page.click(`[data-session-id="${parent}"] button[aria-label="Expand child sessions"]`)
    await until(async () => (await childIds(page, parent)).length === expected, `${parent} shows ${expected} children`)
  }
  assert.equal((await childIds(page, 'seven')).length, 5)
  // The preview rows render as soon as the branch is expanded; the continuation row only appears once
  // the branch load has settled, so wait for the row itself before using it.
  const more = '[data-session-continuation="more"][data-session-continuation-owner="seven"]'
  await page.waitForSelector(more)
  // Continuation keeps its step.
  await page.click(more)
  await until(async () => (await childIds(page, 'seven')).length === 7, 'Show more reveals the remaining children')
  // A realtime refresh does not shrink the window the user grew.
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'refresh-trigger' })).status < 300, true)
  await until(async () => !!(await page.$('[data-session-id="refresh-trigger"]')), 'refresh delivered')
  assert.equal((await childIds(page, 'seven')).length, 7)
  assert.deepEqual(browserErrors, [])
  console.log('sidebar child window e2e passed')
} finally {
  await fixture.cleanup()
}
