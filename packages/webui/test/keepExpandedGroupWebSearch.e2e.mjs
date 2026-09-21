import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname

const WEB_SEARCH_PART = {
  providerMeta: {
    openaiResponses: {
      outputItem: { type: 'web_search_call', action: { type: 'search', query: 'neutral query' } },
    },
  },
}
const TOOL_RUN = [
  { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'exec', args: { command: 'echo neutral' } } }, WEB_SEARCH_PART] },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'c1', response: { output: 'neutral tool output' } } }] },
]

const CASES = {
  // The final standalone tool group stays expanded instead of collapsing into a summary row.
  'keep-expanded': TOOL_RUN,
  // The same shape with a trailing text message is an ordinary collapsed group.
  collapsed: [...TOOL_RUN, { role: 'model', parts: [{ text: 'Neutral wrap-up text.' }] }],
}

let browser
let page
let server

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    window.fetch = async () => new Response('{}', { status: 404 })

    const cases = ${JSON.stringify(CASES)}
    for (const [id, messages] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages,
        isMobile: false,
        groupTools: true,
        showUsageBadge: false,
      }))
    }
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'keep-expanded-web-search-fixture.tsx' },
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
    const ids = Object.keys(CASES)
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${ids.map(id => `<div id="${id}" class="fixture"></div>`).join('')}<script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('#keep-expanded .foxwarm-chat-timeline')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('a keep-expanded tail tool group keeps its web-search cards while a collapsed group hides them', async () => {
  const views = await page.evaluate(() => Object.fromEntries(
    Object.keys({ 'keep-expanded': 0, collapsed: 0 }).map(id => [id, {
      webSearchCards: document.querySelectorAll(`#${id} .foxwarm-web-search-card`).length,
      summaryCards: document.querySelectorAll(`#${id} [aria-label="Expand tool group"]`).length,
    }]),
  ))

  assert.equal(views['keep-expanded'].webSearchCards, 1, 'keep-expanded group renders its web-search card')
  assert.equal(views['keep-expanded'].summaryCards, 0, 'keep-expanded group does not collapse into a summary row')
  assert.equal(views.collapsed.webSearchCards, 0, 'collapsed group hides the web-search cards covered by its summary row')
  assert.equal(views.collapsed.summaryCards, 1, 'collapsed group renders its summary row')
})
