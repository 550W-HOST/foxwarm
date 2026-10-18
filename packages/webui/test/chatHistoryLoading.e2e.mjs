import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
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

    window.fixtureTimelineView = new URLSearchParams(location.search).has('continuous') ? 'conversation' : undefined
    window.fixtureHistoryMode = new URLSearchParams(location.search).has('continuous') ? undefined : 'active'
    window.fixtureArchive = Array.from({ length: 600 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: 'Original narrative ' + (index + 1) + ' ' + 'Readable history. '.repeat(5) }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } }))
    if (new URLSearchParams(location.search).has('variedHistory')) window.fixtureArchive = window.fixtureArchive.map(message => ({ ...message, parts: [{ text: message.parts[0].text + '\\n\\n' + 'Different historical row height. '.repeat(message.__meta.seq % 11 * 7) }] }))
    if (new URLSearchParams(location.search).has('denseProcess')) window.fixtureArchive = Array.from({ length: 600 }, (_, index) => {
      const seq = index + 1
      const meta = { seq, timestamp: 1700000000000 + index }
      if (seq === 1) return { role: 'user', parts: [{ text: 'Run the long synthetic process.' }], __meta: meta }
      if (seq === 600) return { role: 'model', parts: [{ text: 'Dense process outcome. '.repeat(250) }], __meta: meta }
      const id = 'dense-call-' + Math.floor(seq / 2)
      return seq % 2 ? { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: 'Synthetic tool output. '.repeat(seq % 17 + 1) } } }], __meta: meta }
        : { role: 'model', parts: [{ functionCall: { name: 'exec', id, args: { command: 'synthetic command ' + seq } } }, ...(seq === 102 ? [{ text: 'Earlier process checkpoint 102' }] : [])], __meta: meta }
    })
    window.fixtureArchiveRequests = []
    window.fixtureFailArchive = false
    window.fixtureDelayArchive = false
    const archiveResolvers = []
    window.resolveFixtureArchive = () => archiveResolvers.shift()?.()
    window.fixtureRequests = []
    window.fixtureMessageBodies = []
    window.fixtureNodePosts = []
    const nodeResponseResolvers = []
    window.resolveFixtureNode = (nodeId, status = 200) => nodeResponseResolvers.shift()?.resolve(new Response(JSON.stringify(status === 200
      ? { session: { id: 'fixture/main', currentNode: nodeId, cwd: 'fixture://kept-cwd' } }
      : { error: 'Node went offline.' }), { status, headers: { 'Content-Type': 'application/json' } }))
    const messageResponseResolvers = []
    const historyResponseResolvers = []
    const stateProbeResolvers = []
    window.fixtureHistoryRequestCount = 0
    window.fixtureHistoryAbortCount = 0
    window.fixtureStateProbeCount = 0
    window.fixtureIgnoreHistoryAbort = false
    window.fixtureStoppedMicTracks = 0
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { window.fixtureStoppedMicTracks += 1 } }] }) } })
    window.AudioContext = class {
      sampleRate = 16000
      destination = {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null } }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    window.resolveFixtureHistory = (queueLength = 0, messages = [{ role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } }], historyVersion = 0, extras = {}) => {
      const entry = historyResponseResolvers.shift()
      if (!entry) throw new Error('No pending history request')
      entry.settled = true
      const latestSeq = extras.latestSeq ?? messages.reduce((latest, message) => Math.max(latest, message.__meta?.seq || 0), 0)
      entry.resolve(new Response(JSON.stringify({
        session: { id: extras.sessionId || 'fixture/main', busy: extras.busy ?? false, runtimeState: { state: extras.busy ? 'requesting-model' : 'idle', busy: extras.busy ?? false, queueLength }, queueLength, messageCount: extras.messageCount ?? messages.length, historyVersion, modelKey: 'fixture/model' },
        messages,
        persistentMemorySnapshot: 'snapshot supplied by history',
        queuedMessages: extras.queuedMessages ?? [],
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
      if (url.endsWith('/nodes')) return new Response(JSON.stringify({ nodes: [
        { id: 'master', label: 'master', selectable: true, reason: null },
        { id: 'exec-only-remote', label: 'Shell node', selectable: true, reason: null },
        { id: 'offline-node', label: 'offline-node', selectable: false, reason: 'Offline' },
        { id: 'upgrade-node', label: 'upgrade-node', selectable: false, reason: 'Update this node to connect.' },
      ], lockedReason: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/node')) {
        window.fixtureNodePosts.push({ url, body: JSON.parse(init.body) })
        return new Promise((resolve, reject) => {
          nodeResponseResolvers.push({ resolve })
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }
      if (url.includes('/state')) {
        window.fixtureStateProbeCount += 1
        return new Promise((resolve, reject) => stateProbeResolvers.push({ resolve, reject }))
      }
      if (url.includes('/history/continuous')) {
        window.fixtureArchiveRequests.push(url)
        const archiveAtRequest = window.fixtureArchive.slice()
        const resolvePage = () => {
          if (window.fixtureFailArchive) { window.fixtureFailArchive = false; return new Response('{}', { status: 503 }) }
          const query = new URL(url, location.href).searchParams
          const before = Number(query.get('beforeSeq')) || Infinity
          const after = Number(query.get('afterSeq')) || 0
          const candidates = archiveAtRequest.filter(message => message.__meta.seq < before && message.__meta.seq > after)
          const messages = after ? candidates.slice(0, 100) : candidates.slice(-100)
          return new Response(JSON.stringify({ messages, firstSeq: messages[0]?.__meta.seq, lastSeq: messages.at(-1)?.__meta.seq, hasMore: candidates.length > 100, latestSeq: archiveAtRequest.at(-1)?.__meta.seq || 0 }), { status: 200 })
        }
        if (window.fixtureDelayArchive) return new Promise(resolve => archiveResolvers.push(() => resolve(resolvePage())))
        return resolvePage()
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
        : new Response(JSON.stringify({ configured: new URLSearchParams(location.search).has('asrClose'), available: new URLSearchParams(location.search).has('asrClose') }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
      constructor(url) {
        this.isAsr = String(url).includes('/asr/stream')
        this.sent = []
        this.readyState = FixtureWebSocket.CONNECTING
        this.opened = false
        this.pending = []
        FixtureWebSocket.instances.push(this)
        if (this.isAsr || !new URLSearchParams(window.location.search).has('manualSse')) queueMicrotask(() => this.open())
      }
      open() {
        if (this.readyState === FixtureWebSocket.CLOSED || this.opened) return
        this.opened = true
        this.readyState = FixtureWebSocket.OPEN
        this.onopen?.({})
        queueMicrotask(() => this.emit({ type: 'connected' }))
        queueMicrotask(() => this.pending.splice(0).forEach(payload => this.emit(payload)))
      }
      close() {
        if (this.readyState === FixtureWebSocket.CLOSED) return
        this.readyState = FixtureWebSocket.CLOSED
        if (this.isAsr) queueMicrotask(() => this.onclose?.({}))
      }
      send(raw) {
        const payload = JSON.parse(raw)
        this.sent.push(payload)
        if (this.isAsr) {
          if (payload.type === 'start') queueMicrotask(() => this.emit({ type: 'ready' }))
          return
        }
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
        const sessionPayloadTypes = new Set(['session-state', 'session-event', 'message', 'history-append', 'session-deleted', 'typing'])
        const message = sessionPayloadTypes.has(payload.type) && !payload.sessionId ? { ...payload, sessionId: 'fixture/main' } : payload
        this.onmessage?.({ data: JSON.stringify(message) })
      }
      fail() { if (this.readyState === FixtureWebSocket.CLOSED) return; this.readyState = FixtureWebSocket.CLOSED; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
    window.fixtureAsrSockets = () => FixtureWebSocket.instances.filter(socket => socket.isAsr)
    window.fixtureEventSourceCount = () => FixtureWebSocket.instances.length
    window.openFixtureEventSource = () => FixtureWebSocket.instances.at(-1)?.open()
    window.failFixtureEventSource = () => FixtureWebSocket.instances.at(-1)?.fail()
    window.emitFixtureEvent = payload => FixtureWebSocket.instances.at(-1)?.emit(payload)
    window.emitFixtureMessage = message => window.emitFixtureEvent({ type: 'message', message })

    const fixtureRoot = createRoot(document.getElementById('root'))
    window.renderFixtureChats = (count = 1, generation = 0, sessionId = 'fixture/main') => fixtureRoot.render(React.createElement('div', { style: (new URLSearchParams(location.search).has('nodePicker') || new URLSearchParams(location.search).has('pastedText') || new URLSearchParams(location.search).has('continuous')) ? { height: '100%' } : undefined },
      ...Array.from({ length: count }, (_, index) => React.createElement(Chat, {
        key: generation + '-' + index,
        sessionId, canonicalSessionId: sessionId, sessionDisplayName: 'Fixture',
        webUiIdentityMode: new URLSearchParams(location.search).has('identityMode'),
        timelineView: window.fixtureTimelineView || (new URLSearchParams(location.search).has('timelineView') ? 'grouped' : 'detailed'),
        historyMode: window.fixtureHistoryMode,
        showUserMessageMetadata: !!window.fixtureShowUserMetadata,
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

async function fixtureStartupStage(name, operation) {
  let timer
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture startup stage timed out: ${name}`)), 8000) }),
    ])
  } catch (error) {
    console.error(`[chatHistoryLoading fixture startup failed: ${name}]`, error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

before(async () => {
  const bundle = await fixtureStartupStage('esbuild-bundle', buildFixtureBundle)
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssAsset = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build WebUI before running composer layout cases')
  const composerCss = await readFile(new URL(cssAsset, assets), 'utf8')
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const tallTimelineCss = request.url?.includes('restoreOldAnchor')
      ? '.foxwarm-chat-messages{height:300px!important;overflow:auto!important}[data-chat-message-anchor-key]{min-height:32px!important}'
      : ''
    response.end(`<!doctype html><html><head>${(request.url?.includes('nodePicker') || request.url?.includes('pastedText') || request.url?.includes('continuous')) ? `<style>${composerCss}</style>` : ''}<style>html,body,#root{width:100%;height:100%;margin:0}.foxwarm-chat-root{height:100%}.foxwarm-chat-composer-form-anchor{position:relative}.foxwarm-chat-composer-form-anchor>[data-slash-command-overlay="true"]{position:absolute;left:0;right:0;bottom:calc(100% + .5rem)}${tallTimelineCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await fixtureStartupStage('http-listen', () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await fixtureStartupStage('chromium-launch', () => puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    timeout: 7000,
    dumpio: process.env.FOXWARM_E2E_CHROMIUM_DUMPIO === '1',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }))
  const readinessPage = await fixtureStartupStage('page-create', () => browser.newPage())
  try {
    await fixtureStartupStage('page-readiness', async () => {
      await readinessPage.goto(fixtureUrl, { waitUntil: 'load' })
      const fixtureInstalled = await readinessPage.evaluate(() => typeof window.renderFixtureChats === 'function')
      assert.equal(fixtureInstalled, true, 'fixture installs the Chat renderer before history tests')
      await readinessPage.waitForFunction(() => typeof window.renderFixtureChats === 'function')
    })
  } finally {
    await readinessPage.close()
  }
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('real Chat node picker switches only its Session after confirmation and follows runtime node changes', async () => {
  const nodePage = await browser.newPage()
  try {
    await nodePage.goto(`${fixtureUrl}?nodePicker=1`, { waitUntil: 'load' })
    await nodePage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await nodePage.evaluate(() => window.resolveFixtureHistory())
    const trigger = '.foxwarm-node-picker-trigger'
    const editor = '[role="textbox"][aria-label="Message"]'
    await nodePage.waitForSelector(trigger)
    assert.equal(await nodePage.$eval(trigger, node => node.textContent), '')
    assert.equal(await nodePage.$eval(trigger, node => node.getAttribute('aria-label')), 'Execution node: master')
    assert.equal(await nodePage.evaluate(() => window.fixtureRequests.filter(url => url.endsWith('/nodes')).length), 0)
    await nodePage.type(editor, 'Retained draft')
    await nodePage.click(trigger)
    await nodePage.waitForSelector('[data-node-option="exec-only-remote"]')
    assert.equal(await nodePage.$eval('[data-node-option="offline-node"]', node => node.disabled), true)
    assert.equal(await nodePage.$eval('[data-node-option="upgrade-node"]', node => node.disabled), true)
    await nodePage.click('[data-node-option="exec-only-remote"]')
    await nodePage.waitForFunction(() => window.fixtureNodePosts.length === 1)
    assert.equal(await nodePage.$eval(trigger, node => node.textContent), '', 'no optimistic selection')
    assert.equal(await nodePage.$eval(trigger, node => node.disabled), true)
    await nodePage.evaluate(() => window.resolveFixtureNode('exec-only-remote'))
    await nodePage.waitForFunction(() => document.querySelector('.foxwarm-node-picker-trigger')?.textContent === 'exec-only-remote')
    assert.equal(await nodePage.$eval(`${trigger} svg`, node => node.classList.contains('text-fw-accent')), true)
    assert.equal(await nodePage.evaluate(() => document.activeElement?.matches('.foxwarm-node-picker-trigger')), true)
    assert.equal(await nodePage.$eval(editor, node => node.textContent), 'Retained draft')
    assert.equal(await nodePage.evaluate(() => window.fixtureMessageBodies.length), 0)

    await nodePage.click(trigger)
    await nodePage.waitForSelector('[data-node-option="master"]')
    await nodePage.click('[data-node-option="master"]')
    await nodePage.waitForFunction(() => window.fixtureNodePosts.length === 2)
    await nodePage.evaluate(() => window.resolveFixtureNode('master'))
    await nodePage.waitForFunction(() => document.querySelector('.foxwarm-node-picker-trigger')?.getAttribute('aria-label') === 'Execution node: master')
    assert.deepEqual(await nodePage.evaluate(() => window.fixtureNodePosts.map(post => post.body)), [{ nodeId: 'exec-only-remote' }, { nodeId: 'master' }])
    assert.ok((await nodePage.evaluate(() => window.fixtureNodePosts.map(post => post.url))).every(url => url.includes('fixture%2Fmain/node')))

    await nodePage.evaluate(() => window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', currentNode: 'runtime-selected-node', cwd: 'fixture://kept-cwd', runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 0 } }))
    await nodePage.waitForFunction(() => document.querySelector('.foxwarm-node-picker-trigger')?.textContent === 'runtime-selected-node')
    await nodePage.click(trigger)
    await nodePage.waitForSelector('[data-node-option="runtime-selected-node"]')
    assert.equal(await nodePage.$eval('[data-node-option="runtime-selected-node"]', node => node.disabled && node.getAttribute('aria-pressed') === 'true'), true, 'stale selection remains visible')
    await nodePage.keyboard.press('Escape')
    assert.equal(await nodePage.evaluate(() => document.activeElement?.matches('.foxwarm-node-picker-trigger')), true)
  } finally {
    await nodePage.evaluate(() => localStorage.removeItem('composer_draft_v1_fixture/main'))
    await nodePage.close()
  }
})

test('real Chat node picker keeps the confirmed value on failure and ignores a late old-Session response', async () => {
  const nodePage = await browser.newPage()
  try {
    await nodePage.goto(`${fixtureUrl}?nodePicker=1`, { waitUntil: 'load' })
    await nodePage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await nodePage.evaluate(() => window.resolveFixtureHistory())
    await nodePage.click('.foxwarm-node-picker-trigger')
    await nodePage.waitForSelector('[data-node-option="exec-only-remote"]')
    await nodePage.click('[data-node-option="exec-only-remote"]')
    await nodePage.waitForFunction(() => window.fixtureNodePosts.length === 1)
    await nodePage.evaluate(() => window.resolveFixtureNode('exec-only-remote', 400))
    await nodePage.waitForFunction(() => document.querySelector('[data-node-picker-popup] [role="alert"]')?.textContent.includes('offline'))
    assert.equal(await nodePage.$eval('.foxwarm-node-picker-trigger', node => node.getAttribute('aria-label')), 'Execution node: master')
    await nodePage.click('[data-node-option="exec-only-remote"]')
    await nodePage.waitForFunction(() => window.fixtureNodePosts.length === 2)
    await nodePage.evaluate(() => window.renderFixtureChats(1, 0, 'fixture/other'))
    await nodePage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await nodePage.evaluate(() => {
      window.resolveFixtureHistory(0, [], 0, { sessionId: 'fixture/other' })
      window.resolveFixtureNode('exec-only-remote')
    })
    await nodePage.waitForFunction(() => document.querySelector('.foxwarm-node-picker-trigger')?.getAttribute('aria-label') === 'Execution node: master')
    assert.equal(await nodePage.$('[data-node-picker-popup]'), null)
  } finally {
    await nodePage.close()
  }
})

test('WebUI identity Chat hides node and model controls without fetching their endpoints', async () => {
  const identityPage = await browser.newPage()
  try {
    await identityPage.goto(`${fixtureUrl}?identityMode=1`, { waitUntil: 'load' })
    await identityPage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await identityPage.evaluate(() => window.resolveFixtureHistory())
    await identityPage.waitForSelector('[role="textbox"][aria-label="Message"]')
    assert.equal(await identityPage.$('.foxwarm-node-picker-trigger'), null)
    assert.equal(await identityPage.$('.foxwarm-model-selector-trigger'), null)
    assert.deepEqual(await identityPage.evaluate(() => window.fixtureRequests.filter(url => /\/(nodes|node|models|commands)$/.test(url))), [])
  } finally {
    await identityPage.close()
  }
})

test('real Chat ASR WebSocket close after ready unlocks retained partial; final and cancel do not report an error', async () => {
  page = await browser.newPage()
  await page.goto(`${fixtureUrl}?asrClose=1`, { waitUntil: 'load' })
  try {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.waitForSelector('button[aria-label="Start recording"]')
    await page.type(editor, 'before')
    await page.click('button[aria-label="Start recording"]')
    await page.waitForFunction(() => window.fixtureAsrSockets().length === 1 && document.querySelector('[role="textbox"][aria-label="Message"]')?.contentEditable === 'false')
    await page.evaluate(() => window.fixtureAsrSockets()[0].emit({ type: 'partial', text: ' partial' }))
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === 'before partial')
    await page.click('button[aria-label="Stop recording and transcribe"]')
    await page.waitForFunction(() => window.fixtureAsrSockets()[0].sent.some(payload => payload.type === 'stop'))
    await page.evaluate(() => window.fixtureAsrSockets()[0].fail())
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('closed before the final transcript')
      && document.querySelector('[role="textbox"][aria-label="Message"]')?.contentEditable === 'true')
    assert.equal(await page.$eval(editor, node => node.textContent), 'before partial')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments[0].text), 'before partial')

    await page.click('button[aria-label="Start recording"]')
    await page.waitForFunction(() => window.fixtureAsrSockets().length === 2)
    await page.evaluate(() => window.fixtureAsrSockets()[1].emit({ type: 'final', text: ' final' }))
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.contentEditable === 'true')
    assert.equal(await page.$('[role="alert"]'), null)
    assert.equal(await page.$eval(editor, node => node.textContent), 'before partial final')

    await page.click('button[aria-label="Start recording"]')
    await page.waitForFunction(() => window.fixtureAsrSockets().length === 3)
    await page.evaluate(() => window.renderFixtureChats(0, 1))
    await page.waitForFunction(() => window.fixtureAsrSockets()[2].readyState === 3)
    await page.evaluate(() => window.renderFixtureChats(1, 2))
    await page.waitForSelector(editor)
    assert.equal(await page.$('[role="alert"]'), null)
    assert.equal(await page.$eval(editor, node => node.textContent), 'before partial final')
  } finally {
    // This fixture deliberately persists the ASR draft; later tests start with a clean composer.
    await page.evaluate(() => localStorage.removeItem('composer_draft_v1_fixture/main'))
    await page.close()
  }
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

test('successive A/B sends issue distinct identified requests without waiting for history', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'A')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await page.evaluate(() => window.resolveFixtureMessages())
  await page.waitForFunction(selector => document.querySelector(selector)?.dataset.empty === 'true', {}, editor)
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'false', {}, editor)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.type(editor, 'B')
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
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'false', {}, editor)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
    && document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2, { timeout: 60_000 })
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

  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, '/')
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
  await page.click(editor)
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

  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'accepted before failed response')
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
  await page.click(editor)
  await page.keyboard.down('Control')
  await page.keyboard.press('A')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.waitForFunction(selector => document.querySelector(selector)?.dataset.empty === 'true', {}, editor)
  await page.close()
})

test('manually typed slash commands are sent without an optimistic row or client identity', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))

  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, '/status')
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
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'queued while busy')
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
  assert.equal(await page.$eval('[data-processing-status-slot] [role="status"]', block => block.dataset.processingRuntimeState), 'requesting-model')
  assert.equal(await page.$eval('[data-processing-queue-status]', block => block.textContent.includes('3 queued')), true)
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('live streaming text')), true)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 2)
  await page.close()
})

