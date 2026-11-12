import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { build } from './browserFixtureBundle.mjs'

// Shared harness for the actual-Chat browser fixtures: the real Chat component bundled with
// scripted history/message HTTP responses and a controllable realtime socket. Each e2e file
// starts its own server and Chromium so the runner can place files on different workers.

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = fileURLToPath(new URL('../src/components/Chat.tsx', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
    import { storeChatViewportState } from './src/chatViewportState'
    import { initializeThemeRuntime, setThemeSelection } from './src/theme'
    window.initializeFixtureTheme = () => { initializeThemeRuntime(); setThemeSelection({themeId:'foxwarm.default',colorMode:'dark'}) }

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
    if (new URLSearchParams(location.search).has('bufferedProcesses')) window.fixtureArchive = Array.from({ length: 600 }, (_, index) => {
      const seq = index + 1
      const meta = { seq, timestamp: 1700000000000 + index }
      if (seq === 1) return { role: 'user', parts: [{ text: 'Start the first process.' }], __meta: meta }
      if (seq === 250 || seq === 500) return { role: 'model', parts: [{ text: 'Buffered process outcome ' + seq }], __meta: meta }
      if (seq === 251) return { role: 'user', parts: [{ text: 'Buffered tall user input.\\n\\n' + 'Ordinary paragraph in the protected reading area.\\n\\n'.repeat(24) }], __meta: meta }
      if (seq > 500) return { role: seq % 2 ? 'user' : 'model', parts: [{ text: 'Buffered ordinary message ' + seq }], __meta: meta }
      const id = 'buffered-call-' + Math.floor(seq / 2)
      return seq % 2 ? { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: 'Buffered process output' } } }], __meta: meta }
        : { role: 'model', parts: [{ functionCall: { name: 'exec', id, args: { command: 'buffered command ' + seq } } }], __meta: meta }
    })
    if (new URLSearchParams(location.search).has('multiPartHistory')) window.fixtureArchive = window.fixtureArchive.map(message => message.__meta.seq === 500 ? { ...message, role: 'model', parts: [
      { text: 'First body paragraph.\\n\\n'.repeat(80) },
      { text: 'MULTIPART_READER\\n\\n' + 'Second body paragraph.\\n\\n'.repeat(80) },
    ] } : message)
    window.fixtureBlockExpansions = {}
    window.fixtureDelayedBlocks = {}
    window.resolveFixtureBlock = id => { const resolve = window.fixtureDelayedBlocks[id]; delete window.fixtureDelayedBlocks[id]; resolve?.() }
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
      for (const message of messages) {
        const block = message.__meta?.contextBlock
        if (block?.sourceKind === 'block' && !window.fixtureBlockExpansions[block.id]) window.fixtureBlockExpansions[block.id] = [{ role: 'model', parts: [{ text: 'Child block' }], __meta: { contextBlock: { ...block, id: 10000 + block.id, level: 1, sourceKind: 'message' } } }]
      }
      const latestSeq = extras.latestSeq ?? messages.reduce((latest, message) => Math.max(latest, message.__meta?.seq || 0), 0)
      entry.resolve(new Response(JSON.stringify({
        session: { id: extras.sessionId || 'fixture/main', busy: extras.busy ?? false, busyStartedAt: extras.busyStartedAt, runtimeState: extras.runtimeState ?? { state: extras.busy ? 'requesting-model' : 'idle', busy: extras.busy ?? false, queueLength }, queueLength, messageCount: extras.messageCount ?? messages.length, historyVersion, modelKey: 'fixture/model' },
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
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
      if (url.includes('/context-blocks/')) {
        if (window.fixtureFailBlocks) return new Response('{}', { status: 503 })
        const id = Number(url.match(/context-blocks\\/(\\d+)/)?.[1])
        const reply = () => new Response(JSON.stringify({ messages: window.fixtureBlockExpansions[id] || [] }), { status: 200 })
        if (window.fixtureDelayBlockIds?.includes(id)) return new Promise(resolve => { window.fixtureDelayedBlocks[id] = () => resolve(reply()) })
        return reply()
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
    console.error(`[Chat fixture startup failed: ${name}]`, error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Starts the fixture server and Chromium. Call `close()` from the file's `after` hook. */
export async function startChatFixture() {
  let browser
  let server
  let fixtureUrl
  const close = async () => {
    await browser?.close()
    await new Promise(resolve => server ? server.close(resolve) : resolve())
  }
  try {
    if (process.env.FOXWARM_E2E_SCREENSHOT_DIR) await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR, { recursive: true })
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
  } catch (error) {
    await close()
    throw error
  }
  return { browser, fixtureUrl, close }
}
