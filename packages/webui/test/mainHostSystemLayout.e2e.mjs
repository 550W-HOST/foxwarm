// System's list/detail layout against a real C# Main: the header stays put and a selection far
// down a long list keeps its details in view (wide window and 1100 px); an Agent's prompt layers
// (framework prompt dialog, installation additions created through Code's file route) and rule
// layers (installation policy, creator ancestors read-only, own layer saved or rejected by the
// server).
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const fixture = await createHostFixture('system-layout')
const exists = file => access(file).then(() => true, () => false)
// A model key naming a GPT model selects the framework prompt's GPT-only blocks.
await writeModelFixture(fixture.data, { default: 'gpt-lab', providers: { 'gpt-lab': { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9/r', models: ['wire'], contextLimit: 20000 } } })
await writeFile(join(fixture.data, 'state/tool-authorization.yaml'), 'version: 1\nrules:\n  - id: global-no-web\n    tool: web_search\n    action: deny\n')
const failures = []

try {
  await fixture.start()
  for (let index = 0; index < 30; index += 1) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: `row-${String(index).padStart(2, '0')}` })).status, 200)
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'parent', rules: [{ id: 'parent-no-exec', tool: 'exec', action: 'deny' }] })).status, 201)
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'child' })).status, 201)
  // Creator chains are recorded when a model creates an Agent; write one into the catalog.
  await fixture.stop()
  const indexPath = join(fixture.data, 'state/agents.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.child = { ...index.child, createdBy: 'parent' }
  await writeFile(indexPath, JSON.stringify(index, null, 2))
  await fixture.start()
  const agents = (await fixture.api('GET', '/api/agents')).body
  const child = agents.agents.find(agent => agent.id === 'child')
  assert.deepEqual(child.creatorChain, ['parent', 'child'])
  assert.deepEqual(agents.agents.find(agent => agent.id === 'parent').rules, [{ id: 'parent-no-exec', tool: 'exec', action: 'deny' }])
  assert.equal(typeof agents.agents.find(agent => agent.id === 'main').lastActivity, 'number')
  assert.equal(agents.prompt.installation.exists, false)
  const framework = (await fixture.api('GET', '/api/agents/child/framework-prompt')).body
  assert.match(framework.model, /gpt/)
  assert.equal(framework.modelDependent, true)
  assert.match(framework.text, /--- REPLY STYLE ---/)
  assert.doesNotMatch(framework.text, /<foxwarm-if/)
  assert.equal((await fixture.api('GET', '/api/agents/missing/framework-prompt')).status, 404)

  const page = globalThis.layoutPage = await fixture.openApp()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('dialog', dialog => { browserErrors.push('dialog: ' + dialog.message()); void dialog.dismiss() })
  await page.setViewport({ width: 1600, height: 900 })
  await page.evaluate(() => { location.hash = 'system' })
  await page.waitForSelector('[data-system-tab="sessions"]')
  await page.click('[data-system-tab="sessions"]')

  // Selecting the last row of a long list keeps its details and the section tabs in view.
  const selectLast = async label => {
    await page.waitForSelector('[data-system-split="sessions"][data-system-split-layout="split"] [data-architecture-session-id="row-00"]')
    await page.$eval('[data-system-split="sessions"] [data-system-pane-scroll="list"]', list => { list.scrollTop = list.scrollHeight })
    const last = await page.$$eval('[data-architecture-session-id]', rows => rows.at(-1).getAttribute('data-architecture-session-id'))
    await page.click(`[data-architecture-session-id="${last}"]`)
    await page.waitForSelector(`[data-architecture-inspector-session-id="${last}"]`)
    const layout = await page.evaluate(id => {
      const box = element => element.getBoundingClientRect()
      const detail = box(document.querySelector('[data-system-split="sessions"] [data-system-pane-scroll="detail"]'))
      const inspector = box(document.querySelector(`[data-architecture-inspector-session-id="${id}"]`))
      const row = box(document.querySelector(`[data-architecture-session-id="${id}"]`))
      return { tabs: box(document.querySelector('[data-system-tab="sessions"]')).top, inspector: inspector.top, detail: [detail.top, detail.bottom], row: [row.top, row.bottom], height: innerHeight, list: document.querySelector('[data-system-split="sessions"] [data-system-pane-scroll="list"]').scrollTop }
    }, last)
    if (layout.list <= 0) failures.push(`${label}: the list did not scroll by itself ${JSON.stringify(layout)}`)
    if (layout.tabs < 0) failures.push(`${label}: section tabs scrolled away ${JSON.stringify(layout)}`)
    if (layout.inspector < layout.detail[0] - 1 || layout.inspector > layout.detail[0] + 40) failures.push(`${label}: inspector header not at the top of its pane ${JSON.stringify(layout)}`)
    if (layout.row[1] > layout.height || layout.row[0] < layout.detail[0]) failures.push(`${label}: selected row out of view ${JSON.stringify(layout)}`)
  }
  await selectLast('1600 px')
  await page.setViewport({ width: 1100, height: 900 })
  await selectLast('1100 px')
  await page.setViewport({ width: 1600, height: 900 })

  // Agents in creator order, each row with its rule state.
  await page.click('[data-system-tab="agents"]')
  await page.waitForSelector('[data-architecture-agent-id="child"]')
  assert.deepEqual(await page.$$eval('[data-architecture-agent-id]', rows => rows.map(row => [row.getAttribute('data-architecture-agent-id'), row.getAttribute('data-agent-depth')])), [['main', '0'], ['parent', '0'], ['child', '1']])
  assert.match(await page.$eval('[data-architecture-agent-id="parent"]', row => row.textContent), /1 rule/)
  // The list pane scrolls and so clips: the first row's selection and focus rings stay inside it.
  const ringOutsideList = selector => page.$eval(selector, row => {
    const list = row.closest('[data-system-pane-scroll="list"]')
    const outer = list.getBoundingClientRect(), box = row.getBoundingClientRect()
    const left = outer.left + list.clientLeft, top = outer.top + list.clientTop
    // Outset box-shadows (rings) extend by their spread; inset ones are drawn inside the row.
    const spread = Math.max(0, ...getComputedStyle(row).boxShadow.split(/,(?![^(]*\))/).filter(shadow => !/\binset\b/.test(shadow))
      .map(shadow => parseFloat(shadow.replace(/[a-z]+\([^)]*\)/g, '').match(/-?[\d.]+px/g)?.[3] || '0')))
    return { left: left - (box.left - spread), top: top - (box.top - spread), right: box.right + spread - (left + list.clientWidth), bottom: box.bottom + spread - (top + list.clientHeight) }
  })
  await page.click('[data-architecture-agent-id="main"]')
  await page.waitForSelector('[data-architecture-agent-id="main"][data-architecture-agent-selected="true"]')
  await page.keyboard.press('Shift')
  await page.focus('[data-architecture-agent-id="main"]')
  assert.equal(await page.$eval('[data-architecture-agent-id="main"]', row => row.matches(':focus-visible')), true)
  for (const state of ['focused', 'selected']) {
    const outside = await ringOutsideList('[data-architecture-agent-id="main"]')
    if (Object.values(outside).some(value => value > 0)) failures.push(`${state} first agent row: ring outside the list pane ${JSON.stringify(outside)}`)
    await page.$eval('[data-architecture-agent-id="main"]', row => row.blur())
  }
  await page.click('[data-architecture-agent-id="child"]')
  await page.waitForSelector('[data-architecture-agent-inspector-id="child"] [data-agent-tab-panel="overview"]')
  assert.match(await page.$eval('[data-agent-access]', element => element.textContent), /Rules from parent apply too/)

  // Prompt layers: framework, installation additions, then the Agent's own memory.
  await page.click('[data-agent-tab="prompt"]')
  await page.waitForSelector('[data-prompt-layers]')
  assert.deepEqual(await page.$$eval('[data-prompt-layer]', rows => rows.map(row => row.getAttribute('data-prompt-layer'))), ['framework', 'installation', 'memory:child'])
  await page.click('[data-prompt-framework-view]')
  await page.waitForSelector('[data-json-inspector-dialog] [data-framework-prompt-model]')
  assert.match(await page.$eval('[data-framework-prompt-model]', element => element.getAttribute('data-framework-prompt-model')), /gpt/)
  await page.waitForFunction(() => document.querySelector('[data-json-inspector-dialog] .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('You are running in Foxwarm'))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-json-inspector-dialog]', { hidden: true })
  // Create in Code writes the empty file, then the layer opens it.
  const localPrompt = join(fixture.data, 'agents/00_SYSTEM.local.md')
  assert.equal(await exists(localPrompt), false)
  await page.click('[data-prompt-installation-create]')
  await until(() => exists(localPrompt), 'installation additions created')
  assert.equal(await readFile(localPrompt, 'utf8'), '')
  // Code opens on master as a Workbench tab (this fixture has no Code assets, so it shows its
  // install page).
  await page.waitForSelector('[data-tab-id^="vscode"]')
  await page.click('[data-tab-id="system:agents"]')

  // Rule layers: the installation policy and the creator's layer read-only, the own layer edited.
  await page.waitForSelector('[data-architecture-agent-inspector-id="child"]')
  // The layer now opens the existing file.
  await page.waitForSelector('[data-prompt-installation-open]')
  await page.click('[data-agent-tab="rules"]')
  await page.waitForSelector('[data-rule-layers]')
  assert.deepEqual(await page.$$eval('[data-rule-layer]', rows => rows.map(row => row.getAttribute('data-rule-layer'))), ['installation', 'parent', 'own'])
  // A top-level creator's layer is changed only by administrators.
  const parentLayer = await page.$eval('[data-rule-layer="parent"]', row => row.textContent)
  assert.match(parentLayer, /Changed by administrators/)
  assert.doesNotMatch(parentLayer, /sessions of/)
  assert.match(await page.$eval('[data-rule-layer="own"]', row => row.textContent), /sessions of parent/)
  await page.click('[data-rule-layer="installation"] button[aria-expanded="false"]')
  await page.waitForSelector('[data-rule-layer="installation"] [data-rule-id="global-no-web"]')
  await page.click('[data-rule-layer="parent"] button[aria-expanded="false"]')
  await page.waitForSelector('[data-rule-layer="parent"] [data-rule-id="parent-no-exec"]')
  assert.equal(await page.$('[data-rule-layer="parent"] [data-rule-edit], [data-rule-layer="installation"] [data-rule-edit]'), null)

  const editor = '[data-rule-editor] [role="textbox"]'
  const replaceRules = async text => {
    await page.focus(editor)
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await page.keyboard.sendCharacter(text)
    await page.waitForFunction(expected => [...document.querySelectorAll('[data-rule-editor] .view-line')].map(line => line.textContent).join('').replace(/\u00a0/g, ' ').trim() === expected, { timeout: 10000 }, text)
  }
  await page.click('[data-rule-layer="own"] [data-rule-edit]')
  await page.waitForSelector(editor, { visible: true })
  // The server rejects an unknown action; the stored layer is unchanged.
  await replaceRules('[{id: child-rule, tool: exec, action: maybe}]')
  await page.click('[data-rule-save]:not(:disabled)')
  await page.waitForSelector('[data-rule-error]')
  assert.match(await page.$eval('[data-rule-error]', element => element.textContent), /action/i)
  assert.deepEqual((await fixture.api('GET', '/api/agents')).body.agents.find(agent => agent.id === 'child').rules, [])
  await replaceRules('[{id: child-no-web, tool: web_search, action: deny}]')
  await page.click('[data-rule-save]:not(:disabled)')
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-id="child-no-web"]')
  assert.deepEqual((await fixture.api('GET', '/api/agents')).body.agents.find(agent => agent.id === 'child').rules, [{ id: 'child-no-web', tool: 'web_search', action: 'deny' }])
  assert.match(await page.$eval('[data-architecture-agent-id="child"]', row => row.textContent), /1 rule/)

  // Edit in Setup opens the Authorization tab.
  await page.click('[data-rule-installation-setup]')
  await page.waitForSelector('[data-setup-section="authorization"]:not([hidden])')

  assert.deepEqual(failures, [])
  assert.deepEqual(browserErrors, [])
  console.log('System layout e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT) await globalThis.layoutPage?.screenshot({ path: process.env.FOXWARM_SYSTEM_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
}
