import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const componentEntry = new URL('../src/components/ContextMenu.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssCandidates = assetNames.filter(name => /^index-.*\.css$/.test(name))
  const cssStats = await Promise.all(cssCandidates.map(async name => ({
    name,
    mtimeMs: (await stat(new URL(name, assetsDirectory))).mtimeMs,
  })))
  const cssAsset = cssStats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
  assert.ok(cssAsset, 'build packages/webui before running the context-menu browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ContextMenu from ${JSON.stringify(componentEntry)}

    function Fixture() {
      return React.createElement(ContextMenu, {
        open: true,
        point: { x: 24, y: 24 },
        onClose() {},
        entries: [{
          key: 'idle',
          label: 'Notify on idle',
          onSelect() {},
          trailingControl: { label: 'always', checked: false, onSelect() {} },
        }],
      })
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'context-menu-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${result.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('[data-context-menu-split-row="true"]')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('split context-menu actions highlight the complete row from either hover target', async () => {
  const readColors = () => page.$eval('[data-context-menu-split-row="true"]', (row) => ({
    row: getComputedStyle(row).backgroundColor,
    main: getComputedStyle(row.children[0]).backgroundColor,
    trailing: getComputedStyle(row.children[1]).backgroundColor,
  }))

  await page.$eval('[data-context-menu-split-row="true"] > button:first-child', button => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await page.waitForFunction(() => document.querySelector('[data-context-menu-split-row="true"]')?.getAttribute('data-context-menu-split-row-hovered') === 'true')
  const mainHover = await readColors()
  assert.equal(mainHover.main, 'rgba(0, 0, 0, 0)')
  assert.equal(mainHover.trailing, 'rgba(0, 0, 0, 0)')

  await page.$eval('[data-context-menu-split-row="true"] > button:last-child', button => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  const trailingHover = await readColors()
  assert.equal(trailingHover.row, mainHover.row)
  assert.equal(trailingHover.main, mainHover.main)
  assert.equal(trailingHover.trailing, mainHover.trailing)
})