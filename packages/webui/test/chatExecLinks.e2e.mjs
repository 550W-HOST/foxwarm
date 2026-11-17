import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

// Real Chat with a scripted Session: execId links between background receipts and completion
// events, and the running-commands control in the status row. Assertions check structure only.
const webui = new URL('..', import.meta.url).pathname
let browser, page, server, fixtureUrl
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build packages/webui before running the exec link browser test')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from './src/components/Chat'
    import { initializeThemeRuntime, setThemeSelection } from './src/theme'
    initializeThemeRuntime()
    setThemeSelection({ themeId: 'foxwarm.default', colorMode: 'dark' })
    let seq = 0
    const row = (role, parts) => ({ role, parts, __meta: { seq: ++seq, timestamp: 1700000000000 + seq * 1000 } })
    const exec = (id, command, output) => [
      row('model', [{ functionCall: { id, name: 'exec', args: { command, summary: 'Run ' + id } } }]),
      row('tool', [{ functionResponse: { tool_use_id: id, name: 'exec', response: { output } } }]),
    ]
    const footer = '\\n---\\nNode: \`master\`\\nLog file: /tmp/exec/fixture/output.log'
    const event = body => row('user', [{ system: '<foxwarm-system kind="event" type="background-process-finished">\\n' + body + '\\n</foxwarm-system>' }])
    const messages = [
      row('user', [{ text: 'Run the suite.' }]),
      ...exec('call-a', 'npm test', '[brave-fox] Still running after 15s, moved to background. Output so far:\\nRUNNING_SUITE' + footer),
      ...exec('call-old', 'make old', 'Partial Output:\\nlegacy line\\n---\\n[Process running longer than 15s] Switched to background.\\nexecId: old-heron'),
      ...exec('call-b', 'sleep 600', '[quiet-owl] Still running after 15s, moved to background. No output yet.' + footer),
      ...Array.from({ length: 14 }, (_, index) => row(index % 2 ? 'model' : 'user', [{ text: 'Filler ' + index + '\\n\\n' + 'Readable paragraph. '.repeat(30) }])),
      event('[brave-fox] Finished: exit code 0, 2m 4s\\nCommand: \`npm test\`\\nNode: \`master\`\\nSUITE_TAIL\\n---\\nLog file: /tmp/exec/fixture/output.log'),
      event('execId: old-heron\\ncommand: \`make old\`\\nExit code: 0'),
      row('model', [{ text: 'Reference answer' }]),
    ]
    let runtimeState = { state: 'idle', busy: false, queueLength: 0 }
    let execs = [{ execId: 'quiet-owl', nodeId: 'master', command: 'sleep 600', startedAt: Date.now() - 65000, elapsedMs: 65000, cwd: '/work', logPath: '/tmp/exec/q/output.log', stopRequested: false }]
    const session = () => ({ id: 'fixture/execs', busy: false, runtimeState, queueLength: 0, messageCount: messages.length, historyVersion: 1, runningExecs: execs.length })
    window.stopRequests = []
    window.fixtureStopOutcome = 'stopped'
    window.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/execs/')) {
        window.stopRequests.push(url)
        return Response.json({ outcome: window.fixtureStopOutcome })
      }
      if (url.endsWith('/execs')) return Response.json({ execs })
      return Response.json(url.includes('/history') ? { session: session(), messages, queuedMessages: [], queueLength: 0, historyVersion: 1 }
        : url.includes('/models') ? { models: [] }
        : url.includes('/asr/status') ? { configured: false, available: false } : {})
    }
    class Socket {
      static CLOSED = 3
      static current
      constructor() { Socket.current = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit({ type: 'connected' }) }) }
      close() { this.readyState = Socket.CLOSED }
      emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
      send(raw) { const payload = JSON.parse(raw); if (payload.type === 'set-subscriptions') queueMicrotask(() => {
        this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: { 'fixture/execs': 'fixture/execs' } })
        this.emit({ type: 'subscriptions-applied', revision: payload.revision })
      }) }
    }
    window.WebSocket = Socket
    window.fixture = {
      finishAll() { execs = []; Socket.current.emit({ type: 'session-state', session: session(), sessionId: 'fixture/execs' }) },
    }
    createRoot(document.getElementById('root')).render(<Chat historyMode="active" sessionId="fixture/execs" canonicalSessionId="fixture/execs" sessionDisplayName="Background commands" timelineView={new URLSearchParams(location.search).get('view') || 'detailed'} />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'chat-exec-links-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

async function mount(view = 'detailed') {
  await page.setViewport({ width: 1000, height: 760 })
  await page.goto(`${fixtureUrl}/?view=${view}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Reference answer'))
  await wait(150)
}
const screenshot = async name => {
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/${name}.png` })
}
const links = () => page.$$eval('[data-chat-timeline="committed"] [data-exec-link]', elements => elements.map(element => ({
  execId: element.dataset.execRef, role: element.dataset.execRole, text: element.textContent, title: element.title,
})))
const inView = (execId, role) => page.$eval(`[data-exec-link][data-exec-ref="${execId}"][data-exec-role="${role}"]`, element => {
  const box = element.getBoundingClientRect()
  const viewport = document.querySelector('.foxwarm-chat-messages').getBoundingClientRect()
  return { visible: box.top >= viewport.top && box.bottom <= viewport.bottom, flashing: element.classList.contains('fw-exec-link-flash') }
})

