import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname

const CONTEXT_BLOCK_META = { id: 42, level: 1, rawStartSeq: 10, rawEndSeq: 20, sourceKind: 'message' }
const CONTEXT_BLOCK_TEXT = '[CTX-BLOCK L1 B#42 raw#10-#20] Summary body for the preceding-part case.'

let browser
let page
let server

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    window.fetch = async () => new Response('{}', { status: 404 })

    const contextBlockMeta = ${JSON.stringify(CONTEXT_BLOCK_META)}
    const contextBlockText = ${JSON.stringify(CONTEXT_BLOCK_TEXT)}
    const cases = {
      // Control: the block summary is the message's first part.
      'ctx-first': [{ text: contextBlockText }],
      // An image part is not a visible model text/reasoning part, so the summary is not at visible index 0.
      'ctx-after-image': [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: contextBlockText }],
      // An unknown hosted Responses item is skipped by the visible-part scan for the same reason.
      'ctx-after-hosted': [{ providerMeta: { openaiResponses: { outputItem: { type: 'file_search_call' } } } }, { text: contextBlockText }],
    }

    for (const [id, parts] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages: [{ role: 'model', parts, __meta: { seq: id, contextBlock: contextBlockMeta } }],
        isMobile: false,
        groupTools: true,
        showUsageBadge: false,
      }))
    }
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'context-block-preceding-parts-fixture.tsx' },
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
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const ids = ['ctx-first', 'ctx-after-image', 'ctx-after-hosted']
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${ids.map(id => `<div id="${id}" class="fixture"></div>`).join('')}<script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('#ctx-first .foxwarm-context-block-card')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('a CTX-BLOCK message keeps its block card when a non-text part precedes the summary', async () => {
  const views = await page.evaluate(() => Object.fromEntries(
    ['ctx-first', 'ctx-after-image', 'ctx-after-hosted'].map(id => [id, {
      contextCards: document.querySelectorAll(`#${id} .foxwarm-context-block-card`).length,
      assistantCards: document.querySelectorAll(`#${id} .foxwarm-assistant-message-card`).length,
      text: document.querySelector(`#${id}`).textContent,
    }]),
  ))

  for (const [id, view] of Object.entries(views)) {
    assert.equal(view.contextCards, 1, `${id} renders the CTX-BLOCK card`)
    assert.equal(view.assistantCards, 0, `${id} does not fall back to an ordinary assistant card`)
    assert.ok(view.text.includes('Summary body for the preceding-part case.'), `${id} keeps the summary text`)
  }
})
