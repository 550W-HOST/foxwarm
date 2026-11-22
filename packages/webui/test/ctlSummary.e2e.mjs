import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

// A ctl call's own `summary` is shown like an exec purpose: in Conversation's fully collapsed
// header (falling back to the arguments), first in the expanded view, and in Search. Detailed
// headers keep the arguments. When the tool it runs states its own summary (Node exec), only that
// one is shown.
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const screenshotDir = process.env.FOXWARM_E2E_SCREENSHOT_DIR
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const mcpArgs = { repo: 'octo-org/demo', state: 'open', perPage: 5 }
const mcpCommand = 'tool call mcp:github/list_issues --args @args'
const execCommand = 'tool call node:worker/exec --args @args'
const fixtures = {
  mcp: { name: 'ctl', args: { command: mcpCommand, values: { args: mcpArgs } } },
  mcpSummary: { name: 'ctl', args: { command: mcpCommand, values: { args: mcpArgs }, summary: 'List open issues' } },
  builtin: { name: 'ctl', args: { command: 'skill load code-index' } },
  builtinSummary: { name: 'ctl', args: { command: 'skill load code-index', summary: 'Load the index skill' } },
  execBoth: { name: 'ctl', args: { command: execCommand, values: { args: { command: 'make', summary: 'Build the project' } }, summary: 'Run make on the worker' } },
  execCtlOnly: { name: 'ctl', args: { command: execCommand, values: { args: { command: 'make' } }, summary: 'Run make on the worker' } },
}
const modes = ['detailed', 'conversation']
const states = ['collapsed', 'expanded']
const ids = Object.keys(fixtures).flatMap(id => modes.flatMap(mode => states.map(state => `${id}-${mode}-${state}`)))
let browser
let server
let page

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup, getToolCallSearchText } from ${JSON.stringify(toolEntry)}
    const fixtures = ${JSON.stringify(fixtures)}
    window.searchText = id => getToolCallSearchText(fixtures[id])
    for (const [id, fixture] of Object.entries(fixtures)) {
      for (const mode of ${JSON.stringify(modes)}) {
        for (const state of ${JSON.stringify(states)}) {
          const key = id + '-' + mode + '-' + state
          const call = { id: key, ...fixture }
          const msg = { role: 'model', parts: [{ functionCall: call }], __meta: { seq: 1 } }
          const nextMsg = { role: 'tool', parts: [{ functionResponse: { tool_use_id: key, name: call.name, response: { output: 'done' } } }], __meta: { seq: 2 } }
          createRoot(document.getElementById(key)).render(React.createElement(InterleavedToolGroup, { msg, nextMsg, messageKeyPrefix: key, hideCollapsedContent: mode === 'conversation' }))
        }
      }
    }
  `
  const built = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'ctl-summary.tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
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
  await page.waitForSelector(`#${ids.at(-1)} .foxwarm-tool-card`)
  for (const id of ids.filter(id => id.endsWith('-expanded'))) await page.click(`#${id} .foxwarm-tool-card`)
  if (screenshotDir) {
    await new Promise(resolve => setTimeout(resolve, 600))
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: `${screenshotDir}/ctl-summary-cards.png`, fullPage: true })
  }
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const card = id => page.evaluate(root => {
  const element = document.getElementById(root)
  const argsView = element.querySelector('.foxwarm-tool-call-args')
  return {
    tag: element.querySelector('.foxwarm-tool-tag')?.textContent,
    preview: element.querySelector('.foxwarm-tool-call-summary')?.textContent?.replace(/\s+/g, ' ').trim(),
    summary: argsView?.querySelector('[data-ctl-summary]')?.textContent,
    command: argsView?.querySelector('[data-ctl-command]')?.textContent,
    body: argsView?.innerText,
  }
}, id)

test('Conversation headers show the ctl summary, falling back to the arguments', async () => {
  assert.equal((await card('mcpSummary-conversation-collapsed')).preview, 'List open issues')
  assert.equal((await card('mcp-conversation-collapsed')).preview, 'repo: octo-org/demo state: open perPage: 5')
  assert.equal((await card('builtinSummary-conversation-collapsed')).preview, 'Load the index skill')
  assert.equal((await card('builtin-conversation-collapsed')).preview, 'action: load skillName: code-index')
  assert.equal((await card('execCtlOnly-conversation-collapsed')).preview, 'Run make on the worker')
  assert.equal((await card('mcpSummary-conversation-collapsed')).tag, 'tool:mcp:github/list_issues')
})

test('Detailed headers keep the arguments, as exec keeps its command', async () => {
  for (const id of ['mcp', 'mcpSummary']) assert.equal((await card(`${id}-detailed-collapsed`)).preview, 'repo: octo-org/demo state: open perPage: 5', id)
  for (const id of ['builtin', 'builtinSummary']) assert.equal((await card(`${id}-detailed-collapsed`)).preview, 'action: load skillName: code-index', id)
  assert.equal((await card('execCtlOnly-detailed-collapsed')).preview, 'make')
})

test('the expanded view shows the summary, the command and the arguments', async () => {
  for (const mode of modes) {
    const shown = await card(`mcpSummary-${mode}-expanded`)
    assert.equal(shown.summary, 'List open issues', mode)
    assert.equal(shown.command, `ctl ${mcpCommand}`, mode)
    assert.equal(shown.body, `List open issues\nctl ${mcpCommand}\nrepo: octo-org/demo\nstate: open\nperPage: 5`, mode)
    const plain = await card(`mcp-${mode}-expanded`)
    assert.equal(plain.summary, undefined, mode)
    assert.equal(plain.body, `ctl ${mcpCommand}\nrepo: octo-org/demo\nstate: open\nperPage: 5`, mode)
  }
})

test('a ctl-run exec with both summaries shows only the exec summary', async () => {
  assert.equal((await card('execBoth-conversation-collapsed')).preview, 'Build the project')
  assert.equal((await card('execBoth-detailed-collapsed')).preview, 'make')
  for (const mode of modes) {
    const expanded = await card(`execBoth-${mode}-expanded`)
    assert.equal(expanded.summary, undefined, mode)
    assert.ok(expanded.body.includes('Build the project'), mode)
    assert.ok(!expanded.body.includes('Run make on the worker'), mode)
  }
  assert.ok(!(await page.evaluate(() => window.searchText('execBoth'))).includes('Run make on the worker'))
})

test('Search includes the summary before the command', async () => {
  const text = await page.evaluate(() => window.searchText('mcpSummary'))
  assert.ok(text.startsWith(`List open issues\u0000ctl ${mcpCommand}\u0000`), text)
  assert.ok(!(await page.evaluate(() => window.searchText('mcp'))).includes('List open issues'))
})

test('the JSON view keeps the stored summary', async () => {
  await page.click('#execBoth-detailed-collapsed button[title="JSON"]')
  await page.waitForSelector('[role="dialog"]')
  const text = await page.$eval('[role="dialog"]', element => element.textContent)
  assert.ok(text.includes('"summary": "Run make on the worker"'), text)
  assert.ok(text.includes('"summary": "Build the project"'), text)
})
