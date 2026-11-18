import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { createHostFixture } from './mainHostFixture.mjs'

const title = '.monaco-workbench .part.titlebar'
const browserOptions = {
  executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
}
const viewport = { width: 1150, height: 720 }
const windows = { platform: 'windows', left: 0, right: 138, top: 32, state: [] }
const macos = { platform: 'macos', left: 80, right: 0, top: 38, state: [] }

function installProvider(frame, late = false) {
  window.frameReports = []
  const channel = { postMessage: message => window.frameReports.push(message) }
  if (frame.platform === 'windows') {
    Object.defineProperty(window, 'chrome', { value: { ...window.chrome, webview: channel } })
  } else {
    window.webkit = { messageHandlers: { foxwarmFrame: channel } }
  }
  if (!late) window.foxwarmFrame = frame
}

const intersects = ([x, y, w, h], rect) =>
  Math.min(x + w, rect.right) > Math.max(x, rect.left) && Math.min(y + h, rect.bottom) > Math.max(y, rect.top)

async function snapshot(page, selector = title) {
  return page.$eval(selector, bar => {
    const rect = element => element?.getBoundingClientRect().toJSON()
    const overlay = navigator.windowControlsOverlay
    return {
      bar: rect(bar), visible: overlay?.visible ?? false,
      overlay: overlay?.getTitlebarAreaRect()?.toJSON(),
      left: rect(bar.querySelector('.titlebar-left .window-controls-container')),
      right: rect(bar.querySelector('.titlebar-right .window-controls-container')),
      wco: bar.querySelectorAll('.wco-enabled').length,
      adapted: document.documentElement.dataset.foxwarmCodeFrame,
      controls: [...bar.querySelectorAll('.menubar, .command-center, .action-item, [role="button"]')]
        .filter(element => getComputedStyle(element).visibility !== 'hidden')
        .map(rect).filter(box => box.width && box.height),
      report: window.frameReports?.at(-1),
    }
  })
}

function checkLayout(state, frame) {
  assert.equal(state.visible, true)
  assert.equal(state.adapted, frame.platform)
  assert.equal(state.wco, 2)
  assert.deepEqual([state.overlay.x, state.overlay.width, state.overlay.height],
    [frame.left, viewport.width - frame.left - frame.right, frame.top])
  assert.deepEqual([state.left.left, state.left.width, state.right.right, state.right.width],
    [0, frame.left, viewport.width, frame.right])
  assert.equal(state.bar.height, Math.max(35, frame.top))
  assert.ok(state.report.regions.length > 0, 'there is a usable drag surface')
  assert.ok(state.controls.length >= 3, 'menu, command center and layout controls are present')
  for (const rect of state.controls) {
    assert.ok(rect.left >= frame.left && rect.right <= viewport.width - frame.right,
      `title-bar control crosses a reserved area: ${JSON.stringify(rect)}`)
    assert.ok(!state.report.regions.some(region => intersects(region, rect)),
      `reported native drag covers a control: ${JSON.stringify(rect)}`)
  }
}

test('adapter subtracts fractional controls and floating layers, follows geometry and theme, and deduplicates', async () => {
  const source = await readFile(new URL('../../../dotnet/Foxwarm/Code/workbenchFrame.js', import.meta.url), 'utf8')
  const browser = await puppeteer.launch(browserOptions)
  try {
    const page = await browser.newPage()
    await page.setViewport(viewport)
    await page.setContent(`<body style="margin:0"><div class="monaco-workbench web vs"><div class="part titlebar">
      <div class="titlebar-drag-region" style="height:35px"></div>
      <button style="position:absolute;top:5px;left:32.5px;width:60px;height:22px">Test</button>
    </div></div>`)
    await page.evaluate(installProvider, windows, true)
    await page.addScriptTag({ content: source })
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmCodeFrame), undefined)
    await page.evaluate(frame => {
      window.foxwarmFrame = frame
      window.dispatchEvent(new Event('foxwarm-frame'))
      navigator.windowControlsOverlay.addEventListener('geometrychange', event => {
        window.geometry = [event.visible, event.titlebarAreaRect.toJSON()]
      })
    }, windows)
    await page.waitForFunction(() => window.frameReports.length === 1)
    const original = await snapshot(page)
    assert.deepEqual(Object.keys(original.report), ['type', 'regions', 'colorScheme'])
    assert.equal(original.report.type, 'frame-regions')
    assert.equal(original.report.colorScheme, 'light')
    const button = await page.$eval('button', element => element.getBoundingClientRect().toJSON())
    assert.ok(original.report.regions.every(region => !intersects(region, button)))
    await page.evaluate(() => {
      const floating = document.createElement('div')
      floating.className = 'quick-input-widget'
      floating.style = 'position:fixed;top:8px;left:200px;width:300px;height:200px'
      document.body.append(floating)
      document.querySelector('.monaco-workbench').classList.replace('vs', 'vs-dark')
    })
    await page.waitForFunction(() => window.frameReports.at(-1)?.colorScheme === 'dark')
    const floating = await page.$eval('.quick-input-widget', element => element.getBoundingClientRect().toJSON())
    assert.ok((await snapshot(page)).report.regions.every(region => !intersects(region, floating)))
    assert.equal(await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('foxwarm-frame'))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return window.frameReports.length
    }), 2)
    await page.evaluate(() => {
      window.foxwarmFrame = { ...window.foxwarmFrame, right: 0, top: 0, state: ['fullscreen'] }
      window.dispatchEvent(new Event('foxwarm-frame'))
    })
    await page.waitForFunction(() => window.frameReports.at(-1)?.regions.length === 0)
    assert.equal(await page.evaluate(() => window.geometry[0]), false)
  } finally { await browser.close() }
})

