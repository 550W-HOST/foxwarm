import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}

    const messages = [
      {
        role: 'user',
        parts: [{ text: '<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\\nfirst top-level card line\\nsecond top-level card line\\nthird top-level card line\\nfourth top-level card line\\n</foxwarm-message>' }],
        __meta: { seq: 1, timestamp: 1700000000000 },
      },
      {
        role: 'model',
        parts: [{ text: '[CTX-BLOCK L1 B#7 raw#2-#3] Top-level context summary' }],
        __meta: { seq: 2, timestamp: 1700000001000, contextBlock: { id: 7, level: 1, rawStartSeq: 2, rawEndSeq: 3, sourceKind: 'message' } },
      },
      {
        role: 'model',
        parts: [{ text: 'Final model row\\n\\n| heading one | heading two | heading three | heading four | heading five |\\n| --- | --- | --- | --- | --- |\\n| deliberately-wide-table-value-one | deliberately-wide-table-value-two | deliberately-wide-table-value-three | deliberately-wide-table-value-four | deliberately-wide-table-value-five |' }],
        __meta: { seq: 3, timestamp: 1700000002000, modelId: 'fixture/model', usage: { cachedTokens: 11, inputTokens: 22, outputTokens: 33 } },
      },
    ]

    const nestedMessages = [{
      role: 'user',
      parts: [{ text: '<foxwarm-system kind="event" type="nested-fixture">\\nnested card body line one\\nnested card body line two\\nnested card body line three\\n</foxwarm-system>' }],
      __meta: { seq: 21, timestamp: 1700000001500 },
    }]

    window.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/context-blocks/7/expand')) return new Response(JSON.stringify({ sessionId: 'fixture/main', blockId: 7, expansionKind: 'messages', target: 'B#7', previewLength: 6000, messages: nestedMessages }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/history')) return new Response(JSON.stringify({ session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, modelKey: 'fixture/model' }, messages, queuedMessages: [], queueLength: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [{ key: 'fixture/model', contextLimit: 128000 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/asr/status')) return new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404 })
    }

    class FixtureEventSource {
      static CLOSED = 2
      constructor() { this.readyState = 1; queueMicrotask(() => this.onopen?.({})) }
      close() { this.readyState = FixtureEventSource.CLOSED }
    }
    window.EventSource = FixtureEventSource

    createRoot(document.getElementById('root')).render(React.createElement(Chat, {
      sessionId: 'fixture/main',
      canonicalSessionId: 'fixture/main',
      sessionDisplayName: 'Fixture',
      showUsageBadge: true,
    }))
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'timeline-overflow-boundary-fixture.tsx' },
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

async function clickPoint(x, y) {
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
}

async function captureFixture(name) {
  const directory = process.env.FOXWARM_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: false })
}

async function assertThreadLineContract(cardSelector, lineSelector, { expectedWidth = 18, leftOffset = 10 } = {}) {
  const collapsed = await page.$eval(cardSelector, (card, lineSelector) => {
    const button = card.querySelector(lineSelector)
    const line = button.querySelector('span')
    const cardRect = card.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const lineRect = line.getBoundingClientRect()
    return {
      card: { left: cardRect.left, top: cardRect.top, bottom: cardRect.bottom },
      button: { left: buttonRect.left, right: buttonRect.right, top: buttonRect.top, bottom: buttonRect.bottom, width: buttonRect.width },
      line: { left: lineRect.left, width: lineRect.width },
      expanded: button.getAttribute('aria-expanded'),
    }
  }, lineSelector)

  assert.equal(collapsed.expanded, 'false')
  assert.equal(collapsed.button.width, expectedWidth, `gutter hit target is exactly 2px narrower than the former ${expectedWidth + 2}px target`)
  assert.ok(Math.abs(collapsed.button.left - (collapsed.card.left - leftOffset)) <= 0.5, 'left placement stays unchanged')
  assert.ok(Math.abs(collapsed.line.left - collapsed.card.left) <= 0.5, 'the visual 2px thread line stays aligned to the card edge')
  assert.equal(collapsed.line.width, 2)

  const outerGutterPoint = { x: collapsed.button.left + 2, y: (collapsed.button.top + collapsed.button.bottom) / 2 }
  assert.equal(await page.evaluate(({ x, y, lineSelector }) => document.elementFromPoint(x, y)?.closest(lineSelector) !== null, { ...outerGutterPoint, lineSelector }), true, 'outer gutter point remains owned by ThreadLineButton')
  await clickPoint(outerGutterPoint.x, outerGutterPoint.y)
  await page.waitForFunction(({ cardSelector, lineSelector }) => document.querySelector(cardSelector)?.querySelector(lineSelector)?.getAttribute('aria-expanded') === 'true', {}, { cardSelector, lineSelector })

  const expanded = await page.$eval(cardSelector, (card, lineSelector) => {
    const button = card.querySelector(lineSelector)
    const cardRect = card.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return {
      cardLeft: cardRect.left,
      cardBottom: cardRect.bottom,
      buttonRight: buttonRect.right,
      buttonBottom: buttonRect.bottom,
    }
  }, lineSelector)
  const removedCardSidePoint = { x: expanded.buttonRight + 1, y: Math.min(expanded.cardBottom, expanded.buttonBottom) - 3 }
  assert.ok(removedCardSidePoint.x < expanded.cardLeft + leftOffset, 'probe stays inside the exact 2px removed card-side strip')
  assert.equal(await page.evaluate(({ x, y, lineSelector }) => document.elementFromPoint(x, y)?.closest(lineSelector) !== null, { ...removedCardSidePoint, lineSelector }), false, 'the removed 2px card-side strip no longer belongs to ThreadLineButton')
  await clickPoint(removedCardSidePoint.x, removedCardSidePoint.y)
  assert.equal(await page.$eval(`${cardSelector} ${lineSelector}`, button => button.getAttribute('aria-expanded')), 'true', 'clicking the removed card-side strip does not collapse the expanded card')

  await clickPoint(outerGutterPoint.x, Math.min(expanded.cardBottom, expanded.buttonBottom) - 3)
  await page.waitForFunction(({ cardSelector, lineSelector }) => document.querySelector(cardSelector)?.querySelector(lineSelector)?.getAttribute('aria-expanded') === 'false', {}, { cardSelector, lineSelector })
}

