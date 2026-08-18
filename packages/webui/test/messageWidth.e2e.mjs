import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
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

    const repeatedText = 'message width contract '.repeat(160)
    const cases = {
      shortModel: { messages: [{ role: 'model', parts: [{ text: 'Short model answer.' }], __meta: { seq: 1 } }] },
      longModel: { messages: [{ role: 'model', parts: [{ text: repeatedText }], __meta: { seq: 2 } }] },
      shortTool: { messages: [{ role: 'model', parts: [{ functionCall: { id: 'short-tool', name: 'wait', args: { reason: 'brief', timeoutSeconds: 1 } } }], __meta: { seq: 3 } }] },
      longTool: { messages: [{ role: 'model', parts: [{ functionCall: { id: 'long-tool', name: 'wait', args: { reason: repeatedText, timeoutSeconds: 1 } } }], __meta: { seq: 4 } }] },
      shortUser: { messages: [{ role: 'user', parts: [{ text: 'Short user message.' }], __meta: { seq: 5 } }] },
      longUser: { messages: [{ role: 'user', parts: [{ text: repeatedText }], __meta: { seq: 6 } }] },
      nestedModel: { nestedDepth: 1, messages: [{ role: 'model', parts: [{ text: 'Nested model.' }], __meta: { seq: 7 } }] },
      nestedUser: { nestedDepth: 1, messages: [{ role: 'user', parts: [{ text: repeatedText }], __meta: { seq: 8 } }] },
      systemMessage: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-message type="inter-agent">\\nSystem-like message.\\n</foxwarm-message>' }], __meta: { seq: 9 } }] },
      nestedSystemMessage: { nestedDepth: 1, messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="event">\\nNested system-like message.\\n</foxwarm-system>' }], __meta: { seq: 10 } }] },
    }

    for (const [id, fixture] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages: fixture.messages,
        isMobile: window.innerWidth < 768,
        groupTools: false,
        showUsageBadge: false,
        nestedDepth: fixture.nestedDepth || 0,
      }))
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'message-width-fixture.tsx' },
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

async function mountFixture({ width, height, style = 'default', dark = false }) {
  await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(({ style, dark }) => {
    document.documentElement.classList.toggle('dark', dark)
    if (style === '550a') document.documentElement.setAttribute('data-foxwarm-ui-style', '550a')
  }, { style, dark })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-chat-timeline').length === 10)
}

async function readWidths() {
  return page.evaluate(() => {
    const read = (id, leafSelector) => {
      const fixture = document.getElementById(id)
      const timeline = fixture.querySelector('.foxwarm-chat-timeline')
      const row = timeline.firstElementChild
      const message = row.firstElementChild
      const leaf = fixture.querySelector(leafSelector)
      const style = getComputedStyle(message)
      return {
        timeline: timeline.getBoundingClientRect().width,
        message: message.getBoundingClientRect().width,
        leaf: leaf.getBoundingClientRect().width,
        maxWidth: style.maxWidth,
        overflow: fixture.scrollWidth - fixture.clientWidth,
        timelineOverflowX: getComputedStyle(timeline).overflowX,
      }
    }
    return {
      shortModel: read('shortModel', '.foxwarm-assistant-message-card'),
      longModel: read('longModel', '.foxwarm-assistant-message-card'),
      shortTool: read('shortTool', '.foxwarm-tool-card'),
      longTool: read('longTool', '.foxwarm-tool-card'),
      shortUser: read('shortUser', '.foxwarm-user-message-bubble'),
      longUser: read('longUser', '.foxwarm-user-message-bubble'),
      nestedModel: read('nestedModel', '.foxwarm-assistant-message-card'),
      nestedUser: read('nestedUser', '.foxwarm-user-message-bubble'),
      systemMessage: read('systemMessage', '[data-system-message-card]'),
      nestedSystemMessage: read('nestedSystemMessage', '[data-system-message-card]'),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

function assertRatio(sample, expected, label) {
  const ratio = sample.message / sample.timeline
  assert.ok(Math.abs(ratio - expected) < 0.015, `${label} ratio ${ratio} should be ${expected}`)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the message-width browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:900px;max-width:100%;min-width:0}</style></head><body><main>${['shortModel', 'longModel', 'shortTool', 'longTool', 'shortUser', 'longUser', 'nestedModel', 'nestedUser', 'systemMessage', 'nestedSystemMessage'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

test('desktop preserves the longstanding 80% model/tool/system and capped user message contract', async () => {
  await mountFixture({ width: 1200, height: 900 })
  const widths = await readWidths()

  for (const key of ['shortModel', 'longModel', 'shortTool', 'longTool', 'systemMessage']) {
    assertRatio(widths[key], 0.8, key)
    assert.equal(widths[key].maxWidth, '80%')
  }
  assert.ok(widths.shortUser.message < widths.shortUser.timeline * 0.5, 'short user message remains content-sized')
  assertRatio(widths.longUser, 0.8, 'longUser')
  assert.equal(widths.shortUser.maxWidth, '80%')
  assert.equal(widths.longUser.maxWidth, '80%')
  assertRatio(widths.nestedModel, 1, 'nestedModel')
  assertRatio(widths.nestedUser, 0.85, 'nestedUser')
  assertRatio(widths.nestedSystemMessage, 1, 'nestedSystemMessage')

  for (const sample of Object.values(widths).filter(value => typeof value === 'object')) {
    assert.ok(sample.overflow <= 1)
    assert.equal(sample.timelineOverflowX, 'visible')
  }
  assert.ok(widths.documentOverflow <= 1)
})

test('mobile model/tool/system messages remain full-width without horizontal document overflow', async () => {
  await mountFixture({ width: 390, height: 760, style: '550a', dark: true })
  const widths = await readWidths()
  for (const key of ['shortModel', 'longModel', 'shortTool', 'longTool', 'systemMessage', 'nestedSystemMessage']) assertRatio(widths[key], 1, key)
  for (const sample of Object.values(widths).filter(value => typeof value === 'object')) {
    assert.ok(sample.overflow <= 1)
    assert.equal(sample.timelineOverflowX, 'visible')
  }
  assert.ok(widths.documentOverflow <= 1)
})
