// windowFrame.ts on fixture DOMs in Chromium: drag-rectangle collection and edge fills
// need real layout and hit testing.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const bundle = await esbuild.build({ entryPoints: [path.join(webuiRoot, 'src/windowFrame.ts')], bundle: true, format: 'iife', globalName: 'windowFrame', platform: 'browser', target: 'chrome120', write: false, logLevel: 'silent' })
const browserBundle = bundle.outputFiles[0].text

async function withFixture(html, run) {
  const browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 800, height: 400, deviceScaleFactor: 1 })
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font: 14px sans-serif; }
      .shell { position: fixed; inset: 0; padding: 6px; display: flex; gap: 6px; background: #ddd; }
      .panel { border: 1px solid #999; background: #fff; }
      button { width: 30px; height: 24px; }
    </style></head><body>${html}</body></html>`)
    await page.addScriptTag({ content: browserBundle })
    return await run(page)
  } finally {
    await browser.close()
  }
}

const intersects = ([x, y, w, h], r) => Math.min(x + w, r.right) - Math.max(x, r.left) >= 1 && Math.min(y + h, r.bottom) - Math.max(y, r.top) >= 1

test('drag rectangles exclude interactive descendants, floating layers and rows outside the band', async () => {
  await withFixture(`
    <div class="shell">
      <div class="panel" data-frame-row="column" data-frame-in-band style="width:260px;padding:12px">
        <div id="brand" data-frame-drag style="display:flex;gap:8px;height:36px;align-items:center">
          <span tabindex="-1" id="inert">inert</span>
          <h1 style="margin:0;font-size:16px">Brand</h1>
          <button id="settings" aria-label="Settings"></button>
          <span role="button" tabindex="0" id="custom">x</span>
        </div>
      </div>
      <div class="panel" data-frame-row="inline" style="flex:1;height:42px">
        <div id="outOfBand" data-frame-drag style="height:40px"></div>
      </div>
    </div>
    <div role="menu" id="menu" style="position:fixed;left:150px;top:30px;width:120px;height:100px;background:#eee"></div>`, async page => {
    const result = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
      return { regions: window.windowFrame.collectFrameDragRects(document), brand: rect('brand'), settings: rect('settings'), custom: rect('custom'), inert: rect('inert'), menu: rect('menu'), outOfBand: rect('outOfBand') }
    })
    assert.ok(result.regions.length > 0)
    for (const region of result.regions) {
      assert.ok(region.every(Number.isInteger), `integer rect ${region}`)
      for (const key of ['settings', 'custom', 'menu', 'outOfBand']) assert.ok(!intersects(region, result[key]), `${region} overlaps ${key}`)
    }
    // A tabindex=-1 element is not interactive, and the brand row outside the menu stays draggable.
    assert.ok(result.regions.some(region => intersects(region, result.inert)))
    assert.ok(result.regions.some(region => intersects(region, { left: result.brand.left, top: result.brand.top, right: result.brand.left + 10, bottom: result.brand.top + 10 })))
  })
})

test('edge fills extend through gutter and padding, but never across interactive or text content', async () => {
  await withFixture(`
    <div class="shell">
      <div class="panel" style="width:260px;padding:12px">
        <div id="brand" data-frame-drag style="height:36px"><button>b</button></div>
      </div>
      <div class="panel" style="flex:1;position:relative">
        <button id="blocker" style="position:absolute;left:4px;top:-6px;width:40px;height:10px"></button>
        <div id="title" style="position:absolute;left:100px;top:2px;font-size:8px">Text</div>
        <div id="strip" data-frame-drag style="margin-top:14px;height:36px"></div>
      </div>
    </div>`, async page => {
    const result = await page.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect()
      return { fills: window.windowFrame.computeFrameEdgeFills(document), brand: r('brand').toJSON(), strip: r('strip').toJSON() }
    })
    const { brand, strip } = result
    // Brand row: one top fill from the window's left edge, and one left fill.
    assert.deepEqual(result.fills.filter(f => f.x < brand.right && f.y < brand.bottom), [
      { x: 0, y: 0, w: brand.right, h: brand.top },
      { x: 0, y: brand.top, w: brand.left, h: brand.height },
    ])
    // The strip's top fill would cross a button and text, so only its right fill exists.
    assert.deepEqual(result.fills.filter(f => f.x >= strip.left), [{ x: strip.right, y: strip.top, w: 800 - strip.right, h: strip.height }])
  })
})

test('the overlay surface colour is the page under the controls, composited and ignoring frame fills', async () => {
  await withFixture(`
    <div class="foxwarm-frame-fills"><div class="foxwarm-frame-fill" style="position:fixed;left:600px;top:0;width:200px;height:40px;background:transparent"></div></div>
    <div class="shell">
      <div class="panel" style="flex:1;background:rgb(40, 40, 40)">
        <div id="strip" style="height:40px;background:rgba(255, 255, 255, 0.5)"></div>
      </div>
    </div>`, async page => {
    const color = zones => page.evaluate(z => windowFrame.frameSurfaceColor(document, z), zones)
    // Right-hand controls over the half-transparent strip on the dark panel.
    assert.equal(await color({ left: 0, right: 140, top: 30, width: 800 }), '#949494')
    // Left-hand controls over the gutter, whose colour is opaque.
    assert.equal(await color({ left: 4, right: 0, top: 4, width: 800 }), '#dddddd')
    assert.equal(await color({ left: 0, right: 0, top: 30, width: 800 }), null)
  })
})
