import { waitForWebUiReady } from './webuiReadiness.mjs'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

async function openMobileApp({ simulateViewport = true, width = 390, height = 844, themeId = 'foxwarm.default', colorMode = 'light', search = '', home = false } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width, height })
  await page.evaluateOnNewDocument(({ simulateViewport, width, height, themeId, colorMode }) => {
    localStorage.setItem('foxwarm_theme_selection_v3', JSON.stringify({ version: 3, themeId, lightThemeId: themeId, darkThemeId: themeId, colorMode }))
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
    const viewport = Object.assign(new EventTarget(), { height, width, offsetTop: 0, offsetLeft: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { value: viewport })
    // This models a shifted fixed-position origin, NOT a real iOS keyboard.
    // The original mobile shell follows offsetTop; a body portal starts at -offsetTop.
    window.__setViewport = values => {
      Object.assign(viewport, values)
      document.body.style.transform = viewport.offsetLeft || viewport.offsetTop ? `translate(${-viewport.offsetLeft}px, ${-viewport.offsetTop}px)` : ''
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
    }
  }, { simulateViewport, width, height, themeId, colorMode })
  await page.goto(`${url}${search}#tab/chat:e2e-a`)
  await waitForWebUiReady(page)
  await page.waitForSelector('[role="textbox"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 20)
  await page.evaluate(() => { window.__originalEditor = document.querySelector('[role="textbox"]'); window.__originalChat = document.querySelector('.foxwarm-chat-root') })
  if (home) {
    await page.click('.mobile-header-back')
    await page.waitForSelector('.mobile-primary-nav', { visible: true })
    return page
  }
  await page.click('[role="textbox"]')
  return page
}

async function measure(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
  return page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } }
    return {
      pane: rect('[data-pane-id]'), header: rect('[data-mobile-chat-header]'),
      back: rect('.mobile-header-back'), actions: rect('.mobile-header-capsule'),
      slot: rect('[data-workbench-content-slot]'), host: rect('[data-workbench-content-tab]'),
      layer: rect('[data-workbench-content-layer]'), editor: rect('[role="textbox"]'),
      form: rect('.foxwarm-chat-composer-form'),
      sameChat: window.__originalChat === document.querySelector('.foxwarm-chat-root'),
      sameEditor: window.__originalEditor === document.querySelector('[role="textbox"]'),
      focused: document.activeElement === window.__originalEditor, reads: window.__viewportHistoryReads,
    }
  })
}

function assertVisibleViewport(state, { height, top = 0, left = 0, width = 390 }) {
  // Slot/host agreement alone can pass while BOTH follow the wrong shell origin.
  for (const [key, expected] of Object.entries({ top, left, width, bottom: height })) {
    assert.ok(Math.abs(state.pane[key] - expected) < 1, `pane ${key} must match visible viewport/safe area: ${JSON.stringify(state)}`)
  }
  assert.ok(state.header.top >= top && state.header.bottom <= height, `header must remain visible: ${JSON.stringify(state)}`)
  assert.ok(state.editor.top >= top && state.editor.bottom <= height, `editor must remain visible: ${JSON.stringify(state)}`)
}

async function captureViewport(page, phase, state) {
  const directory = process.env.FOXWARM_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, `mobile-viewport-${phase}.png`) })
  await writeFile(path.join(directory, `mobile-viewport-${phase}.json`), `${JSON.stringify(state, null, 2)}\n`)
}

function assertAligned(state) {
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(state.host[key] - state.slot[key]) < 1, `host ${key} must match slot: ${JSON.stringify(state)}`)
  assert.ok(state.sameChat && state.sameEditor && state.focused)
  assert.equal(state.reads, 1)
}

test('mobile App keeps its stable focused editor aligned during simulated keyboard resize and viewport pan', async () => {
  const page = await openMobileApp()
  try {
    const initial = await measure(page)
    assertAligned(initial)
    assertVisibleViewport(initial, { height: 844 })
    await page.evaluate(() => window.__setViewport({ height: 500 }))
    const shrink = await measure(page)
    assertAligned(shrink)
    assertVisibleViewport(shrink, { height: 500 })
    await page.evaluate(() => window.__setViewport({ height: 500, offsetTop: 220 }))
    const keyboard = await measure(page)
    await captureViewport(page, 'keyboard', keyboard)
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
    assertVisibleViewport(keyboard, { height: 500 })
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--foxwarm-safe-area-top', '24px')
      document.documentElement.style.setProperty('--foxwarm-safe-area-left', '9px')
      document.documentElement.style.setProperty('--foxwarm-safe-area-right', '11px')
    })
    const safeArea = await measure(page)
    assertAligned(safeArea)
    assertVisibleViewport(safeArea, { height: 500, top: 24, left: 9, width: 370 })
    await captureViewport(page, 'safe-area', safeArea)
    const scroller = await page.$('.foxwarm-chat-messages')
    const box = await scroller.boundingBox()
    const top = await scroller.evaluate(element => element.scrollTop)
    // The floating mobile header overlaps the top of the message scroller.
    await page.mouse.move(box.x + 80, box.y + box.height / 2)
    await page.mouse.wheel({ deltaY: -300 })
    await page.waitForFunction(top => document.querySelector('.foxwarm-chat-messages').scrollTop < top - 100, {}, top)
    assertAligned(await measure(page))
    await page.evaluate(() => window.__setViewport({ offsetTop: 280 }))
    const shifted = await measure(page)
    assertAligned(shifted)
    assertVisibleViewport(shifted, { height: 500, top: 24, left: 9, width: 370 })
    // Horizontal pan is retained, not reset; this is a coordinate model, not pinch emulation.
    await page.evaluate(() => window.__setViewport({ offsetLeft: 35, offsetTop: 180, height: 420, width: 260, scale: 1.5 }))
    const panned = await measure(page)
    assertAligned(panned)
    assertVisibleViewport(panned, { height: 420, top: 24, left: -26, width: 370 })
    await page.evaluate(() => {
      for (const edge of ['top', 'left', 'right']) document.documentElement.style.setProperty(`--foxwarm-safe-area-${edge}`, '0px')
      window.__setViewport({ height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 })
    })
    const restored = await measure(page)
    assertAligned(restored)
    assertVisibleViewport(restored, { height: 844 })
    assert.ok(Math.abs(restored.editor.bottom - initial.editor.bottom) < 1, 'closing the keyboard must restore the composer without a leftover gap')
    await captureViewport(page, 'restored', restored)
  } finally { await page.close() }
})

