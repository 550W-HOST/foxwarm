import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const reasoningEntry = new URL('../src/components/ReasoningCard.tsx', import.meta.url).pathname
const webSearchEntry = new URL('../src/components/WebSearchCard.tsx', import.meta.url).pathname
const contextEntry = new URL('../src/components/ContextBlockCard.tsx', import.meta.url).pathname
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
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import ReasoningCard from ${JSON.stringify(reasoningEntry)}
    import WebSearchCard from ${JSON.stringify(webSearchEntry)}
    import ContextBlockCard from ${JSON.stringify(contextEntry)}
    import { ToolCallsBlock } from ${JSON.stringify(toolEntry)}

    const longPath = '/workspace/' + 'aligned-segment/'.repeat(18) + 'read-target.tsx'
    const read = { role: 'model', parts: [{ functionCall: { id: 'read-align', name: 'read', args: { filePath: longPath, startLine: 7, endLine: 19 } } }] }
    const shortRead = { role: 'model', parts: [{ functionCall: { id: 'read-short', name: 'read', args: { filePath: '/workspace/read-target.tsx', startLine: 7, endLine: 19 } } }] }
    createRoot(document.getElementById('read')).render(React.createElement(ToolCallsBlock, { msg: read, onOpenCodeFile: () => {} }))
    createRoot(document.getElementById('read-short')).render(React.createElement(ToolCallsBlock, { msg: shortRead, onOpenCodeFile: () => {} }))
    createRoot(document.getElementById('reasoning')).render(React.createElement(ReasoningCard, { thinking: 'reasoning preview', tone: 'message', defaultExpanded: false }))
    createRoot(document.getElementById('web-search')).render(React.createElement(WebSearchCard, { action: { type: 'search', query: 'web search preview', queries: ['web search preview'] } }))
    createRoot(document.getElementById('event')).render(React.createElement(ChatTimeline, { sessionId: 'fixture/main', messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="event" type="wait-timeout">\\nevent preview\\n</foxwarm-system>' }] }], isMobile: window.innerWidth < 768, groupTools: false, showUsageBadge: false }))
    createRoot(document.getElementById('context')).render(React.createElement(ContextBlockCard, { sessionId: 'fixture/main', messageKey: 'context', block: { id: 1, level: 1, rawStartSeq: 1, rawEndSeq: 2 }, text: 'context summary', nestedDepth: 0, renderNestedMessages: () => null }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'thread-card-header-alignment-fixture.tsx' },
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

async function mountFixture({ width, dark }) {
  await page.setViewport({ width, height: 720, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-tag, .foxwarm-reasoning-tag, .foxwarm-web-search-tag, .foxwarm-system-message-tag').length >= 4)
}

async function readAlignment() {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector)
      const box = element.getBoundingClientRect()
      return { top: box.top, right: box.right, bottom: box.bottom, height: box.height, center: box.top + box.height / 2 }
    }
    const centerDelta = (left, right) => Math.abs(left.center - right.center)
    const readTag = rect('#read .foxwarm-tool-tag')
    const readSummary = rect('#read .foxwarm-tool-call-summary')
    const readCode = rect('#read .foxwarm-tool-code-open')
    const readPath = rect('#read .foxwarm-tool-code-path')
    const readRange = rect('#read .foxwarm-tool-read-range')
    const shortReadPath = rect('#read-short .foxwarm-tool-code-path')
    const shortReadRange = rect('#read-short .foxwarm-tool-read-range')
    const eventTag = rect('#event .foxwarm-system-message-tag')
    const eventPreview = rect('#event .foxwarm-system-message-preview')
    const reasoningTag = rect('#reasoning .foxwarm-reasoning-tag')
    const reasoningPreview = rect('#reasoning .foxwarm-reasoning-preview')
    const webSearchTag = rect('#web-search .foxwarm-web-search-tag')
    const webSearchPreview = rect('#web-search .foxwarm-web-search-preview')
    const contextTag = rect('#context .foxwarm-context-block-tag')
    const contextPreview = rect('#context .foxwarm-context-block-preview')
    const readSummaryElement = document.querySelector('#read .foxwarm-tool-call-summary')
    const readPathElement = document.querySelector('#read .foxwarm-tool-code-path')
    const readRangeElement = document.querySelector('#read .foxwarm-tool-read-range')
    return {
      deltas: {
        readTagSummary: centerDelta(readTag, readSummary),
        readTagCode: centerDelta(readTag, readCode),
        readTagPath: centerDelta(readTag, readPath),
        readTagRange: centerDelta(readTag, readRange),
        event: centerDelta(eventTag, eventPreview),
        reasoning: centerDelta(reasoningTag, reasoningPreview),
        webSearch: centerDelta(webSearchTag, webSearchPreview),
        context: centerDelta(contextTag, contextPreview),
      },
      read: {
        summaryHeight: readSummary.height,
        summaryRight: readSummary.right,
        pathRight: readPath.right,
        rangeRight: readRange.right,
        shortRangePathGap: shortReadRange.left - shortReadPath.right,
        rangeVisible: readRange.right <= readSummary.right + 0.5,
        pathOverflow: readPathElement.scrollWidth > readPathElement.clientWidth,
        summaryOverflow: readSummaryElement.scrollWidth > readSummaryElement.clientWidth,
        rangeWhiteSpace: getComputedStyle(readRangeElement).whiteSpace,
      },
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the thread-card alignment browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:900px;max-width:100%;min-width:0;margin-bottom:12px}</style></head><body><main>${['read', 'read-short', 'reasoning', 'web-search', 'event', 'context'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

test('collapsed thread-card headers share an aligned tag and one-line preview rhythm', async () => {
  for (const fixture of [{ width: 1200, dark: false }, { width: 1200, dark: true }, { width: 390, dark: false }, { width: 390, dark: true }]) {
    await mountFixture(fixture)
    const layout = await readAlignment()
    for (const delta of Object.values(layout.deltas)) assert.ok(delta <= 0.5, `${JSON.stringify(fixture)} header centers align`)
    assert.equal(layout.read.summaryHeight, 18)
    assert.equal(layout.read.rangeVisible, true)
    assert.ok(layout.read.shortRangePathGap <= 5, 'a direct read range stays next to its path instead of filling the shared header')
    assert.equal(layout.read.pathOverflow, true, 'the long path truncates before the fixed line range')
    assert.equal(layout.read.summaryOverflow, false)
    assert.equal(layout.read.rangeWhiteSpace, 'nowrap')
    assert.ok(layout.documentOverflow <= 1)
  }
})
