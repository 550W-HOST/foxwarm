import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const entry = new URL('../src/components/HistorySearchView.tsx', import.meta.url).pathname
const themeRuntime = new URL('../src/theme/runtime.ts', import.meta.url).pathname
const timeFormatter = new URL('../src/components/timelineTime.ts', import.meta.url).pathname
let browser, server, fixture, stylesheet, baseUrl

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import HistorySearchView from ${JSON.stringify(entry)}
import { initializeThemeRuntime, setThemeSelection } from ${JSON.stringify(themeRuntime)}
import { formatTimelineTimeMarker } from ${JSON.stringify(timeFormatter)}
initializeThemeRuntime()
setThemeSelection({ themeId: 'foxwarm.default', colorMode: new URLSearchParams(location.search).get('mode') === 'dark' ? 'dark' : 'light' })
window.fixtureFormatTime = timestamp => formatTimelineTimeMarker({ timestamp })
const msg = (role, seq, parts) => ({ role, parts, __meta: { seq, timestamp: 1700000000000 + seq * 1000 } })
const block = { role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#3 raw#20-#21]\\nBlock topic' }], __meta: { timestamp: 1700259200000, contextBlock: { id: 3, level: 1, sourceKind: 'message', sourceStart: 20, sourceEnd: 21, rawStartSeq: 20, rawEndSeq: 21, rawStartTimestamp: 1700000020000, createdAt: 1700259200000 } } }
const results = [
  { key: 'hit-a', kind: 'messages', sessionId: 'alpha', firstSeq: 10, lastSeq: 11, hasEarlier: false, hasLater: true, messages: [
    msg('user', 10, [{ text: 'alpha question' }, { inlineDataRef: { blobId: 'sample.png', mimeType: 'image/png', apiPath: '/blobs/sample.png' } }]),
    msg('model', 11, [{ text: 'alpha answer' }, { functionCall: { id: 'call-1', name: 'read', args: { filePath: 'memo.txt' } } }]),
  ] },
  { key: 'hit-b', kind: 'block', sessionId: 'beta', firstSeq: 20, lastSeq: 21, hasEarlier: true, hasLater: true, messages: [block] },
]
window.__requests = []
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.href)
  window.__requests.push(url.pathname + url.search)
  const response = body => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
  if (url.pathname.endsWith('/api/history/search')) {
    if (url.searchParams.get('query') === 'slow') return new Promise(resolve => { window.__resolveSlow = () => resolve(new Response(JSON.stringify({ results: [results[0]] }), { headers: { 'Content-Type': 'application/json' } })) })
    if (url.searchParams.get('query') === 'fresh') return response({ results: [results[1]] })
    if (url.searchParams.get('query') === 'stale') return response({ results: [{ key: 'stale', sessionId: 'alpha', kind: 'unavailable', messages: [], hasEarlier: false, hasLater: false, fallbackExcerpt: 'Cached excerpt only' }] })
    if (['missing-time', 'negative-time', 'invalid-date', 'ctx-no-start'].includes(url.searchParams.get('query'))) {
      const query = url.searchParams.get('query')
      const source = query === 'ctx-no-start' ? { ...block, __meta: { ...block.__meta, contextBlock: { ...block.__meta.contextBlock, rawStartTimestamp: undefined } } }
        : { role: 'user', parts: [{ text: query }], __meta: { seq: 33, ...(query === 'negative-time' ? { timestamp: -1 } : query === 'invalid-date' ? { timestamp: Number.MAX_VALUE } : {}) } }
      return response({ results: [{ key: query, sessionId: 'alpha', kind: query === 'ctx-no-start' ? 'block' : 'messages', messages: [source], firstSeq: 33, lastSeq: 33, hasEarlier: false, hasLater: false }] })
    }
    return response({ results })
  }
  if (url.pathname.endsWith('/api/history/window')) {
    if (url.searchParams.get('target')) {
      const wide = url.searchParams.get('target') === 'msg#10-200'
      return response({ sessionId: url.searchParams.get('sessionId'), messages: [msg('user', 10, [{ text: 'exact archive message' }])], firstSeq: 10, lastSeq: 10,
        requestedRange: wide ? { startSeq: 10, endSeq: 200 } : { startSeq: 10, endSeq: 11 }, shownRange: { startSeq: 10, endSeq: 10 },
        hasEarlier: false, hasLater: wide, hasMoreInTarget: wide })
    }
    if (url.searchParams.has('targetEndSeq')) return response({ messages: [msg('model', 11, [{ text: 'continuing selected range' }])], firstSeq: 11, lastSeq: 11,
      shownRange: { startSeq: 11, endSeq: 11 }, hasEarlier: true, hasLater: true, hasMoreInTarget: false })
    if (url.searchParams.has('beforeSeq')) return response({ messages: [msg('user', 19, [{ text: 'earlier beta detail' }])], firstSeq: 19, lastSeq: 19, hasEarlier: false, hasLater: true })
    if (url.searchParams.has('afterSeq')) return response({ messages: [msg('tool', 12, [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'later alpha tool output' } } }])], firstSeq: 12, lastSeq: 12, hasEarlier: true, hasLater: false })
  }
  if (url.pathname.endsWith('/context-blocks/3/expand')) return response({ sessionId: 'beta', blockId: 3, expansionKind: 'messages', messages: [msg('user', 20, [{ text: 'nested beta detail' }])] })
  return response({})
}
createRoot(document.getElementById('app')).render(<HistorySearchView isMobile={false} groupTools={true} showUsageBadge={false} showUserMessageMetadata={false} knownSessions={['alpha', 'beta']} />)
`

before(async () => {
  fixture = (await build({ stdin: { contents: source, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'history-viewer-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, jsx: 'automatic' })).outputFiles[0].text
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build the WebUI before history viewer browser tests')
  stylesheet = await readFile(new URL(cssName, assets), 'utf8')
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname
    if (path === '/prefix/ui/' || path === '/prefix/ui/index.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><link rel="stylesheet" href="/prefix/ui/fixture.css"><div id="app"></div><script src="/prefix/ui/fixture.js"></script>'); return }
    if (path === '/prefix/ui/fixture.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(stylesheet); return }
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

async function assertHeaderTime(page, selector, timestamp) {
  const expected = await page.evaluate(value => ({ ...window.fixtureFormatTime(value), dateTime: new Date(value).toISOString() }), timestamp)
  const actual = await page.$eval(`${selector} header time`, element => ({ text: element.textContent, title: element.title, dateTime: element.dateTime }))
  assert.deepEqual(actual, expected)
}

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
    await assertHeaderTime(page, '[data-history-result="hit-a"]', 1700000010000)
    await assertHeaderTime(page, '[data-history-result="hit-b"]', 1700000020000)
    assert.equal(await page.$eval('[data-history-result="hit-b"] header', element => element.textContent.includes('Context summary') || element.textContent.includes('Messages')), false)
    assert.equal(await page.$eval('[data-history-result="hit-a"] img', el => el.getAttribute('src')?.includes('/prefix/ui/api/blobs/sample.png')), true)
    assert.deepEqual(await page.$eval('[data-history-result="hit-a"] [data-history-page="later"]', el => ({ wide: el.getBoundingClientRect().width > el.closest('[data-history-result]').getBoundingClientRect().width * 0.8, icon: !!el.querySelector('svg'), dashed: !!el.querySelector('.border-dashed'), range: el.textContent })), { wide: true, icon: true, dashed: true, range: 'Load latermsg#10–11' })
    assert.equal(await page.$eval('[data-history-result="hit-a"] header', el => el.textContent.includes('msg#10–11')), false)
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$('[data-history-result="hit-a"]'))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/history-range-row-light.png` })
    await page.click('[data-history-result="hit-a"] [data-history-page="later"]')
    await page.waitForFunction(() => document.querySelector('[data-history-result="hit-a"]')?.textContent?.includes('later alpha tool output'))
    assert.equal(await page.$eval('[data-history-result="hit-b"]', el => el.textContent.includes('later alpha tool output')), false)
    await page.click('[data-history-result="hit-b"] [data-history-page="earlier"]')
    await page.waitForFunction(() => document.querySelector('[data-history-result="hit-b"]')?.textContent?.includes('earlier beta detail'))
    await assertHeaderTime(page, '[data-history-result="hit-b"]', 1700000019000)
    assert.equal(await page.$eval('[data-history-result="hit-a"]', el => el.textContent.includes('earlier beta detail')), false)
    assert.equal(await page.$eval('[data-history-result="hit-b"] [data-history-page="later"]', el => el.textContent.includes('msg#19–21')), true)
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
    await assertHeaderTime(page, '[data-history-result]', 1700000010000)
    assert.equal(await page.$eval('[data-history-result] [data-history-range]', el => el.textContent.includes('Selected msg#10–11')), true)
    assert.equal(await page.evaluate(() => window.__requests.some(url => url.includes('sessionId=alpha') && url.includes('target=msg%2310-11'))), true)
  } finally { await page.close() }
})

