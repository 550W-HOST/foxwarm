import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { build } from './browserFixtureBundle.mjs'

// The committed timeline mounts a window of derived rows: the newest rows on opening, more as
// the reader approaches the top, and the rows around a Search target. Bottom-follow keeps
// working while a reply streams, and a revisit reuses the sanitized Markdown.

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(testDir, '..')
const chatEntry = path.resolve(packageDir, 'src/components/Chat.tsx')
const rendererEntry = path.resolve(packageDir, 'src/components/markdownRenderer.ts')
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'

let browser
let server
let fixtureUrl

const PLAIN_BEFORE_TOOLS = 120
const TOOL_CALLS = 60

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
    import { ASSISTANT_MARKDOWN_CACHE_LIMITS, getAssistantMarkdownCacheStats } from ${JSON.stringify(rendererEntry)}

    window.markdownCacheStats = () => ({ ...getAssistantMarkdownCacheStats(), limits: ASSISTANT_MARKDOWN_CACHE_LIMITS })
    const messages = []
    let seq = 0
    const push = (role, parts) => messages.push({ role, parts, __meta: { seq: ++seq, timestamp: 1700000000000 + seq * 1000 } })
    // Ordinary turns, then one long tool run that Conversation folds into a single Activity.
    for (let index = 0; index < ${PLAIN_BEFORE_TOOLS}; index++) {
      if (index % 2 === 0) push('user', [{ text: 'Question ' + index + ' about WINDOW_MARKER_' + index }])
      else push('model', [{ text: 'Answer ' + index + ' with **Markdown** and a list:\\n\\n- one\\n- two\\n\\nWINDOW_MARKER_' + index }])
    }
    push('user', [{ text: 'Run the tools please' }])
    for (let index = 0; index < ${TOOL_CALLS}; index++) {
      push('model', [{ functionCall: { id: 'call-' + index, name: 'exec', args: { command: 'echo ' + index } } }])
      push('tool', [{ functionResponse: { name: 'exec', tool_use_id: 'call-' + index, response: { output: 'out ' + index } } }])
    }
    push('model', [{ text: 'Final reply after the tools, LAST_MARKER' }])

    window.fetch = async input => {
      const url = String(input)
      if (url.includes('/history')) return new Response(JSON.stringify({
        session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, modelKey: 'fixture/model' },
        messages, queuedMessages: [], queueLength: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/asr/status')) return new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    class FixtureWebSocket {
      static CLOSED = 3
      static instances = []
      constructor() {
        this.readyState = 0
        FixtureWebSocket.instances.push(this)
        queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit({ type: 'connected' }) })
      }
      close() { this.readyState = FixtureWebSocket.CLOSED }
      send(raw) {
        const payload = JSON.parse(raw)
        if (payload.type !== 'set-subscriptions') return
        queueMicrotask(() => {
          this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: { 'fixture/main': 'fixture/main' } })
          this.emit({ type: 'subscriptions-applied', revision: payload.revision })
        })
      }
      emit(payload) {
        const message = ['session-event', 'session-state', 'message'].includes(payload.type) ? { ...payload, sessionId: 'fixture/main' } : payload
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }
    window.WebSocket = FixtureWebSocket
    let streamLines = []
    window.appendStreamLine = line => {
      streamLines.push(line)
      FixtureWebSocket.instances.at(-1)?.emit({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'fixture-stream', text: streamLines.join('\\n\\n') } })
    }

    const root = createRoot(document.getElementById('root'))
    window.renderFixture = (generation, timelineView) => root.render(React.createElement(Chat, {
      key: generation, sessionId: 'fixture/main', canonicalSessionId: 'fixture/main', sessionDisplayName: 'Fixture', timelineView,
    }))
    window.unmountFixture = () => root.render(React.createElement('div'))
    const params = new URLSearchParams(location.search)
    window.renderFixture(0, params.get('view') || 'detailed')
  `
  const result = await build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: 'chat-timeline-window-fixture.tsx' },
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
  const assets = path.join(packageDir, 'dist/assets')
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build WebUI before running the timeline window cases')
  const css = await readFile(path.join(assets, cssName), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style><style>html,body,#root{width:100%;height:100%;margin:0}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server ? server.close(resolve) : resolve())
})

const TOTAL_MESSAGES = PLAIN_BEFORE_TOOLS + 1 + TOOL_CALLS * 2 + 1

async function openChat(view = 'detailed') {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 760 })
  await page.goto(`${fixtureUrl}/?view=${view}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('LAST_MARKER'))
  await settle(page)
  return page
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30)))))

const mounted = page => page.$$eval('[data-chat-timeline="committed"] [data-chat-message-anchor-key]', nodes => nodes.map(node => node.getAttribute('data-chat-message-anchor-key')))

const position = page => page.$eval('.foxwarm-chat-messages', container => ({
  scrollTop: container.scrollTop,
  distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
}))

const readingAnchor = page => page.evaluate(() => {
  const container = document.querySelector('.foxwarm-chat-messages')
  const viewport = container.getBoundingClientRect()
  const anchor = [...container.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > viewport.top + 1)
  return { key: anchor?.getAttribute('data-chat-message-anchor-key'), offset: anchor ? anchor.getBoundingClientRect().top - viewport.top : null }
})

