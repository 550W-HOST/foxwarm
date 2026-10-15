import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import { webuiReactAliases } from './reactRendererAliases.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, baseUrl
before(async () => {
  const webui = new URL('..', import.meta.url).pathname
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const bundle = await build({
    stdin: {
      contents: `
        import React, { StrictMode } from 'react'
        import { createRoot } from 'react-dom/client'
        import FoxLoaderPreview from './src/components/FoxLoaderPreview'
        import { initializeThemeRuntime } from './src/theme'
        initializeThemeRuntime()
        window.fixture = { actions: 0 }
        createRoot(document.getElementById('root')).render(
          <StrictMode><>
            <FoxLoaderPreview />
            <button data-after-preview onClick={() => window.fixture.actions++}>After preview</button>
          </></StrictMode>
        )
      `,
      resolveDir: webui,
      sourcefile: 'fox-loader-preview-fixture.tsx',
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    alias: webuiReactAliases,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const trigger = '[aria-label="Preview full-screen splash"]'

test('manual splash opens by keyboard, closes with Escape or pointer, and returns keyboard position', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(baseUrl)
    await page.waitForSelector(trigger)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    assert.equal(await page.$eval(trigger, button => button === document.activeElement), true)
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-fox-splash]', { visible: true })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-fox-splash]', { hidden: true })
    assert.equal(await page.$eval(trigger, button => button === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await page.$eval('[data-after-preview]', button => button === document.activeElement), true)
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixture.actions), 1)
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift')
    await page.keyboard.press('Space')
    await page.waitForSelector('[data-fox-splash]', { visible: true })
    await page.mouse.click(10, 10)
    await page.waitForSelector('[data-fox-splash]', { hidden: true })
    assert.equal(await page.$eval(trigger, button => button === document.activeElement), true)
  } finally { await page.close() }
})
