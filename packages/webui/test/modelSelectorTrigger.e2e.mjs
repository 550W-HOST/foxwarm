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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-model-trigger-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')
const assetsDirectory = path.join(webuiRoot, 'dist/assets')
let server
let browser
let page
let fixtureUrl

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  window.fetch = async () => ({ ok: true, json: async () => ({ commands: [] }) })
  const noop = async () => {}
  window.modelSelections = []
  window.childModelSelections = []
  const props = {
    sessionId: 'fixture/main', sessionMissing: false, loading: false, asrAvailable: false,
    modelOptions: [
      { key: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates', label: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates', providerKey: 'provider', modelId: 'a-very-long-current-model-label-that-needs-room-before-it-truncates' },
      { key: 'provider/secondary', label: 'provider/secondary', providerKey: 'provider', modelId: 'secondary' },
    ],
    currentModelKey: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates',
    sessionModel: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates',
    defaultModelKey: 'default/model',
    childModelDefault: 'provider/an-equally-long-child-model-label-that-must-not-overflow',
    effectiveChildModelKey: 'provider/an-equally-long-child-model-label-that-must-not-overflow',
    effectiveEffort: 'xhigh', effectiveChildEffort: 'medium',
    onChangeModel: async model => { window.modelSelections.push(model) }, onChangeChildModel: async model => { window.childModelSelections.push(model) }, onChangeEffort: noop, onChangeChildEffort: noop,
    onRefreshModels: noop, onOpenModelSettings: () => { window.modelSettingsOpens += 1 }, onSend: async () => false,
    onTranscribeAudio: async () => ({ text: '', status: 200, rawLength: 0, textLength: 0, responsePreview: '' }),
    onCreateStreamingTranscriber: async () => ({ sendAudioChunk() {}, stop() {}, cancel() {} }),
  }
  const detailOptions = [
    { key: 'alpha', label: 'Alpha Custom', providerKey: 'alpha', modelId: 'org/model-a', providerType: 'openai-completions', isVirtual: false, targets: [], allowedEfforts: ['low', 'high'], defaultEffort: 'high' },
    { key: 'beta', label: 'Beta Custom', providerKey: 'beta', modelId: 'org/model-a', providerType: 'anthropic', isVirtual: false, targets: [], allowedEfforts: ['low', 'high'], defaultEffort: 'high' },
    { key: 'unique', label: 'Unique Friendly', providerKey: 'unique', modelId: 'family/unique', providerType: 'openai', isVirtual: false, targets: [], allowedEfforts: ['low', 'high'], defaultEffort: 'high' },
    { key: 'alias', label: 'alias', providerKey: 'alias', modelId: null, providerType: 'session-hash', isVirtual: true, targets: ['alpha/org/model-a'], allowedEfforts: ['low', 'high'], defaultEffort: null },
    { key: 'sticky', label: 'sticky', providerKey: 'sticky', modelId: null, providerType: 'session-hash', isVirtual: true, targets: ['alpha/org/model-a', 'beta/org/model-a'], allowedEfforts: ['low', 'high'], defaultEffort: null },
    { key: 'route', label: 'route', providerKey: 'route', modelId: null, providerType: 'failover', isVirtual: true, targets: ['beta/org/model-a', 'alpha/org/model-a'], allowedEfforts: ['low', 'high'], defaultEffort: null },
  ]
  const root = createRoot(document.getElementById('root'))
  window.renderFixture = (mode = 'default') => {
    window.modelSelections = []
    window.childModelSelections = []
    window.modelSettingsOpens = 0
    const activeProps = mode === 'details'
      ? { ...props, modelOptions: detailOptions, currentModelKey: 'alpha', sessionModel: 'alpha', defaultModelKey: 'alias', childModelDefault: 'beta', effectiveChildModelKey: 'beta', effectiveEffort: 'high', effectiveChildEffort: 'high' }
      : mode === 'short'
        ? { ...props, modelOptions: [{ key: 'master', label: 'master', isVirtual: true }, { key: 'thinker', label: 'thinker', isVirtual: true }], currentModelKey: 'master', sessionModel: 'master', defaultModelKey: 'master', childModelDefault: 'thinker', effectiveChildModelKey: 'thinker', effectiveEffort: 'high', childEffortDefault: 'high', effectiveChildEffort: 'high' }
      : mode === 'no-child'
        ? { ...props, childModelDefault: null, effectiveChildModelKey: null }
        : props
    root.render(<div id="host" style={{ width: '900px', maxWidth: '100%' }}><ChatComposer {...activeProps} /></div>)
  }
  window.renderFixture()
  window.setHostWidth = width => { document.getElementById('host').style.width = width + 'px' }
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: webuiReactAliases,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent',
  })
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the model trigger browser test')
  const css = await readFile(path.join(assetsDirectory, cssAsset), 'utf8')
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(path.join(outputDirectory, 'fixture.js'))); return }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><head><style>:root { --foxwarm-color-hover: rgb(230 232 236); }</style><style>${css}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

