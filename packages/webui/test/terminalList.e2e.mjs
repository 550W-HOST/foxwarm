import { waitForWebUiReady } from './webuiReadiness.mjs'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

// Terminal tabs are views of the running-terminal registry: the sidebar lists every
// terminal, tab Close detaches, and only the explicit kill actions end a PTY.
const dist = new URL('../dist/', import.meta.url)
const browserPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const screenshotDir = process.env.FOXWARM_TERMINAL_LIST_SCREENSHOTS_DIR
let browser
let server
let baseUrl

async function serve(request, response) {
  const pathname = new URL(request.url, 'http://fixture').pathname
  const relative = pathname.startsWith('/prefix/ui/') ? pathname.slice('/prefix/ui/'.length) : ''
  const file = relative && !relative.endsWith('/') ? new URL(relative, dist) : new URL('index.html', dist)
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not file')
    const ext = path.extname(file.pathname)
    response.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'application/octet-stream' })
    response.end(await readFile(file))
  } catch {
    response.writeHead(404)
    response.end()
  }
}

before(async () => {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
  browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
  await browser.defaultBrowserContext().overridePermissions(new URL(baseUrl).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

const minutes = 60_000
const registry = () => [
  { id: 'term-alpha', nodeId: 'master', cwd: '/work/alpha', shell: '/bin/bash', pid: 101, createdAt: Date.now() - 5 * minutes, cols: 80, rows: 24 },
  { id: 'term-beta', nodeId: 'gpu-1', cwd: '/srv/projects/a-rather-long-directory-name/beta', shell: '/usr/bin/zsh', pid: 202, createdAt: Date.now() - 3 * 60 * minutes, cols: 80, rows: 24 },
]
const chatTab = { id: 'chat:e2e-a', type: 'chat', sessionId: 'e2e-a', title: 'e2e-a', preview: false }

async function openFixture({ tabs = [chatTab], activeTabId = 'chat:e2e-a', terminals = registry(), width = 1400, height = 900, mobile = false, platform = null, hostFrame = null } = {}) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height })
  await page.evaluateOnNewDocument(({ tabs, activeTabId, terminals, platform, hostFrame }) => {
    if (window !== window.top) return
    if (platform) Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => platform })
    if (hostFrame) window.foxwarmFrame = hostFrame
    if (!sessionStorage.getItem('terminal-list-fixture')) {
      sessionStorage.setItem('terminal-list-fixture', 'true')
      const tabsById = Object.fromEntries(tabs.map(tab => [tab.id, tab]))
      localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ state: { version: 4, tabsById, root: { id: 'pane-main', kind: 'pane', tabIds: tabs.map(tab => tab.id), activeTabId }, focusedPaneId: 'pane-main' }, version: 1 }))
      localStorage.setItem('foxwarm_last_active_tab_v1', activeTabId)
      localStorage.setItem('foxwarm_sidebar_collapsed_v1', 'false')
    }
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    window.__terminals = terminals
    window.__terminalDeletes = []
    window.__terminalCreates = []
    window.__terminalSockets = []
    window.__backlog = id => `BACKLOG-${id.toUpperCase()}\r\nCOPYWORD tail\r\n$ `
    const sessionFixture = id => ({ id, aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, lastMessageTime: 1, busy: false })
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
      const pathname = url.pathname
      const method = options.method || 'GET'
      if (pathname.endsWith('/api/auth/session')) return json({ role: 'admin' })
      if (pathname.endsWith('/api/setup/status')) return json({ oobe: false, models: { exists: true, hasPlaceholderSecrets: false }, channels: [], capabilities: { historySearch: { available: true } } })
      if (pathname.endsWith('/api/terminals') && method === 'POST') {
        const request = JSON.parse(options.body)
        window.__terminalCreates.push(request)
        const terminal = { id: `term-new-${window.__terminalCreates.length}`, nodeId: request.nodeId, cwd: request.cwd, shell: '/bin/sh', pid: 900 + window.__terminalCreates.length, createdAt: Date.now(), cols: request.cols, rows: request.rows }
        window.__terminals.unshift(terminal)
        return json({ terminal })
      }
      if (pathname.includes('/api/terminals/')) {
        const id = decodeURIComponent(pathname.split('/').at(-1))
        const terminal = window.__terminals.find(row => row.id === id)
        if (method === 'DELETE') {
          window.__terminalDeletes.push(id)
          window.__terminals = window.__terminals.filter(row => row.id !== id)
          for (const socket of window.__terminalSockets) if (socket.terminalId === id && socket.readyState === 1) socket.emit({ type: 'exit', exitCode: 129, signal: 1 })
          return terminal ? json({ success: true, closed: true }) : json({ error: 'Terminal not found.' }, 404)
        }
        return terminal ? json({ terminal }) : json({ error: 'Terminal not found.' }, 404)
      }
      if (pathname.endsWith('/api/terminals')) return json({ terminals: window.__terminals, supported: true, owner: 'master' })
      if (pathname.endsWith('/api/nodes')) return json({ nodes: [] })
      if (pathname.endsWith('/api/session-list/sidebar')) return json({ version: 1, revision: 'r1', sessions: [sessionFixture('e2e-a')], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} })
      if (pathname.includes('/api/session-list/')) return json({ sessions: [], results: [] })
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/history')) return json({ messages: [], queuedMessages: [], queueLength: 0, session: { id: 'e2e-a', messageCount: 0, historyVersion: 1 } })
      if (pathname.endsWith('/api/agents')) return json({ agents: [] })
      if (pathname.endsWith('/api/tasks')) return json({ tasks: [], total: 0, omitted: 0 })
      if (pathname.endsWith('/api/models')) return json({ models: [] })
      if (pathname.endsWith('/api/commands')) return json({ commands: [] })
      return json({})
    }
    class FixtureWebSocket {
      static OPEN = 1
      readyState = 1
      onopen = null; onmessage = null; onclose = null; onerror = null
      constructor(url) {
        this.url = String(url)
        this.sent = []
        const parsed = new URL(url)
        if (!parsed.pathname.endsWith('/terminals/stream')) return
        this.terminalId = parsed.searchParams.get('terminalId')
        window.__terminalSockets.push(this)
        queueMicrotask(() => {
          this.onopen?.({})
          const terminal = window.__terminals.find(row => row.id === this.terminalId)
          if (terminal) this.emit({ type: 'ready', terminal, backlog: window.__backlog(this.terminalId) })
        })
      }
      emit(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
      send(raw) { this.sent.push(JSON.parse(raw)) }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
    window.__inputs = id => window.__terminalSockets.filter(socket => !id || socket.terminalId === id).flatMap(socket => socket.sent.filter(message => message.type === 'input').map(message => message.data)).join('')
  }, { tabs, activeTabId, terminals, platform, hostFrame })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.foxwarmTest, { timeout: 10_000 }).catch(error => {
    throw new Error(`${error.message}; page errors: ${pageErrors.join(' | ')}`)
  })
  await waitForWebUiReady(page)
  return page
}

