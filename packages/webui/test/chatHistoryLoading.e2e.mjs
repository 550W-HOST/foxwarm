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

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}

    window.fixtureRequests = []
    window.fixtureMessageBodies = []
    const messageResponseResolvers = []
    const historyResponseResolvers = []
    const stateProbeResolvers = []
    window.fixtureHistoryRequestCount = 0
    window.fixtureHistoryAbortCount = 0
    window.fixtureStateProbeCount = 0
    window.fixtureIgnoreHistoryAbort = false
    window.resolveFixtureHistory = (queueLength = 0, messages = [{ role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } }]) => {
      const entry = historyResponseResolvers.shift()
      if (!entry) throw new Error('No pending history request')
      entry.settled = true
      entry.resolve(new Response(JSON.stringify({
        session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle', busy: false, queueLength }, queueLength, modelKey: 'fixture/model' },
        messages,
        persistentMemorySnapshot: 'snapshot supplied by history',
        queuedMessages: [],
        queueLength,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    window.resolveFixtureStateProbe = () => stateProbeResolvers.shift()?.resolve(new Response(JSON.stringify({
      session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, modelKey: 'fixture/model' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    window.resolveFixtureStateProbeNotFound = () => stateProbeResolvers.shift()?.resolve(new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    window.resolveFixtureMessages = () => messageResponseResolvers.splice(0).forEach(entry => entry.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    window.rejectNextFixtureMessage = () => messageResponseResolvers.shift()?.reject(new TypeError('Failed to fetch'))

    window.fetch = async (input, init) => {
      const url = String(input)
      window.fixtureRequests.push(url)
      if (url.includes('/state')) {
        window.fixtureStateProbeCount += 1
        return new Promise((resolve, reject) => stateProbeResolvers.push({ resolve, reject }))
      }
      if (url.includes('/history')) {
        window.fixtureHistoryRequestCount += 1
        return new Promise((resolve, reject) => {
          const entry = { resolve, reject, settled: false }
          historyResponseResolvers.push(entry)
          init?.signal?.addEventListener('abort', () => {
            if (entry.settled) return
            window.fixtureHistoryAbortCount += 1
            if (window.fixtureIgnoreHistoryAbort) return
            entry.settled = true
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      if (url.includes('/message')) {
        window.fixtureMessageBodies.push(JSON.parse(init?.body || '{}'))
        return new Promise((resolve, reject) => messageResponseResolvers.push({ resolve, reject }))
      }
      if (url.includes('/debug-file')) return new Response(JSON.stringify({ resolvedPath: '/redacted/session.json', payload: { history: [], persistentMemorySnapshot: 'debug snapshot' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [{ key: 'fixture/model', contextLimit: 1000 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/asr/status')) return new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/commands')) return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    class FixtureEventSource {
      static CLOSED = 2
      static instances = []
      constructor() {
        this.readyState = 0
        this.opened = false
        this.pending = []
        FixtureEventSource.instances.push(this)
        if (!new URLSearchParams(window.location.search).has('manualSse')) queueMicrotask(() => this.open())
      }
      open() {
        if (this.readyState === FixtureEventSource.CLOSED || this.opened) return
        this.opened = true
        this.readyState = 1
        this.onopen?.({})
        queueMicrotask(() => this.pending.splice(0).forEach(payload => this.emit(payload)))
      }
      close() { this.readyState = FixtureEventSource.CLOSED }
      emit(payload) {
        if (!this.opened) { this.pending.push(payload); return }
        this.onmessage?.({ data: JSON.stringify(payload) })
      }
      fail() { this.onerror?.({}) }
    }
    window.EventSource = FixtureEventSource
    window.fixtureEventSourceCount = () => FixtureEventSource.instances.length
    window.openFixtureEventSource = () => FixtureEventSource.instances.at(-1)?.open()
    window.failFixtureEventSource = () => FixtureEventSource.instances.at(-1)?.fail()
    window.emitFixtureEvent = payload => FixtureEventSource.instances.at(-1)?.emit(payload)
    window.emitFixtureMessage = message => window.emitFixtureEvent({ type: 'message', message })

    createRoot(document.getElementById('root')).render(React.createElement(Chat, {
      sessionId: 'fixture/main', canonicalSessionId: 'fixture/main', sessionDisplayName: 'Fixture',
    }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'chat-history-loading-fixture.tsx' },
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

test('history snapshot is lazy-debug independent and a delayed response preserves newer SSE', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => typeof window.emitFixtureMessage === 'function')

  assert.equal(await page.evaluate(() => window.fixtureRequests.some(url => url.includes('/debug-file'))), false)

  await page.evaluate(() => window.emitFixtureMessage({
    role: 'model',
    parts: [{ text: 'new SSE answer' }],
    __meta: { seq: 2, timestamp: 20 },
  }))
  await page.waitForFunction(() => document.body.textContent.includes('new SSE answer'))

  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row') && document.body.textContent.includes('snapshot supplied by history'))

  const bodyText = await page.$eval('body', element => element.textContent)
  assert.ok(bodyText.indexOf('old history row') < bodyText.indexOf('new SSE answer'))
  assert.ok(await page.$('.foxwarm-context-scrollbar-segment[data-context-category="snapshot"]'), 'history snapshot feeds the context overview')
  assert.equal(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).length), 1)
  assert.equal(await page.evaluate(() => window.fixtureRequests.some(url => url.includes('/debug-file'))), false)

  await page.click('button[title="Session options"]')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info')?.click())
  await page.waitForFunction(() => window.fixtureRequests.some(url => url.includes('/debug-file')))
  assert.equal(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/debug-file')).length), 1)
  await page.close()
})

test('rapid A/B sends issue distinct identified requests without waiting for A response', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const composer = await page.$('textarea')
  await composer.type('A')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await composer.type('B')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 2)

  const sends = await page.evaluate(() => window.fixtureMessageBodies)
  assert.deepEqual(sends.map(send => send.parts[0].text), ['A', 'B'])
  assert.equal(new Set(sends.map(send => send.clientMessageId)).size, 2)
  assert.ok(sends.every(send => typeof send.clientMessageId === 'string' && send.clientMessageId.length > 0))
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.justify-end')]
    .map(row => row.textContent.trim())
    .filter(text => text === 'A' || text === 'B')), ['A', 'B'])
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.close()
})

test('same-session refresh triggers coalesce behind one in-flight history request and one trailing request', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1 && typeof window.emitFixtureEvent === 'function')

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 1, modelKey: 'fixture/model' },
  }))
  await new Promise(resolve => setTimeout(resolve, 150))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 2, modelKey: 'fixture/model' },
  }))
  await new Promise(resolve => setTimeout(resolve, 150))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 3, modelKey: 'fixture/model' },
  }))
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.deepEqual(await page.evaluate(() => ({
    requests: window.fixtureHistoryRequestCount,
    aborts: window.fixtureHistoryAbortCount,
  })), { requests: 1, aborts: 0 })

  await page.evaluate(() => window.resolveFixtureHistory(3))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.deepEqual(await page.evaluate(() => ({
    requests: window.fixtureHistoryRequestCount,
    aborts: window.fixtureHistoryAbortCount,
  })), { requests: 2, aborts: 0 })

  await page.evaluate(() => window.resolveFixtureHistory(3))
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.close()
})

test('a failed POST cannot remove an already reconciled persisted user row', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const composer = await page.$('textarea')
  await composer.type('accepted before failed response')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await page.waitForFunction(() => [...document.querySelectorAll('.justify-end')]
    .some(row => row.textContent.trim() === 'accepted before failed response'))
  await page.evaluate(() => {
    const clientMessageId = window.fixtureMessageBodies[0].clientMessageId
    window.emitFixtureMessage({
      role: 'user',
      parts: [{ text: 'accepted before failed response' }],
      __meta: { clientMessageId, seq: 2, timestamp: 20 },
    })
  })
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-2"]')
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-end')]
    .filter(row => row.textContent.trim() === 'accepted before failed response').length), 1)
  await page.evaluate(() => window.rejectNextFixtureMessage())
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.ok(await page.$('[data-chat-message-anchor-key="seq-local-2"]'))
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-start')]
    .some(row => row.textContent.trim() === 'Error: Failed to send message')), false)
  await page.close()
})

