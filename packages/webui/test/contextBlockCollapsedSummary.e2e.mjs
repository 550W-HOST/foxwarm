import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const contextEntry = new URL('../src/components/ContextBlockCard.tsx', import.meta.url).pathname
const modelThreadEntry = new URL('../src/components/ModelThreadCard.tsx', import.meta.url).pathname
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ContextBlockCard from ${JSON.stringify(contextEntry)}
    import ModelThreadCard from ${JSON.stringify(modelThreadEntry)}
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import { InterleavedToolGroup } from ${JSON.stringify(toolEntry)}

    const longSummary = 'Long collapsed CTX summary content '.repeat(45) + 'CTX SUMMARY HIDDEN END'
    window.fixtureExpansionFetches = 0
    window.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/context-blocks/42/expand')) {
        window.fixtureExpansionFetches += 1
        return new Response(JSON.stringify({
          sessionId: 'fixture/main',
          blockId: 42,
          expansionKind: 'messages',
          target: 'B#42',
          previewLength: 6000,
          messages: [{ role: 'model', parts: [{ text: 'EXPANDED ARCHIVE CHILD' }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }

    const renderNestedMessages = (messages) => React.createElement(
      'div',
      { 'data-expanded-archive': 'true' },
      messages[0]?.parts?.[0]?.text,
    )
    const mountContext = (id, blockId, summary) => createRoot(document.getElementById(id)).render(React.createElement(ContextBlockCard, {
      sessionId: 'fixture/main',
      messageKey: id,
      block: { id: blockId, level: 1, rawStartSeq: 10, rawEndSeq: 20, sourceKind: 'message' },
      text: '[CTX-BLOCK L1 B#' + blockId + ' raw#10-#20] ' + summary,
      nestedDepth: 0,
      renderNestedMessages,
    }))
    mountContext('ctx-short', 41, 'Short CTX summary.')
    mountContext('ctx-long', 42, longSummary)

    const mountModelThread = (id, preview) => createRoot(document.getElementById(id)).render(React.createElement(ModelThreadCard, {
      kind: 'reasoning',
      label: 'Reasoning',
      preview,
      defaultExpanded: false,
    }, React.createElement('div', null, 'expanded reasoning')))
    mountModelThread('header-short', 'Short preview')
    mountModelThread('header-long', 'Long single-line model-thread preview '.repeat(35))
    mountModelThread('header-responsive', 'Responsive width preview '.repeat(3))

    const systemCases = {
      'system-short': '<foxwarm-system kind="event" type="short">\\nShort system preview.\\n</foxwarm-system>',
      'system-long': '<foxwarm-system kind="event" type="long">\\n' + 'Long system header preview '.repeat(35) + '\\n</foxwarm-system>',
      'system-body-short': '<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\\nOne body line.\\n</foxwarm-message>',
      'system-body-long': '<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\\n' + ['body line one', 'body line two', 'body line three', 'body line four', 'body line five'].join('\\n') + '\\n</foxwarm-message>',
    }
    for (const [id, text] of Object.entries(systemCases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages: [{ role: 'user', parts: [{ text }], __meta: { seq: id } }],
        isMobile: true,
        groupTools: false,
        showUsageBadge: false,
      }))
    }

    const mountTool = (id, output) => {
      const call = { role: 'model', parts: [{ functionCall: { id: id + '-call', name: 'exec', args: { command: 'printf short' } } }] }
      const result = { role: 'tool', parts: [{ functionResponse: { tool_use_id: id + '-call', name: 'exec', response: { output } } }] }
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, { msg: call, nextMsg: result, messageKeyPrefix: id }))
    }
    mountTool('tool-body-short', 'short tool result')
    mountTool('tool-body-long', 'A'.repeat(450) + 'BEYOND_400' + 'B'.repeat(300) + 'WITHIN_800' + 'C'.repeat(100) + 'BEYOND_800' + 'FULL_OUTPUT_END')
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'thread-card-overflow-fade-fixture.tsx' },
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

async function readOverflow(selector) {
  return page.$eval(selector, element => {
    const style = getComputedStyle(element)
    return {
      fade: element.getAttribute('data-overflow-fade'),
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      lineHeight: Number.parseFloat(style.lineHeight),
      maxHeight: style.maxHeight,
      maskImage: style.maskImage || style.webkitMaskImage,
    }
  })
}