test('opening mounts the newest rows and scrolling up extends the window without moving the reader', async () => {
  const page = await openChat()
  try {
    const opening = await mounted(page)
    assert.ok(opening.length > 0 && opening.length < TOTAL_MESSAGES / 2, `opening mounts a bounded window: ${opening.length}`)
    assert.ok(opening.includes(`seq-local-${TOTAL_MESSAGES}`), 'the latest row is mounted')
    assert.ok(!opening.includes('seq-local-1'), 'the oldest row is not mounted')
    assert.ok((await position(page)).distanceFromBottom <= 2, 'opening is at the bottom')

    // Read upward in wheel steps: every extension keeps the row under the reader in place.
    await page.mouse.move(500, 300)
    let previousCount = opening.length
    let extensions = 0
    for (let step = 0; step < 400 && !(await mounted(page)).includes('seq-local-1'); step++) {
      await page.mouse.wheel({ deltaY: -400 })
      await settle(page)
      const before = await readingAnchor(page)
      await settle(page)
      const after = await readingAnchor(page)
      assert.equal(after.key, before.key)
      assert.ok(Math.abs(after.offset - before.offset) < 3, `no jump while extending: ${JSON.stringify({ before, after })}`)
      const count = (await mounted(page)).length
      if (count > previousCount) extensions++
      previousCount = count
    }
    assert.ok((await mounted(page)).includes('seq-local-1'), 'reading up mounts the oldest loaded row')
    assert.ok(extensions >= 2, `the window grows in bounded pieces: ${extensions}`)
  } finally { await page.close() }
})

test('Conversation counts rendered rows, so a folded tool run does not crowd out earlier turns', async () => {
  const page = await openChat('grouped')
  try {
    const opening = await mounted(page)
    // The tool run (120 source messages) is one Activity row; the window still reaches the
    // ordinary turns before it.
    assert.ok(opening.includes(`seq-local-${PLAIN_BEFORE_TOOLS}`), `the turn before the tool run is mounted: ${opening.slice(0, 3)}`)
    assert.ok(!opening.includes('seq-local-1'), 'the window is still bounded')
    assert.ok((await position(page)).distanceFromBottom <= 2)
  } finally { await page.close() }
})

test('a Search jump to an old row mounts it and shows it', async () => {
  const page = await openChat()
  try {
    assert.ok(!(await mounted(page)).includes('seq-local-3'))
    await page.click('[aria-label="Find in chat"]')
    await page.type('[aria-label="Search messages"]', 'Question 2 about')
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-3"]')
    await page.waitForFunction(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const row = container.querySelector('[data-chat-message-anchor-key="seq-local-3"]')
      if (!row) return false
      const viewport = container.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    })
    assert.ok((await mounted(page)).length < TOTAL_MESSAGES, 'the target window is bounded too')
    // Returning to the bottom mounts the newest rows again.
    await page.click('[aria-label="Close search"]')
    await page.click('[aria-label="Scroll to bottom"]')
    await page.waitForSelector(`[data-chat-message-anchor-key="seq-local-${TOTAL_MESSAGES}"]`)
    await page.waitForFunction(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      return container.scrollHeight - container.scrollTop - container.clientHeight <= 2
    })
  } finally { await page.close() }
})

test('a streamed reply keeps bottom-follow with a windowed timeline', async () => {
  const page = await openChat()
  try {
    const opening = (await mounted(page)).length
    for (let index = 0; index < 30; index++) {
      await page.evaluate(line => window.appendStreamLine(line), `stream line ${index} ${'content '.repeat(14)}`)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').textContent.includes('stream line 29'))
    await settle(page)
    assert.ok((await position(page)).distanceFromBottom <= 2, 'the streamed reply stays in view')
    assert.ok((await mounted(page)).length <= opening + 1, 'streaming does not mount older rows')
  } finally { await page.close() }
})

test('a revisit reuses sanitized Markdown, and the cache stays bounded', async () => {
  const page = await openChat()
  try {
    const first = await page.evaluate(() => window.markdownCacheStats())
    assert.ok(first.entries > 0 && first.misses > 0)
    const html = await page.$eval('[data-chat-timeline="committed"]', node => node.innerHTML)
    // Leave and return, as switching away from the Session and back does.
    await page.evaluate(() => window.unmountFixture())
    await settle(page)
    await page.evaluate(() => window.renderFixture(1, 'detailed'))
    await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('LAST_MARKER'))
    await settle(page)
    const second = await page.evaluate(() => window.markdownCacheStats())
    assert.ok(second.hits - first.hits >= first.entries, `the revisit reuses each mounted reply: ${JSON.stringify({ first, second })}`)
    assert.equal(second.misses, first.misses, 'no reply is rendered again')
    assert.equal(await page.$eval('[data-chat-timeline="committed"]', node => node.innerHTML), html, 'the revisit renders the same output')
    assert.ok(second.entries <= second.limits.entries && second.bytes <= second.limits.bytes)
  } finally { await page.close() }
})
