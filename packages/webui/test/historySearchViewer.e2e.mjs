import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const entry = new URL('../src/components/HistorySearchView.tsx', import.meta.url).pathname
let browser, server, fixture, baseUrl

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import HistorySearchView from ${JSON.stringify(entry)}
const msg = (role, seq, parts) => ({ role, parts, __meta: { seq, timestamp: 1700000000000 + seq * 1000 } })
const block = { role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#3 raw#20-#21]\\nBlock topic' }], __meta: { contextBlock: { id: 3, level: 1, sourceKind: 'message', sourceStart: 20, sourceEnd: 21, rawStartSeq: 20, rawEndSeq: 21, createdAt: 1700000000000 } } }
const results = [
  { key: 'hit-a', kind: 'messages', sessionId: 'alpha', firstSeq: 10, lastSeq: 11, hasEarlier: false, hasLater: true, messages: [
    msg('user', 10, [{ text: 'alpha question' }, { inlineDataRef: { blobId: 'sample.png', mimeType: 'image/png', apiPath: '/blobs/sample.png' } }]),
    msg('model', 11, [{ text: 'alpha answer' }, { functionCall: { id: 'call-1', name: 'read', args: { filePath: 'memo.txt' } } }]),
  ] },
  { key: 'hit-b', kind: 'block', sessionId: 'beta', firstSeq: 20, lastSeq: 21, hasEarlier: false, hasLater: true, messages: [block] },
]
window.__requests = []
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.href)
  window.__requests.push(url.pathname + url.search)
  const response = body => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
  if (url.pathname.endsWith('/api/history/search')) {
    if (url.searchParams.get('query') === 'slow') return new Promise(resolve => { window.__resolveSlow = () => resolve(new Response(JSON.stringify({ results: [results[0]] }), { headers: { 'Content-Type': 'application/json' } })) })
    if (url.searchParams.get('query') === 'fresh') return response({ results: [results[1]] })
    return response({ results })
  }
  if (url.pathname.endsWith('/api/history/window')) {
    if (url.searchParams.get('target')) return response({ sessionId: url.searchParams.get('sessionId'), messages: [msg('user', 10, [{ text: 'exact archive message' }])], firstSeq: 10, lastSeq: 10, hasEarlier: false, hasLater: false })
    if (url.searchParams.has('afterSeq')) return response({ messages: [msg('tool', 12, [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'later alpha tool output' } } }])], firstSeq: 12, lastSeq: 12, hasEarlier: true, hasLater: false })
  }
  if (url.pathname.endsWith('/context-blocks/3/expand')) return response({ sessionId: 'beta', blockId: 3, expansionKind: 'messages', messages: [msg('user', 20, [{ text: 'nested beta detail' }])] })
  return response({})
}
createRoot(document.getElementById('app')).render(<HistorySearchView isMobile={false} groupTools={true} showUsageBadge={false} showUserMessageMetadata={false} knownSessions={['alpha', 'beta']} />)
`

before(async () => {
  fixture = (await build({ stdin: { contents: source, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'history-viewer-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, jsx: 'automatic' })).outputFiles[0].text
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname
    if (path === '/prefix/ui/' || path === '/prefix/ui/index.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><div id="app"></div><script src="/prefix/ui/fixture.js"></script>'); return }
    if (path === '/prefix/ui/fixture.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(fixture); return }
    if (path === '/prefix/ui/api/blobs/sample.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
})
after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('history results use independent timelines and pagination, CTX expansion, image URLs and copied locator on a subpath', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(baseUrl)
    await page.type('#history-search-query', 'topic')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result="hit-b"]')
    assert.equal(await page.$$eval('[data-history-result]', items => items.length), 2)
    assert.equal(await page.$$eval('[data-history-result] .foxwarm-chat-timeline', items => items.length), 2)
    assert.equal(await page.$eval('[data-history-result="hit-a"]', el => el.textContent.includes('alpha answer')), true)
    assert.equal(await page.$eval('[data-history-result="hit-b"]', el => el.textContent.includes('Block topic')), true)
    assert.equal(await page.$eval('[data-history-result="hit-a"] img', el => el.getAttribute('src')?.includes('/prefix/ui/api/blobs/sample.png')), true)
    await page.click('[data-history-result="hit-a"] > button:last-of-type')
    await page.waitForFunction(() => document.querySelector('[data-history-result="hit-a"]')?.textContent?.includes('later alpha tool output'))
    assert.equal(await page.$eval('[data-history-result="hit-b"]', el => el.textContent.includes('later alpha tool output')), false)
    assert.equal(await page.$eval('[data-history-result="hit-a"]', el => !!el.querySelector('[data-tool-group], .foxwarm-tool-response')), true)
    const contextButton = await page.$('[data-history-result="hit-b"] [aria-label*="Expand"]')
    assert.ok(contextButton)
    await contextButton.click()
    await page.waitForFunction(() => document.querySelector('[data-history-result="hit-b"]')?.textContent?.includes('nested beta detail'))
    assert.equal(await page.evaluate(() => window.__requests.every(url => url.startsWith('/prefix/ui/api/'))), true)
    await page.click('#history-search-query', { clickCount: 3 })
    await page.keyboard.type('sessionId=alpha msg#10-11')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.querySelector('[data-history-search-results]')?.textContent?.includes('exact archive message'))
    assert.equal(await page.evaluate(() => window.__requests.some(url => url.includes('sessionId=alpha') && url.includes('target=msg%2310-11'))), true)
  } finally { await page.close() }
})

test('changing a query prevents a late earlier search from replacing its results', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(baseUrl)
    await page.type('#history-search-query', 'slow')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => typeof window.__resolveSlow === 'function')
    await page.click('#history-search-query', { clickCount: 3 })
    await page.keyboard.press('Backspace')
    await page.keyboard.type('fresh')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result="hit-b"]')
    await page.evaluate(() => window.__resolveSlow())
    assert.equal(await page.$$eval('[data-history-result]', items => items.map(item => item.getAttribute('data-history-result')).join(',')), 'hit-b')
  } finally { await page.close() }
})
