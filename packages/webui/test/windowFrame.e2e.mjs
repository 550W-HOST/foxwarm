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
        banded: document.querySelectorAll('[data-frame-banded]').length,
        leading: document.documentElement.hasAttribute('data-foxwarm-frame-leading'),
        messages: window.__frameMessages.length,
      }))
      assert.deepEqual(state, { frame: null, narrow: false, fills: false, strip: false, inBand: 0, rowVars: 0, edges: 0, appRegion: 0, banded: 0, leading: false, messages: 0 })
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
        assert.ok(inRegion(info.regions, 0, 0) && inRegion(info.regions, 24, 4) && inRegion(info.regions, 4, 24), 'rail title row around the toggle')
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  }
})

/** Geometry of the framed layout: shell, sidebar, title-row rows, tabs, cards and status row. */
function frameLayout(page) {
  return page.evaluate(() => {
    const box = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
    const mid = element => { const r = element.getBoundingClientRect(); return (r.top + r.bottom) / 2 }
    const style = element => element ? getComputedStyle(element) : null
    const shell = document.querySelector('.foxwarm-desktop-workbench-shell')
    const sidebar = document.querySelector('.foxwarm-sidebar-panel')
    const rows = [...document.querySelectorAll('[data-frame-row="inline"]')].map(row => {
      const pane = row.closest('.foxwarm-workbench-panel')
      const body = pane?.querySelector('.foxwarm-workbench-pane-body')
      const inner = row.querySelector(':scope > [data-workbench-pane-drag-blank]')
      return {
        pane: pane?.dataset.paneId ?? null,
        inBand: row.hasAttribute('data-frame-in-band'),
        banded: row.hasAttribute('data-frame-banded'),
        box: box(row),
        inner: box(inner),
        innerBorderTop: style(inner).borderTopWidth,
        body: box(body),
        bodyStyle: body ? { borderTop: style(body).borderTopWidth, radius: style(body).borderBottomRightRadius, topRadius: style(body).borderTopLeftRadius } : null,
        padRight: parseFloat(row.style.getPropertyValue('--foxwarm-frame-pad-right')) || 0,
        tabs: [...row.querySelectorAll('[data-tab-id]')].map(tab => ({ ...box(tab), active: tab.hasAttribute('data-tab-active'), background: style(tab).backgroundColor, border: style(tab).borderTopWidth })),
        controls: [...row.querySelectorAll('.foxwarm-workbench-tab-toolbar button')].map(button => ({ ...box(button), mid: mid(button), border: style(button).borderTopColor, background: style(button).backgroundColor })),
      }
    })
    const brandRow = document.querySelector('.foxwarm-sidebar-brand-row')
    const brandButtons = [...document.querySelectorAll('[data-sidebar-brand] button')]
    const toggle = document.querySelector('.foxwarm-sidebar-rail-toggle')
    const status = document.querySelector('[data-workbench-status-bar]')
    return {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      chrome: style(shell).backgroundColor,
      canvasEdge: getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-canvas-edge').trim(),
      headerSurface: getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-workbench-header-surface').trim(),
      sidebar: { box: box(sidebar), background: style(sidebar).backgroundColor, border: style(sidebar).borderRightWidth },
      brandRow: box(brandRow),
      brandMid: brandRow ? mid(brandRow.querySelector('h1')) : null,
      brandLogo: box(brandRow?.querySelector('h1 > svg')),
      wordmark: brandRow ? style(brandRow.querySelector('.foxwarm-sidebar-wordmark')).display : null,
      brandButtons: brandButtons.map(button => ({ mid: mid(button), border: style(button).borderTopColor, background: style(button).backgroundColor })),
      toggle: toggle ? { ...box(toggle), mid: mid(toggle) } : null,
      status: { box: box(status), background: style(status).backgroundColor },
      rows,
    }
  })
}

const transparent = 'rgba(0, 0, 0, 0)'
const hexToRgb = hex => { const [r, g, b] = hex.replace('#', '').match(/../g).map(part => parseInt(part, 16)); return `rgb(${r}, ${g}, ${b})` }

