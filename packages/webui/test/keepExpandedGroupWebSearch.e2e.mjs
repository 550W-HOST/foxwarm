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
  live: [],
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
    const roots = new Map()
    function render(id, messages, sessionId = 'fixture/main', searchTarget = null) {
      if (!roots.has(id)) roots.set(id, createRoot(document.getElementById(id)))
      roots.get(id).render(React.createElement(ChatTimeline, {
        sessionId,
        messages,
        searchTarget,
        isMobile: false,
        groupTools: true,
        showUsageBadge: false,
      }))
    }
    for (const [id, messages] of Object.entries(cases)) render(id, messages)
    window.renderLiveTimeline = (messages, sessionId, searchTarget) => render('live', messages, sessionId, searchTarget)
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

const liveCall = (id, seq) => ({
  role: 'model',
  parts: [{ functionCall: { ...(id ? { id } : {}), name: 'exec', args: { command: `echo ${seq}` } } }],
  __meta: { seq, llmRequestId: `live-request-${seq}` },
})
const liveResult = (id, seq) => ({
  role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: `Result ${seq}` } } }], __meta: { seq },
})
const liveAnswer = { role: 'model', parts: [{ text: 'Live run finished.' }], __meta: { seq: 99 } }
const liveTool = '#live [data-search-tool-index="0"]'

async function renderLive(messages, sessionId = 'fixture/main', searchTarget = null) {
  await page.evaluate((messages, sessionId, searchTarget) => window.renderLiveTimeline(messages, sessionId, searchTarget), messages, sessionId, searchTarget)
  // Await a committed React render rather than assuming evaluate flushed it.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

test('manual tool disclosure survives pairing and historical regrouping, and later group collapse wins', async () => {
  const call = liveCall('live-call', 10)
  const result = liveResult('live-call', 11)
  await renderLive([call], 'fixture/manual')
  await page.click('#live [aria-label="Expand exec tool"]')
  await page.waitForSelector(`${liveTool} .foxwarm-tool-call-args`)
  await renderLive([call, result], 'fixture/manual')
  assert.ok(await page.$(`${liveTool} .foxwarm-tool-call-args`), 'pairing retains the manual argument expansion')
  assert.equal(await page.$eval(`${liveTool} .foxwarm-tool-expanded-content`, node => node.textContent), 'Result 11')

  await renderLive([call, result, liveAnswer], 'fixture/manual')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true')
  assert.ok(await page.$(`${liveTool} .foxwarm-tool-call-args`), 'historical group retains the tool choice')
  await page.click('#live [aria-label="Collapse tool group"]')
  await page.waitForSelector('#live [aria-label="Expand tool group"]')
  await renderLive([call, { ...result, parts: result.parts.map(part => ({ functionResponse: { ...part.functionResponse, response: { output: 'Updated result' } } })) }, liveAnswer], 'fixture/manual')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false', 'old open tool state must not reopen a manually collapsed group')
  await page.click('#live [aria-label="Expand tool group"]')
  await page.waitForSelector(`${liveTool} .foxwarm-tool-call-args`)
  assert.equal(await page.$eval(`${liveTool} .foxwarm-tool-expanded-content`, node => node.textContent), 'Updated result')

  await page.click('#live [aria-label="Collapse exec tool"]')
  await page.waitForSelector('#live [aria-label="Expand exec tool"]')
  await renderLive([call, result, liveAnswer], 'fixture/manual')
  assert.equal(await page.$(`${liveTool} .foxwarm-tool-call-args`), null, 'manual tool collapse also survives history updates')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'collapsing one member does not discard the group choice')
  await page.click('#live [aria-label="Expand exec tool"]')
  await page.waitForSelector(`${liveTool} .foxwarm-tool-call-args`)

  await renderLive([call, result, liveAnswer], 'fixture/other')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false', 'another Session starts with no inherited group choice')
  await page.click('#live [aria-label="Expand tool group"]')
  await page.waitForSelector(liveTool)
  assert.equal(await page.$(`${liveTool} .foxwarm-tool-call-args`), null, 'another Session starts with no inherited tool choice')
})

test('forced-open tails and search reveals stay transient while explicit group expansion remains', async () => {
  const call = liveCall('auto-call', 20)
  const result = liveResult('auto-call', 21)
  await renderLive([call, result], 'fixture/auto')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true')
  await renderLive([call, result, liveAnswer], 'fixture/auto')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false', 'untouched tail defaults to collapsed when historical')
  const target = { id: 'fixture-search', rowKey: 'llm-request-live-request-20', toolIndex: 0, surface: 'call' }
  await renderLive([call, result, liveAnswer], 'fixture/auto', target)
  assert.ok(await page.$(`${liveTool} .foxwarm-tool-call-args`))
  await renderLive([call, result, liveAnswer], 'fixture/auto')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false', 'closing Search removes its reveal')
  await page.click('#live [aria-label="Expand tool group"]')
  await page.waitForSelector(liveTool)
  assert.equal(await page.$(`${liveTool} .foxwarm-tool-call-args`), null, 'Search did not record manual tool expansion')
  await renderLive([call, result, liveAnswer, { role: 'user', parts: [{ text: 'Next input' }], __meta: { seq: 100 } }], 'fixture/auto')
  assert.equal(await page.$eval('#live [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'explicit group expansion survives subsequent history')
})

test('ID-less tool choices are scoped to their stable message, not another message with the same tool index', async () => {
  const first = liveCall(undefined, 30)
  const second = liveCall(undefined, 31)
  await renderLive([first], 'fixture/idless')
  await page.click('#live [aria-label="Expand exec tool"]')
  await page.waitForSelector(`${liveTool} .foxwarm-tool-call-args`)
  await renderLive([first, second, liveAnswer], 'fixture/idless')
  const choices = await page.$$eval('#live [data-search-tool-index="0"]', nodes => nodes.map(node => !!node.querySelector('.foxwarm-tool-call-args')))
  assert.deepEqual(choices, [true, false])
})
