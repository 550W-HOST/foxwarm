// The document must never scroll: the app shell is exactly the viewport tall, in the
// ordinary layout and in the Desktop window-frame layout, at every size and display scale.
//
// Overlay scrollbars and --hide-scrollbars hide a stray document scrollbar, so the
// scroller is measured directly (scroll range, scrollHeight/clientHeight and the width a
// classic scrollbar would take from the viewport), never by looking at pixels.
//
// A window whose pixel size isn't a multiple of the device scale (125 % display scaling,
// 110 % browser zoom) has a fractional visual viewport. Emulated viewports are integer
// CSS px, so that case is covered with real windows under --force-device-scale-factor.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const webui = resolve(import.meta.dirname, '..')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
const WORKBENCH_KEY = (await readFile(join(webui, 'src/workbench/store.ts'), 'utf8')).match(/WORKBENCH_STATE_STORAGE_KEY = '([^']+)'/)[1]
const COLLAPSED_KEY = (await readFile(join(webui, 'src/App.tsx'), 'utf8')).match(/SIDEBAR_COLLAPSED_STORAGE_KEY = '([^']+)'/)[1]
const executablePath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'

const WINDOWS_FRAME = { platform: 'windows', left: 0, right: 138, top: 32 }
const hosts = { ordinary: null, frame: WINDOWS_FRAME }
const chat = id => ({ id: `chat:${id}`, type: 'chat', title: id.split('/').pop(), sessionId: id })
const tabs = ['tidepool/proration-v2', 'tidepool/release'].map(chat)
const workbench = { tabs, root: { id: 'p1', kind: 'pane', tabIds: tabs.map(t => t.id), activeTabId: tabs[0].id, collapsed: false } }

let demo, server, base

