import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const webui = new URL('..', import.meta.url).pathname
let browser, page, server, fixtureUrl
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from './src/components/Chat'
    import { initializeThemeRuntime, setThemeSelection } from './src/theme'
    initializeThemeRuntime()
    setThemeSelection({ themeId: 'foxwarm.550a', colorMode: 'dark' })
    const short = new URLSearchParams(location.search).has('short')
    const messages = Array.from({ length: short ? 0 : 24 }, (_, index) => ({ role: 'model', parts: [{ text: 'Earlier answer ' + index + '\\n\\nA supported reading position.' }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } }))
    messages.push({ role: 'user', parts: [{ system: '<foxwarm-system kind="event">\\n' + 'Long event detail.\\n'.repeat(75) + '</foxwarm-system>' }], __meta: { seq: messages.length + 1, timestamp: 1700000000025 } })
    messages.push({ role: 'model', parts: [{ thinking: 'Inspect the supported state.' }, { text: 'Reference answer', phase: 'final_answer' }], __meta: { seq: messages.length + 1, timestamp: 1700000000026 } })
    let queuedMessages = [], runtimeState = { state: 'idle', busy: false, queueLength: 0 }, historyVersion = 1, pendingPost = null
    const session = () => ({ id: 'fixture/status', busy: runtimeState.busy, runtimeState, queueLength: runtimeState.queueLength, messageCount: messages.length, historyVersion })
    window.commands = []
    window.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/message')) {
        const body = JSON.parse(init.body)
        if (body.text) window.commands.push(body.text)
        if (!body.text) await new Promise(resolve => { pendingPost = resolve })
        return Response.json({ accepted: true })
      }
      return Response.json(url.includes('/history') ? { session: session(), messages, queuedMessages, queueLength: runtimeState.queueLength, historyVersion }
        : url.includes('/models') ? { models: [] }
        : url.includes('/asr/status') ? { configured: false, available: false } : {})
    }
    class Socket {
      static CLOSED = 3
      static current
      constructor() { Socket.current = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit({ type: 'connected' }) }) }
      close() { this.readyState = Socket.CLOSED }
      emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
      send(raw) { const payload = JSON.parse(raw); if (payload.type === 'set-subscriptions') queueMicrotask(() => {
        this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: { 'fixture/status': 'fixture/status' } })
        this.emit({ type: 'subscriptions-applied', revision: payload.revision })
      }) }
    }
    window.WebSocket = Socket
    const emit = event => Socket.current.emit({ ...event, sessionId: 'fixture/status' })
    window.fixture = {
      state(state, extra = {}) { runtimeState = { ...runtimeState, state, busy: state === 'requesting-model' || state === 'running-tool', ...extra }; emit({ type: 'session-state', session: session() }) },
      queue(count, withPreview = true) {
        runtimeState = { ...runtimeState, queueLength: count }; historyVersion++
        queuedMessages = withPreview ? Array.from({ length: count }, (_, index) => ({ role: 'user', parts: [{ text: 'Queued follow-up ' + index }], __meta: { id: 'queued-' + index, timestamp: 1700000000050 + index } })) : []
        emit({ type: 'session-state', session: session() })
      },
      releaseSend() { pendingPost?.(); pendingPost = null },
      append(text, role = 'model') { const message = { role, parts: [{ text }], __meta: { seq: messages.length + 1, timestamp: 1700000000100 + messages.length } }; messages.push(message); emit({ type: 'message', message }) }
    }
    createRoot(document.getElementById('root')).render(<Chat sessionId="fixture/status" canonicalSessionId="fixture/status" sessionDisplayName="Mock preview · status and queue" timelineView="detailed" />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'chat-bottom-status-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
async function mount(short = false, width = 900) {
  await page.setViewport({ width, height: 800 })
  await page.goto(`${fixtureUrl}/${short ? '?short' : ''}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Reference answer'))
  await page.evaluate(() => document.fonts.ready)
  await wait(120)
}
const geometry = () => page.evaluate(() => {
  const scroll = document.querySelector('.foxwarm-chat-messages')
  const reference = [...document.querySelectorAll('.foxwarm-assistant-message-card')].find(element => element.textContent.includes('Reference answer'))
  return { composer: document.querySelector('.foxwarm-chat-composer').getBoundingClientRect().height, slot: document.querySelector('[data-processing-status-slot]').getBoundingClientRect().height, bodies: document.querySelectorAll('[data-chat-message-anchor-key]').length, top: reference.getBoundingClientRect().top, scrollHeight: scroll.scrollHeight, scrollTop: scroll.scrollTop, distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight }
})
const clickControl = text => page.$$eval('[data-processing-status-slot] button, [data-processing-queue-status] button', (buttons, text) => buttons.find(button => button.textContent === text).click(), text)
const screenshot = async name => {
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/${name}.png` })
}