test('a leading execId in a receipt or completion event links to its counterpart; other text stays plain', async () => {
  await mount()
  const found = await links()
  assert.deepEqual(found.map(({ execId, role, text }) => [execId, role, text]).sort(), [
    ['brave-fox', 'completion', '[brave-fox]'],
    ['brave-fox', 'receipt', '[brave-fox]'],
    ['quiet-owl', 'receipt', '[quiet-owl]'],
  ])
  assert.equal(found.find(link => link.execId === 'quiet-owl').title, 'Not finished yet')
  // Earlier history without the header has no links.
  assert.equal(found.some(link => link.execId === 'old-heron'), false)

  await page.click('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="completion"]')
  await page.waitForFunction(() => document.querySelector('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="receipt"]')?.classList.contains('fw-exec-link-flash'))
  assert.deepEqual(await inView('brave-fox', 'receipt'), { visible: true, flashing: true })
  await screenshot('exec-link-receipt')
  await page.click('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="receipt"]')
  await page.waitForFunction(() => document.querySelector('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="completion"]')?.classList.contains('fw-exec-link-flash'))
  assert.equal((await inView('brave-fox', 'completion')).visible, true)

  // A missing counterpart does nothing visible, and a link click never toggles its card.
  await page.$eval('[data-exec-link][data-exec-ref="quiet-owl"]', element => element.scrollIntoView({ block: 'center' }))
  await wait(50)
  const before = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  const expanded = await page.$$eval('[aria-expanded="true"]', elements => elements.length)
  await page.click('[data-exec-link][data-exec-ref="quiet-owl"]')
  await wait(100)
  assert.equal(await page.$eval('.foxwarm-chat-messages', element => element.scrollTop), before)
  assert.equal(await page.$$eval('[aria-expanded="true"]', elements => elements.length), expanded)
})

test('in the grouped view a link reveals a counterpart inside a collapsed group', async () => {
  await mount('grouped')
  const completion = '[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="completion"]'
  if (!await page.$(completion)) {
    // The completion card can itself sit in a collapsed group; open it like a reader would.
    for (const button of await page.$$('[data-chat-timeline="committed"] button[aria-expanded="false"]')) {
      if (await page.$(completion)) break
      await button.click().catch(() => {})
      await wait(50)
    }
  }
  assert.ok(await page.$(completion), 'completion link is reachable')
  assert.equal(await page.$('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="receipt"]'), null, 'receipt starts hidden in its group')
  await page.click(completion)
  await page.waitForFunction(() => document.querySelector('[data-exec-link][data-exec-ref="brave-fox"][data-exec-role="receipt"]')?.classList.contains('fw-exec-link-flash'), { timeout: 3000 })
  assert.equal((await inView('brave-fox', 'receipt')).visible, true)
})

test('the status row lists running commands and stops one', async () => {
  await mount()
  const control = await page.waitForSelector('[data-running-commands-control] button')
  assert.equal(await control.evaluate(element => element.textContent), '1 running command')
  await control.click()
  await page.waitForSelector('[data-running-command="quiet-owl"]')
  assert.match(await page.$eval('[data-running-command="quiet-owl"]', element => element.textContent), /sleep 600/)
  await screenshot('running-commands')

  await page.evaluate(() => { window.fixtureStopOutcome = 'unsupported' })
  await page.click('[data-running-command-stop]')
  await page.waitForSelector('[data-running-command="quiet-owl"] [role="alert"]')
  assert.equal(await page.$eval('[data-running-command-stop]', element => element.disabled), false, 'a refused stop can be retried')

  await page.evaluate(() => { window.fixtureStopOutcome = 'stopped' })
  await page.click('[data-running-command-stop]')
  await page.waitForFunction(() => document.querySelector('[data-running-command-stop]')?.textContent === 'Stopping…')
  assert.deepEqual(await page.evaluate(() => window.stopRequests.map(url => new URL(url, location.href).pathname.replace(/^.*\/sessions\//, ''))), [
    'fixture%2Fexecs/execs/quiet-owl/stop', 'fixture%2Fexecs/execs/quiet-owl/stop',
  ])
  await page.evaluate(() => window.fixture.finishAll())
  await page.waitForFunction(() => !document.querySelector('[data-running-commands-control]'))
})
