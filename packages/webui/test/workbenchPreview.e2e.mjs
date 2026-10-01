import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const dist = new URL('../dist/', import.meta.url)
const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
const browserPath = firefox ? (process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox') : (process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium')
let browser
let server
let baseUrl

const chat = (id, preview = true) => ({ id: `chat:${id}`, type: 'chat', sessionId: id, title: id, preview })
const system = { id: 'system:agents', type: 'agents', title: 'Agents' }

async function serve(request, response) {
  const pathname = new URL(request.url, 'http://fixture').pathname
  if (pathname === '/prefix/ui/vscode-web/') {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><html><body>Code fixture</body></html>')
    return
  }
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
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', executablePath: browserPath, headless: true, args: firefox ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
})
after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function openFixture({ tabs = [system, chat('e2e-a')], activeTabId = 'chat:e2e-a', hash = '', split = false, splitSecondChat = false, themeId, codeNewWindow, responsiveChat = false, terminal = null, width = 1400 } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 900 })
  await page.evaluateOnNewDocument(({ initialTabs, activeId, splitPanes, splitSecondChat, themeId, codeNewWindow, responsiveChat, terminal }) => {
    if (window !== window.top) return
    const tabsById = Object.fromEntries(initialTabs.map(tab => [tab.id, tab]))
    const root = splitPanes
      ? { id: 'split-main', kind: 'split', direction: 'row', sizes: [50, 50], children: [
        { id: 'pane-main', kind: 'pane', tabIds: splitSecondChat ? initialTabs.filter(tab => tab.id !== 'chat:e2e-b').map(tab => tab.id) : initialTabs.filter(tab => tab.id !== 'system:agents').map(tab => tab.id), activeTabId: activeId },
        { id: 'pane-other', kind: 'pane', tabIds: [splitSecondChat ? 'chat:e2e-b' : 'system:agents'], activeTabId: splitSecondChat ? 'chat:e2e-b' : 'system:agents' },
      ] }
      : { id: 'pane-main', kind: 'pane', tabIds: initialTabs.map(tab => tab.id), activeTabId: activeId }
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ state: { version: 4, tabsById, root, focusedPaneId: 'pane-main' }, version: 1 }))
    localStorage.setItem('foxwarm_last_active_tab_v1', activeId)
    localStorage.setItem('foxwarm_sidebar_collapsed_v1', 'false')
    if (themeId) localStorage.setItem('foxwarm_theme_selection_v2', JSON.stringify({ version: 2, themeId, colorMode: 'light' }))
    if (codeNewWindow !== undefined) localStorage.setItem('foxwarm_code_open_new_window_v1', String(codeNewWindow))
    const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    window.__sent = []
    window.__terminalDeletes = []
    window.__terminalCreates = []
    const terminalTemplate = terminal
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const pathname = url.pathname
      if (pathname.endsWith('/api/setup/status')) return json({ oobe: false, models: { exists: true, hasPlaceholderSecrets: false }, channels: [] })
      if (pathname.endsWith('/api/terminals') && options.method === 'POST' && terminalTemplate) {
        const request = JSON.parse(options.body)
        window.__terminalCreates.push(request)
        terminal = { ...terminalTemplate, ...request, id: 'term-reopened' }
        return json({ terminal })
      }
      if (pathname.includes('/api/terminals/') && options.method === 'DELETE') {
        window.__terminalDeletes.push(pathname)
        terminal = null
        return json({ ok: true })
      }
      if (pathname.includes('/api/terminals/') && terminal) return json({ terminal })
      if (pathname.endsWith('/api/terminals')) return json({ terminals: terminal ? [terminal] : [] })
      if (pathname.endsWith('/api/nodes')) return json({ nodes: [] })
      if (pathname.endsWith('/api/agents')) return json({ agents: [] })
      if (pathname.endsWith('/api/webui/settings')) return json({ settings: {} })
      if (pathname.endsWith('/api/models')) return json({ models: responsiveChat ? [{ key: 'fixture/model', label: 'Fixture model', contextLimit: 128000 }] : [] })
      if (pathname.endsWith('/api/commands')) return json({ commands: [] })
      if (pathname.endsWith('/api/session-list/sidebar')) return json({ version: 1, revision: 'r1', sessions: [sessionFixture('e2e-a'), sessionFixture('e2e-b'), sessionFixture('e2e-c')], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} })
      if (pathname.endsWith('/api/session-list/by-id')) return json({ results: JSON.parse(options.body).ids.filter(id => id === 'history-outside/main').map(requestedId => ({ requestedId, resolution: { kind: 'exact', sessionId: requestedId }, session: { ...sessionFixture(requestedId), displayName: 'Outside the sidebar' } })) })
      if (pathname.endsWith('/api/history/search')) return json({ results: ['history-outside/main', 'e2e-a'].map(sessionId => ({ key: sessionId, sessionId, kind: 'messages', firstSeq: 7, lastSeq: 7, hasEarlier: false, hasLater: false, messages: [{ role: 'user', parts: [{ text: 'Archived navigation fixture' }], __meta: { seq: 7, timestamp: 1700000000000 } }] })) })
      if (pathname.endsWith('/api/session-list/descendant-activity')) return json({ results: [] })
      if (pathname.includes('/api/session-list/')) return json({ sessions: [], results: [] })
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/message')) {
        window.__sent.push({ path: pathname, body: options.body })
        return json({ ok: true })
      }
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/history')) {
        const messages = responsiveChat ? Array.from({ length: 35 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: 'Responsive message ' + index + '\n\n' + 'Pane-local content wraps normally. '.repeat(8) }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } })) : []
        return json({ messages, queuedMessages: [], session: { id: decodeURIComponent(pathname.split('/').at(-2)), messageCount: messages.length, historyVersion: 1, ...(responsiveChat ? { modelKey: 'fixture/model', childModelDefault: 'fixture/model', childModelPolicySource: 'explicit' } : {}) }, latestSeq: messages.length, historyVersion: 1, historyComplete: true })
      }
      return json({})
    }
    function sessionFixture(id) { return { id, aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, lastMessageTime: 1, busy: false } }
    class FixtureWebSocket {
      static OPEN = 1
      readyState = 1
      onopen = null; onmessage = null; onclose = null; onerror = null
      constructor(url) { queueMicrotask(() => {
        this.onopen?.({})
        if (new URL(url).pathname.endsWith('/terminals/stream') && terminal) this.onmessage?.({ data: JSON.stringify({ type: 'ready', terminal, backlog: '' }) })
      }) }
      send(raw) {
        if (!responsiveChat) return
        const data = JSON.parse(raw)
        if (data.type === 'set-subscriptions') queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-accepted', revision: data.revision, sessionListResolutions: {}, sessionResolutions: Object.fromEntries(data.sessionIds.map(id => [id, id])) }) })
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-applied', revision: data.revision }) })
        })
      }
      close() { this.readyState = 3; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
  }, { initialTabs: tabs, activeId: activeTabId, splitPanes: split, splitSecondChat, themeId, codeNewWindow, responsiveChat, terminal })
  await page.goto(`${baseUrl}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.foxwarmTest)
  return page
}

async function state(page) {
  return page.evaluate(() => {
    const { state } = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4'))
    return { tabsById: state.tabsById, root: state.root, hash: decodeURIComponent(location.hash), active: state.root.kind === 'pane' ? state.root.activeTabId : state.root.children.map(pane => pane.activeTabId) }
  })
}

async function drag(page, from, to) {
  const source = await page.$(from)
  const target = await page.$(to)
  assert.ok(source && target, `expected drag source/target: ${from} -> ${to}`)
  const a = await source.boundingBox()
  const b = await target.boundingBox()
  assert.ok(a && b)
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 })
  await page.waitForSelector('[data-pane-id] > .pointer-events-none')
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}

test('preview ID follows Session; drafts and sending never Keep, direct links remain navigation', async () => {
  const page = await openFixture()
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.type('saved draft A')
    await page.waitForFunction(() => localStorage.getItem('composer_draft_v1_e2e-a')?.includes('saved draft A'))
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, true)

    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    assert.deepEqual((await state(page)).root.tabIds, ['system:agents', 'chat:e2e-b'])
    assert.equal((await state(page)).hash, '#tab/chat:e2e-b')
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.type('send B')
    await page.waitForFunction(() => localStorage.getItem('composer_draft_v1_e2e-b')?.includes('send B'))
    await page.click('[aria-label="Send message"]')
    await page.waitForFunction(() => window.__sent.length === 1 && !localStorage.getItem('composer_draft_v1_e2e-b'))
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, true)

    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-a'))
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent?.includes('saved draft A'))
    assert.deepEqual((await state(page)).root.tabIds, ['system:agents', 'chat:e2e-a'])
    await page.evaluate(() => { window.location.hash = 'session/e2e-c' })
    await page.waitForSelector('[data-tab-id="chat:e2e-c"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-c'].preview, true)
    await page.evaluate(() => { window.location.hash = 'tab/chat%3Ae2e-b' })
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, true)
    await page.goBack()
    await page.waitForSelector('[data-tab-id="chat:e2e-c"][title$="(preview)"]')
    await page.goForward()
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, true)
  } finally { await page.close() }
})

test('explicit tab and Sidebar Keep change only preview flag, not ID or route', async () => {
  const page = await openFixture()
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    await page.click('[data-tab-id="chat:e2e-a"]')
    await page.waitForFunction(() => decodeURIComponent(location.hash) === '#tab/chat:e2e-a')
    const beforeHash = (await state(page)).hash
    await page.click('[data-tab-id="chat:e2e-a"]', { clickCount: 2 })
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:e2e-a"]')?.title === 'e2e-a')
    assert.equal((await state(page)).hash, beforeHash)
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    await page.click('[data-tab-id="chat:e2e-b"]', { button: 'right' })
    await page.waitForSelector('[role="menu"]')
    await page.evaluate(() => [...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent?.trim() === 'Keep')?.click())
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:e2e-b"]')?.title === 'e2e-b')
    assert.deepEqual(Object.keys((await state(page)).tabsById).sort(), ['chat:e2e-a', 'chat:e2e-b', 'system:agents'])

    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-c'))
    await page.waitForSelector('[data-tab-id="chat:e2e-c"][title$="(preview)"]')
    await page.waitForSelector('[data-session-id="e2e-c"]')
    await page.click('[data-session-id="e2e-c"]', { clickCount: 2 })
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:e2e-c"]')?.title === 'e2e-c')
    assert.deepEqual(Object.keys((await state(page)).tabsById).sort(), ['chat:e2e-a', 'chat:e2e-b', 'chat:e2e-c', 'system:agents'])
    await page.evaluate(() => { window.location.hash = 'session/e2e-a' })
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:e2e-a"]')?.title === 'e2e-a')
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, false)
  } finally { await page.close() }
})

test('cancel and no-op drag preserve preview; real reorder and cross-pane drop Keep', async () => {
  const page = await openFixture({ tabs: [system, chat('e2e-a'), { id: 'system:setup', type: 'setup', title: 'Setup' }] })
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    const bounds = await (await page.$('[data-tab-id="chat:e2e-a"]')).boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2, { steps: 5 })
    await page.waitForSelector('[data-pane-id="pane-main"] .pointer-events-none')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, true, 'canceled active drag does not Keep')
    await new Promise(resolve => setTimeout(resolve, 650))
    await drag(page, '[data-tab-id="chat:e2e-a"]', '[data-tab-id="chat:e2e-a"]')
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, true, 'dropping on the original tab leaves its position unchanged')
    await new Promise(resolve => setTimeout(resolve, 650))
    await drag(page, '[data-tab-id="chat:e2e-a"]', '[data-tab-id="system:setup"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-a']?.preview === false)
    assert.deepEqual((await state(page)).root.tabIds, ['system:agents', 'system:setup', 'chat:e2e-a'], 'dropping on the immediate right neighbor uses existing reorderTabs semantics')
  } finally { await page.close() }

  const otherPage = await openFixture({ split: true })
  try {
    await otherPage.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    await drag(otherPage, '[data-workbench-tab-handle="chat:e2e-a"]', '[data-pane-id="pane-other"]')
    await otherPage.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-a']?.preview === false)
    assert.equal((await state(otherPage)).hash, '#tab/chat:e2e-a')
    assert.ok(await otherPage.$('[data-pane-id="pane-other"] [data-tab-id="chat:e2e-a"]'))
  } finally { await otherPage.close() }
})

test('Sidebar drag into a tab row Keeps the Session; docking a preview to a pane edge Keeps it', async () => {
  const sidebarPage = await openFixture()
  try {
    await sidebarPage.waitForSelector('[data-session-id="e2e-b"]')
    await drag(sidebarPage, '[data-session-id="e2e-b"]', '[data-tab-id="system:agents"]')
    await sidebarPage.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-b']?.preview === false)
    const snapshot = await state(sidebarPage)
    assert.equal(snapshot.tabsById['chat:e2e-a'].preview, true)
    assert.equal(snapshot.hash, '#tab/chat:e2e-b')
  } finally { await sidebarPage.close() }

  const dockPage = await openFixture({ split: true })
  try {
    await dockPage.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    const source = await (await dockPage.$('[data-workbench-tab-handle="chat:e2e-a"]')).boundingBox()
    const target = await (await dockPage.$('[data-pane-id="pane-other"]')).boundingBox()
    await dockPage.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await dockPage.mouse.down()
    await dockPage.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 4 })
    await dockPage.mouse.move(target.x + target.width - 4, target.y + target.height / 2, { steps: 20 })
    await new Promise(resolve => setTimeout(resolve, 120))
    await dockPage.mouse.up()
    await dockPage.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-a']?.preview === false)
    const snapshot = await state(dockPage)
    assert.equal(snapshot.hash, '#tab/chat:e2e-a')
    assert.equal(snapshot.root.kind, 'split')
    assert.ok(await dockPage.$('[data-workbench-tab-handle="chat:e2e-a"]'))
  } finally { await dockPage.close() }
})

test('direct Chat link opens a preview; close does not rehydrate until explicit navigation', async () => {
  const page = await openFixture({ activeTabId: 'system:agents', hash: '#tab/chat:e2e-b' })
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    await page.click('[data-tab-id="chat:e2e-b"] button[title="Close tab"]')
    await page.waitForFunction(() => !document.querySelector('[data-tab-id="chat:e2e-b"]') && decodeURIComponent(location.hash) === '#tab/system:agents')
    assert.equal((await state(page)).tabsById['chat:e2e-b'], undefined)
    await page.evaluate(() => { window.location.hash = 'session/e2e-b' })
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, true)
  } finally { await page.close() }
})

test('Keep after a direct Session link changes only preview state, not the current hash', async () => {
  const page = await openFixture({ activeTabId: 'system:agents', hash: '#session/e2e-b' })
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-b"][title$="(preview)"]')
    const beforeHash = (await state(page)).hash
    await page.click('[data-tab-id="chat:e2e-b"]', { button: 'right' })
    await page.waitForSelector('[role="menu"]')
    await page.evaluate(() => [...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent?.trim() === 'Keep')?.click())
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:e2e-b"]')?.title === 'e2e-b')
    assert.equal((await state(page)).hash, beforeHash)
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, false)
  } finally { await page.close() }
})

const paneButtons = '[title="Split right with active tab"], [title="Split down with active tab"], [title="Close pane"]'

test('single pane with one tab omits its strip without leaving header height; Sidebar drag restores tabs and controls', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a')] })
  try {
    await page.waitForSelector('[data-pane-id="pane-main"] [role="textbox"][aria-label="Message"]')
    assert.equal(await page.$('[data-pane-id="pane-main"] [data-tab-id]'), null)
    assert.equal(await page.$(paneButtons), null)
    const geometry = await page.$eval('[data-pane-id="pane-main"]', pane => {
      const content = pane.querySelector('.min-h-0.flex-1')
      return { contentTop: content.getBoundingClientRect().top, paneTop: pane.getBoundingClientRect().top, contentHeight: content.getBoundingClientRect().height, paneHeight: pane.getBoundingClientRect().height }
    })
    assert.ok(geometry.contentTop - geometry.paneTop <= 2, JSON.stringify(geometry))
    assert.ok(geometry.paneHeight - geometry.contentHeight <= 3, JSON.stringify(geometry))
    await page.waitForSelector('[data-session-id="e2e-b"]')
    const source = await (await page.$('[data-session-id="e2e-b"]')).boundingBox()
    const target = await (await page.$('[data-pane-id="pane-main"]')).boundingBox()
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 4 })
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 })
    await new Promise(resolve => setTimeout(resolve, 120))
    await page.mouse.up()
    await page.waitForSelector('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-b"]')
    assert.equal(await page.$$eval('[data-pane-id="pane-main"] [data-tab-id]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval(paneButtons, nodes => nodes.length), 3)
    assert.equal((await state(page)).tabsById['chat:e2e-b'].preview, false)
    // Wait for the drag's document-level click guard to clear before a real Close click.
    await page.waitForFunction(() => {
      let delivered = false
      const probe = () => { delivered = true }
      document.body.addEventListener('click', probe, { once: true })
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      document.body.removeEventListener('click', probe)
      return delivered
    })
    await page.click('[data-tab-id="chat:e2e-b"] button[title="Close tab"]')
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state
      return state.root.tabIds.length === 1 && state.root.activeTabId === 'chat:e2e-a'
        && !document.querySelector('[data-tab-id]')
        && !!document.querySelector('[data-pane-id="pane-main"] [role="textbox"][aria-label="Message"]')
    })
    assert.equal((await state(page)).hash, '#tab/chat:e2e-a')
    assert.equal(await page.$(paneButtons), null)
  } finally { await page.close() }
})

test('Close tab owns a small pointer move inside its button instead of starting a tab drag', async () => {
  const page = await openFixture({ tabs: [system, chat('e2e-a', false), chat('e2e-b', false)], activeTabId: 'chat:e2e-b' })
  try {
    const selector = '[data-tab-id="chat:e2e-b"] button[title="Close tab"]'
    await page.waitForSelector(selector)
    const box = await (await page.$(selector)).boundingBox()
    assert.ok(box && box.width > 14, 'close control has room for a short movement entirely inside it')
    const startX = box.x + box.width / 2 - 4
    const endX = startX + 8 // Cross the workbench's 6px drag threshold without leaving the button.
    const y = box.y + box.height / 2
    assert.equal(await page.evaluate(({ startX, endX, y }) => [startX, endX].every(x => document.elementFromPoint(x, y)?.closest('button[title="Close tab"]')?.closest('[data-tab-id]')?.getAttribute('data-tab-id') === 'chat:e2e-b'), { startX, endX, y }), true)
    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(endX, y, { steps: 4 })
    const dragBeforeRelease = await page.$('[data-pane-id="pane-main"] > .pointer-events-none')
    await page.mouse.up()
    assert.equal(dragBeforeRelease, null, 'moving within Close must not activate the tab drag overlay')
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state
      return state.root.tabIds.join(',') === 'system:agents,chat:e2e-a'
        && state.root.activeTabId === 'chat:e2e-a'
        && !document.querySelector('[data-tab-id="chat:e2e-b"]')
    })
  } finally { await page.close() }
})

test('each single-tab pane uses its header while multi-tab panes retain their strips and controls', async () => {
  const page = await openFixture({ split: true })
  try {
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    await page.waitForSelector('[data-workbench-tab-handle="system:agents"]')
    assert.equal(await page.$('[data-tab-id]'), null)
    if (process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR}/single-tab-panes.png` })
    assert.equal(await page.$(paneButtons), null)
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-b"]')
    assert.equal(await page.$(paneButtons), null, 'replacing the preview keeps one tab in the pane')
    await page.click('[data-workbench-tab-handle="chat:e2e-b"]', { clickCount: 2 })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-c'))
    await page.waitForSelector('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-c"]')
    assert.equal(await page.$$eval('[data-pane-id="pane-main"] [data-tab-id]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval('[data-pane-id="pane-main"] button[title="Split right with active tab"], [data-pane-id="pane-main"] button[title="Split down with active tab"], [data-pane-id="pane-main"] button[title="Close pane"]', nodes => nodes.length), 3)
    assert.equal(await page.$('[data-pane-id="pane-other"] ' + paneButtons.split(', ').join(', [data-pane-id="pane-other"] ')), null)
    await page.click('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-c"] button[title="Close tab"]')
    await page.waitForFunction(() => !document.querySelector('[data-tab-id="chat:e2e-c"]'))
    assert.ok(await page.$('[data-workbench-tab-handle="chat:e2e-b"]'))
    assert.equal(await page.$(paneButtons), null)
  } finally { await page.close() }
})