const terminalTabs = page => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).filter(tab => tab.type === 'terminal'))
const screenText = page => page.$eval('.xterm-rows', element => element.textContent)

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function openTerminalMenu(page) {
  await page.click('[data-sidebar-nav="terminal"] button[aria-label="Terminals"]')
  await page.waitForSelector('[data-terminal-list] [data-terminal-row]', { visible: true })
}

async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
}

test('running terminals are listed without creating tabs; tab Close detaches and reopening reattaches the backlog', async () => {
  const page = await openFixture()
  try {
    assert.deepEqual(await terminalTabs(page), [], 'a running terminal no longer gets a tab automatically')
    await openTerminalMenu(page)
    const rows = await page.$$eval('[data-terminal-row]', rows => rows.map(row => ({ id: row.dataset.terminalRow, text: row.textContent })))
    assert.deepEqual(rows.map(row => row.id), ['term-alpha', 'term-beta'])
    assert.match(rows[0].text, /\/work\/alpha.*master · pid 101 · bash · 5m/)
    assert.match(rows[1].text, /gpu-1 · pid 202 · zsh · 3h/)
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/terminal-list-desktop.png`, clip: { x: 0, y: 0, width: 520, height: 640 }, captureBeyondViewport: false })

    await page.click('[data-terminal-row="term-alpha"] button:not([aria-label])')
    await waitReady(page)
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('BACKLOG-TERM-ALPHA'))
    let tabs = await terminalTabs(page)
    assert.deepEqual(tabs.map(tab => tab.terminalId), ['term-alpha'])
    const tabId = tabs[0].id

    await openTerminalMenu(page)
    assert.match(await page.$eval('[data-terminal-row="term-alpha"]', row => row.textContent), /Open/)
    assert.doesNotMatch(await page.$eval('[data-terminal-row="term-beta"]', row => row.textContent), /Open/)
    await page.click('[data-terminal-row="term-alpha"] button:not([aria-label])')
    assert.equal((await terminalTabs(page)).length, 1, 'opening an open terminal focuses its tab')
    assert.equal(await page.evaluate(() => window.__terminalSockets.length), 1)

    await page.click(`[data-workbench-tab-close="${tabId}"], [data-tab-id="${tabId}"] button[title="Close tab"]`)
    await page.waitForFunction(id => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById[id], {}, tabId)
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), [], 'Close detaches without killing')
    assert.ok(await page.evaluate(() => window.__terminals.some(row => row.id === 'term-alpha')))
    assert.equal(await page.evaluate(() => window.__terminalSockets[0].readyState), 3, 'the closed view released its stream')

    await openTerminalMenu(page)
    assert.doesNotMatch(await page.$eval('[data-terminal-row="term-alpha"]', row => row.textContent), /Open/)
    await page.click('[data-terminal-row="term-alpha"] button:not([aria-label])')
    await waitReady(page)
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('BACKLOG-TERM-ALPHA'))
    assert.deepEqual((await terminalTabs(page)).map(tab => tab.terminalId), ['term-alpha'])
    assert.deepEqual(await page.evaluate(() => window.__terminalSockets.map(socket => socket.terminalId)), ['term-alpha', 'term-alpha'])
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [])
  } finally { await page.close() }
})

test('kill from the list and from the terminal header asks first', async () => {
  const page = await openFixture()
  const dialogs = []
  let accept = false
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()) })
  try {
    await openTerminalMenu(page)
    await page.click('[data-terminal-row="term-beta"] button[aria-label="Kill terminal"]')
    await until(() => dialogs.length === 1)
    assert.equal(dialogs.at(-1), 'Kill the terminal in /srv/projects/a-rather-long-directory-name/beta on gpu-1? Programs running in it will stop.')
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), [], 'a dismissed confirmation keeps the terminal')
    accept = true
    await page.click('[data-terminal-row="term-beta"] button[aria-label="Kill terminal"]')
    await page.waitForFunction(() => window.__terminalDeletes.includes('term-beta'))
    await page.waitForFunction(() => !document.querySelector('[data-terminal-row="term-beta"]'))
    assert.ok(await page.$('[data-terminal-row="term-alpha"]'), 'the list stays open after killing a row')

    await page.click('[data-terminal-row="term-alpha"] button:not([aria-label])')
    await waitReady(page)
    accept = false
    await page.click('[data-terminal-kill]')
    await until(() => dialogs.length === 3)
    assert.match(dialogs.at(-1), /^Kill the terminal in \/work\/alpha on master\?/)
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), ['term-beta'])
    accept = true
    await page.click('[data-terminal-kill]')
    await page.waitForFunction(() => window.__terminalDeletes.includes('term-alpha'))
    await page.waitForFunction(() => !Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).some(tab => tab.type === 'terminal'))
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [])
  } finally { await page.close() }
})

test('an ended terminal stays visible in its tab; a normal shell exit closes the tab', async () => {
  const gone = { id: 'terminal:term-gone', type: 'terminal', terminalId: 'term-gone', nodeId: 'master', cwd: '/work/gone', title: 'gone' }
  const page = await openFixture({ tabs: [chatTab, gone], activeTabId: gone.id })
  try {
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status closed'))
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('[terminal is no longer running]'))
    assert.deepEqual((await terminalTabs(page)).map(tab => tab.id), [gone.id], 'the tab does not vanish')
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [], 'a view never silently replaces an ended terminal')
    assert.equal(await page.$('[data-terminal-kill]'), null)

    await page.click('[data-terminal-new]')
    await waitReady(page)
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates.map(({ nodeId, cwd }) => ({ nodeId, cwd }))), [{ nodeId: 'master', cwd: '/work/gone' }])
    assert.equal((await terminalTabs(page))[0].terminalId, 'term-new-1')

    await page.evaluate(() => window.__terminalSockets.at(-1).emit({ type: 'exit', exitCode: 2 }))
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('[terminal exited: code=2]'))
    assert.equal((await terminalTabs(page)).length, 1, 'an abnormal exit stays visible with its code')

    await page.click('[data-terminal-new]')
    await waitReady(page)
    await page.evaluate(() => window.__terminalSockets.at(-1).emit({ type: 'exit', exitCode: 0 }))
    await page.waitForFunction(() => !Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).some(tab => tab.type === 'terminal'))
  } finally { await page.close() }
})

async function openAlpha(options) {
  const tab = { id: 'terminal:term-alpha', type: 'terminal', terminalId: 'term-alpha', nodeId: 'master', cwd: '/work/alpha', title: 'alpha' }
  const page = await openFixture({ tabs: [chatTab, tab], activeTabId: tab.id, ...options })
  await waitReady(page)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('COPYWORD'))
  return page
}

async function chord(page, ...keys) {
  for (const key of keys) await page.keyboard.down(key)
  for (const key of keys.reverse()) await page.keyboard.up(key)
}

async function selectCopyWord(page) {
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find(element => element.textContent.includes('COPYWORD'))
    const rect = row.getBoundingClientRect()
    return { x: rect.x, y: rect.y, height: rect.height }
  })
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { clickCount: 2 })
}

test('copy and paste shortcuts off macOS; ^C, ^W and Ctrl+Backspace reach the shell', async () => {
  const page = await openAlpha({ platform: 'Linux x86_64' })
  try {
    await page.click('.xterm-screen')
    await page.evaluate(() => navigator.clipboard.writeText('PASTED-TEXT'))
    await chord(page, 'Control', 'Shift', 'KeyV')
    await page.waitForFunction(() => window.__inputs('term-alpha').includes('PASTED-TEXT'))

    await selectCopyWord(page)
    await chord(page, 'Control', 'KeyC')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'COPYWORD')
    assert.ok(!(await page.evaluate(() => window.__inputs('term-alpha'))).includes('\x03'), 'Ctrl+C with a selection copies instead of sending ^C')
    await chord(page, 'Control', 'KeyC')
    await page.waitForFunction(() => window.__inputs('term-alpha').includes('\x03'), {}, 'without a selection Ctrl+C sends ^C')

    await page.evaluate(() => navigator.clipboard.writeText(''))
    await selectCopyWord(page)
    await chord(page, 'Control', 'Shift', 'KeyC')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'COPYWORD')

    await chord(page, 'Control', 'Backspace')
    await chord(page, 'Control', 'KeyW')
    await page.waitForFunction(() => window.__inputs('term-alpha').split('\x17').length === 3)
  } finally { await page.close() }
})

const beforeUnloadPrevented = page => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
})

test('a focused attached terminal asks before the page unloads, only off macOS and outside Desktop', async () => {
  const page = await openAlpha({ platform: 'Win32' })
  try {
    assert.equal(await beforeUnloadPrevented(page), false, 'no guard before the terminal has focus')
    await page.click('.xterm-screen')
    assert.equal(await beforeUnloadPrevented(page), true)
    const dialog = new Promise(resolve => page.once('dialog', async item => { resolve(item.type()); await item.dismiss() }))
    void page.reload().catch(() => {})
    assert.equal(await dialog, 'beforeunload', 'Ctrl+W, close and reload ask first')
    await page.click('[data-sidebar-nav="system"] button')
    assert.equal(await beforeUnloadPrevented(page), false, 'no guard once focus leaves the terminal')
  } finally { await page.close() }

  for (const options of [{ platform: 'MacIntel' }, { platform: 'Win32', hostFrame: { platform: 'windows', left: 0, right: 138, top: 32 } }]) {
    const unguarded = await openAlpha(options)
    try {
      await unguarded.click('.xterm-screen')
      assert.equal(await unguarded.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true)
      assert.equal(await beforeUnloadPrevented(unguarded), false, JSON.stringify(options))
    } finally { await unguarded.close() }
  }
})

test('the mobile terminal tool lists running terminals with touch-sized controls', async () => {
  const page = await openFixture({ mobile: true, activeTabId: 'chat:e2e-a', tabs: [chatTab] })
  try {
    await page.evaluate(() => { location.hash = '' })
    await page.waitForSelector('button[aria-label="Workspace tools"]', { visible: true })
    await page.click('button[aria-label="Workspace tools"]')
    await page.waitForSelector('[role="menuitem"]', { visible: true })
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === 'Terminal').click())
    await page.waitForSelector('dialog [data-terminal-list] [data-terminal-row]', { visible: true })
    const sizes = await page.$$eval('dialog [data-terminal-row="term-alpha"] button', buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { width: box.width, height: box.height } }))
    assert.ok(sizes.every(size => size.height >= 44), JSON.stringify(sizes))
    assert.ok(sizes[1].width >= 44, 'the kill control is a full touch target')
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/terminal-list-mobile.png`, captureBeyondViewport: false })
    await page.click('dialog [data-terminal-row="term-beta"] button:not([aria-label])')
    await waitReady(page)
    assert.equal(await page.$('dialog[open]'), null)
    assert.deepEqual((await terminalTabs(page)).map(tab => tab.terminalId), ['term-beta'])
  } finally { await page.close() }
})
