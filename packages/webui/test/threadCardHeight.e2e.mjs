import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const packageDir = new URL('..', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname
let browser, page, server, baseUrl

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build the WebUI before running this browser fixture')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}

    const size = new URLSearchParams(location.search).get('size') || 'large'
    const lines = size === 'small' ? 2 : 85
    const body = Array.from({ length: lines }, (_, n) => 'event detail line ' + n).join('\\n')
    const messages = Array.from({ length: 17 }, (_, index) => ({
      role: 'model', parts: [{ text: 'earlier message ' + index + ' with enough text to fill the chat viewport' }],
      __meta: { seq: index + 1, timestamp: 1000 + index },
    }))
    messages.push({ role: 'user', parts: [{ text: '<foxwarm-system kind="event">\\n' + body + '\\n</foxwarm-system>' }], __meta: { seq: 18, timestamp: 1018 } })
    if (size === 'two-large') messages.push({ role: 'user', parts: [{ text: '<foxwarm-system kind="event">\\n' + body + '\\n</foxwarm-system>' }], __meta: { seq: 19, timestamp: 1019 } })
    if (size === 'cards') {
      messages.splice(17, 1,
        { role: 'model', parts: [{ functionCall: { name: 'exec', id: 'card-tool', args: { command: ('echo a\\n').repeat(24) } } }, { thinking: Array.from({ length: 18 }, (_, n) => 'reasoning step ' + n).join('\\n\\n') }, { providerMeta: { openaiResponses: { outputItem: { type: 'web_search_call', action: { type: 'search', queries: Array.from({ length: 12 }, (_, n) => 'query ' + n), query: 'query 0' } } } } }], __meta: { seq: 18, timestamp: 1018 } },
        { role: 'model', parts: [{ text: 'Last answer' }], __meta: { seq: 19, timestamp: 1019 } })
    }
    if (size === 'ctx' || size === 'ctx-deep') {
      messages.splice(17, 1, { role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#4 raw#1-#3] ' + ('summary paragraph\\n\\n').repeat(10) }], __meta: { seq: 18, timestamp: 1018, contextBlock: { id: 4, level: 1, rawStartSeq: 1, rawEndSeq: 3, sourceKind: 'message' } } })
    }
    if (size === 'group' || size === 'group-large') {
      const call = (id, seq) => ({ role: 'model', parts: [{ functionCall: { id, name: 'exec', args: { command: 'echo ' + id } } }], __meta: { seq, timestamp: 1000 + seq, usage: { cachedTokens: 0, inputTokens: 500, outputTokens: 100 } } })
      const result = (id, seq) => ({ role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: id + ' result\\n' + 'line\\n'.repeat(25) } } }], __meta: { seq, timestamp: 1000 + seq } })
      const entries = size === 'group-large' ? Array.from({ length: 14 }, (_, n) => [call('call-' + n, 18 + 2 * n), result('call-' + n, 19 + 2 * n)]).flat() : [call('first', 18), result('first', 19), call('second', 20), result('second', 21)]
      messages.splice(17, 1, ...entries, { role: 'model', parts: [{ text: 'Final answer' }], __meta: { seq: 18 + entries.length, timestamp: 1018 + entries.length } })
    }

    window.fetch = async input => {
      const url = String(input)
      if (url.includes('/context-blocks/5/expand')) {
        return new Response(JSON.stringify({ sessionId: 'fixture/height', blockId: 5, expansionKind: 'messages', messages: [
          { role: 'model', parts: [{ functionCall: { id: 'deep-tool', name: 'exec', args: { command: 'echo deep' } } }], __meta: { seq: 31 } },
          { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'deep-tool', response: { output: 'deep result' } } }], __meta: { seq: 32 } },
          { role: 'model', parts: [{ text: 'Deep archive tail' }], __meta: { seq: 33 } },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/context-blocks/4/expand') && size === 'ctx-deep') {
        return new Response(JSON.stringify({ sessionId: 'fixture/height', blockId: 4, expansionKind: 'messages', messages: [
          { role: 'model', parts: [{ text: '[CTX-BLOCK L2 B#5 raw#1-#3] nested summary' }], __meta: { seq: 30, contextBlock: { id: 5, level: 2, rawStartSeq: 1, rawEndSeq: 3, sourceKind: 'message' } } },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/context-blocks/4/expand')) {
        await new Promise(resolve => setTimeout(resolve, 125))
        return new Response(JSON.stringify({ sessionId: 'fixture/height', blockId: 4, expansionKind: 'messages', messages: [{ role: 'model', parts: [{ text: 'Loaded archive detail ' + 'line\\n'.repeat(60) }], __meta: { seq: 1 } }, { role: 'model', parts: [{ functionCall: { id: 'nested-tool', name: 'exec', args: { command: 'echo nested' } } }], __meta: { seq: 2 } }, { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'nested-tool', response: { output: 'nested result' } } }], __meta: { seq: 3 } }, { role: 'model', parts: [{ text: 'archive tail' }], __meta: { seq: 4 } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const data = url.includes('/history')
        ? { session: { id: 'fixture/height', busy: true, runtimeState: 'requesting-model', queueLength: 0 }, messages, queuedMessages: [], queueLength: 0 }
        : url.includes('/models') ? { models: [] }
        : url.includes('/asr/status') ? { configured: false, available: false }
        : {}
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    class FixtureSocket {
      static CLOSED = 3
      static instances = []
      constructor() { this.readyState = 0; FixtureSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.({}) }) }
      close() { this.readyState = FixtureSocket.CLOSED }
      send(raw) { const payload = JSON.parse(raw); if (payload.type !== 'set-subscriptions') return; queueMicrotask(() => {
        this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: { 'fixture/height': 'fixture/height' } })
        this.emit({ type: 'subscriptions-applied', revision: payload.revision })
      }) }
      emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
    }
    window.WebSocket = FixtureSocket
    window.emitStream = text => FixtureSocket.instances.at(-1)?.emit({ type: 'session-event', sessionId: 'fixture/height', event: { type: 'model-stream-update', streamId: 'fixture-stream', text } })
    createRoot(document.getElementById('root')).render(React.createElement(Chat, {
      sessionId: 'fixture/height', canonicalSessionId: 'fixture/height', sessionDisplayName: 'Height test', groupTools: size.startsWith('group') || size.startsWith('ctx'),
    }))
  `
  const result = await build({ stdin: { contents: source, resolveDir: packageDir, sourcefile: 'height-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((request, response) => {
    const reduced = new URL(request.url, 'http://localhost').searchParams.get('reduced') === '1'
    const mediaOverride = reduced ? `<script>const nativeMatchMedia = window.matchMedia.bind(window); window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : nativeMatchMedia(query)</script>` : ''
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.foxwarm-chat-root{height:100%;display:flex;flex-direction:column}.foxwarm-chat-root>header{flex:0 0 48px}.foxwarm-chat-message-region{position:relative;min-height:0;flex:1}.foxwarm-chat-messages{height:100%;overflow-y:auto;padding:8px}.foxwarm-chat-root form{display:none}[data-chat-message-anchor-key]{min-height:66px}.foxwarm-tool-group [data-chat-message-anchor-key]{min-height:0}</style></head><body><div id="root"></div>${mediaOverride}<script>${result.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ browser: process.env.FOXWARM_E2E_BROWSER === 'firefox' ? 'firefox' : 'chrome', executablePath: process.env.FOXWARM_E2E_BROWSER === 'firefox' ? (process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox') : (process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'), headless: true, args: process.env.FOXWARM_E2E_BROWSER === 'firefox' ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const geometry = () => page.evaluate(() => {
  const container = document.querySelector('.foxwarm-chat-messages')
  const card = document.querySelector('[data-system-message-card]')
  const view = container.getBoundingClientRect()
  const rect = card.getBoundingClientRect()
  return { top: rect.top, height: rect.height, viewportTop: view.top, scrollTop: container.scrollTop, distance: container.scrollHeight - container.scrollTop - container.clientHeight, styleHeight: card.style.height, clipPath: card.style.clipPath }
})
async function mount(size, reduced = false, width = 900, height = 600) {
  if (process.env.FOXWARM_E2E_BROWSER !== 'firefox') await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }])
  if (process.env.FOXWARM_E2E_BROWSER !== 'firefox') await page.setViewport({ width, height })
  await page.goto(`${baseUrl}/?size=${size}&reduced=${reduced ? '1' : '0'}`, { waitUntil: 'load' })
  await page.waitForSelector(size.startsWith('group') ? '[data-tool-group]' : size.startsWith('ctx') ? '.foxwarm-context-block-card' : size === 'cards' ? '.foxwarm-tool-card' : '[data-system-message-card]')
  await wait(80)
  await page.$eval('.foxwarm-chat-messages', node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')) })
  await wait(40)
}

// Clicking the line instead of the card surface verifies the existing disclosure control.
const toggle = () => page.click('[data-system-message-card] .foxwarm-thread-line-button')

test('short expansion follows bottom; height interpolates and returns to auto', async () => {
  await mount('small')
  const start = await geometry()
  assert.ok(start.distance < 3)
  await toggle()
  const early = await geometry()
  assert.ok(early.styleHeight.endsWith('px'), 'layout commit installs a pixel start height')
  await wait(115)
  const middle = await geometry()
  await wait(260)
  const final = await geometry()
  assert.ok(middle.height > start.height + 1 && middle.height < final.height - 1, `intermediate height ${middle.height} between ${start.height} and ${final.height}`)
  assert.ok(final.distance < 3, 'small expansion retains bottom follow: ' + JSON.stringify({start, early, middle, final}))
  assert.equal(final.styleHeight, '')
  assert.equal(final.clipPath, '')
  await toggle()
  await wait(370)
  const collapsed = await geometry()
  assert.ok(collapsed.height < final.height)
  assert.ok(collapsed.distance < 3, 'collapse clamps the attached scroller naturally')
})

test('large attached expansion keeps the card top visible without snapshot restoration', async () => {
  await mount('large')
  const start = await geometry()
  assert.ok(start.distance < 3)
  await toggle()
  await wait(610)
  const expanded = await geometry()
  assert.ok(expanded.top >= expanded.viewportTop - 3, `expanded top ${expanded.top}, viewport ${expanded.viewportTop}; start ${JSON.stringify(start)} expanded ${JSON.stringify(expanded)}`)
  assert.ok(expanded.distance > 100, 'bottom follow is suppressed for the oversized card')
  assert.ok(Math.abs(expanded.scrollTop - start.scrollTop) < 5, 'no synthetic scroll position compensation')
  assert.equal(expanded.styleHeight, '')
  await toggle()
  await wait(400)
  const collapsed = await geometry()
  assert.ok(collapsed.height < expanded.height && collapsed.styleHeight === '')
})

test('detached expansion does not jump; rapid reversal cleans up', async () => {
  await mount('large')
  await page.$eval('.foxwarm-chat-messages', node => { node.scrollTop -= 80; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true })) })
  const start = await geometry()
  await page.$eval('[data-system-message-card] .foxwarm-thread-line-button', node => node.click())
  await wait(80)
  await page.$eval('[data-system-message-card] .foxwarm-thread-line-button', node => node.click())
  await wait(400)
  const end = await geometry()
  assert.ok(Math.abs(start.scrollTop - end.scrollTop) < 5, 'detached viewport stays detached through reversal: ' + JSON.stringify({start, end}))
  assert.equal(end.styleHeight, '')
  assert.equal(end.clipPath, '')
})

test('reduced-motion does not leave a transition height or clip', async () => {
  await mount('large', true)
  await toggle()
  const result = await geometry()
  assert.equal(result.styleHeight, '')
  assert.equal(result.clipPath, '')
})


test('group card keeps its header and transitions nested members with independently clickable disclosures', async () => {
  await mount('group')
  const group = '[data-tool-group]'
  const before = await page.$eval(group, node => ({
    height: node.getBoundingClientRect().height,
    members: node.querySelectorAll('.foxwarm-tool-card:not(.foxwarm-tool-group-card)').length,
    header: node.querySelector('.foxwarm-tool-group-header')?.textContent,
    outerLeft: node.querySelector('[data-tool-group-card]')?.getBoundingClientRect().left,
    regularLeft: document.querySelector('.foxwarm-assistant-message-card')?.getBoundingClientRect().left,
    regularWidth: document.querySelector('.foxwarm-assistant-message-card')?.getBoundingClientRect().width,
    outerWidth: node.querySelector('[data-tool-group-card]')?.getBoundingClientRect().width,
    inlineHeight: node.style.height,
    firstAnchor: node.getAttribute('data-chat-message-anchor-key'),
  }))
  assert.equal(before.members, 0)
  assert.equal(before.inlineHeight, '', 'initially mounted group has no height animation')
  assert.ok(Math.abs(before.outerLeft - before.regularLeft) <= 1 && Math.abs(before.outerWidth - before.regularWidth) <= 2, `collapsed group aligns with ordinary card: ${JSON.stringify(before)}`)
  assert.ok(before.header?.includes('exec ×2'))
  const samples = await page.$eval(`${group} [aria-label="Expand tool group"]`, async button => {
    const node = button.closest('[data-tool-group]')
    button.click()
    const heights = []
    let target = ''
    const started = performance.now()
    do {
      await new Promise(requestAnimationFrame)
      heights.push(node.getBoundingClientRect().height)
      target ||= node.style.height
    } while (performance.now() - started < 320)
    return { heights, target }
  })
  assert.ok(samples.target.endsWith('px'), 'group commit measures a target pixel height')
  await wait(140)
  const after = await page.$eval(group, node => {
    const outer = node.querySelector('[data-tool-group-card]')
    const member = node.querySelector('.foxwarm-tool-card:not(.foxwarm-tool-group-card)')
    return {
      height: node.getBoundingClientRect().height,
      members: node.querySelectorAll('.foxwarm-tool-card:not(.foxwarm-tool-group-card)').length,
      header: node.querySelector('.foxwarm-tool-group-header')?.textContent,
      styleHeight: node.style.height,
      outerLeft: outer.getBoundingClientRect().left,
      outerLine: outer.querySelector(':scope > .foxwarm-thread-line-button').getBoundingClientRect().toJSON(),
      memberLine: member.querySelector(':scope > .foxwarm-thread-line-button').getBoundingClientRect().toJSON(),
      outerHit: (() => { const button = outer.querySelector(':scope > .foxwarm-thread-line-button'); const r = button.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === button })(),
      memberHit: (() => { const button = member.querySelector(':scope > .foxwarm-thread-line-button'); const r = button.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === button })(),
      firstAnchor: node.getAttribute('data-chat-message-anchor-key'),
      duplicateFirstAnchors: document.querySelectorAll(`[data-chat-message-anchor-key="${node.getAttribute('data-chat-message-anchor-key')}"]`).length,
    }
  })
  assert.ok(samples.heights.some(value => value > before.height + 1 && value < after.height - 1), `actual interpolated group heights between ${before.height} and ${after.height}: ${JSON.stringify(samples.heights)}`)
  assert.equal(after.members, 2)
  assert.equal(after.header, before.header, 'counted tags stay in the same header across expansion')
  assert.equal(after.outerLeft, before.outerLeft, 'collapsed and expanded outer card align')
  assert.equal(after.firstAnchor, before.firstAnchor)
  assert.equal(after.duplicateFirstAnchors, 1)
  assert.ok(after.outerLine.right - after.memberLine.left >= 1 && after.outerLine.right - after.memberLine.left <= 3, `pl-2 gives about 2px group hit-box overlap: ${JSON.stringify(after)}`)
  assert.ok(after.outerHit && after.memberHit, `both disclosure centers hit their intended button: ${JSON.stringify(after)}`)
  assert.equal(after.styleHeight, '')
  await page.click(`${group} .foxwarm-tool-card:not(.foxwarm-tool-group-card) > .foxwarm-thread-line-button`)
  assert.equal(await page.$eval(group, node => node.dataset.toolGroupExpanded), 'true', 'member toggle does not collapse the outer card')
  await page.click(`${group} [data-tool-group-card] > .foxwarm-thread-line-button`)
  await wait(370)
  assert.equal(await page.$eval(group, node => node.querySelectorAll('.foxwarm-tool-card:not(.foxwarm-tool-group-card)').length), 0)
  assert.equal(await page.$eval(group, node => node.querySelector('.foxwarm-tool-group-header')?.textContent), before.header)
  await page.click(`${group} [aria-label="Expand tool group"]`)
  await wait(370)
  await page.click(`${group} .foxwarm-tool-group-header`)
  await wait(370)
  assert.equal(await page.$eval(group, node => node.dataset.toolGroupExpanded), 'false', 'the header itself collapses the group')
})

test('oversized group preserves its top until new content or explicit bottom navigation', async () => {
  await mount('group-large')
  const start = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  await page.click('[data-tool-group] [aria-label="Expand tool group"]')
  await wait(610)
  const expanded = await page.evaluate(() => {
    const view = document.querySelector('.foxwarm-chat-messages')
    const group = document.querySelector('[data-tool-group]')
    return { top: group.getBoundingClientRect().top, viewportTop: view.getBoundingClientRect().top, scrollTop: view.scrollTop, distance: view.scrollHeight - view.scrollTop - view.clientHeight }
  })
  assert.ok(expanded.top >= expanded.viewportTop - 3, JSON.stringify(expanded))
  assert.ok(Math.abs(expanded.scrollTop - start) < 5, JSON.stringify({start, expanded}))
  assert.ok(expanded.distance > 100)
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  await page.click('[aria-label="Scroll to bottom"]')
  await wait(80)
  const bottom = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(bottom < 3, 'explicit bottom action overrides the animation hold')
})


test('individual tool, reasoning, and hosted web-search cards transition on local toggles', async () => {
  await mount('cards')
  for (const selector of ['.foxwarm-tool-card', '[data-model-thread-card="reasoning"]', '[data-model-thread-card="web-search"]']) {
    const before = await page.$eval(selector, node => node.getBoundingClientRect().height)
    await page.$eval(`${selector} .foxwarm-thread-line-button`, node => node.click())
    await wait(115)
    const middle = await page.$eval(selector, node => node.getBoundingClientRect().height)
    await wait(340)
    const after = await page.$eval(selector, node => ({ height: node.getBoundingClientRect().height, style: node.style.height }))
    assert.ok(after.height > before + 4, `${selector}: actual expansion ${before} -> ${after.height}`)
    assert.ok(middle > before && middle < after.height, `${selector}: measured intermediate ${middle}`)
    assert.equal(after.style, '')
    await page.$eval(`${selector} .foxwarm-thread-line-button`, node => node.click())
    await wait(350)
  }
})

test('CTX asynchronous archive content grows after toggle and returns to natural height', async () => {
  await mount('ctx')
  const selector = '.foxwarm-context-block-card'
  await page.$eval(`${selector} .foxwarm-thread-line-button`, node => node.click())
  await wait(70)
  const interim = await page.$eval(selector, node => ({ height: node.getBoundingClientRect().height, style: node.style.height }))
  await page.waitForSelector('.foxwarm-context-block-card .foxwarm-chat-timeline')
  await wait(550)
  const loaded = await page.$eval(selector, node => ({ height: node.getBoundingClientRect().height, style: node.style.height, text: node.textContent }))
  assert.ok(loaded.height > interim.height + 40, `async content restores natural size ${interim.height} -> ${loaded.height}`)
  assert.ok(loaded.text.includes('Loaded archive detail'))
  assert.equal(loaded.style, '')
  const nestedGroup = `${selector} [data-tool-group]`
  assert.equal(await page.$eval(nestedGroup, node => node.querySelector('[aria-label="Expand tool group"]') !== null), true)
  await page.$eval(`${nestedGroup} [aria-label="Expand tool group"]`, node => node.click())
  await wait(370)
  assert.equal(await page.$eval(nestedGroup, node => node.querySelector('.foxwarm-tool-card:not(.foxwarm-tool-group-card)') !== null), true)
  await page.$eval(`${nestedGroup} .foxwarm-tool-group-header`, node => node.click())
  await wait(370)
  assert.equal(await page.$eval(nestedGroup, node => node.querySelector('[aria-label="Expand tool group"]') !== null), true)
})

test('new streaming content after a tall expansion resumes the existing bottom follow latch', async () => {
  await mount('large')
  await toggle()
  await wait(650)
  await page.evaluate(() => window.emitStream('New assistant output\n\n'.repeat(20)))
  await page.waitForSelector('.foxwarm-assistant-message-card')
  await wait(240)
  const afterStream = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(afterStream < 5, `next stream update follows bottom after the temporary hold: ${afterStream}`)
})


test('mobile chevron treatment keeps the outer card header and contained disclosure operable', { skip: process.env.FOXWARM_E2E_BROWSER === 'firefox' && 'Puppeteer BiDi does not support Firefox viewport emulation' }, async () => {
  await mount('group', false, 380, 640)
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-separator-treatment', 'chevron'))
  const beforeHeader = await page.$eval('[data-tool-group] .foxwarm-tool-group-header', node => node.textContent)
  await page.click('[data-tool-group] [aria-label="Expand tool group"]')
  await wait(350)
  await page.$eval('[data-tool-group] [data-usage-badge]', node => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
  const result = await page.$eval('[data-tool-group]', node => {
    const outer = node.querySelector('[data-tool-group-card]')
    const line = outer.querySelector(':scope > .foxwarm-thread-line-button')
    const stroke = line.querySelector('.foxwarm-thread-line-stroke')
    const icon = line.querySelector('.foxwarm-thread-disclosure-icon')
    const header = outer.querySelector('.foxwarm-tool-group-header')
    const badge = node.querySelector('[data-usage-badge]')
    const view = document.querySelector('.foxwarm-chat-messages')
    return { stroke: getComputedStyle(stroke).display, icon: getComputedStyle(icon).display, header: header.textContent,
      lineRect: line.getBoundingClientRect().toJSON(), headerRect: header.getBoundingClientRect().toJSON(),
      badgeRect: badge?.getBoundingClientRect().toJSON(), badgeHit: badge ? document.elementFromPoint(badge.getBoundingClientRect().left + badge.getBoundingClientRect().width / 2, badge.getBoundingClientRect().top + badge.getBoundingClientRect().height / 2)?.closest('[data-usage-badge]') === badge : false, viewRect: view.getBoundingClientRect().toJSON(),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  assert.equal(result.stroke, 'none')
  assert.notEqual(result.icon, 'none')
  assert.equal(result.header, beforeHeader)
  assert.ok(result.lineRect.left >= result.viewRect.left - 1 && result.lineRect.right <= result.viewRect.right, 'contained chevron remains clickable')
  assert.ok(result.horizontalOverflow <= 1)
  assert.ok(result.badgeRect, 'group member usage remains available inside the expanded card')
  assert.ok(result.badgeRect.right <= result.viewRect.right + 1, 'usage stays in viewport')
  assert.ok(result.badgeHit, `usage badge remains painted and clickable: ${JSON.stringify(result)}`)
  await page.click('[data-tool-group] .foxwarm-tool-group-header')
  await wait(350)
  assert.equal(await page.$eval('[data-tool-group]', node => node.dataset.toolGroupExpanded), 'false')
})

test('explicit bottom navigation during an active tall group transition wins over the hold', async () => {
  await mount('group-large')
  await page.click('[data-tool-group] [aria-label="Expand tool group"]')
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  await page.click('[aria-label="Scroll to bottom"]')
  await wait(600)
  const result = await page.$eval('.foxwarm-chat-messages', node => ({ distance: node.scrollHeight - node.scrollTop - node.clientHeight, anchor: node.style.overflowAnchor }))
  assert.ok(result.distance < 3, `explicit bottom wins while height changes: ${JSON.stringify(result)}`)
  assert.equal(result.anchor, '', 'anchor override is released after the user action')
})


test('group reversal while still animating restores the collapsed natural box', async () => {
  await mount('group-large')
  await page.$eval('[data-tool-group] [aria-label="Expand tool group"]', node => node.click())
  await wait(70)
  await page.$eval('[data-tool-group] [data-tool-group-card] > .foxwarm-thread-line-button', node => node.click())
  await wait(600)
  const group = await page.$eval('[data-tool-group]', node => ({ height: node.getBoundingClientRect().height, inlineHeight: node.style.height, overflow: node.style.overflow, summary: !!node.querySelector('[aria-label="Expand tool group"]') }))
  assert.ok(group.summary)
  assert.equal(group.inlineHeight, '')
  assert.equal(group.overflow, '')
})

test('reversing both directions targets the new natural height from the currently visible height', async () => {
  await mount('group-large')
  const probe = await page.$eval('[data-tool-group]', async group => {
    const height = () => group.getBoundingClientRect().height
    const frames = async count => { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame) }
    const measureReverse = async (button, expectedNatural) => {
      const current = height()
      const events = []
      const log = event => { if (event.target === group) events.push([event.type, event.propertyName, event.elapsedTime, Math.round(performance.now()), group.style.height]) }
      group.addEventListener('transitioncancel', log)
      group.addEventListener('transitionend', log)
      button.click()
      const immediateStyle = group.style.height
      await frames(1)
      const firstStyle = group.style.height
      await frames(1)
      const target = Number.parseFloat(group.style.height)
      const intermediate = []
      for (let index = 0; index < 4; index++) { await frames(1); intermediate.push(height()) }
      await new Promise(resolve => setTimeout(resolve, 390))
      group.removeEventListener('transitioncancel', log)
      group.removeEventListener('transitionend', log)
      return { current, target, intermediate, natural: height(), auto: group.style.height === '', expectedNatural, immediateStyle, firstStyle, events }
    }
    const collapsed = height()
    group.querySelector('[aria-label="Expand tool group"]').click()
    await frames(6)
    const expandingTarget = Number.parseFloat(group.style.height)
    const toCollapse = await measureReverse(group.querySelector('[data-tool-group-card] > .foxwarm-thread-line-button'), collapsed)
    group.querySelector('[aria-label="Expand tool group"]').click()
    await new Promise(resolve => setTimeout(resolve, 420))
    const expanded = height()
    group.querySelector('[data-tool-group-card] > .foxwarm-thread-line-button').click()
    await frames(6)
    const toExpand = await measureReverse(group.querySelector('[aria-label="Expand tool group"]'), expanded)
    return { collapsed, expanded, expandingTarget, toCollapse, toExpand }
  })
  for (const [name, entry] of [['expand→collapse', probe.toCollapse], ['collapse→expand', probe.toExpand]]) {
    assert.ok(Math.abs(entry.target - entry.expectedNatural) < 2, `${name} target should be natural height: ${JSON.stringify(entry)}`)
    assert.ok(Math.abs(entry.natural - entry.expectedNatural) < 2, `${name} auto settles at natural height: ${JSON.stringify(entry)}`)
    assert.ok(entry.auto)
    const low = Math.min(entry.current, entry.target), high = Math.max(entry.current, entry.target)
    assert.ok(entry.intermediate.some(value => value > low + 1 && value < high - 1), `${name} transitions through actual heights: ${JSON.stringify(entry)}`)
  }
})

test('a token received while the final animation layout settles uses normal attached follow', async () => {
  await mount('large')
  await toggle()
  await wait(275)
  const held = await page.$eval('.foxwarm-chat-messages', node => ({ distance: node.scrollHeight - node.scrollTop - node.clientHeight, overflowAnchor: node.style.overflowAnchor }))
  assert.equal(held.overflowAnchor, 'none', 'the animation-only hold has not settled yet')
  assert.ok(held.distance > 100)
  await page.evaluate(() => window.emitStream('Next token after expand\n\n'.repeat(18)))
  await wait(400)
  const after = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(after < 5, `new token must not be lost to the post-animation observer hold: ${after}`)
})


test('a token during the active height transition waits until completion before following', async () => {
  await mount('large')
  const during = await page.$eval('[data-system-message-card] .foxwarm-thread-line-button', async button => {
    const frames = async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame) }
    button.click()
    await frames(5)
    window.emitStream('Live token during expansion\n\n'.repeat(18))
    await frames(4)
    const view = document.querySelector('.foxwarm-chat-messages')
    const card = document.querySelector('[data-system-message-card]')
    return { cardTop: card.getBoundingClientRect().top, viewTop: view.getBoundingClientRect().top, distance: view.scrollHeight - view.scrollTop - view.clientHeight, styleHeight: card.style.height }
  })
  assert.ok(during.styleHeight.endsWith('px'), `card still animating: ${JSON.stringify(during)}`)
  assert.ok(during.cardTop >= during.viewTop - 3, `active height cannot hide top: ${JSON.stringify(during)}`)
  assert.ok(during.distance > 100, 'the token has not forced a premature bottom jump')
  await wait(470)
  const after = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(after < 5, 'the pending token follows once the active animation finishes')
})

test('manual upward intent during an active expansion cancels pending token follow', async () => {
  await mount('large')
  await page.$eval('[data-system-message-card] .foxwarm-thread-line-button', node => node.click())
  await page.$eval('.foxwarm-chat-messages', node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true })); node.scrollTop -= 70 })
  await page.evaluate(() => window.emitStream('Detaching token\n\n'.repeat(18)))
  await wait(550)
  const distance = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(distance > 100, 'explicit upward intent outranks the pending stream follow')
})

test('two active tall cards do not release each other’s pending follow early', async () => {
  await mount('two-large')
  const during = await page.evaluate(async () => {
    const frames = async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame) }
    const buttons = [...document.querySelectorAll('[data-system-message-card] .foxwarm-thread-line-button')]
    buttons[0].click()
    await frames(5)
    buttons[1].click()
    await frames(2)
    window.emitStream('Concurrent card token\n\n'.repeat(20))
    await frames(10)
    const view = document.querySelector('.foxwarm-chat-messages')
    return { distance: view.scrollHeight - view.scrollTop - view.clientHeight, heights: [...document.querySelectorAll('[data-system-message-card]')].map(card => card.style.height) }
  })
  assert.ok(during.heights.some(value => value.endsWith('px')), `at least one card still animates: ${JSON.stringify(during)}`)
  assert.ok(during.distance > 100, `first card must not prematurely restore follow: ${JSON.stringify(during)}`)
  await wait(500)
  const after = await page.$eval('.foxwarm-chat-messages', node => node.scrollHeight - node.scrollTop - node.clientHeight)
  assert.ok(after < 5, 'the pending token follows after both animations complete')
})


test('multi-level CTX and nested tool-group disclosures remain independently clickable at compact inset', async () => {
  await mount('ctx-deep')
  await page.$eval('.foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.click())
  await page.waitForSelector('.foxwarm-context-block-nested .foxwarm-context-block-card')
  await page.$eval('.foxwarm-context-block-nested .foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.click())
  await page.waitForSelector('.foxwarm-context-block-nested .foxwarm-context-block-nested [data-tool-group]')
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-context-block-card')].every(card => !card.style.height))
  const measure = () => page.evaluate(() => {
    const contexts = [...document.querySelectorAll('.foxwarm-context-block-card')]
    const group = contexts[1].querySelector('[data-tool-group]')
    const rect = node => node.getBoundingClientRect().toJSON()
    return {
      parentLine: rect(contexts[0].querySelector(':scope > .foxwarm-thread-line-button')),
      childLine: rect(contexts[1].querySelector(':scope > .foxwarm-thread-line-button')),
      groupLine: rect(group.querySelector('[data-tool-group-card] > .foxwarm-thread-line-button')),
      summaryWidth: rect(contexts[0].querySelector('.foxwarm-markdown')).width,
      parentWidth: rect(contexts[0]).width,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      nestedAnchors: contexts[0].querySelectorAll('[data-chat-message-anchor-key]').length,
    }
  })
  const collapsed = await measure()
  assert.ok(collapsed.parentLine.right - collapsed.childLine.left >= 1 && collapsed.parentLine.right - collapsed.childLine.left <= 3, `pl-2 gives about 2px CTX hit-box overlap: ${JSON.stringify(collapsed)}`)
  assert.ok(collapsed.childLine.right - collapsed.groupLine.left >= 1 && collapsed.childLine.right - collapsed.groupLine.left <= 3, `pl-2 gives about 2px CTX/group overlap: ${JSON.stringify(collapsed)}`)
  assert.ok(collapsed.parentWidth - collapsed.summaryWidth <= 25, 'nested inset does not shrink the parent summary')
  assert.equal(collapsed.nestedAnchors, 0, 'nested CTX timeline does not register top-level viewport anchors')
  await page.$eval('.foxwarm-context-block-nested [data-tool-group] [aria-label="Expand tool group"]', node => node.click())
  await wait(400)
  const groupPair = await page.$eval('.foxwarm-context-block-nested [data-tool-group]', node => {
    const rect = element => element.getBoundingClientRect().toJSON()
    return { outer: rect(node.querySelector('[data-tool-group-card] > .foxwarm-thread-line-button')), inner: rect(node.querySelector('.foxwarm-tool-card:not(.foxwarm-tool-group-card) > .foxwarm-thread-line-button')) }
  })
  assert.ok(groupPair.outer.right - groupPair.inner.left >= 1 && groupPair.outer.right - groupPair.inner.left <= 3, `pl-2 gives about 2px nested group overlap: ${JSON.stringify(groupPair)}`)
  await page.$eval('.foxwarm-context-block-nested [data-tool-group] .foxwarm-tool-card:not(.foxwarm-tool-group-card) > .foxwarm-thread-line-button', node => node.click())
  assert.equal(await page.$eval('.foxwarm-context-block-nested [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'member interaction does not collapse its parent group')
  const expanded = await measure()
  assert.ok(expanded.horizontalOverflow <= 1, `nested disclosures do not create horizontal overflow: ${JSON.stringify(expanded)}`)
  await page.click('.foxwarm-context-block-nested .foxwarm-context-block-card > .foxwarm-thread-line-button')
  assert.equal(await page.$eval('.foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.getAttribute('aria-expanded')), 'true', 'child CTX rail click leaves parent open')
  await page.click('.foxwarm-context-block-card > .foxwarm-thread-line-button')
  assert.equal(await page.$eval('.foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.getAttribute('aria-expanded')), 'false', 'parent CTX rail click collapses parent')
})


test('narrow multi-level CTX plus nested group keeps compact disclosures independently clickable', { skip: process.env.FOXWARM_E2E_BROWSER === 'firefox' && 'Puppeteer BiDi does not support Firefox viewport emulation' }, async () => {
  await mount('ctx-deep', false, 380, 640)
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-separator-treatment', 'chevron'))
  await page.$eval('.foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.click())
  await page.waitForSelector('.foxwarm-context-block-nested .foxwarm-context-block-card')
  await page.$eval('.foxwarm-context-block-nested .foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.click())
  await page.waitForSelector('.foxwarm-context-block-nested .foxwarm-context-block-nested [data-tool-group]')
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-context-block-card')].every(card => !card.style.height))
  await page.$eval('.foxwarm-context-block-nested [data-tool-group] [aria-label="Expand tool group"]', node => node.click())
  await wait(450)
  const sample = await page.evaluate(() => {
    const contexts = [...document.querySelectorAll('.foxwarm-context-block-card')]
    const group = contexts[1].querySelector('[data-tool-group]')
    const rect = element => element.getBoundingClientRect().toJSON()
    return { parent: rect(contexts[0].querySelector(':scope > .foxwarm-thread-line-button')),
      child: rect(contexts[1].querySelector(':scope > .foxwarm-thread-line-button')),
      group: rect(group.querySelector('[data-tool-group-card] > .foxwarm-thread-line-button')),
      member: rect(group.querySelector('.foxwarm-tool-card:not(.foxwarm-tool-group-card) > .foxwarm-thread-line-button')),
      width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  assert.ok(sample.width < 500, `actual narrow viewport required: ${JSON.stringify(sample)}`)
  for (const [parent, child] of [[sample.parent, sample.child], [sample.child, sample.group], [sample.group, sample.member]]) {
    assert.ok(parent.right - child.left >= 1 && parent.right - child.left <= 3, `pl-2 gives about 2px narrow-rail overlap: ${JSON.stringify(sample)}`)
  }
  assert.ok(sample.overflow <= 1, `nested cards stay inside viewport: ${JSON.stringify(sample)}`)
  await page.click('.foxwarm-context-block-nested [data-tool-group] [data-tool-group-card] > .foxwarm-thread-line-button')
  assert.equal(await page.$eval('.foxwarm-context-block-nested .foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.getAttribute('aria-expanded')), 'true', 'group chevron click leaves child CTX open')
  await page.click('.foxwarm-context-block-nested .foxwarm-context-block-card > .foxwarm-thread-line-button')
  assert.equal(await page.$eval('.foxwarm-context-block-card > .foxwarm-thread-line-button', node => node.getAttribute('aria-expanded')), 'true', 'child chevron click leaves parent CTX open')
})

test('expanded group member usage remains outside its card edge and clickable in chevron theme', async () => {
  await mount('group')
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-separator-treatment', 'chevron'))
  await page.click('[data-tool-group] [aria-label="Expand tool group"]')
  await wait(410)
  await page.$eval('[data-tool-group] [data-usage-badge]', node => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
  const sample = await page.$eval('[data-tool-group]', node => {
    const outer = node.querySelector('[data-tool-group-card]')
    const member = node.querySelector('.foxwarm-tool-card:not(.foxwarm-tool-group-card)')
    const badge = node.querySelector('[data-usage-badge]')
    const badgeRect = badge.getBoundingClientRect()
    return { outerOverflow: getComputedStyle(outer).overflowX, memberRight: member.getBoundingClientRect().right,
      badgeLeft: badgeRect.left, hit: document.elementFromPoint(badgeRect.left + badgeRect.width / 2, badgeRect.top + badgeRect.height / 2)?.closest('[data-usage-badge]') === badge,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  assert.ok(sample.badgeLeft >= sample.memberRight + 7, `existing 8px member-to-usage gap: ${JSON.stringify(sample)}`)
  assert.equal(sample.outerOverflow, 'visible', 'outer group card must not clip member usage')
  assert.ok(sample.hit, `badge is actually clickable outside member card: ${JSON.stringify(sample)}`)
  assert.ok(sample.documentOverflow <= 1)
  await page.click('[data-tool-group] [data-usage-badge]')
  assert.equal(await page.$eval('[data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'usage click does not collapse group')
})