test('old preview records disappear without removing kept or system tabs; canonical previews survive reload', async () => {
  const old = { id: 'chatpreview_old-uuid', type: 'chat', sessionId: 'e2e-old', title: 'Old', preview: true }
  const legacy = { id: 'chat:__preview__', type: 'chat', sessionId: 'e2e-legacy', title: 'Legacy', preview: true }
  const page = await openFixture({ tabs: [old, legacy, system, chat('e2e-c', false), chat('e2e-a')], activeTabId: 'chat:e2e-a' })
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    await page.click('[data-tab-id="system:agents"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.activeTabId === 'system:agents')
    const snapshot = await state(page)
    assert.deepEqual(Object.keys(snapshot.tabsById).sort(), ['chat:e2e-a', 'chat:e2e-c', 'system:agents'])
    assert.deepEqual(snapshot.root.tabIds, ['system:agents', 'chat:e2e-c', 'chat:e2e-a'])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-c'].preview, false)
  } finally { await page.close() }
})

test('global history entry opens a persistent workbench tab without a chat composer', async () => {
  const page = await openFixture()
  try {
    const footer = '[data-sidebar-footer]'
    assert.deepEqual(await page.$$eval(`${footer} button`, buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Search history', 'Open UI settings'])
    assert.equal(await page.$$eval('button[title="Search history"]', buttons => buttons.length), 1)
    assert.equal(await page.$eval(`${footer} button[aria-label="Search history"]`, button => button.getBoundingClientRect().width), 36)
    assert.equal(await page.$eval(`${footer} button[aria-label="Search history"]`, button => button.textContent.trim()), '')
    assert.ok(await page.$(`${footer} button[aria-label="Search history"] svg.lucide-history`))
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$(footer))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/sidebar-footer-search.png` })
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$('.foxwarm-chat-root .sticky'))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/chat-find-header.png` })
    await page.click(`${footer} button[aria-label="Search history"]`)
    await page.waitForSelector('[data-tab-id="system:search"]')
    await page.waitForSelector('[data-history-search-view]')
    assert.equal(await page.$('[data-history-search-view] [aria-label="Message"]'), null)
    assert.equal((await state(page)).root.activeTabId, 'system:search')
    assert.equal((await state(page)).tabsById['system:search'].type, 'search')
    assert.equal((await state(page)).tabsById['system:search'].title, 'History')
    assert.equal(await page.$eval('[data-tab-id="system:search"]', tab => tab.title), 'History')
    assert.ok(await page.$('[data-tab-id="system:search"] svg.lucide-history'))
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$('[data-tab-id="system:search"]'))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/history-workbench-tab.png` })
    assert.equal((await state(page)).hash, '#tab/system:search')
  } finally { await page.close() }
})

test('collapsed rail and mobile Session list place the Search icon in their footers', async () => {
  const page = await openFixture()
  try {
    await page.click('button[title="Collapse sidebar"]')
    await page.waitForSelector('.w-12 [data-sidebar-footer] button[aria-label="Search history"]')
    assert.equal(await page.$eval('.w-12 [data-sidebar-footer] button[aria-label="Search history"]', button => button.textContent.trim()), '')
    assert.ok(await page.$('.w-12 [data-sidebar-footer] button[aria-label="Search history"] svg.lucide-history'))
    assert.equal(await page.$('.w-12 > div:first-child button[aria-label="Search history"]'), null)
    assert.equal(await page.$('.w-12 > div:first-child button[aria-label="Open UI settings"]'), null)
    assert.ok(await page.$('.w-12 [data-sidebar-footer] button[aria-label="Open UI settings"]'))
    await page.setViewport({ width: 390, height: 800 })
    await page.waitForSelector('[data-sidebar-footer] button[aria-label="Open UI settings"]')
    assert.deepEqual(await page.$$eval('[data-sidebar-footer] button', buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Search history', 'Open UI settings'])
    assert.equal(await page.$eval('[data-sidebar-footer] button[aria-label="Search history"]', button => button.textContent.trim()), '')
    assert.ok(await page.$('[data-sidebar-footer] button[aria-label="Search history"] svg.lucide-history'))
    await page.click('[data-sidebar-footer] button[aria-label="Search history"]')
    await page.waitForSelector('[data-history-search-view]')
  } finally { await page.close() }
})

test('persisted search tabs keep their identity while showing the current History label after refresh', async () => {
  const tab = { id: 'system:search', type: 'search', title: 'Search history' }
  const page = await openFixture({ tabs: [chat('e2e-a', false), tab], activeTabId: tab.id })
  try {
    await page.waitForSelector('[data-history-search-view]')
    for (let refresh = 0; refresh < 2; refresh += 1) {
      assert.equal(await page.$eval('[data-tab-id="system:search"]', element => element.title), 'History')
      assert.equal((await state(page)).tabsById['system:search'].type, 'search')
      assert.equal((await state(page)).root.activeTabId, 'system:search')
      if (!refresh) await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-history-search-view]')
    }
  } finally { await page.close() }
})

test('history result Open session reuses kept Chats or opens a preview while retaining the History tab', async () => {
  const history = { id: 'system:search', type: 'search', title: 'History' }
  const page = await openFixture({ tabs: [history, chat('e2e-a', false)], activeTabId: history.id })
  try {
    await page.waitForSelector('#history-search-query')
    await page.type('#history-search-query', 'entry')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.querySelector('[data-history-result="history-outside/main"] header')?.textContent.includes('Outside the sidebar'))
    assert.equal(await page.$('[data-session-id="history-outside/main"]'), null)
    await page.click('[data-history-result="e2e-a"] a[aria-label="Open session"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.activeTabId === 'chat:e2e-a')
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, false)
    assert.equal((await state(page)).tabsById['system:search'].type, 'search')
    await page.click('[data-tab-id="system:search"]')
    await page.waitForSelector('#history-search-query')
    await page.type('#history-search-query', 'entry')
    await page.click('button[type=submit]')
    await page.waitForSelector('[data-history-result="history-outside/main"]')
    await page.click('[data-history-result="history-outside/main"] a[aria-label="Open session"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.activeTabId === 'chat:history-outside/main')
    assert.equal((await state(page)).tabsById['chat:history-outside/main'].preview, true)
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, false)
    assert.equal((await state(page)).tabsById['system:search'].type, 'search')
    assert.equal((await state(page)).hash, '#tab/chat:history-outside/main')
  } finally { await page.close() }
})

test('Ctrl/Cmd+F targets the focused Chat pane and not inactive Chat or non-Chat workbench tabs', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a', false), chat('e2e-b', false), system], activeTabId: 'chat:e2e-a', split: true, splitSecondChat: true })
  try {
    await page.waitForSelector('[data-pane-id="pane-main"] [role="textbox"][aria-label="Message"]')
    await page.waitForSelector('[data-pane-id="pane-other"] [role="textbox"][aria-label="Message"]')
    await page.click('[data-pane-id="pane-main"] [role="textbox"][aria-label="Message"]')
    await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
    await page.waitForSelector('[data-pane-id="pane-main"] [data-chat-search] input')
    assert.equal(await page.$('[data-pane-id="pane-other"] [data-chat-search]'), null)
    await page.type('[data-pane-id="pane-main"] [data-chat-search] input', 'repeat query')
    await page.click('[data-sidebar-footer] button[aria-label="Open UI settings"]')
    await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
    assert.deepEqual(await page.evaluate(() => ({
      value: document.querySelector('[data-pane-id="pane-main"] [data-chat-search] input').value,
      selected: document.activeElement === document.querySelector('[data-pane-id="pane-main"] [data-chat-search] input')
        && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 'repeat query'.length,
      count: document.querySelectorAll('[data-chat-search]').length,
    })), { value: 'repeat query', selected: true, count: 1 })
    await page.click('[data-pane-id="pane-main"] button[aria-label="Close search"]')
    await page.click('[data-pane-id="pane-other"] [role="textbox"][aria-label="Message"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-other')
    await page.keyboard.down('Meta'); await page.keyboard.press('f'); await page.keyboard.up('Meta')
    await page.waitForSelector('[data-pane-id="pane-other"] [data-chat-search] input')
    assert.equal(await page.$('[data-pane-id="pane-main"] [data-chat-search]'), null)
    const ignored = await page.evaluate(() => {
      const dispatch = init => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true, ...init }); window.dispatchEvent(event); return event.defaultPrevented }
      return [dispatch({ shiftKey: true }), dispatch({ altKey: true }), dispatch({ isComposing: true })]
    })
    assert.deepEqual(ignored, [false, false, false])
    await page.click('[data-pane-id="pane-other"] button[aria-label="Close search"]')
    await page.click('[data-pane-id="pane-main"] [data-tab-id="system:agents"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-main')
    const blocked = await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })
    assert.equal(blocked, false)
    assert.equal(await page.$$eval('[data-chat-search]', elements => elements.length), 0)
  } finally { await page.close() }
})

test('550A Chat has one Code action, honors the new-tab preference, and dispatches the Terminal target', async () => {
  const page = await openFixture({ themeId: 'foxwarm.550a', codeNewWindow: true })
  try {
    const header = '.foxwarm-chat-root .sticky'
    await page.waitForSelector(`${header} button[title="Code"]`)
    assert.equal(await page.$$eval(`${header} button[title="Code"]`, buttons => buttons.length), 1)
    assert.equal(await page.$eval(`${header} button[title="Code"]`, button => button.textContent), 'Code')
    assert.equal(await page.$eval(`${header} button[title="Terminal"]`, button => button.textContent), 'Terminal')
    assert.equal(await page.$(`${header} .lucide-external-link`), null)
    assert.equal(await page.$(`${header} button[title="Open code in a new browser tab"]`), null)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmComponentTreatment), 'console')
    if (process.env.FOXWARM_HEADER_SCREENSHOT_PATH) {
      await (await page.$(header)).screenshot({ path: process.env.FOXWARM_HEADER_SCREENSHOT_PATH })
    }
    await page.evaluate(() => {
      window.__openedCode = []
      window.open = (...args) => { window.__openedCode.push(args); return null }
    })
    await page.click(`${header} button[title="Code"]`)
    const opened = await page.evaluate(() => window.__openedCode)
    assert.equal(opened.length, 1)
    const codeUrl = new URL(opened[0][0])
    assert.equal(codeUrl.pathname, '/prefix/ui/vscode-web/')
    assert.equal(codeUrl.searchParams.get('folderUri'), 'foxwarm://node+master/')
    assert.deepEqual(opened[0].slice(1), ['_blank', 'noopener,noreferrer'])
    assert.equal((await state(page)).tabsById['vscode-web'], undefined)

    await page.click(`${header} button[title="Terminal"]`)
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).some(tab => tab.type === 'terminal'))
    const terminal = Object.values((await state(page)).tabsById).find(tab => tab.type === 'terminal')
    assert.equal(terminal.nodeId, 'master')
    assert.equal(terminal.cwd, '/')
  } finally { await page.close() }
})

test('Chat Code still opens the embedded workbench when the new-tab preference is off', async () => {
  const page = await openFixture({ codeNewWindow: false })
  try {
    await page.waitForSelector('.foxwarm-chat-root button[title="Code"]')
    await page.evaluate(() => {
      window.__openedCode = []
      window.open = (...args) => { window.__openedCode.push(args); return null }
    })
    await page.click('.foxwarm-chat-root button[title="Code"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.activeTabId === 'vscode-web')
    assert.equal((await state(page)).tabsById['vscode-web'].type, 'vscode')
    assert.deepEqual(await page.evaluate(() => window.__openedCode), [])
  } finally { await page.close() }
})

test('Application menu icons precede their labels and retain Setup, Logs, and reload actions', async () => {
  const page = await openFixture({ themeId: 'foxwarm.550a' })
  try {
    const menu = '[data-global-ui-settings-menu]'
    const trigger = '[data-sidebar-footer] button[aria-label="Open UI settings"]'
    const openMenu = async () => {
      await page.waitForSelector(trigger)
      await page.click(trigger)
      await page.waitForSelector(menu, { visible: true })
    }
    await openMenu()
    const rows = await page.$$eval(`${menu} button`, buttons => buttons.filter(button => /Open setup|Reload WebUI|Open logs/.test(button.textContent)).map(button => {
      const label = button.firstElementChild
      const icon = label.firstElementChild
      const text = label.lastChild
      const range = document.createRange()
      range.selectNodeContents(text)
      return {
        text: label.textContent,
        icon: [...icon.classList].find(name => /^lucide-(settings|refresh-cw|file-text)$/.test(name)),
        svgCount: button.querySelectorAll('svg').length,
        width: icon.getBoundingClientRect().width,
        beforeText: icon.getBoundingClientRect().right < range.getBoundingClientRect().left,
      }
    }))
    assert.deepEqual(rows, [
      { text: 'Open setup', icon: 'lucide-settings', svgCount: 1, width: 14, beforeText: true },
      { text: 'Reload WebUI', icon: 'lucide-refresh-cw', svgCount: 1, width: 14, beforeText: true },
      { text: 'Open logs', icon: 'lucide-file-text', svgCount: 1, width: 14, beforeText: true },
    ])
    if (process.env.FOXWARM_APPLICATION_MENU_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.FOXWARM_APPLICATION_MENU_SCREENSHOT_PATH })
    }
    await page.click(`${menu} .lucide-settings`)
    await page.waitForSelector('[data-setup-tab="appearance"]')
    assert.equal(await page.$(menu), null)
    await openMenu()
    assert.equal(await page.$eval(`${menu} .lucide-settings`, icon => icon.closest('button').textContent), 'Open setupactive')
    await page.click(`${menu} .lucide-file-text`)
    await page.waitForSelector('[data-logs-view]')
    assert.equal((await state(page)).root.activeTabId, 'system:logs')
    assert.equal(await page.$(menu), null)
    await openMenu()
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-global-ui-settings-menu] button[aria-label="Reload app"]')
      const rect = button?.getBoundingClientRect()
      return rect && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click(`${menu} button[aria-label="Reload app"]`),
    ])
    await page.waitForFunction(() => !!window.foxwarmTest)
    assert.equal(await page.$(menu), null)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmComponentTreatment), 'console')
  } finally { await page.close() }
})


test('Chat follows each pane through real divider dragging without changing desktop navigation or drafts', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a', false), chat('e2e-b', false)], split: true, splitSecondChat: true, responsiveChat: true, width: 1800 })
  const main = '[data-pane-id="pane-main"]'
  const other = '[data-pane-id="pane-other"]'
  const editor = ' [role="textbox"][aria-label="Message"]'
  const paneLayout = selector => page.$eval(selector + ' .foxwarm-chat-root', root => {
    const visible = selector => { const el = root.querySelector(selector); return !!el && getComputedStyle(el).display !== 'none' }
    const messages = root.querySelector('.foxwarm-chat-messages')
    return {
      width: root.getBoundingClientRect().width,
      sm: visible('.foxwarm-chat-sm-label'), md: visible('.foxwarm-chat-md-label'),
      minimap: visible('.foxwarm-context-scrollbar-shell'),
      gutter: getComputedStyle(root.querySelector('.foxwarm-chat-messages-content')).paddingRight,
      nativeScrollbar: getComputedStyle(messages).scrollbarWidth,
      compact: root.querySelector('.foxwarm-model-selector-root').dataset.chatLayout,
      childLabel: visible('.foxwarm-model-child-trigger > span'),
      back: !!root.querySelector('button[title="Back"]'),
      overflow: [...root.querySelectorAll('.foxwarm-chat-composer-form, [data-chat-timeline], .sticky')].some(el => el.scrollWidth > el.clientWidth + 1),
    }
  })
  const resizeMain = async target => {
    const box = await (await page.$('[role="separator"]')).boundingBox()
    const width = (await paneLayout(main)).width
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + target - width, box.y + box.height / 2, { steps: 8 })
    // The content must react while the pointer is still held, not only on release.
    await page.waitForFunction((target) => {
      const root = document.querySelector('[data-pane-id="pane-main"] .foxwarm-chat-root')
      const width = root?.getBoundingClientRect().width
      return Math.abs(width - target) < 2 && !!root.querySelector('.foxwarm-context-scrollbar-shell') === (width >= 768)
    }, {}, target)
    await page.mouse.up()
  }
  try {
    await page.waitForSelector(main + editor)
    await page.waitForSelector(main + ' [data-chat-timeline] [data-search-row]')
    await page.click(main + editor); await page.keyboard.type('main draft remains')
    await page.click(other + editor); await page.keyboard.type('other draft remains')
    await resizeMain(1030)
    const wide = await paneLayout(main), narrow = await paneLayout(other)
    assert.equal(wide.md, true); assert.equal(wide.minimap, true); assert.equal(wide.gutter, '32px'); assert.equal(wide.nativeScrollbar, 'none')
    assert.equal(narrow.md, false); assert.equal(narrow.minimap, false); assert.equal(narrow.gutter, '0px'); assert.notEqual(narrow.nativeScrollbar, 'none')
    assert.equal(wide.back, false); assert.equal(narrow.back, false)
    assert.equal(wide.overflow, false); assert.equal(narrow.overflow, false)
    const scrollBox = await (await page.$(main + ' .foxwarm-chat-messages')).boundingBox()
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2)
    await page.mouse.wheel({ deltaY: -650 })
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pane-id="pane-main"] .foxwarm-chat-messages')
      return el.scrollHeight - el.scrollTop - el.clientHeight > 500
    })
    await page.click(other + ' .foxwarm-model-selector-trigger')
    await page.waitForSelector('[data-model-selector-popup][data-model-layout="compact"]')
    const popup = await page.$eval('[data-model-selector-popup]', el => ({ width: el.getBoundingClientRect().width, columns: getComputedStyle(el.querySelector('.foxwarm-model-columns')).gridTemplateColumns.split(' ').length, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }))
    assert.equal(popup.columns, 1); assert.ok(popup.width <= 360 && popup.left >= 8 && popup.right <= 1792)
    await page.keyboard.press('Escape')
    await resizeMain(767)
    assert.equal((await paneLayout(main)).minimap, false)
    await resizeMain(769)
    assert.equal((await paneLayout(main)).minimap, true)
    await resizeMain(639)
    assert.equal((await paneLayout(main)).sm, false)
    await resizeMain(641)
    assert.equal((await paneLayout(main)).sm, true)
    assert.ok(await page.$eval(main + ' .foxwarm-chat-messages', el => el.scrollHeight - el.scrollTop - el.clientHeight > 200), 'resizing must not rejoin bottom after upward user intent')
    await page.click(main + ' .foxwarm-model-selector-trigger')
    await page.waitForSelector('[data-model-selector-popup][data-model-layout="wide"]')
    assert.equal(await page.$eval('.foxwarm-model-columns', el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2)
    await page.keyboard.press('Escape')
    // Equal content widths produce the same layout in different browser widths.
    await resizeMain(600)
    const beforeViewportResize = await paneLayout(main)
    await page.setViewport({ width: 1600, height: 900 })
    await resizeMain(600)
    const afterViewportResize = await paneLayout(main)
    assert.deepEqual({ ...afterViewportResize, width: 600 }, { ...beforeViewportResize, width: 600 })
    await resizeMain(410)
    assert.equal((await paneLayout(main)).childLabel, false)
    // Sidebar collapse changes width/anchor position while the portaled picker stays open.
    await page.click(main + ' .foxwarm-model-selector-trigger')
    await page.waitForSelector('[data-model-layout="compact"]')
    const previousLeft = await page.$eval('[data-model-selector-popup]', el => el.getBoundingClientRect().left)
    await page.$eval('button[title="Collapse sidebar"]', button => button.click())
    await page.waitForFunction(left => document.querySelector('[data-model-selector-popup]')?.getBoundingClientRect().left < left - 100, {}, previousLeft)
    await page.waitForFunction(() => document.querySelector('[data-pane-id="pane-main"] .foxwarm-chat-root').getBoundingClientRect().width > 420)
    assert.equal((await paneLayout(main)).childLabel, true)
    await page.keyboard.press('Escape')
    for (const [selector, text] of [[main, 'main draft remains'], [other, 'other draft remains']]) {
      assert.equal(await page.$eval(selector + editor, (el, text) => el.textContent.includes(text), text), true)
      assert.equal((await paneLayout(selector)).overflow, false)
    }
    assert.deepEqual((await state(page)).active, ['chat:e2e-a', 'chat:e2e-b'])
    assert.equal(await page.$$eval('.foxwarm-chat-root', elements => elements.length), 2)
    if (process.env.FOXWARM_CONTAINER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_CONTAINER_SCREENSHOT_PATH })
    // A hidden mounted Chat retains its band and recomputes when revealed.
    await page.$eval(main + ' .foxwarm-chat-root', root => { root.style.display = 'none' })
    await page.waitForFunction(() => document.querySelector('[data-pane-id="pane-main"] .foxwarm-chat-root').getBoundingClientRect().width === 0)
    await page.$eval(main + ' .foxwarm-chat-root', root => { root.style.display = ''; root.style.width = '768px' })
    await page.waitForFunction(() => !!document.querySelector('[data-pane-id="pane-main"] .foxwarm-context-scrollbar-shell'))
    assert.equal((await paneLayout(main)).gutter, '32px')
    await page.$eval(main + ' .foxwarm-chat-root', root => { root.style.width = '' })
    // The production embedded and popup routes use the same container boundary.
    for (const query of ['foxwarmEmbed=chat&foxwarmEmbedNonce=container-fixture-nonce&sessionId=e2e-a', 'foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=e2e-a']) {
      await page.setViewport({ width: 410, height: 900 })
      await page.goto(baseUrl + '?' + query, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.foxwarm-chat-root [data-search-row]')
      const leaf = await paneLayout('')
      assert.equal(leaf.sm, false); assert.equal(leaf.md, false); assert.equal(leaf.minimap, false); assert.equal(leaf.childLabel, false); assert.equal(leaf.overflow, false)
      await page.click('.foxwarm-model-selector-trigger')
      await page.waitForSelector('[data-model-layout="compact"]')
      const rect = await page.$eval('[data-model-selector-popup]', el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }))
      assert.ok(rect.left >= 8 && rect.right <= 402)
      await page.keyboard.press('Escape')
    }
  } finally { await page.close() }
})

test('every ordinary single tab closes from its header; Code retains the strip', async () => {
  for (const tab of [chat('e2e-a'), system, { id: 'system:search', type: 'search', title: 'History' }, { id: 'system:logs', type: 'logs', title: 'Logs' }, { id: 'system:setup', type: 'setup', title: 'Setup' }, { id: 'vscode-web', type: 'vscode', title: 'Code' }]) {
    const page = await openFixture({ tabs: [tab], activeTabId: tab.id })
    try {
      const close = tab.type === 'vscode' ? '[data-tab-id="vscode-web"] button[title="Close tab"]' : `[data-workbench-tab-close=${JSON.stringify(tab.id)}]`
      await page.waitForSelector(close)
      if (tab.type !== 'vscode') {
        assert.equal(await page.$('[data-tab-id]'), null, tab.type)
        assert.ok(await page.$(`[data-workbench-tab-handle=${JSON.stringify(tab.id)}]`), tab.type)
        if (tab.type === 'setup') assert.equal(await page.$$eval('button', buttons => buttons.filter(button => button.textContent.trim() === 'Close').length), 0, 'Setup has no extra Close action')
      } else {
        assert.equal(await page.$('[data-workbench-tab-handle]'), null)
        if (process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR}/single-code.png` })
      }
      await page.click(close)
      await page.waitForFunction(id => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById[id], {}, tab.id)
      assert.equal((await state(page)).hash, '')
      assert.deepEqual((await state(page)).root.tabIds, [])
      assert.match(await page.$eval('[data-pane-id]', pane => pane.textContent), /Empty pane/)
    } finally { await page.close() }
  }
})

