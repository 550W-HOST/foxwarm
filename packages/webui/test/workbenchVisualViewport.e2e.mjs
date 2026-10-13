import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

let browser, server, url
before(async () => {
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  server = createServer(async (request, response) => {
    const relative = new URL(request.url, 'http://fixture').pathname.slice('/ui/'.length)
    try {
      const file = new URL(relative || 'index.html', new URL('../dist/', import.meta.url))
      response.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html')
      response.end(await readFile(file))
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}/ui/`
})
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })

async function openMobileApp({ simulateViewport = true } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844 })
  await page.evaluateOnNewDocument(simulateViewport => {
    const tab = { id: 'chat:e2e-a', type: 'chat', sessionId: 'e2e-a', title: 'Viewport fixture' }
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ state: { version: 4, tabsById: { [tab.id]: tab }, root: { id: 'pane-main', kind: 'pane', tabIds: [tab.id], activeTabId: tab.id }, focusedPaneId: 'pane-main' }, version: 1 }))
    const session = { id: 'e2e-a', aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 20, lastMessageTime: 1, busy: false, modelKey: 'fixture/model' }
    const messages = Array.from({ length: 20 }, (_, index) => ({ role: 'user', parts: [{ text: `Viewport row ${index}. ` + 'Loaded content without streaming. '.repeat(15) }], __meta: { seq: index + 1 } }))
    window.__viewportHistoryReads = 0
    const json = body => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
    window.fetch = input => {
      const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname
      if (pathname.endsWith('/auth/session')) return json({ role: 'admin' })
      if (pathname.endsWith('/setup/status')) return json({ oobe: false, models: { exists: true, hasPlaceholderSecrets: false }, channels: [] })
      if (pathname.endsWith('/models')) return json({ models: [{ key: 'fixture/model', label: 'Fixture model', contextLimit: 128000 }] })
      if (pathname.endsWith('/session-list/sidebar')) return json({ version: 1, revision: 'r1', sessions: [session], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} })
      if (pathname.endsWith('/history')) { window.__viewportHistoryReads++; return json({ messages, queuedMessages: [], session, latestSeq: 20, historyVersion: 1, historyComplete: true }) }
      return json({ settings: {}, tasks: [], total: 0, omitted: 0, agents: [], nodes: [], terminals: [], commands: [], results: [] })
    }
    window.WebSocket = class {
      static OPEN = 1
      readyState = 1
      constructor() { queueMicrotask(() => this.onopen?.({})) }
      send(raw) {
        const data = JSON.parse(raw)
        if (data.type === 'set-subscriptions') queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-accepted', revision: data.revision, sessionListResolutions: {}, sessionResolutions: Object.fromEntries(data.sessionIds.map(id => [id, id])) }) })
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-applied', revision: data.revision }) })
        })
      }
      close() { this.readyState = 3; this.onclose?.({}) }
    }
    if (!simulateViewport) return
    const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { value: viewport })
    // This models a shifted fixed-position origin, NOT a real iOS keyboard.
    // The original mobile shell follows offsetTop; a body portal starts at -offsetTop.
    window.__setViewport = values => {
      Object.assign(viewport, values)
      document.body.style.transform = `translate(${-viewport.offsetLeft}px, ${-viewport.offsetTop}px)`
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
    }
  }, simulateViewport)
  await page.goto(`${url}#tab/chat:e2e-a`)
  await page.waitForSelector('[role="textbox"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 20)
  await page.evaluate(() => { window.__originalEditor = document.querySelector('[role="textbox"]'); window.__originalChat = document.querySelector('.foxwarm-chat-root') })
  await page.click('[role="textbox"]')
  return page
}

async function measure(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
  return page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } }
    return { slot: rect('[data-workbench-content-slot]'), host: rect('[data-workbench-content-tab]'), layer: rect('[data-workbench-content-layer]'), editor: rect('[role="textbox"]'), sameChat: window.__originalChat === document.querySelector('.foxwarm-chat-root'), sameEditor: window.__originalEditor === document.querySelector('[role="textbox"]'), focused: document.activeElement === window.__originalEditor, reads: window.__viewportHistoryReads }
  })
}

function assertAligned(state) {
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(state.host[key] - state.slot[key]) < 1, `host ${key} must match slot: ${JSON.stringify(state)}`)
  assert.ok(state.sameChat && state.sameEditor && state.focused)
  assert.equal(state.reads, 1)
}

test('mobile App keeps its stable focused editor aligned during simulated keyboard resize and viewport pan', async () => {
  const page = await openMobileApp()
  try {
    assertAligned(await measure(page))
    await page.evaluate(() => window.__setViewport({ height: 500, offsetTop: 220 }))
    const keyboard = await measure(page)
    if (process.env.FOXWARM_VIEWPORT_SCREENSHOT) {
      await page.evaluate(() => {
        const keyboard = document.createElement('div')
        keyboard.style.cssText = 'position:fixed;left:0;top:500px;height:344px;width:390px;z-index:9999;background:#383838;color:white;text-align:center;padding-top:40px;pointer-events:none'
        keyboard.dataset.simulatedKeyboard = 'true'
        keyboard.textContent = 'SIMULATED keyboard — not iOS'
        document.documentElement.append(keyboard)
      })
      await page.screenshot({ path: process.env.FOXWARM_VIEWPORT_SCREENSHOT })
      await page.evaluate(() => document.querySelector('[data-simulated-keyboard]').remove())
    }
    assertAligned(keyboard)
    assert.ok(keyboard.editor.top >= 0 && keyboard.editor.bottom <= 500)
    await page.evaluate(() => document.documentElement.style.setProperty('--foxwarm-safe-area-top', '24px'))
    assertAligned(await measure(page))
    const scroller = await page.$('.foxwarm-chat-messages')
    const box = await scroller.boundingBox()
    const top = await scroller.evaluate(element => element.scrollTop)
    await page.mouse.move(box.x + 80, box.y + 40)
    await page.mouse.wheel({ deltaY: -300 })
    await page.waitForFunction(top => document.querySelector('.foxwarm-chat-messages').scrollTop < top - 100, {}, top)
    assertAligned(await measure(page))
    await page.evaluate(() => window.__setViewport({ offsetTop: 280 }))
    assertAligned(await measure(page))
    // Horizontal pan is retained, not reset; this is a coordinate model, not pinch emulation.
    await page.evaluate(() => window.__setViewport({ offsetLeft: 35, offsetTop: 180, height: 420, width: 260, scale: 1.5 }))
    assertAligned(await measure(page))
    await page.evaluate(() => window.__setViewport({ height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }))
    assertAligned(await measure(page))
  } finally { await page.close() }
})


test('native Chromium page scale retains the mobile slot and focused content boundary', async () => {
  const page = await openMobileApp({ simulateViewport: false })
  try {
    const client = await page.createCDPSession()
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 })
    await page.waitForFunction(() => window.visualViewport.scale > 1.4)
    assertAligned(await measure(page))
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    assertAligned(await measure(page))
  } finally { await page.close() }
})
