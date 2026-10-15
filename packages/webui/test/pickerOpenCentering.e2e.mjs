import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-picker-centering-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
let browser, page, server, fixtureUrl
const evidence = []

await writeFile(entryPath, `
  import { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  const noop = async () => {}
  const models = Array.from({ length: 45 }, (_, i) => ({ key: 'provider/model-' + i, label: 'Model ' + i, providerKey: 'provider', modelId: 'model-' + i }))
  const nodes = Array.from({ length: 45 }, (_, i) => ({ id: 'node-' + i, label: 'node-' + i, selectable: i !== 30, reason: i === 30 ? 'Offline' : null }))
  window.directoryRequests = []
  window.fetch = async (url, init) => {
    if (!url.endsWith('/nodes')) return { ok: true, json: async () => ({ commands: [] }) }
    window.directoryRequests.push({ url, signal: init.signal })
    return new Promise(resolve => { window.resolveDirectory = () => resolve({ ok: true, json: async () => ({ nodes, lockedReason: null }) }) })
  }
  function Fixture() {
    const [state, setState] = useState({
      sessionId: 'fixture/main', modelOptions: models, currentModelKey: models[20].key, sessionModel: models[20].key,
      childModelDefault: models[28].key, effectiveChildModelKey: models[28].key, currentNode: 'node-22', modelBusy: false,
    })
    window.patchFixture = patch => setState(value => ({ ...value, ...patch }))
    window.restoreModels = () => setState(value => ({ ...value, modelOptions: [...models] }))
    const changeModel = async (key, child = false) => {
      setState(value => ({ ...value, modelBusy: true }))
      await new Promise(resolve => { window.finishModelSave = resolve })
      setState(value => ({ ...value, modelBusy: false, ...(child ? { childModelDefault: key, effectiveChildModelKey: key } : { sessionModel: key, currentModelKey: key || models[0].key }) }))
    }
    return <div style={{ width: 'min(900px, calc(100% - 48px))', position: 'absolute', top: 'calc(100vh - 160px)', left: 24 }}>
      <ChatComposer {...state} sessionMissing={false} loading={false} asrAvailable={false}
        defaultModelKey={models[0].key} effectiveEffort="default" effectiveChildEffort="default"
        onChangeModel={key => changeModel(key)} onChangeChildModel={key => changeModel(key, true)}
        onChangeEffort={noop} onChangeChildEffort={noop} onRefreshModels={() => window.restoreModels()}
        onOpenModelSettings={noop} onSend={async () => false}
        onCreateStreamingTranscriber={async () => ({ sendAudioChunk() {}, stop() {}, cancel() {} })}
        onChangeNode={async (key, signal) => {
          window.nodeSaveSignal = signal
          await new Promise((resolve, reject) => {
            window.finishNodeSave = (fail = false) => {
              if (fail) reject(new Error('Could not switch node.'))
              else { if (!signal.aborted) setState(value => ({ ...value, currentNode: key })); resolve() }
            }
          })
        }} />
    </div>
  }
  createRoot(document.getElementById('root')).render(<Fixture />)
`)

