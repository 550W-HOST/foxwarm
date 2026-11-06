// Sidebar navigation, Session-list toolbar and status-bar links over a real C# Main.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('sidebar-navigation', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
const shots = process.env.FOXWARM_SIDEBAR_SCREENSHOT_DIR
const shot = async (page, name, clip) => { if (shots) await page.screenshot({ path: join(shots, name), captureBeyondViewport: false, ...(clip ? { clip } : {}) }) }
const sidebarClip = { x: 0, y: 0, width: 300, height: 640 }
const menuLabels = page => page.$$eval('[role="menu"] :is([role="menuitemradio"], [role="menuitemcheckbox"], [data-context-menu-header])', items => items.map(item => `${item.getAttribute('role') || 'header'}:${item.textContent.trim()}${item.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`))
const chooseDisplay = async (page, label) => {
  await page.click('button[aria-label="Session display options"]')
  await page.waitForSelector('[role="menu"]')
  await page.evaluate(text => [...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent.trim() === text).click(), label)
}

try {
  await fixture.start()
  assert.ok([200, 201].includes((await fixture.api('POST', '/api/agents', { agentId: 'beta' })).status))
  for (const [agentId, sessionId] of [['main', 'lead'], ['main', 'worker'], ['beta', 'notes']]) assert.ok([200, 201].includes((await fixture.api('POST', '/api/sessions', { agentId, sessionId })).status))
  assert.equal((await fixture.api('POST', '/api/sessions/lead/pin', { pinned: true })).status, 200)
  const page = globalThis.sidebarPage = await fixture.openApp()
  await page.setViewport({ width: 1400, height: 900 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))

  // Brand row with settings and collapse; navigation rows; no footer.
  await page.waitForSelector('[data-sidebar-nav-list]')
  assert.deepEqual(await page.$$eval('[data-sidebar-nav-list] [data-sidebar-nav]', rows => rows.map(row => row.textContent.trim())), ['System', 'Tasks', 'Search', 'Code', 'Terminal'])
  assert.ok(await page.$('[data-sidebar-brand] button[aria-label="Open UI settings"]'))
  assert.equal(await page.$('.foxwarm-sidebar-panel [data-sidebar-footer]'), null)
  // Toolbar: search, new session, display options.
  assert.deepEqual(await page.$$eval('.foxwarm-sidebar-panel :is(input[aria-label="Search sessions"], button[aria-label="New session"], button[aria-label="Session display options"])', items => items.map(item => item.getAttribute('aria-label'))), ['Search sessions', 'New session', 'Session display options'])
  await page.click('[data-sidebar-nav="system"] > button')
  await page.waitForSelector('[data-sidebar-nav="system"][data-active]')
  await page.waitForSelector('[data-session-id="worker"]')
  await shot(page, 'sidebar-ungrouped.png', sidebarClip)

  // One display menu with headers, radio choices and a toggle.
  await page.click('button[aria-label="Session display options"]')
  await page.waitForSelector('[role="menu"]')
  assert.deepEqual(await menuLabels(page), ['presentation:View', 'menuitemradio:Default ✓', 'menuitemradio:Time', 'menuitemradio:Flat', 'presentation:Group by', 'menuitemradio:No grouping ✓', 'menuitemradio:By Agent', 'menuitemradio:By Node', 'presentation:Rows', 'menuitemcheckbox:Detailed rows'])
  await shot(page, 'display-options-menu.png', { x: 0, y: 0, width: 520, height: 720 })
  await page.keyboard.press('Escape')
  await chooseDisplay(page, 'By Agent')
  await page.waitForSelector('[data-session-group="beta"] [data-session-id="beta/notes"]')
  await page.mouse.move(900, 600)
  await shot(page, 'sidebar-grouped-agent.png', sidebarClip)
  await chooseDisplay(page, 'Detailed rows')
  await page.waitForSelector('[data-session-list-density="detailed"]')
  await page.mouse.move(900, 600)
  await shot(page, 'sidebar-grouped-agent-detailed.png', sidebarClip)
  await chooseDisplay(page, 'Detailed rows')
  await page.waitForSelector('[data-session-list-density="normal"]')
  await page.click('[data-session-id="worker"]', { button: 'right' })
  await page.waitForSelector('[role="menu"]')
  await shot(page, 'session-context-menu.png', { x: 0, y: 0, width: 560, height: 900 })
  await page.keyboard.press('Escape')

  // A filter offers message search with the text prefilled, in the Search tab.
  await page.type('input[aria-label="Search sessions"]', 'deploy notes')
  await page.waitForSelector('[data-session-list-search-messages]')
  assert.equal(await page.$eval('[data-session-list-search-messages]', button => button.textContent.trim()), 'Search messages for ‘deploy notes’')
  await page.click('[data-session-list-search-messages]')
  await page.waitForSelector('[data-history-search-view] [data-history-query-input]')
  await until(async () => (await page.$eval('[data-history-query-input]', input => input.value)) === 'deploy notes', 'the query is prefilled')
  await page.waitForSelector('[data-sidebar-nav="search"][data-active]')
  await page.click('button[aria-label="Clear session search"]')

  // Status bar: labelled task counts, a terminal-panel toggle and links into System.
  await page.waitForSelector('[data-status-task-counts]')
  assert.match(await page.$eval('[data-status-task-counts]', element => element.textContent), /^\d+ active · \d+ open$/)
  assert.equal(await page.$eval('[data-status-terminal-panel]', element => element.textContent.trim()), 'Terminal panel')
  await shot(page, 'status-bar.png', { x: 280, y: 860, width: 1120, height: 40 })
  for (const [trigger, filter] of [['Running sessions:', 'active'], ['Waiting in loaded sessions:', 'waiting']]) {
    await page.click(`[data-workbench-status-bar] button[aria-label^="${trigger}"]`)
    await page.waitForSelector('[data-workbench-status-popup] [data-status-open]')
    if (filter === 'active' && shots) {
      await shot(page, 'status-running-popup.png', { x: 280, y: 560, width: 520, height: 340 })
      // Capturing can dismiss the popover; reopen it for the action.
      if (!await page.$('[data-workbench-status-popup]')) await page.click(`[data-workbench-status-bar] button[aria-label^="${trigger}"]`)
      await page.waitForSelector('[data-workbench-status-popup] [data-status-open]')
    }
    assert.equal(await page.$eval('[data-workbench-status-popup] [data-status-open]', button => button.textContent), 'Open in System › Sessions')
    await page.click('[data-workbench-status-popup] [data-status-open]')
    await page.waitForSelector('[data-system-section="sessions"]')
    await until(() => page.$eval('[data-system-summary="sessions"]', summary => [...summary.querySelectorAll('button[aria-pressed="true"]')].map(button => button.textContent).join()).then(text => text.endsWith(filter)), `${filter} filter selected`)
  }
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.locator('[data-workbench-status-popup] button::-p-text(Open in System › Nodes)').click()
  await page.waitForSelector('[data-system-section="nodes"]')

  // The collapsed rail keeps the same entries at the top.
  await page.click('button[title="Collapse sidebar"]')
  await page.waitForSelector('.w-12 [data-sidebar-nav-list]')
  assert.deepEqual(await page.$$eval('.w-12 [data-sidebar-nav-list] button[aria-label]', buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Open UI settings', 'System', 'Tasks', 'Search history'])
  await shot(page, 'sidebar-collapsed.png', { x: 0, y: 0, width: 120, height: 400 })

  assert.deepEqual(browserErrors, [])
  console.log('sidebar navigation e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SIDEBAR_FAILURE_SCREENSHOT) await globalThis.sidebarPage?.screenshot({ path: process.env.FOXWARM_SIDEBAR_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
}
