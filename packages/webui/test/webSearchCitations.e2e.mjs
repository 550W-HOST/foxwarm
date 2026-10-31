import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as esbuild from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(path.join(tmpdir(), 'foxwarm-citations-e2e-'))
const entry = path.join(temporary, 'fixture.tsx')
const outdir = path.join(temporary, 'dist')
const marker = '\uE200cite\uE202turn0search3\uE201'
const artifactId = `art_${'a'.repeat(32)}`
const artifactMarker = `<foxwarm-artifact id="${artifactId}" revision="1" />`
let server, browser, page, url
let artifactRequests = 0

await writeFile(entry, `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatTimeline from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatTimeline.tsx'))}
import { projectSessionSearchFields, findRenderedMatchRange } from ${JSON.stringify(path.join(webuiRoot, 'src/components/chatSessionSearch.ts'))}
import ${JSON.stringify(path.join(webuiRoot, 'src/index.css'))}
const marker = ${JSON.stringify(marker)}
const model = (text, annotations = [], streaming = false) => ({ role: 'model', parts: [{ text, providerMeta: { openaiResponses: { annotations } } }], __meta: { seq: 7, llmRequestId: 'request-citation', streaming } })
function Fixture() {
  const [messages, setMessages] = useState([model('Claim ' + marker)])
  window.fixture = {
    set: (text, annotations, streaming) => setMessages([model(text, annotations, streaming)]),
    setMessages,
    search: () => projectSessionSearchFields(messages, 'detailed').map(field => field.text),
    match: query => findRenderedMatchRange(document.querySelector('[data-search-surface="model"]'), query, 0)?.toString(),
  }
  return <ChatTimeline sessionId="fixture/main" messages={messages} isMobile={false} timelineView="detailed" showUsageBadge={false} />
}
createRoot(document.getElementById('root')).render(<Fixture />)
`)

before(async () => {
  await esbuild.build({ entryPoints: [entry], outdir, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic', alias: webuiReactAliases, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js' || request.url === '/fixture.css') {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css')
      return response.end(await readFile(path.join(outdir, request.url.slice(1))))
    }
    if (request.url.includes('/api/sessions/')) {
      response.setHeader('Content-Type', 'application/json')
      if (request.url.endsWith('/resources/image')) { response.setHeader('Content-Type', 'image/png'); return response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=', 'base64')) }
      artifactRequests++
      return response.end(JSON.stringify({ receipt: { protocolVersion: 1, artifactId, revision: 1, sessionId: 'fixture/main', type: 'image', title: 'Stable figure' }, document: { type: 'image', schemaVersion: 1, title: 'Stable figure', mimeType: 'image/png', width: 1, height: 1, alt: 'Stable figure' }, resources: { image: { mimeType: 'image/png', sizeBytes: 68 } } }))
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><main id="root"></main><script type="module" src="/fixture.js"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); await rm(temporary, { recursive: true, force: true }) })
const reload = async () => { await page.goto(url); await page.waitForSelector('[data-web-search-ref]') }
const set = async (text, annotations = [], streaming = false) => {
  await page.evaluate((text, annotations, streaming) => window.fixture.set(text, annotations, streaming), text, annotations, streaming)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

test('native sanitized UI shows inspectable unknown IDs, scoped exact Unicode links, deduplicated Sources and safe URLs', async () => {
  await reload()
  assert.deepEqual(await page.$eval('[data-web-search-ref]', element => ({ tag: element.tagName, text: element.textContent, title: element.title, raw: element.dataset.citationRaw })), { tag: 'SPAN', text: '[source?]', title: 'turn0search3', raw: marker })
  const prefix = '😀 中文 claim '
  const text = `${prefix}${marker} next ${marker}`
  const annotation = { type: 'url_citation', start_index: [...prefix].length, end_index: [...prefix].length + marker.length, url: 'https://example.com/exact', title: 'Verified title' }
  await set(text, [annotation, annotation, { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' }])
  const result = await page.$$eval('[data-web-search-ref]', elements => elements.map(element => ({ tag: element.tagName, title: element.title, href: element.getAttribute('href'), target: element.getAttribute('target'), rel: element.getAttribute('rel') })))
  assert.equal(result[0].tag, 'A')
  assert.equal(result[0].href, annotation.url)
  assert.match(result[0].title, /Verified title.*turn0search3/)
  assert.equal(result[0].target, '_blank')
  assert.equal(result[0].rel, 'noopener noreferrer')
  assert.equal(result[1].tag, 'SPAN')
  assert.equal((await page.$$('[data-web-search-citation]')).length, 1)
  assert.equal(await page.$('a[href^="javascript:"]'), null)
  await page.evaluate(() => { window.confirm = value => { window.__confirm = value; return false } })
  await page.click('[data-web-search-ref="resolved"]')
  assert.match(await page.evaluate(() => window.__confirm), /https:\/\/example.com\/exact/)
  assert.equal(page.url(), `${url}/`)
})

test('raw/copy and literal code, user, tool content preserve original references; search matches surrounding prose', async () => {
  await reload()
  const text = `Before ${marker} after.\n\n\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\``
  await set(text)
  assert.equal((await page.$$('[data-web-search-ref]')).length, 1)
  assert.deepEqual(await page.$$eval('.foxwarm-markdown code', elements => elements.map(element => element.textContent.trim())), [marker, marker])
  assert.equal(await page.evaluate(() => window.fixture.match('Before  after.')), 'Before [source?] after.')
  assert.ok((await page.evaluate(() => window.fixture.search())).some(field => field.includes('Before  after.')))
  assert.ok((await page.evaluate(() => window.fixture.search())).every(field => !field.includes('[source?]')))
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text } } }))
  await page.$eval('[title="Copy Raw Text"]', element => element.click())
  assert.equal(await page.evaluate(() => window.__copied), text)
  await page.$eval('[title="Raw Text"]', element => element.click())
  assert.equal(await page.$eval('.foxwarm-assistant-message-raw', element => element.textContent), text)
  await page.evaluate(marker => window.fixture.setMessages([
    { role: 'user', parts: [{ text: marker }], __meta: { seq: 1 } },
    { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'read', args: { filePath: 'reference.txt' } } }], __meta: { seq: 2 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'read-1', name: 'read', response: { output: marker } } }], __meta: { seq: 3 } },
  ]), marker)
  await page.waitForSelector('.foxwarm-user-message-text')
  assert.equal(await page.$eval('.foxwarm-user-message-text', element => element.textContent.trim()), marker)
  assert.equal(await page.$('[data-web-search-ref]'), null)
  // Native expanded tool response retains its raw provider-style citation text.
  await page.$eval('.foxwarm-tool-header-toggle', element => element.click())
  await page.waitForSelector('[data-search-surface="response"]')
  assert.ok((await page.$eval('[data-search-surface="response"]', element => element.textContent)).includes(marker))
})