before(async () => {
  await esbuild.build({ entryPoints: [entryPath], outfile: path.join(tempDir, 'fixture.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic', alias: webuiReactAliases, logLevel: 'silent' })
  const assets = path.join(webuiRoot, 'dist/assets')
  const cssAsset = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build the WebUI before running picker browser tests')
  const css = await readFile(path.join(assets, cssAsset), 'utf8')
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end(await readFile(path.join(tempDir, 'fixture.js')))
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><html><head><style>${css}</style><style>:root { --foxwarm-color-surface: white; --foxwarm-color-text: #202838; --foxwarm-color-text-strong: #202838; --foxwarm-color-text-muted: #667080; --foxwarm-color-border: #d0d6df; --foxwarm-color-accent: #087ba0; --foxwarm-color-accent-surface: #e4f3f8; }</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', executablePath: firefox ? process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox' : process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: firefox ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  if (!firefox) await page.setViewport({ width: 1100, height: 800 })
})

after(async () => {
  if (process.env.FOXWARM_PICKER_EVIDENCE_DIR) await writeFile(path.join(process.env.FOXWARM_PICKER_EVIDENCE_DIR, 'geometry.json'), JSON.stringify(evidence, null, 2))
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

const modelList = scope => `[data-model-column="${scope}"] [data-model-selector-scroll]`
const nodeList = '[data-node-picker-popup] [data-node-option]'
async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function closePicker(selector) {
  await page.keyboard.press('Escape')
  await page.waitForSelector(selector, { hidden: true })
  await settle()
}
async function clickVisible(selector) {
  // Use physical coordinates, without ElementHandle.click's implicit scrollIntoView.
  const point = await page.$eval(selector, element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (!hit || !element.contains(hit)) throw new Error('Click target is not visible: ' + element.outerHTML)
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await settle()
}
async function geometry(scope = 'current') {
  return page.evaluate(scope => {
    const list = scope === 'node' ? document.querySelector('[data-node-option]')?.parentElement : document.querySelector(`[data-model-column="${scope}"] [data-model-selector-scroll]`)
    const selected = list.querySelector('[aria-pressed="true"]')
    const rect = list.getBoundingClientRect()
    const row = selected?.getBoundingClientRect()
    return { scope, scrollTop: list.scrollTop, maxScroll: list.scrollHeight - list.clientHeight, containerCenter: rect.top + list.clientTop + list.clientHeight / 2, rowCenter: row ? row.top + row.height / 2 : null, selected: selected?.getAttribute(scope === 'node' ? 'data-node-option' : 'data-model-option-key'), pageScroll: scrollY, bodyScroll: document.body.scrollTop }
  }, scope)
}
async function expectCentered(scope) {
  await settle()
  const result = await geometry(scope)
  evidence.push(result)
  assert.ok(Math.abs(result.rowCenter - result.containerCenter) <= 1, JSON.stringify(result))
  assert.equal(result.pageScroll, 0)
  assert.equal(result.bodyScroll, 0)
  return result
}
async function screenshot(name) {
  if (process.env.FOXWARM_PICKER_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.FOXWARM_PICKER_EVIDENCE_DIR, name + '.png') })
}

test('current and child center on opening, not on physical selection, filtering, refresh, or ordinary rerenders', async () => {
  await page.goto(fixtureUrl)
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await clickVisible('.foxwarm-model-selector-trigger')
  await page.waitForFunction(() => document.activeElement?.matches('[aria-label="Filter models"]'))
  await expectCentered('current')
  await expectCentered('child')
  await screenshot('model-open-centered')
  for (const scope of ['current', 'child']) {
    await page.$eval(modelList(scope), list => { list.scrollTop = 90 })
    await settle()
    const before = await geometry(scope)
    await clickVisible(`[data-model-column="${scope}"] [data-model-option-key="provider/model-3"]`)
    assert.equal((await geometry(scope)).scrollTop, before.scrollTop, 'pending save must not center the old selection')
    await page.evaluate(() => window.finishModelSave())
    await page.waitForFunction(scope => document.querySelector(`[data-model-column="${scope}"] [data-model-option-key="provider/model-3"]`)?.getAttribute('aria-pressed') === 'true', {}, scope)
    await settle()
    const after = await geometry(scope)
    evidence.push({ phase: 'selection', before, after })
    assert.equal(after.scrollTop, before.scrollTop, 'confirmed selection must not center the clicked row')
  }
  await clickVisible('[aria-label="Filter models"]')
  await page.keyboard.type('Model')
  await settle()
  const filtered = await geometry('current')
  await clickVisible('[aria-label="Refresh models"]')
  assert.equal((await geometry('current')).scrollTop, filtered.scrollTop)
  await page.evaluate(() => window.patchFixture({ effectiveEffort: 'high' }))
  await settle()
  assert.equal((await geometry('current')).scrollTop, filtered.scrollTop)
  await closePicker('[data-model-selector-popup]')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-model-selector-trigger')), true)
  await clickVisible('.foxwarm-model-selector-trigger')
  const reopenedCurrent = await expectCentered('current')
  await expectCentered('child')
  assert.equal(await page.$eval('[aria-label="Filter models"]', input => input.value), '')
  await page.keyboard.press('Tab')
  // Firefox includes the scroll container itself in sequential focus navigation.
  if (await page.evaluate(() => document.activeElement?.matches('[data-model-selector-scroll]'))) await page.keyboard.press('Tab')
  await settle()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-option-key')), '__default__')
  const keyboardScroll = await page.$eval(modelList('current'), list => {
    const focused = document.activeElement.getBoundingClientRect()
    const bounds = list.getBoundingClientRect()
    return { scrollTop: list.scrollTop, focusedVisible: focused.top >= bounds.top && focused.bottom <= bounds.bottom }
  })
  assert.equal(keyboardScroll.focusedVisible, true, 'normal keyboard focus must still reveal an offscreen option')
  assert.ok(keyboardScroll.scrollTop < reopenedCurrent.scrollTop)
})

test('late initial model options and newly appearing child center only their own first visible list; default clamps', async () => {
  await page.goto(fixtureUrl)
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await page.evaluate(() => window.patchFixture({ modelOptions: [], childModelDefault: null }))
  await clickVisible('.foxwarm-model-selector-trigger')
  assert.equal((await geometry('current')).rowCenter, null)
  await page.evaluate(() => window.restoreModels())
  await expectCentered('current')
  await page.$eval(modelList('current'), list => { list.scrollTop = 120 })
  await page.evaluate(() => window.patchFixture({ childModelDefault: 'provider/model-28', effectiveChildModelKey: 'provider/model-28' }))
  await expectCentered('child')
  assert.equal((await geometry('current')).scrollTop, 120)
  await closePicker('[data-model-selector-popup]')
  await page.evaluate(() => window.patchFixture({ sessionModel: null, currentModelKey: 'provider/model-20' }))
  await settle()
  await clickVisible('.foxwarm-model-selector-trigger')
  const result = await geometry('current')
  assert.equal(result.selected, '__default__', 'default policy, not its effective concrete target')
  assert.equal(result.scrollTop, 0)
})

test('async Node directory centers once, preserves manual scroll through pending/error/state changes, and reopens at the new selection', async () => {
  await page.goto(fixtureUrl)
  await page.waitForSelector('.foxwarm-node-picker-trigger')
  assert.equal(await page.evaluate(() => window.directoryRequests.length), 0)
  await clickVisible('.foxwarm-node-picker-trigger')
  assert.equal(await page.$(nodeList), null, 'no stale list during directory loading')
  await page.evaluate(() => window.resolveDirectory())
  await page.waitForSelector('[data-node-option="node-22"]')
  await expectCentered('node')
  assert.equal(await page.$eval('[data-node-option="node-30"]', row => row.disabled), true)
  await screenshot('node-open-centered')
  await page.$eval(nodeList, row => { row.parentElement.scrollTop = 120 })
  await settle()
  const before = await geometry('node')
  await clickVisible('[data-node-option="node-4"]')
  assert.equal((await geometry('node')).scrollTop, before.scrollTop)
  await page.evaluate(() => window.finishNodeSave(true))
  await page.waitForSelector('[data-node-picker-popup] [role="alert"]')
  assert.equal((await geometry('node')).scrollTop, before.scrollTop)
  assert.equal((await geometry('node')).selected, 'node-22')
  await page.evaluate(() => window.patchFixture({ currentNode: 'node-18' }))
  await settle()
  const after = await geometry('node')
  evidence.push({ phase: 'node-rerender', before, after })
  assert.equal(after.scrollTop, before.scrollTop)
  assert.equal(await page.evaluate(() => window.directoryRequests.length), 1)
  await closePicker('[data-node-picker-popup]')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-node-picker-trigger')), true)
  await clickVisible('.foxwarm-node-picker-trigger')
  await page.evaluate(() => window.resolveDirectory())
  await page.waitForSelector('[data-node-option="node-18"]')
  await expectCentered('node')
  await page.$eval(nodeList, row => { row.parentElement.scrollTop = 120 })
  await clickVisible('[data-node-option="node-4"]')
  await page.evaluate(() => window.finishNodeSave())
  await page.waitForSelector('[data-node-picker-popup]', { hidden: true })
  await clickVisible('.foxwarm-node-picker-trigger')
  await page.evaluate(() => window.resolveDirectory())
  await page.waitForSelector('[data-node-option="node-4"]')
  await expectCentered('node')
})

test('missing Node remains selected and clamped; switching Session aborts an in-flight directory', async () => {
  await page.goto(fixtureUrl)
  await page.waitForSelector('.foxwarm-node-picker-trigger')
  await page.evaluate(() => window.patchFixture({ currentNode: 'missing-node' }))
  await clickVisible('.foxwarm-node-picker-trigger')
  await page.evaluate(() => window.resolveDirectory())
  await page.waitForSelector('[data-node-option="missing-node"]')
  const result = await geometry('node')
  assert.equal(result.selected, 'missing-node')
  assert.equal(result.scrollTop, result.maxScroll)
  assert.equal(await page.$eval('[data-node-option="missing-node"]', row => row.disabled), true)
  await closePicker('[data-node-picker-popup]')
  await clickVisible('.foxwarm-node-picker-trigger')
  await page.evaluate(() => window.patchFixture({ sessionId: 'fixture/other', currentNode: 'master' }))
  await page.waitForSelector('[data-node-picker-popup]', { hidden: true })
  assert.equal(await page.evaluate(() => window.directoryRequests.at(-1).signal.aborted), true)
  await page.evaluate(() => window.resolveDirectory())
  await settle()
  assert.equal(await page.$('[data-node-picker-popup]'), null)
})