test('model trigger grows to 30rem for long current and child labels', async () => {
  const geometry = await page.$eval('.foxwarm-model-selector-root', node => ({ width: node.getBoundingClientRect().width, maxWidth: getComputedStyle(node).maxWidth }))
  assert.equal(geometry.maxWidth, '480px')
  assert.ok(geometry.width > 304 && geometry.width <= 480, JSON.stringify(geometry))
})

test('short current and child model names with child effort fit when composer has room', async () => {
  await page.setViewport({ width: 1000, height: 700 })
  await page.evaluate(() => {
    document.getElementById('host').style.fontFamily = 'monospace'
    window.renderFixture('short')
  })
  await page.waitForFunction(() => document.querySelector('[data-model-trigger-child="true"]')?.textContent?.includes('thinker · High'))
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-model-selector-root')
    const button = root.querySelector('.foxwarm-model-selector-trigger')
    const currentName = button.querySelector('[data-model-trigger-name="true"]')
    const child = button.querySelector('[data-model-trigger-child="true"]')
    const childText = child.querySelector('span')
    const send = document.querySelector('button[type="submit"]')
    const r = element => { const bounds = element.getBoundingClientRect(); return { width: bounds.width, left: bounds.left, right: bounds.right } }
    return {
      root: r(root), button: r(button), currentName: r(currentName), child: r(child), send: r(send),
      childMaxWidth: getComputedStyle(child).maxWidth,
      childTextScrollWidth: childText.scrollWidth, childTextClientWidth: childText.clientWidth,
      childText: childText.textContent,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
    }
  })
  assert.equal(geometry.currentName.width > 0, true, JSON.stringify(geometry))
  assert.equal(geometry.childText, 'thinker · High')
  assert.ok(geometry.root.right - geometry.button.right > 0, JSON.stringify(geometry))
  assert.ok(geometry.childTextScrollWidth <= geometry.childTextClientWidth + 1, JSON.stringify(geometry))
  assert.ok(geometry.send.right <= 1000 && geometry.documentOverflow <= 0, JSON.stringify(geometry))
})

test('model trigger shrinks and ellipsizes without horizontal overflow in a narrow composer', async () => {
  await page.evaluate(() => {
    document.getElementById('host').style.fontFamily = ''
    window.renderFixture()
  })
  await page.waitForFunction(() => document.querySelector('[data-model-trigger-name="true"]')?.textContent?.includes('a-very-long-current-model'))
  await page.setViewport({ width: 360, height: 700 })
  await page.evaluate(() => { document.getElementById('host').style.width = '100%' })
  const geometry = await page.evaluate(() => {
    const host = document.getElementById('host').getBoundingClientRect()
    const root = document.querySelector('.foxwarm-model-selector-root').getBoundingClientRect()
    const trigger = document.querySelector('.foxwarm-model-selector-trigger')
    const labels = [...trigger.querySelectorAll('.truncate')]
    return {
      hostRight: host.right, rootRight: root.right, rootWidth: root.width,
      triggerClientWidth: trigger.clientWidth, triggerScrollWidth: trigger.scrollWidth,
      labelClipped: labels.some(label => label.scrollWidth > label.clientWidth),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sendVisible: !!document.querySelector('button[type="submit"]'),
    }
  })
  assert.ok(geometry.rootRight <= geometry.hostRight + 0.5, JSON.stringify(geometry))
  assert.ok(geometry.rootWidth <= 300, JSON.stringify(geometry))
  assert.equal(geometry.labelClipped, true)
  assert.ok(geometry.documentOverflow <= 0, JSON.stringify(geometry))
  assert.equal(geometry.sendVisible, true)
  await page.click('[data-model-trigger-child="true"]')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  assert.equal(await page.$$eval('[data-model-column]', columns => columns.length), 2)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-model-selector-trigger')), true)
})

