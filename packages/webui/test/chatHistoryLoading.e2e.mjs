import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = fileURLToPath(new URL('../src/components/Chat.tsx', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
    import { storeChatViewportState } from './src/chatViewportState'

    if (new URLSearchParams(location.search).has('restoreOldAnchor')) {
      storeChatViewportState('fixture/main', { kind: 'anchor', messageKey: 'seq-local-1', offsetPx: 24 })
    }

    window.fixtureRequests = []
    window.fixtureMessageBodies = []
    const messageResponseResolvers = []
    const historyResponseResolvers = []
    const stateProbeResolvers = []
    window.fixtureHistoryRequestCount = 0
    window.fixtureHistoryAbortCount = 0
    window.fixtureStateProbeCount = 0
    window.fixtureIgnoreHistoryAbort = false
    window.resolveFixtureHistory = (queueLength = 0, messages = [{ role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } }], historyVersion = 0, extras = {}) => {
      const entry = historyResponseResolvers.shift()
      if (!entry) throw new Error('No pending history request')
      entry.settled = true
      const latestSeq = extras.latestSeq ?? messages.reduce((latest, message) => Math.max(latest, message.__meta?.seq || 0), 0)
      entry.resolve(new Response(JSON.stringify({
        session: { id: extras.sessionId || 'fixture/main', busy: false, runtimeState: { state: 'idle', busy: false, queueLength }, queueLength, messageCount: extras.messageCount ?? messages.length, historyVersion, modelKey: 'fixture/model' },
        messages,
        persistentMemorySnapshot: 'snapshot supplied by history',
        queuedMessages: [],
        queueLength,
        latestSeq,
        historyVersion,
        prefixLength: extras.prefixLength ?? 0,
        historyComplete: extras.historyComplete ?? (extras.prefixLength ?? 0) === 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    window.rejectFixtureHistory = (status = 500, code = 'HISTORY_FAILED') => {
      const entry = historyResponseResolvers.shift()
      if (!entry) throw new Error('No pending history request')
      entry.settled = true
      entry.resolve(new Response(JSON.stringify({ error: 'history failed', code }), { status, headers: { 'Content-Type': 'application/json' } }))
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
      const bootstrapFailure = new URLSearchParams(location.search).has('bootstrapFailure')
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
      if (url.includes('/upload')) {
        const file = init?.body?.get?.('file')
        return new Response(JSON.stringify({ path: '/fixture/upload', filename: file?.name || 'attachment', mimeType: file?.type || 'application/octet-stream', size: file?.size || 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/message')) {
        window.fixtureMessageBodies.push(JSON.parse(init?.body || '{}'))
        return new Promise((resolve, reject) => messageResponseResolvers.push({ resolve, reject }))
      }
      if (url.includes('/debug-file')) return new Response(JSON.stringify({ resolvedPath: '/redacted/session.json', payload: { history: [], persistentMemorySnapshot: 'debug snapshot' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/models')) return bootstrapFailure
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ models: [{ key: 'fixture/model', contextLimit: 1000 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/asr/status')) return bootstrapFailure
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/commands')) return bootstrapFailure ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ commands: [
        { name: '/status', description: 'Show status', usage: '/status', requiresSession: true },
        { name: '/session', description: 'Manage sessions', usage: '/session', requiresSession: true },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    class FixtureWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      static instances = []
      constructor() {
        this.readyState = FixtureWebSocket.CONNECTING
        this.opened = false
        this.pending = []
        FixtureWebSocket.instances.push(this)
        if (!new URLSearchParams(window.location.search).has('manualSse')) queueMicrotask(() => this.open())
      }
      open() {
        if (this.readyState === FixtureWebSocket.CLOSED || this.opened) return
        this.opened = true
        this.readyState = FixtureWebSocket.OPEN
        this.onopen?.({})
        queueMicrotask(() => this.pending.splice(0).forEach(payload => this.emit(payload)))
      }
      close() { this.readyState = FixtureWebSocket.CLOSED }
      send(raw) {
        const payload = JSON.parse(raw)
        if (payload.type !== 'set-subscriptions') return
        queueMicrotask(() => {
          this.emit({ type: 'subscriptions-accepted', revision: payload.revision,
            sessionListResolutions: Object.fromEntries(payload.sessionListIds.map(id => [id, id])),
            sessionResolutions: Object.fromEntries(payload.sessionIds.map(id => [id, id])) })
          this.emit({ type: 'subscriptions-applied', revision: payload.revision })
        })
      }
      emit(payload) {
        if (!this.opened) { this.pending.push(payload); return }
        const sessionPayloadTypes = new Set(['session-state', 'session-event', 'message', 'session-deleted', 'typing'])
        const message = sessionPayloadTypes.has(payload.type) && !payload.sessionId ? { ...payload, sessionId: 'fixture/main' } : payload
        this.onmessage?.({ data: JSON.stringify(message) })
      }
      fail() { if (this.readyState === FixtureWebSocket.CLOSED) return; this.readyState = FixtureWebSocket.CLOSED; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
    window.fixtureEventSourceCount = () => FixtureWebSocket.instances.length
    window.openFixtureEventSource = () => FixtureWebSocket.instances.at(-1)?.open()
    window.failFixtureEventSource = () => FixtureWebSocket.instances.at(-1)?.fail()
    window.emitFixtureEvent = payload => FixtureWebSocket.instances.at(-1)?.emit(payload)
    window.emitFixtureMessage = message => window.emitFixtureEvent({ type: 'message', message })

    const fixtureRoot = createRoot(document.getElementById('root'))
    window.renderFixtureChats = (count = 1, generation = 0, sessionId = 'fixture/main') => fixtureRoot.render(React.createElement('div', {},
      ...Array.from({ length: count }, (_, index) => React.createElement(Chat, {
        key: generation + '-' + index,
        sessionId, canonicalSessionId: sessionId, sessionDisplayName: 'Fixture',
      })),
    ))
    window.renderFixtureChats()
  `
  const result = await build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: 'chat-history-loading-fixture.tsx' },
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
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const tallTimelineCss = request.url?.includes('restoreOldAnchor')
      ? '.foxwarm-chat-messages{height:300px!important;overflow:auto!important}[data-chat-message-anchor-key]{min-height:32px!important}'
      : ''
    response.end(`<!doctype html><html><head><style>html,body,#root{width:100%;height:100%;margin:0}.foxwarm-chat-root{height:100%}.foxwarm-chat-composer-form-anchor{position:relative}.foxwarm-chat-composer-form-anchor>[data-slash-command-overlay="true"]{position:absolute;left:0;right:0;bottom:calc(100% + .5rem)}${tallTimelineCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('page bootstrap endpoints are fetched once across panes, remounts, and model popup opens', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  const endpointCounts = () => page.evaluate(() => Object.fromEntries(['/asr/status', '/models', '/commands'].map(endpoint => [
    endpoint,
    window.fixtureRequests.filter(url => url.includes(endpoint)).length,
  ])))
  await page.waitForFunction(() => ['/asr/status', '/models', '/commands'].every(endpoint => window.fixtureRequests.some(url => url.includes(endpoint))))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })

  await page.evaluate(() => window.renderFixtureChats(3, 1))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })
  await page.click('[aria-haspopup="dialog"]')
  await page.waitForSelector('[data-model-selector-popup="true"]')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })

  await page.evaluate(() => window.renderFixtureChats(1, 2))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })
  await page.close()
})

test('failed page bootstrap endpoints remain cached across remounts', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?bootstrapFailure=1`, { waitUntil: 'load' })
  const endpointCounts = () => page.evaluate(() => Object.fromEntries(['/asr/status', '/models', '/commands'].map(endpoint => [
    endpoint,
    window.fixtureRequests.filter(url => url.includes(endpoint)).length,
  ])))
  await page.waitForFunction(() => ['/asr/status', '/models', '/commands'].every(endpoint => window.fixtureRequests.some(url => url.includes(endpoint))))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })
  assert.equal(await page.$eval('[aria-haspopup="dialog"]', button => button.textContent.includes('!')), true)
  await page.evaluate(() => window.renderFixtureChats(2, 1))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(await endpointCounts(), { '/asr/status': 1, '/models': 1, '/commands': 1 })
  await page.close()
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

test('history bootstrap paints the latest 100 before one guarded prefix request and then enables the minimap', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  const allMessages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 ? 'model' : 'user',
    parts: [{ text: `two phase row ${index + 1}` }],
    __meta: { seq: index + 1, timestamp: index + 1 },
  }))

  await page.evaluate(messages => window.resolveFixtureHistory(0, messages.slice(-100), 7, {
    latestSeq: 120, prefixLength: 20, historyComplete: false, messageCount: 120,
  }), allMessages)
  await page.waitForFunction(() => document.body.textContent.includes('two phase row 120'))
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-chat-message-anchor-key]')].some(row => row.textContent.trim() === 'two phase row 1')), false)
  assert.equal(await page.$('.foxwarm-context-scrollbar'), null)
  assert.deepEqual(await page.$eval('.foxwarm-chat-messages', element => ({
    native: element.dataset.showSystemScrollbar,
    minimap: element.dataset.showContextMinimap,
  })), { native: 'false', minimap: 'true' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.deepEqual(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).map(url => new URL(url, location.href).search)), [
    '?tail=100', '?prefixLength=20&historyVersion=7',
  ])

  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 121, historyVersion: 7, modelKey: 'fixture/model' },
    })
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'append during prefix' }], __meta: { seq: 121, timestamp: 121 } })
  })

  await page.evaluate(messages => window.resolveFixtureHistory(0, messages.slice(0, 20), 7, {
    latestSeq: 120, messageCount: 120,
  }), allMessages)
  await page.waitForSelector('.foxwarm-context-scrollbar')
  await page.waitForFunction(() => document.body.textContent.includes('append during prefix'))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 2)
  await page.close()
})

test('empty and exactly-100-message bootstraps skip the prefix request', async () => {
  for (const count of [0, 100]) {
    page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 720 })
    await page.goto(fixtureUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    const messages = Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'model' : 'user',
      parts: [{ text: `bounded row ${index + 1}` }],
      __meta: { seq: index + 1, timestamp: index + 1 },
    }))
    await page.evaluate(messages => window.resolveFixtureHistory(0, messages, 0, {
      latestSeq: messages.length, prefixLength: 0, historyComplete: true, messageCount: messages.length,
    }), messages)
    await page.waitForSelector('.foxwarm-context-scrollbar')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1, `count=${count}`)
    await page.close()
  }
})

test('a stale bootstrap prefix falls back once to a full correction', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'model', parts: [{ text: 'recent row' }], __meta: { seq: 2, timestamp: 20 } },
  ], 3, { latestSeq: 2, prefixLength: 1, historyComplete: false, messageCount: 2 }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.rejectFixtureHistory(409, 'SESSION_HISTORY_BOUNDARY_STALE'))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
  assert.deepEqual(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).map(url => new URL(url, location.href).search)), [
    '?tail=100', '?prefixLength=1&historyVersion=3', '',
  ])
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'corrected old row' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'recent row' }], __meta: { seq: 2, timestamp: 20 } },
  ], 4, { latestSeq: 2, messageCount: 2 }))
  await page.waitForFunction(() => document.body.textContent.includes('corrected old row'))
  await page.waitForSelector('.foxwarm-context-scrollbar')
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 3)
  await page.close()
})

test('failed earlier-history loading keeps the recent screen and retries with one full correction', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'model', parts: [{ text: 'usable recent row' }], __meta: { seq: 2, timestamp: 20 } },
  ], 1, { latestSeq: 2, prefixLength: 1, historyComplete: false, messageCount: 2 }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.rejectFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('Earlier messages could not be loaded.'))
  assert.equal(await page.$('.foxwarm-context-scrollbar'), null)
  assert.equal(await page.evaluate(() => document.body.textContent.includes('usable recent row')), true)
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry')?.click())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'retried old row' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'usable recent row' }], __meta: { seq: 2, timestamp: 20 } },
  ], 1, { latestSeq: 2, messageCount: 2 }))
  await page.waitForFunction(() => document.body.textContent.includes('retried old row'))
  await page.waitForSelector('.foxwarm-context-scrollbar')
  await page.close()
})

test('retrying earlier history preserves and restores an anchor older than the recent tail', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?restoreOldAnchor=1`, { waitUntil: 'load' })
  const allMessages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 ? 'model' : 'user',
    parts: [{ text: `restore row ${index + 1}` }],
    __meta: { seq: index + 1, timestamp: index + 1 },
  }))
  await page.evaluate(messages => window.resolveFixtureHistory(0, messages.slice(-100), 2, {
    latestSeq: 120, prefixLength: 20, historyComplete: false, messageCount: 120,
  }), allMessages)
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.rejectFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('Earlier messages could not be loaded.'))
  assert.equal(await page.$('[data-chat-message-anchor-key="seq-local-1"]'), null)

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry')?.click())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
  await page.evaluate(messages => window.resolveFixtureHistory(0, messages, 2, {
    latestSeq: 120, messageCount: 120,
  }), allMessages)
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-1"]')
  const anchorOffset = await page.$eval('[data-chat-message-anchor-key="seq-local-1"]', element => {
    const container = document.querySelector('.foxwarm-chat-messages')
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top
  })
  assert.ok(Math.abs(anchorOffset - 24) <= 2, `restored anchor offset was ${anchorOffset}`)
  await page.close()
})