test('the same full-width range row follows the actual dark theme runtime', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${baseUrl}?mode=dark`)
    await page.type('#history-search-query', 'topic')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result="hit-a"] [data-history-page="later"]')
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true)
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$('[data-history-result="hit-a"]'))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/history-range-row-dark.png` })
  } finally { await page.close() }
})

test('a cached source without original messages never shows a fabricated message range', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(baseUrl)
    await page.type('#history-search-query', 'stale')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result="stale"]')
    assert.equal(await page.$eval('[data-history-result="stale"]', el => el.textContent.includes('Cached excerpt only') && !el.querySelector('[data-history-page], [data-history-range]')), true)
    assert.equal(await page.$('[data-history-result="stale"] header time'), null)
  } finally { await page.close() }
})

test('invalid or missing first timestamps never fall back to a block creation time', async () => {
  const page = await browser.newPage()
  try {
    for (const query of ['missing-time', 'negative-time', 'invalid-date', 'ctx-no-start']) {
      await page.goto(baseUrl)
      await page.type('#history-search-query', query)
      await page.click('button[type=submit]')
      await page.waitForSelector(`[data-history-result="${query}"]`)
      assert.equal(await page.$(`[data-history-result="${query}"] header time`), null, query)
      assert.equal(await page.$eval(`[data-history-result="${query}"] header`, element => element.textContent.trim()), 'alpha', query)
    }
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

test('a pasted range continues inside its bound before ordinary later browsing', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(baseUrl)
    await page.type('#history-search-query', 'sessionId=alpha msg#10-200')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result]')
    assert.equal(await page.$eval('[data-history-result] [data-history-page="later"]', el => el.textContent.includes('Selected msg#10–200 · shown 10–10')), true)
    await page.click('[data-history-result] [data-history-page="later"]')
    await page.waitForFunction(() => document.querySelector('[data-history-result]')?.textContent?.includes('continuing selected range'))
    assert.equal(await page.$eval('[data-history-result] [data-history-page="later"]', el => el.textContent.includes('Load later') && el.textContent.includes('shown 10–11')), true)
    await page.click('[data-history-result] [data-history-page="later"]')
    await page.waitForFunction(() => document.querySelector('[data-history-result]')?.textContent?.includes('later alpha tool output'))
    const requests = await page.evaluate(() => window.__requests.filter(url => url.includes('/history/window')))
    assert.equal(requests.some(url => url.includes('afterSeq=10') && url.includes('targetEndSeq=200')), true)
    assert.equal(requests.some(url => url.includes('afterSeq=11') && !url.includes('targetEndSeq')), true)
  } finally { await page.close() }
})
