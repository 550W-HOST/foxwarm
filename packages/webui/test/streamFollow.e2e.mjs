import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname

let browser
let page
let server
let fixtureUrl

const fixtureCss = `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font: 14px sans-serif; }
  #root { width: 100%; height: 100%; }
  .foxwarm-chat-root { display: flex; height: 100%; flex-direction: column; overflow: hidden; }
  .foxwarm-chat-root > header { flex: 0 0 48px; }
  .foxwarm-chat-message-region { position: relative; min-height: 0; flex: 1 1 auto; }
  .foxwarm-chat-messages { height: 100%; overflow-y: auto; padding: 8px; }
  .foxwarm-chat-root form { display: none; }
  [data-chat-message-anchor-key] { min-height: 68px; }
  .foxwarm-assistant-message-card { line-height: 18px; }
  .foxwarm-markdown p { margin: 0; }
`

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}

    const messages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'model',
      parts: [{ text: 'persisted message ' + index }],
      __meta: { seq: index + 1, timestamp: 1000 + index },
    }))

    window.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          session: { id: 'fixture/main', busy: true, runtimeState: 'requesting-model', queueLength: 0 },
          messages,
          queuedMessages: [],
          queueLength: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/asr/status')) {
        return new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    class FixtureEventSource {
      static CLOSED = 2
      static instances = []
      constructor() {
        this.readyState = 1
        FixtureEventSource.instances.push(this)
        queueMicrotask(() => this.onopen?.({}))
      }
      close() { this.readyState = FixtureEventSource.CLOSED }
      emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
    }
    window.EventSource = FixtureEventSource

    let streamLines = []
    window.appendStreamLine = (line) => {
      streamLines.push(line)
      FixtureEventSource.instances.at(-1)?.emit({
        type: 'session-event',
        event: {
          type: 'model-stream-update',
          streamId: 'fixture-stream',
          text: streamLines.join('\\n\\n'),
        },
      })
    }
    window.resetFixtureStream = () => { streamLines = [] }

    createRoot(document.getElementById('root')).render(
      React.createElement(Chat, {
        sessionId: 'fixture/main',
        canonicalSessionId: 'fixture/main',
        sessionDisplayName: 'Fixture chat',
      }),
    )
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'stream-follow-fixture.tsx' },
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

async function appendLines(count, prefix = 'stream') {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate((line) => window.appendStreamLine(line), `${prefix} ${index} ${'content '.repeat(12)}`)
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
}

async function readPosition() {
  return page.$eval('.foxwarm-chat-messages', (container) => ({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
  }))
}

async function scrollToBottom() {
  await page.$eval('.foxwarm-chat-messages', (container) => {
    container.scrollTop = container.scrollHeight
    container.dispatchEvent(new Event('scroll'))
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
}

async function mountFixture({ width, height, mobile = false }) {
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-messages')
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 24)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await scrollToBottom()
}

before(async () => {
  const bundle = await buildFixtureBundle()
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${fixtureCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  fixtureUrl = `http://127.0.0.1:${address.port}`

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})

test('desktop streaming follow latches user wheel/scrollbar intent and rejoins only at bottom', async () => {
  await mountFixture({ width: 900, height: 620 })
  await appendLines(10, 'initial')
  assert.ok((await readPosition()).distanceFromBottom <= 2, 'untouched streaming should follow the bottom')

  await page.hover('.foxwarm-chat-messages')
  await page.mouse.wheel({ deltaY: -90 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const afterWheel = await readPosition()
  assert.ok(afterWheel.distanceFromBottom > 10, 'wheel up should leave the bottom')

  await appendLines(10, 'after-wheel')
  const afterContinuedStream = await readPosition()
  assert.ok(afterContinuedStream.distanceFromBottom > afterWheel.distanceFromBottom, 'continued streaming must not pull the user back down')
  assert.ok(Math.abs(afterContinuedStream.scrollTop - afterWheel.scrollTop) <= 3, 'the user viewport should remain stable during continued streaming')

  await scrollToBottom()
  await appendLines(6, 'rejoined')
  assert.ok((await readPosition()).distanceFromBottom <= 2, 'returning to the bottom should resume follow')

  await page.$eval('.foxwarm-chat-messages', (container) => {
    const rect = container.getBoundingClientRect()
    container.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse', buttons: 1, clientX: rect.right - 1, clientY: rect.top + rect.height / 2, bubbles: true }))
    container.scrollTop -= 120
    container.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'mouse', bubbles: true }))
  })
  const afterScrollbar = await readPosition()
  await appendLines(5, 'after-scrollbar')
  const afterScrollbarStream = await readPosition()
  assert.ok(Math.abs(afterScrollbarStream.scrollTop - afterScrollbar.scrollTop) <= 3, 'scrollbar drag away should also latch the viewport')
})

test('mobile touch scrolling leaves streaming follow until the user returns to bottom', async () => {
  await mountFixture({ width: 390, height: 760, mobile: true })
  await appendLines(10, 'mobile-initial')
  assert.ok((await readPosition()).distanceFromBottom <= 2)

  await page.$eval('.foxwarm-chat-messages', (container) => {
    const makeTouch = (clientY) => new Touch({ identifier: 1, target: container, clientX: 100, clientY })
    container.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(280)], bubbles: true }))
    container.dispatchEvent(new TouchEvent('touchmove', { touches: [makeTouch(370)], bubbles: true }))
    container.scrollTop -= 100
    container.dispatchEvent(new Event('scroll'))
    container.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }))
  })
  const afterTouch = await readPosition()
  assert.ok(afterTouch.distanceFromBottom > 10)
  await appendLines(8, 'mobile-after-touch')
  const afterTouchStream = await readPosition()
  assert.ok(Math.abs(afterTouchStream.scrollTop - afterTouch.scrollTop) <= 3, 'touch-scrolled viewport should stay stable while tokens arrive')

  await scrollToBottom()
  await appendLines(5, 'mobile-rejoined')
  assert.ok((await readPosition()).distanceFromBottom <= 2)
})