test('queue-origin append atomically moves one logical input between timelines', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'prior committed row' }], __meta: { seq: 1, timestamp: 10 } },
  ], 0, {
    messageCount: 1,
    latestSeq: 1,
    queuedMessages: [{
      role: 'user',
      parts: [{ text: 'queue transition duplicate probe' }],
      __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-probe' },
    }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('queue transition duplicate probe'))

  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: {
        id: 'fixture/main',
        busy: true,
        runtimeState: { state: 'requesting-model' },
        queueLength: 0,
        messageCount: 2,
        historyVersion: 0,
        modelKey: 'fixture/model',
      },
    })
    window.emitFixtureEvent({
      type: 'history-append', historyVersion: 0, messageCount: 2, queueLength: 0, latestSeq: 2,
      messages: [{ role: 'user', parts: [{ text: 'queue transition duplicate probe' }], __meta: { seq: 2, timestamp: 20 } }],
      queuedMessages: [], queuedPreviewOmittedCount: 0,
    })
  })

  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue transition duplicate probe'))
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue transition duplicate probe') === true,
    queued: document.querySelector('[data-queued-preview]')?.textContent.includes('queue transition duplicate probe') === true,
  })), { committed: true, queued: false })
  await page.close()
})

test('queue-origin append after an earlier missing canonical row preserves the safe frontier and recovers atomically', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'frontier row 1' }], __meta: { seq: 1, timestamp: 10 } },
  ], 0, {
    messageCount: 1,
    latestSeq: 1,
    queuedMessages: [{ role: 'user', parts: [{ text: 'queue row 3' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-row-3' } }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('queue row 3'))
  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 3, historyVersion: 0, modelKey: 'fixture/model' },
    })
    window.emitFixtureEvent({
      type: 'history-append', historyVersion: 0, messageCount: 3, queueLength: 0, latestSeq: 3,
      messages: [{ role: 'user', parts: [{ text: 'queue row 3' }], __meta: { seq: 3, timestamp: 30 } }],
      queuedMessages: [], queuedPreviewOmittedCount: 0,
    })
  })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.match(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).at(-1)), /afterSeq=1/)
  assert.deepEqual(await page.evaluate(() => ({
    queueRowCommitted: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue row 3') === true,
    queueRowQueued: document.querySelector('[data-queued-preview]')?.textContent.includes('queue row 3') === true,
  })), { queueRowCommitted: false, queueRowQueued: true })
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'model', parts: [{ text: 'missing row 2' }], __meta: { seq: 2, timestamp: 20 } },
    { role: 'user', parts: [{ text: 'queue row 3' }], __meta: { seq: 3, timestamp: 30 } },
  ], 0, { messageCount: 3, latestSeq: 3, queuedMessages: [] }))
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('missing row 2'))
  assert.deepEqual(await page.evaluate(() => ({
    missing: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('missing row 2') === true,
    queueRowCommitted: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue row 3') === true,
    queueRowQueued: document.querySelector('[data-queued-preview]')?.textContent.includes('queue row 3') === true,
  })), { missing: true, queueRowCommitted: true, queueRowQueued: false })
  await page.close()
})

