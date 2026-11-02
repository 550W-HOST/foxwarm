// System page over a real C# Main: Agents | Sessions | Nodes and the entry points of the former pages.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('system-page', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
// No model request is made; a configured model keeps first-time setup out of the way.
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const state = page => page.evaluate(() => ({ hash: decodeURIComponent(location.hash), workbench: JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4') || 'null')?.state }))

try {
  await fixture.start()
  for (const id of ['lead', 'worker', 'reviewer']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  const page = globalThis.systemPage = await fixture.openApp()
  await page.setViewport({ width: 1600, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))

  // Sidebar entry is "System" and opens on Sessions.
  await page.click('button[title="Open System"]')
  await page.waitForSelector('h1::-p-text(System)')
  assert.deepEqual(await page.$$eval('.foxwarm-system-tab', buttons => buttons.map(button => button.textContent)), ['Agents', 'Sessions', 'Nodes'])
  await page.waitForSelector('[data-system-section="sessions"] [data-architecture-session-id="worker"]')
  assert.deepEqual(await page.$$eval('[data-system-summary]', items => items.map(item => item.getAttribute('data-system-summary'))), ['sessions'])
  assert.match(await page.$eval('[data-system-summary="sessions"]', element => element.textContent), /0 active.*0 waiting.*0 queued/)
  // No global summary-card row and no Topology surface.
  assert.equal(await page.evaluate(() => document.body.innerText.includes('Execution topology') || document.body.innerText.includes('in loaded window')), false)
  for (const label of ['Filter by status', 'Filter by agent', 'Filter by node', 'Filter by model']) assert.ok(await page.$(`select[aria-label="${label}"]`), label)
  assert.ok(await page.$('button[aria-label="Global token usage"]'))
  await page.select('select[aria-label="Filter by node"]', 'master')
  await until(async () => (await page.$$('[data-architecture-session-id]')).length === 3, 'master holds every Session')
  await page.type('input[aria-label="Search sessions, models, tools"]', 'review')
  await until(async () => (await page.$$eval('[data-architecture-session-id]', rows => rows.map(row => row.getAttribute('data-architecture-session-id')))).join() === 'reviewer', 'search narrows the list')
  await page.click('[data-architecture-session-id="reviewer"]')
  await page.waitForSelector('[data-architecture-inspector-session-id="reviewer"]')
  await shot(page, 'system-sessions.png')

  await page.click('[data-system-tab="agents"]')
  await page.waitForSelector('[data-architecture-agent-id="main"]')
  assert.match(await page.$eval('[data-system-summary="agents"]', element => element.textContent), /\d+ agents/)
  assert.equal((await state(page)).workbench.tabsById['system:agents'].section, 'agents')
  await shot(page, 'system-agents.png')

  // Nodes lists the Sessions placed on each Node; a Session opens in the Sessions inspector.
  await page.click('[data-system-tab="nodes"]')
  await page.waitForSelector('[data-node-surface] [data-system-node-id="master"] [data-system-node-session="worker"]')
  assert.match(await page.$eval('[data-system-summary="nodes"]', element => element.textContent), /Online 1 · Total 1/)
  assert.match(await page.$eval('[data-system-node-id="master"]', element => element.textContent), /3 sessions here/)
  await shot(page, 'system-nodes.png')
  await page.click('[data-system-node-session="worker"]')
  await page.waitForSelector('[data-system-section="sessions"] [data-architecture-inspector-session-id="worker"]')
  assert.ok(await page.$('[data-architecture-session-id="worker"][data-architecture-session-selected="true"]'))

  // Former entry points open System on the right section.
  await page.evaluate(() => { location.hash = 'nodes' })
  await page.waitForSelector('[data-system-section="nodes"] [data-node-surface]')
  await until(async () => (await state(page)).hash === '#tab/system:agents', 'the Nodes route settles on the System tab')
  await page.click('[data-system-tab="sessions"]')
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.locator('[data-workbench-status-popup] button::-p-text(Open in System › Nodes)').click()
  await page.waitForSelector('[data-system-section="nodes"]')
  for (const hash of ['agents', 'architecture']) {
    await page.evaluate(() => { location.hash = 'tab/chat%3Alead' })
    await page.waitForSelector('.foxwarm-chat-root')
    await page.evaluate(value => { location.hash = value }, hash)
    await page.waitForSelector('[data-system-section]', { visible: true })
    await until(async () => {
      const { workbench } = await state(page)
      const find = node => node.kind === 'pane' ? (node.id === workbench.focusedPaneId ? node : null) : node.children.map(find).find(Boolean)
      return find(workbench.root)?.activeTabId === 'system:agents'
    }, `#${hash} opens the System tab`)
  }

  // A saved layout with the former Nodes tab reopens as System on Nodes, in the same position.
  const saved = await page.browser().newPage()
  await saved.setViewport({ width: 1600, height: 1000 })
  await saved.evaluateOnNewDocument(() => {
    if (sessionStorage.getItem('saved-layout')) return
    sessionStorage.setItem('saved-layout', '1')
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ version: 1, state: {
      version: 4,
      tabsById: { 'chat:lead': { id: 'chat:lead', type: 'chat', title: 'lead', sessionId: 'lead' }, 'system:nodes': { id: 'system:nodes', type: 'nodes', title: 'Nodes' } },
      root: { id: 'pane-main', kind: 'pane', tabIds: ['chat:lead', 'system:nodes'], activeTabId: 'system:nodes', collapsed: false },
      focusedPaneId: 'pane-main',
    } }))
  })
  await saved.goto(page.url().split('#')[0] + '#tab/system%3Anodes', { waitUntil: 'networkidle0' })
  await saved.waitForSelector('[data-system-section="nodes"] [data-node-surface]')
  await saved.waitForSelector('[data-fox-splash]', { hidden: true })
  // Normalized on read: the tab is System, in the former tab's position.
  assert.deepEqual(await saved.$$eval('[data-tab-id]', tabs => tabs.map(tab => tab.getAttribute('data-tab-id'))), ['chat:lead', 'system:agents'])
  assert.equal(await saved.$eval('[data-tab-id="system:agents"]', element => element.textContent.trim()), 'System')
  // The next Workbench write stores the new form.
  await saved.click('[data-system-tab="sessions"]')
  await until(async () => {
    const { workbench } = await state(saved)
    return workbench.root.tabIds?.join() === 'chat:lead,system:agents' && workbench.tabsById['system:agents']?.section === 'sessions' && !workbench.tabsById['system:nodes']
  }, 'saved layout rewritten in the new form').catch(async error => { console.log(JSON.stringify(await state(saved))); throw error })
  await saved.close()

  // The nodes popup leaf shows System on Nodes without the Workbench.
  const popup = await page.browser().newPage()
  await popup.goto(page.url().split('#')[0].split('?')[0] + '?foxwarmPopup=nodes&foxwarmPopupVersion=1', { waitUntil: 'networkidle0' })
  await popup.waitForSelector('[data-foxwarm-popup-root="nodes"] [data-system-section="nodes"] [data-node-surface]')
  assert.equal(await popup.$('[data-pane-id], [data-workbench-status-bar]'), null)
  await popup.close()

  assert.deepEqual(browserErrors, [])
  console.log('system page e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT) await globalThis.systemPage?.screenshot({ path: process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
}