test('contiguous state-before-message appends cause no HTTP history requests after bootstrap', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  for (let seq = 2; seq <= 11; seq += 1) {
    await page.evaluate(seq => {
      window.emitFixtureEvent({
        type: 'session-state',
        session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: seq, historyVersion: 0, modelKey: 'fixture/model' },
      })
      window.emitFixtureMessage({ role: seq % 2 ? 'model' : 'user', parts: [{ text: `contiguous ${seq}` }], __meta: { seq, timestamp: seq * 10 } })
    }, seq)
  }
  await page.waitForFunction(() => document.body.textContent.includes('contiguous 11'))
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.close()
})

test('missing and skipped committed messages use one after-seq correction instead of a full snapshot', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 3, historyVersion: 0, modelKey: 'fixture/model' },
  }))
  await page.evaluate(() => window.emitFixtureMessage({ role: 'model', parts: [{ text: 'gap row 3' }], __meta: { seq: 3, timestamp: 30 } }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '?afterSeq=1&historyVersion=0')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'recovered row 2' }], __meta: { seq: 2, timestamp: 20 } },
    { role: 'model', parts: [{ text: 'gap row 3' }], __meta: { seq: 3, timestamp: 30 } },
  ], 0, { latestSeq: 3, messageCount: 3 }))
  await page.waitForFunction(() => document.body.textContent.includes('recovered row 2'))
  assert.equal((await page.$$eval('[data-chat-message-anchor-key="seq-local-3"]', rows => rows.length)), 1)
  assert.equal(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history') && !new URL(url, location.href).search).length), 0)
  await page.close()
})