/** Shared title-row and card geometry of the framed layout for a host's title height. */
function assertFramedLayout(layout, title, label) {
  // The window background is chrome; the sidebar and the status row sit on it.
  assert.equal(layout.chrome, hexToRgb(layout.canvasEdge), `${label}: chrome is the canvas edge colour`)
  assert.equal(layout.sidebar.background, transparent, `${label}: sidebar on the chrome`)
  assert.equal(layout.sidebar.border, '0px')
  assert.equal(layout.sidebar.box.left, 0)
  assert.equal(layout.sidebar.box.top, 0)
  assert.equal(layout.status.background, transparent, `${label}: status row on the chrome`)
  assert.equal(layout.status.box.bottom, layout.height)
  for (const row of layout.rows.filter(row => row.inBand)) {
    // A top pane's strip is a title-row segment; its card starts right below it, with even gutters.
    if (!row.banded) {
      assert.equal(row.box.top, 0, `${label}: strip at the window top`)
      assert.equal(row.box.bottom, title, `${label}: strip exactly one title row tall`)
      assert.equal(row.body.top, title - 1, `${label}: card below the title row (the active tab overlaps its top border)`)
      for (const tab of row.tabs) assert.equal(tab.bottom, title, `${label}: tabs sit on the card`)
      for (const control of row.controls) assert.ok(Math.abs(control.mid - title / 2) <= 1, `${label}: strip control centred on the title row (${control.mid})`)
    }
    assert.equal(row.body.bottom, layout.status.box.top, `${label}: card ends at the status row`)
    assert.equal(row.bodyStyle.radius, '10px', `${label}: card corners`)
    // Inactive tabs are text on the chrome; the active tab has the header surface and joins the card.
    for (const tab of row.tabs) {
      if (tab.active) assert.equal(tab.background, hexToRgb(layout.headerSurface), `${label}: active tab surface`)
      else assert.equal(tab.background, transparent, `${label}: inactive tab has no slab`)
      assert.equal(tab.border, '0px')
    }
    // Title-row buttons are borderless in both themes.
    for (const control of row.controls) assert.deepEqual([control.border, control.background], [transparent, transparent], `${label}: borderless strip control`)
  }
  const right = Math.max(...layout.rows.map(row => row.body.right))
  assert.equal(right, layout.width - 8, `${label}: right gutter`)
  if (layout.brandRow) {
    assert.deepEqual([layout.brandRow.top, layout.brandRow.bottom], [0, title], `${label}: brand row is the title row's left end`)
    assert.ok(Math.abs(layout.brandMid - title / 2) <= 1, `${label}: brand centred on the title row`)
    for (const button of layout.brandButtons) {
      assert.ok(Math.abs(button.mid - title / 2) <= 1, `${label}: brand button centred`)
      assert.deepEqual([button.border, button.background], [transparent, transparent], `${label}: borderless brand button`)
    }
  }
}