test('hosted search sources remain in their own card, not sentence citations or a session-wide registry', async () => {
  await reload()
  await page.evaluate(marker => window.fixture.setMessages([
    { role: 'model', parts: [{ providerMeta: { openaiResponses: { outputItem: { type: 'web_search_call', action: { type: 'search', query: 'Earlier request', sources: [{ type: 'url', url: 'https://example.com/search-only', title: 'Search result' }, { type: 'url', url: 'https://example.com/search-only' }, { type: 'url', url: 'javascript:alert(1)' }] } } } } }], __meta: { seq: 5, llmRequestId: 'older' } },
    { role: 'model', parts: [{ text: 'Later unrelated claim ' + marker }], __meta: { seq: 7, llmRequestId: 'newer' } },
  ]), marker)
  await page.waitForSelector('[data-model-thread-card="web-search"]')
  assert.equal(await page.$('[data-web-search-citation]'), null)
  assert.equal(await page.$('[data-web-search-ref="resolved"]'), null)
  await page.click('[data-model-thread-card="web-search"]')
  await page.waitForSelector('[data-web-search-source]')
  assert.equal((await page.$$('[data-web-search-source]')).length, 1)
  assert.match(await page.$eval('[data-model-thread-card="web-search"]', element => element.textContent), /Search sources:/)
  assert.equal(await page.$eval('[data-web-search-source]', element => element.getAttribute('href')), 'https://example.com/search-only')
})

test('stream completion and later math keep earlier artifact, selection and special-block state mounted', async () => {
  await reload()
  const prefix = `Stable selectable paragraph.\n\n${artifactMarker}\n\n\\[\nx=1\n\\]\n\nClaim `
  await set(prefix + marker.slice(0, 3), [], true)
  await page.waitForSelector('[data-artifact-id] img')
  const requestsBefore = artifactRequests
  await page.$eval('[title="Raw LaTeX"]', element => element.click())
  await page.evaluate(() => {
    window.__figure = document.querySelector('[data-artifact-id]')
    window.__math = document.querySelector('[data-special-block]')
    window.__paragraph = document.querySelector('.foxwarm-markdown p')
    const range = document.createRange(); range.selectNodeContents(window.__paragraph)
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  for (const partial of [marker.slice(0, 1), marker.slice(0, 5), marker.slice(0, 14)]) {
    await set(prefix + partial, [], true)
    assert.doesNotMatch(await page.$eval('.foxwarm-assistant-message-markdown', element => element.textContent), /[\uE200\uE201\uE202]|turn0search/)
  }
  const annotation = { type: 'url_citation', start_index: prefix.length, end_index: prefix.length + marker.length, url: 'https://example.com/stream' }
  await set(prefix + marker + '\n\n\\[\ny=2\n\\]', [annotation], false)
  assert.deepEqual(await page.evaluate(() => ({ figure: window.__figure === document.querySelector('[data-artifact-id]'), math: window.__math === document.querySelector('[data-special-block]'), paragraph: window.__paragraph === document.querySelector('.foxwarm-markdown p'), raw: !!document.querySelector('[data-special-block-raw]'), selection: getSelection().toString() })), { figure: true, math: true, paragraph: true, raw: true, selection: 'Stable selectable paragraph.' })
  assert.equal(artifactRequests, requestsBefore)
  assert.equal((await page.$$('[data-special-block]')).length, 2)
  assert.equal((await page.$$('[data-web-search-ref="resolved"]')).length, 1)
})
