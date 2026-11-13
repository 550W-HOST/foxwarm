import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, origin
before(async () => {
  const entry = new URL('../src/components/useChatConversationSync.ts', import.meta.url).pathname
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { useChatConversationSync } from ${JSON.stringify(entry)}
    const query = new URLSearchParams(location.search)
    const busy = query.has('busy'), scoped = query.has('scoped')
    const f = window.fixture = { requests: [], uploads: [], result: null }
    window.fetch = async (input, options = {}) => {
      const url = String(input)
      if (url.includes('/upload')) {
        const file = options.body.get('file')
        f.uploads.push({ url, name: file.name, body: await file.text() })
        return new Response(JSON.stringify({ path: '/uploads/fixture.txt', filename: file.name, mimeType: file.type }))
      }
      if (url.endsWith('/message')) {
        f.requests.push(JSON.parse(options.body))
        return new Promise(resolve => { f.respond = (status = 202) => resolve(new Response('{}', { status })) })
      }
      if (url.includes('/history')) return new Response(JSON.stringify({ session: { id: 'fixture/main', busy, queueLength: 0 }, messages: [], queuedMessages: [], queueLength: 0, latestSeq: 0, historyVersion: 0, prefixLength: 0, historyComplete: true }))
      return new Response('{}', { status: 404 })
    }
    class Socket { static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ type: 'connected' }) }) }) }
      close() { this.readyState = 3 }
      send(raw) { const data = JSON.parse(raw); if (data.type === 'set-subscriptions') queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-accepted', revision: data.revision, sessionListResolutions: {}, sessionResolutions: Object.fromEntries(data.sessionIds.map(id => [id, id])) }) })
        this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-applied', revision: data.revision }) })
      }) }
    }
    window.WebSocket = Socket
    function Fixture() {
      const state = useChatConversationSync('fixture/main', scoped)
      f.state = state
      f.send = (text, attachment = false) => { state.sendMessage({ text, attachments: attachment ? [{ ref: 'attachment1', file: new File(['fixture attachment'], 'example.txt', { type: 'text/plain' }) }] : [] }).then(result => { f.result = result }) }
      return <pre>{JSON.stringify({ messages: state.messages, queuedMessages: state.queuedMessages, pendingSend: state.pendingSend })}</pre>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: new URL('../src', import.meta.url).pathname }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"test"' } })
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', executablePath: firefox ? process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox' : process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: firefox ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

async function send(t, text, { busy = false, scoped = false, attachment = false } = {}) {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.goto(`${origin}/?${busy ? 'busy&' : ''}${scoped ? 'scoped' : ''}`)
  await page.waitForFunction(() => window.fixture?.state.historyLoaded && !window.fixture.state.loading)
  await page.evaluate((text, attachment) => window.fixture.send(text, attachment), text, attachment)
  await page.waitForFunction(() => window.fixture.requests.length === 1)
  // Allow React's pending-row render to settle while the HTTP response is still held.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return page
}

for (const text of ['/stpo', '/Stop', '/unknown explain this', '/home/example/file', '/session/archive', '/stop.txt', '/stop\u0085compact']) {
  test(`ordinary send preserves pending identity for ${JSON.stringify(text)}`, async t => {
    const page = await send(t, text)
    const { requests, rows } = await page.evaluate(() => ({ requests: window.fixture.requests, rows: window.fixture.state.messages }))
    assert.equal(requests[0].parts[0].text, text)
    assert.ok(requests[0].clientMessageId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].__meta.clientMessageId, requests[0].clientMessageId)
    assert.equal(rows[0].__meta.optimistic, true)
    await page.evaluate(() => window.fixture.respond())
    await page.waitForFunction(() => window.fixture.result === true)
  })
}

for (const busy of [false, true]) for (const scoped of [false, true]) {
  test(`unknown slash attachment send uses ordinary ${busy ? 'queue' : 'history'} row, scoped=${scoped}`, async t => {
    const page = await send(t, '/Stop inspect this', { busy, scoped, attachment: true })
    const data = await page.evaluate(busy => ({ request: window.fixture.requests[0], uploads: window.fixture.uploads, rows: busy ? window.fixture.state.queuedMessages : window.fixture.state.messages }), busy)
    assert.ok(data.request.clientMessageId)
    assert.equal(data.rows.length, 1)
    assert.equal(data.rows[0].__meta.clientMessageId, data.request.clientMessageId)
    assert.equal(data.uploads[0].name, 'attachment1_example.txt')
    assert.equal(data.uploads[0].body, 'fixture attachment')
    assert.equal(data.uploads[0].url.includes('sessionId=fixture%2Fmain'), scoped)
    assert.deepEqual(data.request.uploadedFiles, [{ path: '/uploads/fixture.txt', filename: 'attachment1_example.txt', mimeType: 'text/plain' }])
    assert.ok(data.rows[0].parts.some(part => part.text.includes('attachment1_example.txt')))
    await page.evaluate(() => window.fixture.respond())
    await page.waitForFunction(() => window.fixture.result === true)
  })
}

for (const text of ['/help', '/stop invalid', '\uFEFF/model --effort invalid', '/stop']) {
  test(`known command ${JSON.stringify(text)} omits ordinary identity and pending rows`, async t => {
    const page = await send(t, text)
    const data = await page.evaluate(() => ({ request: window.fixture.requests[0], messages: window.fixture.state.messages, queued: window.fixture.state.queuedMessages }))
    assert.equal(data.request.clientMessageId, undefined)
    assert.deepEqual(data.messages, [])
    assert.deepEqual(data.queued, [])
    if (text === '/stop') assert.ok(data.request.controlRequestId)
    await page.evaluate(() => window.fixture.respond(200))
    await page.waitForFunction(() => window.fixture.result === true)
  })
}

test('rejected ordinary slash send removes its pending row and retains the draft contract', async t => {
  const page = await send(t, '/stpo')
  await page.evaluate(() => window.fixture.respond(403))
  await page.waitForFunction(() => window.fixture.result === false)
  assert.equal(await page.evaluate(() => window.fixture.state.messages.some(row => row.__meta?.optimistic)), false)
})
