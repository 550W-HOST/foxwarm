import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

// Real Chat with scripted history: reply file links resolve against the Node and cwd recorded by
// the most recent preceding tool call, and share the Code link handler with expanded tool paths.
const webui = new URL('..', import.meta.url).pathname
let browser, page, server, fixtureUrl
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build packages/webui before running the Code file link browser test')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from './src/components/Chat'
    import { initializeThemeRuntime, setThemeSelection } from './src/theme'
    initializeThemeRuntime()
    setThemeSelection({ themeId: 'foxwarm.default', colorMode: 'light' })
    let seq = 0
    const row = (role, parts) => ({ role, parts, __meta: { seq: ++seq, timestamp: 1700000000000 + seq * 1000 } })
    const text = value => row('model', [{ text: value }])
    const call = (id, name, args, meta) => [
      row('model', [{ functionCall: { id, name, args } }]),
      row('tool', [{ functionResponse: { tool_use_id: id, name, response: { output: 'ok' }, __meta: meta } }]),
    ]
    const messages = [
      row('user', [{ text: 'Look around.' }]),
      text('Before any tool: [early](src/early.ts) and [absolute](/etc/early.conf).'),
      ...call('cd', 'exec', { command: 'cd repo', summary: 'Enter the repository' }, {
        target: { source: 'node', name: 'exec', node: 'dev/box' },
        exec: { nodeId: 'dev/box', cwd: '/work', finalCwd: '/work/repo' },
        placementAfter: { node: 'dev/box', cwd: '/work/repo' },
      }),
      text('See [the app](src/app.ts#L12), [config](/etc/app.conf:3), [packages](packages/), [docs](https://example.com/docs) and [home](~/notes.md) here.'),
      ...call('other', 'read', { filePath: '/srv/other/readme.md' }, {
        target: { source: 'node', name: 'read', node: 'other-node' },
        resolvedPaths: [{ raw: '/srv/other/readme.md', resolved: '/srv/other/readme.md', nodeId: 'other-node' }],
        placementAfter: { node: 'dev/box', cwd: '/work/repo' },
      }),
      text('Reference answer: [relative](src/b.ts) and [absolute](/srv/other/b.ts).'),
    ]
    const session = () => ({ id: 'fixture/links', busy: false, runtimeState: { state: 'idle', busy: false, queueLength: 0 }, queueLength: 0, messageCount: messages.length, historyVersion: 1, currentNode: 'master', cwd: '/elsewhere' })
    window.fetch = async (input) => {
      const url = String(input)
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
        this.emit({ type: 'subscriptions-accepted', revision: payload.revision, sessionListResolutions: {}, sessionResolutions: { 'fixture/links': 'fixture/links' } })
        this.emit({ type: 'subscriptions-applied', revision: payload.revision })
      }) }
    }
    window.WebSocket = Socket
    window.opened = []
    createRoot(document.getElementById('root')).render(<Chat historyMode="active" sessionId="fixture/links" canonicalSessionId="fixture/links" sessionDisplayName="Links" timelineView={new URLSearchParams(location.search).get('view') || 'detailed'}
      onOpenCodeFile={(filePath, lines, target) => window.opened.push({ filePath, lines, target })} />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'chat-code-file-links-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss() })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

const dialogs = []

async function mount(viewport = { width: 1000, height: 900 }, view = 'detailed') {
  await page.setViewport(viewport)
  await page.goto(`${fixtureUrl}/?view=${view}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Reference answer'))
  await wait(150)
  dialogs.length = 0
}
const screenshot = async name => {
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/${name}.png` })
}
const replyLinks = () => page.$$eval('.foxwarm-assistant-message-card a', anchors => anchors.map(anchor => ({
  text: anchor.textContent, code: anchor.classList.contains('foxwarm-code-link'), href: anchor.getAttribute('href'),
})))
const linkSelector = label => `.foxwarm-assistant-message-card a.foxwarm-code-link[data-code-label="${label}"]`