test.before(async () => {
  if (process.env.FOXWARM_DEMO_DIST) demo = { dir: resolve(process.env.FOXWARM_DEMO_DIST), owned: false }
  else {
    const dir = await mkdtemp(join(tmpdir(), 'fw-document-overflow-demo-'))
    const result = spawnSync(process.execPath, [join(webui, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.demo.config.ts', '--configLoader', 'runner', '--logLevel', 'error'], {
      cwd: webui, env: { ...process.env, FOXWARM_DEMO_OUT_DIR: dir }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, `demo build failed:\n${result.stdout}\n${result.stderr}`)
    demo = { dir, owned: true }
  }
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/demo/')) { res.writeHead(404); res.end(); return }
    let file = normalize(join(demo.dir, url.pathname.slice('/demo/'.length)))
    if (!file.startsWith(demo.dir)) { res.writeHead(403); res.end(); return }
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html') } catch {}
    try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(body) } catch { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}/demo/`
})

test.after(async () => {
  server?.close()
  if (demo?.owned) await rm(demo.dir, { recursive: true, force: true })
})

const launch = (...args) => puppeteer.launch({
  executablePath, headless: true, defaultViewport: null,
  // Headless hides scrollbars by default; classic ones also show up as lost viewport width.
  ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox', '--disable-setuid-sandbox', ...args],
})

async function openPage(browser, { host, collapsed }) {
  const page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.evaluateOnNewDocument((storage, host) => {
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value)
    if (host) {
      window.chrome = { webview: { postMessage() {} } }
      window.foxwarmFrame = host
    }
  }, {
    [WORKBENCH_KEY]: JSON.stringify({ state: { version: 4, tabsById: Object.fromEntries(workbench.tabs.map(t => [t.id, t])), root: workbench.root, focusedPaneId: 'p1' }, version: 1 }),
    [COLLAPSED_KEY]: String(collapsed),
  }, host)
  await page.goto(base, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-foxwarm-boot-ready') && !document.getElementById('foxwarm-boot'))
  return page
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))))

/** The document scroller's overflow, measured without looking at scrollbars. */
async function measure(page) {
  await settle(page)
  return page.evaluate(() => {
    const scroller = document.scrollingElement
    const before = scroller.scrollTop
    scroller.scrollTop = 1e6
    const scrollRangeY = scroller.scrollTop - before
    scroller.scrollTop = before
    const root = document.documentElement
    return {
      inner: [innerWidth, innerHeight],
      visualHeight: visualViewport.height,
      appHeight: root.style.getPropertyValue('--foxwarm-app-height'),
      frame: root.dataset.foxwarmFrame || null,
      scrollRangeY,
      overflowY: scroller.scrollHeight - scroller.clientHeight,
      overflowX: scroller.scrollWidth - scroller.clientWidth,
      // A classic scrollbar takes its width from the viewport.
      scrollbarWidth: innerWidth - root.clientWidth,
      scrollbarHeight: innerHeight - root.clientHeight,
    }
  })
}

function assertFlat(m, label, host) {
  if (host) assert.equal(m.frame, 'windows', `${label}: the frame layout is active`)
  else assert.equal(m.frame, null, `${label}: the ordinary layout is active`)
  assert.deepEqual({ y: m.scrollRangeY, oy: m.overflowY, ox: m.overflowX, sw: m.scrollbarWidth, sh: m.scrollbarHeight }, { y: 0, oy: 0, ox: 0, sw: 0, sh: 0 },
    `${label}: the document doesn't scroll (${JSON.stringify(m)})`)
}

for (const [name, host] of Object.entries(hosts)) {
  for (const collapsed of [false, true]) {
    test(`${name} layout${collapsed ? ' with the sidebar collapsed' : ''}: the document doesn't overflow at common sizes and scales`, async () => {
      const browser = await launch()
      try {
        const page = await openPage(browser, { host, collapsed })
        for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
          for (const [width, height] of [[1261, 810], [1280, 800], [1366, 768], [1024, 768], [800, 600], [700, 600], [390, 844]]) {
            await page.setViewport({ width, height, deviceScaleFactor })
            assertFlat(await measure(page), `${width}x${height} @${deviceScaleFactor}`, host)
          }
        }
      } finally {
        await browser.close()
      }
    })
  }

  // Real windows: the pixel size is the window's, so the CSS viewport is fractional.
  for (const scale of [1.25, 1.5, 1.75]) {
    test(`${name} layout: the document doesn't overflow in windows with a fractional viewport at ${scale * 100}% display scale`, async () => {
      const browser = await launch(`--force-device-scale-factor=${scale}`, '--window-size=1261,810')
      try {
        const page = await openPage(browser, { host, collapsed: false })
        const cdp = await page.createCDPSession()
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        const samples = []
        for (let height = 800; height <= 830; height++) {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1261, height } })
          const m = await measure(page)
          samples.push(m)
          assertFlat(m, `window height ${height} @${scale} (viewport ${m.inner.join('x')}, visual height ${m.visualHeight})`, host)
        }
        // Guard against a vacuous pass: some window must have a visual viewport that rounds up.
        if (scale === 1.25) assert.ok(samples.some(m => Math.round(m.visualHeight) > m.visualHeight + 0.05), 'the scan includes viewports whose rounded height exceeds the real one')
      } finally {
        await browser.close()
      }
    })
  }
}

test('the shell keeps following the visual viewport when it is not the layout viewport', async () => {
  const browser = await launch()
  try {
    const page = await openPage(browser, { host: null, collapsed: false })
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await settle(page)
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--foxwarm-app-height')), '', 'matching viewports keep the 100dvh default')
    // Pinch zoom shrinks the visual viewport below the layout viewport, as an on-screen keyboard does.
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--foxwarm-app-height') !== '')
    const pinned = await page.evaluate(() => ({ app: document.documentElement.style.getPropertyValue('--foxwarm-app-height'), visual: visualViewport.height }))
    assert.equal(pinned.app, `${Math.round(pinned.visual)}px`)
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--foxwarm-app-height') === '')
  } finally {
    await browser.close()
  }
})