test('a message-only seq gap schedules one after-seq correction without waiting for session-state', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.evaluate(() => window.emitFixtureMessage({
    role: 'model', parts: [{ text: 'message-only gap row 3' }], __meta: { seq: 3, timestamp: 30 },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '?afterSeq=1&historyVersion=0')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'message-only recovered row 2' }], __meta: { seq: 2, timestamp: 20 } },
    { role: 'model', parts: [{ text: 'message-only gap row 3' }], __meta: { seq: 3, timestamp: 30 } },
  ], 0, { latestSeq: 3, messageCount: 3 }))
  await page.waitForFunction(() => document.body.textContent.includes('message-only recovered row 2'))
  assert.equal((await page.$$eval('[data-chat-message-anchor-key="seq-local-3"]', rows => rows.length)), 1)
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

test('successful real Chat send clears the live and persisted composer draft', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'clear after accepted send')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  assert.equal(await page.$eval(editor, node => node.textContent.includes('clear after accepted send')), true)
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector)
    return node?.textContent === '' && node.dataset.empty === 'true'
  }, {}, editor)
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_fixture/main')), null)

  await page.type(editor, 'before ')
  await page.$eval(editor, node => {
    const text = 'p'.repeat(2000)
    const data = new DataTransfer(); data.setData('text/plain', text)
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    const files = new DataTransfer()
    files.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
    files.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: files }))
  })
  await page.keyboard.type(' after')
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-pasted-text-chip').length === 1
    && document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 2)
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '', {}, editor)
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)

  await page.type(editor, 'retain after rejected send')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 3)
  await page.evaluate(() => window.rejectNextFixtureMessage())
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('retain after rejected send'), {}, editor)
  assert.match(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main') || ''), /retain after rejected send/)
  await page.close()
})