test('queue-origin append waits for an already in-flight authoritative correction', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'prior committed row' }], __meta: { seq: 1, timestamp: 10 } },
  ], 0, {
    messageCount: 1,
    latestSeq: 1,
    queuedMessages: [{ role: 'user', parts: [{ text: 'in-flight queue A' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-in-flight-a' } }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('in-flight queue A'))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 2, historyVersion: 0, modelKey: 'fixture/model' },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)

  await page.evaluate(() => window.emitFixtureEvent({
    type: 'history-append', historyVersion: 0, messageCount: 2, queueLength: 0, latestSeq: 2,
    messages: [{ role: 'user', parts: [{ text: 'in-flight queue A' }], __meta: { seq: 2, timestamp: 20 } }],
    queuedMessages: [], queuedPreviewOmittedCount: 0,
  }))
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('in-flight queue A') === true,
    queued: document.querySelector('[data-queued-preview]')?.textContent.includes('in-flight queue A') === true,
  })), { committed: false, queued: true })
  await page.close()
})

test('a dropped queue-origin append recovers history and queue together from afterSeq', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'prior committed row' }], __meta: { seq: 1, timestamp: 10 } },
  ], 0, {
    messageCount: 1,
    latestSeq: 1,
    queuedMessages: [{ role: 'user', parts: [{ text: 'dropped append queue A' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-dropped-a' } }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('dropped append queue A'))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'session-state',
    session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, messageCount: 2, historyVersion: 0, modelKey: 'fixture/model' },
  }))
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('dropped append queue A') === true,
    queued: document.querySelector('[data-queued-preview]')?.textContent.includes('dropped append queue A') === true,
  })), { committed: false, queued: true })
  await page.evaluate(() => window.resolveFixtureHistory(0, [
    { role: 'user', parts: [{ text: 'dropped append queue A' }], __meta: { seq: 2, timestamp: 20 } },
  ], 0, { messageCount: 2, latestSeq: 2, queuedMessages: [] }))
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('dropped append queue A'))
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('dropped append queue A') === true,
    queued: document.querySelector('[data-queued-preview]')?.textContent.includes('dropped append queue A') === true,
  })), { committed: true, queued: false })
  await page.close()
})

