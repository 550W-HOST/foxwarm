// Window frame in the static demo build: a Desktop host is emulated by injecting
// window.foxwarmFrame and a recording host channel at document start, and the PWA
// window-controls overlay by stubbing its media query and inset variables (headless
// Chromium emulates neither display-mode: window-controls-overlay nor titlebar-area-*).
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

// Tall caption buttons, as measured on a Windows guest at 100 %.
const WINDOWS = { platform: 'windows', left: 0, right: 144, top: 48 }
const MACOS = { platform: 'macos', left: 78, right: 0, top: 38 }

const chat = id => ({ id: `chat:${id}`, type: 'chat', title: id.split('/').pop(), sessionId: id })
const pane = (id, tabs) => ({ id, kind: 'pane', tabIds: tabs.map(t => t.id), activeTabId: tabs[0]?.id ?? null, collapsed: false })
const tabs = ['tidepool/proration-v2', 'tidepool/release', 'tidepool/support'].map(chat)
const layouts = {
  tabs: { tabs, root: pane('p1', tabs) },
  sole: { tabs: tabs.slice(0, 1), root: pane('p1', tabs.slice(0, 1)) },
  split: { tabs, root: { id: 's1', kind: 'split', direction: 'row', sizes: [50, 50], children: [pane('p1', tabs.slice(0, 2)), pane('p2', tabs.slice(2))] } },
}
// Two tabs per pane: a top/bottom split, and row splits by the right pane's share of the workbench width.
const fourTabs = [...tabs, chat('tidepool/billing')]
layouts.column = { tabs: fourTabs, root: { id: 's1', kind: 'split', direction: 'column', sizes: [50, 50], children: [pane('p1', fourTabs.slice(0, 2)), pane('p2', fourTabs.slice(2))] } }
for (const right of [50, 40, 25]) layouts[`split${right}`] = { tabs: fourTabs, root: { id: 's1', kind: 'split', direction: 'row', sizes: [100 - right, right], children: [pane('p1', fourTabs.slice(0, 2)), pane('p2', fourTabs.slice(2))] } }

let demo, server, browser, base

test.before(async () => {
  if (process.env.FOXWARM_DEMO_DIST) demo = { dir: resolve(process.env.FOXWARM_DEMO_DIST), owned: false }
  else {
    const dir = await mkdtemp(join(tmpdir(), 'fw-window-frame-demo-'))
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
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

test.after(async () => {
  await browser?.close()
  server?.close()
  if (demo?.owned) await rm(demo.dir, { recursive: true, force: true })
})

async function open({ width = 1280, height = 800, layout = 'tabs', collapsed = false, host = null, overlay = null, dark = false }) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }])
  const { tabs: layoutTabs, root } = layouts[layout]
  const storage = {
    [WORKBENCH_KEY]: JSON.stringify({ state: { version: 4, tabsById: Object.fromEntries(layoutTabs.map(t => [t.id, t])), root, focusedPaneId: 'p1' }, version: 1 }),
    [COLLAPSED_KEY]: String(collapsed),
  }
  await page.evaluateOnNewDocument((storage, host, overlay) => {
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value)
    window.__frameMessages = []
    if (host) {
      window.chrome = { webview: { postMessage: message => window.__frameMessages.push(JSON.parse(JSON.stringify(message))) } }
      window.foxwarmFrame = host
    }
    if (overlay) {
      const listeners = new Set()
      const query = { matches: true, media: '(display-mode: window-controls-overlay)', addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) }
      const native = window.matchMedia.bind(window)
      window.matchMedia = media => media.includes('window-controls-overlay') ? query : native(media)
      window.__setOverlay = matches => { query.matches = matches; for (const listener of listeners) listener({ matches }) }
      const css = `html[data-foxwarm-frame="overlay"]{--foxwarm-frame-left:${overlay.left}px;--foxwarm-frame-right:${overlay.right}px;--foxwarm-frame-top:${overlay.top}px}`
      document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style) })
    }
  }, storage, host, overlay)
  await page.goto(base, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-foxwarm-boot-ready') && !document.getElementById('foxwarm-boot'))
  await settle(page)
  return { page, errors, close: () => context.close() }
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))))