before(async () => {
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the thread-card overflow fade browser test')
  const [css, bundle] = await Promise.all([readFile(new URL(cssAsset, assetsDirectory), 'utf8'), buildFixtureBundle()])

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const ids = ['ctx-short', 'ctx-long', 'header-short', 'header-long', 'header-responsive', 'system-short', 'system-long', 'system-body-short', 'system-body-long', 'tool-body-short', 'tool-body-long']
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{box-sizing:border-box;width:900px;max-width:100%;padding:16px}.fixture{min-width:0;margin-bottom:12px}</style></head><body><main>${ids.map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 480, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-context-block-preview').length === 2)
  await page.waitForFunction(() => document.querySelectorAll('[data-overflow-fade]').length >= 5)
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('collapsed CTX-BLOCK clamps to five lines, fades only real overflow, and stays lazy', async () => {
  const short = await readOverflow('#ctx-short .foxwarm-markdown')
  const long = await readOverflow('#ctx-long .foxwarm-markdown')

  assert.equal(short.fade, null)
  assert.ok(short.scrollHeight <= short.clientHeight + 1)
  assert.equal(long.fade, 'bottom')
  assert.ok(long.scrollHeight > long.clientHeight + 1)
  assert.ok(Math.abs(long.clientHeight / long.lineHeight - 5) <= 0.1, `CTX clamp should expose exactly five line boxes: ${JSON.stringify(long)}`)
  assert.match(long.maxHeight, /5/)
  assert.notEqual(long.maskImage, 'none')
  assert.equal(await page.evaluate(() => window.fixtureExpansionFetches), 0)
  assert.equal(await page.$('#ctx-long [data-expanded-archive]'), null)

  await page.click('#ctx-long .foxwarm-context-block-preview')
  await page.waitForSelector('#ctx-long [data-expanded-archive]')
  assert.equal(await page.evaluate(() => window.fixtureExpansionFetches), 1)
  assert.equal(await page.$eval('#ctx-long [data-expanded-archive]', element => element.textContent), 'EXPANDED ARCHIVE CHILD')
  assert.equal(await page.$eval('#ctx-long .foxwarm-markdown', element => element.getAttribute('data-overflow-fade')), null)
})

test('single-line thread headers add a right fade only when their preview is clipped', async () => {
  const modelShort = await readOverflow('#header-short .foxwarm-reasoning-preview')
  const modelLong = await readOverflow('#header-long .foxwarm-reasoning-preview')
  const systemShort = await readOverflow('#system-short .foxwarm-system-message-preview')
  const systemLong = await readOverflow('#system-long .foxwarm-system-message-preview')

  for (const sample of [modelShort, systemShort]) assert.equal(sample.fade, null)
  for (const sample of [modelLong, systemLong]) {
    assert.equal(sample.fade, 'right')
    assert.ok(sample.scrollWidth > sample.clientWidth + 1)
    assert.notEqual(sample.maskImage, 'none')
  }
})

test('overflow measurement responds to width changes without polling', async () => {
  assert.equal(await page.$eval('#header-responsive .foxwarm-reasoning-preview', element => element.getAttribute('data-overflow-fade')), 'right')
  await page.setViewport({ width: 1200, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.waitForFunction(() => document.querySelector('#header-responsive .foxwarm-reasoning-preview')?.getAttribute('data-overflow-fade') === null)
  await page.setViewport({ width: 480, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await page.waitForFunction(() => document.querySelector('#header-responsive .foxwarm-reasoning-preview')?.getAttribute('data-overflow-fade') === 'right')
})

test('multi-line System and Tool result previews add a bottom fade only when clamped', async () => {
  const systemShort = await readOverflow('#system-body-short .foxwarm-system-message-result-preview')
  const systemLong = await readOverflow('#system-body-long .foxwarm-system-message-result-preview')
  const toolShort = await readOverflow('#tool-body-short .foxwarm-tool-result-preview')
  const toolLong = await readOverflow('#tool-body-long .foxwarm-tool-result-preview')

  for (const sample of [systemShort, toolShort]) assert.equal(sample.fade, null)
  for (const sample of [systemLong, toolLong]) {
    assert.equal(sample.fade, 'bottom')
    assert.ok(sample.scrollHeight > sample.clientHeight + 1)
    assert.notEqual(sample.maskImage, 'none')
  }
})

test('wide collapsed Tool body samples 800 characters before the independent three-line fade clamp', async () => {
  await page.setViewport({ width: 1200, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.waitForFunction(() => document.querySelector('#tool-body-long .foxwarm-tool-result-preview')?.getAttribute('data-overflow-fade') === 'bottom')
  const collapsed = await page.$eval('#tool-body-long .foxwarm-tool-result-preview', element => ({
    text: element.textContent,
    fade: element.getAttribute('data-overflow-fade'),
    overflowing: element.scrollHeight > element.clientHeight + 1,
  }))
  assert.equal(collapsed.fade, 'bottom')
  assert.equal(collapsed.overflowing, true)
  assert.ok(collapsed.text.includes('BEYOND_400'), 'collapsed DOM keeps source content beyond the former 400-character cap')
  assert.ok(collapsed.text.includes('WITHIN_800'), 'collapsed DOM keeps source content within the new 800-character sample')
  assert.equal(collapsed.text.includes('BEYOND_800'), false)
  assert.equal(collapsed.text.length, 803, '800 sampled characters plus the truncation marker')

  await page.click('#tool-body-long .foxwarm-tool-tag')
  await page.waitForSelector('#tool-body-long .foxwarm-tool-expanded-content')
  const expanded = await page.$eval('#tool-body-long .foxwarm-tool-expanded-content', element => element.textContent)
  assert.ok(expanded.includes('BEYOND_800'))
  assert.ok(expanded.includes('FULL_OUTPUT_END'))
})
