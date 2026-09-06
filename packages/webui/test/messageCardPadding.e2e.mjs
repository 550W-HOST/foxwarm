import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const timelineEntry = fileURLToPath(new URL('../src/components/ChatTimeline.tsx', import.meta.url))
const themeEntry = fileURLToPath(new URL('../src/theme/index.ts', import.meta.url))
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import { BUILTIN_THEMES, initializeThemeRuntime, setThemeSelection } from ${JSON.stringify(themeEntry)}

    initializeThemeRuntime()
    window.themeCases = BUILTIN_THEMES.flatMap(theme => ['light', 'dark'].map(colorMode => ({ themeId: theme.id, colorMode })))
    window.selectFixtureTheme = (themeId, colorMode) => setThemeSelection({ themeId, colorMode })
    createRoot(document.getElementById('root')).render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/main',
      messages: [
        { role: 'model', parts: [{ text: 'Assistant message.' }], __meta: { seq: 1 } },
        { role: 'user', parts: [{ text: 'User message.' }], __meta: { seq: 2 } },
      ],
      isMobile: false,
      groupTools: false,
      showUsageBadge: false,
    }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: 'message-card-padding-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

async function readPadding(selector) {
  return page.$eval(selector, element => {
    const style = getComputedStyle(element)
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
  })
}

before(async () => {
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the message-card padding browser test')
  const [css, bundle] = await Promise.all([
    readFile(new URL(cssAsset, assetsDirectory), 'utf8'),
    buildFixtureBundle(),
  ])
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-user-message-bubble')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('assistant and user cards keep an 8px inset in every built-in light and dark variant', async () => {
  const cases = await page.evaluate(() => window.themeCases)
  assert.equal(cases.length, 12)
  for (const { themeId, colorMode } of cases) {
    await page.evaluate(({ themeId, colorMode }) => window.selectFixtureTheme(themeId, colorMode), { themeId, colorMode })
    assert.deepEqual(await readPadding('.foxwarm-assistant-message-card'), ['8px', '8px', '8px', '8px'], `${themeId} ${colorMode} assistant`)
    assert.deepEqual(await readPadding('.foxwarm-user-message-bubble'), ['8px', '8px', '8px', '8px'], `${themeId} ${colorMode} user`)
  }
})

test('assistant Raw and JSON views retain the card inset without nested padding', async () => {
  const assistant = '.foxwarm-assistant-message-card'
  for (const title of ['Raw Text', 'JSON']) {
    await page.click(`${assistant} button[title="${title}"]`)
    assert.deepEqual(await readPadding(assistant), ['8px', '8px', '8px', '8px'])
    assert.deepEqual(await readPadding(`${assistant} .foxwarm-assistant-message-raw`), ['0px', '0px', '0px', '0px'])
  }
})