test('single Chat icon owns drag and its existing menu; cancel and Close pointer motion do not Keep', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a')] })
  try {
    const handle = '[data-workbench-tab-handle="chat:e2e-a"]'
    await page.waitForSelector(handle)
    const bounds = await (await page.$(handle)).boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2, { steps: 4 })
    await page.waitForSelector('[data-pane-id] > .pointer-events-none')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, true)
    await page.waitForFunction(() => {
      let delivered = false
      const probe = () => { delivered = true }
      document.body.addEventListener('click', probe, { once: true })
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.body.removeEventListener('click', probe)
      return delivered
    })
    await page.focus(handle)
    await page.keyboard.down('Shift')
    await page.keyboard.press('F10')
    await page.keyboard.up('Shift')
    await page.waitForSelector('[role="menu"]')
    const entries = await page.$$eval('[role="menu"] button', buttons => buttons.map(button => button.textContent.trim()))
    assert.ok(entries.includes('Keep'))
    assert.ok(entries.includes('Move to new window'))
    await page.keyboard.press('Escape')
    const close = await (await page.$('[data-workbench-tab-close="chat:e2e-a"]')).boundingBox()
    const x = close.x + close.width / 2 - 4
    const y = close.y + close.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 8, y, { steps: 4 })
    assert.equal(await page.$('[data-pane-id] > .pointer-events-none'), null)
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, true)
    await page.mouse.up()
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-a'])
    assert.equal((await state(page)).hash, '')
  } finally { await page.close() }
})

