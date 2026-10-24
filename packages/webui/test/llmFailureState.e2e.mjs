import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import { webuiReactAliases } from './reactRendererAliases.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, url
before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import ArchitectureView from './src/components/ArchitectureView'
      import { initializeThemeRuntime } from './src/theme'
      initializeThemeRuntime()
      const failed = { id: 'fixture/failed', agent: 'main', displayName: 'Failed foreground request', parentSessionId: null,
        messageCount: 2, busy: false, busyStartedAt: null, queueLength: 0,
        runtimeState: { state: 'llm-failed', busy: false, queueLength: 0 } }
      const summary = { total: 1, busy: 0, queued: 0, managed: 0, cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
      window.fetch = async (address, options = {}) => {
        const path = new URL(address, location.origin).pathname
        let payload = {}
        if (path.endsWith('/session-list/architecture')) payload = {
          revision: 'fixture', roots: { sessions: [failed], nextCursor: null, total: 1 }, children: [], summary, agentCounts: [{agent:'main',count:1}] }
        else if (path.endsWith('/session-list/by-id')) payload = {
          revision: 'fixture', results: [{id: failed.id, session: failed}], paths: {[failed.id]:[failed.id]} }
        else if (path.endsWith('/agents')) payload = {agents:[]}
        else if (path.endsWith('/nodes')) payload = {nodes:[]}
        else if (path.endsWith('/session-list/summary')) payload = summary
        return new Response(JSON.stringify(payload), {headers:{'Content-Type':'application/json'}})
      }
      window.WebSocket = class { static OPEN=1; static CONNECTING=0; readyState=0; send(){} close(){this.readyState=3} }
      createRoot(document.getElementById('root')).render(<ArchitectureView currentSession={failed.id} onSelectSession={() => {}} />)
    `, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'llm-failure-fixture.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    alias: webuiReactAliases, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

test('Architecture projects a settled failure without active duration or busy counts', async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.setViewport({ width: 1360, height: 1000 })
    await page.goto(url)
    await page.waitForSelector('[data-architecture-session-id="fixture/failed"]')
    const row = await page.$eval('[data-architecture-session-id="fixture/failed"]', element => ({
      text: element.textContent,
      danger: !!element.querySelector('.bg-fw-danger'),
      animations: element.getAnimations({subtree:true}).filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).length,
    }))
    assert.match(row.text, /Request failed/)
    assert.doesNotMatch(row.text, /\d+[smhd]|Running|Requesting model/)
    assert.equal(row.danger, true)
    assert.equal(row.animations, 0)
    await page.waitForFunction(() => document.querySelector('aside')?.textContent.includes('Request failed'))
    const inspector = await page.$eval('aside', element => element.textContent)
    assert.match(inspector, /Request failed/)
    assert.doesNotMatch(inspector, /for \d|Running|Requesting model/)
    const active = await page.evaluate(() => [...document.querySelectorAll('button')].find(element => element.textContent.startsWith('Active'))?.querySelector('.tabular-nums')?.textContent)
    assert.equal(active, '0')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