before(async () => {
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the timeline overflow boundary browser test')
  const [css, bundle] = await Promise.all([readFile(new URL(cssAsset, assetsDirectory), 'utf8'), buildFixtureBundle()])

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.foxwarm-chat-root>header{display:none}.foxwarm-chat-root form{display:none}.foxwarm-chat-messages-content{padding-right:0!important}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 760, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('[data-system-message-card]')
  await page.waitForSelector('[data-usage-badge]')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('outer native message scroller owns malformed-child containment without clipping intentional inner paint', async () => {
  const overflowOwners = await page.$eval('[data-usage-badge]', badge => {
    const owners = []
    let current = badge.parentElement
    while (current && !current.classList.contains('foxwarm-chat-messages')) {
      const style = getComputedStyle(current)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        owners.push({ className: current.className, overflowX: style.overflowX, overflowY: style.overflowY })
      }
      current = current.parentElement
    }
    const outer = current
    const badgeStyle = getComputedStyle(badge)
    return {
      owners,
      outer: outer ? { overflowX: getComputedStyle(outer).overflowX, overflowY: getComputedStyle(outer).overflowY } : null,
      badgeShadow: badgeStyle.boxShadow,
    }
  })
  assert.deepEqual(overflowOwners.owners, [], `intermediate timeline boundaries must not clip the badge shadow: ${JSON.stringify(overflowOwners.owners)}`)
  assert.deepEqual(overflowOwners.outer, { overflowX: 'hidden', overflowY: 'auto' })
  assert.notEqual(overflowOwners.badgeShadow, 'none')

  const widths = await page.evaluate(() => {
    const timeline = document.querySelector('[data-chat-timeline="committed"] .foxwarm-chat-timeline')
    const oversized = document.createElement('div')
    oversized.id = 'malformed-oversized-child'
    oversized.style.width = '2400px'
    oversized.style.height = '1px'
    timeline.appendChild(oversized)
    const outer = document.querySelector('.foxwarm-chat-messages')
    const modelRow = document.querySelector('[data-chat-message-anchor-key="seq-local-3"] > div')
    const table = document.querySelector('.foxwarm-assistant-message-markdown table')
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outerOverflowX: getComputedStyle(outer).overflowX,
      outerHasOversizedContent: outer.scrollWidth > outer.clientWidth + 1000,
      modelWidth: modelRow.getBoundingClientRect().width,
      timelineWidth: timeline.getBoundingClientRect().width,
      tableOverflowX: getComputedStyle(table).overflowX,
      tableScrollable: table.scrollWidth > table.clientWidth + 1,
    }
  })
  assert.ok(widths.documentOverflow <= 1, `malformed child widened the document by ${widths.documentOverflow}px`)
  assert.equal(widths.outerOverflowX, 'hidden')
  assert.equal(widths.outerHasOversizedContent, true)
  assert.ok(widths.modelWidth <= widths.timelineWidth * 0.8 + 1, 'desktop model row keeps the 80% width contract')
  assert.equal(widths.tableOverflowX, 'auto')
  assert.equal(widths.tableScrollable, true)
  await page.$eval('[data-usage-badge]', badge => badge.scrollIntoView({ block: 'center' }))
  await captureFixture('usage-badge-outer-boundary')
})

test('top-level and nested thread-card gutters remain clickable with the 2px card-side reduction', async () => {
  await assertThreadLineContract('[data-system-message-card]', '.foxwarm-system-message-thread-line')

  const contextButton = await page.$('.foxwarm-context-block-header')
  await contextButton.click()
  await page.waitForSelector('.foxwarm-context-block-header ~ .min-w-0 .foxwarm-chat-timeline [data-system-message-card]')
  await assertThreadLineContract('.foxwarm-context-block-header ~ .min-w-0 .foxwarm-chat-timeline [data-system-message-card]', '.foxwarm-system-message-thread-line')
  await page.click('[data-chat-timeline="committed"] > .foxwarm-chat-timeline > div [data-system-message-card]')
  await page.click('.foxwarm-context-block-header ~ .min-w-0 .foxwarm-chat-timeline [data-system-message-card]')
  await captureFixture('top-level-and-nested-gutters')
  await page.click('[data-chat-timeline="committed"] > .foxwarm-chat-timeline > div [data-system-message-card] .foxwarm-system-message-thread-line')
  await page.click('.foxwarm-context-block-header ~ .min-w-0 .foxwarm-chat-timeline [data-system-message-card] .foxwarm-system-message-thread-line')
})

test('mobile keeps the same gutter placement and interaction with a 14px hit width', async () => {
  await page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await page.waitForFunction(() => document.querySelector('.foxwarm-system-message-thread-line')?.getBoundingClientRect().width === 14)
  await assertThreadLineContract('[data-chat-timeline="committed"] > .foxwarm-chat-timeline > div [data-system-message-card]', '.foxwarm-system-message-thread-line', { expectedWidth: 14, leftOffset: 8 })
  assert.ok(await page.$eval('.foxwarm-chat-messages', outer => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1 && getComputedStyle(outer).overflowX === 'hidden'))
})
