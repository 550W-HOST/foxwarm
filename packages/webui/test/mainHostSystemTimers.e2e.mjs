// System › Timers over a real C# Main: list and filters, Session inspector link, run results,
// pause/resume, edit, delete and live refresh.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('system-timers', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
const future = Date.now() + 30 * 86_400_000
await writeFile(join(fixture.data, 'state/timers.json'), JSON.stringify({ timers: [
  { id: 'msg1', sessionId: 'lead', message: 'Post the daily summary', cron: '0 0 1 1 *', newSession: false, createdAt: 1, recentRuns: [{ at: Date.now() - 60_000, outcome: 'delivered' }] },
  { id: 'once1', sessionId: 'lead', message: 'Nightly review', at: future, newSession: true, agentName: 'main', sessionPrefix: 'nightly', createdAt: 2 },
  { id: 'script1', sessionId: 'worker', message: '', action: 'toolscript', script: { code: '# disk check\nprint("checked")', mode: 'foreground', timeoutSecs: 20 }, cron: '0 0 1 1 *', createdAt: 3,
    recentRuns: [{ at: Date.now() - 120_000, outcome: 'failed', error: 'Disk probe timed out' }, { at: Date.now() - 180_000, outcome: 'completed', runId: 'tsr_fixture' }] },
] }))
await mkdir(join(fixture.data, 'state/toolscript-runs'), { recursive: true })
await writeFile(join(fixture.data, 'state/toolscript-runs/tsr_fixture.json'), JSON.stringify({ runId: 'tsr_fixture', ownerSessionId: 'worker', status: 'completed', mode: 'foreground', stdout: 'checked\n', createdAt: 1, updatedAt: 2 }))
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const listed = page => page.$$eval('[data-system-timer-list] [data-system-timer-id]', rows => rows.map(row => row.getAttribute('data-system-timer-id')))
const timer = async id => (await fixture.api('GET', '/api/timers')).body.timers.find(row => row.id === id)

