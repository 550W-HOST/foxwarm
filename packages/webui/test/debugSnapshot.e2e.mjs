import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname
let browser
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}

    const originalStringify = JSON.stringify
    window.fixtureDebugCaptures = []
    JSON.stringify = function(value, ...args) {
      const text = originalStringify.call(this, value, ...args)
      if (value?.sessionId && value?.sessionPayload && value?.clientState) {
        window.fixtureDebugCaptures.push(text)
      }
      return text
    }

    window.fixtureDebugRequests = []
    window.fixtureDebugAbortCount = 0
    window.fixtureCopiedText = null
    const debugResponseResolvers = []
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: async text => { window.fixtureCopiedText = text } }),
    })

    window.resolveNextFixtureDebug = version => {
      const entry = debugResponseResolvers.shift()
      if (!entry) throw new Error('No pending debug request')
      entry.resolve(new Response(originalStringify({
        resolvedPath: '/fixture/session-' + version + '.json',
        payload: {
          history: [{ role: 'model', parts: [{ text: 'file-history-' + version }] }],
          persistentMemorySnapshot: 'file-snapshot-' + version,
          fixturePayloadVersion: version,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }

    window.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/debug-file')) {
        window.fixtureDebugRequests.push(url)
        return new Promise(resolve => {
          const entry = { resolve }
          debugResponseResolvers.push(entry)
          init?.signal?.addEventListener('abort', () => { window.fixtureDebugAbortCount += 1 }, { once: true })
        })
      }
      if (url.includes('/history')) {
        const sessionId = decodeURIComponent(url.match(/sessions\\/(.*?)\\/history/)?.[1] || 'unknown')
        return new Response(originalStringify({
          session: { id: sessionId, displayName: sessionId, busy: false, runtimeState: { state: 'idle' }, queueLength: 0, modelKey: 'fixture/model' },
          messages: [{ role: 'user', parts: [{ text: 'history-' + sessionId }], __meta: { seq: 1, timestamp: 1 } }],
          persistentMemorySnapshot: '',
          queuedMessages: [],
          queueLength: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/models')) return new Response(originalStringify({ models: [{ key: 'fixture/model', contextLimit: 1000 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/asr/status')) return new Response(originalStringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/commands')) return new Response(originalStringify({ commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
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
      emit(payload) { this.onmessage?.({ data: originalStringify(payload) }) }
    }
    window.EventSource = FixtureEventSource
    window.emitFixtureEvent = payload => FixtureEventSource.instances.at(-1)?.emit(payload)

    const root = createRoot(document.getElementById('root'))
    window.renderFixture = sessionId => root.render(React.createElement(Chat, {
      sessionId,
      canonicalSessionId: sessionId,
      sessionDisplayName: 'Display ' + sessionId,
    }))
    window.unmountFixture = () => root.unmount()
    window.renderFixture('fixture/main')
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'debug-snapshot-fixture.tsx' },
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

async function openDebug(page) {
  await page.click('button[title="Session options"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'debug info'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info')?.click())
}

async function closeDebug(page) {
  await page.click('button[title="Close"]')
  await page.waitForFunction(() => !document.querySelector('[data-debug-info-json]'))
}

before(async () => {
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>html,body,#root{width:100%;height:100%;margin:0}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('debug JSON is captured only on explicit open or refresh and remains immutable between captures', async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('history-fixture/main'))

  await page.evaluate(() => {
    window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', displayName: 'state-before-open', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, modelKey: 'fixture/model' } })
    window.emitFixtureEvent({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'stream', text: 'stream-before-open' } })
  })
  await page.waitForFunction(() => document.body.textContent.includes('stream-before-open'))
  assert.deepEqual(await page.evaluate(() => ({ requests: window.fixtureDebugRequests.length, captures: window.fixtureDebugCaptures.length })), { requests: 0, captures: 0 })

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 1)
  await page.evaluate(() => window.resolveNextFixtureDebug(1))
  await page.waitForFunction(() => document.querySelector('[data-debug-info-json]')?.textContent.includes('"fixturePayloadVersion": 1'))
  const firstSnapshot = await page.$eval('[data-debug-info-json]', element => element.textContent)
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 1)
  assert.match(firstSnapshot, /history-fixture\/main/)
  assert.match(firstSnapshot, /stream-before-open/)
  assert.doesNotMatch(firstSnapshot, /file-history-1/, 'file history remains overridden by live history')

  await page.evaluate(() => {
    window.emitFixtureEvent({ type: 'message', message: { role: 'model', parts: [{ text: 'message-after-open' }], __meta: { seq: 2, timestamp: 2 } } })
    window.emitFixtureEvent({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'stream', text: 'stream-after-open' } })
    window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', displayName: 'state-after-open', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, modelKey: 'fixture/model' } })
  })
  await page.waitForFunction(() => document.body.textContent.includes('message-after-open'))
  assert.equal(await page.$eval('[data-debug-info-json]', element => element.textContent), firstSnapshot)
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 1)

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'copy')?.click())
  await page.waitForFunction(() => window.fixtureCopiedText !== null)
  assert.equal(await page.evaluate(() => window.fixtureCopiedText), firstSnapshot)

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'refresh')?.click())
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 2)
  await page.evaluate(() => window.resolveNextFixtureDebug(2))
  await page.waitForFunction(() => document.querySelector('[data-debug-info-json]')?.textContent.includes('"fixturePayloadVersion": 2'))
  const refreshedSnapshot = await page.$eval('[data-debug-info-json]', element => element.textContent)
  assert.notEqual(refreshedSnapshot, firstSnapshot)
  assert.match(refreshedSnapshot, /message-after-open/)
  assert.match(refreshedSnapshot, /stream-after-open/)
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 2)

  await closeDebug(page)
  await page.evaluate(() => window.emitFixtureEvent({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'stream', text: 'stream-after-close' } }))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(await page.evaluate(() => ({ requests: window.fixtureDebugRequests.length, captures: window.fixtureDebugCaptures.length })), { requests: 2, captures: 2 })

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 3)
  await page.evaluate(() => window.resolveNextFixtureDebug(3))
  await page.waitForFunction(() => document.querySelector('[data-debug-info-json]')?.textContent.includes('"fixturePayloadVersion": 3'))
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 3)
  assert.match(await page.$eval('[data-debug-info-json]', element => element.textContent), /stream-after-close/)
  await page.close()
})