test('model popup is fixed before first paint and preserves page and composer scroll on first and remounted opens', async () => {
  const openAndReadSamples = async () => {
    const baseline = await page.evaluate(() => {
      const shell = document.getElementById('long-chat-shell')
      window.__popupMountSamples = []
      const readScroll = () => ({
        scrollY,
        htmlScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        bodyScrollHeight: document.body.scrollHeight,
        shellScrollTop: shell?.scrollTop || 0,
      })
      const record = (phase) => {
        const popup = document.querySelector('[data-model-selector-popup="true"]')
        if (!popup) return
        const rect = popup.getBoundingClientRect()
        const configure = popup.querySelector('button[aria-label="Configure models"]')
        const configureRect = configure?.getBoundingClientRect()
        const configureHit = configureRect
          ? document.elementFromPoint(configureRect.left + configureRect.width / 2, configureRect.top + configureRect.height / 2)
          : null
        window.__popupMountSamples.push({
          phase,
          position: getComputedStyle(popup).position,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          configureVisible: configure?.checkVisibility() || false,
          configureHit: !!configure && (configureHit === configure || configure.contains(configureHit)),
          ...readScroll(),
        })
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-model-selector-popup="true"]')) return
        record('mutation')
        requestAnimationFrame(() => {
          record('raf1')
          requestAnimationFrame(() => record('raf2'))
        })
        observer.disconnect()
      })
      observer.observe(document.body, { childList: true })
      return readScroll()
    })
    await page.click('button[aria-haspopup="dialog"]')
    await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
    const result = await page.evaluate(() => {
      const configure = document.querySelector('button[aria-label="Configure models"]')
      const rect = configure?.getBoundingClientRect()
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
      return {
        samples: window.__popupMountSamples,
        configureVisible: configure?.checkVisibility() || false,
        configureHit: !!configure && (hit === configure || configure.contains(hit)),
      }
    })
    assert.ok(result.samples.length >= 3, JSON.stringify(result))
    for (const sample of result.samples) {
      assert.equal(sample.position, 'fixed', JSON.stringify(sample))
      assert.equal(sample.scrollY, baseline.scrollY, JSON.stringify(sample))
      assert.equal(sample.htmlScrollTop, baseline.htmlScrollTop, JSON.stringify(sample))
      assert.equal(sample.bodyScrollTop, baseline.bodyScrollTop, JSON.stringify(sample))
      assert.equal(sample.bodyScrollHeight, baseline.bodyScrollHeight, JSON.stringify(sample))
      assert.equal(sample.shellScrollTop, baseline.shellScrollTop, JSON.stringify(sample))
      assert.ok(sample.rect.x >= 0 && sample.rect.y >= 0 && sample.rect.right <= sample.viewportWidth && sample.rect.bottom <= sample.viewportHeight, JSON.stringify(sample))
      assert.equal(sample.configureVisible, true, JSON.stringify(sample))
      assert.equal(sample.configureHit, true, JSON.stringify(sample))
    }
    assert.equal(result.configureVisible, true)
    assert.equal(result.configureHit, true)
  }

  await page.setViewport({ width: 1000, height: 700 })
  await page.evaluate(() => {
    document.getElementById('host').style.width = '900px'
    document.body.style.margin = '0'
    window.scrollTo(0, 0)
  })
  await openAndReadSamples()
  await page.click('button[aria-label="Configure models"]')
  assert.equal(await page.evaluate(() => window.modelSettingsOpens), 1)

  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await page.setViewport({ width: 390, height: 700 })
  await page.evaluate(() => {
    document.body.style.margin = '0'
    const root = document.getElementById('root')
    const shell = document.createElement('div')
    shell.id = 'long-chat-shell'
    shell.style.cssText = 'height:620px;overflow:auto;'
    const spacer = document.createElement('div')
    spacer.style.height = '900px'
    root.before(shell)
    shell.append(spacer, root)
    document.getElementById('host').style.width = '100%'
    shell.scrollTop = shell.scrollHeight
  })
  await openAndReadSamples()
  await page.click('button[aria-label="Configure models"]')
  assert.equal(await page.evaluate(() => window.modelSettingsOpens), 1)
  await page.click('button[aria-haspopup="dialog"]')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  await page.click('[data-model-option-key="provider/secondary"]')
  assert.deepEqual(await page.evaluate(() => window.modelSelections), ['provider/secondary'])
})

