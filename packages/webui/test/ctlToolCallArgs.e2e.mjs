import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

// `ctl tool call` of an MCP tool shows the tool's arguments in the collapsed header and the
// expanded view exactly as a direct call of a tool with those arguments does, for bound
// (@args, valuesJson) and inline JSON arguments, and while the call streams.
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const screenshotDir = process.env.FOXWARM_E2E_SCREENSHOT_DIR
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
// Keys the activity summary does not pick, as most MCP tools have.
const args = { repo: 'octo-org/demo', state: 'open', perPage: 5, sort: { by: 'updated', labels: ['bug', 'ui'] } }
const command = 'tool call mcp:github/search_issues --args @args'
const fixtures = {
  direct: { call: { name: 'search_issues', args } },
  bound: { call: { name: 'ctl', args: { command, values: { args } } } },
  boundJson: { call: { name: 'ctl', args: { command, valuesJson: JSON.stringify({ args }) } } },
  inline: { call: { name: 'ctl', args: { command: `tool call mcp:github/search_issues --args '${JSON.stringify(args)}'` } } },
  // Streaming: the direct call's complete arguments, and a ctl call whose values are still arriving.
  directStreaming: { streaming: true, call: { name: 'search_issues', args: { repo: 'octo-org/demo' } } },
  ctlStreaming: { streaming: true, call: { name: 'ctl', args: `{"command":${JSON.stringify(command)},"values":{"args":{"repo":"octo-org/demo","perPage":5,"sort":{"labels":["bu` } },
  ctlStreamingParsed: { streaming: true, call: { name: 'ctl', args: { command, values: { args: { repo: 'octo-org/demo' } } } } },
}
const ids = Object.keys(fixtures).flatMap(id => [`${id}-collapsed`, `${id}-expanded`])
let browser
let server
let page

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup, getToolCallSearchText } from ${JSON.stringify(toolEntry)}
    const fixtures = ${JSON.stringify(fixtures)}
    window.searchText = id => getToolCallSearchText(fixtures[id].call)
    for (const [id, fixture] of Object.entries(fixtures)) {
      for (const state of ['collapsed', 'expanded']) {
        const key = id + '-' + state
        const call = { id: key, ...fixture.call }
        const msg = { role: 'model', parts: [{ functionCall: call }], __meta: fixture.streaming ? { streaming: true } : { seq: 1 } }
        const nextMsg = fixture.streaming ? { role: 'tool', parts: [] } : { role: 'tool', parts: [{ functionResponse: { tool_use_id: key, name: call.name, response: { output: '2 issues' } } }], __meta: { seq: 2 } }
        createRoot(document.getElementById(key)).render(React.createElement(InterleavedToolGroup, { msg, nextMsg, messageKeyPrefix: key }))
      }
    }
  `
  const built = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'ctl-tool-call-args.tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const bundle = built.outputFiles[0].text
  // The built stylesheet, when present, makes the screenshots readable; assertions don't need it.
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssAsset = (await readdir(assets).catch(() => [])).find(name => /^index-.*\.css$/.test(name))
  const css = cssAsset ? await readFile(new URL(cssAsset, assets), 'utf8') : ''
  server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(bundle)
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><main style="width:760px;padding:12px">${ids.map(id => `<div style="font:11px monospace;color:#888;margin-top:8px">${id}</div><div id="${id}"></div>`).join('')}</main><script src="/bundle.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  page = await browser.newPage()
  await page.setViewport({ width: 800, height: 1400 })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForSelector('#ctlStreamingParsed-expanded .foxwarm-tool-card')
  for (const id of Object.keys(fixtures)) await page.click(`#${id}-expanded .foxwarm-tool-card`)
  if (screenshotDir) {
    await new Promise(resolve => setTimeout(resolve, 600))
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: `${screenshotDir}/ctl-tool-call-args.png`, fullPage: true })
  }
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const card = id => page.evaluate(root => {
  const element = document.getElementById(root)
  const argsView = element.querySelector('.foxwarm-tool-call-args')
  const commandLine = argsView?.querySelector('[data-ctl-command]')
  return {
    tag: element.querySelector('.foxwarm-tool-tag')?.textContent,
    preview: element.querySelector('.foxwarm-tool-call-summary')?.textContent,
    title: element.querySelector('.foxwarm-tool-call-summary')?.getAttribute('title'),
    command: commandLine?.textContent,
    expanded: argsView ? argsView.innerText.slice(commandLine ? commandLine.innerText.length : 0).trim() : undefined,
  }
}, id)

test('the collapsed header of a ctl MCP call shows the tool arguments as a direct call does', async () => {
  const direct = await card('direct-collapsed')
  // The one-line layout breaks only between arguments; the header shows them on one line.
  assert.equal(direct.preview, 'repo: octo-org/demo\nstate: open\nperPage: 5\nsort: {by: updated, labels: [bug, ui]}')
  for (const id of ['bound', 'boundJson', 'inline']) {
    const ctl = await card(`${id}-collapsed`)
    assert.equal(ctl.preview, direct.preview, id)
    assert.equal(ctl.tag, 'tool:mcp:github/search_issues', id)
    assert.match(ctl.title, /^ctl tool call mcp:github\/search_issues --args /, id)
  }
})

test('the expanded view of a ctl MCP call shows the tool arguments below the command', async () => {
  const direct = await card('direct-expanded')
  assert.equal(direct.expanded, 'repo: octo-org/demo\nstate: open\nperPage: 5\nsort: {by: updated, labels: [bug, ui]}')
  for (const id of ['bound', 'boundJson', 'inline']) {
    const ctl = await card(`${id}-expanded`)
    assert.equal(ctl.expanded, direct.expanded, id)
    assert.match(ctl.command, /^ctl tool call mcp:github\/search_issues --args /, id)
  }
})

test('a streaming ctl MCP call shows the arguments received so far', async () => {
  const direct = await card('directStreaming-collapsed')
  assert.equal((await card('ctlStreamingParsed-collapsed')).preview, direct.preview)
  assert.equal((await card('ctlStreamingParsed-expanded')).expanded, (await card('directStreaming-expanded')).expanded)
  const partial = await card('ctlStreaming-collapsed')
  assert.equal(partial.preview, 'repo: octo-org/demo\nperPage: 5\nsort: {labels: [bu]}')
  assert.equal(partial.tag, 'tool:mcp:github/search_issues')
  assert.equal((await card('ctlStreaming-expanded')).expanded, 'repo: octo-org/demo\nperPage: 5\nsort: {labels: [bu]}')
})

test('Search matches the arguments shown, after the command', async () => {
  const direct = await page.evaluate(() => window.searchText('direct'))
  for (const id of ['bound', 'boundJson', 'inline']) {
    const text = await page.evaluate(key => window.searchText(key), id)
    assert.match(text, /^ctl tool call mcp:github\/search_issues --args /, id)
    assert.equal(text.slice(text.indexOf('\u0000') + 1), direct, id)
  }
})

test('the JSON view keeps the stored ctl call', async () => {
  await page.click('#bound-collapsed button[title="JSON"]')
  await page.waitForSelector('[role="dialog"]')
  const text = await page.$eval('[role="dialog"]', element => element.textContent)
  assert.ok(text.includes(`"command": "${command}"`), text)
  assert.ok(text.includes('"values": {'), text)
})
