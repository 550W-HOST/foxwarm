import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname

// One collapsed group: four `exec` calls where the second one fails, thinking in the group's first
// message, and thinking before the wrap-up text that ends the group.
const MESSAGES = [
  { role: 'model', parts: [{ thinking: 'Neutral reasoning step one.' }, { functionCall: { id: 'c1', name: 'exec', args: { command: 'echo one' } } }] },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'c1', response: { output: 'neutral output one' } } }] },
  { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'exec', args: { command: 'echo two' } } }] },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'c2', response: { error: 'neutral error message' } } }] },
  { role: 'model', parts: [{ functionCall: { id: 'c3', name: 'exec', args: { command: 'echo three' } } }] },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'c3', response: { output: 'neutral output three' } } }] },
  { role: 'model', parts: [{ functionCall: { id: 'c4', name: 'exec', args: { command: 'echo four' } } }] },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'c4', response: { output: 'neutral output four' } } }] },
  { role: 'model', parts: [{ thinking: 'Neutral reasoning step two.' }, { text: 'Neutral wrap-up text.' }] },
]

let browser
let page
let server

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    window.fetch = async () => new Response('{}', { status: 404 })

    createRoot(document.getElementById('summary')).render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/main',
      messages: ${JSON.stringify(MESSAGES)},
      isMobile: false,
      groupTools: true,
      showUsageBadge: false,
    }))
  `

  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-group-summary-fixture.tsx' },
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
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="summary" class="fixture"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('#summary [aria-label="Expand tool group"]')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('a collapsed tool group summarises its counted tags by tone', async () => {
  const view = await page.evaluate(() => {
    const summaryButton = document.querySelector('#summary [aria-label="Expand tool group"]')
    const card = summaryButton.closest('.foxwarm-tool-card')
    return {
      tags: [...card.querySelectorAll('[data-tool-tag-tone]')].map(tag => ({
        text: tag.textContent,
        tone: tag.getAttribute('data-tool-tag-tone'),
        label: tag.querySelector('span:last-child').textContent,
      })),
    }
  })

  assert.deepEqual(
    view.tags.map(tag => [tag.label, tag.tone]),
    [['exec ×3', 'success'], ['reasoning ×2', 'neutral'], ['exec ×1', 'error']],
    'counted tags are merged, sorted by count, and keep failed calls in their own error entry',
  )
  assert.ok(view.tags.every(tag => tag.text.includes('×')), 'every counted tag uses the × separator')
  assert.equal(view.tags.filter(tag => tag.label.startsWith('exec')).length, 2, 'the failed call is not merged into the successful exec count')
  assert.equal(new Set(view.tags.map(tag => tag.label)).size, view.tags.length, 'no counted tag is rendered twice')
})

test('a collapsed summary replaces the group cards it summarises', async () => {
  const view = await page.evaluate(() => ({
    toolCards: document.querySelectorAll('#summary .foxwarm-tool-card').length,
    callCards: document.querySelectorAll('#summary [aria-label="Expand exec tool"]').length,
    reasoningCards: document.querySelectorAll('#summary .foxwarm-reasoning-card').length,
    tags: document.querySelectorAll('#summary [data-tool-tag-tone]').length,
  }))

  assert.equal(view.toolCards, 1, 'only the summary card is rendered for the collapsed group')
  assert.equal(view.callCards, 0, 'individual exec call cards stay hidden while collapsed')
  assert.equal(view.reasoningCards, 0, 'thinking folded into the collapsed group keeps no reasoning card')
  assert.equal(view.tags, 3, 'the summary holds the counted tags')
})
