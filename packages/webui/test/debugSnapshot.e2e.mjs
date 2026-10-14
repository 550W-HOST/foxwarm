import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createEditorFixtureServer } from './editorFixtureServer.mjs'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = fileURLToPath(new URL('../src/components/Chat.tsx', import.meta.url))
let browser
let server
let fixtureUrl

function fixtureSource() {
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

    class FixtureWebSocket {
      static CLOSED = 3
      static instances = []
      constructor() {
        this.readyState = 0
        this.sessionId = ''
        FixtureWebSocket.instances.push(this)
        queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit({ type: 'connected' }) })
      }
      close() { this.readyState = FixtureWebSocket.CLOSED }
      send(raw) { const payload = JSON.parse(raw); if (payload.type !== 'set-subscriptions') return; this.sessionId = payload.sessionIds[0] || this.sessionId; queueMicrotask(() => { this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: Object.fromEntries(payload.sessionIds.map(id => [id, id])) }); this.emit({ type: 'subscriptions-applied', revision: payload.revision }) }) }
      emit(payload) { const message = ['session-state', 'session-event', 'message', 'session-deleted'].includes(payload.type) && !payload.sessionId ? { ...payload, sessionId: this.sessionId } : payload; this.onmessage?.({ data: originalStringify(message) }) }
    }
    window.WebSocket = FixtureWebSocket
    window.emitFixtureEvent = payload => FixtureWebSocket.instances.at(-1)?.emit(payload)

    const root = createRoot(document.getElementById('root'))
    window.renderFixture = sessionId => root.render(React.createElement(Chat, {
      sessionId,
      canonicalSessionId: sessionId,
      sessionDisplayName: 'Display ' + sessionId,
    }))
    window.unmountFixture = () => root.unmount()
    window.renderFixture('fixture/main')
  `

  return source
}

async function readSnapshot(page) {
  return page.evaluate(async () => {
    const { loadYamlMonacoSupport } = await import('/src/yamlMonacoSupport.ts')
    const { monaco } = await loadYamlMonacoSupport()
    return monaco.editor.getModels()[0]?.getValue() || ''
  })
}

async function waitForSnapshot(page, version) {
  await page.waitForFunction(version => {
    const editor = document.querySelector('[data-json-inspector-dialog] [data-editor-ready="true"]')
    return !!editor && window.fixtureDebugCaptures.at(-1)?.includes('"fixturePayloadVersion": ' + version)
  }, {}, version)
}

async function openDebug(page) {
  await page.click('button[title="Session options"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'debug info'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info')?.click())
}

async function closeDebug(page) {
  await page.click('button[title="Close"]')
  await page.waitForFunction(() => !document.querySelector('[data-json-inspector-dialog]'))
}

before(async () => {
  server = await createEditorFixtureServer(fixtureSource(), 'debug-snapshot')
  fixtureUrl = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

test('mounted Chat session menu remains above the overlapping context minimap', async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 720 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('.foxwarm-context-scrollbar-shell'))
  await page.click('button[aria-label="Open session options"]')
  await page.waitForSelector('[data-session-ui-settings-menu]')
  const evidence = await page.evaluate(() => {
    const menu = document.querySelector('[data-session-ui-settings-menu]')
    const minimap = document.querySelector('.foxwarm-context-scrollbar-shell')
    if (!(menu instanceof HTMLElement) || !(minimap instanceof HTMLElement)) throw new Error('Expected menu and minimap')
    const menuRect = menu.getBoundingClientRect()
    const minimapRect = minimap.getBoundingClientRect()
    const left = Math.max(menuRect.left, minimapRect.left)
    const right = Math.min(menuRect.right, minimapRect.right)
    const top = Math.max(menuRect.top, minimapRect.top)
    const bottom = Math.min(menuRect.bottom, minimapRect.bottom)
    if (right <= left || bottom <= top) throw new Error('Fixture did not produce menu/minimap overlap')
    const x = (left + right) / 2
    const y = (top + bottom) / 2
    const hit = document.elementFromPoint(x, y)
    return {
      hitInsideMenu: !!hit?.closest('[data-session-ui-settings-menu]'),
      headerZ: getComputedStyle(menu.closest('.sticky')).zIndex,
      minimapZ: getComputedStyle(minimap).zIndex,
    }
  })
  assert.deepEqual(evidence, { hitInsideMenu: true, headerZ: '40', minimapZ: '30' })
  await page.close()
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
  await waitForSnapshot(page, 1)
  const firstSnapshot = await readSnapshot(page)
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) {
    await mkdir(process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/debug-wide.png` })
  }
  await page.click('[data-json-inspector-dialog] .view-lines')
  await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
  await page.waitForSelector('[data-json-inspector-dialog] .find-widget.visible')
  assert.equal(await page.$('[data-chat-search]'), null, 'Monaco Find must not open Chat Search')
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
  assert.equal(await readSnapshot(page), firstSnapshot)
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 1)

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Copy')?.click())
  await page.waitForFunction(() => window.fixtureCopiedText !== null)
  assert.equal(await page.evaluate(() => window.fixtureCopiedText), firstSnapshot)

  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh')?.click())
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 2)
  await page.evaluate(() => window.resolveNextFixtureDebug(2))
  await waitForSnapshot(page, 2)
  const refreshedSnapshot = await readSnapshot(page)
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
  await waitForSnapshot(page, 3)
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 3)
  assert.match(await readSnapshot(page), /stream-after-close/)
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
  assert.equal(await page.$('[data-json-inspector-dialog]'), null)

  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 4)
  await page.evaluate(() => window.resolveNextFixtureDebug(4))
  await page.waitForFunction(() => window.fixtureDebugCaptures.length === 2)
  assert.match(await readSnapshot(page), /"sessionId": "fixture\/other"/)
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

