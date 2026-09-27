import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const browserPath = process.env.FOXWARM_E2E_BROWSER || '/usr/bin/chromium'
const browserKind = browserPath.includes('firefox') ? 'firefox' : 'chrome'
const dist = new URL('../dist/', import.meta.url)
let browser
let server
let baseUrl

const tabs = {
  'chat:popup-test': { id: 'chat:popup-test', type: 'chat', sessionId: 'popup-test', title: 'Popup chat' },
  'terminal:term-1': { id: 'terminal:term-1', type: 'terminal', terminalId: 'term-1', nodeId: 'master', cwd: '/tmp', title: 'Terminal /tmp' },
  'vscode-web': { id: 'vscode-web', type: 'vscode', title: 'Code' },
  'system:agents': { id: 'system:agents', type: 'agents', title: 'Agents' },
  'system:setup': { id: 'system:setup', type: 'setup', title: 'Setup' },
}

async function serve(request, response) {
  const pathname = new URL(request.url, 'http://fixture').pathname
  const relative = pathname.startsWith('/prefix/ui/') ? pathname.slice('/prefix/ui/'.length) : ''
  const file = relative && !relative.endsWith('/') ? new URL(relative, dist) : new URL('index.html', dist)
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not file')
    const body = await readFile(file)
    const ext = path.extname(file.pathname)
    response.writeHead(200, { 'Content-Type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(await readFile(new URL('index.html', dist)))
  }
}

function installFixture(page) {
  return page.evaluateOnNewDocument((initialTabs) => {
    const paneId = 'pane-popup-e2e'
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({
      state: { version: 4, tabsById: initialTabs, root: { id: paneId, kind: 'pane', tabIds: Object.keys(initialTabs), activeTabId: 'chat:popup-test' }, focusedPaneId: paneId },
      version: 1,
    }))
    localStorage.setItem('composer_draft_v1_popup-test', JSON.stringify({ version: 1, segments: [{ type: 'text', text: 'saved popup draft' }] }))
    const response = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    window.__fetches = []
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      window.__fetches.push({ method: init.method || 'GET', path: url.pathname })
      if (url.pathname.endsWith('/api/setup/status')) return response({ oobe: false, models: { exists: true, rawYaml: 'providers: {}', providerCount: 1, defaultModel: 'test', hasPlaceholderSecrets: false, placeholderProviders: [] }, config: { rawYaml: 'channels: {}', channelsYaml: '', channelCount: 0 }, channels: [] })
      if (url.pathname.endsWith('/api/terminals')) return response({ terminals: [{ id: 'term-1', nodeId: 'master', cwd: '/tmp', shell: '/bin/sh', pid: 1, createdAt: 1, cols: 80, rows: 24 }] })
      if (url.pathname.includes('/api/terminals/term-1')) return response({ terminal: { id: 'term-1', nodeId: 'master', cwd: '/tmp', shell: '/bin/sh', pid: 1, createdAt: 1, cols: 80, rows: 24 } })
      if (url.pathname.endsWith('/api/nodes')) return response({ nodes: [] })
      if (url.pathname.endsWith('/api/agents')) return response({ agents: [] })
      if (url.pathname.endsWith('/api/webui/settings')) return response({ settings: { instanceName: '', tabIcon: '' } })
      if (url.pathname.endsWith('/api/models')) return response({ models: [] })
      if (url.pathname.endsWith('/api/commands')) return response({ commands: [] })
      if (url.pathname.includes('/api/session-list/')) return response({ sessions: [], results: [], rootIds: [], nextCursor: null, revision: 1, total: 0 })
      if (url.pathname.includes('/api/sessions/')) return response({ messages: [], queuedMessages: [], session: { id: 'popup-test', status: 'idle' }, latestSeq: 0, historyVersion: 1, guardedPrefixLength: 0 })
      return response({})
    }
    class FixtureWebSocket {
      static OPEN = 1
      readyState = 1
      onopen = null; onmessage = null; onclose = null; onerror = null
      constructor() { queueMicrotask(() => this.onopen?.({})) }
      send() {}
      close() { this.readyState = 3; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
  }, tabs)
}

async function openFixture() {
  const page = await browser.newPage()
  await installFixture(page)
  await page.goto(`${baseUrl}/prefix/ui/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-tab-id="chat:popup-test"]')
  return page
}

async function chooseMove(page, tabId) {
  await page.keyboard.press('Escape')
  await page.evaluate((id) => {
    const tab = document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)
    if (!tab) throw new Error(`Missing tab ${id}`)
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  }, tabId)
  await page.waitForSelector('[role="menu"]')
  const result = await page.evaluate(() => {
    const button = [...document.querySelectorAll('[role="menu"] button')].find(item => item.textContent?.trim() === 'Move to new window')
    if (!(button instanceof HTMLButtonElement)) return 'missing'
    if (button.disabled) return 'disabled'
    button.click()
    return 'clicked'
  })
  return result
}

async function chooseMoveWithTrustedClick(page, tabId) {
  await page.evaluate((id) => {
    const tab = document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)
    if (!tab) throw new Error(`Missing tab ${id}`)
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  }, tabId)
  await page.waitForSelector('[role="menu"]')
  const buttons = await page.$$('[role="menu"] button')
  for (const button of buttons) {
    if ((await button.evaluate(element => element.textContent?.trim())) === 'Move to new window') {
      await button.click()
      return
    }
  }
  throw new Error('Move to new window menu item was not found')
}

before(async () => {
  server = createServer((request, response) => { void serve(request, response) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch(browserKind === 'firefox'
    ? { browser: 'firefox', executablePath: browserPath, headless: true }
    : { browser: 'chrome', executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('blocked popups and cancelled confirmations retain the original tab', async () => {
  const page = await openFixture()
  try {
    await page.evaluate(() => { window.__alerts = []; window.alert = value => window.__alerts.push(value); window.open = () => null })
    assert.equal(await chooseMove(page, 'chat:popup-test'), 'clicked')
    assert.ok(await page.$('[data-tab-id="chat:popup-test"]'))
    assert.match(await page.evaluate(() => window.__alerts[0]), /blocked/i)

    await page.evaluate(() => { window.__confirms = []; window.confirm = value => { window.__confirms.push(value); return false } })
    assert.equal(await chooseMove(page, 'system:setup'), 'clicked')
    assert.ok(await page.$('[data-tab-id="system:setup"]'))
    assert.match(await page.evaluate(() => window.__confirms[0]), /Unsaved changes will be lost/)
  } finally { await page.close() }
})

test('moves each supported tab to the expected URL and terminal move never deletes the PTY', async () => {
  const cases = [
    ['chat:popup-test', 'chat'],
    ['terminal:term-1', 'terminal'],
    ['system:setup', 'setup'],
    ['system:agents', 'agents'],
    ['vscode-web', 'code'],
  ]
  for (const [tabId, kind] of cases) {
    const page = await openFixture()
    try {
      await page.evaluate(() => {
        window.__opened = []
        window.open = value => { window.__opened.push(String(value)); return { opener: window } }
        window.confirm = () => true
      })
      assert.equal(await chooseMove(page, tabId), 'clicked')
      await new Promise(resolve => setTimeout(resolve, 150))
      const stillPresent = await page.$(`[data-tab-id=${JSON.stringify(tabId)}]`)
      assert.equal(!!stillPresent, false, `expected ${tabId} to be removed after opening ${kind}; opened=${await page.evaluate(() => window.__opened[0] || '')}`)
      const opened = new URL(await page.evaluate(() => window.__opened[0]))
      assert.equal(opened.pathname.startsWith('/prefix/ui/'), true)
      if (kind === 'code') assert.equal(opened.pathname, '/prefix/ui/vscode-web/')
      else assert.equal(opened.searchParams.get('foxwarmPopup'), kind)
      if (kind === 'terminal') {
        assert.equal(opened.searchParams.get('terminalId'), 'term-1')
        assert.equal(await page.evaluate(() => window.__fetches.some(item => item.method === 'DELETE' && item.path.includes('/terminals/'))), false)
      }
    } finally { await page.close() }
  }
})

test('popup Chat restores the existing draft and never rewrites normal workbench state', async () => {
  const page = await browser.newPage()
  await installFixture(page)
  try {
    await page.goto(`${baseUrl}/prefix/ui/?foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=popup-test&title=Popup`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('[data-foxwarm-popup-root="chat"]')
    assert.equal(await page.$('[data-pane-id]'), null)
    await page.waitForFunction(() => document.querySelector('.foxwarm-inline-composer-editor')?.textContent?.includes('saved popup draft'))
    const persisted = JSON.parse(await page.evaluate(() => localStorage.getItem('foxwarm_workbench_state_v4')))
    assert.deepEqual(Object.keys(persisted.state.tabsById).sort(), Object.keys(tabs).sort())
  } finally { await page.close() }
})

test('a real popup keeps working after its opener closes and after refresh', async () => {
  const opener = await openFixture()
  let popup
  try {
    await chooseMoveWithTrustedClick(opener, 'chat:popup-test')
    const deadline = Date.now() + 10_000
    while (!popup && Date.now() < deadline) {
      popup = (await browser.pages()).find(candidate => candidate !== opener && candidate.url().includes('foxwarmPopup=chat'))
      if (!popup) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(popup, 'expected a real popup page')
    await popup.waitForSelector('[data-foxwarm-popup-root="chat"]')
    await opener.close()
    await popup.waitForSelector('.foxwarm-inline-composer-editor')
    await popup.click('.foxwarm-inline-composer-editor')
    await popup.keyboard.type(' after opener close')
    await popup.waitForFunction(() => document.querySelector('.foxwarm-inline-composer-editor')?.textContent?.includes('after opener close'))
    await popup.reload({ waitUntil: 'domcontentloaded' })
    await popup.waitForFunction(() => document.querySelector('.foxwarm-inline-composer-editor')?.textContent?.includes('after opener close'))
  } finally {
    if (popup && !popup.isClosed()) await popup.close()
    if (!opener.isClosed()) await opener.close()
  }
})