test('the served bundled workbench uses Code’s own WCO layout only with a top-level Desktop provider', async () => {
  const host = await createHostFixture('code-window-frame')
  let browser
  try {
    await host.start()
    browser = await puppeteer.launch(browserOptions)
    const url = host.origin + '/vscode-web/?nodeId=master'
    const open = async (os, provider, late = false) => {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      await page.setViewport(viewport)
      await context.setCookie({ name: 'foxwarm_token', value: host.token, url: host.origin })
      await page.evaluateOnNewDocument(platform => {
        const ua = navigator.userAgent.replace('X11; Linux x86_64', platform === 'macos'
          ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64')
        Object.defineProperty(navigator, 'userAgent', { value: ua })
      }, os)
      if (provider) await page.evaluateOnNewDocument(installProvider, provider, late)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
      assert.equal(response.status(), 200, 'prepared Code OSS assets are required')
      await page.waitForSelector(`${title} .command-center`, { visible: true })
      return page
    }
    const workspace = join(host.data, 'state/vscode-web/node-master.code-workspace')
    const theme = name => writeFile(workspace, JSON.stringify({ folders: [], settings: { 'workbench.colorTheme': name } }))
    await mkdir(join(host.data, 'state/vscode-web'), { recursive: true })
    await theme('Light Modern')
    const baseline = await open('windows')
    const ordinary = await snapshot(baseline)
    assert.deepEqual([ordinary.adapted, ordinary.visible, ordinary.wco, ordinary.report], [undefined, false, 0, undefined])

    const win = await open('windows', windows, true)
    assert.equal((await snapshot(win)).adapted, undefined)
    await win.evaluate(frame => {
      window.foxwarmFrame = frame
      window.dispatchEvent(new Event('foxwarm-frame'))
    }, windows)
    await win.waitForFunction(() => window.frameReports.length > 0)
    await win.waitForFunction(() => document.querySelector('.monaco-workbench.vs') && window.frameReports.at(-1)?.colorScheme === 'light')
    checkLayout(await snapshot(win), windows)

    const menu = `${title} .menubar-menu-button`
    await win.click(menu)
    await win.waitForSelector('.menubar-menu-items-holder', { visible: true })
    const menuRect = await win.$eval('.menubar-menu-items-holder', element => element.getBoundingClientRect().toJSON())
    assert.ok((await snapshot(win)).report.regions.every(region => !intersects(region, menuRect)))
    await win.keyboard.press('Escape')
    await win.click(`${title} .command-center-quick-pick`)
    await win.waitForSelector('.quick-input-widget input', { visible: true })
    await win.keyboard.press('Escape')

    await theme('Dark Modern')
    const mac = await open('macos', macos)
    await mac.waitForFunction(() => window.frameReports.length > 0)
    await mac.waitForFunction(() => document.querySelector('.monaco-workbench.vs-dark') && window.frameReports.at(-1)?.colorScheme === 'dark')
    checkLayout(await snapshot(mac), macos)

    // Deliberately inject into the child too: the adapter must refuse even that provider.
    await theme('Light Modern')
    const parent = await open('windows', windows)
    await parent.setContent('<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>' +
      `<iframe src="${url}"></iframe>`)
    const iframe = await (await parent.waitForSelector('iframe')).contentFrame()
    assert.ok(iframe)
    await iframe.waitForSelector(`${title} .command-center`, { visible: true })
    const child = await snapshot(iframe)
    assert.deepEqual(child, ordinary)
    assert.deepEqual(await iframe.evaluate(() => window.frameReports), [])
  } finally {
    if (browser) await browser.close()
    await host.cleanup()
  }
})
