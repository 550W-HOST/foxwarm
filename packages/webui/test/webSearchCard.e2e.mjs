import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    const metadata = (action) => ({ providerMeta: { openaiResponses: { sourceModelId: 'fixture/gpt', outputItem: { type: 'web_search_call', status: 'completed', action } } } })
    const message = { role: 'model', parts: [
      { thinking: 'first reasoning' },
      metadata({ type: 'search', query: 'primary query', queries: ['primary query', 'secondary query', 'secondary query'] }),
      { thinking: 'second reasoning' },
      metadata({ type: 'open_page', url: 'https://example.com/page' }),
      metadata({ type: 'find_in_page', pattern: 'invisible' }),
      { text: 'final answer', providerMeta: { openaiResponses: { annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Example source' }] } } },
    ], __meta: { seq: 1 } }
    createRoot(document.getElementById('root')).render(React.createElement(ChatTimeline, { sessionId: 'fixture/main', messages: [message], isMobile: false, groupTools: false, showUsageBadge: false }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'web-search-card-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the web search card browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('persisted web search calls render in part order as collapsed reasoning-style cards', async () => {
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('[data-model-thread-card="web-search"]')
  const snapshot = await page.evaluate(() => ({
    orderedKinds: [...document.querySelectorAll('.foxwarm-reasoning-card, .foxwarm-web-search-card, .foxwarm-assistant-message-card')].map(element => {
      if (element.classList.contains('foxwarm-reasoning-card')) return 'reasoning'
      if (element.classList.contains('foxwarm-web-search-card')) return 'web-search'
      return 'text'
    }),
    tags: [...document.querySelectorAll('.foxwarm-web-search-tag')].map(element => element.textContent?.trim()),
    previews: [...document.querySelectorAll('.foxwarm-web-search-preview')].map(element => element.textContent?.trim()),
    expanded: [...document.querySelectorAll('[data-model-thread-card="web-search"] button')].map(element => element.getAttribute('aria-expanded')),
    sources: [...document.querySelectorAll('[data-web-search-citation]')].map(element => element.textContent?.trim()),
    hasToolCard: !!document.querySelector('.foxwarm-tool-card'),
  }))
  assert.deepEqual(snapshot.orderedKinds, ['reasoning', 'web-search', 'reasoning', 'web-search', 'text'])
  assert.deepEqual(snapshot.tags, ['Web Search', 'Web Search'])
  assert.deepEqual(snapshot.previews, ['primary query', 'Open Page: https://example.com/page'])
  assert.deepEqual(snapshot.expanded, ['false', 'false'])
  assert.deepEqual(snapshot.sources, ['[1] Example source'])
  assert.equal(snapshot.hasToolCard, false)

  await page.click('[data-model-thread-card="web-search"]')
  const expanded = await page.$eval('[data-model-thread-card="web-search"]', element => ({
    state: element.querySelector('button')?.getAttribute('aria-expanded'),
    body: element.querySelector('.foxwarm-web-search-body')?.textContent,
  }))
  assert.equal(expanded.state, 'true')
  assert.match(expanded.body || '', /primary query/)
  assert.match(expanded.body || '', /secondary query/)
  assert.equal((expanded.body || '').match(/secondary query/g)?.length, 1)
})