test('unsafe queue-origin append with newer unresolved queue state applies neither timeline side', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'prior committed row' }], __meta: { seq: 1, timestamp: 10 } },
  ], 0, {
    messageCount: 1,
    latestSeq: 1,
    queuedMessages: [{
      role: 'user',
      parts: [{ text: 'queue mismatch duplicate probe' }],
      __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-mismatch-probe' },
    }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('queue mismatch duplicate probe'))

  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: {
        id: 'fixture/main',
        busy: true,
        runtimeState: { state: 'requesting-model' },
        queueLength: 2,
        messageCount: 2,
        historyVersion: 0,
        modelKey: 'fixture/model',
      },
    })
    window.emitFixtureEvent({
      type: 'history-append', historyVersion: 0, messageCount: 2, queueLength: 0, latestSeq: 2,
      messages: [{ role: 'user', parts: [{ text: 'queue mismatch duplicate probe' }], __meta: { seq: 2, timestamp: 20 } }],
      queuedMessages: [], queuedPreviewOmittedCount: 0,
    })
    window.fixtureOrdinaryFramesSent = 0
    const emitOrdinaryFrame = () => {
      const offset = window.fixtureOrdinaryFramesSent++
      window.emitFixtureMessage({ role: 'model', parts: [{ text: `later ordinary frame ${offset} must wait` }], __meta: { seq: 3 + offset, timestamp: 30 + offset } })
      if (window.fixtureOrdinaryFramesSent >= 20) window.clearInterval(window.fixtureOrdinaryFramesTimer)
    }
    emitOrdinaryFrame()
    window.fixtureOrdinaryFramesTimer = window.setInterval(emitOrdinaryFrame, 10)
  })

  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue mismatch duplicate probe') === true,
    queued: document.querySelector('[data-queued-preview]')?.textContent.includes('queue mismatch duplicate probe') === true,
    laterFrame: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('later ordinary frame') === true,
  })), { committed: false, queued: true, laterFrame: false })
  assert.ok(await page.evaluate(() => window.fixtureOrdinaryFramesSent) < 20, 'ordinary frames must not postpone atomic recovery until streaming becomes quiet')
  assert.match(await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).at(-1)), /afterSeq=1/)
  const ordinaryFrameCount = await page.evaluate(() => {
    window.clearInterval(window.fixtureOrdinaryFramesTimer)
    return window.fixtureOrdinaryFramesSent
  })
  const recovered = [
    { role: 'user', parts: [{ text: 'queue mismatch duplicate probe' }], __meta: { seq: 2, timestamp: 20 } },
    ...Array.from({ length: ordinaryFrameCount }, (_, offset) => ({ role: 'model', parts: [{ text: `later ordinary frame ${offset} must wait` }], __meta: { seq: 3 + offset, timestamp: 30 + offset } })),
  ]
  await page.evaluate((messages, count) => window.resolveFixtureHistory(2, messages, 0, {
    messageCount: 2 + count,
    latestSeq: 2 + count,
    queuedMessages: [
      { role: 'user', parts: [{ text: 'newer queued B' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-b' } },
      { role: 'user', parts: [{ text: 'newer queued C' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-c' } },
    ],
  }), recovered, ordinaryFrameCount)
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue mismatch duplicate probe'))
  assert.deepEqual(await page.evaluate(() => ({
    committed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('queue mismatch duplicate probe') === true,
    oldQueue: document.querySelector('[data-queued-preview]')?.textContent.includes('queue mismatch duplicate probe') === true,
    newerQueue: document.querySelector('[data-queued-preview]')?.textContent.includes('newer queued B') === true,
  })), { committed: true, oldQueue: false, newerQueue: true })
  await page.close()
})

test('trusted tail frontier ignores a delayed covered queue append while prefix history is pending', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  const tail = Array.from({ length: 100 }, (_, index) => ({ role: 'model', parts: [{ text: `tail ${index + 101}` }], __meta: { seq: index + 101, timestamp: index + 101 } }))
  await page.evaluate(messages => window.resolveFixtureHistory(1, messages, 0, {
    messageCount: 200,
    latestSeq: 200,
    prefixLength: 100,
    historyComplete: false,
    queuedMessages: [{ role: 'user', parts: [{ text: 'newer queue B' }], __meta: { queuedPreview: true, temporary: true, synthetic: 'queue-b' } }],
  }), tail)
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('newer queue B'))
  await page.evaluate(() => window.emitFixtureEvent({
    type: 'history-append', historyVersion: 0, messageCount: 50, queueLength: 0, latestSeq: 50,
    messages: [{ role: 'user', parts: [{ text: 'delayed covered queue A' }], __meta: { seq: 50, timestamp: 50 } }],
    queuedMessages: [], queuedPreviewOmittedCount: 0,
  }))
  assert.deepEqual(await page.evaluate(() => ({
    delayed: document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('delayed covered queue A') === true,
    newerQueue: document.querySelector('[data-queued-preview]')?.textContent.includes('newer queue B') === true,
  })), { delayed: false, newerQueue: true })
  await page.close()
})

test('prefix bootstrap keeps the contiguous authority frontier when a live gap precedes a newer queue batch', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  const tail = Array.from({ length: 100 }, (_, index) => ({ role: 'model', parts: [{ text: `bootstrap tail ${index + 101}` }], __meta: { seq: index + 101, timestamp: index + 101 } }))
  await page.evaluate(messages => window.resolveFixtureHistory(1, messages, 0, {
    messageCount: 200,
    latestSeq: 200,
    prefixLength: 100,
    historyComplete: false,
    queuedMessages: [{ role: 'user', parts: [{ text: 'bootstrap queue A' }], __meta: { queuedPreview: true, temporary: true, synthetic: 'bootstrap-a' } }],
  }), tail)
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(() => {
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'concurrent row 202 before missing 201' }], __meta: { seq: 202, timestamp: 202 } })
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 1, messageCount: 203, historyVersion: 0, modelKey: 'fixture/model' },
    })
    window.emitFixtureEvent({
      type: 'history-append', historyVersion: 0, messageCount: 203, queueLength: 1, latestSeq: 203,
      messages: [{ role: 'user', parts: [{ text: 'newer queue row 203' }], __meta: { seq: 203, timestamp: 203 } }],
      queuedMessages: [{ role: 'user', parts: [{ text: 'bootstrap queue B' }], __meta: { queuedPreview: true, temporary: true, synthetic: 'bootstrap-b' } }],
      queuedPreviewOmittedCount: 0,
    })
  })
  const prefix = Array.from({ length: 100 }, (_, index) => ({ role: 'model', parts: [{ text: `bootstrap prefix ${index + 1}` }], __meta: { seq: index + 1, timestamp: index + 1 } }))
  await page.evaluate(messages => window.resolveFixtureHistory(0, messages, 0, { messageCount: 200, latestSeq: 100, queuedMessages: [] }), prefix)
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
  const request = await page.evaluate(() => window.fixtureRequests.filter(url => url.includes('/history')).at(-1))
  assert.match(request, /afterSeq=200/)
  assert.match(request, /historyVersion=0/)
  assert.equal(await page.evaluate(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('bootstrap prefix 1')), true)
  assert.equal(await page.evaluate(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('concurrent row 202 before missing 201')), true)
  assert.equal(await page.evaluate(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('newer queue row 203')), false)
  await page.evaluate(() => window.resolveFixtureHistory(1, [
    { role: 'model', parts: [{ text: 'recovered missing row 201' }], __meta: { seq: 201, timestamp: 201 } },
    { role: 'model', parts: [{ text: 'concurrent row 202 before missing 201' }], __meta: { seq: 202, timestamp: 202 } },
    { role: 'user', parts: [{ text: 'newer queue row 203' }], __meta: { seq: 203, timestamp: 203 } },
  ], 0, {
    messageCount: 203,
    latestSeq: 203,
    queuedMessages: [{ role: 'user', parts: [{ text: 'bootstrap queue B' }], __meta: { queuedPreview: true, temporary: true, synthetic: 'bootstrap-b' } }],
  }))
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('newer queue row 203'))
  assert.equal(await page.evaluate(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('recovered missing row 201')), true)
  assert.equal(await page.evaluate(() => document.querySelector('[data-queued-preview]')?.textContent.includes('bootstrap queue B')), true)
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

for (const lifetime of ['session replacement', 'unmount']) {
  test(`${lifetime} aborts pending history and fences its late success from the next Chat`, async () => {
    page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 720 })
    await page.goto(fixtureUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await page.evaluate(lifetime => {
      window.fixtureIgnoreHistoryAbort = true
      // A stable key exercises replacement of the Session within the same mounted Chat.
      window.renderFixtureChats(lifetime === 'unmount' ? 0 : 1, 0, 'fixture/other')
    }, lifetime)
    await page.waitForFunction(() => window.fixtureHistoryAbortCount === 1)
    if (lifetime === 'unmount') {
      await page.waitForSelector('.foxwarm-chat-root', { hidden: true })
      await page.evaluate(() => window.renderFixtureChats(1, 1, 'fixture/other'))
    }
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await page.evaluate(() => window.resolveFixtureHistory())
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('old history row')), false)

    await page.evaluate(() => window.resolveFixtureHistory(0, [
      { role: 'user', parts: [{ text: 'next Session history' }], __meta: { seq: 1, timestamp: 20 } },
    ], 0, { sessionId: 'fixture/other' }))
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('next Session history'))
    assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('old history row')), false)
    assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 2)
    await page.close()
  })
}