test('Refresh invalidates older pending captures and folds only the new successful snapshot', async () => {
  const page = await browser.newPage()
  await page.goto(fixtureUrl)
  await page.waitForFunction(() => document.body.textContent.includes('history-fixture/main'))
  await openDebug(page)
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 1)
  await page.$$eval('[data-json-inspector-dialog] button', buttons => buttons.find(button => button.textContent.trim() === 'Refresh').click())
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 2 && window.fixtureDebugAbortCount === 1)
  await page.evaluate(() => {
    window.emitFixtureEvent({ type:'message', message:{role:'model',parts:[{text:'message-while-pending'}],__meta:{seq:2,timestamp:2}} })
    window.resolveNextFixtureDebug(1)
  })
  await page.waitForFunction(() => document.body.textContent.includes('message-while-pending'))
  assert.equal(await page.evaluate(() => window.fixtureDebugCaptures.length), 0)
  await page.evaluate(() => window.resolveNextFixtureDebug(2))
  await waitForSnapshot(page, 2)
  assert.doesNotMatch(await readSnapshot(page), /message-while-pending/, 'capture uses its source at request start')
  const expanded = await page.evaluate(async () => {
    const { loadYamlMonacoSupport } = await import('/src/yamlMonacoSupport.ts')
    const { monaco } = await loadYamlMonacoSupport()
    const editor = monaco.editor.getEditors()[0]
    await editor.getAction('editor.unfoldAll').run()
    return editor.getVisibleRanges().map(range => [range.startLineNumber, range.endLineNumber])
  })
  assert.equal(expanded.length, 1)
  await page.$$eval('[data-json-inspector-dialog] button', buttons => buttons.find(button => button.textContent.trim() === 'Refresh').click())
  await page.waitForFunction(() => window.fixtureDebugRequests.length === 3)
  await page.evaluate(() => window.resolveNextFixtureDebug(3))
  await waitForSnapshot(page, 3)
  assert.match(await readSnapshot(page), /message-while-pending/)
  const refreshed = await page.evaluate(async () => {
    const { loadYamlMonacoSupport } = await import('/src/yamlMonacoSupport.ts')
    const { monaco } = await loadYamlMonacoSupport()
    return { models:monaco.editor.getModels().length, visible:monaco.editor.getEditors()[0].getVisibleRanges().length }
  })
  assert.equal(refreshed.models, 1)
  assert.ok(refreshed.visible > 1, 'new snapshot reapplies initial folding')
  await closeDebug(page)
  await page.close()
})
