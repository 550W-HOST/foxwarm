import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
let browser
let page
let server
let fixtureUrl

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup } from ${JSON.stringify(toolEntry)}
    const cases = {
      incompleteRead: { name: 'read', args: {} },
      failedMalformedEdit: { name: 'edit', args: { command: 'npm run build', cwd: '/workspace', timeout: 30 } },
    }
    for (const [id, call] of Object.entries(cases)) {
      const response = id === 'failedMalformedEdit'
        ? { tool_use_id: id, name: 'edit', response: { error: 'invalid edit arguments' } }
        : undefined
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, {
        msg: { role: 'model', parts: [{ functionCall: { ...call, id } }] },
        nextMsg: response ? { role: 'tool', parts: [{ functionResponse: response }] } : { role: 'tool', parts: [] },
        onOpenCodeFile: () => { throw new Error('invalid Code navigation should not be offered') },
      }))
    }
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-missing-path-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><body><div id="incompleteRead"></div><div id="failedMalformedEdit"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

test('tool calls without a file path remain visible without offering invalid Code navigation', async () => {
  await page.goto(fixtureUrl)
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 2)
  for (const id of ['incompleteRead', 'failedMalformedEdit']) {
    assert.match(await page.$eval(`#${id}`, element => element.textContent || ''), /Path unavailable/)
    assert.equal(await page.$$eval(`#${id} .foxwarm-tool-code-open`, buttons => buttons.length), 0)
  }
})