test('Terminal single-tab chrome preserves status-row height and closes its backend resource', async () => {
  const terminal = { id: 'term-header', nodeId: 'master', cwd: '/workspace', pid: 42, cols: 80, rows: 24 }
  const tab = { id: 'terminal:term-header', type: 'terminal', terminalId: terminal.id, nodeId: terminal.nodeId, cwd: terminal.cwd, title: 'Terminal' }
  for (const viewportWidth of [1400, 390]) {
    const options = { activeTabId: tab.id, terminal, hash: '#tab/terminal%3Aterm-header', viewportWidth }
    const single = await openFixture({ ...options, tabs: [tab] })
    const multi = await openFixture({ ...options, tabs: [system, tab] })
    try {
      for (const page of [single, multi]) {
        await page.bringToFront()
        await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
      }
      const height = async page => { await page.bringToFront(); return page.$eval('[data-terminal-header]', element => element.getBoundingClientRect().height) }
      const singleHeight = await height(single), multiHeight = await height(multi)
      assert.ok(singleHeight <= multiHeight, `single-tab Terminal must not grow at ${viewportWidth}px: ${singleHeight} vs ${multiHeight}`)
      await single.bringToFront()
      assert.match(await single.$eval('[data-terminal-header]', element => element.textContent), /status ready.*node master.*pid 42/)
      assert.ok(await single.$('[data-terminal-header] button[aria-label="Show Web keyboard"]'))
      await multi.close()
      if (process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR) {
        await single.bringToFront()
        await single.screenshot({ path: `${process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR}/single-terminal-${viewportWidth}.png`, clip: await (await single.$('[data-terminal-header]')).boundingBox(), fromSurface: false })
      }
      assert.equal(await single.$eval('[data-workbench-tab-close="terminal:term-header"]', button => {
        const box = button.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button
      }), true, 'Terminal X owns its hit target')
      await single.click('[data-workbench-tab-close="terminal:term-header"]')
      await single.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['terminal:term-header'] && !location.hash).catch(async error => {
        throw new Error(`${error.message}: ${JSON.stringify(await single.evaluate(() => ({ state: JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state, hash: location.hash, deletes: window.__terminalDeletes, header: document.querySelector('[data-terminal-header]')?.textContent, body: document.body.textContent.slice(0, 300) })))}`)
      })
      assert.deepEqual(await single.evaluate(() => window.__terminalDeletes), ['/prefix/ui/api/terminals/term-header'])
      assert.equal((await state(single)).hash, '')
      if (viewportWidth === 1400) {
        await single.click('button[title="Create terminal tab"]')
        await single.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).some(tab => tab.type === 'terminal' && tab.terminalId === 'term-reopened'))
        await single.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
        const reopened = await state(single)
        const fresh = Object.values(reopened.tabsById).find(tab => tab.type === 'terminal' && tab.terminalId === 'term-reopened')
        assert.notEqual(fresh.id, tab.id)
        assert.equal(reopened.hash, `#tab/${fresh.id}`)
        assert.ok(await single.evaluate(() => window.__terminalCreates.length > 0), 'explicit reopen sends a terminal create request')
        assert.deepEqual(await single.evaluate(() => window.__terminalDeletes), ['/prefix/ui/api/terminals/term-header'])
      }
    } finally { await single.close(); if (!multi.isClosed()) await multi.close() }
  }
})