test('manually typed slash commands are sent without an optimistic row or client identity', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const composer = await page.$('textarea')
  await composer.type('/status')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)

  const request = await page.evaluate(() => window.fixtureMessageBodies[0])
  assert.equal(request.parts[0].text, '/status')
  assert.equal(request.clientMessageId, undefined)
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-end')]
    .some(row => row.textContent.trim() === '/status')), false)
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.close()
})

test('temporary command responses survive history refreshes in place but clear on reload', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.emitFixtureMessage({
    role: 'assistant',
    parts: [{ text: 'temporary status result' }],
    __meta: { temporary: true, isCommandResponse: true, timestamp: 15 },
  }))
  await page.waitForFunction(() => [...document.querySelectorAll('.justify-start')]
    .some(row => row.textContent.trim() === 'temporary status result'))

  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('old history row'))
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-start')]
    .some(row => row.textContent.trim() === 'temporary status result')), true)

  await page.evaluate(() => window.emitFixtureMessage({
    role: 'model',
    parts: [{ text: 'persisted after status' }],
    __meta: { seq: 2, timestamp: 20 },
  }))
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-2"]')
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 1, modelKey: 'fixture/model' },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'persisted after status' }], __meta: { seq: 2, timestamp: 20 } },
  ]))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(await page.evaluate(() => [...document.querySelector('.foxwarm-chat-timeline').children]
    .map(row => row.textContent.trim())
    .filter(text => ['old history row', 'temporary status result', 'persisted after status'].includes(text))), [
    'old history row',
    'temporary status result',
    'persisted after status',
  ])

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'persisted after status' }], __meta: { seq: 2, timestamp: 20 } },
  ]))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('persisted after status'))
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-start')]
    .some(row => row.textContent.trim() === 'temporary status result')), false)
  await page.close()
})

