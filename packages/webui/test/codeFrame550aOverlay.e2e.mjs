import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const frameHostSource = new URL('../src/components/VscodeWebFrameHost.tsx', import.meta.url)

let browser
let page
let server
let fixtureUrl

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the Code frame overlay browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const host = await readFile(frameHostSource, 'utf8')
  assert.match(host, /style=\{\{ zIndex: 35, visibility: 'hidden', pointerEvents: 'none' \}\}/)

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html data-foxwarm-ui-style="550a"><head><style>${css}</style></head><body><main style="position:fixed;inset:0;background:#111"></main><iframe data-foxwarm-vscode-web-frame="true" style="position:fixed;inset:20px;z-index:35;background:#fff" title="Code"></iframe></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('550A scanlines remain above WebUI content but below the persistent Code iframe', async () => {
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  const layers = await page.evaluate(() => {
    const scanlines = getComputedStyle(document.body, '::after')
    const frame = document.querySelector('[data-foxwarm-vscode-web-frame]')
    return {
      scanlineZIndex: Number(scanlines.zIndex),
      frameZIndex: Number(getComputedStyle(frame).zIndex),
      scanlinePointerEvents: scanlines.pointerEvents,
    }
  })
  assert.equal(layers.scanlinePointerEvents, 'none')
  assert.equal(layers.scanlineZIndex, 34, 'scanlines remain layered over ordinary WebUI content')
  assert.equal(layers.frameZIndex, 35, 'the persistent Code iframe keeps its established layer')
  assert.ok(layers.frameZIndex > layers.scanlineZIndex, 'the persistent Code iframe stays above the 550A scanlines')
})