test('accepted send clears only its submitted Session after switching composers', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  const editor = '[role="textbox"][aria-label="Message"]'

  await page.type(editor, 'submitted main draft')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await page.evaluate(() => window.renderFixtureChats(1, 1, 'fixture/other'))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.resolveFixtureHistory(0, [], 0, { sessionId: 'fixture/other' }))
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '', {}, editor)
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.type(editor, 'new Session draft')

  await page.evaluate(() => window.resolveFixtureMessages())
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('new Session draft'), {}, editor)
  assert.match(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/other') || ''), /new Session draft/)
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
  await page.close()
})

test('slash suggestions overlay the composer without changing bottom-follow geometry', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory(0, Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? 'model' : 'user',
    parts: [{ text: `history row ${index} ${'content '.repeat(12)}` }],
    __meta: { seq: index + 1, timestamp: index + 1 },
  }))))
  await page.waitForFunction(() => document.body.textContent.includes('history row 29'))
  await page.evaluate(() => {
    const messages = document.querySelector('.foxwarm-chat-messages')
    messages.scrollTop = messages.scrollHeight
  })

  await page.type('textarea', '/')
  await page.waitForSelector('[data-slash-command-overlay="true"]')
  // Wait for Chat's resize observer/scroll anchoring pass before sampling geometry.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const open = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-chat-composer-inner')
    const messages = document.querySelector('.foxwarm-chat-messages')
    const overlay = document.querySelector('[data-slash-command-overlay="true"]')
    const form = document.querySelector('.foxwarm-chat-composer-form')
    const overlayRect = overlay.getBoundingClientRect()
    const formRect = form.getBoundingClientRect()
    return {
      composerHeight: root.getBoundingClientRect().height,
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      anchored: overlayRect.bottom <= formRect.top,
      viewportSafe: overlayRect.top >= 0,
    }
  })
  assert.equal(open.anchored, true)
  assert.equal(open.viewportSafe, true)
  assert.ok(Math.abs((open.scrollTop + open.clientHeight) - open.scrollHeight) <= 2)

  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-slash-command-overlay="true"]', { hidden: true })
  const closed = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-chat-composer-inner')
    const messages = document.querySelector('.foxwarm-chat-messages')
    return {
      composerHeight: root.getBoundingClientRect().height,
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
    }
  })
  assert.equal(closed.composerHeight, open.composerHeight)
  assert.equal(closed.scrollHeight, open.scrollHeight)
  assert.ok(Math.abs((closed.scrollTop + closed.clientHeight) - closed.scrollHeight) <= 2)
  // Closing a page blurs the composer; clear its draft first so this test cannot
  // seed a leading slash into the next test's same-session fixture.
  await page.click('textarea')
  await page.keyboard.down('Control')
  await page.keyboard.press('A')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.evaluate(() => localStorage.removeItem('draft_fixture/main'))
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