/** The last reported regions plus every visible interactive element, the zones and key boxes. */
function inspect(page) {
  return page.evaluate(() => {
    const box = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
    const messages = window.__frameMessages
    const last = messages[messages.length - 1] || null
    const root = document.documentElement
    const style = getComputedStyle(root)
    const zones = { left: parseFloat(style.getPropertyValue('--foxwarm-frame-left')) || 0, right: parseFloat(style.getPropertyValue('--foxwarm-frame-right')) || 0, top: parseFloat(style.getPropertyValue('--foxwarm-frame-top')) || 0 }
    // Visible interactive elements: hit-tested where they are not covered by the spacers.
    const mute = document.createElement('style')
    mute.textContent = '.foxwarm-frame-edge, .foxwarm-frame-strip { pointer-events: none !important; }'
    document.head.appendChild(mute)
    const interactive = []
    for (const element of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="button"], [role="menuitem"], [data-tab-id], [tabindex]:not([tabindex="-1"])')) {
      const r = element.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const x = Math.min(Math.max((r.left + r.right) / 2, 0), innerWidth - 1), y = Math.min(Math.max((r.top + r.bottom) / 2, 0), innerHeight - 1)
      const hit = document.elementFromPoint(x, y)
      if (hit && (hit === element || element.contains(hit))) interactive.push({ name: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.tagName).trim().slice(0, 40), ...box(element) })
    }
    mute.remove()
    return {
      frame: root.dataset.foxwarmFrame || null,
      window: root.dataset.foxwarmWindow || null,
      messages: messages.length,
      regions: last?.regions ?? null,
      colorScheme: last?.colorScheme ?? null,
      keys: last ? Object.keys(last).sort() : null,
      zones,
      width: root.clientWidth,
      interactive,
      brand: box(document.querySelector('[data-sidebar-brand]')),
      strip: box(document.querySelector('.foxwarm-frame-strip')),
      fills: document.querySelectorAll('.foxwarm-frame-fill').length,
      safeTop: getComputedStyle(document.querySelector('.foxwarm-safe-area-shell') || root).paddingTop,
    }
  })
}

const overlaps = ([x, y, w, h], r) => Math.min(x + w, r.right) - Math.max(x, r.left) >= 1 && Math.min(y + h, r.bottom) - Math.max(y, r.top) >= 1
const inRegion = (regions, x, y) => regions.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h)

function assertHostContract(info, label) {
  assert.ok(info.regions, `${label}: a frame-regions report`)
  assert.deepEqual(info.keys, ['colorScheme', 'regions', 'type'], `${label}: message schema`)
  assert.ok(info.regions.length > 0 && info.regions.length <= 128)
  assert.ok(info.interactive.length > 10, `${label}: the app rendered its controls`)
  for (const region of info.regions) {
    assert.equal(region.length, 4)
    for (const control of info.interactive) assert.ok(!overlaps(region, control), `${label}: region ${region} covers "${control.name}"`)
  }
  // No visible control sits under the window controls.
  const zoneBoxes = [
    { left: 0, top: 0, right: info.zones.left, bottom: info.zones.top },
    { left: info.width - info.zones.right, top: 0, right: info.width, bottom: info.zones.top },
  ].filter(zone => zone.right > zone.left && zone.bottom > zone.top)
  for (const zone of zoneBoxes) for (const control of info.interactive) {
    assert.ok(!(Math.min(zone.right, control.right) - Math.max(zone.left, control.left) >= 1 && Math.min(zone.bottom, control.bottom) - Math.max(zone.top, control.top) >= 1), `${label}: "${control.name}" under the window controls`)
  }
}