test('ordinary Terminal close selects another still-open tab rather than restoring the closed route', async () => {
  const terminal = { id: 'term-fallback', nodeId: 'master', cwd: '/workspace', pid: 42, cols: 80, rows: 24 }
  const tab = { id: 'terminal:term-fallback', type: 'terminal', terminalId: terminal.id, nodeId: terminal.nodeId, cwd: terminal.cwd, title: 'Terminal' }
  const page = await openFixture({ tabs: [system, tab], activeTabId: tab.id, terminal, hash: '#tab/terminal%3Aterm-fallback' })
  try {
    await page.bringToFront()
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    await page.click('[data-tab-id="terminal:term-fallback"] button[title="Close tab"]')
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['terminal:term-fallback'] && decodeURIComponent(location.hash) === '#tab/system:agents')
    assert.deepEqual((await state(page)).root.tabIds, ['system:agents'])
    assert.ok(await page.$('[data-workbench-tab-handle="system:agents"]'))
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), ['/prefix/ui/api/terminals/term-fallback'])
  } finally { await page.close() }
})


test('Chat composer uses a smaller empty editor below 600px in Default and 550A', async () => {
  for (const themeId of ['foxwarm.default', 'foxwarm.550a']) {
    const sessionId = 'compact-' + themeId
    const page = await openFixture({ tabs: [chat(sessionId, false), chat('e2e-b', false)], activeTabId: 'chat:' + sessionId, split: true, splitSecondChat: true, width: 1800, themeId })
    const root = '[data-pane-id="pane-main"] .foxwarm-chat-root'
    const editor = root + ' [role="textbox"][aria-label="Message"]'
    const geometry = () => page.$eval(editor, el => ({
      height: el.getBoundingClientRect().height,
      minHeight: getComputedStyle(el).minHeight,
      marginBottom: getComputedStyle(el.parentElement).marginBottom,
      lineHeight: getComputedStyle(el).lineHeight,
      padding: getComputedStyle(el).padding,
    }))
    try {
      await page.waitForSelector(editor)
      const original = await geometry()
      for (const [width, minHeight] of [[600, 60], [599, 35]]) {
        await page.$eval(root, (el, width) => { el.style.width = width + 'px' }, width)
        await page.waitForFunction((selector, height) => getComputedStyle(document.querySelector(selector)).minHeight === height + 'px', {}, editor, minHeight)
        const actual = await geometry()
        assert.equal(await page.$eval(root, el => el.getBoundingClientRect().width), width)
        assert.equal(actual.height, minHeight, themeId + ' empty editor at ' + width)
        assert.equal(actual.marginBottom, '0px')
        assert.equal(actual.lineHeight, original.lineHeight)
        assert.equal(actual.padding, original.padding)
      }
      await page.click(editor)
      await page.keyboard.type('First line')
      for (let index = 0; index < 3; index++) {
        await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
        await page.keyboard.type('Another line')
      }
      assert.ok((await geometry()).height > 60, themeId + ' multiline editor can grow')
    } finally { await page.close() }
  }
})