test('initial stream registers before bootstrap and a caught-up reconnect avoids history', async () => {
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(`${fixtureUrl}?manualSse=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 1)
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 0)

  await page.evaluate(() => window.openFixtureEventSource())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed while initial stream opened' }], __meta: { seq: 2, timestamp: 20 } }))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed while initial stream opened'))
  await page.evaluate(() => window.resolveFixtureHistory())
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('old history row'))
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)

  await page.evaluate(() => window.failFixtureEventSource())
  await page.waitForFunction(() => window.fixtureEventSourceCount() === 2, { timeout: 2500 })
  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  await page.evaluate(() => window.openFixtureEventSource())
  await page.evaluate(() => {
    window.emitFixtureEvent({
      type: 'session-state',
      session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 3, historyVersion: 0, modelKey: 'fixture/model' },
    })
    window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed while reconnect stream opened' }], __meta: { seq: 3, timestamp: 30 } })
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

  await page.evaluate(() => window.openFixtureEventSource())
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.emitFixtureMessage({ role: 'model', parts: [{ text: 'committed across pre-open failures' }], __meta: { seq: 2, timestamp: 20 } }))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed across pre-open failures'))
  await page.evaluate(() => window.resolveFixtureHistory())
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(await page.evaluate(() => window.fixtureHistoryRequestCount), 1)
  assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('committed across pre-open failures')), true)
  await page.close()
})

test('pasted text survives a direct user send and canonical history reload with or without a final newline', async () => {
  for (const attachment of ['none', 'file', 'image']) {
    for (const finalNewline of [false, true]) {
      for (const showMetadata of [false, true]) {
        const view = await browser.newPage()
        try {
          await view.setViewport({ width: 1000, height: 720 })
          await view.goto(`${fixtureUrl}?pastedText=1`, { waitUntil: 'load' })
          await view.evaluate(() => window.resolveFixtureHistory(0, []))
          await view.waitForSelector('[role="textbox"][aria-label="Message"]')
          await view.evaluate(value => { window.fixtureShowUserMetadata = value; window.renderFixtureChats() }, showMetadata)
          await view.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

          const pasted = 'A'.repeat(2000) + (finalNewline ? '\n' : '')
          await view.$eval('[role="textbox"][aria-label="Message"]', (editor, { pasted, attachment }) => {
            editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
            editor.focus()
            const text = new DataTransfer()
            text.setData('text/plain', pasted)
            editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: text }))
            if (attachment !== 'none') {
              const files = new DataTransfer()
              files.items.add(new File(['contents'], attachment === 'image' ? 'photo.png' : 'notes.txt', {
                type: attachment === 'image' ? 'image/png' : 'text/plain',
              }))
              editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: files }))
            }
          }, { pasted, attachment })
          await view.waitForFunction(hasAttachment => document.querySelectorAll('.foxwarm-composer-pasted-text-chip').length === 1
            && document.querySelectorAll('.foxwarm-composer-attachment-chip').length === (hasAttachment ? 1 : 0), {}, attachment !== 'none')
          await view.locator('button[aria-label="Send message"]').click()
          await view.waitForFunction(() => window.fixtureMessageBodies.length === 1)
          const sent = await view.evaluate(() => window.fixtureMessageBodies[0])
          const exactText = `<pasted-text>${pasted}</pasted-text>${attachment === 'none' ? '' : '<attachment-ref ref="attachment1" />'}`
          assert.deepEqual(sent.parts, [{ text: exactText }])
          assert.equal(sent.uploadedFiles.length, attachment === 'none' ? 0 : 1)
          assert.equal(await view.evaluate(() => document.querySelectorAll('.foxwarm-pasted-text-block:not(.foxwarm-composer-pasted-text-chip)').length), 1)

          // Plain WebUI text (including file descriptors) is stored as one source-wrapped system part.
          const opening = '<foxwarm-message type="channel" channelType="webui" time="2026-09-10 17:31:53 +0800" hint="direct user message via channel">'
          const descriptor = attachment === 'none' ? '' : `<foxwarm-${attachment} name="attachment1_${attachment === 'image' ? 'photo.png' : 'notes.txt'}" node="master" path="/fixture/upload" mime="${attachment === 'image' ? 'image/png' : 'text/plain'}" />`
          const parts = attachment === 'image'
            ? [{ system: opening }, { text: exactText }, { text: descriptor }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } }, { system: '</foxwarm-message>' }]
            : [{ system: `${opening}\n${exactText}${descriptor ? `\n${descriptor}` : ''}\n</foxwarm-message>` }]
          await view.evaluate(() => window.resolveFixtureMessages())
          await view.evaluate(() => window.renderFixtureChats(1, 1))
          await view.waitForFunction(() => window.fixtureHistoryRequestCount >= 2)
          await view.evaluate(canonicalParts => window.resolveFixtureHistory(0, [{ role: 'user', parts: canonicalParts, __meta: { seq: 1, timestamp: 1000 } }], 1), parts)
          await view.waitForSelector('[data-chat-message-anchor-key] .foxwarm-pasted-text-block')
          const history = await view.$('[data-chat-message-anchor-key]')
          assert.equal(await history.$eval('.foxwarm-pasted-text-block', chip => chip.textContent.includes('A'.repeat(72))), true)
          const rawText = await history.evaluate(row => row.textContent)
          assert.equal(rawText.includes('channelType="webui"'), showMetadata)
          await view.locator('[data-chat-message-anchor-key] .foxwarm-pasted-text-block').click()
          await view.waitForSelector('textarea[aria-label="Full pasted text"]')
          assert.equal(await view.$eval('textarea[aria-label="Full pasted text"]', textarea => textarea.value), pasted)
        } finally {
          await view.close()
        }
      }
    }
  }
})

for (const segmented of [false, true]) {
  test(`busy Chat sends preserve ${segmented ? 'early-commentary suffix' : 'ordinary'} draft through ACK, queue history, and covered offset deltas`, async () => {
    page = await browser.newPage()
    await page.goto(fixtureUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await page.evaluate(() => window.resolveFixtureHistory(0, undefined, 0, { busy: true }))
    await page.waitForFunction(() => document.body.textContent.includes('old history row'))
    const request = { streamVersion: 2, streamId: 'send-stream', llmRequestId: 'send-request', startedAt: 100 }
    const historyRows = [{ role: 'user', parts: [{ text: 'old history row' }], __meta: { seq: 1, timestamp: 10 } }]
    const resolveBusyHistory = (queueLength, queuedMessages = []) => page.evaluate(({ queueLength, queuedMessages, rows }) => {
      const requestUrl = new URL(window.fixtureRequests.filter(url => url.includes('/history')).at(-1), location.href)
      const afterSeq = requestUrl.searchParams.get('afterSeq')
      window.resolveFixtureHistory(queueLength, afterSeq === null ? rows : rows.filter(row => row.__meta.seq > Number(afterSeq)), 0,
        { busy: true, latestSeq: rows.at(-1).__meta.seq, messageCount: rows.length, queuedMessages })
    }, { queueLength, queuedMessages, rows: historyRows })
    const outputIndex = segmented ? 1 : 0
    const delta = (sequence, offset, text) => ({
      ...request, type: 'model-stream-update', sequenceStart: sequence, sequence,
      ...(segmented ? { partDeltas: [{ outputIndex, kind: 'text', contentIndex: 0, phase: 'final_answer', textDelta: { offset, text } }] } : { textDelta: { offset, text } }),
    })
    const emit = event => page.evaluate(event => window.emitFixtureEvent({ type: 'session-event', event }), event)
    await emit({ ...request, type: 'model-stream-reset', sequence: 0 })
    if (segmented) {
      await emit({ ...request, type: 'model-stream-update', sequenceStart: 1, sequence: 1,
        partDeltas: [{ outputIndex: 0, kind: 'text', contentIndex: 0, phase: 'commentary', textDelta: { offset: 0, text: 'Committed commentary.' } }] })
      const commentary = { role: 'model', parts: [{ text: 'Committed commentary.', phase: 'commentary' }],
        __meta: { seq: 2, timestamp: 110, llmRequestId: 'send-request', llmSegment: { outputStart: 0, outputEndExclusive: 1, complete: false } } }
      historyRows.push(commentary)
      await page.evaluate(message => window.emitFixtureMessage(message), commentary)
      await emit({ ...request, type: 'model-stream-update', sequenceStart: 2, sequence: 2, trimBeforeOutputIndex: 1 })
    }
    let sequence = segmented ? 3 : 1
    await emit(delta(sequence++, 0, 'Before send '))
    const draftSelector = `[data-search-row="llm-request-send-request${segmented ? '-output-1' : ''}"]`
    const readDraft = () => page.$eval(draftSelector, node => node.textContent.trim())
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === 'Before send', {}, draftSelector)
    await page.type('[role="textbox"][aria-label="Message"]', 'Input while streaming')
    await page.click('[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
    assert.equal(await readDraft(), 'Before send', 'POST pending retains the active prefix')
    await emit(delta(sequence++, 12, 'after send'))
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === 'Before send after send', {}, draftSelector)
    await page.evaluate(() => window.resolveFixtureMessages())
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    const lastSeq = segmented ? 2 : 1
    await resolveBusyHistory(1, [{ role: 'user', parts: [{ text: 'Input while streaming' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'send-preview' } }])
    await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('Input while streaming'))
    assert.equal(await readDraft(), 'Before send after send', 'ACK and authoritative queue history retain the prefix')

    // A duplicate covered event is ignored; a new sequence replaces its addressed suffix.
    await emit(delta(sequence - 1, 12, 'must not appear'))
    await emit(delta(sequence++, 12, 'after send plus overlap'))
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === 'Before send after send plus overlap', {}, draftSelector)
    const sent = await page.evaluate(() => window.fixtureMessageBodies[0])
    const canonicalUser = { role: 'user', parts: sent.parts, __meta: { seq: lastSeq + 1, timestamp: 120, clientMessageId: sent.clientMessageId } }
    historyRows.push(canonicalUser)
    await page.evaluate(message => window.emitFixtureMessage(message), canonicalUser)
    await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Input while streaming'))
    assert.equal(await readDraft(), 'Before send after send plus overlap', 'canonical user append does not consume a model draft')
    await page.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
    await resolveBusyHistory(0)
    await page.waitForFunction(() => !document.querySelector('[data-queued-preview]'))
    await emit(delta(sequence++, 'Before send after send plus overlap'.length, ' continues'))
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === 'Before send after send plus overlap continues', {}, draftSelector)

    // A rejected second send also cannot erase the still-active model request.
    await page.type('[role="textbox"][aria-label="Message"]', 'Rejected input')
    await page.click('[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureMessageBodies.length === 2)
    await page.evaluate(() => window.rejectNextFixtureMessage())
    await page.waitForFunction(() => document.body.textContent.includes('Error: Failed to send message'))
    assert.equal(await readDraft(), 'Before send after send plus overlap continues')
    await emit(delta(sequence++, 'Before send after send plus overlap continues'.length, ' alive'))
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim().endsWith(' continues alive'), {}, draftSelector)

    // Matching completed canonical output closes exactly this draft, even while busy.
    await page.evaluate(({ segmented, seq }) => window.emitFixtureMessage({ role: 'model', parts: [{ text: 'Before send after send plus overlap continues alive' }],
      __meta: { seq, timestamp: 130, llmRequestId: 'send-request', ...(segmented ? { llmSegment: { outputStart: 1, outputEndExclusive: 2, complete: true } } : {}) },
    }), { segmented, seq: lastSeq + 2 })
    await page.waitForSelector(`[data-chat-message-anchor-key="seq-local-${lastSeq + 2}"]`)
    assert.equal(await page.$$eval(draftSelector, nodes => nodes.length), 1, 'canonical handoff contains no duplicate synthetic row')
    await emit({ ...request, type: 'model-stream-reset', streamId: 'next-stream', llmRequestId: 'next-request', startedAt: 140, sequence: 0 })
    await emit({ ...request, type: 'model-stream-update', streamId: 'next-stream', llmRequestId: 'next-request', startedAt: 140,
      sequenceStart: 1, sequence: 1, textDelta: { offset: 0, text: 'New request only' } })
    await page.waitForFunction(() => document.querySelector('[data-search-row="llm-request-next-request"]')?.textContent.trim() === 'New request only')
    // A new request reset also replaces an unfinished draft, without joining its prefix.
    await emit({ ...request, type: 'model-stream-reset', streamId: 'replacement-stream', llmRequestId: 'replacement-request', startedAt: 150, sequence: 0 })
    await emit({ ...request, type: 'model-stream-update', streamId: 'replacement-stream', llmRequestId: 'replacement-request', startedAt: 150,
      sequenceStart: 1, sequence: 1, textDelta: { offset: 0, text: 'Replacement request only' } })
    await page.waitForFunction(() => document.querySelector('[data-search-row="llm-request-replacement-request"]')?.textContent.trim() === 'Replacement request only')
    assert.equal(await page.$('[data-search-row="llm-request-next-request"]'), null)
    await page.evaluate(messageCount => window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false,
      runtimeState: { state: 'idle' }, queueLength: 0, messageCount, historyVersion: 0, modelKey: 'fixture/model' } }), lastSeq + 2)
    await page.waitForFunction(() => !document.querySelector('[data-search-row="llm-request-replacement-request"]'))
    if (segmented) assert.equal(await page.$$eval('[data-search-row="llm-request-send-request"]', nodes => nodes.length), 1, 'early commentary remains canonical')
    await page.close()
  })
}

test('real Chat WS call commit, tool result, and final model row retain a manually opened running tool', async () => {
  page = await browser.newPage()
  await page.goto(`${fixtureUrl}?timelineView`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await page.evaluate(() => window.resolveFixtureHistory(0, undefined, 0, { busy: true }))
  await page.waitForFunction(() => document.body.textContent.includes('old history row'))
  await page.evaluate(() => window.emitFixtureEvent({ type: 'session-event', event: {
    type: 'model-stream-update', streamVersion: 2, streamId: 'tool-stream', llmRequestId: 'tool-request', startedAt: 100,
    sequenceStart: 1, sequence: 1, toolCallDeltas: [{ index: 0, id: 'running-call', name: 'exec', argumentsDelta: { offset: 0, text: '{"command":"echo running"}' } }],
  } }))
  await page.waitForSelector('[aria-label="Expand exec tool"]')
  await page.click('[aria-label="Expand exec tool"]')
  await page.waitForSelector('.foxwarm-tool-call-args')
  await page.evaluate(() => window.emitFixtureMessage({ role: 'model', parts: [{ functionCall: { id: 'running-call', name: 'exec', args: { command: 'echo running' } } }],
    __meta: { seq: 2, timestamp: 110, llmRequestId: 'tool-request' } }))
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-2"]')
  assert.ok(await page.$('.foxwarm-tool-call-args'), 'matching canonical call retains explicit disclosure')
  await page.evaluate(() => window.emitFixtureMessage({ role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'running-call', response: { output: 'Running tool completed' } } }],
    __meta: { seq: 3, timestamp: 120 } }))
  await page.waitForSelector('.foxwarm-tool-expanded-content')
  assert.ok(await page.$('.foxwarm-tool-call-args'), 'normal result pairing retains explicit disclosure')
  await page.evaluate(() => window.emitFixtureMessage({ role: 'model', parts: [{ text: 'Tool run finished normally' }], __meta: { seq: 4, timestamp: 130, llmRequestId: 'final-request' } }))
  await page.waitForFunction(() => document.body.textContent.includes('Tool run finished normally'))
  assert.equal(await page.$eval('[data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'historical regrouping retains the owning group')
  assert.equal(await page.$eval('.foxwarm-tool-expanded-content', node => node.textContent.trim()), 'Running tool completed')
  await page.close()
})


async function openContinuousChat(query = '') {
  const chatPage = await browser.newPage()
  await chatPage.setViewport({ width: 1000, height: 760 })
  await chatPage.goto(`${fixtureUrl}?continuous=1${query}`, { waitUntil: 'load' })
  await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary, not original history' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
  return chatPage
}

const readingAnchor = chatPage => chatPage.evaluate(() => {
  const container = document.querySelector('.foxwarm-chat-messages')
  const viewport = container.getBoundingClientRect()
  const anchor = [...container.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > viewport.top)
  return { key: anchor?.getAttribute('data-chat-message-anchor-key'), offset: anchor?.getBoundingClientRect().top - viewport.top }
})

async function loadContinuousEarlier(chatPage) {
  await chatPage.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
    container.scrollTop = 5
    container.dispatchEvent(new Event('scroll'))
  })
}

test('continuous Chat loads one recent page, retries earlier pages, bounds mounted rows, and keeps independent mode positions', async () => {
  const chatPage = await openContinuousChat()
  try {
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 1)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary')), false)
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length), 100)
    await chatPage.evaluate(() => { window.fixtureFailArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => document.querySelector('[data-continuous-history]')?.textContent.includes('could not be loaded'))
    await chatPage.click('[data-continuous-history] button')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = 800
      container.dispatchEvent(new Event('scroll'))
    })
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForSelector(`[data-chat-message-anchor-key="${reading.key}"]`)
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, {}, reading)
    // The two internal axes also support Detailed over the already-loaded raw source.
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForSelector(`[data-chat-message-anchor-key="${reading.key}"]`)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary')), false)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    const requestsBeforeSearch = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Original narrative 301')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), requestsBeforeSearch, 'Search mounts loaded history without fetching Archive')
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Close search"]')
  } finally { await chatPage.close() }
})

test('continuous Chat preserves raw reading anchors through a concurrent compact and live append', async () => {
  const chatPage = await openContinuousChat()
  try {
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = 900
      container.dispatchEvent(new Event('scroll'))
    })
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Live reply after another compact' }], __meta: { seq: 601, timestamp: 1700000001000 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Second generated summary' }], __meta: { contextBlock: { id: 2, level: 2, sourceKind: 'block', rawStartSeq: 1, rawEndSeq: 600 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 601 }))
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, {}, reading)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Second generated summary')), false)
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat reconciles optimistic sends and live drafts while an older page is pending', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    const reading = await readingAnchor(chatPage)
    await chatPage.type('[role="textbox"][aria-label="Message"]', 'Concurrent original input')
    await chatPage.click('[aria-label="Send message"]')
    await chatPage.waitForFunction(() => window.fixtureMessageBodies.length === 1)
    await chatPage.evaluate(() => {
      const clientMessageId = window.fixtureMessageBodies[0].clientMessageId
      const message = { role: 'user', parts: [{ text: 'Concurrent original input' }], __meta: { seq: 601, timestamp: 1700000000601, clientMessageId } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 0 }, queueLength: 0, messageCount: 8, historyVersion: 1, modelKey: 'fixture/model' } })
      window.emitFixtureEvent({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'continuous-stream', text: 'Live uncommitted reply' } })
      window.resolveFixtureMessages()
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, { timeout: 5000 }, reading)
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-601"]'), null, 'an old window does not append a disconnected live tail')
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Live uncommitted reply'))
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})


test('continuous Chat ignores a pending page viewport correction after switching to active history', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    const before = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const after = await readingAnchor(chatPage)
    assert.equal(after.key, before.key)
    assert.ok(Math.abs(after.offset - before.offset) < 3)
    assert.equal(await chatPage.$('[data-continuous-history]'), null)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-501"]')
  } finally { await chatPage.close() }
})

test('continuous Chat commits a queued input and removes its preview in the same frame', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 1 }, queueLength: 1, messageCount: 7, historyVersion: 1, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(1, [], 1, { latestSeq: 600, messageCount: 7, busy: true, queuedMessages: [{ role: 'user', parts: [{ text: 'Continuous queued input' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-0-user-fixture', queueType: 'user', queueIndex: 0 } }] }))
    await chatPage.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('Continuous queued input'))
    await chatPage.evaluate(() => {
      window.fixtureQueueFrames = []
      const sample = () => {
        window.fixtureQueueFrames.push({ committed: !!document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Continuous queued input'), queued: !!document.querySelector('[data-queued-preview]')?.textContent.includes('Continuous queued input') })
        if (window.fixtureQueueFrames.length < 12) requestAnimationFrame(sample)
      }
      sample()
      const message = { role: 'user', parts: [{ text: 'Continuous queued input' }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 0 }, queueLength: 0, messageCount: 8, historyVersion: 1, modelKey: 'fixture/model' } })
      window.emitFixtureEvent({ type: 'history-append', messages: [message], queuedMessages: [], queueLength: 0, messageCount: 8, historyVersion: 1 })
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.waitForFunction(() => window.fixtureQueueFrames.length === 12)
    assert.equal(await chatPage.$('[data-queued-preview]'), null)
    assert.equal(await chatPage.evaluate(() => window.fixtureQueueFrames.every(frame => frame.committed !== frame.queued)), true)
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
  } finally { await chatPage.close() }
})


test('continuous Chat Search follows active retry visibility instead of the Archive tail', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const retry = { role: 'model', modelVisible: false, parts: [{ text: '⚠️ LLM Error: Old archived retry' }], __meta: { seq: 601, timestamp: 1700000000601, noticeType: 'llm-retry', retry: { final: true } } }
      window.fixtureArchive.push(retry)
      window.emitFixtureMessage(retry)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForSelector('[data-chat-timeline="committed"] [data-system-event]')
    assert.equal(await chatPage.$eval('[data-chat-timeline="committed"] [data-system-event]', node => !!node.closest('[data-activity-details]')), false)
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary covering the old retry' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 601 } } }], 2, { latestSeq: 601 }))
    await chatPage.waitForFunction(() => !document.querySelector('[data-chat-timeline="committed"] [data-system-event]'))
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Old archived retry')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
  } finally { await chatPage.close() }
})


test('continuous Chat catches up by one bounded page and returns to latest without draining a disconnected Archive gap', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 800; seq++) window.fixtureArchive.push({ role: seq % 2 ? 'user' : 'model', parts: [{ text: 'Offline original ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } })
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary after offline work' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 799 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 800 }))
    await chatPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-800"]'), null)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Live commit while returning to latest' }], __meta: { seq: 801, timestamp: 1700000000801 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-800"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-801"]')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages')), false)
  } finally { await chatPage.close() }
})

test('continuous Chat backfills original Archive tool results rather than pruned active snapshots', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      window.fixtureTimelineView = 'detailed'
      window.fixtureHistoryMode = 'continuous'
      window.renderFixtureChats()
      window.fixtureDelayArchive = true
      const original = { role: 'tool', parts: [{ functionResponse: { id: 'archive-tool', name: 'exec', response: { result: 'FullOriginalArchiveResult' } } }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(original)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => {
      const pruned = structuredClone(window.fixtureArchive.at(-1))
      pruned.parts[0].functionResponse.response.result = 'PrunedActiveSnapshotResult'
      window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary before the tool result' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 600 } } }, pruned], 2, { latestSeq: 601 })
    })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'PrunedActiveSnapshotResult')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-601"]'), null)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.click('[aria-label="Search messages"]', { clickCount: 3 })
    await chatPage.type('[aria-label="Search messages"]', 'FullOriginalArchiveResult')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('PrunedActiveSnapshotResult')), false)
  } finally { await chatPage.close() }
})


async function readOlderContinuousPosition(chatPage) {
  await loadContinuousEarlier(chatPage)
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
  await loadContinuousEarlier(chatPage)
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
  await chatPage.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    container.scrollTop = 900
    container.dispatchEvent(new Event('scroll'))
  })
  await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return readingAnchor(chatPage)
}

async function waitForReadingPosition(chatPage, expected) {
  await chatPage.waitForFunction(expected => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const anchor = [...container.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > container.getBoundingClientRect().top)
    return anchor?.getAttribute('data-chat-message-anchor-key') === expected.key
      && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
  }, {}, expected)
}

test('continuous Chat keeps its older window when active history returns to bottom', async () => {
  const chatPage = await openContinuousChat()
  try {
    const before = await readOlderContinuousPosition(chatPage)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      container.scrollTop = 20
      container.dispatchEvent(new Event('scroll'))
    })
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat remount locates an older saved row with two bounded pages', async () => {
  const chatPage = await openContinuousChat()
  try {
    const before = await readOlderContinuousPosition(chatPage)
    const requestsBefore = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.evaluate(() => window.renderFixtureChats(1, 1))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
    await waitForReadingPosition(chatPage, before)
    const requests = await chatPage.evaluate(() => window.fixtureArchiveRequests)
    const seq = Number(before.key.match(/-(\d+)$/)[1])
    assert.deepEqual(requests.slice(requestsBefore).map(url => new URL(url, 'http://fixture').search), [`?beforeSeq=${seq + 1}`, `?afterSeq=${seq}`])
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
  } finally { await chatPage.close() }
})

test('continuous Chat retains live commits racing the final later page and accepts subsequent commits', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 800; seq++) window.fixtureArchive.push({ role: seq % 2 ? 'user' : 'model', parts: [{ text: 'Offline original ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } })
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary after offline work' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 799 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 800 }))
    await chatPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    await chatPage.evaluate(() => {
      window.fixtureDelayArchive = true
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Load newer messages').click()
    })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Racing canonical 801' }], __meta: { seq: 801, timestamp: 1700000000801 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 3, historyVersion: 2, modelKey: 'fixture/model' } })
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForFunction(() => ![...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Subsequent canonical 802' }], __meta: { seq: 802, timestamp: 1700000000802 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 4, historyVersion: 2, modelKey: 'fixture/model' } })
      window.emitFixtureMessage(message)
    })
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Racing canonical 801')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.click('[aria-label="Search messages"]', { clickCount: 3 })
    await chatPage.type('[aria-label="Search messages"]', 'Subsequent canonical 802')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureHistoryRequestCount), 2)
  } finally { await chatPage.close() }
})

test('continuous Chat remount mounts its saved window even when a live burst outgrows the recent tail', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      const anchor = container.querySelector('[data-chat-message-anchor-key="seq-local-550"]')
      container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + 29.5
      container.dispatchEvent(new Event('scroll'))
    })
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await readingAnchor(chatPage)
    assert.equal(before.key, 'seq-local-550')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true; window.renderFixtureChats(1, 1) })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2 && window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 900; seq++) {
        const message = { role: 'model', parts: [{ text: 'Concurrent canonical ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } }
        window.fixtureArchive.push(message)
        window.emitFixtureMessage(message)
      }
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
      window.resolveFixtureArchive()
    })
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

async function observeNativeHistoryInput(chatPage) {
  await chatPage.evaluate(() => {
    window.fixtureNativeHistoryInput = []
    const container = document.querySelector('.foxwarm-chat-messages')
    for (const type of ['wheel', 'touchmove', 'scroll']) container.addEventListener(type, event => {
      window.fixtureNativeHistoryInput.push({ type, trusted: event.isTrusted, top: container.scrollTop })
    }, { passive: true })
  })
  const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await chatPage.mouse.move(rect.x, rect.y)
  return rect
}

async function openContinuousTopEdge() {
  const chatPage = await openContinuousChat()
  await chatPage.waitForSelector('[aria-label="Scroll to top"]')
  await chatPage.click('[aria-label="Scroll to top"]')
  await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop === 0)
  await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return chatPage
}

test('continuous Chat rechecks a rapid upward gesture that reaches the top during a slow page', async () => {
  const chatPage = await openContinuousChat()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop === 0)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.filter(event => event.type === 'wheel' && event.trusted).length >= 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-continuous-history]').textContent.includes('Loading messages'))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]', { timeout: 5000 })
    const result = await chatPage.evaluate(() => ({
      top: document.querySelector('.foxwarm-chat-messages').scrollTop,
      first: document.querySelector('[data-chat-message-anchor-key]')?.getAttribute('data-chat-message-anchor-key'),
      requests: window.fixtureArchiveRequests.length,
      inputs: window.fixtureNativeHistoryInput,
    }))
    console.log('RAPID_TOP_PAGE', JSON.stringify(result))
    assert.equal(result.first, 'seq-local-401')
    assert.equal(result.requests, 2, 'completing one page must not drain Archive without another gesture')
    assert.ok(result.top > 0, 'earlier rows must become reachable without a downward gesture')
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, { timeout: 5000 }, reading)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    assert.equal(await chatPage.evaluate(() => new URL(window.fixtureArchiveRequests[2], location.href).searchParams.get('beforeSeq')), '401')
  } finally { await chatPage.close() }
})

test('continuous Chat accepts an upward wheel at the top without a native scroll event', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'wheel' && event.trusted))
    const result = await chatPage.evaluate(() => ({ requests: window.fixtureArchiveRequests.length, inputs: window.fixtureNativeHistoryInput }))
    console.log('CLAMPED_TOP_WHEEL', JSON.stringify(result))
    assert.equal(result.inputs.filter(event => event.type === 'scroll').length, 0)
    assert.equal(result.requests, 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
  } finally { await chatPage.close() }
})

test('continuous Chat accepts an upward-history touch gesture at the clamped top', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    const rect = await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    const client = await chatPage.createCDPSession()
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y - 100 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x, y: rect.y + 80 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'touchmove' && event.trusted))
    const result = await chatPage.evaluate(() => ({ requests: window.fixtureArchiveRequests.length, inputs: window.fixtureNativeHistoryInput }))
    console.log('CLAMPED_TOP_TOUCH', JSON.stringify(result))
    assert.equal(result.inputs.filter(event => event.type === 'scroll').length, 0)
    assert.equal(result.requests, 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await client.detach()
  } finally { await chatPage.close() }
})

test('continuous Chat keeps top-edge failures explicit and retries without a reverse gesture', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true; window.fixtureFailArchive = true })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForFunction(() => document.querySelector('[data-continuous-history]').textContent.includes('Messages could not be loaded'))
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.filter(event => event.type === 'wheel' && event.trusted).length >= 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2, 'an upward gesture must not silently retry an error')
    await chatPage.click('[data-continuous-history] button')
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await chatPage.mouse.move(rect.x, rect.y)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Canonical live input during top-edge retry' }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
  } finally { await chatPage.close() }
})

async function sampleHistoryFrames(chatPage, key, attribute = 'data-chat-message-anchor-key') {
  await chatPage.evaluate(({ key, attribute }) => {
    window.fixtureHistoryFrames = []
    const sample = () => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[' + attribute + '="' + key + '"]')
      window.fixtureHistoryFrames.push({ top: container.scrollTop, height: container.scrollHeight,
        offset: anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : null,
        first: container.querySelector('[data-chat-message-anchor-key]')?.getAttribute('data-chat-message-anchor-key') })
      if (window.fixtureHistoryFrames.length < 26) requestAnimationFrame(sample)
    }
    sample()
  }, { key, attribute })
}

async function wheelHistoryTo(chatPage, top) {
  const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, top: element.scrollTop }
  })
  await chatPage.mouse.move(rect.x, rect.y)
  await chatPage.mouse.wheel({ deltaY: top - rect.top })
  await chatPage.waitForFunction(top => Math.abs(document.querySelector('.foxwarm-chat-messages').scrollTop - top) < 2, {}, top)
}

test('continuous Chat requests history within 500px and mounts a slow reply at the current reading point without more input', async () => {
  const chatPage = await openContinuousChat('&variedHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'wheel' && event.trusted))
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2, 'request while still hundreds of pixels above the boundary')
    await chatPage.mouse.wheel({ deltaY: 70 })
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop > 450)
    const reading = await readingAnchor(chatPage)
    await sampleHistoryFrames(chatPage, reading.key)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('SLOW_HISTORY_CURRENT_READER_FRAMES', JSON.stringify(frames))
    assert.ok(frames.some(frame => frame.first === 'seq-local-401'), 'a successful page mounts even after the reader changed direction and stopped')
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - reading.offset) < 3), 'every sampled paint retains the current reading point, not the request-time point')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
  } finally { await chatPage.close() }
})

test('continuous Chat retains a visible outcome across Conversation process merging and window replacement in every frame', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await sampleHistoryFrames(chatPage, 'seq-local-600')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('MERGED_PROCESS_REPLACEMENT_FRAMES', JSON.stringify(frames))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3), 'the visible outcome cannot disappear or jump during a folded process replacement')
    assert.ok(frames.some(frame => frame.first === 'seq-local-301'))
  } finally { await chatPage.close() }
})

test('continuous Chat replaces variable-height windows without a displaced frame', async () => {
  const chatPage = await openContinuousChat('&variedHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.mouse.wheel({ deltaY: 70 })
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop > 450)
    const reading = await readingAnchor(chatPage)
    await sampleHistoryFrames(chatPage, reading.key)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('VARIABLE_HEIGHT_REPLACEMENT_FRAMES', JSON.stringify(frames))
    assert.ok(frames.some(frame => frame.first === 'seq-local-301'))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - reading.offset) < 3))
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat retains an opened process and its reading point when a slow earlier page joins it', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.click('[aria-label="Expand activity"]')
    await chatPage.waitForFunction(() => {
      const activity = document.querySelector('[data-timeline-activity]')
      return activity?.dataset.activityExpanded === 'true' && !activity.style.height
    })
    await chatPage.waitForSelector('[data-search-row="seq-local-502"]')
    await chatPage.click('[data-search-row="seq-local-502"] [aria-label="Expand exec tool"]')
    await chatPage.waitForSelector('[data-search-row="seq-local-502"] .foxwarm-tool-call-args')
    await chatPage.waitForFunction(() => [...document.querySelectorAll('[data-activity-details] [style]')].every(element => !element.style.transition.includes('height')))
    await sampleHistoryFrames(chatPage, 'seq-local-502', 'data-search-row')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('OPEN_PROCESS_RESPONSE_FRAMES', JSON.stringify(frames))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3))
    assert.equal(await chatPage.$eval('[data-timeline-activity]', node => node.dataset.activityExpanded), 'true')
    assert.ok(await chatPage.$('[data-search-row="seq-local-502"] .foxwarm-tool-call-args'), 'the reader’s nested tool disclosure stays open')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-timeline-activity]'))
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.dataset.activityExpanded === 'true')
  } finally { await chatPage.close() }
})

test('continuous Chat keeps loaded Search navigation authoritative after extending a folded process window', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    for (const seq of [201, 101]) {
      await chatPage.mouse.wheel({ deltaY: -100000 })
      await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-' + seq + '"]')
    }
    await chatPage.evaluate(() => { window.fixtureHistoryMode = 'continuous'; window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-timeline-activity]'))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    await chatPage.mouse.wheel({ deltaY: -100 })
    await chatPage.waitForSelector('[aria-label="Scroll to bottom"]')
    const requests = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Earlier process checkpoint 102')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.keyboard.press('Enter')
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const row = container.querySelector('[data-search-row="seq-local-102"]')
      if (!row) return false
      return row.getBoundingClientRect().bottom > container.getBoundingClientRect().top && row.getBoundingClientRect().top < container.getBoundingClientRect().bottom
    }), true)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), requests)
  } finally { await chatPage.close() }
})
