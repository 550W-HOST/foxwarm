import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
    const allMessages = Array.from({ length: 1200 }, (_, index) => ({
      role: index === 600 ? 'user' : index === 1198 || index === 1199 ? 'model' : index === 1197 ? 'tool' : index % 4 === 0 ? 'user' : index % 4 === 1 ? 'model' : 'tool',
      parts: index === 600 ? [{ system: '<foxwarm-system kind="time" />' }] : index === 1198 ? [{ thinking: 'persisted reasoning '.repeat(6) }, { text: 'model card content '.repeat(8) }] : index === 1199 ? [{ text: 'model card content '.repeat(8) }] : index === 1197 ? [{ functionResponse: { tool_use_id: 'orphan-error', name: 'edit', response: { error: 'failed' } } }] : index % 4 === 1 ? [{ functionCall: { id: 'call-' + index, name: 'read', args: { filePath: '/tmp/' + index } } }] : index % 4 === 2 ? [{ functionResponse: { tool_use_id: 'call-' + (index - 1), name: 'read', response: { output: 'ok ' + index } } }] : [{ text: 'committed message ' + index + ' content '.repeat(8) }],
      modelVisible: index === 600 ? false : undefined,
      __meta: { seq: index + 1, timestamp: 1000 + index, ...(index % 4 === 1 ? { usage: { inputTokens: 700, cachedTokens: 100, outputTokens: 20 } } : {}) },
    }))
    window.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/history')) { const params = new URL(location.href).searchParams; const compact = params.get('compact') === '1' || params.get('short') === '1'; const messages = compact ? allMessages.slice(-101).map(message => message.__meta.seq === 1101 ? { ...message, modelVisible: false } : message) : allMessages; return new Response(JSON.stringify({ session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, modelKey: 'fixture/model' }, messages, queuedMessages: [], queueLength: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
      if (url.includes('/models')) { const contextLimit = Number(new URL(location.href).searchParams.get('contextLimit')) || 1000; return new Response(JSON.stringify({ models: [{ key: 'fixture/model', contextLimit }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
      if (url.includes('/asr/status')) return new Response(JSON.stringify({ configured: false, available: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404 })
    }
    class FixtureEventSource { static CLOSED = 2; static instances = []; constructor() { this.readyState = 1; FixtureEventSource.instances.push(this); queueMicrotask(() => this.onopen?.({})) } close() { this.readyState = FixtureEventSource.CLOSED } emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) } }
    window.EventSource = FixtureEventSource
    window.appendFixtureStream = () => FixtureEventSource.instances.at(-1)?.emit({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'stream', text: 'streaming '.repeat(100) } })
    createRoot(document.getElementById('root')).render(React.createElement(Chat, { sessionId: 'fixture/main', canonicalSessionId: 'fixture/main', sessionDisplayName: 'Fixture' }))
  `
  const result = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'context-scrollbar-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  return result.outputFiles[0].text
}

async function mount(width = 1000, contextLimit = 1000, height = 720, compact = false, short = false) {
  if (page && !page.isClosed()) await page.close()
  page = await browser.newPage()
  await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(`${fixtureUrl}?contextLimit=${contextLimit}${compact ? '&compact=1' : ''}${short ? '&short=1' : ''}`, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-messages')
  if (width >= 768) {
    await page.waitForSelector('.foxwarm-context-scrollbar')
  }
}

before(async () => {
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the context scrollbar browser test')
  const [css, bundle] = await Promise.all([readFile(new URL(cssAsset, assetsDirectory), 'utf8'), buildFixtureBundle()])
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const compactFixtureCss = req.url?.includes('compact=1') ? '.foxwarm-chat-messages-content{height:1px!important;min-height:0!important;overflow:hidden!important}[data-chat-message-anchor-key]{height:1px!important;min-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important}' : ''
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.foxwarm-chat-root>header{flex:0 0 48px}.foxwarm-chat-root form{display:none}[data-chat-message-anchor-key]{min-height:64px}[data-chat-message-anchor-key="seq-local-1001"]{min-height:480px}${compactFixtureCss}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })

test('desktop reserves a flush 32px context track with full-history semantic bars and real free share', async () => {
  await mount()
  const state = await page.evaluate(() => {
    const shell = document.querySelector('.foxwarm-context-scrollbar-shell')
    const container = document.querySelector('.foxwarm-chat-messages')
    const segments = [...document.querySelectorAll('.foxwarm-context-scrollbar-segment')]
    const used = document.querySelector('.foxwarm-context-scrollbar-used')
    const shellRect = shell.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const trackRect = document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect()
    const thumb = document.querySelector('.foxwarm-context-scrollbar-viewport')
    const content = document.querySelector('.foxwarm-chat-messages-content')
    return { shellWidth: getComputedStyle(shell).width, trackWidth: `${trackRect.width}px`, shellBackground: getComputedStyle(shell).backgroundColor, contentRightPadding: getComputedStyle(content).paddingRight, trackToContainerRight: containerRect.right - trackRect.right, scrollbarWidth: getComputedStyle(container).scrollbarWidth, segments: segments.length, tones: segments.map(x => x.className), usedHeight: Number.parseFloat(used.style.height), usedOverflow: used.scrollHeight - used.clientHeight, leftMargin: trackRect.left - shellRect.left, bottomMargin: shellRect.bottom - trackRect.bottom, rightInset: shellRect.right - trackRect.right, thumbBackground: getComputedStyle(thumb).backgroundColor }
  })
  assert.equal(state.shellWidth, '32px')
  assert.equal(state.trackWidth, '32px')
  assert.equal(state.scrollbarWidth, 'none')
  assert.equal(state.contentRightPadding, '32px')
  assert.ok(Math.abs(state.trackToContainerRight) <= 0.1, 'track reaches the scroll container outer right edge')
  assert.ok(state.segments > 800, 'full history should be represented before all rows mount')
  assert.ok(state.tones.some(tone => tone.includes('tool-success')))
  assert.ok(state.tones.some(tone => tone.includes('user')))
  assert.ok(state.usedHeight > 0 && state.usedHeight <= 100)
  assert.ok(state.usedOverflow <= 1, 'subpixel segments must not accumulate into a taller overflowed stack')
  assert.equal(state.shellBackground, 'rgba(0, 0, 0, 0)')
  assert.ok(Math.abs(state.leftMargin) <= 0.1)
  assert.ok(Math.abs(state.bottomMargin) <= 0.1)
  assert.ok(Math.abs(state.rightInset) <= 0.1, 'track should be flush to the gutter right edge')
  await page.hover('.foxwarm-context-scrollbar-viewport')
  await new Promise(resolve => setTimeout(resolve, 40))
  const hoverBackground = await page.$eval('.foxwarm-context-scrollbar-viewport', element => getComputedStyle(element).backgroundColor)
  assert.notEqual(hoverBackground, state.thumbBackground, 'overlay thumb should visibly brighten on hover')
})

test('click and drag drive native scroll and detach streaming follow without a second scroller', async () => {
  await mount()
  const gutter = await page.$('.foxwarm-context-scrollbar')
  const box = await gutter.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8)
  await new Promise(resolve => setTimeout(resolve, 80))
  const centeredThumb = await page.$eval('.foxwarm-context-scrollbar-viewport', element => {
    const rect = element.getBoundingClientRect()
    return { center: rect.top + rect.height / 2, top: rect.top }
  })
  assert.ok(Math.abs(centeredThumb.center - (box.y + box.height * 0.8)) < 4, 'outside click places the measured thumb center despite changing row/token density')
  const afterClick = await page.$eval('.foxwarm-chat-messages', element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }))
  assert.ok(afterClick.top > 0)
  const thumb = await page.$('.foxwarm-context-scrollbar-viewport')
  const thumbBox = await thumb.boundingBox()
  assert.ok(thumbBox.height > 1, 'fixture viewport marker should be directly draggable')
  const grabFraction = 1 / 3
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height * grabFraction)
  await page.mouse.down()
  const afterThumbDown = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.ok(Math.abs(afterThumbDown - afterClick.top) < 1, 'grabbing the existing viewport marker must not jump')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.65, { steps: 4 })
  await page.mouse.up()
  const afterDrag = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.notEqual(afterDrag, afterClick.top)
  const draggedThumb = await page.$eval('.foxwarm-context-scrollbar-viewport', element => {
    const rect = element.getBoundingClientRect()
    return { point: rect.top + rect.height / 3 }
  })
  assert.ok(Math.abs(draggedThumb.point - (box.y + box.height * 0.65)) < 4, 'drag preserves the grabbed one-third thumb position despite variable thumb height')
  await page.evaluate(() => window.appendFixtureStream())
  await new Promise(resolve => setTimeout(resolve, 40))
  const afterStream = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.ok(Math.abs(afterStream - afterDrag) < 3, 'custom navigation must retain existing follow-detach behavior')
})

test('track remains sticky inside the native timeline scroll chain for wheel and trackpad gestures', async () => {
  await mount()
  const track = await page.$('.foxwarm-context-scrollbar')
  const box = await track.boundingBox()
  await page.$eval('.foxwarm-chat-messages', element => { element.scrollTop = element.scrollHeight - element.clientHeight })
  const before = await page.$eval('.foxwarm-chat-messages', element => ({ top: element.scrollTop, page: window.scrollY }))
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel({ deltaY: -240 })
  await new Promise(resolve => setTimeout(resolve, 80))
  const after = await page.$eval('.foxwarm-chat-messages', element => ({ top: element.scrollTop, page: window.scrollY }))
  assert.ok(after.top < before.top, 'wheel over the track natively scrolls the timeline')
  assert.equal(after.page, before.page, 'wheel remains in the timeline scroll chain rather than scrolling the page')
})

test('explicit top action expands lazy history before reaching the true first row', async () => {
  await mount(1000, 1000, 720, false, true)
  assert.equal(await page.$('[data-chat-message-anchor-key="seq-local-1100"]'), null, 'fixture starts with only the recent lazy subset')
  await page.$eval('.foxwarm-chat-messages', element => { element.scrollTop = 300; element.dispatchEvent(new Event('scroll')) })
  await page.waitForSelector('button[aria-label="Scroll to top"]')
  await page.click('button[aria-label="Scroll to top"]')
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-1100"]')
  assert.equal(await page.$eval('.foxwarm-chat-messages', element => element.scrollTop), 0)
})

test('a non-scrollable initial lazy subset proactively expands hidden history', async () => {
  await mount(1000, 1000, 720, true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(await page.$('[data-chat-message-anchor-key="seq-local-1100"]'), 'the one hidden older row becomes mounted without a scroll event')
})

test('viewport thumb includes free context when its lower edge passes the final message', async () => {
  await mount(1000, 50000, 720, false, true)
  await page.$eval('.foxwarm-chat-messages', element => { element.scrollTop = element.scrollHeight - element.clientHeight })
  await new Promise(resolve => setTimeout(resolve, 80))
  const state = await page.evaluate(() => {
    const track = document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect()
    const thumb = document.querySelector('.foxwarm-context-scrollbar-viewport').getBoundingClientRect()
    const free = document.querySelector('.foxwarm-context-scrollbar-free')
    const freeTop = Number.parseFloat(free.style.top)
    return { thumbBottom: thumb.bottom, trackBottom: track.bottom, freeTop, freeBoundary: track.top + track.height * freeTop / 100 }
  })
  assert.ok(state.freeTop < 100, 'fixture exposes measured free context')
  assert.ok(state.thumbBottom > state.freeBoundary, 'trailing viewport blank extends the thumb into represented free context')
  assert.ok(state.thumbBottom < state.trackBottom - 1, 'trailing layout does not make all free context appear visible')
})

test('zero-token display-only user rows keep the viewport thumb at both viewport boundaries', async () => {
  await mount(1000, 1000, 720, false, true)
  const track = await page.$('.foxwarm-context-scrollbar')
  const box = await track.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5)
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-1101"]')
  for (const boundary of ['top', 'bottom']) {
    await page.$eval('.foxwarm-chat-messages', (container, boundary) => {
      const row = document.querySelector('[data-chat-message-anchor-key="seq-local-1101"]')
      const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = boundary === 'top'
        ? rowTop + 8
        : rowTop - container.clientHeight + 56
      container.dispatchEvent(new Event('scroll'))
    }, boundary)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.notEqual(await page.$('.foxwarm-context-scrollbar-viewport'), null, `thumb remains rendered when viewport ${boundary} is in a zero-token row`)
  }
})

test('info control exposes a stable legend without starting track navigation or native drag', async () => {
  await mount(1000, 1000, 720, false, true)
  const info = '.foxwarm-context-scrollbar-info-button'
  await page.hover(info)
  const legend = await page.$$eval('.foxwarm-context-scrollbar-legend-row', rows => rows.map(row => ({ text: row.textContent.replace(/\s+/g, ' ').trim(), label: row.querySelector('.foxwarm-context-scrollbar-legend-label')?.textContent })))
  assert.equal(legend.length, 6)
  assert.deepEqual(legend.map(row => row.label), [
    'system prompt snapshot',
    'system events',
    'tool calls',
    'user prompts',
    'model reasoning',
    'model contents',
  ])
  assert.ok(legend.every(row => /\d+(?:\.\d+)?[KM]? · \d+%$/.test(row.text)))
  await page.focus(info)
  assert.equal(await page.$eval('.foxwarm-context-scrollbar-tooltip', element => getComputedStyle(element).display), 'grid')
  const before = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  await page.click(info)
  assert.equal(await page.$eval('.foxwarm-chat-messages', element => element.scrollTop), before)
  const prevented = await page.$eval('.foxwarm-context-scrollbar', element => {
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(prevented, true)
})

test('right-click vertical-scale menu persists and changes overview geometry coherently', async () => {
  await mount(1000, 1000, 720, false, true)
  const track = await page.$('.foxwarm-context-scrollbar')
  const box = await track.boundingBox()
  const before = await page.$eval('.foxwarm-context-scrollbar-segment', element => element.getBoundingClientRect().height)
  const beforeScroll = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  await page.$eval('.foxwarm-context-scrollbar-shell', (element, point) => {
    const track = element.querySelector('.foxwarm-context-scrollbar')
    track?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, clientX: point.x, clientY: point.y }))
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: point.x, clientY: point.y }))
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  await page.waitForSelector('[role="menu"] [role="menuitemcheckbox"]')
  assert.equal(await page.$eval('.foxwarm-chat-messages', element => element.scrollTop), beforeScroll, 'right-click opens the menu without context navigation')
  const labels = await page.$$eval('[role="menu"] [role="menuitemcheckbox"]', buttons => buttons.map(button => button.textContent.trim()))
  assert.deepEqual(labels, ['Token count', 'Token count (logarithmic)', 'Rendered height'])
  await page.click('[role="menu"] [role="menuitemcheckbox"]:nth-of-type(3)')
  const after = await page.$eval('.foxwarm-context-scrollbar-segment', element => element.getBoundingClientRect().height)
  const persisted = await page.evaluate(() => window.localStorage.getItem('foxwarm.contextScrollbar.verticalScale'))
  assert.equal(persisted, 'rendered-height')
  assert.notEqual(after, before, 'rendered-height replaces token slice geometry')
  await page.evaluate(() => window.localStorage.removeItem('foxwarm.contextScrollbar.verticalScale'))
})

test('model-content bars and legend swatch use the assistant card surface in every theme', async () => {
  await mount(1000, 1000, 720, false, true)
  for (const theme of ['light', 'dark', '550a']) {
    const colors = await page.evaluate((theme) => {
      const html = document.documentElement
      html.classList.toggle('dark', theme === 'dark')
      if (theme === '550a') html.setAttribute('data-foxwarm-ui-style', '550a')
      else html.removeAttribute('data-foxwarm-ui-style')
      const card = document.querySelector('.foxwarm-assistant-message-card')
      const segment = document.querySelector('.foxwarm-context-scrollbar-segment-model-content')
      const swatch = document.querySelector('.foxwarm-context-scrollbar-legend-swatch.foxwarm-context-scrollbar-category-model')
      const reasoning = document.querySelector('.foxwarm-context-scrollbar-segment.foxwarm-context-scrollbar-tone-reasoning')
      return {
        card: getComputedStyle(card).backgroundColor,
        segment: getComputedStyle(segment).backgroundColor,
        swatch: getComputedStyle(swatch).backgroundColor,
        swatchOutline: getComputedStyle(swatch).boxShadow,
        reasoning: getComputedStyle(reasoning).backgroundColor,
      }
    }, theme)
    assert.equal(colors.segment, colors.card, `${theme} model-content bar matches assistant card surface`)
    assert.equal(colors.swatch, colors.card, `${theme} model-content swatch matches assistant card surface`)
    assert.notEqual(colors.swatchOutline, 'none', `${theme} white/panel swatch retains an outline`)
    assert.notEqual(colors.reasoning, colors.segment, `${theme} reasoning remains distinct from model content`)
  }
})

test('tool error bars retain their final error tone instead of the legend tool color', async () => {
  await mount(1000, 1000, 720, false, true)
  const colors = await page.evaluate(() => ({
    errorBar: getComputedStyle(document.querySelector('.foxwarm-context-scrollbar-tone-tool-error')).backgroundColor,
    legendTool: getComputedStyle(document.querySelector('.foxwarm-context-scrollbar-legend-swatch.foxwarm-context-scrollbar-category-tools')).backgroundColor,
  }))
  assert.notEqual(colors.errorBar, colors.legendTool)
})

test('per-pane composer clearance and gutter controls stay above the composer', async () => {
  await mount(900, 1000, 720, true)
  await page.addStyleTag({ content: '.foxwarm-chat-root form{display:block !important}' })
  await page.hover('.foxwarm-context-scrollbar-info-button')
  const constrained = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-chat-root').getBoundingClientRect()
    const composer = document.querySelector('.foxwarm-chat-composer-inner').getBoundingClientRect()
    const shell = document.querySelector('.foxwarm-context-scrollbar-shell').getBoundingClientRect()
    const icon = document.querySelector('.foxwarm-context-scrollbar-info-button').getBoundingClientRect()
    const tooltip = document.querySelector('.foxwarm-context-scrollbar-tooltip')
    const tooltipRect = tooltip.getBoundingClientRect()
    const composerLayer = document.querySelector('.foxwarm-chat-composer-inner').parentElement
    tooltip.style.pointerEvents = 'auto'
    const topElement = document.elementFromPoint(tooltipRect.left + tooltipRect.width / 2, tooltipRect.top + tooltipRect.height / 2)
    tooltip.style.pointerEvents = ''
    return {
      rightGap: root.right - composer.right,
      iconCenter: icon.left + icon.width / 2,
      trackCenter: document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect().left + document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect().width / 2,
      sideGap: icon.left - document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect().left,
      bottomGap: document.querySelector('.foxwarm-context-scrollbar').getBoundingClientRect().bottom - icon.bottom,
      shellZ: Number(getComputedStyle(document.querySelector('.foxwarm-context-scrollbar-shell')).zIndex),
      composerZ: Number(getComputedStyle(composerLayer).zIndex),
      tooltipTopmost: !!topElement?.closest('.foxwarm-context-scrollbar-tooltip'),
    }
  })
  assert.ok(constrained.rightGap >= 63.5, 'constrained pane preserves 64px right composer clearance')
  assert.ok(Math.abs(constrained.iconCenter - constrained.trackCenter) < 0.1, 'info icon is centered in the visible track')
  assert.ok(Math.abs(constrained.sideGap - 7.5) < 0.1 && Math.abs(constrained.bottomGap - 7.5) < 0.1, 'icon has equal 7.5px track-relative side and bottom gaps')
  assert.ok(constrained.shellZ > constrained.composerZ, 'context shell and tooltip layer above the z-20 composer')
  assert.equal(constrained.tooltipTopmost, true, 'tooltip is not covered by the composer')

  await mount(1400, 1000, 720, true)
  await page.addStyleTag({ content: '.foxwarm-chat-root form{display:block !important}' })
  const wide = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-chat-root').getBoundingClientRect()
    const composer = document.querySelector('.foxwarm-chat-composer-inner').getBoundingClientRect()
    return { leftGap: composer.left - root.left, rightGap: root.right - composer.right }
  })
  assert.ok(Math.abs(wide.leftGap - wide.rightGap) < 0.1, 'wide pane retains natural equal centering')
})

test('mobile leaves the native chat layout and hides the custom gutter', async () => {
  await mount(390, 1000, 720, true)
  assert.equal(await page.$('.foxwarm-context-scrollbar-shell'), null)
  assert.equal(await page.$eval('.foxwarm-chat-message-region', element => getComputedStyle(element).display), 'block')
})