test('the bottom action follows the latch below 200px and even without a native scroll event', async () => {
  await mount()
  assert.equal(await page.$('[aria-label="Scroll to bottom"]'), null)
  const bounds = await page.$eval('.foxwarm-chat-messages', element => element.getBoundingClientRect().toJSON())
  await page.mouse.move(bounds.left + bounds.width * 0.6, bounds.top + bounds.height * 0.5)
  await page.mouse.wheel({ deltaY: -60 })
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  const detached = await geometry()
  assert.ok(detached.distance > 4 && detached.distance < 200, JSON.stringify(detached))
  await page.click('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Scroll to bottom"]'))
  await page.setViewport({ width: 900, height: 760 })
  await page.evaluate(() => window.fixture.append('Later answer\n\n'.repeat(25)))
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Later answer'))
  await wait(160)
  assert.ok((await geometry()).distance < 4)
  assert.equal(await page.$('[aria-label="Scroll to bottom"]'), null)

  await mount(true)
  const before = await geometry()
  assert.equal(before.distance, 0)
  await page.mouse.move(350, 250)
  await page.mouse.wheel({ deltaY: -60 })
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  assert.equal((await geometry()).scrollTop, before.scrollTop, 'Upward intent at a non-scrollable bottom still exposes rejoin')
  await page.click('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Scroll to bottom"]'))
  await page.evaluate(() => window.fixture.append('New content\n\n'.repeat(60)))
  await wait(150)
  assert.ok((await geometry()).distance < 4)
})

test('a tall manual expansion exposes rejoin immediately and the bottom action wins during its animation', async () => {
  await mount()
  const before = await geometry()
  await page.click('[data-system-message-card] .foxwarm-thread-line-button')
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  assert.ok(Math.abs((await geometry()).scrollTop - before.scrollTop) < 3)
  await page.click('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Scroll to bottom"]'))
  await page.waitForFunction(() => !document.querySelector('[data-system-message-card]').style.height)
  await page.evaluate(() => window.fixture.append('New canonical output after the manual rejoin.'))
  await wait(120)
  assert.ok((await geometry()).distance < 4)
  assert.equal(await page.$('[aria-label="Scroll to bottom"]'), null)
})

