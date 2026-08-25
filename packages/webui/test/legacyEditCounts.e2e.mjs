import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { ToolCallsBlock } from ${JSON.stringify(toolEntry)}

    const calls = {
      deletion: { id: 'delete-call', name: 'edit', args: { filePath: 'delete.txt', oldText: 'one line', newText: '' } },
      insertion: { id: 'insert-call', name: 'edit_memory', args: { filePath: 'notes.md', oldText: '', newText: 'one line' } },
      replacement: { id: 'replace-call', name: 'edit', args: { filePath: 'replace.txt', oldText: 'before', newText: 'after' } },
      empty: { id: 'empty-call', name: 'edit', args: { filePath: 'empty.txt', oldText: '', newText: '' } },
    }

    for (const [id, call] of Object.entries(calls)) {
      const msg = { role: 'model', parts: [{ functionCall: call }], __meta: { timestamp: Date.now() } }
      createRoot(document.getElementById(id)).render(React.createElement(ToolCallsBlock, { msg }))
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'legacy-edit-counts-fixture.tsx' },
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
    response.end(`<!doctype html><html><body>${['deletion', 'insertion', 'replacement', 'empty'].map(id => `<div id="${id}"></div>`).join('')}<script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 4)
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function readCounts(id) {
  return page.$eval(`#${id} .foxwarm-tool-call-summary`, summary => ({
    text: summary.textContent,
    removed: [...summary.querySelectorAll('.foxwarm-diff-removed-count')].map(element => element.textContent),
    added: [...summary.querySelectorAll('.foxwarm-diff-added-count')].map(element => element.textContent),
    separators: summary.querySelectorAll('.foxwarm-diff-count-separator').length,
  }))
}

test('collapsed legacy edit headers omit zero-count sides and separators', async () => {
  assert.deepEqual(await readCounts('deletion'), { text: '-1delete.txt', removed: ['-1'], added: [], separators: 0 })
  assert.deepEqual(await readCounts('insertion'), { text: '+1notes.md', removed: [], added: ['+1'], separators: 0 })
  assert.deepEqual(await readCounts('replacement'), { text: '-1/+1replace.txt', removed: ['-1'], added: ['+1'], separators: 1 })
  assert.deepEqual(await readCounts('empty'), { text: 'empty.txt', removed: [], added: [], separators: 0 })

  const deletionText = (await readCounts('deletion')).text
  assert.doesNotMatch(deletionText, /\+0|\+1|\//)
})