import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
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
    import { ToolCallsBlock, getToolCallSearchText } from ${JSON.stringify(toolEntry)}

    const calls = {
      deletion: { id: 'delete-call', name: 'edit', args: { filePath: 'delete.txt', oldText: 'one line', newText: '' } },
      insertion: { id: 'insert-call', name: 'edit_memory', args: { filePath: 'notes.md', oldText: '', newText: 'one line' } },
      replacement: { id: 'replace-call', name: 'edit', args: { filePath: 'replace.txt', oldText: 'before', newText: 'after' } },
      empty: { id: 'empty-call', name: 'edit', args: { filePath: 'empty.txt', oldText: '', newText: '' } },
      batch: { id: 'batch-call', name: 'edit', args: { filePath: 'batch.txt', edits: [{ oldText: 'first', newText: 'second' }, { oldText: 'second', newText: 'third', replaceAll: true }] } },
      patch: { id: 'patch-call', name: 'edit', args: { apply_patch: '*** Begin Patch\\n*** Add File: added.txt\\n+patch-value\\n*** End Patch' } },
      malformed: { id: 'malformed-call', name: 'edit', args: { filePath: 'invalid.txt', edits: [null] } },
    }

    window.searchForCase = id => getToolCallSearchText(calls[id])
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
    response.end(`<!doctype html><html><body>${['deletion', 'insertion', 'replacement', 'empty', 'batch', 'patch', 'malformed'].map(id => `<div id="${id}"></div>`).join('')}<script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 7)
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

test('unified edit batch and patch cards render their file operations and searchable payloads', async () => {
  assert.match((await readCounts('batch')).text, /2 replacements.*batch.txt/)
  assert.match((await readCounts('patch')).text, /1 op.*added.txt/)
  await page.click('#batch .foxwarm-tool-card')
  const batch = await page.$eval('#batch .foxwarm-tool-call-args', element => element.textContent)
  assert.match(batch, /first/); assert.match(batch, /second/); assert.match(batch, /third/)
  assert.match(batch, /Replace all occurrences/)
  await page.click('#patch .foxwarm-tool-card')
  const patch = await page.$eval('#patch .foxwarm-tool-call-args', element => element.textContent)
  assert.match(patch, /Add added.txt/); assert.match(patch, /patch-value/)
  const search = await page.evaluate(() => ['batch', 'patch', 'malformed'].map(id => window.searchForCase(id)))
  assert.match(search[0], /batch.txt/); assert.match(search[0], /third/)
  assert.match(search[1], /added.txt/); assert.match(search[1], /patch-value/)
  await page.click('#malformed .foxwarm-tool-card')
  assert.match(await page.$eval('#malformed .foxwarm-tool-call-args', element => element.textContent), /null/)
})