test('model picker disambiguates duplicate concrete ids and describes virtual routing in both columns', async () => {
  await page.reload({ waitUntil: 'load' })
  await page.setViewport({ width: 1100, height: 760 })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await page.evaluate(() => window.renderFixture('details'))
  await page.waitForFunction(() => document.querySelector('[data-model-trigger-name="true"]')?.textContent?.trim() === 'alpha/Alpha Custom')
  await page.waitForFunction(() => document.querySelector('[data-model-trigger-child="true"]')?.textContent?.includes('beta/Beta Custom'))

  await page.click('button[aria-haspopup="dialog"]')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  const details = await page.evaluate(() => {
    const read = (scope, key) => {
      const row = document.querySelector(`[data-model-column="${scope}"] [data-model-option-key="${key}"]`)
      const target = row?.querySelector('[data-model-option-target="true"]')
      return { text: target?.textContent || null, title: target?.getAttribute('title') || null }
    }
    return {
      currentName: document.querySelector('[data-model-trigger-name="true"]')?.textContent?.trim(),
      childName: document.querySelector('[data-model-trigger-child="true"]')?.textContent?.trim(),
      currentAlias: read('current', 'alias'),
      childAlias: read('child', 'alias'),
      currentSticky: read('current', 'sticky'),
      childSticky: read('child', 'sticky'),
      currentRoute: read('current', 'route'),
      childRoute: read('child', 'route'),
      concreteDetailCount: document.querySelectorAll('[data-model-option-key="alpha"] [data-model-option-target="true"]').length,
    }
  })
  assert.equal(details.currentName, 'alpha/Alpha Custom')
  assert.ok(details.childName?.includes('beta/Beta Custom'))
  assert.deepEqual(details.currentAlias, { text: 'alpha/org/model-a', title: 'alpha/org/model-a' })
  assert.deepEqual(details.childAlias, details.currentAlias)
  assert.deepEqual(details.currentSticky, { text: 'session-hash: alpha/org/model-a, beta/org/model-a', title: 'session-hash: alpha/org/model-a, beta/org/model-a' })
  assert.deepEqual(details.childSticky, details.currentSticky)
  assert.deepEqual(details.currentRoute, { text: 'failover: beta/org/model-a, alpha/org/model-a', title: 'failover: beta/org/model-a, alpha/org/model-a' })
  assert.deepEqual(details.childRoute, details.currentRoute)
  assert.equal(details.concreteDetailCount, 0)

  await page.type('input[aria-label="Filter models"]', 'Beta Custom')
  await page.waitForFunction(() => (
    !!document.querySelector('[data-model-column="current"] [data-model-option-key="beta"]')
    && !document.querySelector('[data-model-column="current"] [data-model-option-key="alpha"]')
  ))
  assert.equal((await page.$eval('[data-model-trigger-name="true"]', element => element.textContent || '')).trim(), 'alpha/Alpha Custom')
  await page.click('[data-model-column="current"] [data-model-option-key="beta"]')
  assert.deepEqual(await page.evaluate(() => window.modelSelections), ['beta'])
})