test('without a frame provider nothing is installed or changed', async () => {
  for (const width of [1280, 390]) {
    const { page, errors, close } = await open({ width })
    try {
      const state = await page.evaluate(() => ({
        frame: document.documentElement.dataset.foxwarmFrame ?? null,
        narrow: document.documentElement.hasAttribute('data-foxwarm-frame-narrow'),
        fills: !!document.querySelector('.foxwarm-frame-fills'),
        strip: !!document.querySelector('.foxwarm-frame-strip'),
        inBand: document.querySelectorAll('[data-frame-in-band]').length,
        rowVars: [...document.querySelectorAll('[data-frame-row]')].filter(row => row.style.length).length,
        edges: [...document.querySelectorAll('.foxwarm-frame-edge')].map(edge => getComputedStyle(edge).display).filter(display => display !== 'none').length,
        appRegion: [...document.querySelectorAll('[data-frame-drag]')].map(el => getComputedStyle(el).appRegion).filter(value => value && value !== 'none').length,
        corner: document.querySelectorAll('.foxwarm-frame-corner, [data-frame-corner], [data-frame-corner-pane], [data-frame-banded]').length,
        stack: [...document.querySelectorAll('[data-frame-row="stack"]')].map(row => getComputedStyle(row).paddingTop),
        messages: window.__frameMessages.length,
      }))
      assert.deepEqual(state, { frame: null, narrow: false, fills: false, strip: false, inBand: 0, rowVars: 0, edges: 0, appRegion: 0, corner: 0, stack: width < 768 ? [] : ['0px'], messages: 0 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  }
  const manifest = JSON.parse(await readFile(join(webui, 'public/manifest.json'), 'utf8'))
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.display_override, ['window-controls-overlay'])
})

test('Windows host: title rows clear the caption buttons and drag surfaces reach the window edges', async () => {
  for (const collapsed of [false, true]) {
    const { page, errors, close } = await open({ host: WINDOWS, collapsed })
    try {
      const info = await inspect(page)
      assert.equal(info.frame, 'windows')
      assert.equal(info.colorScheme, 'light')
      assertHostContract(info, `windows collapsed=${collapsed}`)
      const gapRight = info.width - WINDOWS.right
      // The 40 px gap beside the caption buttons drags, through the top gutter and up to the buttons.
      assert.ok(inRegion(info.regions, gapRight - 20, 0) && inRegion(info.regions, gapRight - 20, 30), 'gap beside the caption buttons')
      assert.ok(inRegion(info.regions, info.width - 1, 40), 'gap extends to the right window edge')
      if (!collapsed) {
        // Brand row: through the shell gutter and panel padding to the top and left edges.
        const middle = Math.round((info.brand.top + info.brand.bottom) / 2)
        for (const [x, y] of [[0, 0], [0, middle], [Math.round(info.brand.left) + 4, 0], [Math.round(info.brand.left) + 4, middle]]) assert.ok(inRegion(info.regions, x, y), `brand row drag at ${x},${y}`)
      } else {
        // Rail top above the expand button.
        assert.ok(inRegion(info.regions, 0, 0) && inRegion(info.regions, 24, 10), 'rail top')
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  }
})

/** Geometry of the Windows corner: the inline rows, their panes, the painted corner pieces and the strip contents. */
function cornerState(page) {
  return page.evaluate(() => {
    const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
    const mid = element => { const r = element.getBoundingClientRect(); return (r.top + r.bottom) / 2 }
    const rows = [...document.querySelectorAll('[data-frame-row="inline"]')].map(row => {
      const pane = row.closest('.foxwarm-workbench-panel')
      const paneStyle = pane && getComputedStyle(pane)
      const tabs = [...row.querySelectorAll('[data-tab-id]')]
      return {
        pane: pane?.dataset.paneId ?? null,
        corner: row.getAttribute('data-frame-corner'),
        banded: row.hasAttribute('data-frame-banded'),
        cornerPane: !!pane?.hasAttribute('data-frame-corner-pane'),
        box: box(row),
        paneBox: pane ? box(pane) : null,
        paneTop: paneStyle ? { border: paneStyle.borderTopWidth, left: paneStyle.borderTopLeftRadius, right: paneStyle.borderTopRightRadius } : null,
        background: getComputedStyle(row).backgroundColor,
        padRight: parseFloat(row.style.getPropertyValue('--foxwarm-frame-pad-right')) || 0,
        tabs: tabs.map(tab => ({ ...box(tab), label: mid(tab.querySelector('span') || tab) })),
        controls: [...row.querySelectorAll('.foxwarm-workbench-tab-toolbar button')].map(button => ({ ...box(button), mid: mid(button) })),
      }
    })
    const pieces = [...document.querySelectorAll('.foxwarm-frame-corner > *')].map(piece => ({ ...box(piece), edge: piece.dataset.frameCornerEdge, background: getComputedStyle(piece).backgroundColor }))
    return { rows, pieces, width: document.documentElement.clientWidth }
  })
}

/** The corner row reaches the window's top and right edges: square pane corners and painted gutters in the row's colour. */
function assertFlushCorner(state, row, label) {
  assert.ok(row.cornerPane, `${label}: corner pane marked`)
  assert.deepEqual(row.paneTop, { border: '0px', left: '0px', right: '0px' }, `${label}: pane top edge`)
  const top = state.pieces.find(piece => piece.edge === 'left')
  const right = state.pieces.find(piece => piece.edge === 'bottom')
  assert.ok(top && right, `${label}: corner pieces`)
  assert.deepEqual([top.left, top.top, top.right, top.bottom], [row.paneBox.left, 0, state.width, row.paneBox.top], `${label}: top gutter painted`)
  assert.equal(right.top, 0)
  assert.equal(right.right, state.width, `${label}: right gutter painted to the window edge`)
  assert.ok(right.left <= row.box.right && right.bottom >= WINDOWS.top, `${label}: right piece covers border and gutter beside the caption buttons`)
  for (const piece of [top, right]) assert.equal(piece.background, row.background, `${label}: painted in the row's surface`)
}

test('Windows host: the tab row at the caption buttons is flush with the window corner and as tall as the buttons', async () => {
  for (const dark of [false, true]) {
    const { page, errors, close } = await open({ host: WINDOWS, dark })
    try {
      const state = await cornerState(page)
      assert.equal(state.rows.length, 1)
      const [row] = state.rows
      assert.equal(row.corner, 'fit')
      assert.equal(row.banded, false)
      assertFlushCorner(state, row, `dark=${dark}`)
      assert.equal(row.box.top, row.paneBox.top, 'row starts at the pane top')
      assert.equal(row.box.bottom, WINDOWS.top, 'row is exactly as tall as the caption buttons')
      // Tabs start below the window edge, run into the content, and their labels and the strip controls centre on the buttons.
      for (const tab of row.tabs) {
        assert.equal(tab.bottom, WINDOWS.top)
        assert.ok(tab.top >= 6, 'tab top below the window edge')
        assert.ok(Math.abs(tab.label - WINDOWS.top / 2) <= 1, `tab label centred (${tab.label})`)
      }
      assert.ok(row.controls.length >= 2)
      for (const control of row.controls) {
        assert.ok(Math.abs(control.mid - WINDOWS.top / 2) <= 1, `control centred (${control.mid})`)
        assert.ok(control.right <= state.width - WINDOWS.right - 40, 'controls stay left of the drag gap')
      }
      const info = await inspect(page)
      assertHostContract(info, `windows dark=${dark}`)
      assert.equal(info.colorScheme, dark ? 'dark' : 'light')
      assert.deepEqual(errors, [])
    } finally { await close() }
  }
  // The theme recolours the corner.
  const { page, close } = await open({ host: WINDOWS })
  try {
    const before = await cornerState(page)
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await settle(page)
    const after = await cornerState(page)
    assert.notEqual(after.rows[0].background, before.rows[0].background)
    assert.ok(after.pieces.every(piece => piece.background === after.rows[0].background))
  } finally { await close() }
})

test('Windows host: only the corner pane reserves the caption buttons; a narrow corner pane moves its tabs below a drag band', async () => {
  for (const [layout, banded] of [['split50', false], ['split40', true], ['split25', true]]) {
    for (const dark of [false, true]) {
      const { page, errors, close } = await open({ host: WINDOWS, layout, dark })
      const label = `${layout} dark=${dark}`
      try {
        const state = await cornerState(page)
        const left = state.rows.find(row => row.pane === 'p1')
        const right = state.rows.find(row => row.pane === 'p2')
        // The other pane keeps its browser position and reserves nothing.
        assert.equal(left.corner, null)
        assert.equal(left.cornerPane, false)
        assert.equal(left.padRight, 0)
        assert.equal(left.paneTop.border, '1px')
        assert.equal(right.banded, banded, `${label}: banded`)
        assertFlushCorner(state, right, label)
        const info = await inspect(page)
        assertHostContract(info, label)
        const width = right.box.right - right.box.left
        if (!banded) {
          assert.equal(right.corner, 'fit')
          assert.equal(right.box.bottom, WINDOWS.top)
          assert.equal(right.padRight, Math.ceil(right.box.right - (state.width - WINDOWS.right)) + 40, 'overlap plus the drag gap')
        } else {
          // The band above that pane only drags the window; tabs and controls sit below it at full pane width.
          assert.equal(right.padRight, 0)
          for (const element of [...right.tabs, ...right.controls]) assert.ok(element.top >= WINDOWS.top, `${label}: below the band`)
          assert.ok(right.controls.at(-1).right > state.width - WINDOWS.right, `${label}: controls use the width under the caption buttons`)
          const bandY = WINDOWS.top / 2
          for (const x of [right.box.left + 4, right.box.left + width / 2, state.width - WINDOWS.right - 4]) assert.ok(inRegion(info.regions, Math.round(x), bandY), `${label}: band drags at ${x}`)
          assert.ok(inRegion(info.regions, Math.round(right.box.left + width / 2), 0), `${label}: band reaches the window top`)
          assert.ok(!inRegion(info.regions, Math.round(left.box.left + 20), bandY), `${label}: the other pane's tabs are not part of the band`)
        }
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  }
  // Top/bottom split: the top pane keeps its full width; the bottom pane is untouched.
  const { page, close } = await open({ host: WINDOWS, layout: 'column' })
  try {
    const state = await cornerState(page)
    const top = state.rows.find(row => row.pane === 'p1')
    const bottom = state.rows.find(row => row.pane === 'p2')
    assert.equal(top.corner, 'fit')
    assert.equal(top.banded, false)
    assertFlushCorner(state, top, 'column')
    assert.equal(bottom.corner, null)
    assert.equal(bottom.cornerPane, false)
    assert.equal(bottom.padRight, 0)
    assertHostContract(await inspect(page), 'windows column')
  } finally { await close() }
})

test('Windows host: a sole tab header at the corner is flush too; a standard-height caption only reserves', async () => {
  const { page, close } = await open({ host: WINDOWS, layout: 'sole' })
  try {
    const state = await cornerState(page)
    const [row] = state.rows
    assert.equal(row.corner, '', 'a header taller than the buttons keeps its height')
    const pane = await page.evaluate(() => { const p = document.querySelector('.foxwarm-workbench-panel'); const s = getComputedStyle(p); return { marked: p.hasAttribute('data-frame-corner-pane'), border: s.borderTopWidth, radius: s.borderTopRightRadius, top: p.getBoundingClientRect().top } })
    assert.deepEqual(pane, { marked: true, border: '0px', radius: '0px', top: 6 })
    assert.equal(row.box.top, 6)
    assert.ok(state.pieces.find(piece => piece.edge === 'bottom')?.bottom >= row.box.bottom, 'gutter beside the whole header painted')
    assertHostContract(await inspect(page), 'windows sole')
  } finally { await close() }
  const standard = await open({ host: { ...WINDOWS, right: 138, top: 32 } })
  try {
    const state = await cornerState(standard.page)
    assert.equal(state.rows[0].corner, '', 'a row taller than the caption keeps its own height')
    assert.ok(state.rows[0].box.bottom > 32)
    assertHostContract(await inspect(standard.page), 'windows standard caption')
  } finally { await standard.close() }
})

test('macOS host: rows step below and beside the lights, full screen reserves nothing', async () => {
  for (const collapsed of [false, true]) {
    const { page, close } = await open({ host: MACOS, collapsed, dark: true })
    try {
      const info = await inspect(page)
      assert.equal(info.frame, 'macos')
      assert.equal(info.colorScheme, 'dark')
      const corner = await cornerState(page)
      assert.deepEqual(corner.pieces, [], 'no Windows corner on macOS')
      assert.ok(corner.rows.every(row => row.corner === null && !row.cornerPane))
      assertHostContract(info, `macos collapsed=${collapsed}`)
      // The band under and beside the lights drags from the window's top-left corner.
      assert.ok(inRegion(info.regions, 0, 0) && inRegion(info.regions, MACOS.left + 10, MACOS.top - 4), 'lights band')
      if (!collapsed) assert.ok(info.brand.top >= MACOS.top, 'brand row below the lights')
    } finally { await close() }
  }
  const { page, close } = await open({ host: { ...MACOS, left: 0, top: 0, state: ['fullscreen'] } })
  try {
    const info = await inspect(page)
    assert.equal(info.window, 'fullscreen')
    assert.deepEqual(info.regions, [])
    assert.equal(info.fills, 0)
    assert.ok(info.brand.top < 30, 'brand row keeps its browser position')
  } finally { await close() }
})

test('split panes keep blank tab-strip space for pane drag; menus opened from the brand row stay out of the regions', async () => {
  const { page, close } = await open({ host: { ...WINDOWS, state: ['maximized'] }, layout: 'split' })
  try {
    const info = await inspect(page)
    assert.equal(info.window, 'maximized')
    assertHostContract(info, 'windows split')
    const blank = await page.evaluate(() => {
      const strip = document.querySelector('[data-workbench-pane-drag-area] [data-workbench-pane-drag-blank]')
      const r = strip.getBoundingClientRect()
      return { x: Math.round(r.right - 8), y: Math.round((r.top + r.bottom) / 2) }
    })
    assert.ok(!inRegion(info.regions, blank.x, blank.y), 'blank strip space of the first pane moves the pane, not the window')
    await page.click('[data-sidebar-brand] button[aria-label="Open UI settings"]')
    await settle(page)
    const opened = await inspect(page)
    const menu = await page.evaluate(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
    for (const region of opened.regions) assert.ok(!overlaps(region, menu), `region ${region} covers the open menu`)
    assertHostContract(opened, 'windows menu open')
  } finally { await close() }
})

test('narrow windows keep the mobile shell below a draggable strip; mid widths use the desktop layout', async () => {
  for (const host of [WINDOWS, MACOS]) {
    const { page, close } = await open({ host, width: 700, layout: 'sole' })
    try {
      const info = await inspect(page)
      assert.deepEqual(info.strip, { left: 0, top: 0, right: 700, bottom: host.top })
      assert.deepEqual(info.regions, [[0, 0, 700, host.top]])
      assert.equal(info.fills, 0)
      for (const control of info.interactive) assert.ok(control.top >= host.top, `"${control.name}" below the strip`)
    } finally { await close() }
    const mid = await open({ host, width: 800, collapsed: true })
    try {
      const info = await inspect(mid.page)
      assert.equal(info.strip, null)
      assertHostContract(info, `${host.platform} 800`)
    } finally { await mid.close() }
  }
})

test('PWA window-controls overlay maps the insets to app-region and switches off with the overlay', async () => {
  const { page, errors, close } = await open({ overlay: { left: 0, right: 186, top: 33 } })
  try {
    const state = () => page.evaluate(() => ({
      frame: document.documentElement.dataset.foxwarmFrame ?? null,
      brand: getComputedStyle(document.querySelector('[data-sidebar-brand]')).appRegion,
      button: getComputedStyle(document.querySelector('[data-sidebar-brand] button')).appRegion,
      fills: [...document.querySelectorAll('.foxwarm-frame-fill')].map(fill => getComputedStyle(fill).appRegion),
      endGap: [...document.querySelectorAll('[data-frame-edge="end"]')].map(edge => edge.getBoundingClientRect().width).filter(Boolean),
      messages: window.__frameMessages.length,
      themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
      // The surface the overlay controls sit on: the end of the first pane's tab strip.
      under: (() => {
        const [r, g, b] = getComputedStyle(document.querySelector('[data-frame-row="inline"]')).backgroundColor.match(/\d+/g).map(Number)
        return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
      })(),
      canvas: document.cookie.split('; ').find(part => part.startsWith('foxwarm_canvas='))?.slice(15) ?? null,
    }))
    // The built-in light theme paints the strip on the canvas colour; give it its own.
    await page.addStyleTag({ content: '[data-frame-row="inline"] { background: #123456 !important }' })
    // A theme change (here the system switching to dark) re-reads the surface.
    const before = await page.evaluate(() => document.cookie)
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await settle(page)
    assert.notEqual(await page.evaluate(() => document.cookie), before, 'the canvas cookie followed the theme change')
    const on = await state()
    assert.equal(on.frame, 'overlay')
    assert.equal(on.brand, 'drag')
    assert.equal(on.button, 'no-drag')
    assert.ok(on.fills.length > 0 && on.fills.every(value => value === 'drag'))
    assert.ok(on.endGap.length === 1 && on.endGap[0] > 186, 'tab strip reserves the overlay controls plus the gap')
    assert.equal(on.messages, 0)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.foxwarm-frame-corner > *, [data-frame-corner], [data-frame-corner-pane]').length), 0, 'no Windows corner in the overlay')
    // Chromium paints the overlay controls on theme-color; the manifest cookie keeps the canvas.
    assert.equal(on.themeColor, on.under)
    assert.equal(on.under, '#123456')
    assert.ok(on.canvas && `#${on.canvas}` !== on.under)
    await page.evaluate(() => window.__setOverlay(false))
    await settle(page)
    const off = await state()
    assert.equal(off.frame, null)
    assert.equal(off.themeColor, `#${on.canvas}`)
    assert.equal(off.brand, 'none')
    assert.deepEqual(off.fills, [])
    assert.deepEqual(errors, [])
  } finally { await close() }
})