test('same-count historyVersion change refreshes an open Chat after an in-place history rewrite', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'tool', parts: [{ functionResponse: { tool_use_id: 'same-count', name: 'read', response: { output: 'full historical response' } } }], __meta: { seq: 2, timestamp: 20 } }], 1))
  await page.waitForFunction(() => document.body.textContent.includes('full historical response'))

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 1, modelKey: 'fixture/model' },
  }))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 2, modelKey: 'fixture/model' },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'tool', parts: [{ functionResponse: { tool_use_id: 'same-count', name: 'read', response: { output: 'historical tool response pruned' } } }], __meta: { seq: 2, timestamp: 20 } }], 2))
  await page.waitForFunction(() => document.body.textContent.includes('historical tool response pruned'))
  assert.equal(await page.evaluate(() => document.body.textContent.includes('full historical response')), false)
  await page.close()
})

test('a same-version committed count decrease fails safe to one full correction', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'count row 1' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'count row 2' }], __meta: { seq: 2, timestamp: 20 } },
  ], 1, { latestSeq: 2, messageCount: 2 }))
  await page.waitForFunction(() => document.body.textContent.includes('count row 2'))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 1, modelKey: 'fixture/model' },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'count row 1' }], __meta: { seq: 1, timestamp: 10 } },
  ], 1, { latestSeq: 1, messageCount: 1 }))
  await page.waitForFunction(() => !document.body.textContent.includes('count row 2'))
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
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.close()
})

