import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
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

for (const patchTool of ['apply_patch', 'edit']) test(`Expanded file paths open Code with the per-response Node and resolved path with ${patchTool}, preserve raw label and read lines`, async () => {
  await page.goto(url)
  await page.evaluate(patchTool => {
    window.renderCase('read', { id: 'read-a', name: 'read', args: { filePath: '~/file.txt', startLine: 2, endLine: 4 } },
      { tool_use_id: 'read-a', name: 'read', response: { output: 'ok' }, __meta: { resolvedPaths: [{ raw: '~/file.txt', resolved: '/home/owner/file.txt', nodeId: 'remote-a' }] } })
    window.renderCase('relative', { id: 'write-b', name: 'write', args: { filePath: './relative.txt', content: 'ok' } },
      { tool_use_id: 'write-b', name: 'write', response: { output: 'ok' }, __meta: { resolvedPaths: [{ raw: './relative.txt', resolved: '/earlier/cwd/relative.txt', nodeId: 'master' }] } })
    const patch = '*** Begin Patch\n*** Add File: $fw_tmp/a.txt\n+a\n*** Delete File: $fw_tmp/removed.txt\n*** Add File: $fw_tmp/b.txt\n+b\n*** End Patch'
    window.renderCase('patch', { id: 'patch-c', name: patchTool, args: patchTool === 'edit' ? { apply_patch: patch } : { input: patch } },
      { tool_use_id: 'patch-c', name: patchTool, response: { output: 'ok' }, __meta: { resolvedPaths: [
        { raw: '$fw_tmp/a.txt', resolved: '/agent/tmp/a.txt', nodeId: 'remote-a' },
        { raw: '$fw_tmp/removed.txt', resolved: '/agent/tmp/removed.txt', nodeId: 'remote-a' },
        { raw: '$fw_tmp/b.txt', resolved: '/agent/tmp/b.txt', nodeId: 'remote-a' },
      ] } })
    window.renderCase('historical', { id: 'old-d', name: 'read', args: { filePath: '~/old.txt' } },
      { tool_use_id: 'old-d', name: 'read', response: { output: 'ok' } })
  }, patchTool)
  // Collapsed headers keep plain paths; the whole collapsed surface expands the card.
  await page.waitForSelector('#read .foxwarm-tool-code-path')
  assert.equal(await page.$$eval('#read a.foxwarm-code-link, #relative a.foxwarm-code-link, #patch a.foxwarm-code-link', links => links.length), 0)
  assert.equal(await page.$eval('#read .foxwarm-tool-code-path', element => element.textContent), '~/file.txt')
  for (const id of ['read', 'relative', 'patch', 'historical']) {
    await page.click(`#${id} .foxwarm-tool-header-toggle`)
    await page.waitForSelector(`#${id} .foxwarm-tool-call-args`)
  }
  assert.equal(await page.$eval('#read .foxwarm-tool-call-args a.foxwarm-code-link', element => element.textContent), '~/file.txt')
  assert.equal(await page.$$eval('#historical a.foxwarm-code-link', links => links.length), 0)
  await page.click('#read .foxwarm-tool-call-args a.foxwarm-code-link')
  await page.click('#relative .foxwarm-tool-call-args a.foxwarm-code-link')
  assert.equal(await page.$$eval('#patch a.foxwarm-code-link', links => links.length), 2, 'deleted files stay plain')
  await page.$$eval('#patch a.foxwarm-code-link', links => links[0].click())
  await page.$$eval('#patch a.foxwarm-code-link', links => links[links.length - 1].click())
  for (const id of ['read', 'relative', 'patch']) assert.ok(await page.$(`#${id} .foxwarm-tool-call-args`), 'link clicks do not collapse the card')
  assert.deepEqual(await page.evaluate(() => window.clicks), [
    { raw: '~/file.txt', lines: { startLine: 2, endLine: 4 }, target: { nodeId: 'remote-a', resolvedPath: '/home/owner/file.txt' } },
    { raw: './relative.txt', target: { nodeId: 'master', resolvedPath: '/earlier/cwd/relative.txt' } },
    { raw: '$fw_tmp/a.txt', target: { nodeId: 'remote-a', resolvedPath: '/agent/tmp/a.txt' } },
    { raw: '$fw_tmp/b.txt', target: { nodeId: 'remote-a', resolvedPath: '/agent/tmp/b.txt' } },
  ])
})


test('Windows native resolved paths retain their real callback target and plain raw label', async () => {
  await page.goto(url)
  await page.evaluate(() => window.renderCase('read',
    { id: 'windows-read', name: 'read', args: { filePath: '$fw_agentdir/input.txt' } },
    { tool_use_id: 'windows-read', name: 'read', response: { output: 'ok' }, __meta: { resolvedPaths: [
      { raw: '$fw_agentdir/input.txt', resolved: 'W:\\work space\\input.txt', nodeId: 'master' },
    ] } }))
  await page.click('#read .foxwarm-tool-header-toggle')
  await page.waitForSelector('#read .foxwarm-tool-call-args a.foxwarm-code-link')
  assert.equal(await page.$eval('#read a.foxwarm-code-link', element => element.textContent), '$fw_agentdir/input.txt')
  const href = new URL(await page.$eval('#read a.foxwarm-code-link', element => element.href))
  assert.equal(href.searchParams.get('openFilePath'), '/W:/work space/input.txt')
  await page.click('#read a.foxwarm-code-link')
  assert.deepEqual(await page.evaluate(() => window.clicks), [
    { raw: '$fw_agentdir/input.txt', target: { nodeId: 'master', resolvedPath: 'W:\\work space\\input.txt' } },
  ])
})


test('pending cross-Node wrapper paths stay readable without borrowing native Code navigation', async () => {
  await page.goto(url)
  await page.evaluate(() => window.renderCase('read', {
    id: 'pending-remote-read', name: 'call_tool', args: {
      toolId: 'node:other-node/read', args: { filePath: '/workspace/input.txt' },
    },
  }))
  await page.waitForSelector('#read .foxwarm-tool-call-summary')
  assert.equal(await page.$eval('#read .foxwarm-tool-call-summary', element => element.textContent), '/workspace/input.txt')
  assert.equal(await page.$$eval('#read a.foxwarm-code-link', links => links.length), 0)
  await page.click('#read .foxwarm-tool-call-summary')
  await page.waitForSelector('#read .foxwarm-tool-call-args')
  assert.match(await page.$eval('#read .foxwarm-tool-call-args', element => element.textContent), /node:other-node\/read/)
  assert.equal(await page.$$eval('#read a.foxwarm-code-link', links => links.length), 0)
  assert.deepEqual(await page.evaluate(() => window.clicks), [])
})