test('current and child summary share one hover, focus, and keyboard-operable picker trigger', async () => {
  await page.reload({ waitUntil: 'load' })
  await page.setViewport({ width: 1000, height: 700 })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await page.evaluate(() => window.renderFixture('details'))
  await page.waitForFunction(() => document.querySelector('[data-model-trigger-child="true"]')?.textContent?.includes('beta/Beta Custom'))

  const layout = await page.evaluate(() => {
    const button = document.querySelector('.foxwarm-model-selector-trigger')
    const label = button.querySelector('[data-model-trigger-name="true"]')
    const effort = button.querySelector('[data-model-trigger-effort="true"]')
    const child = button.querySelector('[data-model-trigger-child="true"]')
    const rect = element => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
    return {
      buttons: document.querySelectorAll('.foxwarm-model-selector-root button[aria-haspopup="dialog"]').length,
      childIsButton: child instanceof HTMLButtonElement,
      button: rect(button), label: rect(label), effort: rect(effort), child: rect(child),
    }
  })
  assert.equal(layout.buttons, 1)
  assert.equal(layout.childIsButton, false)
  assert.ok(layout.child.x > layout.effort.x + layout.effort.width, JSON.stringify(layout))

  const hoverAt = async (x, y) => {
    await page.mouse.move(x, y)
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)))
    return page.evaluate(({ x: px, y: py }) => {
      const button = document.querySelector('.foxwarm-model-selector-trigger')
      return {
        background: getComputedStyle(button).backgroundColor,
        hovered: button.matches(':hover'),
        hit: document.elementFromPoint(px, py)?.closest('button') === button,
      }
    }, { x, y })
  }
  const centerY = layout.button.y + layout.button.height / 2
  const outside = await hoverAt(2, 2)
  const mainHover = await hoverAt(layout.label.x + layout.label.width / 2, centerY)
  const gapHover = await hoverAt((layout.effort.x + layout.effort.width + layout.child.x) / 2, centerY)
  const childHover = await hoverAt(layout.child.x + layout.child.width / 2, centerY)
  assert.equal(mainHover.hovered, true)
  assert.equal(gapHover.hovered, true)
  assert.equal(childHover.hovered, true)
  assert.equal(mainHover.hit, true)
  assert.equal(gapHover.hit, true)
  assert.equal(childHover.hit, true)
  assert.notEqual(mainHover.background, outside.background)
  assert.equal(mainHover.background, gapHover.background)
  assert.equal(mainHover.background, childHover.background)

  await page.mouse.click(layout.child.x + layout.child.width / 2, centerY)
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  assert.equal(await page.$$eval('[data-model-column]', columns => columns.length), 2)
  await page.mouse.click(layout.child.x + layout.child.width / 2, centerY)
  await page.waitForSelector('[data-model-selector-popup="true"]', { hidden: true })
  await page.focus('.foxwarm-model-selector-trigger')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.foxwarm-model-selector-root') !== null), false)

  await page.focus('.foxwarm-model-selector-trigger')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-model-selector-popup="true"]', { hidden: true })
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-model-selector-trigger')), true)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  await page.click('[data-model-column="child"] [data-model-option-key="route"]')
  assert.deepEqual(await page.evaluate(() => window.childModelSelections), ['route'])
  assert.deepEqual(await page.evaluate(() => window.modelSelections), [])
  await page.click('[data-model-column="current"] [data-model-option-key="unique"]')
  assert.deepEqual(await page.evaluate(() => window.modelSelections), ['unique'])
  assert.ok(await page.$('input[type="range"][aria-label="Child effort"]'))
  assert.ok(await page.$('input[type="range"][aria-label="Current effort"]'))
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-model-selector-trigger')), true)
})

test('without a configured child the trigger stays compact and the popup has only the current column', async () => {
  await page.reload({ waitUntil: 'load' })
  await page.setViewport({ width: 390, height: 700 })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
  await page.evaluate(() => window.renderFixture('no-child'))
  await page.waitForFunction(() => !document.querySelector('[data-model-trigger-child="true"]'))
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('.foxwarm-model-selector-trigger')
    const bounds = button.getBoundingClientRect()
    return { width: bounds.width, viewportOverflow: document.documentElement.scrollWidth - innerWidth }
  })
  assert.ok(geometry.width > 0 && geometry.width <= 390, JSON.stringify(geometry))
  assert.ok(geometry.viewportOverflow <= 0, JSON.stringify(geometry))
  await page.click('.foxwarm-model-selector-trigger')
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  assert.equal(await page.$$eval('[data-model-column]', columns => columns.length), 1)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.foxwarm-model-selector-trigger')), true)
})
