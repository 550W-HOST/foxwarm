import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const componentPath = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const progressPath = new URL('../src/components/ToolScriptProgressContext.tsx', import.meta.url).pathname
let browser
let page
let server
let url

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup } from ${JSON.stringify(componentPath)}
    import { ToolScriptProgressContext } from ${JSON.stringify(progressPath)}
    const root = createRoot(document.getElementById('root'))
    window.renderCases = (cases, progress = {}) => {
      localStorage.setItem('script-activity-history', JSON.stringify(cases))
      root.render(React.createElement(ToolScriptProgressContext.Provider, { value: progress },
        cases.map(({ id, call, response }) => React.createElement('div', { id, key: id },
          React.createElement(InterleavedToolGroup, {
            msg: { role: 'model', parts: [{ functionCall: call }] },
            nextMsg: { role: 'tool', parts: response ? [{ functionResponse: response }] : [] },
            messageKeyPrefix: id,
          }))),
      ))
    }
    window.renderCases(JSON.parse(localStorage.getItem('script-activity-history') || '[]'))
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'script-activity-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', write: false, target: 'chrome120',
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
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

test('nested activity survives live completion and historical reload using display metadata and legacy results', async () => {
  await page.goto(url)
  await page.evaluate(() => {
    window.renderCases([{ id: 'current', call: { id: 'run-current', name: 'run_script', args: { code: 'def main(args): return 7' } } }], {
      'run-current': [{ id: 'tss_1', name: 'nested_probe', status: 'running', startedAt: 1, argsSummary: 'live target' }],
    })
  })
  await page.waitForFunction(() => document.querySelector('#current')?.textContent.includes('nested_probe'))
  assert.equal(await page.$$eval('#current .animate-pulse', elements => elements.length), 1)
  await page.click('#current .foxwarm-tool-header-toggle')
  await page.evaluate(() => {
    const subCalls = [{ id: 'tss_1', name: 'nested_probe', status: 'completed', startedAt: 1, completedAt: 4, durationMs: 3, argsSummary: 'persisted target' }]
    const response = (id, name, legacy = false) => ({
      tool_use_id: id, name,
      response: { status: 'completed', runId: 'tsr_fixture', result: { subCalls: ['author result'] }, ...(legacy ? { subCalls } : {}) },
      ...(!legacy ? { __meta: { toolScriptSubCalls: subCalls } } : {}),
    })
    window.renderCases([
      { id: 'current', call: { id: 'run-current', name: 'run_script', args: {} }, response: response('run-current', 'run_script') },
      { id: 'unified', call: { id: 'run-unified', name: 'call_tool', args: { toolId: 'builtin:continue_script', args: {} } }, response: response('run-unified', 'call_tool') },
      { id: 'legacy', call: { id: 'run-legacy', name: 'run_script', args: {} }, response: response('run-legacy', 'run_script', true) },
      { id: 'legacy-unified', call: { id: 'run-legacy-unified', name: 'call_tool', args: { source: 'builtin', name: 'run_script', args: {} } }, response: response('run-legacy-unified', 'call_tool', true) },
    ])
  })
  await page.waitForFunction(() => ['current', 'unified', 'legacy', 'legacy-unified'].every(id => document.getElementById(id)?.textContent.includes('nested_probe')))
  assert.equal(await page.$$eval('#current .animate-pulse', elements => elements.length), 0)
  assert.ok(await page.$eval('#current', element => element.textContent.includes('persisted target')))
  assert.ok(await page.$eval('#current', element => element.textContent.includes('author result')))
  await page.reload()
  await page.waitForFunction(() => ['current', 'unified', 'legacy', 'legacy-unified'].every(id => document.getElementById(id)?.textContent.includes('nested_probe')))
  for (const id of ['current', 'unified', 'legacy', 'legacy-unified']) {
    await page.click(`#${id} .foxwarm-tool-header-toggle`)
    await page.waitForFunction(id => document.getElementById(id)?.textContent.includes('persisted target'), {}, id)
    assert.ok(await page.$eval(`#${id}`, element => element.textContent.includes('author result')))
  }
})
