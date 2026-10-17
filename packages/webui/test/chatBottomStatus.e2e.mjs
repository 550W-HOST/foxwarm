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
    setThemeSelection({ themeId: new URLSearchParams(location.search).get('theme') || 'foxwarm.default', colorMode: 'dark' })
    const short = new URLSearchParams(location.search).has('short')
    const messages = Array.from({ length: short ? 0 : 24 }, (_, index) => ({ role: 'model', parts: [{ text: 'Earlier answer ' + index + '\\n\\nA supported reading position.' }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } }))
    messages.push({ role: 'user', parts: [{ system: '<foxwarm-system kind="event">\\n' + 'Long event detail.\\n'.repeat(75) + '</foxwarm-system>' }], __meta: { seq: messages.length + 1, timestamp: 1700000000025 } })
    messages.push({ role: 'model', parts: [{ thinking: 'Inspect the supported state.' }, { text: 'Reference answer', phase: 'final_answer' }], __meta: { seq: messages.length + 1, timestamp: 1700000000026 } })
    let queuedMessages = [], runtimeState = { state: 'idle', busy: false, queueLength: 0 }, historyVersion = 1, pendingPost = null
    const session = () => ({ id: 'fixture/status', busy: runtimeState.busy, runtimeState, queueLength: runtimeState.queueLength, messageCount: messages.length, historyVersion })
    window.commands = []; window.sentMessages = []
    window.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/message')) {
        const body = JSON.parse(init.body)
        window.lastControlRequest = body
        if (body.text) {
          window.commands.push(body.text)
          if (window.fixture.autoFeedback !== false && body.controlRequestId) queueMicrotask(() => {
            const action = body.text === '/stop' ? 'stop' : body.text === '/continue' ? 'continue' : 'dequeue'
            emit({type:'session-event',event:{type:'session-control-feedback',requestId:body.controlRequestId,feedback:{action,status:'accepted',message:'Accepted'}}})
            if(action==='stop') { runtimeState={...runtimeState,stopping:true};emit({type:'session-state',session:session()}) }
          })
        }
        if (body.parts) window.sentMessages.push(body.parts.map(part => part.text || '').join(''))
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
      autoFeedback:true,
      feedback(requestId,feedback){emit({type:'session-event',event:{type:'session-control-feedback',requestId,feedback}})},
      state(state, extra = {}) { runtimeState = { ...runtimeState, stopping: undefined, state, busy: state === 'requesting-model' || state === 'running-tool', ...extra }; emit({ type: 'session-state', session: session() }) },
      queue(count, withPreview = true) {
        runtimeState = { ...runtimeState, queueLength: count }; historyVersion++
        queuedMessages = withPreview ? Array.from({ length: count }, (_, index) => ({ role: 'user', parts: [{ text: 'Queued follow-up ' + index }], __meta: { id: 'queued-' + index, timestamp: 1700000000050 + index } })) : []
        emit({ type: 'session-state', session: session() })
      },
      releaseSend() { pendingPost?.(); pendingPost = null },
      theme(themeId) { setThemeSelection({ themeId, colorMode: 'dark' }) },
      append(text, role = 'model') { const message = { role, parts: [{ text }], __meta: { seq: messages.length + 1, timestamp: 1700000000100 + messages.length } }; messages.push(message); emit({ type: 'message', message }) }
    }
    createRoot(document.getElementById('root')).render(<Chat historyMode="active" sessionId="fixture/status" canonicalSessionId="fixture/status" sessionDisplayName="Mock preview · status and queue" timelineView={new URLSearchParams(location.search).get('view') || 'detailed'} />)
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
async function mount(short = false, width = 900, view = 'detailed') {
  await page.setViewport({ width, height: 800 })
  await page.goto(`${fixtureUrl}/?view=${view}${short ? '&short' : ''}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Reference answer'))
  await page.evaluate(() => document.fonts.ready)
  await wait(120)
}
const geometry = () => page.evaluate(() => {
  const scroll = document.querySelector('.foxwarm-chat-messages')
  const reference = [...document.querySelectorAll('.foxwarm-assistant-message-card, .foxwarm-conversation-reply')].find(element => element.textContent.includes('Reference answer'))
  return { composer: document.querySelector('.foxwarm-chat-composer').getBoundingClientRect().height, slot: document.querySelector('[data-processing-status-slot]').getBoundingClientRect().height, bodies: document.querySelectorAll('[data-chat-message-anchor-key]').length, top: reference.getBoundingClientRect().top, scrollHeight: scroll.scrollHeight, scrollTop: scroll.scrollTop, distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight }
})
const clickControl = async text => {
  if (text === 'Stop') { await page.click('[aria-label="Stop session"]'); return }
  for (const button of await page.$$('[data-processing-status-slot] button, [data-processing-queue-status] button')) {
    if (await button.evaluate((element, text) => element.textContent === text, text)) return button.click()
  }
  throw new Error(`Status control not found: ${text}`)
}
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

test('a small upward wheel leave rejoins naturally on downward input, including when no scroll event is possible', async () => {
  await mount()
  const bounds = await page.$eval('.foxwarm-chat-messages', element => element.getBoundingClientRect().toJSON())
  await page.mouse.move(bounds.left + bounds.width * 0.6, bounds.top + bounds.height * 0.5)
  await page.mouse.wheel({ deltaY: -3 })
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(() => {
    const scroll = document.querySelector('.foxwarm-chat-messages')
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 0
  })
  const near = await geometry()
  assert.ok(near.distance > 0 && near.distance <= 4, JSON.stringify(near))
  await page.mouse.wheel({ deltaY: 60 })
  await page.waitForFunction(() => {
    const scroll = document.querySelector('.foxwarm-chat-messages')
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.$('[aria-label="Scroll to bottom"]'), null, 'the old tiny leave must not block natural bottom rejoin')
  await page.evaluate(() => window.fixture.append('Follow after natural rejoin.\n\n'.repeat(40)))
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Follow after natural rejoin.'))
  await page.waitForFunction(() => {
    const scroll = document.querySelector('.foxwarm-chat-messages')
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 4
  })

  await mount(true)
  const before = await geometry()
  await page.mouse.move(350, 250)
  await page.mouse.wheel({ deltaY: -60 })
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  assert.equal((await geometry()).scrollTop, before.scrollTop)
  await page.mouse.wheel({ deltaY: 60 })
  await page.waitForFunction(() => !document.querySelector('[aria-label="Scroll to bottom"]'))
  assert.equal((await geometry()).scrollTop, before.scrollTop, 'explicit return intent does not need a native scroll event')
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

test('status visibility is stable and queue actions follow the final visible message', async () => {
  await mount(false, 900, 'conversation')
  const baseline = await geometry()
  await page.evaluate(() => window.fixture.queue(1, false))
  await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('1 queued'))
  assert.equal(await page.$$eval('[data-processing-queue-status]', blocks => blocks.length), 1)
  await clickControl('Run queued')
  assert.ok(await page.evaluate(() => window.commands.includes('/dequeue')))
  await page.evaluate(() => window.fixture.queue(0))
  await page.waitForFunction(() => !document.querySelector('[data-processing-queue-status]'))
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
  await page.waitForSelector('[data-composer-action="send"][disabled]')
  const loading = await geometry()
  assert.ok(Math.abs(loading.top - baseline.top) <= 1 && loading.scrollHeight === baseline.scrollHeight, JSON.stringify({ baseline, loading }))
  await page.evaluate(() => window.fixture.releaseSend())
  await page.waitForSelector('[data-composer-action="stop"]:not([disabled])')
  await clickControl('Stop')
  assert.ok(await page.evaluate(() => window.commands.includes('/stop')))
  const noQueueLayout = await page.evaluate(() => {
    const block = document.querySelector('[data-processing-status-slot] [role="status"]'), form = document.querySelector('.foxwarm-chat-composer-form')
    const css = getComputedStyle(block)
    return { height: block.getBoundingClientRect().height, gap: form.getBoundingClientRect().top - block.getBoundingClientRect().bottom, border: css.borderTopWidth, background: css.backgroundColor }
  })
  assert.ok(baseline.slot === 56 && noQueueLayout.gap >= 16 && noQueueLayout.border === '0px' && noQueueLayout.background === 'rgba(0, 0, 0, 0)', JSON.stringify(noQueueLayout))
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) console.log('no-queue layout', JSON.stringify({ ...noQueueLayout, referenceTop: baseline.top, scrollHeight: baseline.scrollHeight, slot: baseline.slot }))
  await screenshot('status-no-queue')
  await page.evaluate(() => { window.fixture.state('idle'); window.fixture.state('requesting-model') })
  await page.waitForSelector('[data-runtime-presentation="request"]')

  await page.evaluate(() => window.fixture.queue(2, false))
  await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('2 queued'))
  assert.equal(await page.$$eval('[data-processing-queue-status]', blocks => blocks.length), 1)
  assert.ok((await page.$eval('[data-processing-status-slot] [role="status"]', element => element.textContent)).includes('Requesting model'))
  assert.equal((await geometry()).slot, baseline.slot)
  await clickControl('Run queued')
  assert.ok(await page.evaluate(() => window.commands.includes('/dequeue')))
  await page.evaluate(() => window.fixture.queue(2))
  await page.waitForSelector('[data-queued-preview]')
  const queueLayout = await page.evaluate(() => {
    const slot = document.querySelector('[data-processing-status-slot]'), block = slot.querySelector('[role="status"]')
    const preview = document.querySelector('[data-queued-preview]').getBoundingClientRect()
    const spacer = document.querySelector('[data-chat-composer-spacer]').getBoundingClientRect()
    const form = document.querySelector('.foxwarm-chat-composer-form').getBoundingClientRect()
    const footer = document.querySelector('[data-processing-queue-footer]')
    const controls = [...slot.querySelectorAll('button:not([aria-haspopup="dialog"])')]
    return { blocks: slot.querySelectorAll('[role="status"]').length, separate: controls.length === 0 && !slot.contains(footer) && footer.querySelectorAll('button').length === 1, ordered: block.getBoundingClientRect().bottom <= preview.top && document.querySelector('[data-queued-preview] .foxwarm-user-message-bubble').getBoundingClientRect().bottom <= footer.getBoundingClientRect().top && footer.getBoundingClientRect().bottom <= spacer.top, clear: footer.getBoundingClientRect().bottom < form.top }
  })
  assert.deepEqual(queueLayout, { blocks: 1, separate: true, ordered: true, clear: true })
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) console.log('queue geometry', JSON.stringify(await page.evaluate(() => {
    const block = document.querySelector('[data-processing-status-slot] [role="status"]').getBoundingClientRect(), preview = document.querySelector('[data-queued-preview]').getBoundingClientRect(), form = document.querySelector('.foxwarm-chat-composer-form').getBoundingClientRect()
    return { statusBottom: block.bottom, previewBottom: preview.bottom, formTop: form.top, previewGap: form.top - preview.bottom }
  })))
  await screenshot('status-with-queue')
  await page.evaluate(() => window.fixture.state('running-tool', { tool: { name: 'long_tool_name_'.repeat(30), startedAt: 1 } }))
  await page.setViewport({ width: 360, height: 800 })
  await wait(100)
  const controls = await page.$$eval('[data-processing-status-slot] button, [data-processing-queue-status] button, [data-composer-action="stop"]', buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect()
    return { visible: rect.left >= 0 && rect.right <= innerWidth && rect.height > 0, hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) }
  }))
  assert.ok(controls.length === 3 && controls.every(control => control.visible && control.hit), JSON.stringify(controls))
  const primary = await page.$eval('[data-processing-status-slot] [role="status"]', block => { const css = getComputedStyle(block); return { border: css.borderTopWidth, bounded: block.scrollWidth <= block.clientWidth + 1 } })
  assert.deepEqual(primary, { border: '0px', bounded: true })
  await screenshot('status-narrow-queue')
  await page.evaluate(() => window.fixture.queue(0))
  await page.waitForFunction(() => !document.querySelector('[data-queued-preview]') && !document.querySelector('[data-processing-queue-status]'))
  await screenshot('status-narrow-no-queue')
  await page.setViewport({ width: 900, height: 800 })
  await wait(120)
  assert.equal((await geometry()).scrollHeight, baseline.scrollHeight)
  await page.evaluate(() => { window.fixture.state('idle'); window.fixture.append('A new direct user input.', 'user') })
  await page.waitForSelector('[data-processing-runtime-state="interrupted"]')
  await page.evaluate(() => window.fixture.queue(1, false))
  await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('1 queued'))
  assert.equal(await page.$$eval('[data-processing-queue-status]', blocks => blocks.length), 1)
  assert.equal(await page.$$eval('[data-processing-status-slot] button, [data-processing-queue-status] button', buttons => buttons.length), 2)
  await clickControl('Continue')
  assert.ok(await page.evaluate(() => window.commands.includes('/continue')))
  await page.evaluate(() => window.fixture.queue(0))
  await page.waitForFunction(() => !document.querySelector('[data-processing-queue-status]'))
  const interrupted = await geometry()
  await page.evaluate(() => window.fixture.state('requesting-model'))
  await page.waitForSelector('[data-processing-runtime-state="requesting-model"]')
  const resumed = await geometry()
  assert.ok(Math.abs(resumed.top - interrupted.top) <= 1 && resumed.scrollHeight === interrupted.scrollHeight, JSON.stringify({ interrupted, resumed }))
  await page.evaluate(async () => { window.fixture.theme('foxwarm.550a'); await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
  const consolePadding = await page.$eval('[data-processing-status-slot] [role="status"]', block => { const css = getComputedStyle(block); return [css.paddingLeft, css.paddingTop] })
  assert.deepEqual(consolePadding, ['0px', '0px'])
})


for (const view of ['detailed', 'grouped', 'conversation']) {
  test(`queue footer follows the final visible message in ${view}`, async () => {
    await mount(false, 900, view)
    await page.evaluate(() => window.fixture.queue(1, false))
    await page.waitForSelector('[data-processing-queue-footer]')
    assert.equal(await page.$eval('[data-processing-queue-footer]', element => element.dataset.alignment), 'left')
    assert.equal(await page.$eval('[data-processing-queue-footer]', element => !!element.closest('[data-chat-timeline="committed"]')), true)
    await page.evaluate(() => window.fixture.append('A direct user follow-up', 'user'))
    await page.waitForFunction(() => document.querySelector('[data-processing-queue-footer]')?.dataset.alignment === 'right')
    const right = await page.evaluate(() => ({queue: document.querySelector('[data-processing-queue-status]').getBoundingClientRect().right,
      message: [...document.querySelectorAll('[data-chat-timeline="committed"] .foxwarm-user-message-bubble')].at(-1).getBoundingClientRect().right}))
    assert.ok(Math.abs(right.queue - right.message) < 1)
    await page.evaluate(() => window.fixture.append('A final assistant response'))
    await page.waitForFunction(() => document.querySelector('[data-processing-queue-footer]')?.dataset.alignment === 'left')
    await page.evaluate(() => window.fixture.queue(1, true))
    await page.waitForSelector('[data-queued-preview] [data-processing-queue-footer]')
    assert.equal(await page.$$eval('[data-processing-queue-footer]', elements => elements.length), 1)
    assert.equal(await page.$eval('[data-processing-queue-footer]', element => element.dataset.alignment), 'right')
    const placement = await page.evaluate(() => {
      const preview = document.querySelector('[data-queued-preview]')
      const bubble = preview.querySelector('.foxwarm-user-message-bubble').getBoundingClientRect()
      const footer = preview.querySelector('[data-processing-queue-status]').getBoundingClientRect()
      return { below: footer.top >= bubble.bottom, right: Math.abs(footer.right - bubble.right) < 1 }
    })
    assert.deepEqual(placement, {below: true, right: true})
    await page.evaluate(() => window.fixture.queue(0))
    await page.waitForFunction(() => !document.querySelector('[data-processing-queue-footer]'))
  })
}


test('composer swaps empty running drafts to Stop while text and whitespace retain safe send semantics', async () => {
  for (const width of [900, 390]) {
    await mount(false, width)
    await page.waitForSelector('[data-composer-action="send"][disabled]')
    await page.evaluate(() => window.fixture.state('requesting-model'))
    await page.waitForSelector('[data-composer-action="stop"]:not([disabled])')
    assert.equal(await page.$('[data-processing-status-slot] button'), null)
    await page.click('[aria-label="Stop session"]')
    await page.waitForFunction(() => window.commands.includes('/stop'))
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.type('   ')
    assert.ok(await page.$('[data-composer-action="stop"]'))
    await page.keyboard.type('New follow-up')
    await page.waitForSelector('[data-composer-action="send"]:not([disabled])')
    await page.click('[aria-label="Send message"]')
    await page.waitForFunction(() => window.sentMessages.some(text => text.trim() === 'New follow-up'))
    assert.equal(await page.evaluate(() => window.commands.filter(text => text === '/stop').length), 1)
    await page.evaluate(() => window.fixture.releaseSend())
    await page.waitForSelector('[data-composer-action="stop"]')
    await page.evaluate(() => window.fixture.state('waiting'))
    await page.waitForSelector('[data-composer-action="send"][disabled]')
    await page.evaluate(() => window.fixture.state('idle'))
    await page.waitForSelector('[data-composer-action="send"][disabled]')
  }
})

test('Stop feedback is correlated, does not insert receipts, and stays Stopping until authoritative state settles', async () => {
  await mount(false,390)
  await page.evaluate(()=>{window.fixture.autoFeedback=false;window.fixture.state('requesting-model')})
  await page.waitForSelector('[data-composer-action="stop"]:not([disabled])')
  const before=await page.$$eval('[data-chat-message-anchor-key]',rows=>rows.length)
  await page.click('[aria-label="Stop session"]')
  await page.waitForSelector('[data-runtime-presentation="stopping"]')
  await page.evaluate(()=>window.fixture.feedback('unrelated-request',{action:'stop',status:'error',message:'Should not appear'}))
  assert.equal(await page.$('[data-control-feedback]'),null)
  await page.evaluate(()=>window.fixture.feedback(window.lastControlRequest.controlRequestId,{action:'stop',status:'accepted',message:'Stop requested'}))
  await page.waitForSelector('[data-composer-action="stop"][disabled]')
  assert.match(await page.$eval('[data-runtime-caption]',el=>el.textContent),/Stopping/)
  await page.evaluate(()=>window.fixture.state('running-tool',{stopping:true,tool:{name:'exec',startedAt:1}}))
  await page.waitForSelector('[data-composer-action="stop"][disabled]')
  await page.evaluate(()=>window.fixture.state('idle'))
  await page.waitForSelector('[data-composer-action="send"][disabled]')
  assert.equal(await page.$$eval('[data-chat-message-anchor-key]',rows=>rows.length),before)
  assert.doesNotMatch(await page.$eval('.foxwarm-chat-messages',el=>el.textContent),/Stop requested|Stop signal sent|in-flight LLM/)
})