try {
  await fixture.start()
  for (const id of ['lead', 'worker']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  const page = globalThis.timersPage = await fixture.openApp()
  await page.setViewport({ width: 1600, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))

  // The Session inspector lists that Session's timers and links to the section.
  await page.click('button[title="Open System"]')
  await page.waitForSelector('[data-system-section="sessions"] [data-architecture-session-id="lead"]')
  await page.click('[data-architecture-session-id="lead"]')
  await page.waitForSelector('[data-session-timers="lead"] [data-session-timer-id="msg1"]')
  assert.deepEqual(await page.$$eval('[data-session-timers="lead"] [data-session-timer-id]', rows => rows.map(row => row.getAttribute('data-session-timer-id'))), ['once1', 'msg1'])
  await page.$eval('[data-session-timers="lead"]', element => element.scrollIntoView({ block: 'center' }))
  await shot(page, 'system-sessions-inspector-timers.png')
  await page.click('[data-session-timers-open]')
  await page.waitForSelector('[data-system-section="timers"] [data-system-timers-session-filter="lead"]')
  await until(async () => (await listed(page)).join() === 'once1,msg1', 'the section opens filtered to the Session')
  await page.click('[aria-label="Show timers for all sessions"]')
  await until(async () => (await listed(page)).length === 3, 'all timers listed')
  assert.match(await page.$eval('[data-system-summary="timers"]', element => element.textContent), /3 timers · 0 paused · 1 failing/)

  // Filters and search.
  await page.select('select[aria-label="Filter timers by action"]', 'toolscript')
  await until(async () => (await listed(page)).join() === 'script1', 'action filter')
  await page.select('select[aria-label="Filter timers by action"]', '')
  await page.select('select[aria-label="Filter timers by state"]', 'failing')
  await until(async () => (await listed(page)).join() === 'script1', 'state filter')
  await page.select('select[aria-label="Filter timers by state"]', 'all')
  await page.type('input[aria-label="Search timers"]', 'nightly')
  await until(async () => (await listed(page)).join() === 'once1', 'search')
  await page.click('input[aria-label="Search timers"]', { clickCount: 3 }); await page.keyboard.press('Backspace')
  await until(async () => (await listed(page)).length === 3, 'search cleared')

  // Recent results, with the run linking to its diagnostics.
  await page.click('[data-system-timer-id="script1"]')
  await page.waitForSelector('[data-system-timer-inspector="script1"] [data-system-timer-runs]')
  const inspector = await page.$eval('[data-system-timer-inspector="script1"]', element => element.innerText)
  for (const text of ['Disk probe timed out', 'Failed', 'Completed', 'Inline script: print("checked")', 'Runs for the owner session', '20s']) assert.ok(inspector.includes(text), text)
  await shot(page, 'system-timers-desktop.png')
  await page.click('[data-system-timer-run="tsr_fixture"]')
  await page.waitForSelector('[role="dialog"]')
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('checked'))
  await page.click('[role="dialog"] button[aria-label="Close"]')

  // Pause and resume.
  await page.click('[data-system-timer-id="msg1"]')
  await page.waitForSelector('[data-system-timer-inspector="msg1"]')
  await page.click('[data-system-timer-inspector="msg1"] [data-system-timer-pause]')
  await until(async () => (await timer('msg1')).paused === true, 'paused through the API')
  await page.waitForFunction(() => document.querySelector('[data-system-timer-id="msg1"]')?.textContent.includes('Paused'))
  assert.match(await page.$eval('[data-system-timer-inspector="msg1"]', element => element.innerText), /Next run\s+Paused/)
  await page.click('[data-system-timer-inspector="msg1"] [data-system-timer-pause]')
  await until(async () => (await timer('msg1')).paused === false, 'resumed through the API')

  // Edit: schedule and message, validated by the server.
  await page.locator('[data-system-timer-inspector="msg1"] button::-p-text(Edit)').click()
  await page.waitForSelector('[data-system-timer-editor]')
  await page.select('[data-system-timer-editor] select[aria-label="Schedule"]', 'cron')
  const cron = await page.$('[data-system-timer-editor] input[aria-label="Cron schedule"]')
  await cron.click({ clickCount: 3 }); await cron.type('not a cron')
  await page.click('[data-system-timer-editor] button[type="submit"]')
  await page.waitForSelector('[data-system-timer-editor] [role="alert"]')
  await cron.click({ clickCount: 3 }); await cron.type('30 8 * * 1-5')
  const message = await page.$('[data-system-timer-editor] textarea[aria-label="Message"]')
  await message.click({ clickCount: 3 }); await message.type('Post the weekday summary')
  await page.click('[data-system-timer-editor] button[type="submit"]')
  await page.waitForSelector('[data-system-timer-editor]', { hidden: true })
  const edited = await timer('msg1')
  assert.equal(edited.cron, '30 8 * * 1-5'); assert.equal(edited.message, 'Post the weekday summary'); assert.ok(edited.nextRunAt)
  assert.ok((await page.$eval('[data-system-timer-id="msg1"]', element => element.textContent)).includes('Post the weekday summary'))

  // Live refresh: a change made elsewhere appears without reloading.
  const pauseScript = await fixture.api('PATCH', '/api/timers/script1', { sessionId: 'worker', paused: true })
  assert.equal(pauseScript.status, 200, JSON.stringify(pauseScript.body))
  await page.waitForFunction(() => document.querySelector('[data-system-timer-id="script1"]')?.textContent.includes('Paused'))
  assert.match(await page.$eval('[data-system-summary="timers"]', element => element.textContent), /1 paused/)

  // Delete asks for confirmation first.
  await page.click('[data-system-timer-id="once1"]')
  await page.locator('[data-system-timer-inspector="once1"] button::-p-text(Delete)').click()
  await page.waitForSelector('[data-system-timer-delete-confirm]')
  await page.locator('[data-system-timer-delete-confirm] button::-p-text(Cancel)').click()
  assert.ok(await timer('once1'))
  await page.locator('[data-system-timer-inspector="once1"] button::-p-text(Delete)').click()
  await page.locator('[data-system-timer-delete-confirm] button::-p-text(Delete timer)').click()
  await until(async () => (await listed(page)).join() === 'msg1,script1', 'deleted timer leaves the list')
  assert.equal(await timer('once1'), undefined)

  // The owner opens in the Sessions inspector; #timers opens the section.
  await page.click('[data-system-timer-id="msg1"]')
  await page.click('[data-system-timer-inspector="msg1"] [data-system-timer-owner="lead"]')
  await page.waitForSelector('[data-system-section="sessions"] [data-architecture-inspector-session-id="lead"]')
  await page.evaluate(() => { location.hash = 'timers' })
  await page.waitForSelector('[data-system-section="timers"] [data-system-timers]')

  // Narrow layout keeps the list and inspector usable.
  // Changing to a mobile viewport reloads the page.
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.waitForSelector('[data-fox-splash]', { hidden: true })
  await page.evaluate(() => { location.hash = 'timers' })
  await page.waitForSelector('[data-system-timer-id="script1"]', { visible: true })
  await page.click('[data-system-timer-id="script1"]')
  await page.waitForSelector('[data-system-timer-inspector="script1"]')
  await page.waitForSelector('[data-system-timer-id="script1"][data-system-timer-selected="true"]')
  assert.equal(await page.$('[data-system-timer-id="msg1"][data-system-timer-selected]'), null)
  const overflow = await page.evaluate(() => document.querySelector('[data-system-timers]').scrollWidth - document.querySelector('[data-system-timers]').clientWidth)
  assert.ok(overflow <= 1, `no horizontal overflow (${overflow}px)`)
  await new Promise(done => setTimeout(done, 300)) // Let row color transitions settle.
  await shot(page, 'system-timers-narrow.png')
  await page.$eval('[data-system-timer-inspector="script1"]', element => element.scrollIntoView())
  await shot(page, 'system-timers-narrow-inspector.png')

  assert.deepEqual(browserErrors, [])
  console.log('system timers e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT) await globalThis.timersPage?.screenshot({ path: process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
}