test('close, session change, and unmount abort and invalidate delayed debug captures', async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('history-fixture/main'))

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 1)
  await closeDebug(page)
  await page.waitForFunction(() => window.fixtureDebugAbortCount === 1)
  await page.evaluate(() => window.resolveNextFixtureDebug(1))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 0)

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 2)
  await page.evaluate(() => window.resolveNextFixtureDebug(2))
  await page.waitForFunction(() => window.fixtureDebugCaptures.length === 1)
  await closeDebug(page)

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 3)
  await page.evaluate(() => window.renderFixture('fixture/other'))
  await page.waitForFunction(() => window.fixtureDebugAbortCount === 2 && document.body.textContent.includes('history-fixture/other'))
  await page.evaluate(() => window.resolveNextFixtureDebug(3))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 1)
  assert.equal(await page.$('[data-debug-info-json]'), null)

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 4)
  await page.evaluate(() => window.resolveNextFixtureDebug(4))
  await page.waitForFunction(() => window.fixtureDebugCaptures.length === 2)
  assert.match(await page.$eval('[data-debug-info-json]', element => element.textContent), /"sessionId": "fixture\/other"/)
  await closeDebug(page)

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 5)
  await page.evaluate(() => window.unmountFixture())
  await page.waitForFunction(() => window.fixtureDebugAbortCount === 3)
  await page.evaluate(() => window.resolveNextFixtureDebug(5))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 2)
  assert.equal(await page.$('.foxwarm-chat-root'), null)
  await page.close()
})
