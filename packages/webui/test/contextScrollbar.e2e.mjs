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
    const messages = Array.from({ length: 1200 }, (_, index) => ({
      role: index % 4 === 0 ? 'user' : index % 4 === 1 ? 'model' : 'tool',
      parts: index % 4 === 1 ? [{ functionCall: { id: 'call-' + index, name: 'read', args: { filePath: '/tmp/' + index } } }] : index % 4 === 2 ? [{ functionResponse: { tool_use_id: 'call-' + (index - 1), name: 'read', response: { output: 'ok ' + index } } }] : [{ text: 'committed message ' + index + ' content '.repeat(8) }],
      __meta: { seq: index + 1, timestamp: 1000 + index, ...(index % 4 === 1 ? { usage: { inputTokens: 700, cachedTokens: 100, outputTokens: 20 } } : {}) },
    }))
    window.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/history')) return new Response(JSON.stringify({ session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model' }, queueLength: 0, modelKey: 'fixture/model' }, messages, queuedMessages: [], queueLength: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [{ key: 'fixture/model', contextLimit: 1000 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

async function mount(width = 1000) {
  await page.setViewport({ width, height: 720, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-messages')
  if (width >= 768) {
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-context-scrollbar-segment').length > 800)
  }
}

before(async () => {
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the context scrollbar browser test')
  const [css, bundle] = await Promise.all([readFile(new URL(cssAsset, assetsDirectory), 'utf8'), buildFixtureBundle()])
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.foxwarm-chat-root>header{flex:0 0 48px}.foxwarm-chat-root form{display:none}[data-chat-message-anchor-key]{min-height:64px}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })

test('desktop reserves a 48px native-scroll gutter with full-history semantic bars and real free share', async () => {
  await mount()
  const state = await page.evaluate(() => {
    const shell = document.querySelector('.foxwarm-context-scrollbar-shell')
    const container = document.querySelector('.foxwarm-chat-messages')
    const segments = [...document.querySelectorAll('.foxwarm-context-scrollbar-segment')]
    const used = document.querySelector('.foxwarm-context-scrollbar-used')
    return { shellWidth: getComputedStyle(shell).width, scrollbarWidth: getComputedStyle(container).scrollbarWidth, segments: segments.length, tones: segments.map(x => x.className), usedHeight: Number.parseFloat(used.style.height), usedOverflow: used.scrollHeight - used.clientHeight }
  })
  assert.equal(state.shellWidth, '48px')
  assert.equal(state.scrollbarWidth, 'none')
  assert.ok(state.segments > 800, 'full history should be represented before all rows mount')
  assert.ok(state.tones.some(tone => tone.includes('tool-success')))
  assert.ok(state.tones.some(tone => tone.includes('user')))
  assert.ok(state.usedHeight > 0 && state.usedHeight <= 100)
  assert.ok(state.usedOverflow <= 1, 'subpixel segments must not accumulate into a taller overflowed stack')
})

test('click and drag drive native scroll and detach streaming follow without a second scroller', async () => {
  await mount()
  const gutter = await page.$('.foxwarm-context-scrollbar')
  const box = await gutter.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8)
  await new Promise(resolve => setTimeout(resolve, 80))
  const afterClick = await page.$eval('.foxwarm-chat-messages', element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }))
  assert.ok(afterClick.top > 0)
  const thumb = await page.$('.foxwarm-context-scrollbar-viewport')
  const thumbBox = await thumb.boundingBox()
  assert.ok(thumbBox.height > 1, 'fixture viewport marker should be directly draggable')
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
  await page.mouse.down()
  const afterThumbDown = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.ok(Math.abs(afterThumbDown - afterClick.top) < 1, 'grabbing the existing viewport marker must not jump')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.65, { steps: 4 })
  await page.mouse.up()
  const afterDrag = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.notEqual(afterDrag, afterClick.top)
  await page.evaluate(() => window.appendFixtureStream())
  await new Promise(resolve => setTimeout(resolve, 40))
  const afterStream = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  assert.ok(Math.abs(afterStream - afterDrag) < 3, 'custom navigation must retain existing follow-detach behavior')
})

test('mobile leaves the native chat layout and hides the custom gutter', async () => {
  await mount(390)
  assert.equal(await page.$('.foxwarm-context-scrollbar-shell'), null)
  assert.equal(await page.$eval('.foxwarm-chat-message-region', element => getComputedStyle(element).display), 'block')
})