test('Windows host: one title row as tall as the caption buttons; sidebar and status row on the chrome, panes as cards', async () => {
  for (const collapsed of [false, true]) {
    for (const dark of [false, true]) {
      const label = `collapsed=${collapsed} dark=${dark}`
      const { page, errors, close } = await open({ host: WINDOWS, dark, collapsed })
      try {
        const layout = await frameLayout(page)
        assertFramedLayout(layout, WINDOWS.top, label)
        assert.equal(layout.rows.length, 1)
        const [row] = layout.rows
        assert.equal(row.padRight, Math.ceil(row.box.right - (layout.width - WINDOWS.right)) + 40, `${label}: overlap plus the drag gap`)
        for (const control of row.controls) assert.ok(control.right <= layout.width - WINDOWS.right - 40, `${label}: controls left of the drag gap`)
        if (collapsed) {
          assert.ok(Math.abs(layout.toggle.mid - WINDOWS.top / 2) <= 1, `${label}: rail toggle in the title row`)
          assert.equal(layout.brandRow, null)
        } else assert.notEqual(layout.wordmark, 'none', `${label}: wordmark shown on Windows`)
        const info = await inspect(page)
        assertHostContract(info, `windows ${label}`)
        assert.equal(info.colorScheme, dark ? 'dark' : 'light')
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  }
})

test('under a frame a sole tab keeps its tab strip; without one it folds into the content header', async () => {
  for (const host of [WINDOWS, null]) {
    const { page, close } = await open({ host, layout: 'sole' })
    try {
      const state = await page.evaluate(() => ({
        tabs: document.querySelectorAll('.foxwarm-workbench-tab-strip [data-tab-id]').length,
        paneControls: document.querySelectorAll('[data-workbench-pane-controls]').length,
      }))
      assert.deepEqual(state, host ? { tabs: 1, paneControls: 0 } : { tabs: 0, paneControls: 1 })
      if (host) {
        assertFramedLayout(await frameLayout(page), WINDOWS.top, 'sole')
        assertHostContract(await inspect(page), 'windows sole')
      }
    } finally { await close() }
  }
})

test('Windows host: in row splits every top pane is a title-row segment; a narrow corner pane moves its tabs into its card below a blank drag band', async () => {
  for (const [layout, banded] of [['split50', false], ['split40', true], ['split25', true]]) {
    for (const dark of [false, true]) {
      const { page, errors, close } = await open({ host: WINDOWS, layout, dark })
      const label = `${layout} dark=${dark}`
      try {
        const layoutState = await frameLayout(page)
        assertFramedLayout(layoutState, WINDOWS.top, label)
        const left = layoutState.rows.find(row => row.pane === 'p1')
        const right = layoutState.rows.find(row => row.pane === 'p2')
        assert.equal(left.padRight, 0, `${label}: only the corner pane reserves`)
        assert.equal(left.banded, false)
        // An even gutter between the cards.
        assert.equal(right.body.left - left.body.right, 8, `${label}: gutter between cards`)
        assert.equal(right.banded, banded, `${label}: banded`)
        const info = await inspect(page)
        assertHostContract(info, label)
        if (!banded) {
          assert.equal(right.padRight, Math.ceil(right.box.right - (layoutState.width - WINDOWS.right)) + 40, 'overlap plus the drag gap')
        } else {
          // The strip is the top of the card, aligned with the other cards; the title row above it only drags the window.
          assert.equal(right.padRight, 0)
          assert.equal(right.inner.top, WINDOWS.top - 1, `${label}: strip at the card top`)
          assert.equal(right.inner.top, left.body.top, `${label}: card tops aligned`)
          assert.equal(right.innerBorderTop, '1px', `${label}: strip carries the card's top border`)
          assert.equal(right.bodyStyle.borderTop, '0px')
          assert.equal(right.bodyStyle.topRadius, '0px')
          for (const element of [...right.tabs, ...right.controls]) assert.ok(element.top >= WINDOWS.top, `${label}: below the band`)
          assert.ok(right.controls.at(-1).right > layoutState.width - WINDOWS.right, `${label}: controls use the width under the caption buttons`)
          const width = right.box.right - right.box.left
          for (const x of [right.box.left + 4, right.box.left + width / 2, layoutState.width - WINDOWS.right - 4]) assert.ok(inRegion(info.regions, Math.round(x), WINDOWS.top / 2), `${label}: band drags at ${x}`)
          assert.ok(inRegion(info.regions, Math.round(right.box.left + width / 2), 0), `${label}: band reaches the window top`)
          assert.ok(!inRegion(info.regions, Math.round(left.box.left + 20), WINDOWS.top / 2), `${label}: the other pane's tabs are not part of the band`)
        }
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  }
  // Top/bottom split: the top pane is the title-row segment; the lower pane keeps a compact strip.
  const { page, close } = await open({ host: WINDOWS, layout: 'column' })
  try {
    const layout = await frameLayout(page)
    const top = layout.rows.find(row => row.pane === 'p1')
    const bottom = layout.rows.find(row => row.pane === 'p2')
    assert.deepEqual([top.inBand, top.banded, top.box.top, top.box.bottom], [true, false, 0, WINDOWS.top])
    assert.equal(bottom.inBand, false)
    assert.equal(bottom.padRight, 0)
    assert.equal(bottom.box.bottom - bottom.box.top, 40, 'compact strip')
    assertHostContract(await inspect(page), 'windows column')
  } finally { await close() }
  // A standard-height caption: the title row keeps its 36 px minimum.
  const standard = await open({ host: { ...WINDOWS, right: 138, top: 32 } })
  try {
    assertFramedLayout(await frameLayout(standard.page), 36, 'standard caption')
    assertHostContract(await inspect(standard.page), 'windows standard caption')
  } finally { await standard.close() }
})

test('macOS host: the brand row and the rail toggle start after the lights, full screen reserves nothing', async () => {
  for (const collapsed of [false, true]) {
    const { page, close } = await open({ host: MACOS, collapsed, dark: true })
    try {
      const info = await inspect(page)
      assert.equal(info.frame, 'macos')
      assert.equal(info.colorScheme, 'dark')
      const layout = await frameLayout(page)
      assertFramedLayout(layout, MACOS.top, `macos collapsed=${collapsed}`)
      assertHostContract(info, `macos collapsed=${collapsed}`)
      // The band under and beside the lights drags from the window's top-left corner.
      assert.ok(inRegion(info.regions, 0, 0), 'lights band')
      if (!collapsed) {
        assert.ok(layout.brandLogo.left >= MACOS.left, 'logo after the lights')
        assert.equal(layout.wordmark, 'none', 'logo only; the app name is in the menu bar')
        assert.ok(inRegion(info.regions, MACOS.left + 30, MACOS.top / 2), 'brand row blank drags')
      } else {
        assert.ok(layout.toggle.left >= MACOS.left, 'rail toggle after the lights')
        assert.ok(Math.abs(layout.toggle.mid - MACOS.top / 2) <= 1)
        // The first pane's tabs start after the lights, the toggle and the drag gap.
        assert.ok(layout.rows[0].tabs[0].left >= layout.toggle.right, 'tabs after the toggle')
      }
    } finally { await close() }
  }
  const { page, close } = await open({ host: { ...MACOS, left: 0, top: 0, state: ['fullscreen'] } })
  try {
    const info = await inspect(page)
    assert.equal(info.window, 'fullscreen')
    assert.deepEqual(info.regions, [])
    assert.equal(info.fills, 0)
    const layout = await frameLayout(page)
    assert.notEqual(layout.wordmark, 'none', 'full screen shows the wordmark')
    assert.equal(layout.brandRow.bottom, 36, 'title row keeps its minimum height')
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

test('PWA window-controls overlay: theme-color is the chrome under the controls once the boot screen is gone', async () => {
  for (const dark of [false, true]) {
    const { page, errors, close } = await open({ overlay: { left: 0, right: 186, top: 33 }, dark })
    try {
      const state = await page.evaluate(() => {
        const hex = color => '#' + color.match(/\d+/g).slice(0, 3).map(c => Number(c).toString(16).padStart(2, '0')).join('')
        return {
          themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
          chrome: hex(getComputedStyle(document.querySelector('.foxwarm-desktop-workbench-shell')).backgroundColor),
          canvas: document.cookie.split('; ').find(part => part.startsWith('foxwarm_canvas='))?.slice(15) ?? null,
        }
      })
      assert.equal(state.themeColor, state.chrome, `dark=${dark}: overlay controls on the chrome`)
      assert.notEqual(`#${state.canvas}`, state.chrome, `dark=${dark}: chrome differs from the canvas, so the check is meaningful`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  }
})

/** Largest channel difference and the number of differing pixels between two same-sized PNG screenshots. */
function pixelDiff(page, a, b) {
  return page.evaluate(async (a, b) => {
    const read = async data => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const canvas = new OffscreenCanvas(image.width, image.height)
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, image.width, image.height)
    }
    const [x, y] = [await read(a), await read(b)]
    if (x.width !== y.width || x.height !== y.height) return { max: Infinity, count: Infinity }
    let max = 0, count = 0
    for (let i = 0; i < x.data.length; i += 4) {
      const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]))
      if (d) { count++; max = Math.max(max, d) }
    }
    return { max, count }
  }, a, b)
}

test('switching the PWA overlay off renders the same pixels as a page without a provider', async () => {
  for (const [layout, collapsed, dark] of [['sole', false, false], ['split50', true, true]]) {
    const label = `${layout} collapsed=${collapsed} dark=${dark}`
    const plain = await open({ layout, collapsed, dark })
    const framed = await open({ overlay: { left: 0, right: 186, top: 33 }, layout, collapsed, dark })
    try {
      await framed.page.evaluate(() => window.__setOverlay(false))
      // Let the title-row buttons' colour transitions finish.
      await framed.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)))
      await settle(framed.page)
      const shot = async page => {
        await page.evaluate(() => document.activeElement?.blur())
        await settle(page)
        return page.screenshot({ encoding: 'base64' })
      }
      const [shotA, shotB] = [await shot(plain.page), await shot(framed.page)]
      const diff = await pixelDiff(plain.page, shotA, shotB)
      // Chromium may keep a repainted page's earlier anti-aliasing at a clipped rounded corner;
      // a change in layout or colour moves far more pixels by far more than that.
      assert.ok(diff.max <= 4 && diff.count <= 64, `${label}: pixels differ after the overlay switched off (${JSON.stringify(diff)})`)
    } finally { await plain.close(); await framed.close() }
  }
})

test('PWA window-controls overlay maps the insets to app-region and switches off with the overlay', async () => {
  const { page, errors, close } = await open({ overlay: { left: 0, right: 186, top: 33 } })
  try {
    const state = () => page.evaluate(() => ({
      frame: document.documentElement.dataset.foxwarmFrame ?? null,
      brand: getComputedStyle(document.querySelector('.foxwarm-sidebar-brand-row')).appRegion,
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

test('drag overlays draw the real tab and a compact pane summary, framed or not, light and dark', async () => {
  for (const host of [WINDOWS, null]) for (const dark of [false, true]) {
    const label = `host=${host ? 'windows' : 'none'} dark=${dark}`
    const { page, errors, close } = await open({ host, layout: 'split', dark })
    const tabStyle = selector => page.$eval(selector, element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color, height: element.getBoundingClientRect().height, fontSize: style.fontSize, radius: style.borderTopLeftRadius }
    })
    const drag = async (from, selector) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 12, from.y + 2, { steps: 3 })
      await page.waitForSelector(selector)
    }
    const release = async selector => {
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForSelector(selector, { hidden: true })
    }
    try {
      // Tab: the overlay is the strip's tab drawn without its interactive parts.
      const real = await tabStyle('[data-tab-id][data-tab-active]')
      const tab = await (await page.$('[data-tab-id][data-tab-active]')).boundingBox()
      const tabOverlay = '[data-workbench-tab-overlay]:not([data-pane-drag-overlay])'
      await drag({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }, tabOverlay)
      assert.deepEqual(await tabStyle(`${tabOverlay} .foxwarm-workbench-tab[data-tab-active]`), real, `${label}: active tab overlay matches the strip tab`)
      assert.equal(await page.$eval(tabOverlay, element => element.getAttribute('aria-hidden')), 'true', label)
      assert.equal(await page.$eval(tabOverlay, element => element.querySelector('button, a, input, [tabindex], [role]') === null && getComputedStyle(element).pointerEvents), 'none', `${label}: overlay is not interactive`)
      assert.equal(await page.$eval(tabOverlay, element => getComputedStyle(element).cursor), 'grabbing', label)
      await release(tabOverlay)

      // Pane: the shown tab and the number of the others.
      const blank = await page.evaluate(() => {
        const area = document.querySelector('[data-workbench-pane-drag-area="p1"]')
        const rect = area.getBoundingClientRect()
        for (let x = rect.right - 4; x > rect.left; x -= 6) {
          const y = rect.top + rect.height / 2
          const hit = document.elementFromPoint(x, y)
          if (hit?.matches('[data-workbench-pane-drag-area], [data-workbench-pane-drag-blank]') && hit.closest('[data-workbench-pane-drag-area]') === area) return { x, y }
        }
        return null
      })
      assert.ok(blank, `${label}: blank pane header space`)
      await drag(blank, '[data-pane-drag-overlay]')
      const pane = await page.$eval('[data-pane-drag-overlay]', element => ({
        text: element.textContent.replace(/[\u200E]/g, ''),
        hidden: element.getAttribute('aria-hidden'),
        tab: element.querySelector('.foxwarm-workbench-tab[data-tab-active]') !== null,
      }))
      assert.match(pane.text, /\+1$/, `${label}: the other tab is counted`)
      assert.deepEqual({ hidden: pane.hidden, tab: pane.tab }, { hidden: 'true', tab: true }, label)
      await release('[data-pane-drag-overlay]')
      assert.deepEqual(errors, [], label)
    } finally { await close() }
  }
})