test('reply file links resolve against the preceding call’s Node and cwd; others keep their behavior', async () => {
  await mount()
  const links = await replyLinks()
  // Before any tool, and when a relative path has no cwd for the call's Node, links are plain text.
  assert.deepEqual(links.map(({ text, code }) => [text, code]), [
    ['the app', true], ['config', true], ['packages', true], ['docs', false], ['absolute', true],
  ])
  const text = await page.$eval('[data-chat-timeline="committed"]', element => element.textContent)
  for (const plain of ['Before any tool: early and absolute.', 'and home here.', 'Reference answer: relative and']) assert.ok(text.includes(plain), plain)
  const app = new URL(links[0].href)
  assert.equal(app.pathname, '/vscode-web/')
  assert.equal(app.searchParams.get('openFilePath'), '/work/repo/src/app.ts')
  assert.equal(app.searchParams.get('openFileNodeId'), 'dev/box')
  assert.equal(app.searchParams.get('startLine'), '12')

  for (const label of ['src/app.ts#L12', '/etc/app.conf:3', 'packages/', '/srv/other/b.ts']) await page.click(linkSelector(label))
  assert.deepEqual(await page.evaluate(() => window.opened), [
    { filePath: 'src/app.ts#L12', lines: { startLine: 12 }, target: { nodeId: 'dev/box', resolvedPath: '/work/repo/src/app.ts' } },
    { filePath: '/etc/app.conf:3', lines: { startLine: 3 }, target: { nodeId: 'dev/box', resolvedPath: '/etc/app.conf' } },
    { filePath: 'packages/', target: { nodeId: 'dev/box', resolvedPath: '/work/repo/packages' } },
    { filePath: '/srv/other/b.ts', target: { nodeId: 'other-node', resolvedPath: '/srv/other/b.ts' } },
  ])
  assert.deepEqual(dialogs, [])
  // External links keep their confirmation and never reach Code.
  await page.click('.foxwarm-assistant-message-card a[href^="https://example.com"]')
  await wait(50)
  assert.equal(dialogs.length, 1)
  assert.equal(await page.evaluate(() => window.opened.length), 4)
  await screenshot('reply-code-links')
})

test('expanded file-tool paths use the same Code link; collapsed headers keep plain paths', async () => {
  await mount()
  const card = '.foxwarm-tool-card:has([data-tool-header-tone]) '
  const readCard = await page.$$eval('.foxwarm-tool-card', cards => cards.findIndex(card => card.textContent.includes('/srv/other/readme.md')))
  assert.ok(readCard >= 0, card)
  const inRead = selector => page.evaluateHandle((index, selector) => document.querySelectorAll('.foxwarm-tool-card')[index].querySelector(selector), readCard, selector)
  assert.equal(await (await inRead('a.foxwarm-code-link')).jsonValue(), null, 'collapsed header path is plain')
  await (await inRead('.foxwarm-tool-code-path')).click()
  await page.waitForFunction(index => document.querySelectorAll('.foxwarm-tool-card')[index].querySelector('.foxwarm-tool-call-args a.foxwarm-code-link'), {}, readCard)
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-tool-card, [data-tool-group]')].every(node => !node.style.height));
  const before = await page.evaluate(() => window.opened.length)
  await (await inRead('.foxwarm-tool-call-args a.foxwarm-code-link')).click()
  const opened = await page.evaluate(() => window.opened)
  assert.equal(opened.length, before + 1)
  assert.deepEqual(opened.at(-1), { filePath: '/srv/other/readme.md', target: { nodeId: 'other-node', resolvedPath: '/srv/other/readme.md' } })
  assert.ok(await (await inRead('.foxwarm-tool-call-args')).jsonValue() !== null, 'the link click does not collapse the card')
  await page.mouse.move(1, 1)
  const styles = await page.evaluate(index => {
    const tool = document.querySelectorAll('.foxwarm-tool-card')[index].querySelector('a.foxwarm-code-link')
    const reply = document.querySelector('.foxwarm-assistant-message-card a.foxwarm-code-link')
    const pick = element => { const style = getComputedStyle(element); return [style.color, style.textDecorationLine, style.textDecorationStyle, style.cursor] }
    return [pick(tool), pick(reply)]
  }, readCard)
  assert.deepEqual(styles[0], styles[1])
})

test('mobile: tapping a reply file link opens Code; tapping the text around it does not', async () => {
  await mount({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.$eval(linkSelector('src/app.ts#L12'), element => element.scrollIntoView({ block: 'center' }))
  await wait(100)
  const box = await page.$eval(linkSelector('src/app.ts#L12'), element => {
    const rect = element.getBoundingClientRect()
    const paragraph = element.closest('p').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, left: paragraph.left + 4, line: rect.y + rect.height / 2 }
  })
  const scrollBefore = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
  await page.touchscreen.tap(box.left, box.line)
  await wait(100)
  assert.equal(await page.evaluate(() => window.opened.length), 0, 'text beside the link does not open Code')
  await page.touchscreen.tap(box.x, box.y)
  await wait(100)
  assert.deepEqual(await page.evaluate(() => window.opened), [
    { filePath: 'src/app.ts#L12', lines: { startLine: 12 }, target: { nodeId: 'dev/box', resolvedPath: '/work/repo/src/app.ts' } },
  ])
  assert.deepEqual(dialogs, [])
  assert.equal(await page.$eval('.foxwarm-chat-messages', element => element.scrollTop), scrollBefore)
  await screenshot('reply-code-links-mobile')
})