test('status visibility and loading reuse a constant slot while queue content adds its own height', async () => {
  await mount()
  const baseline = await geometry()
  for (const state of ['requesting-model', 'running-tool', 'waiting', 'idle']) {
    await page.evaluate(state => window.fixture.state(state, { tool: { name: 'exec', startedAt: 1 }, waiting: { waitId: 'input', waitingFor: 'input' } }), state)
    await wait(80)
    assert.equal(await page.$eval('[data-processing-status-slot]', slot => slot.querySelector('[data-processing-runtime-state]')?.dataset.processingRuntimeState || 'idle'), state)
    const next = await geometry()
    assert.ok(Math.abs(next.top - baseline.top) <= 1 && next.scrollHeight === baseline.scrollHeight, JSON.stringify({ state, baseline, next }))
  }
  await page.evaluate(() => window.fixture.state('requesting-model'))
  await page.type('.foxwarm-chat-composer-textarea', 'queued input')
  await page.click('button[type="submit"]')
  await page.waitForSelector('[aria-label="Loading"]')
  const loading = await geometry()
  assert.ok(Math.abs(loading.top - baseline.top) <= 1 && loading.scrollHeight === baseline.scrollHeight, JSON.stringify({ baseline, loading }))
  await page.evaluate(() => window.fixture.releaseSend())
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading"]'))
  await clickControl('Stop')
  assert.ok(await page.evaluate(() => window.commands.includes('/stop')))
  await screenshot('status-no-queue')

  await page.evaluate(() => window.fixture.queue(2, false))
  await page.waitForSelector('[data-processing-queue-status]')
  assert.ok((await page.$eval('[data-processing-queue-status]', element => element.textContent)).includes('2 queued messages'))
  assert.ok((await geometry()).scrollHeight > baseline.scrollHeight)
  await clickControl('Run queued')
  assert.ok(await page.evaluate(() => window.commands.includes('/dequeue')))
  await page.evaluate(() => window.fixture.queue(2))
  await page.waitForSelector('[data-queued-preview]')
  const queueLayout = await page.evaluate(() => {
    const slot = document.querySelector('[data-processing-status-slot]').getBoundingClientRect()
    const note = document.querySelector('[data-processing-queue-status]').getBoundingClientRect()
    const preview = document.querySelector('[data-queued-preview]').getBoundingClientRect()
    const spacer = document.querySelector('[data-chat-composer-spacer]').getBoundingClientRect()
    const composer = document.querySelector('.foxwarm-chat-composer-inner').getBoundingClientRect()
    return { slot: slot.height, ordered: slot.bottom <= note.top && note.bottom <= preview.top && preview.bottom <= spacer.top, clear: preview.bottom <= composer.top }
  })
  assert.deepEqual(queueLayout, { slot: 40, ordered: true, clear: true })
  await screenshot('status-with-queue')
  await page.evaluate(() => window.fixture.state('running-tool', { tool: { name: 'long_tool_name_'.repeat(30), startedAt: 1 } }))
  await page.setViewport({ width: 360, height: 800 })
  await wait(100)
  const controls = await page.$$eval('[data-processing-status-slot] button, [data-processing-queue-status] button', buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect()
    return { visible: rect.left >= 0 && rect.right <= innerWidth && rect.height > 0, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button }
  }))
  assert.ok(controls.length === 2 && controls.every(control => control.visible && control.hit), JSON.stringify(controls))
  const primary = await page.$eval('[data-processing-status-slot]', slot => { const row = slot.querySelector('[role="status"]'), label = row.querySelector('[title]'); return { height: row.getBoundingClientRect().height, slot: slot.getBoundingClientRect().height, clipped: label.scrollWidth > label.clientWidth, title: label.title } })
  assert.ok(primary.height === 32 && primary.slot === 40 && primary.clipped && primary.title.includes('long_tool_name_'), JSON.stringify(primary))
  await screenshot('status-narrow-queue')
  await page.evaluate(() => window.fixture.queue(0))
  await page.waitForFunction(() => !document.querySelector('[data-processing-queue-status]') && !document.querySelector('[data-queued-preview]'))
  await page.setViewport({ width: 900, height: 800 })
  await wait(120)
  assert.equal((await geometry()).scrollHeight, baseline.scrollHeight)
  await page.evaluate(() => { window.fixture.state('idle'); window.fixture.append('A new direct user input.', 'user') })
  await page.waitForSelector('[data-processing-runtime-state="interrupted"]')
  await clickControl('Continue')
  assert.ok(await page.evaluate(() => window.commands.includes('/continue')))
  const interrupted = await geometry()
  await page.evaluate(() => window.fixture.state('requesting-model'))
  await page.waitForSelector('[data-processing-runtime-state="requesting-model"]')
  const resumed = await geometry()
  assert.ok(Math.abs(resumed.top - interrupted.top) <= 1 && resumed.scrollHeight === interrupted.scrollHeight, JSON.stringify({ interrupted, resumed }))
})