test('post-request stream state wins over an older history session snapshot', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: {
      id: 'fixture/main',
      busy: true,
      runtimeState: { state: 'requesting-model' },
      queueLength: 3,
      modelKey: 'live/model',
      cwd: '/live/cwd',
    },
  }))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-event',
    event: { type: 'model-stream-update', streamId: 'live-stream', text: 'live streaming text' },
  }))
  await page.waitForFunction(() => document.querySelector('[data-session-header-subtitle]')?.getAttribute('title') === '/live/cwd')
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)

  assert.equal(await page.$eval('[data-session-header-subtitle]', element => element.getAttribute('title')), '/live/cwd')
  assert.ok(await page.$('[title="live/model"]'))
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Thinking... • 3 queued messages will be inserted after this model response')), true)
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('live streaming text')), true)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 2)
  await page.close()
})

test('session deletion invalidates and defeats a delayed successful history response', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => {
    window.fixtureIgnoreHistoryAbort = true
    window.emitFixtureEvent({ type: 'session-deleted' })
  })
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Session not found.'))
  assert.equal(await page.evaluate(() => window.fixtureHistoryAbortCount), 1)

  await page.evaluate(() => window.resolveFixtureHistory())
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Session not found.')), true)
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.justify-end')]
    .some(row => row.textContent.trim() === 'old history row')), false)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.close()
})

test('initial and reconnect streams register before their single history snapshots', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => {
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed while initial stream opened' }], __meta: { seq: 2, timestamp: 20 } })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed while initial stream opened'))
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('old history row'))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.evaluate(() => {
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed while reconnect stream opened' }], __meta: { seq: 3, timestamp: 30 } })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed while reconnect stream opened'))
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'committed while initial stream opened' }], __meta: { seq: 2, timestamp: 20 } },
  ]))
  await new Promise(resolve => setTimeout(resolve, 150))

  const rootText = await page.$eval('.foxwarm-chat-root', element => element.textContent)
  assert.equal(rootText.includes('committed while initial stream opened'), true)
  assert.equal(rootText.includes('committed while reconnect stream opened'), true)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 2)
  await page.close()
})

test('a stream that fails before opening uses a lightweight state 404 to stop reconnecting', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureStateProbeCount === 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)
  await page.evaluate(() => window.resolveFixtureStateProbeNotFound())
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Session not found.'))
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(await page.evaluate(() => window.fixtureEventSourceCount()), 1)
  assert.equal(await page.evaluate(() => window.fixtureStateProbeCount), 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)
  await page.close()
})

test('repeated pre-open failures use only state probes until a stream opens', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureStateProbeCount === 1)
  await page.evaluate(() => window.resolveFixtureStateProbe())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureStateProbeCount === 2)
  await page.evaluate(() => window.resolveFixtureStateProbe())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 3, { timeout: 3500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => {
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed across pre-open failures' }], __meta: { seq: 2, timestamp: 20 } })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed across pre-open failures'))
  await page.evaluate(() => window.resolveFixtureHistory())
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(await page.evaluate(() => window.fixtureStateProbeCount), 2)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed across pre-open failures')), true)
  await page.close()
})