test('mobile workbench consumes PWA-sized safe areas once around the actual header controls', async () => {
  const page = await openMobileApp({ width: 440, height: 956, themeId: 'foxwarm.550a', colorMode: 'dark' })
  try {
    await page.evaluate(() => {
      for (const [edge, value] of Object.entries({ top: 62, bottom: 34, left: 7, right: 9 })) {
        document.documentElement.style.setProperty(`--foxwarm-safe-area-${edge}`, `${value}px`)
      }
    })
    const state = await measure(page)
    await captureViewport(page, 'pwa-safe-area', state)
    assertAligned(state)
    assertVisibleViewport(state, { height: 956, top: 62, left: 7, width: 424 })
    // Check real controls, not the header wrapper's already-inset rectangle.
    assert.equal(state.back.top, 62 + 1 + 8)
    assert.equal(state.back.left, 7 + 1 + 12)
    assert.equal(state.actions.left + state.actions.width, 440 - 9 - 1 - 12)
    assert.equal(state.form.bottom, 956 - 1 - 16)
    await page.evaluate(() => window.__setViewport({ height: 500, offsetTop: 220 }))
    const keyboard = await measure(page)
    assertAligned(keyboard)
    assertVisibleViewport(keyboard, { height: 500, top: 62, left: 7, width: 424 })
    assert.equal(keyboard.back.top, state.back.top)
    await page.evaluate(() => window.__setViewport({ height: 956, offsetTop: 0 }))
    const restored = await measure(page)
    assertAligned(restored)
    assert.equal(restored.back.top, state.back.top)
    assert.equal(restored.form.bottom, state.form.bottom)
  } finally { await page.close() }
})

test('independent mobile Chat leaves retain their own header safe-area spacing', async () => {
  const page = await openMobileApp({ search: '?foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=e2e-a' })
  try {
    assert.equal(await page.$('[data-workbench-content-tab]'), null)
    await page.evaluate(() => document.documentElement.style.setProperty('--foxwarm-safe-area-top', '62px'))
    const top = await page.$eval('.mobile-header-capsule', element => element.getBoundingClientRect().top)
    assert.equal(top, 62 + 8)
  } finally { await page.close() }
})

test('mobile primary navigation uses the visible browser boundary rather than a shorter home shell', async () => {
  const page = await openMobileApp({ home: true, width: 440, height: 956, themeId: 'foxwarm.550a', colorMode: 'dark' })
  try {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--foxwarm-safe-area-top', '62px')
      document.documentElement.style.setProperty('--foxwarm-safe-area-bottom', '34px')
      // Model a PWA-style discrepancy without changing the real fixed viewport.
      window.__setViewport({ height: 894 })
      window.__homeNav = document.querySelector('.mobile-primary-nav')
    })
    for (const tab of ['sessions', 'tasks', 'search', 'setup', 'sessions']) {
      await page.click(`#mobile-tab-${tab}`)
      await page.waitForFunction(tab => document.getElementById(`mobile-tab-${tab}`)?.getAttribute('aria-selected') === 'true' && document.getElementById(`mobile-panel-${tab}`)?.getBoundingClientRect().height > 0, {}, tab)
      const state = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } }
        const nav = document.querySelector('.mobile-primary-nav')
        const bounds = nav.getBoundingClientRect()
        return {
          viewportBottom: innerHeight,
          shell: rect(document.querySelector('[data-mobile-session-home]')),
          nav: rect(nav), sameNav: nav === window.__homeNav,
          bottomHit: nav.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.bottom - 3)),
          newSession: rect(document.querySelector('button[aria-label="New session"]')),
          controlsHit: [...nav.querySelectorAll('button')].every(button => {
            const r = button.getBoundingClientRect()
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return hit === button || button.contains(hit)
          }),
        }
      })
      await captureViewport(page, `home-${tab}`, state)
      assert.equal(state.shell.bottom, 894, 'the shell still follows the reported visual viewport')
      assert.equal(state.nav.bottom, state.viewportBottom - 34 - 12, JSON.stringify(state))
      assert.ok(state.sameNav && state.controlsHit && state.bottomHit)
      assert.ok(state.nav.left >= 12 && state.nav.left + state.nav.width <= 440 - 12)
      if (tab === 'sessions') assert.equal(state.newSession.bottom, state.viewportBottom - 34 - 88)
    }
    await page.click('[data-session-id="e2e-a"]')
    await page.waitForSelector('[data-mobile-chat-header]')
    const chat = await page.evaluate(() => ({
      backTop: document.querySelector('.mobile-header-back').getBoundingClientRect().top,
      composerBottom: document.querySelector('.foxwarm-chat-composer-form').getBoundingClientRect().bottom,
    }))
    assert.equal(chat.backTop, 62 + 1 + 8)
    assert.equal(chat.composerBottom, 894 - 1 - 16, 'Chat composer spacing is deliberately unchanged')
    await page.click('.mobile-header-back')
    assert.ok(await page.$eval('.mobile-primary-nav', element => element === window.__homeNav))
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