test('a busy send refreshes queue metadata through after-seq instead of full history', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 1, historyVersion: 0, modelKey: 'fixture/model' },
  }))
  const composer = await page.$('textarea')
  await composer.type('queued while busy')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '?afterSeq=1&historyVersion=0')
  await page.evaluate(() => window.resolveFixtureHistory(1, [], 0, { latestSeq: 1, messageCount: 1 }))
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

test('initial stream registers before bootstrap and a caught-up reconnect avoids history', async () => {
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
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 3, historyVersion: 0, modelKey: 'fixture/model' },
    })
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed while reconnect stream opened' }], __meta: { seq: 3, timestamp: 30 } })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed while reconnect stream opened'))
  await new Promise(resolve => setTimeout(resolve, 250))

  const rootText = await page.$eval('.foxwarm-chat-root', element => element.textContent)
  assert.equal(rootText.includes('committed while initial stream opened'), true)
  assert.equal(rootText.includes('committed while reconnect stream opened'), true)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.close()
})

test('reconnect uses after-seq when the same history version is ahead', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 0, modelKey: 'fixture/model' },
    })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '?afterSeq=1&historyVersion=0')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'model', parts: [{ text: 'reconnected row 2' }], __meta: { seq: 2, timestamp: 20 } },
  ], 0, { latestSeq: 2, messageCount: 2 }))
  await page.waitForFunction(() => document.body.textContent.includes('reconnected row 2'))
  await page.close()
})

test('reconnect uses a full snapshot when historyVersion changed', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 1, modelKey: 'fixture/model' },
    })
    window.openFixtureEventSource()
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.equal(await page.evaluate(() => new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href).search), '')
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'model', parts: [{ text: 'rewritten reconnect row' }], __meta: { seq: 1, timestamp: 20 } },
  ], 1, { latestSeq: 1, messageCount: 1 }))
  await page.waitForFunction(() => document.body.textContent.includes('rewritten reconnect row'))
  await page.close()
})

test('a realtime socket that fails before opening reconnects without starting history', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)
  await page.evaluate(() => window.openFixtureEventSource())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.close()
})

test('repeated pre-open failures retain one transport generation and one eventual history bootstrap', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => window.failFixtureEventSource())
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

  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed across pre-open failures')), true)
  await page.close()
})
