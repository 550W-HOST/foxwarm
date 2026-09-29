import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const componentPath = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
let browser
let page
let server
let url

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup } from ${JSON.stringify(componentPath)}
    window.clicks = []
    window.renderCase = (id, call, response) => {
      const msg = { role: 'model', parts: [{ functionCall: call }] }
      const nextMsg = response ? { role: 'tool', parts: [{ functionResponse: response }] } : { role: 'tool', parts: [] }
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, {
        msg, nextMsg, messageKeyPrefix: id,
        onOpenCodeFile: (raw, lines, target) => window.clicks.push({ raw, lines, target }),
      }))
    }
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'resolved-path-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', write: false, target: 'chrome120',
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><body>${['read', 'relative', 'patch', 'historical'].map(id => `<div id="${id}"></div>`).join('')}<script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

test('Code icons use historical per-response Node and resolved path, preserve raw label and read lines', async () => {
  await page.goto(url)
  await page.evaluate(() => {
    window.renderCase('read', { id: 'read-a', name: 'read', args: { filePath: '~/file.txt', startLine: 2, endLine: 4 } },
      { tool_use_id: 'read-a', name: 'read', response: { output: 'ok' }, __meta: { resolvedPaths: [{ raw: '~/file.txt', resolved: '/home/owner/file.txt', nodeId: 'remote-a' }] } })
    window.renderCase('relative', { id: 'write-b', name: 'write', args: { filePath: './relative.txt', content: 'ok' } },
      { tool_use_id: 'write-b', name: 'write', response: { output: 'ok' }, __meta: { resolvedPaths: [{ raw: './relative.txt', resolved: '/earlier/cwd/relative.txt', nodeId: 'master' }] } })
    window.renderCase('patch', { id: 'patch-c', name: 'apply_patch', args: { input: '*** Begin Patch\n*** Add File: $fw_tmp/a.txt\n+a\n*** Delete File: $fw_tmp/removed.txt\n*** Add File: $fw_tmp/b.txt\n+b\n*** End Patch' } },
      { tool_use_id: 'patch-c', name: 'apply_patch', response: { output: 'ok' }, __meta: { resolvedPaths: [
        { raw: '$fw_tmp/a.txt', resolved: '/agent/tmp/a.txt', nodeId: 'remote-a' },
        { raw: '$fw_tmp/removed.txt', resolved: '/agent/tmp/removed.txt', nodeId: 'remote-a' },
        { raw: '$fw_tmp/b.txt', resolved: '/agent/tmp/b.txt', nodeId: 'remote-a' },
      ] } })
    window.renderCase('historical', { id: 'old-d', name: 'read', args: { filePath: '~/old.txt' } },
      { tool_use_id: 'old-d', name: 'read', response: { output: 'ok' } })
  })
  await page.waitForFunction(() => document.querySelectorAll('#read .foxwarm-tool-code-open, #relative .foxwarm-tool-code-open').length === 2)
  assert.equal(await page.$eval('#read .foxwarm-tool-code-path', element => element.textContent), '~/file.txt')
  assert.equal(await page.$$eval('#historical .foxwarm-tool-code-open', buttons => buttons.length), 0)
  await page.click('#read .foxwarm-tool-code-open')
  await page.click('#relative .foxwarm-tool-code-open')
  await page.click('#patch .foxwarm-tool-header-toggle')
  await page.waitForFunction(() => document.querySelectorAll('#patch .foxwarm-tool-code-open').length >= 2)
  await page.$$eval('#patch .foxwarm-tool-code-open', buttons => buttons[0].click())
  await page.$$eval('#patch .foxwarm-tool-code-open', buttons => buttons[buttons.length - 1].click())
  assert.deepEqual(await page.evaluate(() => window.clicks), [
    { raw: '~/file.txt', lines: { startLine: 2, endLine: 4 }, target: { resolvedPath: '/home/owner/file.txt', nodeId: 'remote-a' } },
    { raw: './relative.txt', target: { resolvedPath: '/earlier/cwd/relative.txt', nodeId: 'master' } },
    { raw: '$fw_tmp/a.txt', target: { resolvedPath: '/agent/tmp/a.txt', nodeId: 'remote-a' } },
    { raw: '$fw_tmp/b.txt', target: { resolvedPath: '/agent/tmp/b.txt', nodeId: 'remote-a' } },
  ])
})
