import { waitForWebUiReady } from './webuiReadiness.mjs'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const dist = new URL('../dist/', import.meta.url)
const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
const browserPath = firefox ? (process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox') : (process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium')
let browser
let server
let baseUrl

const chat = (id, preview = true) => ({ id: `chat:${id}`, type: 'chat', sessionId: id, title: id, preview })
const nodesTab = { id: 'system:nodes', type: 'nodes', title: 'Nodes' }
const system = { id: 'system:agents', type: 'agents', title: 'Agents' }

async function serve(request, response) {
  const pathname = new URL(request.url, 'http://fixture').pathname
  if (pathname === '/prefix/ui/vscode-web/') {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><html><body>Code fixture<script>parent.__codeFrameLoads = (parent.__codeFrameLoads || 0) + 1; addEventListener("message", event => { if (event.data.type !== "request") return; (parent.__codeRequests ||= []).push(event.data.request); parent.postMessage({ channel: "foxwarm-code-bridge", version: 1, type: "response", requestId: event.data.requestId, ok: true, result: {} }, location.origin) }); addEventListener("load", () => parent.postMessage({ channel: "foxwarm-code-bridge", version: 1, type: "ready" }, location.origin))</script></body></html>')
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
  browser = await puppeteer.launch({ browser: firefox ? 'firefox' : 'chrome', executablePath: browserPath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: firefox ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
})
after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function openFixture({ freshBrowser = false, tabs = [system, chat('e2e-a')], activeTabId = 'chat:e2e-a', hash = '', split = false, splitSecondChat = false, splitDirection = 'row', layout = null, themeId, colorMode = 'light', nodeDirectory = [], taskRows = null, codeNewWindow, responsiveChat = false, chatMessages = null, timelineView = 'grouped', showScrollbar, terminal = null, width = 1400, height = 900, reducedMotion = false, waitForSplash = true } = {}) {
  const page = await browser.newPage()
  if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // Firefox ESR retains its native viewport; Puppeteer orientation emulation is unsupported.
  if (!firefox) await page.setViewport({ width, height })
  await page.evaluateOnNewDocument(({ freshBrowser, initialTabs, activeId, splitPanes, splitSecondChat, splitDirection, initialLayout, themeId, colorMode, nodeDirectory, taskRows, codeNewWindow, responsiveChat, chatMessages, timelineView, showScrollbar, terminal }) => {
    if (window !== window.top) return
    const tabsById = Object.fromEntries(initialTabs.map(tab => [tab.id, tab]))
    const root = initialLayout || (splitPanes
      ? { id: 'split-main', kind: 'split', direction: splitDirection, sizes: [50, 50], children: [
        { id: 'pane-main', kind: 'pane', tabIds: splitSecondChat ? initialTabs.filter(tab => tab.id !== 'chat:e2e-b').map(tab => tab.id) : initialTabs.filter(tab => tab.id !== 'system:agents').map(tab => tab.id), activeTabId: activeId },
        { id: 'pane-other', kind: 'pane', tabIds: [splitSecondChat ? 'chat:e2e-b' : 'system:agents'], activeTabId: splitSecondChat ? 'chat:e2e-b' : 'system:agents' },
      ] }
      : { id: 'pane-main', kind: 'pane', tabIds: initialTabs.map(tab => tab.id), activeTabId: activeId })
    if (!sessionStorage.getItem('workbench-fixture-initialized')) {
      sessionStorage.setItem('workbench-fixture-initialized', 'true')
      localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ state: { version: 4, tabsById, root, focusedPaneId: 'pane-main' }, version: 1 }))
      localStorage.setItem('foxwarm_last_active_tab_v1', activeId)
      localStorage.setItem('foxwarm_sidebar_collapsed_v1', 'false')
      if(freshBrowser) for(const key of ['foxwarm_workbench_state_v4','foxwarm_workbench_tabs_v3','foxwarm_last_active_tab_v1','foxwarm_last_visited_session_v1'])localStorage.removeItem(key)
    }
    if (chatMessages) localStorage.setItem('foxwarm_timeline_view_v1', timelineView)
    if (showScrollbar !== undefined) localStorage.setItem('foxwarm.contextScrollbar.showScrollbar', String(showScrollbar))
    if (themeId) localStorage.setItem('foxwarm_theme_selection_v3', JSON.stringify({ version: 3, themeId, lightThemeId: themeId, darkThemeId: themeId, colorMode }))
    if (codeNewWindow !== undefined) localStorage.setItem('foxwarm_code_open_new_window_v1', String(codeNewWindow))
    const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    window.__fetches = []
    window.__sent = []
    window.__historyReads = []
    window.__historySearchReads = []
    window.__subscriptions = []
    window.__terminalConnections = []
    window.__terminalDeletes = []
    window.__terminalCreates = []
    const terminalTemplate = terminal
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
      const pathname = url.pathname
      window.__fetches.push({ path: pathname, search: url.search, body: options.body || null })
      if (pathname.endsWith('/api/nodes/onboarding/pending')) return json({ items: [], total: 0, offset: 0, limit: 50 })
      if (pathname.endsWith('/api/tasks') && window.__failTaskPreview && url.searchParams.get('limit') === '3') return Promise.resolve(new Response('{}', { status: 503 }))
      if (pathname.endsWith('/api/auth/session')) return json({ role: 'admin' })
      if (pathname.endsWith('/api/tasks')) {
        const status = url.searchParams.get('status')
        const matching = taskRows?.filter(task => task.status === status)
        const total = matching ? matching.length : status === 'open' ? 3 : status === 'active' ? 2 : 0
        const tasks = matching?.slice(0, Number(url.searchParams.get('limit') || 50)) || []
        return json({ tasks, total, omitted: total - tasks.length })
      }
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
      if (pathname.includes('/api/terminals/') && terminal) {
        if (window.__failNextTerminalLookup) {
          window.__failNextTerminalLookup = false
          return Promise.reject(new Error('Terminal lookup unavailable'))
        }
        return json({ terminal })
      }
      if (pathname.endsWith('/api/terminals')) return json({ terminals: terminal ? [terminal] : [] })
      if (pathname.endsWith('/api/tasks')) return json({ tasks: [], omitted: 0 })
      if (pathname.endsWith('/api/nodes')) return json({ nodes: nodeDirectory })
      if (pathname.endsWith('/api/agents')) return json({ agents: [] })
      if (pathname.endsWith('/api/webui/settings')) return json({ settings: {} })
      if (pathname.endsWith('/api/models')) return json({ models: responsiveChat ? [{ key: 'fixture/model', label: 'Fixture model', contextLimit: 128000 }] : [] })
      if (pathname.endsWith('/api/commands')) return json({ commands: [] })
      if (pathname.endsWith('/api/session-list/sidebar')) return json({ version: 1, revision: 'r1', sessions: [sessionFixture('e2e-a'), sessionFixture('e2e-b'), sessionFixture('e2e-c')], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} })
      if (pathname.endsWith('/api/session-list/by-id')) return json({ results: JSON.parse(options.body).ids.filter(id => id === 'history-outside/main').map(requestedId => ({ requestedId, resolution: { kind: 'exact', sessionId: requestedId }, session: { ...sessionFixture(requestedId), displayName: 'Outside the sidebar' } })) })
      if (pathname.endsWith('/api/history/search')) {
        window.__historySearchReads.push(url.search)
        if (url.searchParams.get('query') === 'empty') return json({ results: [] })
        return json({ results: ['history-outside/main', 'e2e-a'].map(sessionId => ({ key: sessionId, sessionId, kind: 'messages', firstSeq: 7, lastSeq: 7, hasEarlier: false, hasLater: false, messages: [{ role: 'user', parts: [{ text: ('Archived navigation fixture\n').repeat(40) }], __meta: { seq: 7, timestamp: 1700000000000 } }] })) })
      }
      if (pathname.endsWith('/api/session-list/descendant-activity')) return json({ results: [] })
      if (pathname.endsWith('/api/session-list/architecture')) return json({ version: 1, revision: 'r1', sessions: [], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {}, summary: { total: 3, busy: 0, queued: 0, managed: 0, cachedTokens: 3000000000, inputTokens: 200000000, outputTokens: 30000000 } })
      if (pathname.includes('/api/session-list/')) return json({ sessions: [], results: [] })
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/message')) {
        window.__sent.push({ path: pathname, body: options.body })
        return json({ ok: true })
      }
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/history/continuous')) {
        const messages = (chatMessages || (responsiveChat ? Array.from({ length: 35 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: 'Responsive message ' + index + '\n\n' + 'Pane-local content wraps normally. '.repeat(8) }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } })) : [])).filter(message => !message.__meta?.contextBlock)
        const before = Number(url.searchParams.get('beforeSeq')) || Infinity
        const after = Number(url.searchParams.get('afterSeq')) || 0
        const candidates = messages.filter(message => message.__meta?.seq < before && message.__meta?.seq > after)
        const rows = after ? candidates.slice(0, 100) : candidates.slice(-100)
        return json({ messages: rows, firstSeq: rows[0]?.__meta?.seq, lastSeq: rows.at(-1)?.__meta?.seq, hasMore: candidates.length > 100 })
      }
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/history')) {
        window.__historyReads.push(pathname + url.search)
        const messages = chatMessages || (responsiveChat ? Array.from({ length: 35 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: 'Responsive message ' + index + '\n\n' + 'Pane-local content wraps normally. '.repeat(8) }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } })) : [])
        return json({ messages, queuedMessages: [], queueLength: window.__historySessionState?.queueLength || 0, session: { id: decodeURIComponent(pathname.split('/').at(-2)), messageCount: messages.length, historyVersion: 1, ...(responsiveChat ? { modelKey: 'fixture/model', childModelDefault: 'fixture/model', childModelPolicySource: 'explicit' } : {}), ...window.__historySessionState }, latestSeq: messages.length, historyVersion: 1, historyComplete: true })
      }
      return json({})
    }
    function sessionFixture(id) { return { tokenUsage: id === 'e2e-a' ? { cachedTokens: 12000, inputTokens: 1000, outputTokens: 200 } : { cachedTokens: 2000, inputTokens: 400, outputTokens: 100 }, id, aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, lastMessageTime: 1, busy: false } }
    class FixtureWebSocket {
      static instances = []
      static OPEN = 1
      readyState = 1
      onopen = null; onmessage = null; onclose = null; onerror = null
      constructor(url) {
        this.url = String(url)
        this.sent = []
        FixtureWebSocket.instances.push(this)
        if (new URL(url).pathname.endsWith('/terminals/stream')) window.__terminalConnections.push(url)
        queueMicrotask(() => {
        this.onopen?.({})
        if (new URL(url).pathname.endsWith('/terminals/stream') && terminal && !window.__holdTerminalReady) this.onmessage?.({ data: JSON.stringify({ type: 'ready', terminal, backlog: '' }) })
      }) }
      send(raw) {
        this.sent.push(JSON.parse(raw))
        if (!responsiveChat) return
        const data = JSON.parse(raw)
        if (data.type === 'set-subscriptions') window.__subscriptions.push(data.sessionIds)
        if (data.type === 'set-subscriptions') queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-accepted', revision: data.revision, sessionListResolutions: {}, sessionResolutions: Object.fromEntries(data.sessionIds.map(id => [id, id])) }) })
          this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-applied', revision: data.revision }) })
        })
      }
      close() { this.readyState = 3; this.onclose?.({}) }
    }
    window.__emitRealtime = data => { for (const socket of FixtureWebSocket.instances) socket.onmessage?.({ data: JSON.stringify(data) }) }
    window.WebSocket = FixtureWebSocket
  }, { freshBrowser, initialTabs: tabs, activeId: activeTabId, splitPanes: split, splitSecondChat, splitDirection, initialLayout: layout, themeId, colorMode, nodeDirectory, taskRows, codeNewWindow, responsiveChat, chatMessages, timelineView, showScrollbar, terminal })
  await page.goto(`${baseUrl}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  await page.waitForFunction(() => !!window.foxwarmTest || !!document.querySelector('[data-foxwarm-popup-root="chat"]'), { timeout: 8_000 }).catch(async error => {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '')
    throw new Error(`${error.message}; page errors: ${pageErrors.join(' | ')}; body: ${body.slice(0, 500)}`)
  })
  if (waitForSplash) await waitForWebUiReady(page)
  return page
}

async function clickReadyControl(page, selector) {
  await page.waitForSelector(selector, { visible: true })
  await page.hover(selector)
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector)
    if (!element) return false
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit === element || element.contains(hit)
  }, {}, selector)
  await page.click(selector)
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
  await page.waitForSelector(':is([data-pane-id], [data-workbench-content-pane]) > .pointer-events-none')
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}

test('pane collapse follows the direct split direction, releases space, and restores on tab selection', async () => {
  const layout = {
    id: 'split-root', kind: 'split', direction: 'row', sizes: [40, 60], children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['system:agents', 'chat:e2e-a'], activeTabId: 'chat:e2e-a' },
      { id: 'split-inner', kind: 'split', direction: 'column', sizes: [50, 50], children: [
        { id: 'pane-inner-top', kind: 'pane', tabIds: ['chat:e2e-b'], activeTabId: 'chat:e2e-b' },
        { id: 'pane-inner-bottom', kind: 'pane', tabIds: ['system:setup'], activeTabId: 'system:setup' },
      ] },
    ],
  }
  const page = await openFixture({
    tabs: [system, chat('e2e-a', false), chat('e2e-b', false), { id: 'system:setup', type: 'setup', title: 'Setup' }],
    activeTabId: 'chat:e2e-a',
    layout,
  })
  try {
    await page.waitForSelector('[data-tab-id="chat:e2e-a"]')
    const divider = await page.$('[role="separator"][aria-orientation="vertical"]')
    const dividerBox = await divider.boundingBox()
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 80, dividerBox.y + dividerBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.sizes[0] > 40)
    const before = await page.$eval('[data-pane-id="pane-main"]', el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    const neighborBefore = await page.$eval('[data-pane-id="pane-inner-top"]', el => el.getBoundingClientRect().width)
    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-workbench-collapsed-pane="true"] [data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.waitForFunction(() => !document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]'))
    const collapsed = await page.$eval('[data-pane-id="pane-main"]', el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    const neighborCollapsed = await page.$eval('[data-pane-id="pane-inner-top"]', el => el.getBoundingClientRect().width)
    assert.ok(collapsed.width < 100, `left/right split collapses to a vertical rail: ${collapsed.width}px`)
    assert.ok(neighborCollapsed > neighborBefore + 200, 'the nested sibling receives the released width')
    assert.equal(collapsed.height, before.height)
    assert.equal((await state(page)).root.children[0].collapsed, true)
    assert.deepEqual((await state(page)).root.children[0].tabIds, ['system:agents', 'chat:e2e-a'])
    assert.equal(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-workbench-tab-close="chat:e2e-a"]'), null, 'collapsed tabs do not mount their content header')

    await page.click('[data-workbench-collapsed-tab="system:agents"]')
    await page.waitForSelector('[data-tab-id="system:agents"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.children[0].collapsed === false)
    await page.waitForFunction(() => document.querySelector('[data-pane-id="pane-main"]').getBoundingClientRect().width > 300)
    const expanded = await page.$eval('[data-pane-id="pane-main"]', el => el.getBoundingClientRect().width)
    assert.ok(Math.abs(expanded - before.width) < 40, `pane returns close to its prior width: ${expanded}px vs ${before.width}px`)
    assert.equal((await state(page)).root.children[0].activeTabId, 'system:agents')
    assert.ok(await page.$('[data-tab-id="chat:e2e-a"] button[title="Close tab"]'), 'ordinary tab Close remains available')
    assert.ok(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Close pane"]'), 'a multi-pane workbench exposes Close pane')

    const nestedBefore = await page.$eval('[data-pane-id="pane-inner-top"]', el => el.getBoundingClientRect().height)
    await page.click('[data-workbench-pane-collapse="pane-inner-top"]')
    await page.waitForSelector('[data-pane-id="pane-inner-top"][data-workbench-collapsed-pane="true"] [data-workbench-collapsed-tab="chat:e2e-b"]')
    const nestedCollapsed = await page.$eval('[data-pane-id="pane-inner-top"]', el => el.getBoundingClientRect().height)
    assert.ok(nestedCollapsed < 70, `nested up/down split uses a horizontal tab strip: ${nestedCollapsed}px`)
    assert.ok(nestedBefore - nestedCollapsed > 100, 'nested lower sibling receives the released height')
    await page.click('[data-workbench-collapsed-tab="chat:e2e-b"]')
    await page.waitForSelector(':is([data-pane-id="pane-inner-top"], [data-workbench-content-pane="pane-inner-top"]) [role="textbox"][aria-label="Message"]')
  } finally { await page.close() }
})

test('vertical split collapse remains a horizontal tab bar after reload and exposes pane close for a one-tab pane', async () => {
  const layout = {
    id: 'split-column', kind: 'split', direction: 'column', sizes: [45, 55], children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a' },
      { id: 'pane-other', kind: 'pane', tabIds: ['system:agents'], activeTabId: 'system:agents' },
    ],
  }
  const page = await openFixture({ tabs: [system, chat('e2e-a', false)], layout })
  try {
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    assert.ok(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Close pane"]'), 'each of two panes exposes Close pane even when it has only one tab')
    const beforeHeight = await page.$eval('[data-pane-id="pane-main"]', el => el.getBoundingClientRect().height)
    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-workbench-collapsed-pane="true"] [data-workbench-collapsed-tab="chat:e2e-a"]')
    const collapsedHeight = await page.$eval('[data-pane-id="pane-main"]', el => el.getBoundingClientRect().height)
    assert.ok(collapsedHeight < 70, `up/down split collapses to a horizontal strip: ${collapsedHeight}px`)
    assert.ok(beforeHeight - collapsedHeight > 200, 'the lower pane receives the released height')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)
    await page.waitForSelector('[data-workbench-collapsed-pane="true"] [data-workbench-collapsed-tab="chat:e2e-a"]')
    assert.equal(await page.$('[role="textbox"][aria-label="Message"]'), null, 'persisted collapse reloads without mounting pane content')
    await page.click('[data-workbench-collapsed-pane="true"] button[title="Expand pane"]')
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.waitForFunction(() => document.querySelector('[data-pane-id="pane-main"]').getBoundingClientRect().height > 200)
    const restoredHeight = await page.$eval('[data-pane-id="pane-main"]', el => el.getBoundingClientRect().height)
    assert.ok(Math.abs(restoredHeight - beforeHeight) < 40, 'reload keeps the original expanded size available')

    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.click('[data-workbench-pane-collapse="pane-other"]')
    await page.waitForSelector('[data-workbench-collapsed-tab="system:agents"]')
    assert.equal(await page.$('[data-workbench-tab-handle]'), null, 'both panes can stay collapsed without mounting content')
    assert.equal((await state(page)).root.children.filter(pane => pane.collapsed).length, 2)
    assert.equal(await page.$$eval('[data-workbench-collapsed-pane]', panes => panes.every(pane => pane.getBoundingClientRect().height < 70)), true, 'all-collapsed panes remain compact instead of filling the empty space')
    await page.click('[data-workbench-collapsed-tab="system:agents"]')
    await page.waitForSelector('[data-workbench-tab-handle="system:agents"]')
    await page.click('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.waitForFunction(() => document.querySelector('[data-pane-id="pane-main"]').getBoundingClientRect().height > 200)
    assert.ok(Math.abs(await page.$eval('[data-pane-id="pane-main"]', el => el.getBoundingClientRect().height) - beforeHeight) < 40, 'expanding from the all-collapsed layout restores the original split')

    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.click(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) button[title="Close pane"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.kind === 'pane')
    assert.equal(await page.$('[data-workbench-pane-drag-area]'), null, 'closing the other pane removes the whole-pane drag control')
    assert.equal(await page.$('button[title="Collapse pane"]'), null)
    assert.equal((await state(page)).root.collapsed, false, 'moving the closed pane tab into the remaining pane activates and expands it')
    await page.waitForSelector('[data-tab-id="system:agents"]')
    await page.click('[data-tab-id="chat:e2e-a"]')
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    assert.equal(await page.$('[data-workbench-pane-collapse]'), null, 'the restored lone pane has no collapse control')
  } finally { await page.close() }
})

test('a persisted lone collapsed pane keeps its tab expansion entry without pane drag controls', async () => {
  const layout = { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a', collapsed: true }
  const page = await openFixture({ tabs: [chat('e2e-a', false)], layout })
  try {
    await page.waitForSelector('[data-workbench-collapsed-tab="chat:e2e-a"]')
    assert.equal(await page.$('[data-workbench-pane-drag-area]'), null)
    assert.equal(await page.$('button[title="Collapse pane"]'), null)
    assert.ok(await page.$('button[title="Expand pane"]'))
    assert.equal(await page.$('[role="textbox"][aria-label="Message"]'), null)
    await page.click('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    assert.equal((await state(page)).root.collapsed, false)
    assert.equal(await page.$('[data-workbench-pane-collapse]'), null)
  } finally { await page.close() }
})

test('explicit hash navigation activates and expands an existing collapsed-pane tab', async () => {
  const layout = {
    id: 'split-main',
    kind: 'split',
    direction: 'row',
    sizes: [50, 50],
    children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a', collapsed: true },
      { id: 'pane-other', kind: 'pane', tabIds: ['system:agents'], activeTabId: 'system:agents' },
    ],
  }
  const page = await openFixture({ tabs: [chat('e2e-a', false), system], activeTabId: 'system:agents', hash: '#tab/system:agents', layout })
  try {
    await page.waitForSelector('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.evaluate(() => { window.location.hash = '#tab/chat%3Ae2e-a' })
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    assert.equal((await state(page)).root.children.find(pane => pane.id === 'pane-main').collapsed, false, 'explicit hash navigation expands the activated pane')
  } finally { await page.close() }
})

test('collapsing Terminal detaches without closing resources and kept Code stays mounted', async () => {
  const terminal = { id: 'term-collapse', nodeId: 'master', cwd: '/workspace', pid: 42, cols: 80, rows: 24 }
  const terminalTab = { id: 'terminal:term-collapse', type: 'terminal', terminalId: terminal.id, nodeId: terminal.nodeId, cwd: terminal.cwd, title: 'Terminal' }
  const terminalPage = await openFixture({ tabs: [terminalTab, chat('e2e-a', false), system], activeTabId: terminalTab.id, hash: `#tab/${encodeURIComponent(terminalTab.id)}`, split: true, terminal })
  try {
    // Start the collapse probe from the existing Terminal tab after its ready event reconciles startup navigation.
    await terminalPage.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['terminal:term-collapse'].title === 'workspace')
    await terminalPage.waitForSelector('[data-tab-id="terminal:term-collapse"]')
    await terminalPage.click('[data-tab-id="terminal:term-collapse"]')
    await terminalPage.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    const terminalPaneId = await terminalPage.$eval('[data-tab-id="terminal:term-collapse"]', tab => tab.closest('[data-pane-id]').dataset.paneId)
    await terminalPage.click(`[data-workbench-pane-collapse="${terminalPaneId}"]`)
    await terminalPage.waitForSelector('[data-workbench-collapsed-tab="terminal:term-collapse"]')
    assert.equal(await terminalPage.$('[data-terminal-header]'), null, 'Terminal view unmounts while its tab record remains')
    assert.ok((await state(terminalPage)).tabsById['terminal:term-collapse'])
    assert.deepEqual(await terminalPage.evaluate(() => window.__terminalDeletes), [], 'collapse does not run terminal resource close')
    await terminalPage.click('[data-workbench-collapsed-tab="terminal:term-collapse"]')
    await terminalPage.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    assert.equal((await state(terminalPage)).tabsById['terminal:term-collapse'].terminalId, 'term-collapse')
    assert.deepEqual(await terminalPage.evaluate(() => window.__terminalCreates), [], 'expansion reattaches the existing terminal rather than creating a replacement')
  } finally { await terminalPage.close() }

  const codeTab = { id: 'vscode-web', type: 'vscode', title: 'Code' }
  const codePage = await openFixture({ tabs: [codeTab, chat('e2e-a', false), system], activeTabId: codeTab.id, hash: '#tab/vscode-web', split: true })
  try {
    await codePage.waitForSelector('[data-foxwarm-vscode-web-frame="true"]')
    const codeFrameIdentity = await codePage.$eval('[data-foxwarm-vscode-web-frame="true"]', frame => {
      const token = `frame-${Math.random()}`
      frame.dataset.testFrameIdentity = token
      return token
    })
    assert.ok(await codePage.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Close pane"]'))
    await codePage.click('[data-tab-id="chat:e2e-a"]')
    await codePage.waitForSelector('[role="textbox"][aria-label="Message"]')
    assert.ok(await codePage.$('[data-foxwarm-vscode-web-frame="true"]'), 'ordinary switching keeps the inactive Code iframe')
    await codePage.click('[data-workbench-pane-collapse="pane-main"]')
    await codePage.waitForSelector('[data-workbench-collapsed-tab="vscode-web"]')
    await codePage.waitForFunction(() => {
      const frame = document.querySelector('[data-foxwarm-vscode-web-frame="true"]')
      return frame && getComputedStyle(frame).visibility === 'hidden' && getComputedStyle(frame).pointerEvents === 'none'
    })
    assert.ok((await state(codePage)).tabsById['vscode-web'], 'Code tab record stays available while its pane is collapsed')
    assert.equal(await codePage.$eval('[data-foxwarm-vscode-web-frame="true"]', frame => frame.dataset.testFrameIdentity), codeFrameIdentity, 'collapse keeps the same iframe object')
    await codePage.click('[data-workbench-collapsed-tab="vscode-web"]')
    await codePage.waitForSelector('[data-foxwarm-vscode-web-frame="true"]')
    assert.equal(await codePage.$eval('[data-foxwarm-vscode-web-frame="true"]', frame => frame.dataset.testFrameIdentity), codeFrameIdentity, 'expansion reuses the same iframe object')
  } finally { await codePage.close() }
})

test('Terminal disconnect puts a compact red reconnect action after PID and restores the same remote PTY', async () => {
  const terminal = { id: 'term-reconnect', nodeId: 'remote-fixture', cwd: '/workspace/project', pid: 4242, cols: 80, rows: 24 }
  const terminalTab = { id: 'terminal:term-reconnect', type: 'terminal', terminalId: terminal.id, nodeId: terminal.nodeId, cwd: terminal.cwd, title: 'Terminal' }
  const layout = { id: 'split-main', kind: 'split', direction: 'column', sizes: [65, 35], children: [
    { id: 'pane-other', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a' },
    { id: 'pane-main', kind: 'pane', tabIds: [terminalTab.id], activeTabId: terminalTab.id },
  ] }
  const page = await openFixture({ tabs: [terminalTab, chat('e2e-a', false)], activeTabId: terminalTab.id, hash: `#tab/${encodeURIComponent(terminalTab.id)}`, terminal, layout })
  const action = '[data-terminal-header] [role="status"] + button'
  try {
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    assert.equal(await page.$('[data-terminal-header] [role="status"]'), null, 'connected terminals add no disconnect notice')
    const initialHeight = await page.$eval('[data-terminal-header]', header => header.getBoundingClientRect().height)
    await page.evaluate(() => {
      window.__reconnectTextarea = document.querySelector('.xterm-helper-textarea')
      window.__disconnectedSocket = window.WebSocket.instances.find(socket => socket.url.includes('/terminals/stream'))
      window.__disconnectedSocket.close()
    })
    await page.waitForSelector(action)
    const header = await page.$eval('[data-terminal-header]', header => {
      const notice = header.querySelector('[role="status"]')
      const button = notice.nextElementSibling
      return {
        preceding: notice.parentElement.previousElementSibling.textContent,
        text: notice.textContent,
        color: getComputedStyle(notice).color,
        height: header.getBoundingClientRect().height,
        buttonHeight: button.getBoundingClientRect().height,
      }
    })
    assert.equal(header.preceding, 'pid 4242')
    assert.equal(header.text, 'Disconnected')
    assert.doesNotMatch(await page.$eval('[data-terminal-header]', header => header.textContent), /status disconnected/)
    assert.ok(header.buttonHeight <= 22, JSON.stringify(header))
    assert.equal(header.height, initialHeight, 'the existing wide status row keeps its height')
    assert.ok(await page.$eval('[data-terminal-header] [role="status"]', notice => {
      const [r, g, b] = getComputedStyle(notice).color.match(/[\d.]+/g).map(Number)
      return r > g && r > b
    }), `danger text is red: ${header.color}`)
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), [])
    await workbenchScreenshot(page, 'terminal-disconnected-wide.png')
    const buttonBox = await (await page.$(action)).boundingBox()
    await page.mouse.move(buttonBox.x + 5, buttonBox.y + buttonBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(buttonBox.x + 20, buttonBox.y + buttonBox.height / 2, { steps: 4 })
    assert.equal(await page.$('[data-pane-drag-overlay]'), null, 'Reconnect pointer motion does not start pane dragging')
    await page.mouse.move(buttonBox.x + buttonBox.width + 10, buttonBox.y + buttonBox.height / 2)
    await page.mouse.up()

    await page.setViewport({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]').getBoundingClientRect().right <= innerWidth)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.ok(await page.$eval(action, button => button.getBoundingClientRect().right <= innerWidth))
    await workbenchScreenshot(page, 'terminal-disconnected-narrow.png')

    await page.evaluate(() => { window.__failNextTerminalLookup = true })
    await page.click(action)
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('Terminal lookup unavailable'))
    assert.equal(await page.$eval(action, button => button.disabled), false, 'a failed reconnect can be retried')
    assert.doesNotMatch(await page.$eval('[data-terminal-header]', header => header.textContent), /status error/)
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [])
    await page.evaluate(() => { window.__holdTerminalReady = true })
    await page.click(action)
    await page.waitForFunction(() => window.__terminalConnections.length === 2)
    assert.equal(await page.$eval(action, button => button.disabled), true)
    assert.doesNotMatch(await page.$eval('[data-terminal-header]', header => header.textContent), /status connecting/)
    await page.evaluate(terminal => {
      const previous = window.__disconnectedSocket
      previous.onclose?.({})
      previous.onerror?.({})
      previous.onmessage?.({ data: JSON.stringify({ type: 'exit', exitCode: 0 }) })
      const current = window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).at(-1)
      current.onmessage?.({ data: JSON.stringify({ type: 'ready', terminal, backlog: 'restored remote prompt\r\n\x1b[6n' }) })
    }, terminal)
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('restored remote prompt'))
    assert.equal(await page.$('[data-terminal-header] [role="status"]'), null)
    assert.equal(await page.evaluate(() => window.__reconnectTextarea === document.querySelector('.xterm-helper-textarea')), true, 'reconnect reuses xterm')
    assert.deepEqual(await page.evaluate(() => window.__terminalConnections.map(url => new URL(url).searchParams.get('terminalId'))), [terminal.id, terminal.id])
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [], 'reconnect never creates a second surviving PTY')
    assert.deepEqual(await page.evaluate(() => window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).at(-1).sent.filter(message => message.type === 'input')), [], 'backlog query replies stay suppressed')
    await page.focus('.xterm-helper-textarea')
    await page.keyboard.type('x')
    assert.deepEqual(await page.evaluate(() => window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).flatMap(socket => socket.sent.filter(message => message.type === 'input'))), [{ type: 'input', data: 'x' }], 'one key sends once after reconnect')
    await page.evaluate(() => {
      const current = window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).at(-1)
      current.sent.length = 0
    })
    await page.setViewport({ width: 1400, height: 900 })
    await page.waitForFunction(() => window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).at(-1).sent.some(message => message.type === 'resize' && message.cols > 80))
    assert.ok(await page.$('[data-workbench-pane-drag-area="pane-main"]'), 'the existing pane drag area remains available')
    await workbenchScreenshot(page, 'terminal-reconnected-wide.png')
  } finally { await page.close() }
})

test('a newly created Terminal reconnects its remembered ID and PTY exit never offers reconnect', async () => {
  const terminal = { id: 'term-template', nodeId: 'remote-fixture', cwd: '/workspace/new', pid: 4243, cols: 80, rows: 24 }
  const terminalTab = { id: 'terminal:draft', type: 'terminal', nodeId: terminal.nodeId, cwd: terminal.cwd, createMode: 'new', title: 'Terminal' }
  const page = await openFixture({ tabs: [terminalTab], activeTabId: terminalTab.id, hash: `#tab/${encodeURIComponent(terminalTab.id)}`, terminal })
  try {
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates.map(request => ({ nodeId: request.nodeId, cwd: request.cwd }))), [{ nodeId: terminal.nodeId, cwd: terminal.cwd }])
    await page.evaluate(() => window.WebSocket.instances.find(socket => socket.url.includes('/terminals/stream')).close())
    await page.waitForSelector('[data-terminal-header] [role="status"] + button')
    await page.click('[data-terminal-header] [role="status"] + button')
    await page.waitForFunction(() => window.__terminalConnections.length === 2 && document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    assert.deepEqual(await page.evaluate(() => window.__terminalConnections.map(url => new URL(url).searchParams.get('terminalId'))), ['term-reopened', 'term-reopened'])
    assert.equal(await page.evaluate(() => window.__terminalCreates.length), 1)
    await page.evaluate(() => {
      const current = window.WebSocket.instances.filter(socket => socket.url.includes('/terminals/stream')).at(-1)
      current.onmessage?.({ data: JSON.stringify({ type: 'exit', exitCode: 0 }) })
      current.close()
      current.onerror?.({})
    })
    await page.waitForFunction(() => !document.querySelector('[data-terminal-header]') || document.querySelector('[data-terminal-header]').textContent.includes('status closed'))
    assert.equal(await page.$('[data-terminal-header] [role="status"]'), null)
    assert.equal(await page.evaluate(() => window.__terminalCreates.length), 1, 'PTY exit never creates a replacement')
    assert.equal(await page.evaluate(() => window.__terminalConnections.length), 2)
  } finally { await page.close() }
})

function findFixturePane(root, paneId) {
  if (root.kind === 'pane') return root.id === paneId ? root : null
  return root.children.map(child => findFixturePane(child, paneId)).find(Boolean) || null
}

async function paneDragPoint(page, paneId) {
  return page.evaluate(paneId => {
    const area = document.querySelector(`[data-workbench-pane-drag-area="${paneId}"]`)
    if (!area) throw new Error(`Expected a pane header drag area: ${paneId}`)
    const rect = area.getBoundingClientRect()
    for (const y of [rect.top + rect.height / 2, rect.top + 8, rect.bottom - 8]) {
      for (const x of [rect.left + rect.width / 2, rect.left + 8, rect.right - 8, rect.left + rect.width / 4]) {
        const hit = document.elementFromPoint(x, y)
        if (hit?.matches('[data-workbench-pane-drag-area], [data-workbench-pane-drag-blank]') && hit.closest('[data-workbench-pane-drag-area]') === area) return { x, y }
      }
    }
    throw new Error(`Expected actual empty space in the pane header: ${paneId}`)
  }, paneId)
}

async function dragPane(page, sourcePaneId, targetPaneId, edge, { cancel = false, duringDrag } = {}) {
  await waitForTabPaint(page)
  const start = await paneDragPoint(page, sourcePaneId)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y, { steps: 4 })
  await page.waitForSelector('[data-pane-drag-overlay]')
  if (duringDrag) await duringDrag()
  const target = await page.$(`:is([data-pane-id="${targetPaneId}"], [data-workbench-content-pane="${targetPaneId}"]) [data-workbench-pane-drop="${edge}"]`)
  const targetBox = await target.boundingBox()
  assert.ok(targetBox)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 })
  if (!cancel) {
    await page.waitForFunction((paneId, edge) => [...document.querySelectorAll('[data-workbench-content-pane="' + paneId + '"] [data-workbench-pane-drop="' + edge + '"], [data-pane-id="' + paneId + '"] [data-workbench-pane-drop="' + edge + '"]')].some(element => element.className.includes('bg-fw-accent/10')), {}, targetPaneId, edge)
  }
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForFunction(() => !document.querySelector('[data-pane-drag-overlay]'))
}

test('whole-pane dragging preserves its tabs and selection across splits, including collapsed dragging and cancellation', async () => {
  const layout = {
    id: 'split-root', kind: 'split', direction: 'row', sizes: [40, 60], children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['system:agents', 'chat:e2e-a'], activeTabId: 'chat:e2e-a' },
      { id: 'split-inner', kind: 'split', direction: 'column', sizes: [50, 50], children: [
        { id: 'pane-inner-top', kind: 'pane', tabIds: ['chat:e2e-b'], activeTabId: 'chat:e2e-b' },
        { id: 'pane-inner-bottom', kind: 'pane', tabIds: ['system:setup'], activeTabId: 'system:setup' },
      ] },
    ],
  }
  const page = await openFixture({ tabs: [system, chat('e2e-a'), chat('e2e-b', false), { id: 'system:setup', type: 'setup', title: 'Setup' }], layout, responsiveChat: true })
  try {
    await page.waitForSelector('[data-workbench-pane-drag-area="pane-main"]')
    await page.waitForSelector('[data-workbench-content-tab="chat:e2e-b"] [data-chat-message-anchor-key]')
    await page.evaluate(() => {
      window.__paneMoveChats = [...document.querySelectorAll('.foxwarm-chat-root')]
      window.__paneMoveHistory = window.__historyReads.length
    })
    const initial = await state(page)
    await dragPane(page, 'pane-main', 'pane-inner-top', 'right', { cancel: true })
    assert.deepEqual((await state(page)).root, initial.root, 'Escape leaves the entire layout unchanged')

    await dragPane(page, 'pane-main', 'pane-inner-bottom', 'right')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.id === 'split-inner')
    assert.ok(await page.evaluate(() => window.__paneMoveChats.every(root => root.isConnected)), 'whole-pane movement keeps both existing Chat roots')
    assert.equal(await page.evaluate(() => window.__historyReads.length), await page.evaluate(() => window.__paneMoveHistory), 'whole-pane movement does not initialize history again')
    const moved = await state(page)
    assert.deepEqual(findFixturePane(moved.root, 'pane-main'), { ...layout.children[0], collapsed: false })
    assert.deepEqual(moved.tabsById, initial.tabsById, 'moving a pane does not replace, promote, close, or duplicate its tabs')
    assert.equal(moved.root.children[1].direction, 'row')
    assert.deepEqual(moved.root.children[1].children.map(pane => pane.id), ['pane-inner-bottom', 'pane-main'])

    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await dragPane(page, 'pane-main', 'pane-inner-top', 'top')
    const collapsedMoved = await state(page)
    const collapsedPane = findFixturePane(collapsedMoved.root, 'pane-main')
    assert.deepEqual(collapsedPane.tabIds, ['system:agents', 'chat:e2e-a'])
    assert.equal(collapsedPane.activeTabId, 'chat:e2e-a')
    assert.equal(collapsedPane.collapsed, true)
    assert.equal(collapsedMoved.root.children[0].direction, 'column')
    assert.deepEqual(collapsedMoved.root.children[0].children.map(pane => pane.id), ['pane-main', 'pane-inner-top'])
    assert.equal(await page.$eval(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="tablist"]', el => el.getAttribute('aria-orientation')), 'horizontal', 'moving to a new parent split updates the collapsed direction')
    assert.equal(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"]'), null, 'collapsed dragging never mounts tab content')
    await page.click('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]')
  } finally { await page.close() }
})

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
    await waitForWebUiReady(page)
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
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .pointer-events-none')
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

  const otherPage = await openFixture({ split: true, responsiveChat: true })
  try {
    await otherPage.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    await otherPage.waitForSelector('.foxwarm-chat-root [data-chat-message-anchor-key]')
    await otherPage.evaluate(() => { window.__movingChat = document.querySelector('.foxwarm-chat-root'); window.__moveHistory = window.__historyReads.length })
    await drag(otherPage, '[data-workbench-tab-handle="chat:e2e-a"]', '[data-pane-id="pane-other"]')
    await otherPage.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['chat:e2e-a']?.preview === false)
    assert.equal((await state(otherPage)).hash, '#tab/chat:e2e-a')
    assert.ok(await otherPage.evaluate(() => window.__movingChat.isConnected), 'cross-pane tab movement retains the original Chat')
    assert.equal(await otherPage.evaluate(() => window.__historyReads.length), await otherPage.evaluate(() => window.__moveHistory))
    assert.ok(await otherPage.$(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) [data-tab-id="chat:e2e-a"]'))
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
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]')
    assert.equal(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id]'), null)
    assert.equal(await page.$(paneButtons), null)
    assert.equal(await page.$('[data-workbench-pane-drag-area], [data-workbench-pane-collapse]'), null, 'a lone single-tab pane omits whole-pane drag and collapse controls')
    assert.ok(await page.$('[data-workbench-tab-handle="chat:e2e-a"]'), 'ordinary tab drag remains available')
    assert.ok(await page.$('[data-workbench-tab-close="chat:e2e-a"]'), 'ordinary tab Close remains available')
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
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id="chat:e2e-b"]')
    assert.equal(await page.$$eval(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval(paneButtons, nodes => nodes.length), 2, 'a single-pane workbench omits Close pane rather than disabling it')
    assert.equal(await page.$('[data-workbench-pane-drag-area], [data-workbench-pane-collapse]'), null, 'adding another tab does not enable pane drag or collapse')
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
        && !!document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]')
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
    const dragBeforeRelease = await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) > .pointer-events-none')
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

async function waitForTabPaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function openOverflowFixture(activeIndex = 0) {
  const groups = ['a', 'b'].map(group => Array.from({ length: 12 }, (_, index) => chat(index ? `scroll-${group}-${index}` : `e2e-${group}`, false)))
  const layout = { id: 'split-main', kind: 'split', direction: 'row', sizes: [50, 50], children: groups.map((tabs, index) => ({
    id: index ? 'pane-other' : 'pane-main', kind: 'pane', tabIds: tabs.map(tab => tab.id), activeTabId: tabs[activeIndex].id,
  })) }
  const page = await openFixture({ tabs: groups.flat(), activeTabId: groups[0][activeIndex].id, layout, responsiveChat: true })
  await page.waitForSelector('[data-pane-id="pane-other"] .foxwarm-workbench-tab-row')
  await waitForTabPaint(page)
  return page
}

async function tabScrollPositions(page) {
  return page.$$eval('.foxwarm-workbench-tab-row', rows => rows.map(row => row.scrollLeft))
}

async function scrollTabRow(page, paneId, deltaY = 750) {
  const box = await (await page.$(`[data-pane-id="${paneId}"] .foxwarm-workbench-tab-row`)).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel({ deltaY })
  await waitForTabPaint(page)
}

async function visibleTabControl(page, paneId, close = true) {
  return page.evaluate(({ paneId, close }) => {
    const row = document.querySelector(`[data-pane-id="${paneId}"] .foxwarm-workbench-tab-row`)
    const bounds = row.getBoundingClientRect()
    for (const tab of row.children) {
      if (tab.dataset.tabActive) continue
      const control = tab.querySelector(close ? 'button' : 'span')
      const rect = control.getBoundingClientRect()
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      if (rect.left > bounds.left + 8 && rect.right < bounds.right - 8 && control.contains(document.elementFromPoint(x, y))) return { id: tab.dataset.tabId, x, y }
    }
    throw new Error('Expected an inactive visible tab control')
  }, { paneId, close })
}

async function mousePressAt(page, point, button = 'left') {
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ button })
  await new Promise(resolve => setTimeout(resolve, 100))
  await page.mouse.up({ button })
  await waitForTabPaint(page)
}

async function tabToControl(page, selector) {
  // Enter the target strip before walking native Tab order, not every Chat's controls.
  await page.$eval(selector, element => element.closest('.foxwarm-workbench-tab-row').querySelector('[data-tab-id]').focus())
  for (let index = 0; index < 120; index++) {
    if (await page.evaluate(selector => document.activeElement?.matches(selector), selector)) return
    await page.keyboard.press('Tab')
  }
  assert.fail(`Keyboard navigation did not reach ${selector}`)
}

async function assertTabVisible(page, tabId) {
  await page.waitForFunction(tabId => {
    const tab = document.querySelector(`[data-tab-id="${tabId}"]`)
    if (!tab) return false
    const rect = tab.getBoundingClientRect(), row = tab.parentElement.getBoundingClientRect()
    return rect.left >= row.left - 1 && rect.right <= row.right + 1
  }, {}, tabId)
}

test('Workbench tab scroll respects metadata, pane focus and split resizing but reveals explicit navigation', async () => {
  const page = await openOverflowFixture()
  try {
    await scrollTabRow(page, 'pane-main')
    await scrollTabRow(page, 'pane-other')
    const before = await tabScrollPositions(page)
    assert.ok(before.every(left => left >= 700))
    await page.evaluate(() => window.__emitRealtime({ type: 'session-list-delta', sessions: [{ id: 'e2e-a', aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, lastMessageTime: 2, busy: true }] }))
    await page.waitForSelector('[data-session-id="e2e-a"] .runtime-busy-spinner')
    await waitForTabPaint(page)
    assert.deepEqual(await tabScrollPositions(page), before, 'a normal busy delta must not reveal either old active tab')

    const divider = await (await page.$('[role="separator"][aria-orientation="vertical"]')).boundingBox()
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
    await page.mouse.down()
    await page.mouse.move(divider.x - 45, divider.y + divider.height / 2, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.sizes[0] < 49)
    await waitForTabPaint(page)
    assert.deepEqual(await tabScrollPositions(page), before, 'publishing split sizes must preserve manual tab scrolling')

    const composer = await (await page.$('[data-workbench-content-tab="chat:e2e-b"] [role="textbox"][aria-label="Message"]')).boundingBox()
    await mousePressAt(page, { x: composer.x + composer.width / 2, y: composer.y + composer.height / 2 })
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId)), 'pane-other')
    assert.deepEqual(await tabScrollPositions(page), before, 'pane focus is not a tab reveal request')

    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await assertTabVisible(page, 'chat:e2e-b')
    assert.equal((await tabScrollPositions(page))[0], before[0], 'same-ID navigation reveals only its target pane')
    await page.evaluate(() => window.foxwarmTest.switchToSession('scroll-b-11'))
    await assertTabVisible(page, 'chat:scroll-b-11')
    assert.equal((await state(page)).root.children[1].activeTabId, 'chat:scroll-b-11')

    const range = await (await page.$('[data-pane-id="pane-other"] input[aria-label="Scroll tabs"]')).boundingBox()
    await page.mouse.move(range.x + range.width * .35, range.y + range.height / 2)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 100))
    const rangeDown = (await tabScrollPositions(page))[1]
    assert.ok(rangeDown > 0 && rangeDown < 650, 'the overflow range is not pulled back to the active tab during its press')
    await page.mouse.move(range.x + range.width * .65, range.y + range.height / 2, { steps: 5 })
    await page.mouse.up()
    assert.ok((await tabScrollPositions(page))[1] > rangeDown + 100)
  } finally { await page.close() }
})

test('Workbench tab Close and middle gestures keep their pressed target while the strip is scrolled', async () => {
  const page = await openOverflowFixture()
  try {
    await scrollTabRow(page, 'pane-other')
    const target = await visibleTabControl(page, 'pane-other')
    await mousePressAt(page, target)
    let snapshot = await state(page)
    assert.equal(snapshot.tabsById[target.id], undefined, 'X closes its original inactive target')
    assert.equal(snapshot.root.children[1].activeTabId, 'chat:e2e-b')
    assert.ok((await tabScrollPositions(page))[1] >= 700)
    assert.equal(await page.$('[data-workbench-pane-drop-overlay]'), null, 'Close never starts a drag')

    const middleTarget = await visibleTabControl(page, 'pane-other', false)
    await mousePressAt(page, middleTarget, 'middle')
    snapshot = await state(page)
    assert.equal(snapshot.tabsById[middleTarget.id], undefined, 'middle Close retains the pressed tab identity')
    assert.ok(snapshot.tabsById['chat:e2e-b'])

    const canceledTarget = await visibleTabControl(page, 'pane-other', false)
    const beforeCancel = Object.keys(snapshot.tabsById)
    await page.mouse.move(canceledTarget.x, canceledTarget.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.wheel({ deltaY: -200 })
    await waitForTabPaint(page)
    assert.notEqual(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-tab-id]')?.dataset.tabId, canceledTarget), canceledTarget.id)
    await page.mouse.up({ button: 'middle' })
    await waitForTabPaint(page)
    assert.deepEqual(Object.keys((await state(page)).tabsById), beforeCancel, 'releasing over a different tab must not close that tab')

    const releaseTarget = await visibleTabControl(page, 'pane-other', false)
    const toolbar = await (await page.$('[data-pane-id="pane-other"] button[title="Split right with active tab"]')).boundingBox()
    await page.mouse.move(toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(releaseTarget.x, releaseTarget.y)
    await page.mouse.up({ button: 'middle' })
    await waitForTabPaint(page)
    assert.deepEqual(Object.keys((await state(page)).tabsById), beforeCancel, 'a mouseup without a tab press cannot independently close it')
  } finally { await page.close() }
})

test('Workbench tab restore, keyboard Close and active-close fallback retain normal navigation', async () => {
  const page = await openOverflowFixture(11)
  try {
    await assertTabVisible(page, 'chat:scroll-a-11')
    await assertTabVisible(page, 'chat:scroll-b-11')
    assert.ok((await tabScrollPositions(page)).every(left => left > 700), 'initial restored tabs are revealed in both panes')
    for (const [tabId, key] of [['chat:scroll-b-6', 'Enter'], ['chat:scroll-b-7', ' ']]) {
      await tabToControl(page, `[data-tab-id="${tabId}"] button[title="Close tab"]`)
      await page.keyboard.press(key)
      await page.waitForFunction(tabId => !document.querySelector(`[data-tab-id="${tabId}"]`), {}, tabId)
      assert.equal((await state(page)).root.children[1].activeTabId, 'chat:scroll-b-11', 'keyboard Close does not select its inactive parent tab')
    }
    await tabToControl(page, '[data-tab-id="chat:scroll-b-9"]')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-tab-id="chat:scroll-b-9"]')?.dataset.tabActive === 'true')
    await assertTabVisible(page, 'chat:scroll-b-9')
    const close = await (await page.$('[data-tab-id="chat:scroll-b-9"] button[title="Close tab"]')).boundingBox()
    await mousePressAt(page, { x: close.x + close.width / 2, y: close.y + close.height / 2 })
    await assertTabVisible(page, 'chat:scroll-b-10')
    const snapshot = await state(page)
    assert.equal(snapshot.root.children[1].activeTabId, 'chat:scroll-b-10')
    assert.equal(snapshot.hash, '#tab/chat:scroll-b-10')
    assert.equal(snapshot.tabsById['chat:scroll-b-9'], undefined)
  } finally { await page.close() }
})

test('each single-tab pane uses its header while multi-tab panes retain their strips and controls', async () => {
  const page = await openFixture({ split: true })
  try {
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-a"]')
    await page.waitForSelector('[data-workbench-tab-handle="system:agents"]')
    assert.equal(await page.$('[data-tab-id]'), null)
    if (process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_SINGLE_TAB_SCREENSHOT_DIR}/single-tab-panes.png` })
    assert.equal(await page.$$eval('button[title="Close pane"]', nodes => nodes.length), 2)
    assert.equal(await page.$('button[title="Split right with active tab"], button[title="Split down with active tab"]'), null)
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await page.waitForSelector('[data-workbench-tab-handle="chat:e2e-b"]')
    assert.equal(await page.$$eval('button[title="Close pane"]', nodes => nodes.length), 2, 'replacing the preview keeps both panes and their Close actions')
    await page.click('[data-workbench-tab-handle="chat:e2e-b"]', { count: 2 })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-c'))
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id="chat:e2e-c"]')
    assert.equal(await page.$$eval(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Split right with active tab"], :is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Split down with active tab"], :is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Close pane"]', nodes => nodes.length), 3)
    assert.ok(await page.$(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) button[title="Close pane"]'))
    assert.equal(await page.$(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) button[title="Split right with active tab"], :is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) button[title="Split down with active tab"]'), null)
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id="chat:e2e-c"] button[title="Close tab"]')
    await page.waitForFunction(() => !document.querySelector('[data-tab-id="chat:e2e-c"]'))
    assert.ok(await page.$('[data-workbench-tab-handle="chat:e2e-b"]'))
    assert.equal(await page.$$eval('button[title="Close pane"]', nodes => nodes.length), 2)
  } finally { await page.close() }
})

test('sole-tab header whitespace moves its pane without a Move control or dragging header content', async () => {
  const terminal = { id: 'term-blank-header', nodeId: 'master', cwd: '/workspace', pid: 42, cols: 80, rows: 24 }
  const tabs = [chat('e2e-a', false), system,
    { id: 'system:search', type: 'search', title: 'History' },
    { id: 'system:logs', type: 'logs', title: 'Logs' },
    { id: 'system:tasks', type: 'tasks', title: 'Tasks' },
    { id: 'terminal:term-blank-header', type: 'terminal', title: 'Terminal', terminalId: terminal.id, cwd: terminal.cwd, nodeId: terminal.nodeId }]
  tabs.push(nodesTab)
  for (const tab of tabs) {
    const layout = { id: 'split-main', kind: 'split', direction: 'row', sizes: [50, 50], children: [
      { id: 'pane-main', kind: 'pane', tabIds: [tab.id], activeTabId: tab.id },
      { id: 'pane-other', kind: 'pane', tabIds: ['chat:e2e-b'], activeTabId: 'chat:e2e-b' },
    ] }
    const page = await openFixture({ tabs: [tab, chat('e2e-b', false)], activeTabId: tab.id, layout, responsiveChat: true, terminal: tab.type === 'terminal' ? terminal : null })
    try {
      await page.waitForSelector('[data-workbench-pane-drag-area="pane-main"]')
      assert.equal(await page.$('[data-workbench-pane-drag-handle], button[title="Drag pane"]'), null)
      assert.equal(await page.$$eval('[data-workbench-content-pane="pane-main"] [data-workbench-pane-controls] button', buttons => buttons.length), 2, 'only Collapse and Close occupy the pane toolbar')
      const before = await state(page)
      await dragPane(page, 'pane-main', 'pane-other', 'right', { cancel: true })
      assert.deepEqual((await state(page)).root, before.root)
      assert.deepEqual((await state(page)).tabsById, before.tabsById)

      if (tab.type === 'logs') {
        const input = await (await page.$('[data-workbench-content-pane="pane-main"] input[aria-label="Log date and time"]')).boundingBox()
        await page.mouse.move(input.x + input.width / 2, input.y + input.height / 2)
        await page.mouse.down()
        await page.mouse.move(input.x + input.width / 2 + 12, input.y + input.height / 2, { steps: 4 })
        assert.equal(await page.$('[data-pane-drag-overlay]'), null, 'header input remains an input rather than a pane drag activator')
        await page.mouse.up()
      }
      if (tab.type === 'chat') {
        const title = await page.evaluate(() => {
          const area = document.querySelector('[data-workbench-pane-drag-area="pane-main"]')
          const text = area.querySelector('.truncate.text-lg')
          const rect = text.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        })
        await page.mouse.move(title.x, title.y)
        await page.mouse.down()
        await page.mouse.move(title.x + 12, title.y, { steps: 4 })
        assert.equal(await page.$('[data-pane-drag-overlay]'), null, 'header title text is not blank drag space')
        await page.mouse.up()
        const body = await (await page.$('[data-workbench-content-pane="pane-main"] .foxwarm-chat-messages')).boundingBox()
        await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2)
        await page.mouse.down()
        await page.mouse.move(body.x + body.width / 2 + 12, body.y + body.height / 2, { steps: 4 })
        assert.equal(await page.$('[data-pane-drag-overlay]'), null, 'body content does not start whole-pane dragging')
        await page.mouse.up()
        const collapse = await page.$('[data-workbench-pane-collapse="pane-main"]')
        assert.ok(await collapse.$('svg.lucide-minus'))
        const box = await collapse.boundingBox()
        await page.mouse.move(box.x + box.width / 2 - 4, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2, { steps: 4 })
        assert.equal(await page.$('[data-pane-drag-overlay]'), null, 'Collapse remains an ordinary button across the drag threshold')
        await page.mouse.up()
        await page.waitForSelector('[data-workbench-collapsed-pane="true"]')
        assert.equal(await page.$('[data-workbench-pane-collapse="pane-main"] svg.lucide-minus'), null, 'Expand keeps its distinct icon')
      }
    } finally { await page.close() }
  }
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
    await waitForWebUiReady(page)
    await page.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    assert.equal((await state(page)).tabsById['chat:e2e-c'].preview, false)
  } finally { await page.close() }
})

test('global history entry opens a persistent workbench tab without a chat composer', async () => {
  const page = await openFixture()
  try {
    const footer = '[data-sidebar-footer]'
    assert.deepEqual(await page.$$eval(`${footer} button`, buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Open tasks', 'Search history', 'Open UI settings'])
    assert.equal(await page.$$eval('button[title="Search history"]', buttons => buttons.length), 1)
    assert.equal(await page.$eval(`${footer} button[aria-label="Search history"]`, button => button.getBoundingClientRect().width), 36)
    assert.equal(await page.$eval(`${footer} button[aria-label="Search history"]`, button => button.textContent.trim()), '')
    assert.ok(await page.$(`${footer} button[aria-label="Search history"] svg.lucide-history`))
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$(footer))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/sidebar-footer-search.png` })
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$('.foxwarm-chat-root .sticky'))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/chat-find-header.png` })
    await page.click(`${footer} button[aria-label="Search history"]`)
    await page.waitForSelector('[data-tab-id^="history:"]')
    await page.waitForSelector('[data-history-search-view]')
    assert.equal(await page.$('[data-history-search-view] [aria-label="Message"]'), null)
    const historyTabId = await page.$eval('[data-tab-id^="history:"]', tab => tab.getAttribute('data-tab-id'))
    const snapshot = await state(page)
    assert.equal(snapshot.root.activeTabId, historyTabId)
    assert.equal(snapshot.tabsById[historyTabId].type, 'search')
    assert.equal(snapshot.tabsById[historyTabId].title, 'History')
    assert.equal(await page.$eval(`[data-tab-id="${historyTabId}"]`, tab => tab.title), 'History')
    assert.ok(await page.$(`[data-tab-id="${historyTabId}"] svg.lucide-history`))
    if (process.env.FOXWARM_HISTORY_SCREENSHOT_DIR) await (await page.$(`[data-tab-id="${historyTabId}"]`))?.screenshot({ path: `${process.env.FOXWARM_HISTORY_SCREENSHOT_DIR}/history-workbench-tab.png` })
    assert.equal((await state(page)).hash, `#tab/${historyTabId}`)
  } finally { await page.close() }
})

test('History tabs keep independent drafts/results across entries, pane collapse, and mobile list hiding', async () => {
  const page = await openFixture({ split: true })
  try {
    const footer = '[data-sidebar-footer] button[aria-label="Search history"]'
    await page.click(footer)
    await page.waitForSelector('[data-history-search-view]')
    const firstTabId = await page.$eval('[data-tab-id^="history:"]', tab => tab.getAttribute('data-tab-id'))
    await page.type('[data-history-query-input]', 'alpha')
    await page.click('[data-history-search-view] button[type="submit"]')
    await page.waitForSelector('[data-history-result="history-outside/main"]')
    assert.equal(await page.$eval(`[data-tab-id="${firstTabId}"]`, tab => tab.textContent.includes('alpha')), true)
    assert.equal(await page.$eval(`[data-tab-id="${firstTabId}"]`, tab => tab.title), 'alpha')
    await page.click(`[data-history-tab-id="${firstTabId}"] [data-history-query-input]`, { clickCount: 3 })
    await page.keyboard.type('draft')
    assert.equal(await page.$eval(`[data-tab-id="${firstTabId}"]`, tab => tab.title), 'alpha')
    assert.ok(await page.$(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`), 'draft edits do not clear submitted results')
    await page.click(`[data-history-tab-id="${firstTabId}"] button[type="submit"]`)
    await page.waitForSelector(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`)
    assert.equal(await page.$eval(`[data-tab-id="${firstTabId}"]`, tab => tab.title), 'draft')

    await page.click(footer)
    await page.waitForFunction(id => document.querySelectorAll('[data-tab-id^="history:"]').length === 2 && !document.querySelector(`[data-tab-id="${id}"]`)?.classList.contains('hidden'), firstTabId)
    const tabIds = await page.$$eval('[data-tab-id^="history:"]', tabs => tabs.map(tab => tab.getAttribute('data-tab-id')))
    const secondTabId = tabIds.find(id => id !== firstTabId)
    assert.ok(secondTabId)
    const associations = await page.evaluate(({ firstId, secondId }) => {
      const read = id => {
        const view = document.querySelector(`[data-history-tab-id="${id}"]`)
        const input = view.querySelector('[data-history-query-input]')
        const label = view.querySelector('label[for]')
        const sessionInput = view.querySelector('[data-history-session-input]')
        const list = sessionInput?.getAttribute('list')
        const datalist = list ? view.querySelector(`#${CSS.escape(list)}`) : null
        return { inputId: input.id, labelFor: label?.htmlFor, sessionList: list, datalistId: datalist?.id }
      }
      return { first: read(firstId), second: read(secondId) }
    }, { firstId: firstTabId, secondId: secondTabId })
    assert.notEqual(associations.first.inputId, associations.second.inputId)
    assert.deepEqual(associations.first, { inputId: associations.first.inputId, labelFor: associations.first.inputId, sessionList: associations.first.sessionList, datalistId: associations.first.sessionList })
    assert.deepEqual(associations.second, { inputId: associations.second.inputId, labelFor: associations.second.inputId, sessionList: associations.second.sessionList, datalistId: associations.second.sessionList })
    const focusedAfterLabel = await page.$eval(`[data-history-tab-id="${secondTabId}"] label[for="${associations.second.inputId}"]`, label => {
      label.click()
      return { htmlFor: label.htmlFor, activeId: document.activeElement?.id }
    })
    assert.equal(focusedAfterLabel.htmlFor, associations.second.inputId)
    assert.equal(focusedAfterLabel.activeId, associations.second.inputId)
    await page.click(footer)
    await page.waitForFunction(() => document.querySelectorAll('[data-tab-id^="history:"]').length === 2)

    await page.click(`[data-tab-id="${firstTabId}"]`)
    await page.waitForSelector(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`)
    assert.equal(await page.$eval(`[data-history-tab-id="${firstTabId}"] [data-history-query-input]`, input => input.value), 'draft')
    await page.$eval(`[data-history-tab-id="${firstTabId}"]`, element => { element.scrollTop = 20; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await page.click(`[data-tab-id="${secondTabId}"]`)
    await page.waitForSelector(`[data-history-tab-id="${secondTabId}"]`)
    await page.click(`[data-tab-id="${firstTabId}"]`)
    await page.waitForSelector(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`)
    assert.ok(await page.$eval(`[data-history-tab-id="${firstTabId}"]`, element => element.scrollTop >= 10), 'History restores its tab-owned scroll position')
    await page.evaluate(id => { window.__originalHistoryView = document.querySelector('[data-history-tab-id="' + id + '"]'); window.__historySearchCount = window.__historySearchReads.length }, firstTabId)
    await clickReadyControl(page, 'button[title="Split right with active tab"]')
    assert.ok(await page.evaluate(() => window.__originalHistoryView.isConnected), 'split keeps the same History instance')
    await drag(page, `[data-workbench-tab-handle="${firstTabId}"]`, '[data-pane-id="pane-other"]')
    assert.ok(await page.evaluate(() => window.__originalHistoryView.isConnected), 'moving History and removing its old empty pane keeps its instance')
    assert.equal(await page.evaluate(() => window.__historySearchReads.length), await page.evaluate(() => window.__historySearchCount), 'layout operations do not restart Archive search')
    const firstPaneId = await page.$eval(`[data-tab-id="${firstTabId}"]`, tab => tab.closest('[data-pane-id]').dataset.paneId)
    await clickReadyControl(page, `[data-workbench-pane-collapse="${firstPaneId}"]`)
    await page.waitForSelector(`[data-workbench-collapsed-tab="${firstTabId}"]`)
    await page.click(`[data-workbench-collapsed-tab="${firstTabId}"]`)
    await page.waitForSelector(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`)
    assert.equal(await page.$eval(`[data-history-tab-id="${firstTabId}"] [data-history-query-input]`, input => input.value), 'draft')

    await page.setViewport({ width: 390, height: 800 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-a'))
    await page.locator('button[aria-label="Back to sessions"]').click()
    await page.locator('#mobile-tab-search').click()
    await page.waitForSelector('#mobile-panel-search [data-history-search-view]')
    await page.type('#mobile-panel-search [data-history-query-input]', 'mobile draft')
    assert.equal(await page.$eval(`[data-history-tab-id="${firstTabId}"] [data-history-query-input]`, input => input.value), 'draft')
    assert.equal(await page.$eval(`[data-history-tab-id="${secondTabId}"] [data-history-query-input]`, input => input.value), '')
    await page.locator('#mobile-tab-sessions').click()
    await page.locator('#mobile-tab-search').click()
    assert.equal(await page.$eval('#mobile-panel-search [data-history-query-input]', input => input.value), 'mobile draft')
    await page.setViewport({ width: 1400, height: 900 })
    await page.locator(`[data-tab-id="${firstTabId}"]`).click()
    await page.waitForSelector(`[data-history-tab-id="${firstTabId}"] [data-history-result="history-outside/main"]`)
    assert.equal(await page.$eval(`[data-history-tab-id="${firstTabId}"] [data-history-query-input]`, input => input.value), 'draft')
  } finally { await page.close() }
})

test('collapsed rail keeps its Search footer and mobile uses its primary Search tab', async () => {
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
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-a'))
    await page.locator('button[aria-label="Back to sessions"]').click()
    await page.waitForSelector('#mobile-tab-search')
    assert.deepEqual(await page.$$eval('[role="tablist"][aria-label="Main navigation"] button', buttons => buttons.map(button => button.textContent.trim())), ['Sessions', 'Tasks', 'Search', 'Settings'])
    assert.ok(await page.$('#mobile-tab-search svg.lucide-search'))
    await page.locator('#mobile-tab-search').click()
    await page.waitForSelector('#mobile-panel-search [data-history-search-view]')
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
      if (!refresh) { await page.reload({ waitUntil: 'domcontentloaded' }); await waitForWebUiReady(page) }
      await page.waitForSelector('[data-history-search-view]')
    }
  } finally { await page.close() }
})

test('opening an existing History tab from the footer expands its collapsed pane', async () => {
  const historyTab = { id: 'history:existing', type: 'search', title: 'History' }
  const page = await openFixture({
    tabs: [system, chat('e2e-a'), historyTab],
    activeTabId: 'chat:e2e-a',
    layout: {
      id: 'split-main',
      kind: 'split',
      direction: 'row',
      sizes: [50, 50],
      children: [
        { id: 'pane-main', kind: 'pane', tabIds: ['system:agents', 'chat:e2e-a'], activeTabId: 'chat:e2e-a' },
        { id: 'pane-history', kind: 'pane', tabIds: ['history:existing'], activeTabId: 'history:existing', collapsed: true },
      ],
    },
  })
  try {
    await page.waitForSelector('[data-workbench-collapsed-tab="history:existing"]')
    await page.click('[data-sidebar-footer] button[aria-label="Search history"]')
    await page.waitForSelector('[data-history-tab-id="history:existing"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.children.find(pane => pane.id === 'pane-history').collapsed === false)
    assert.equal((await state(page)).tabsById['history:existing'].id, 'history:existing', 'the existing tab instance is activated rather than replaced')
  } finally { await page.close() }
})

test('history result Open session reuses kept Chats or opens a preview while retaining the History tab', async () => {
  const history = { id: 'system:search', type: 'search', title: 'History' }
  const page = await openFixture({ tabs: [history, chat('e2e-a', false)], activeTabId: history.id })
  try {
    await page.waitForSelector('[data-history-query-input]')
    await page.type('[data-history-query-input]', 'entry')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.querySelector('[data-history-result="history-outside/main"] header')?.textContent.includes('Outside the sidebar'))
    assert.equal(await page.$('[data-session-id="history-outside/main"]'), null)
    await page.click('[data-history-result="e2e-a"] a[aria-label="Open session"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.activeTabId === 'chat:e2e-a')
    assert.equal((await state(page)).tabsById['chat:e2e-a'].preview, false)
    assert.equal((await state(page)).tabsById['system:search'].type, 'search')
    await page.click('[data-tab-id="system:search"]')
    await page.waitForSelector('[data-history-query-input]')
    await page.type('[data-history-query-input]', 'entry')
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
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]')
    await page.waitForSelector(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) [role="textbox"][aria-label="Message"]')
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [role="textbox"][aria-label="Message"]')
    await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-chat-search] input')
    assert.equal(await page.$(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) [data-chat-search]'), null)
    await page.type(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-chat-search] input', 'repeat query')
    await page.click('[data-sidebar-footer] button[aria-label="Open UI settings"]')
    await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
    assert.deepEqual(await page.evaluate(() => ({
      value: document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-chat-search] input').value,
      selected: document.activeElement === document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-chat-search] input')
        && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === 'repeat query'.length,
      count: document.querySelectorAll('[data-chat-search]').length,
    })), { value: 'repeat query', selected: true, count: 1 })
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[aria-label="Close search"]')
    await page.click(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) [role="textbox"][aria-label="Message"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-other')
    await page.keyboard.down('Meta'); await page.keyboard.press('f'); await page.keyboard.up('Meta')
    await page.waitForSelector(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) [data-chat-search] input')
    assert.equal(await page.$(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-chat-search]'), null)
    const ignored = await page.evaluate(() => {
      const dispatch = init => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true, ...init }); window.dispatchEvent(event); return event.defaultPrevented }
      return [dispatch({ shiftKey: true }), dispatch({ altKey: true }), dispatch({ isComposing: true })]
    })
    assert.deepEqual(ignored, [false, false, false])
    await page.click(':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"]) button[aria-label="Close search"]')
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) [data-tab-id="system:agents"]')
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
    assert.equal(await page.$(`${header} button[title="Terminal"]`), null)
    assert.equal(await page.$eval('[data-workbench-status-bar] button[title="Terminal"]', button => button.textContent), 'Terminal')
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

    await page.click('[data-workbench-status-bar] button[title="Terminal"]')
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
    assert.equal(await page.$(`${menu} .lucide-clipboard-list`), null, 'Tasks is not duplicated in settings')
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
      { text: 'Reload WebUI', icon: 'lucide-refresh-cw', svgCount: 1, width: 14, beforeText: true },
      { text: 'Open logs', icon: 'lucide-file-text', svgCount: 1, width: 14, beforeText: true },
      { text: 'Open setup', icon: 'lucide-settings', svgCount: 1, width: 14, beforeText: true },
    ])
    if (process.env.FOXWARM_APPLICATION_MENU_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.FOXWARM_APPLICATION_MENU_SCREENSHOT_PATH })
    }
    await clickReadyControl(page, `${menu} button:has(.lucide-settings)`)
    await page.waitForSelector('[data-setup-tab="appearance"]')
    assert.equal(await page.$(menu), null)
    await openMenu()
    assert.equal(await page.$eval(`${menu} .lucide-settings`, icon => icon.closest('button').textContent), 'Open setupactive')
    await clickReadyControl(page, `${menu} button:has(.lucide-file-text)`)
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
  const main = ':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"])'
  const other = ':is([data-pane-id="pane-other"], [data-workbench-content-pane="pane-other"])'
  const editor = ' [role="textbox"][aria-label="Message"]'
  const paneLayout = selector => page.$eval(selector + ' .foxwarm-chat-root', root => {
    const visible = selector => { const el = root.querySelector(selector); return !!el && getComputedStyle(el).display !== 'none' }
    const messages = root.querySelector('.foxwarm-chat-messages')
    return {
      width: root.getBoundingClientRect().width,
      sm: visible('.foxwarm-chat-sm-label'), md: visible('.foxwarm-chat-md-label'),
      minimap: visible('.foxwarm-context-scrollbar-shell'),
      gutter: `${parseFloat(getComputedStyle(messages).paddingRight) - parseFloat(getComputedStyle(messages).paddingLeft)}px`,
      nativeScrollbar: getComputedStyle(messages).scrollbarWidth,
      compact: root.querySelector('.foxwarm-model-selector-root').dataset.chatLayout,
      childLabel: visible('.foxwarm-model-child-trigger > span'),
      back: !!root.querySelector('button[title="Back"]'),
      overflow: [...root.querySelectorAll('.foxwarm-chat-composer-form, [data-chat-timeline], .sticky')].some(el => el.scrollWidth > el.clientWidth + 1),
    }
  })
  const resizeMain = async target => {
    await page.waitForFunction(() => {
      const slot = document.querySelector('[data-workbench-content-slot="pane-main"]')?.getBoundingClientRect()
      const host = document.querySelector('[data-workbench-content-pane="pane-main"]')?.getBoundingClientRect()
      return slot && host && Math.abs(slot.width - host.width) < 1 && Math.abs(slot.left - host.left) < 1
    })
    const box = await (await page.$('[role="separator"]')).boundingBox()
    const width = (await paneLayout(main)).width
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + target - width, box.y + box.height / 2, { steps: 8 })
    // The content must react while the pointer is still held, not only on release.
    await page.waitForFunction((target) => {
      const root = document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root')
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
    assert.equal(wide.md, false, 'desktop Terminal entry is owned by the status bar'); assert.equal(wide.minimap, true); assert.equal(wide.gutter, '32px'); assert.equal(wide.nativeScrollbar, 'none')
    assert.equal(narrow.md, false); assert.equal(narrow.minimap, false); assert.equal(narrow.gutter, '0px'); assert.notEqual(narrow.nativeScrollbar, 'none')
    assert.equal(wide.back, false); assert.equal(narrow.back, false)
    assert.equal(wide.overflow, false); assert.equal(narrow.overflow, false)
    const scrollBox = await (await page.$(main + ' .foxwarm-chat-messages')).boundingBox()
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2)
    await page.mouse.wheel({ deltaY: -650 })
    await page.waitForFunction(() => {
      const el = document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-messages')
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
    await page.waitForFunction(() => document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root').getBoundingClientRect().width > 420)
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
    await page.waitForFunction(() => document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root').getBoundingClientRect().width === 0)
    await page.$eval(main + ' .foxwarm-chat-root', root => { root.style.display = ''; root.style.width = '768px' })
    await page.waitForFunction(() => !!document.querySelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-context-scrollbar-shell'))
    assert.equal((await paneLayout(main)).gutter, '32px')
    await page.$eval(main + ' .foxwarm-chat-root', root => { root.style.width = '' })
    // The production embedded and popup routes use the same container boundary.
    for (const query of ['foxwarmEmbed=chat&foxwarmEmbedNonce=container-fixture-nonce&sessionId=e2e-a', 'foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=e2e-a']) {
      await page.setViewport({ width: 410, height: 900 })
      await page.goto(baseUrl + '?' + query, { waitUntil: 'domcontentloaded' })
      await waitForWebUiReady(page)
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
  for (const tab of [chat('e2e-a'), system, { id: 'system:search', type: 'search', title: 'History' }, { id: 'system:logs', type: 'logs', title: 'Logs' }, { id: 'system:tasks', type: 'tasks', title: 'Tasks' }, { id: 'system:setup', type: 'setup', title: 'Setup' }, { id: 'vscode-web', type: 'vscode', title: 'Code' }]) {
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
    await page.waitForSelector(':is([data-pane-id], [data-workbench-content-pane]) > .pointer-events-none')
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
    assert.equal(await page.$(':is([data-pane-id], [data-workbench-content-pane]) > .pointer-events-none'), null)
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
    // The ready callback reconciles restored tab metadata before startup routing settles.
    await page.waitForSelector('[data-tab-id="terminal:term-fallback"]')
    await page.click('[data-tab-id="terminal:term-fallback"]')
    await page.waitForFunction(() => document.querySelector('[data-terminal-header]')?.textContent.includes('status ready'))
    await page.click('[data-tab-id="terminal:term-fallback"] button[title="Close tab"]')
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['terminal:term-fallback'] && decodeURIComponent(location.hash) === '#tab/system:agents')
    assert.deepEqual((await state(page)).root.tabIds, ['system:agents'])
    // The remaining tab mounts lazily; wait for its content before checking the route result.
    await page.waitForSelector('h1::-p-text(System Architecture)')
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), ['/prefix/ui/api/terminals/term-fallback'])
  } finally { await page.close() }
})


test('Chat composer uses a smaller empty editor below 600px content height in Default and 550A', async () => {
  for (const themeId of ['foxwarm.default', 'foxwarm.550a']) {
    const sessionId = 'compact-' + themeId
    const page = await openFixture({ tabs: [chat(sessionId, false), chat('e2e-b', false)], activeTabId: 'chat:' + sessionId, split: true, splitSecondChat: true, width: 1800, themeId })
    const root = ':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root'
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
      assert.equal(await page.$eval(root, el => el.getBoundingClientRect().height), await page.$eval(root, el => el.parentElement.clientHeight), 'Chat fills the tab content height')
      for (const width of [599, 800]) {
        for (const [height, minHeight] of [[600, 60], [599, 35]]) {
          await page.$eval(root, (el, size) => { el.style.width = size.width + 'px'; el.style.height = size.height + 'px' }, { width, height })
          await page.waitForFunction((selector, height) => getComputedStyle(document.querySelector(selector)).minHeight === height + 'px', {}, editor, minHeight)
          const actual = await geometry()
          assert.deepEqual(await page.$eval(root, el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })), { width, height })
          assert.ok(actual.height >= minHeight, themeId + ' empty editor respects its minimum at ' + width + ' × ' + height)
          assert.equal(actual.marginBottom, '0px')
          assert.equal(actual.lineHeight, original.lineHeight)
          assert.equal(actual.padding, original.padding)
        }
      }
      for (const width of [360, 800]) {
        await page.$eval(root, (el, width) => { el.style.width = width + 'px'; el.style.height = '600px' }, width)
        await page.waitForFunction(selector => document.querySelector(selector)?.dataset.empty === 'true', {}, editor)
        const empty = await page.$eval(editor, el => {
          const form = el.closest('form')
          const box = el.getBoundingClientRect()
          const placeholder = getComputedStyle(el, '::before')
          const toolbar = form.querySelector('button[type="submit"]').parentElement
          const toolbarBox = toolbar.getBoundingClientRect()
          const formBox = form.getBoundingClientRect()
          return {
            placeholderX: box.left + parseFloat(placeholder.insetInlineStart),
            paddingX: box.left + parseFloat(getComputedStyle(el).paddingLeft),
            editorInset: parseFloat(getComputedStyle(el).paddingLeft),
            placeholderTop: parseFloat(placeholder.top),
            paddingTop: parseFloat(getComputedStyle(el).paddingTop),
            clickX: box.left + 6, clickY: box.top + 12,
            editorTop: box.top - formBox.top,
            toolbarInset: toolbarBox.left + parseFloat(getComputedStyle(toolbar).paddingLeft) - formBox.left,
            toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
          }
        })
        assert.equal(empty.placeholderX, empty.paddingX, themeId + ' placeholder follows the editor inset')
        assert.equal(empty.editorInset, 16, themeId + ' text has more horizontal breathing room')
        assert.equal(empty.placeholderTop, empty.paddingTop, themeId + ' placeholder follows the vertical inset')
        assert.equal(empty.paddingTop, 8)
        assert.equal(empty.editorTop, 1, themeId + ' editor reaches the form border without outer padding')
        assert.equal(empty.toolbarInset, 9, themeId + ' toolbar owns its horizontal inset')
        assert.ok(empty.toolbarOverflow <= 1, themeId + ' toolbar fits the narrow section')
        if (process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR, `composer-${themeId}-${width}-empty.png`), fromSurface: false })
        await page.mouse.click(empty.clickX, empty.clickY)
        assert.equal(await page.$eval(editor, el => el === document.activeElement), true, 'editor padding is clickable')
        await page.keyboard.type('First line')
        const textX = await page.$eval(editor, el => {
          const range = document.createRange()
          range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 1)
          return range.getBoundingClientRect().left
        })
        assert.ok(Math.abs(textX - empty.placeholderX) <= 0.5, themeId + ' ordinary text starts at the placeholder')
        if (process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR, `composer-${themeId}-${width}-text.png`), fromSurface: false })
        await page.focus(editor)
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
        await page.keyboard.press('Backspace')
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

test('Tasks uses desktop singleton footers and an independent retained mobile primary page', async () => {
  for (const surface of ['expanded', 'collapsed', 'mobile']) {
    const page = await openFixture({ width: surface === 'mobile' ? 320 : 1400 })
    try {
      if (surface === 'collapsed') await page.click('button[title="Collapse sidebar"]')
      if (surface === 'mobile') {
        const before = await state(page)
        await page.locator('#mobile-tab-tasks').click()
        await page.waitForSelector('#mobile-panel-tasks [data-tasks-view]')
        assert.deepEqual((await state(page)).root, before.root, 'mobile primary navigation does not create a desktop Tasks tab')
        assert.deepEqual((await state(page)).tabsById, before.tabsById)
        await page.locator('#mobile-tab-sessions').click()
        await page.locator('#mobile-tab-tasks').click()
        assert.equal(await page.$$eval('#mobile-panel-tasks [data-tasks-view]', nodes => nodes.length), 1)
        continue
      }
      const entry = '[data-sidebar-footer] button[aria-label="Open tasks"]'
      await page.waitForSelector(entry)
      assert.ok(await page.$(`${entry} svg.lucide-clipboard-list`))
      assert.equal(await page.$eval(entry, button => button.textContent.trim()), surface === 'collapsed' ? '' : 'Tasks')
      const geometry = await page.evaluate(() => {
        const footer = document.querySelector('[data-sidebar-footer]').getBoundingClientRect()
        const tasks = document.querySelector('[aria-label="Open tasks"]').getBoundingClientRect()
        const history = document.querySelector('[aria-label="Search history"]').getBoundingClientRect()
        const settings = document.querySelector('[aria-label="Open UI settings"]').getBoundingClientRect()
        return { leftGap: tasks.left - footer.left, rightGap: footer.right - settings.right, tasksRight: tasks.right, historyLeft: history.left, tasksBottom: tasks.bottom, historyTop: history.top, settingsRight: settings.right, viewportWidth: innerWidth }
      })
      assert.ok(geometry.settingsRight <= geometry.viewportWidth)
      if (surface === 'collapsed') assert.ok(geometry.tasksBottom < geometry.historyTop)
      else {
        assert.equal(geometry.leftGap, 8)
        assert.equal(geometry.rightGap, 8)
        assert.ok(geometry.tasksRight < geometry.historyLeft)
      }
      await page.click(entry)
      await page.waitForSelector('[data-tasks-view]')
      assert.equal((await state(page)).root.activeTabId, 'system:tasks')
      await page.click('[data-tab-id="system:agents"]')
      await page.click(entry)
      await page.waitForSelector('[data-tasks-view]')
      assert.equal((await state(page)).root.activeTabId, 'system:tasks')
      assert.equal(Object.values((await state(page)).tabsById).filter(tab => tab.type === 'tasks').length, 1)
    } finally { await page.close() }
  }
})

test('Code-embedded sidebar keeps a direct Tasks popup entry next to settings', async () => {
  const page = await openFixture()
  try {
    await page.goto(`${baseUrl}?foxwarmEmbed=sidebar&foxwarmEmbedNonce=fixture-nonce-123456`, { waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)
    const entry = 'button[aria-label="Open tasks"]'
    await page.waitForSelector(entry)
    assert.equal(await page.$('[data-pane-id]'), null)
    await page.setViewport({ width: 240, height: 800 })
    assert.equal(await page.$eval(entry, button => button.textContent.trim()), '')
    assert.ok(await page.$(`${entry} svg.lucide-clipboard-list`))
    const geometry = await page.evaluate(() => {
      const tasks = document.querySelector('[aria-label="Open tasks"]').getBoundingClientRect()
      const settings = document.querySelector('[aria-label="Open UI settings"]').getBoundingClientRect()
      return { tasksRight: tasks.right, settingsLeft: settings.left, settingsRight: settings.right, width: innerWidth }
    })
    assert.ok(geometry.tasksRight < geometry.settingsLeft && geometry.settingsRight <= geometry.width)
    await page.evaluate(() => {
      window.__opened = []
      window.__popup = { opener: window }
      window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return window.__popup }
    })
    await page.click(entry)
    const opened = await page.evaluate(() => window.__opened[0])
    const url = new URL(opened.url)
    assert.equal(url.origin, new URL(baseUrl).origin)
    assert.equal(url.pathname, '/prefix/ui/')
    assert.equal(url.searchParams.get('foxwarmPopup'), 'tasks')
    assert.equal(url.searchParams.has('foxwarmEmbed'), false)
    assert.equal(opened.target, '_blank')
    assert.equal(opened.features, 'popup')
    assert.equal(await page.evaluate(() => window.__popup.opener), null)
    await page.evaluate(() => { window.open = () => null; window.__alerts = []; window.alert = message => window.__alerts.push(message) })
    await page.click(entry)
    assert.equal(await page.evaluate(() => window.__alerts.length), 1)
    assert.match(await page.evaluate(() => window.__alerts[0]), /Allow popups/)
    await page.click('button[aria-label="Open UI settings"]')
    await page.waitForSelector('[data-global-ui-settings-menu]', { visible: true })
    assert.equal(await page.$('[data-global-ui-settings-menu] .lucide-clipboard-list'), null)
    assert.equal(await page.$eval('[data-global-ui-settings-menu]', menu => Array.from(menu.querySelectorAll('button')).at(-1).textContent.trim()), 'Open setup')
  } finally { await page.close() }
})

test('Tasks restores from its deployment-relative route, stays singleton, and moves to a popup leaf', async () => {
  const page = await openFixture({ tabs: [system], activeTabId: system.id, hash: '#tab/system%3Atasks' })
  try {
    await page.waitForSelector('[data-tasks-view]')
    assert.equal((await state(page)).tabsById['system:tasks'].type, 'tasks')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)
    await page.waitForSelector('[data-tasks-view]')
    await page.click('[data-sidebar-footer] button[aria-label="Open tasks"]')
    assert.equal(Object.values((await state(page)).tabsById).filter(tab => tab.type === 'tasks').length, 1)
    await page.click('[data-tab-id="system:tasks"]', { button: 'right' })
    await page.waitForSelector('[role="menu"]')
    await page.evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(url); return { opener: null } } })
    await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"] button')).find(button => button.textContent.trim() === 'Move to new window').click())
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['system:tasks'])
    const url = new URL(await page.evaluate(() => window.__opened[0]))
    assert.equal(url.pathname, '/prefix/ui/')
    assert.equal(url.searchParams.get('foxwarmPopup'), 'tasks')
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)
    await page.waitForSelector('[data-tasks-view]')
    assert.equal(await page.$('[data-pane-id]'), null, 'popup mounts only the Tasks leaf')
    assert.equal(await page.$('[data-workbench-tab-close]'), null)
  } finally { await page.close() }
})


test('Full width defaults on, remembers its toggle, and bounds only the message column', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a', false)], responsiveChat: true, width: 1800 })
  const column = '.foxwarm-chat-messages-content'
  const readWidth = () => page.$eval(column, element => element.getBoundingClientRect().width)
  try {
    await page.waitForSelector(column)
    assert.ok(await readWidth() > 1100, 'new browsers retain the full-width message layout')
    await page.click('button[aria-label="Open session options"]')
    await page.waitForSelector('[data-session-ui-settings-menu]', { visible: true })
    const toggle = '[data-session-ui-settings-menu] button[role="switch"]'
    assert.equal(await page.$eval(toggle, element => element.textContent.trim()), 'Full width')
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'true')
    await clickReadyControl(page, toggle)
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages-content').dataset.fullWidth === 'false')
    assert.ok(await readWidth() <= 1100)
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_chat_full_width_v1')), 'false')
    await page.reload({ waitUntil: 'networkidle0' })
    await waitForWebUiReady(page)
    await page.waitForSelector(column)
    assert.equal(await page.$eval(column, element => element.dataset.fullWidth), 'false')
    assert.ok(await readWidth() <= 1100)
    await page.setViewport({ width: 900, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.click('button[aria-label="Open session options"]')
    await clickReadyControl(page, toggle)
    await page.setViewport({ width: 1800, height: 900 })
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages-content').getBoundingClientRect().width > 1100)
  } finally { await page.close() }
})

test('Timeline, Composer, History and Tasks share the reading column and pane-local minimap clearance', async () => {
  const history = { id: 'system:search', type: 'search', title: 'History' }
  const tasks = { id: 'system:tasks', type: 'tasks', title: 'Tasks' }
  const page = await openFixture({ tabs: [chat('e2e-a', false), history, tasks], responsiveChat: true, width: 1800 })
  const alignedGeometry = () => {
    const rect = selector => {
      const box = document.querySelector(selector).getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width }
    }
    const scroller = document.querySelector('.foxwarm-chat-messages')
    const root = document.querySelector('.foxwarm-chat-root')
    const boxes = {
      timeline: rect('.foxwarm-chat-messages-content'), composer: rect('.foxwarm-chat-composer-inner'),
      root: rect('.foxwarm-chat-root'),
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
    // Content can gain a native scrollbar before ResizeObserver publishes its gutter.
    const publishedGutter = parseFloat(getComputedStyle(root).getPropertyValue('--foxwarm-chat-scrollbar-gutter'))
    if (publishedGutter !== boxes.scrollbar || boxes.timeline.width <= 0) return false
    if (Math.abs(boxes.timeline.left - boxes.composer.left) >= 1 || Math.abs(boxes.timeline.right - boxes.composer.right) >= 1) return false
    return boxes
  }
  const aligned = async () => {
    const sample = await page.waitForFunction(alignedGeometry)
    const boxes = await sample.jsonValue()
    await sample.dispose()
    for (const edge of ['left', 'right']) assert.ok(Math.abs(boxes.timeline[edge] - boxes.composer[edge]) < 1, `${edge} edge differs: ${JSON.stringify(boxes)}`)
    assert.ok(boxes.composer.width <= 1100)
    assert.equal(boxes.overflow, false)
    return boxes
  }
  try {
    await page.waitForSelector('.foxwarm-chat-messages-content')
    await page.click('button[aria-label="Open session options"]')
    await clickReadyControl(page, '[data-session-ui-settings-menu] button[role="switch"]')
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages-content').dataset.fullWidth === 'false')
    await page.click('button[aria-label="Open session options"]')
    assert.equal((await aligned()).timeline.width, 1100)
    if (process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR}/chat-reading-column.png` })
    for (const width of [1200, 900, 390]) {
      await page.setViewport({ width, height: 900 })
      if (width < 768) {
        await page.waitForFunction(() => !document.querySelector('.foxwarm-desktop-workbench-shell'))
        await clickReadyControl(page, '[data-session-id="e2e-a"]')
      }
      await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root').getBoundingClientRect().width > 0)
      await aligned()
    }
    await page.setViewport({ width: 1800, height: 900 })
    await page.waitForFunction(() => !!document.querySelector('.foxwarm-desktop-workbench-shell')
      && document.querySelector('.foxwarm-chat-root')?.getBoundingClientRect().width > 1100)
    await page.evaluate(() => {
      localStorage.setItem('foxwarm.contextScrollbar.showScrollbar', 'true')
      localStorage.setItem('foxwarm.contextScrollbar.showMinimap', 'false')
      window.dispatchEvent(new Event('foxwarm-context-scrollbar-settings'))
    })
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').dataset.showContextMinimap === 'false')
    assert.equal((await aligned()).timeline.width, 1100)
    await page.setViewport({ width: 1200, height: 900 })
    await aligned()
    if (process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR}/chat-without-minimap.png` })
    await page.evaluate(() => {
      localStorage.setItem('foxwarm.contextScrollbar.showMinimap', 'true')
      window.dispatchEvent(new Event('foxwarm-context-scrollbar-settings'))
    })
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').dataset.showContextMinimap === 'true')
    await aligned()
    await page.setViewport({ width: 1800, height: 900 })
    for (const [id, selector] of [['system:search', '[data-history-search-view] > .foxwarm-content-column'], ['system:tasks', '.tasks-content']]) {
      await page.waitForSelector('.foxwarm-desktop-workbench-shell', { visible: true })
      await clickReadyControl(page, `[data-tab-id="${id}"]`)
      await page.waitForSelector(selector, { visible: true })
      assert.equal(await page.$eval(selector, element => element.getBoundingClientRect().width), 1100)
      if (id === 'system:search') {
        await page.type('[data-history-query-input]', 'shared width')
        await page.$eval('[data-history-search-view] form button[type="submit"]', element => element.click())
        await page.waitForSelector('[data-history-result]')
      }
      if (process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_CONTENT_WIDTH_SCREENSHOT_DIR}/${id === 'system:search' ? 'history' : 'tasks'}-reading-column.png` })
      if (id === 'system:tasks') {
        const edges = await page.evaluate(() => ['.tasks-toolbar', '.tasks-content'].map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect()
          return [rect.left, rect.right]
        }))
        assert.deepEqual(edges[0], edges[1])
      }
      await page.setViewport({ width: 390, height: 900 })
      await page.waitForFunction(() => !document.querySelector('.foxwarm-desktop-workbench-shell'))
      await page.waitForFunction(selector => {
        const width = document.querySelector(selector)?.getBoundingClientRect().width
        return width > 0 && width <= innerWidth - 32
      }, {}, selector)
      assert.ok(await page.$eval(selector, element => element.getBoundingClientRect().width <= 390 - 32))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.setViewport({ width: 1800, height: 900 })
    }
  } finally { await page.close() }
})

test('Sidebar and tab scrollbars reveal without changing usable width or tab-content continuity', async () => {
  const page = await openFixture({ tabs: [system, ...Array.from({ length: 12 }, (_, index) => chat(`e2e-long-session-${index}`, false))], activeTabId: 'chat:e2e-long-session-0', width: 1400 })
  try {
    const sidebar = '.foxwarm-sidebar-panel [data-session-list-scroll-container]'
    await page.waitForSelector(sidebar)
    await page.mouse.move(1390, 890)
    const idle = await page.$eval(sidebar, element => ({ width: element.clientWidth, color: getComputedStyle(element).scrollbarColor }))
    assert.equal(idle.color, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')
    await page.hover(sidebar)
    const hovered = await page.$eval(sidebar, element => ({ width: element.clientWidth, color: getComputedStyle(element).scrollbarColor }))
    assert.equal(hovered.width, idle.width)
    assert.notEqual(hovered.color, idle.color)
    await page.mouse.move(1390, 890)
    await page.waitForSelector('.foxwarm-tab-overflow')
    assert.equal(await page.$eval('.foxwarm-tab-overflow', element => getComputedStyle(element).opacity), '0')
    const width = await page.$eval('.foxwarm-workbench-tab-row', element => element.clientWidth)
    await page.hover('.foxwarm-workbench-tab-row')
    assert.equal(await page.$eval('.foxwarm-tab-overflow', element => getComputedStyle(element).opacity), '1')
    assert.equal(await page.$eval('.foxwarm-workbench-tab-row', element => element.clientWidth), width)
    await page.mouse.wheel({ deltaY: 450 })
    await page.waitForFunction(() => document.querySelector('.foxwarm-workbench-tab-row').scrollLeft > 0)
    const seam = await page.evaluate(() => {
      const tab = document.querySelector('[data-tab-active="true"]').getBoundingClientRect()
      const strip = document.querySelector('.foxwarm-workbench-tab-strip').getBoundingClientRect()
      return Math.abs(tab.bottom - strip.bottom)
    })
    assert.ok(seam <= 1, 'overlay scrolling does not reserve a stripe below the current tab')
  } finally { await page.close() }
})

async function workbenchScreenshot(page, name) {
  if (!process.env.FOXWARM_E2E_SCREENSHOT_DIR) return
  await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR, { recursive: true })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: path.join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, name), fullPage: true })
}

async function clickStatusPageEntry(page, section) {
  const popup = '[data-workbench-status-popup]'
  await page.click(`[data-workbench-status-bar] button[aria-label^="${section === 'Tasks' ? 'Tasks:' : 'Nodes:'}"]`)
  await page.waitForSelector(popup, { visible: true })
  // Loading preview rows can move the action after the popup first appears.
  await page.locator(`${popup} button::-p-text(Open ${section})`).click()
  await page.waitForSelector(popup, { hidden: true })
}

test('Tasks and Nodes popup entries close the preview and activate singleton pages, including collapsed panes', async () => {
  const page = await openFixture({ tabs: [system, chat('e2e-a', false)] })
  try {
    await page.waitForSelector('[data-workbench-status-bar] button[aria-label^="Tasks:"]')
    await page.click('[data-workbench-status-bar] button[aria-label^="Tasks:"]')
    await page.waitForSelector('[data-workbench-status-popup]', { visible: true })
    await workbenchScreenshot(page, 'status-tasks-popup.png')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-workbench-status-popup]', { hidden: true })
    await clickStatusPageEntry(page, 'Tasks')
    await page.waitForFunction(() => location.hash.includes('system%3Atasks'))
    await page.waitForSelector('[data-tab-id="system:tasks"]')
    assert.equal((await state(page)).tabsById['system:tasks'].type, 'tasks')
    await page.evaluate(() => { window.__failTaskPreview = true })
    await page.click('[data-workbench-status-bar] button[aria-label^="Tasks:"]')
    await page.waitForFunction(() => document.querySelector('[data-workbench-status-popup]')?.textContent.includes('Unable to load tasks'))
    await page.evaluate(() => [...document.querySelectorAll('[data-workbench-status-popup] button')].find(button => button.textContent === 'Open Tasks').click())
    await page.waitForSelector('[data-workbench-status-popup]', { hidden: true })
    assert.equal(Object.keys((await state(page)).tabsById).filter(id => id === 'system:tasks').length, 1)
    await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
    await page.waitForSelector('[data-workbench-status-popup]', { visible: true })
    await page.waitForFunction(() => document.querySelector('[data-workbench-status-popup]')?.textContent.includes('Open Nodes'))
    await workbenchScreenshot(page, 'status-nodes-popup.png')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-workbench-status-popup]', { hidden: true })
    await clickStatusPageEntry(page, 'Nodes')
    await page.waitForSelector('[data-node-surface]')
    await workbenchScreenshot(page, 'nodes-workbench-wide.png')
    assert.equal((await state(page)).tabsById['system:nodes'].type, 'nodes')
    assert.equal((await state(page)).hash, '#tab/system:nodes')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-node-surface]')
    assert.equal((await state(page)).tabsById['system:nodes'].title, 'Nodes')
    await clickReadyControl(page, '[data-tab-id="system:nodes"] button[title="Close tab"]')
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById['system:nodes'])
    assert.notEqual((await state(page)).hash, '#tab/system:nodes')
    await page.click('[data-tab-id="system:agents"]')
    await page.waitForSelector('.foxwarm-architecture-surface-tab')
    assert.deepEqual(await page.$$eval('.foxwarm-architecture-surface-tab', buttons => buttons.map(button => button.textContent)), ['Topology', 'Agents'])
    await workbenchScreenshot(page, 'architecture-two-modes.png')
    await page.evaluate(() => [...document.querySelectorAll('header button')].find(button => button.textContent.includes('protocol-compatible execution')).click())
    await page.waitForSelector('[data-node-surface]')
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('[data-workbench-status-bar]', { hidden: true })
    await workbenchScreenshot(page, 'nodes-workbench-narrow.png')
    assert.equal(await page.$('[data-workbench-status-bar]'), null)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.ok(await page.$('[data-node-surface]'))
    await page.setViewport({ width: 1400, height: 900 })
    await page.locator('[data-tab-id="system:agents"]').click()
    await page.waitForSelector('.foxwarm-architecture-surface-tab')
    await page.evaluate(() => [...document.querySelectorAll('header button')].find(button => button.textContent.includes('protocol-compatible execution')).click())
    await page.waitForSelector('[data-node-surface]')
    assert.equal((await state(page)).hash, '#tab/system:nodes')
  } finally { await page.close() }

  const tasksTab = { id: 'system:tasks', type: 'tasks', title: 'Tasks' }
  for (const tab of [nodesTab, tasksTab]) {
    const layout = { id: 'split-main', kind: 'split', direction: 'row', sizes: [50, 50], children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a' },
      { id: 'pane-other', kind: 'pane', tabIds: [tab.id], activeTabId: tab.id, collapsed: true },
    ] }
    const collapsed = await openFixture({ tabs: [chat('e2e-a', false), tab], layout })
    try {
      await clickStatusPageEntry(collapsed, tab.title)
      await collapsed.waitForFunction(id => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-other' && location.hash === `#tab/${encodeURIComponent(id)}`, {}, tab.id)
      const snapshot = await state(collapsed)
      assert.equal(snapshot.root.children[1].collapsed, false)
      assert.equal(snapshot.root.children[1].activeTabId, tab.id)
      assert.equal(Object.keys(snapshot.tabsById).filter(id => id === tab.id).length, 1)
    } finally { await collapsed.close() }
  }
})

test('Nodes route creates a sole-tab header without Architecture data or setup credentials', async () => {
  const page = await openFixture({ tabs: [], activeTabId: 'system:nodes', hash: '#tab/system%3Anodes' })
  try {
    await page.waitForSelector('[data-node-surface]')
    await page.waitForSelector('[data-workbench-tab-handle="system:nodes"]')
    assert.equal(await page.$('[data-tab-id]'), null)
    const reads = await page.evaluate(() => window.__fetches)
    assert.ok(reads.some(request => request.path.endsWith('/nodes/onboarding/pending')))
    assert.ok(!reads.some(request => request.path.endsWith('/session-list/architecture') && new URLSearchParams(request.search).get('limit') !== '1' || request.path.endsWith('/nodes/onboarding/commands')), 'App keeps its global summary read, but Nodes never mounts the Architecture tree or credentials')
    await page.click('[data-workbench-tab-close="system:nodes"]')
    await page.waitForFunction(() => location.hash === '')
    assert.deepEqual((await state(page)).tabsById, {})
  } finally { await page.close() }
})

test('Desktop status bar opens upward details without navigation and stays outside Sidebar height', async () => {
  const page = await openFixture()
  try {
    const bar = '[data-workbench-status-bar]'
    const tasks = `${bar} button[aria-label="Tasks: 2 active, 5 unfinished"]`
    await page.waitForSelector(tasks)
    assert.equal(await page.$eval(bar, element => element.getBoundingClientRect().height), 24)
    const hash = await page.evaluate(() => location.hash)
    const colors = await page.$eval(tasks, element => ({ idle: getComputedStyle(element).backgroundColor }))
    await page.hover(tasks)
    assert.notEqual(await page.$eval(tasks, element => getComputedStyle(element).backgroundColor), colors.idle)
    await page.click(tasks)
    await page.waitForSelector('[data-workbench-status-popup]', { visible: true })
    assert.equal(await page.evaluate(() => location.hash), hash)
    assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /Active2Open3/)
    assert.equal(await page.evaluate(() => document.querySelector('[data-workbench-status-popup]').getBoundingClientRect().bottom < document.querySelector('[data-workbench-status-bar]').getBoundingClientRect().top), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.$('[data-workbench-status-popup]'), null)
    assert.equal(await page.$eval(tasks, element => document.activeElement === element), true)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('foxwarm-task-counts', { detail: { open: 1, active: 1 } })))
    await page.waitForSelector(`${bar} button[aria-label="Tasks: 1 active, 2 unfinished"]`)
    await page.click(`${bar} button[aria-label="Nodes: 1 online, 1 total"]`)
    await page.waitForSelector('[data-workbench-status-popup]', { visible: true })
    assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /master/)
    assert.equal(await page.evaluate(() => location.hash), hash)
    const bounds = await page.evaluate(() => {
      const footer = document.querySelector('[data-workbench-status-bar]').getBoundingClientRect()
      const sidebar = document.querySelector('.foxwarm-sidebar-panel').getBoundingClientRect()
      return { inset: innerHeight - footer.bottom, sameBottom: Math.abs(sidebar.bottom - footer.bottom), outsideSidebar: footer.left > sidebar.right }
    })
    assert.equal(bounds.inset, 6); assert.ok(bounds.sameBottom < 1); assert.equal(bounds.outsideSidebar, true)
  } finally { await page.close() }
})

test('Desktop text inputs use compact control typography and preserve keyboard entry', async () => {
  const page = await openFixture()
  try {
    const selector = 'input[aria-label="Search sessions"]'
    await page.waitForSelector(selector)
    const style = await page.$eval(selector, element => {
      const css = getComputedStyle(element)
      return { font: parseFloat(css.fontSize), radius: parseFloat(css.borderTopLeftRadius), weight: css.fontWeight }
    })
    assert.ok(style.font <= 14, 'desktop fields do not inherit the touch-only 16px floor')
    assert.ok(style.radius <= 4)
    assert.equal(style.weight, '400')
    await page.click(selector)
    await page.keyboard.type('needle')
    assert.equal(await page.$eval(selector, element => element.value), 'needle')
  } finally { await page.close() }
})


test('Status usage separates global totals from the focused Chat and follows focus changes', async () => {
  const page = await openFixture({ tabs: [system, chat('e2e-a', false), chat('e2e-b', false)], responsiveChat: true, width: 1400 })
  try {
    const total = '[data-workbench-status-bar] button[aria-label="Total token usage"]'
    const current = '[data-workbench-status-bar] button[aria-label="Current Session token usage"]'
    await page.waitForFunction(() => document.querySelector('[aria-label="Total token usage"]')?.textContent.includes('3.2B'))
    assert.match(await page.$eval(current, element => element.textContent), /13.2K/)
    await clickReadyControl(page, total)
    await page.waitForSelector('[data-workbench-status-popup]', { visible: true })
    assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /Total usageTokens3.2B.*Cached3B92.9%.*Input200M6.2%.*Output30M0.9%/)
    await page.keyboard.press('Escape')
    await clickReadyControl(page, current)
    assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /e2e-a.*Cached12K90.9%/)
    await page.keyboard.press('Escape')
    await page.click('[data-tab-id="chat:e2e-b"]')
    await page.waitForFunction(() => document.querySelector('[aria-label="Current Session token usage"]')?.textContent.includes('2.5K'))
    await clickReadyControl(page, current)
    assert.match(await page.$eval('[data-workbench-status-popup]', element => element.textContent), /e2e-b.*Cached2K80.0%/)
    await page.keyboard.press('Escape')
    await page.click('[data-tab-id="system:agents"]')
    await page.waitForSelector(current, { hidden: true })
    assert.equal(await page.$(current), null)
    assert.match(await page.$eval(total, element => element.textContent), /3.2B/)
    await page.setViewport({ width: 850, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('[data-workbench-status-bar]', { hidden: true })
    assert.equal(await page.$('[data-workbench-status-bar]'), null)
  } finally { await page.close() }
})


test('Footer Terminal is a reusable bottom pane that collapses without PTY deletion and remains draggable', async () => {
  const terminal = { id: 'term-panel', nodeId: 'master', cwd: '/', title: 'Panel shell', attached: true }
  const page = await openFixture({ tabs: [system, chat('e2e-a', false)], terminal, responsiveChat: true, width: 1400 })
  const control = '[data-workbench-status-bar] button[aria-label="Toggle terminal"]'
  try {
    assert.equal(await page.$eval('[data-workbench-status-bar] button', button => button.getAttribute('aria-label')), 'Toggle terminal')
    await clickReadyControl(page, control)
    await page.waitForSelector('[data-terminal-header]', { visible: true })
    let snapshot = await state(page)
    const panes = node => node.kind === 'pane' ? [node] : node.children.flatMap(panes)
    const terminalTab = Object.values(snapshot.tabsById).find(tab => tab.type === 'terminal')
    assert.ok(terminalTab)
    const terminalPane = panes(snapshot.root).find(pane => pane.tabIds.includes(terminalTab.id))
    const sourcePane = panes(snapshot.root).find(pane => pane.tabIds.includes('chat:e2e-a'))
    assert.equal(snapshot.root.direction, 'column')
    const box = await page.$eval(`[data-pane-id="${terminalPane.id}"]`, element => ({ y: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height }))
    assert.ok(box.height > 180 && box.height < 360, `panel has a bounded initial height: ${box.height}`)
    assert.equal(await page.$eval(control, element => element.getAttribute('aria-expanded')), 'true')
    await page.evaluate(() => { window.__terminalRoot = document.querySelector('[data-terminal-header]'); window.__terminalConnectionsBefore = window.__terminalConnections.length })
    const beforeResize = box.height
    const divider = await page.$('[role="separator"]')
    const dividerBox = await divider.boundingBox()
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2)
    await page.mouse.down(); await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y - 60, { steps: 8 }); await page.mouse.up()
    assert.ok(await page.$eval(`[data-pane-id="${terminalPane.id}"]`, element => element.getBoundingClientRect().height) > beforeResize + 30)
    assert.ok(await page.evaluate(() => window.__terminalRoot.isConnected), 'divider dragging retains the Terminal content')
    assert.equal(await page.evaluate(() => window.__terminalConnections.length), await page.evaluate(() => window.__terminalConnectionsBefore))
    await page.click(`:is([data-pane-id="${terminalPane.id}"], [data-workbench-content-pane="${terminalPane.id}"]) button[aria-label="Collapse pane"]`)
    await page.waitForSelector(`[data-pane-id="${terminalPane.id}"][data-workbench-collapsed-pane="true"]`)
    assert.deepEqual((await state(page)).root.children.map(pane => pane.id), [sourcePane.id, terminalPane.id], 'Collapse keeps both panes and never merges Terminal into the editor')
    assert.ok((await state(page)).tabsById[terminalTab.id], 'Collapse retains the tab')
    assert.equal(await page.$('[data-terminal-header]'), null)
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), [])
    await clickReadyControl(page, control)
    await page.waitForSelector('[data-terminal-header]', { visible: true })
    assert.equal(Object.values((await state(page)).tabsById).filter(tab => tab.type === 'terminal').length, 1)
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [], 'the exact existing PTY is reused')
    await page.evaluate(() => { window.__terminalRoot = document.querySelector('[data-terminal-header]'); window.__terminalConnectionsBefore = window.__terminalConnections.length })
    await dragPane(page, terminalPane.id, sourcePane.id, 'right')
    assert.ok(await page.evaluate(() => window.__terminalRoot.isConnected), 'whole-pane docking retains Terminal DOM')
    assert.equal(await page.evaluate(() => window.__terminalConnections.length), await page.evaluate(() => window.__terminalConnectionsBefore), 'layout movement does not reconnect the PTY')
    assert.equal((await state(page)).root.direction, 'row')
    assert.ok(await page.$(`[data-workbench-pane-drag-area="${terminalPane.id}"]`))
    await clickReadyControl(page, control)
    await page.waitForSelector(`[data-pane-id="${terminalPane.id}"][data-workbench-collapsed-pane="true"]`)
    await clickReadyControl(page, control)
    await page.waitForSelector('[data-terminal-header]', { visible: true })
    assert.equal(Object.values((await state(page)).tabsById).filter(tab => tab.type === 'terminal').length, 1)
    await page.click(`:is([data-pane-id="${terminalPane.id}"], [data-workbench-content-pane="${terminalPane.id}"]) button[aria-label="Close pane"]`)
    await page.waitForFunction(id => !JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById[id], {}, terminalTab.id)
    assert.deepEqual(await page.evaluate(() => window.__terminalDeletes), ['/prefix/ui/api/terminals/term-panel'])
    assert.equal((await state(page)).root.kind, 'pane', 'closing the terminal panel leaves only the editor')
    assert.equal(Object.values((await state(page)).tabsById).filter(tab => tab.type === 'terminal').length, 0, 'close never moves Terminal into the editor')
    assert.deepEqual(await page.evaluate(() => window.__terminalCreates), [], 'Close does not recreate the just-deleted PTY')
    await page.waitForFunction(() => decodeURIComponent(location.hash) === '#tab/chat:e2e-a')
    await clickReadyControl(page, control)
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.tabsById).some(tab => tab.type === 'terminal' && tab.terminalId === 'term-reopened'))
    assert.equal(await page.evaluate(() => window.__terminalCreates.length), 1, 'a closed PTY is recreated only by explicit reopen')
    await clickReadyControl(page, control)
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('[data-workbench-status-bar]', { hidden: true })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-a'))
    await page.locator('.foxwarm-chat-root button[aria-label="Open session options"]').click()
    await page.waitForSelector('[data-session-ui-settings-menu]')
    assert.ok(await page.$('[data-session-ui-settings-menu] button::-p-text(Terminal)'))
    assert.equal(await page.$('[data-workbench-status-bar]'), null)
  } finally { await page.close() }
})


test('visible Chat keeps its DOM and initialization across split and normalization', async () => {
  const chatMessages = Array.from({ length: 35 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: 'Lifecycle message ' + index + '\n\n' + 'Retained timeline content. '.repeat(10) }], __meta: { seq: index + 1, timestamp: 1700000000000 + index } }))
  chatMessages[24] = { role: 'model', parts: [{ functionCall: { id: 'retained-call', name: 'read', args: { filePath: 'fixture.txt' } } }], __meta: { seq: 25, timestamp: 1700000000024 } }
  chatMessages[25] = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'retained-call', name: 'read', response: { output: 'Retained tool response' } } }], __meta: { seq: 26, timestamp: 1700000000025 } }
  const page = await openFixture({ responsiveChat: true, chatMessages, hash: '#tab/chat:e2e-a' })
  const assertUniformClip = async () => {
    const radii = await page.$$eval('[data-workbench-content-tab]', hosts => hosts.filter(host => !host.inert).map(host => {
      const slot = document.querySelector(`[data-workbench-content-slot="${host.dataset.workbenchContentPane}"]`)
      return [slot, host, host.firstElementChild].map(element => getComputedStyle(element).borderRadius)
    }))
    assert.ok(radii.length > 0)
    for (const corners of radii) assert.deepEqual(corners, ['9px', '9px', '9px'])
  }
  const waitForAnchor = () => page.waitForFunction(() => {
    const viewport = document.querySelector('.foxwarm-chat-messages').getBoundingClientRect()
    const anchor = document.querySelector('[data-chat-message-anchor-key="' + window.__originalScrollAnchor + '"]')
    return Math.abs(anchor.getBoundingClientRect().top - viewport.top - window.__originalScrollOffset) <= 2
  })
  try {
    await page.waitForSelector('.foxwarm-chat-root [data-chat-message-anchor-key]')
    await assertUniformClip()
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace')
    await page.keyboard.type('retained draft')
    await page.$eval('.foxwarm-chat-messages', element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await page.waitForFunction(() => !document.body.textContent.includes('Scroll upward to load'))
    await page.waitForSelector('button[aria-label="Expand tool group"]')
    await page.$eval('button[aria-label="Expand tool group"]', button => button.scrollIntoView({ block: 'center' }))
    await page.click('button[aria-label="Expand tool group"]')
    await page.waitForSelector('[data-tool-group-expanded="true"]')
    await page.waitForFunction(() => !document.querySelector('[data-tool-group-expanded="true"]').style.height)
    const scrollBox = await (await page.$('.foxwarm-chat-messages')).boundingBox()
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2)
    const beforeWheel = await page.$eval('.foxwarm-chat-messages', element => element.scrollTop)
    await page.mouse.wheel({ deltaY: -300 })
    await page.waitForFunction(top => Math.abs(document.querySelector('.foxwarm-chat-messages').scrollTop - top + 300) < 1, {}, beforeWheel)
    await page.evaluate(() => {
      window.__originalChat = document.querySelector('.foxwarm-chat-root')
      window.__originalTimeline = document.querySelector('[data-chat-timeline="committed"]')
      window.__originalHistoryCount = window.__historyReads.length
      window.__originalSubscriptions = window.__subscriptions.length
      window.__loadedRange = [...document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]')].map(row => row.dataset.chatMessageAnchorKey)
      const viewport = document.querySelector('.foxwarm-chat-messages').getBoundingClientRect()
      const scrollAnchor = [...document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]')].find(row => row.getBoundingClientRect().bottom > viewport.top + 1)
      window.__originalScrollAnchor = scrollAnchor.dataset.chatMessageAnchorKey
      window.__originalScrollOffset = scrollAnchor.getBoundingClientRect().top - viewport.top
    })
    await clickReadyControl(page, 'button[title="Split right with active tab"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.kind === 'split')
    await page.waitForSelector('.foxwarm-chat-root [data-chat-message-anchor-key]')
    await assertUniformClip()
    console.info('split lifecycle', await page.evaluate(() => ({ sameRoot: document.querySelector('.foxwarm-chat-root') === window.__originalChat, historyBefore: window.__originalHistoryCount, historyAfter: window.__historyReads.length, subscriptionsBefore: window.__originalSubscriptions, subscriptionsAfter: window.__subscriptions.length })))
    assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root') === window.__originalChat), true, 'split retains the same Chat root')
    assert.equal(await page.evaluate(() => document.querySelector('[data-chat-timeline="committed"]') === window.__originalTimeline), true)
    assert.equal(await page.evaluate(() => window.__historyReads.length), await page.evaluate(() => window.__originalHistoryCount), 'split issues no initialization history read')
    assert.ok(await page.evaluate(() => window.__subscriptions.slice(window.__originalSubscriptions).every(ids => ids.includes('e2e-a'))), 'split never removes the Chat logical session subscription')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await waitForAnchor()
    assert.ok(await page.$('[data-tool-group-expanded="true"]'), 'tool disclosure remains expanded')
    assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', element => element.textContent), 'retained draft')
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]')].map(row => row.dataset.chatMessageAnchorKey)), await page.evaluate(() => window.__loadedRange), 'the loaded timeline range is unchanged')
    assert.ok(await page.$eval('.foxwarm-chat-messages', element => element.scrollHeight - element.scrollTop - element.clientHeight > 200), 'layout does not discard upward scroll intent')
    await page.click('[data-workbench-tab-close="system:agents"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.kind === 'pane')
    await assertUniformClip()
    assert.equal(await page.evaluate(() => document.querySelector('.foxwarm-chat-root') === window.__originalChat), true, 'normalizing the last sibling retains Chat')
    assert.equal(await page.evaluate(() => window.__historyReads.length), await page.evaluate(() => window.__originalHistoryCount))
    await waitForAnchor()
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    assert.ok(await page.evaluate(() => window.__originalChat.isConnected), 'desktop/mobile shell changes retain the visible Chat')
    assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', element => element.textContent), 'retained draft')
  } finally { await page.close() }
})


test('Code retains its iframe/window across split, docking, collapse and desktop/mobile shells', async () => {
  const code = { id: 'vscode-web', type: 'vscode', title: 'Code' }
  const page = await openFixture({ tabs: [code, system, chat('e2e-a', false)], activeTabId: code.id, hash: '#tab/vscode-web', themeId: '550a', responsiveChat: true })
  const assertFrame = async () => {
    assert.ok(await page.evaluate(() => document.querySelector('[data-foxwarm-vscode-web-frame]') === window.__originalCode && window.__originalCode.contentWindow === window.__originalCodeWindow), 'the frame element and browsing context stay identical')
    assert.equal(await page.evaluate(() => window.__codeFrameLoads), 1, 'layout operations never reload Code')
  }
  try {
    await page.waitForFunction(() => window.__codeFrameLoads === 1)
    await page.evaluate(() => { window.__originalCode = document.querySelector('[data-foxwarm-vscode-web-frame]'); window.__originalCodeWindow = window.__originalCode.contentWindow })
    assert.equal(await page.$eval('[data-foxwarm-vscode-web-frame]', frame => Number(getComputedStyle(frame).zIndex)), 35)
    assert.equal(await page.evaluate(() => getComputedStyle(document.body, '::after').content), 'none', 'console treatment has no page-wide overlay above Code')
    await clickReadyControl(page, 'button[title="Split right with active tab"]')
    const split = await state(page)
    const codePane = findFixturePane(split.root, split.root.children[1].id)
    assert.ok(codePane.tabIds.includes(code.id))
    await assertFrame()
    await dragPane(page, codePane.id, 'pane-main', 'top', { duringDrag: async () => {
      assert.equal(await page.$eval('[data-foxwarm-vscode-web-frame]', frame => getComputedStyle(frame).pointerEvents), 'none', 'the visible iframe cannot intercept pane dragging')
      assert.ok(await page.$('[data-pane-drag-overlay]'))
      assert.ok(await page.evaluate(() => {
        const target = document.querySelector('[data-workbench-content-pane="pane-main"] [data-workbench-pane-drop="top"]').getBoundingClientRect()
        const strip = document.querySelector('[data-pane-id="pane-main"] .foxwarm-workbench-tab-row').getBoundingClientRect()
        const pointerY = target.top + target.height / 2
        return pointerY >= strip.top && pointerY <= strip.bottom
      }), 'the top drop target still covers the pane tab strip')
    } })
    await assertFrame()
    await page.click('[data-workbench-pane-collapse="pane-main"]')
    await page.waitForSelector('[data-pane-id="pane-main"][data-workbench-collapsed-pane="true"]')
    await page.waitForFunction(() => {
      const slot = document.querySelector('[data-workbench-content-slot]')?.getBoundingClientRect()
      const host = document.querySelector('[data-workbench-content-tab="vscode-web"]')?.getBoundingClientRect()
      return slot && host && Math.abs(slot.height - host.height) < 1
    })
    await assertFrame()
    // Clicking the iframe activates its pane without relying on pane DOM bubbling.
    await page.click('[data-workbench-collapsed-tab="chat:e2e-a"]')
    await page.waitForSelector('.foxwarm-chat-root [role="textbox"]')
    await page.click('.foxwarm-chat-root [role="textbox"]')
    const frame = await page.$('[data-foxwarm-vscode-web-frame]')
    const box = await frame.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === id, {}, codePane.id)
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    await assertFrame()
    await page.setViewport({ width: 1400, height: 900 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell')
    await assertFrame()
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) button[title="Close pane"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.root.kind === 'pane')
    // Close pane migrates tabs and selects its last tab, hiding but retaining Code.
    await assertFrame()
    await page.click('[data-tab-id="vscode-web"]')
    await assertFrame()
    await page.locator('[data-tab-id="chat:e2e-a"]').click()
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    await page.waitForSelector('.foxwarm-chat-root button[title="Back"]')
    await page.evaluate(() => { window.__ordinaryChat = document.querySelector('.foxwarm-chat-root') })
    await page.click('.foxwarm-chat-root button[title="Back"]')
    await page.waitForFunction(() => !document.querySelector('[data-pane-id]'))
    assert.equal(await page.evaluate(() => window.__ordinaryChat.isConnected), false, 'mobile list hiding still unmounts ordinary Chat')
    await assertFrame()
    assert.equal(await page.$eval('[data-foxwarm-vscode-web-frame]', frame => getComputedStyle(frame).visibility), 'hidden')
    assert.equal(await page.$eval('[data-foxwarm-vscode-web-frame]', frame => getComputedStyle(frame).pointerEvents), 'none')
  } finally { await page.close() }
})

test('restored Code starts only on its first actual visible surface', async () => {
  const code = { id: 'vscode-web', type: 'vscode', title: 'Code' }
  const page = await openFixture({ tabs: [code, chat('e2e-a', false)], activeTabId: code.id, width: 390 })
  try {
    assert.equal(await page.$('[data-foxwarm-vscode-web-frame]'), null, 'mobile list does not start the logically active Code tab')
    await page.setViewport({ width: 1400, height: 900 })
    await page.waitForFunction(() => window.__codeFrameLoads === 1)
    await page.click('[data-tab-id="vscode-web"] button[title="Close tab"]')
    await page.waitForFunction(() => !document.querySelector('[data-foxwarm-vscode-web-frame]'))
    assert.equal(await page.evaluate(() => window.__codeFrameLoads), 1)
  } finally { await page.close() }
})


test('the initial Code file request survives lazy frame creation and explicit reopen', async () => {
  const chatMessages = [
    { role: 'model', parts: [{ functionCall: { id: 'open-file', name: 'read', args: { filePath: '/fixture.txt', startLine: 3, endLine: 8 } } }], __meta: { seq: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'open-file', name: 'read', response: { output: 'File content' } } }], __meta: { seq: 2 } },
  ]
  const page = await openFixture({ tabs: [system, chat('e2e-a', false)], responsiveChat: true, chatMessages, codeNewWindow: false })
  try {
    const openFile = 'button[aria-label="Open /fixture.txt in Code"]'
    await clickReadyControl(page, openFile)
    await page.waitForFunction(() => window.__codeRequests?.some(request => request.kind === 'openFile'))
    assert.deepEqual(await page.evaluate(() => window.__codeRequests.find(request => request.kind === 'openFile')), { kind: 'openFile', nodeId: 'master', path: '/fixture.txt', startLine: 3, endLine: 8 })
    await page.click('[data-tab-id="vscode-web"] button[title="Close tab"]')
    await page.waitForSelector('[data-foxwarm-vscode-web-frame]', { hidden: true })
    await clickReadyControl(page, openFile)
    await page.waitForFunction(() => window.__codeRequests?.filter(request => request.kind === 'openFile').length === 2)
    assert.equal(await page.evaluate(() => window.__codeFrameLoads), 2, 'explicit Close creates a fresh frame only on reopening')
  } finally { await page.close() }
})


test('full-page Tasks and Chat modals block Sidebar navigation without losing their drafts', async () => {
  const tasks = { id: 'system:tasks', type: 'tasks', title: 'Tasks' }
  const page = await openFixture({ tabs: [tasks], activeTabId: tasks.id, hash: '#tab/system:tasks' })
  const sidebarPoint = async () => page.$eval('[data-session-id="e2e-b"]', row => {
    const box = row.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
  try {
    await page.waitForSelector('[data-task-new]')
    const originalTasks = await page.$('[data-tasks-view]')
    await page.click('[data-task-new]')
    await page.waitForSelector('[aria-labelledby="new-task-title"]')
    await page.type('[aria-labelledby="new-task-title"] input:not([type="checkbox"])', 'Unsubmitted task draft')
    const point = await sidebarPoint()
    assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('[aria-labelledby="new-task-title"]').parentElement, point), 'the modal backdrop intercepts the Sidebar hit')
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(() => !document.querySelector('[aria-labelledby="new-task-title"]'))
    assert.equal(await page.evaluate(() => decodeURIComponent(location.hash)), '#tab/system:tasks')
    assert.ok(await originalTasks.evaluate(element => element.isConnected), 'backdrop dismissal never navigates away or unmounts Tasks')
    await page.click('[data-task-new]')
    await page.waitForSelector('[aria-labelledby="new-task-title"]')
    assert.equal(await page.$eval('[aria-labelledby="new-task-title"] input:not([type="checkbox"])', input => input.value), 'Unsubmitted task draft')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[aria-labelledby="new-task-title"]'))
  } finally { await page.close() }

  const chatPage = await openFixture({ responsiveChat: true, hash: '#tab/chat:e2e-a' })
  try {
    await chatPage.waitForSelector('.foxwarm-chat-root input[type="file"]')
    const originalChat = await chatPage.$('.foxwarm-chat-root')
    await chatPage.evaluate(() => {
      const input = document.querySelector('.foxwarm-chat-root input[type="file"]')
      const files = new DataTransfer()
      files.items.add(new File(['Attachment draft'], 'draft.txt', { type: 'text/plain' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await chatPage.waitForSelector('[data-composer-attachment-ref] [data-composer-block-open]')
    await chatPage.click('[data-composer-attachment-ref] [data-composer-block-open]')
    await chatPage.waitForSelector('[aria-label="Attachment information"]')
    const point = await chatPage.$eval('[data-session-id="e2e-b"]', row => {
      const box = row.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    assert.ok(await chatPage.evaluate(({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('[aria-label="Attachment information"]').parentElement, point))
    await chatPage.mouse.click(point.x, point.y)
    await chatPage.waitForFunction(() => !document.querySelector('[aria-label="Attachment information"]'))
    assert.equal(await chatPage.evaluate(() => decodeURIComponent(location.hash)), '#tab/chat:e2e-a')
    assert.ok(await originalChat.evaluate(element => element.isConnected))
    assert.equal(await chatPage.$eval('[data-attachment-preview-ref]', tile => tile.textContent.includes('draft.txt')), true, 'backdrop dismissal retains the attachment draft')
  } finally { await chatPage.close() }
})

test('clicking a visible Code iframe activates its pane after another pane has focus', async () => {
  const code = { id: 'vscode-web', type: 'vscode', title: 'Code' }
  const page = await openFixture({ tabs: [chat('e2e-a', false), code], activeTabId: 'chat:e2e-a', hash: '#tab/chat:e2e-a', responsiveChat: true,
    layout: { id: 'focus-split', kind: 'split', direction: 'row', sizes: [50, 50], children: [
      { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a' },
      { id: 'pane-code', kind: 'pane', tabIds: [code.id], activeTabId: code.id },
    ] } })
  try {
    await page.waitForFunction(() => window.__codeFrameLoads === 1)
    await page.click('.foxwarm-chat-messages')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-main')
    const frame = await page.$('[data-foxwarm-vscode-web-frame]')
    const box = await frame.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + 12)
    await page.waitForFunction(() => document.activeElement?.tagName === 'IFRAME' && JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state.focusedPaneId === 'pane-code')
    assert.equal(await page.evaluate(() => location.hash), '#tab/vscode-web')
    await page.mouse.click(box.x + box.width / 2, box.y + 12)
    assert.equal(await page.evaluate(() => window.__codeFrameLoads), 1)
  } finally { await page.close() }
})


const idleViewportMessages = Array.from({ length: 55 }, (_, index) => ({
  role: index % 2 ? 'model' : 'user',
  parts: [{ text: `Idle row ${index}\n\n` + 'A stable loaded row without streaming, cards or async images. '.repeat(15) }],
  __meta: { seq: index + 1, timestamp: 1700000000000 + index },
}))

async function wheelIdleViewport(page, deltaY) {
  const container = await page.$('.foxwarm-chat-messages')
  const box = await container.boundingBox()
  const top = await container.evaluate(element => element.scrollTop)
  await page.mouse.move(box.x + 100, box.y + 100)
  await page.mouse.wheel({ deltaY })
  await page.waitForFunction(({ top, deltaY }) => Math.abs(document.querySelector('.foxwarm-chat-messages').scrollTop - top - deltaY) < 1, {}, { top, deltaY })
}

async function waitForIdleBottom(page) {
  await page.waitForFunction(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    return container.scrollHeight - container.clientHeight - container.scrollTop <= 1
  })
}

async function settleIdleViewport(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
}

async function openIdleViewportChat({ reading = false, popup = false } = {}) {
  const page = await openFixture({
    responsiveChat: true, chatMessages: idleViewportMessages, height: 1100,
    terminal: { id: 'term-panel', nodeId: 'master', cwd: '/', title: 'Panel shell', attached: true },
    tabs: [system, chat('e2e-a', false)],
    hash: popup ? '?foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=e2e-a' : '#tab/chat:e2e-a',
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 55)
  await settleIdleViewport(page)
  await wheelIdleViewport(page, -700)
  await clickReadyControl(page, '[aria-label="Scroll to bottom"]')
  await waitForIdleBottom(page)
  await settleIdleViewport(page)
  if (reading) await wheelIdleViewport(page, -500)
  await page.evaluate(() => { window.__idleChatRoot = document.querySelector('.foxwarm-chat-root') })
  return page
}

async function idleViewportSnapshot(page, anchorKey = null) {
  return page.evaluate(anchorKey => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const viewport = container.getBoundingClientRect()
    const rows = [...document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]')]
    const anchor = anchorKey
      ? rows.find(row => row.dataset.chatMessageAnchorKey === anchorKey)
      : rows.find(row => row.getBoundingClientRect().bottom > viewport.top + 1 && row.getBoundingClientRect().top < viewport.bottom)
    return {
      rootSame: document.querySelector('.foxwarm-chat-root') === window.__idleChatRoot,
      height: container.clientHeight, scrollHeight: container.scrollHeight, top: container.scrollTop,
      distance: container.scrollHeight - container.clientHeight - container.scrollTop,
      anchor: anchor?.dataset.chatMessageAnchorKey, offset: anchor?.getBoundingClientRect().top - viewport.top,
      rows: rows.length, historyReads: window.__historyReads.length,
    }
  }, anchorKey)
}

for (const action of ['Terminal', 'window height']) {
  for (const reading of [false, true]) {
    test(`idle ${action} resize preserves ${reading ? 'the reading anchor' : 'bottom follow'} without remount`, async () => {
      const page = await openIdleViewportChat({ reading })
      try {
        const before = await idleViewportSnapshot(page)
        if (action === 'Terminal') {
          await clickReadyControl(page, '[data-workbench-status-bar] button[aria-label="Toggle terminal"]')
          await page.waitForSelector('[data-terminal-header]', { visible: true })
        } else await page.setViewport({ width: 1400, height: 800 })
        await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').clientHeight < 750)
        await settleIdleViewport(page)
        if (!reading) await waitForIdleBottom(page)
        const after = await idleViewportSnapshot(page, before.anchor)
        assert.ok(after.height < before.height - 200)
        assert.equal(after.scrollHeight, before.scrollHeight, 'idle content did not grow')
        assert.ok(after.rootSame, 'viewport resizing keeps the same Chat DOM')
        assert.equal(after.historyReads, before.historyReads)
        assert.equal(after.rows, before.rows)
        if (reading) {
          assert.equal(after.anchor, before.anchor)
          assert.ok(Math.abs(after.offset - before.offset) <= 2, 'retain message offset, not a scrollTop snapshot')
          assert.ok(after.distance > 400, 'reading must not rejoin bottom follow')
        } else assert.ok(after.distance <= 1)
      } finally { await page.close() }
    })
  }
}

for (const reading of [false, true]) {
  test(`idle popup width resize preserves ${reading ? 'the reading anchor' : 'bottom follow'}`, async () => {
    const page = await openIdleViewportChat({ popup: true, reading })
    try {
      const before = await idleViewportSnapshot(page)
      await page.setViewport({ width: 900, height: 1100 })
      await settleIdleViewport(page)
      if (!reading) await waitForIdleBottom(page)
      const after = await idleViewportSnapshot(page, before.anchor)
      assert.ok(after.rootSame)
      assert.equal(after.historyReads, before.historyReads)
      assert.equal(after.rows, before.rows)
      assert.equal(after.height, before.height)
      assert.ok(after.scrollHeight > before.scrollHeight + 1000, 'narrower rows genuinely reflowed')
      if (reading) {
        assert.ok(Math.abs(after.offset - before.offset) <= 2)
        assert.ok(after.top > before.top + 1000, 'retention follows the message, not its old scrollTop')
        assert.ok(after.distance > 400)
      } else assert.ok(after.distance <= 1)
    } finally { await page.close() }
  })
}

test('idle continuous viewport resize lets upward wheel replace pending bottom restoration', async () => {
  const page = await openIdleViewportChat()
  try {
    // Exercise native wheel delivery while a previous resize scroll is still queued.
    if (!firefox) await page.emulateCPUThrottling(8)
    const before = await idleViewportSnapshot(page)
    const box = await (await page.$('.foxwarm-chat-messages')).boundingBox()
    await page.mouse.move(box.x + 100, box.y + 100)
    await page.exposeFunction('__idleResizeWheel', () => page.mouse.wheel({ deltaY: -400 }))
    await page.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      let wheelSeen = false
      window.__idleResizeTrace = []
      const record = (event, deltaY) => {
        if (window.__idleResizeTrace.length === 128) window.__idleResizeTrace.shift()
        window.__idleResizeTrace.push({
          event, at: performance.now(), deltaY, top: container.scrollTop,
          height: container.clientHeight, scrollHeight: container.scrollHeight,
          bottomAction: !!document.querySelector('[aria-label="Scroll to bottom"]'),
        })
      }
      record('initial')
      container.addEventListener('wheel', event => {
        if (event.deltaY < 0) wheelSeen = true
        record('wheel', event.deltaY)
      })
      container.addEventListener('scroll', () => {
        record('scroll')
        if (!wheelSeen || window.__idleUserAnchor || container.scrollHeight - container.clientHeight - container.scrollTop < 399) return
        const top = container.getBoundingClientRect().top
        const row = [...document.querySelectorAll('[data-chat-message-anchor-key]')].find(row => row.getBoundingClientRect().bottom > top + 1)
        if (row) window.__idleUserAnchor = { key: row.dataset.chatMessageAnchorKey, offset: row.getBoundingClientRect().top - top }
      })
      window.addEventListener('resize', () => record('viewport-resize'))
      new ResizeObserver(() => record('scroller-resize')).observe(container)
      window.addEventListener('resize', () => window.__idleResizeWheel().then(() => { window.__idleWheelDone = true; record('wheel-command-done') }), { once: true })
    })
    for (const height of [1050, 1000, 950, 900, 850, 800]) {
      await page.setViewport({ width: 1400, height })
      await page.evaluate(() => new Promise(requestAnimationFrame))
    }
    await page.waitForFunction(() => window.__idleWheelDone && window.__idleUserAnchor)
    await settleIdleViewport(page)
    const userAnchor = await page.evaluate(() => window.__idleUserAnchor)
    const after = await idleViewportSnapshot(page, userAnchor.key)
    assert.ok(after.rootSame)
    assert.equal(after.historyReads, before.historyReads)
    assert.equal(after.rows, before.rows)
    const resizeEvidence = JSON.stringify({ before, after, userAnchor, trace: await page.evaluate(() => window.__idleResizeTrace) })
    assert.ok(after.distance >= 399, `deferred resize correction must not take back user wheel movement: ${resizeEvidence}`)
    assert.ok(Math.abs(after.offset - userAnchor.offset) <= 2, `subsequent resize retains the user-selected reading anchor: ${resizeEvidence}`)
    await clickReadyControl(page, '[aria-label="Scroll to bottom"]')
    await waitForIdleBottom(page)
    await page.setViewport({ width: 1400, height: 900 })
    await page.setViewport({ width: 1400, height: 800 })
    await settleIdleViewport(page)
    await waitForIdleBottom(page)
    assert.ok((await idleViewportSnapshot(page)).distance <= 1, 'explicit rejoin restores follow for later resizing')
  } finally { await page.close() }
})

async function themePackageFromPreview(page, id, mode) {
  await clickReadyControl(page, `[data-theme-preview-mode="${mode}"][data-theme-preview="${id}"]`)
  await page.waitForSelector('[data-theme-preview-dialog]')
  await page.evaluate(() => {
    URL.createObjectURL = blob => { window.__exportedTheme = blob.text(); return 'blob:fixture-theme' }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await page.click('[data-theme-preview-dialog] button[aria-label="Export theme"]')
  const manifest = await page.evaluate(async () => JSON.parse(await window.__exportedTheme))
  await page.keyboard.press('Escape')
  return manifest
}

async function importThemePackage(page, manifest) {
  await page.$eval('[data-theme-manager] input[type="file"]', (input, text) => {
    const files = new DataTransfer(); files.items.add(new File([text], 'fixture.foxwarm-theme.json', { type: 'application/json' }))
    input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
  }, JSON.stringify(manifest))
  await page.waitForSelector('[data-theme-preview-dialog]')
}

test('Appearance Auto keeps independent choices and previews require explicit application', async () => {
  const setup = { id: 'system:setup', type: 'setup', title: 'Setup' }
  const page = await openFixture({ tabs: [setup], activeTabId: setup.id, hash: '#setup', width: 1400 })
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await page.waitForSelector('[data-theme-manager]')
    await clickReadyControl(page, '[data-theme-color-mode="auto"]')
    assert.equal(await page.$$eval('[data-theme-mode-panel]', panels => panels.length), 2)
    await clickReadyControl(page, '[data-theme-preview-mode="light"][data-theme-preview="foxwarm.vector"]')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.default')
    assert.equal(await page.$('[data-theme-preview-dialog] button[aria-label="Delete theme"]'), null)
    assert.equal(await page.$('[data-theme-manager] select'), null)
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-theme-preview-close')), true)
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Use for dark')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-theme-preview-close')), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.themePreview), 'foxwarm.vector')
    await clickReadyControl(page, '[data-theme-option-mode="light"][data-theme-option="foxwarm.vector"]')
    await page.waitForSelector('[data-theme-preview-dialog]', { hidden: true })
    await clickReadyControl(page, '[data-theme-preview-mode="dark"][data-theme-preview="foxwarm.catppuccin"]')
    const rootAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-accent'))
    const darkScene = await page.$eval('[data-theme-workbench-preview]', scene => getComputedStyle(scene).getPropertyValue('--foxwarm-color-accent'))
    assert.notEqual(darkScene, rootAccent, 'the detailed sample is locally themed, not inherited from the active app')
    await page.click('[aria-label="Preview light"]')
    assert.notEqual(await page.$eval('[data-theme-workbench-preview]', scene => getComputedStyle(scene).getPropertyValue('--foxwarm-color-accent')), darkScene)
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-accent')), rootAccent)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.vector')
    await page.click('[aria-label="Use for dark"]')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.vector', 'editing the inactive slot does not change the current appearance')
    const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_theme_selection_v3')))
    assert.equal(selection.lightThemeId, 'foxwarm.vector'); assert.equal(selection.darkThemeId, 'foxwarm.catppuccin')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'foxwarm.catppuccin')
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-accent-text').trim()), '#11111b')
    await clickReadyControl(page, '[data-theme-color-mode="light"]')
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'foxwarm.vector')
    assert.equal(await page.$$eval('[data-theme-mode-panel]', panels => panels.length), 1)
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('[data-theme-manager]')
    await waitForWebUiReady(page)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.vector')
    await clickReadyControl(page, '[data-theme-color-mode="auto"]')
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'foxwarm.catppuccin')
    const manifest = await themePackageFromPreview(page, 'foxwarm.catppuccin', 'dark')
    manifest.id = 'custom.auto-pair'; manifest.name = 'Imported fixture'
    await importThemePackage(page, manifest)
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.catppuccin', 'Import previews without silently applying')
    await page.click('[aria-label="Use for dark"]')
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'custom.auto-pair')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_theme_selection_v3')).lightThemeId), 'foxwarm.vector')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'foxwarm.vector')
    await clickReadyControl(page, '[data-theme-preview-mode="dark"][data-theme-preview="custom.auto-pair"]')
    page.once('dialog', dialog => dialog.accept())
    await page.click('[aria-label="Delete theme"]')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('foxwarm_theme_selection_v3')).darkThemeId === 'foxwarm.default')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.vector', 'deleting the inactive-slot theme preserves the active slot')
    await page.setViewport({ width: 850, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await clickReadyControl(page, '[data-theme-preview-mode="dark"][data-theme-preview="foxwarm.catppuccin"]')
    await page.setViewport({ width: 390, height: 844 })
    assert.equal(await page.$eval('[data-theme-preview-dialog]', element => element.getBoundingClientRect().width <= innerWidth - 24), true)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.theme-scene-sidebar')).display === 'none')
    assert.ok(await page.$('[data-theme-workbench-preview] .theme-scene-composer'))
    await page.keyboard.press('Escape')
  } finally { await page.close() }
})

test('Focused panes keep neutral outlines and Sidebar launcher buttons keep visible borders', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a', false), chat('e2e-b', false)], split: true, splitSecondChat: true, responsiveChat: true, themeId: 'foxwarm.vector' })
  try {
    await page.waitForSelector(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root')
    const before = await page.$eval('[data-pane-id="pane-main"]', element => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow }))
    await page.click(':is([data-pane-id="pane-main"], [data-workbench-content-pane="pane-main"]) .foxwarm-chat-root')
    assert.deepEqual(await page.$eval('[data-pane-id="pane-main"]', element => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow })), before)
    assert.equal(before.shadow, 'none')
    for (const title of ['Open agents overview', 'Open code', 'Create terminal tab']) {
      const selector = `.foxwarm-sidebar-panel button[title="${title}"]`
      const border = await page.$eval(selector, element => ({ width: getComputedStyle(element).borderTopWidth, style: getComputedStyle(element).borderTopStyle, color: getComputedStyle(element).borderTopColor }))
      assert.equal(border.width, '1px'); assert.equal(border.style, 'solid'); assert.notEqual(border.color, 'rgba(0, 0, 0, 0)')
    }
  } finally { await page.close() }
})

test('Imported V3 theme independently binds workbench chrome and accent foreground', async () => {
  const setup = { id: 'system:setup', type: 'setup', title: 'Setup' }
  const page = await openFixture({ tabs: [setup, chat('e2e-a', false)], activeTabId: setup.id, hash: '#setup', width: 1400 })
  try {
    await page.waitForSelector('[data-theme-manager]')
    await clickReadyControl(page, '[data-theme-color-mode="light"]')
    const exported = await themePackageFromPreview(page, 'foxwarm.default', 'light')
    assert.equal(exported.schemaVersion, 3)
    exported.id = 'example.chrome-contract'; exported.name = 'Chrome contract'
    const overrides = { sidebarSurface: '#fbeee8', tabBarSurface: '#e5eafa', workbenchHeaderSurface: '#e8fbe9', statusBarSurface: '#f8e8fb', accent: '#f0df80', accentText: '#242414' }
    Object.assign(exported.variants.light.colors, overrides)
    exported.variants.light.shape.cardRadiusPx = 24
    exported.variants.light.composition.header = 'banded'
    await importThemePackage(page, exported)
    const cardGeometry = await page.$eval('[data-theme-workbench-preview] .theme-scene-tool', card => {
      const header = card.querySelector('.theme-scene-tool-header')
      const rect = card.getBoundingClientRect()
      return { outerRadius: getComputedStyle(card).borderTopLeftRadius, clipping: getComputedStyle(card).overflow, innerRadius: getComputedStyle(header).borderTopLeftRadius, headerLeaksAtCorner: header.contains(document.elementFromPoint(rect.left + 3, rect.top + 3)) }
    })
    assert.deepEqual(cardGeometry, { outerRadius: '24px', clipping: 'hidden', innerRadius: '23px', headerLeaksAtCorner: false })
    const apply = await page.$eval('[aria-label="Use for light"]', button => ({ ink: getComputedStyle(button).color, fill: getComputedStyle(button).backgroundColor }))
    assert.equal(apply.ink, 'rgb(255, 255, 255)', 'the preview dialog retains the active application theme')
    await page.click('[aria-label="Use for light"]')
    await page.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'example.chrome-contract')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.foxwarm-sidebar-panel')).backgroundColor === 'rgb(251, 238, 232)')
    assert.equal(await page.$eval('.foxwarm-workbench-tab-strip', element => getComputedStyle(element).backgroundColor), 'rgb(229, 234, 250)')
    assert.equal(await page.$eval('.foxwarm-workbench-tab[data-tab-active="true"]', element => getComputedStyle(element).backgroundColor), 'rgb(232, 251, 233)')
    assert.equal(await page.$eval('[data-workbench-status-bar]', element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'the full status bar stays transparent even with a custom status surface')
    await clickReadyControl(page, '[data-theme-preview-mode="light"][data-theme-preview="foxwarm.vector"]')
    assert.deepEqual(await page.$eval('[aria-label="Use for light"]', button => ({ ink: getComputedStyle(button).color, fill: getComputedStyle(button).backgroundColor })), { ink: 'rgb(36, 36, 20)', fill: 'rgb(240, 223, 128)' })
    await page.keyboard.press('Escape')
    await page.click('[data-tab-id="chat:e2e-a"]')
    await page.waitForSelector('.foxwarm-chat-root')
    assert.equal(await page.$eval('.foxwarm-chat-root .sticky', element => getComputedStyle(element).backgroundColor), 'rgb(232, 251, 233)')
  } finally { await page.close() }
})

async function openConversationScrollFixture(phase) {
  const page = await openFixture({ responsiveChat: true, chatMessages: idleViewportMessages,
    timelineView: 'conversation', height: 1100, hash: '#tab/chat:e2e-a', tabs: [chat('e2e-a', false)] })
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 55)
  await page.evaluate(phase => {
    let sequence = 0
    let paragraphs = 160
    const container = document.querySelector('.foxwarm-chat-messages')
    window.__conversationScrollFrames = []
    window.__conversationStreamTicks = 0
    window.__conversationWheelSeen = false
    window.__conversationLeftBottom = false
    container.addEventListener('wheel', () => { window.__conversationWheelSeen = true }, { passive: true })
    container.addEventListener('scroll', () => {
      if (window.__conversationWheelSeen && container.scrollHeight - container.scrollTop - container.clientHeight > 4) window.__conversationLeftBottom = true
    }, { passive: true })
    const frame = () => {
      window.__conversationScrollFrames.push({ top: container.scrollTop, height: container.scrollHeight, reading: window.__conversationLeftBottom })
      if (window.__conversationRecording) requestAnimationFrame(frame)
    }
    window.__conversationRecording = true
    requestAnimationFrame(frame)
    window.__growConversationText = () => {
      window.__conversationStreamTicks++
      const text = 'CONVERSATION_SCROLL ordinary reply. ' + ('Visible answer text grows while the reader uses the native wheel. '.repeat(4) + '\n\n').repeat(paragraphs++)
      window.WebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'session-event', sessionId: 'e2e-a', event: {
        type: 'model-stream-update', streamVersion: 2, sequence: ++sequence, streamId: 'conversation-scroll',
        llmRequestId: 'conversation-scroll-request', startedAt: 1700000005000,
        partDeltas: [{ outputIndex: 0, contentIndex: 0, kind: 'text', ...(phase ? { phase } : {}), textDelta: { offset: 0, text } }],
      } }) })
    }
    window.__growConversationText()
  }, phase)
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-assistant-message-card')].some(card => card.textContent.includes('CONVERSATION_SCROLL')))
  await waitForIdleBottom(page)
  await settleIdleViewport(page)
  return page
}

async function conversationScrollPosition(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const card = [...document.querySelectorAll('.foxwarm-assistant-message-card')].find(card => card.textContent.includes('CONVERSATION_SCROLL'))
    return { top: container.scrollTop, height: container.scrollHeight, distance: container.scrollHeight - container.scrollTop - container.clientHeight,
      preview: !!card.closest('[data-conversation-preview]'), expanded: !!document.querySelector('[data-activity-expanded="true"]'),
      sameCard: !window.__conversationOriginalCard || card === window.__conversationOriginalCard }
  })
}

for (const phase of ['final_answer', undefined]) {
  test(`Conversation ${phase || 'unknown-phase'} text does not pull an upward wheel reader forward during continued streaming`, async () => {
    const page = await openConversationScrollFixture(phase)
    try {
      const attached = await conversationScrollPosition(page)
      assert.equal(attached.preview, false)
      assert.equal(attached.expanded, false)
      await page.evaluate(() => {
        window.__conversationOriginalCard = [...document.querySelectorAll('.foxwarm-assistant-message-card')].find(card => card.textContent.includes('CONVERSATION_SCROLL'))
        window.__growConversationText()
      })
      await waitForIdleBottom(page)
      assert.ok((await conversationScrollPosition(page)).height > attached.height, 'attached streaming genuinely added visible content')
      const box = await (await page.$('.foxwarm-chat-messages')).boundingBox()
      await page.mouse.move(box.x + 100, box.y + 120)
      await page.evaluate(() => { window.__conversationStreamTimer = setInterval(window.__growConversationText, 20) })
      await page.mouse.wheel({ deltaY: -160 })
      await page.waitForFunction(() => window.__conversationLeftBottom)
      const startTick = await page.evaluate(() => window.__conversationStreamTicks)
      await page.waitForFunction(tick => window.__conversationStreamTicks >= tick + 6, {}, startTick)
      await page.mouse.wheel({ deltaY: -160 })
      await page.waitForFunction(tick => window.__conversationStreamTicks >= tick + 9, {}, startTick)
      await page.evaluate(() => clearInterval(window.__conversationStreamTimer))
      await settleIdleViewport(page)
      await page.evaluate(() => { window.__conversationRecording = false })
      const frames = await page.evaluate(() => window.__conversationScrollFrames)
      const reverse = frames.flatMap((frame, index) => {
        const previous = frames[index - 1]
        return previous?.reading && frame.top > previous.top + 1 ? [{ before: previous, after: frame }] : []
      })
      assert.deepEqual(reverse, [], 'no token-only frame may reverse native upward reader movement')
      const reader = await conversationScrollPosition(page)
      assert.ok(reader.distance > 4)
      assert.ok(reader.sameCard)
      assert.equal(reader.preview, false)
      assert.equal(reader.expanded, false)
      // Explicit rejoin restores attached follow, including subsequent streaming.
      await clickReadyControl(page, '[aria-label="Scroll to bottom"]')
      await page.evaluate(() => window.__growConversationText())
      await waitForIdleBottom(page)
    } finally { await page.close() }
  })
}

test('Conversation live text preserves a detached downward reader during continued growth', async () => {
  const page = await openConversationScrollFixture('final_answer')
  try {
    await page.evaluate(() => { window.__conversationOriginalCard = [...document.querySelectorAll('.foxwarm-assistant-message-card')].find(card => card.textContent.includes('CONVERSATION_SCROLL')) })
    const box = await (await page.$('.foxwarm-chat-messages')).boundingBox()
    await page.mouse.move(box.x + 100, box.y + 120)
    await page.mouse.wheel({ deltaY: -600 })
    await page.waitForFunction(() => window.__conversationLeftBottom)
    await settleIdleViewport(page)
    const before = await conversationScrollPosition(page)
    await page.evaluate(() => { window.__conversationStreamTimer = setInterval(window.__growConversationText, 20) })
    await page.mouse.wheel({ deltaY: 100 })
    await page.waitForFunction(top => document.querySelector('.foxwarm-chat-messages').scrollTop >= top + 99, {}, before.top)
    const startTick = await page.evaluate(() => window.__conversationStreamTicks)
    await page.waitForFunction(tick => window.__conversationStreamTicks >= tick + 6, {}, startTick)
    await page.evaluate(() => clearInterval(window.__conversationStreamTimer))
    await settleIdleViewport(page)
    const after = await conversationScrollPosition(page)
    assert.ok(Math.abs(after.top - before.top - 100) <= 2, 'only the requested downward wheel changes reader position')
    assert.ok(after.distance > 4)
    assert.ok(after.sameCard)
  } finally { await page.close() }
})


for (const deltaY of [-160, -3]) {
  test(`natural scrollbar bottom rejoin ${deltaY < -4 ? 'survives fractional Workbench pane dimensions' : 'finishes a small pending upward leave'}`, async () => {
    const page = await openFixture({ responsiveChat: true, chatMessages: idleViewportMessages, showScrollbar: true,
      tabs: [chat('e2e-a', false), system], hash: '#tab/chat:e2e-a', width: 1401, height: 901,
      layout: { id: 'fractional-split', kind: 'split', direction: 'row', sizes: [47.37, 52.63], children: [
        { id: 'pane-main', kind: 'pane', tabIds: ['chat:e2e-a'], activeTabId: 'chat:e2e-a' },
        { id: 'pane-other', kind: 'pane', tabIds: [system.id], activeTabId: system.id },
      ] } })
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-chat-message-anchor-key]').length === 55)
      await waitForIdleBottom(page)
      const bounds = await (await page.$('.foxwarm-chat-messages')).boundingBox()
      await page.mouse.move(bounds.x + 100, bounds.y + 120)
      await page.mouse.wheel({ deltaY })
      await page.waitForFunction(deltaY => {
        const scroll = document.querySelector('.foxwarm-chat-messages')
        return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > (deltaY < -4 ? 100 : 0)
      }, {}, deltaY)
      const thumb = await page.$eval('.foxwarm-chat-messages', scroll => {
        const rect = scroll.getBoundingClientRect()
        const track = scroll.clientHeight
        const size = track * track / scroll.scrollHeight
        const gutter = scroll.offsetWidth - scroll.clientWidth
        return { x: rect.right - gutter / 2, y: rect.top + scroll.scrollTop / (scroll.scrollHeight - track) * (track - size) + size / 2, bottom: rect.bottom - 1, gutter }
      })
      assert.ok(thumb.gutter > 0, 'the real native scrollbar is enabled')
      await page.mouse.move(thumb.x, thumb.y)
      await page.mouse.down()
      await page.mouse.move(thumb.x, thumb.bottom, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const scroll = document.querySelector('.foxwarm-chat-messages')
        return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1
      })
      await page.waitForFunction(() => !document.querySelector('[aria-label="Scroll to bottom"]'))
    } finally { await page.close() }
  })
}


async function badgePresentation(page, selector) {
  return page.$eval(selector, badge => {
    const style = getComputedStyle(badge)
    const dot = getComputedStyle(badge.firstElementChild)
    return { font: style.fontSize, line: style.lineHeight, padding: style.padding, radius: style.borderRadius, gap: style.gap, color: style.color, background: style.backgroundColor, dot: [dot.width, dot.height, dot.borderRadius, dot.backgroundColor] }
  })
}

test('status popups keep full Node connectivity counts and compact theme-visible sections', async () => {
  const nodeDirectory = Array.from({ length: 14 }, (_, index) => ({
    id: `fixture-node-${String(index + 1).padStart(2, '0')}`,
    displayName: `Fixture node ${index + 1}${[0, 2, 8].includes(index) ? ' — a long display name that must truncate inside the popup' : ''}`,
    type: 'cli-node', online: index < 8,
    services: { 'vscode-fs': 1 },
    ...(index === 2 ? { protocolCompatibility: { status: 'upgrade-required' } } : {}),
  }))
  const taskRows = [
    { id: 'fixture-active', title: 'Review Node status — a long task title that must truncate without hiding the badge', status: 'active', updatedAt: 1700000000000, ownerSessionId: null },
    { id: 'fixture-open', title: 'Check pending setup', status: 'open', updatedAt: 1700000000000, ownerSessionId: null },
  ]
  for (const [themeId, colorMode] of [['foxwarm.default', 'dark'], ['foxwarm.default', 'light'], ['foxwarm.550a', 'dark']]) {
    const page = await openFixture({ tabs: [nodesTab], activeTabId: nodesTab.id, themeId, colorMode, nodeDirectory, taskRows, width: 1280, height: 760 })
    try {
      const label = `${themeId.split('.').at(-1)}-${colorMode}`
      const nodesTrigger = '[data-workbench-status-bar] button[aria-label^="Nodes:"]'
      const popup = '[data-workbench-status-popup]'
      await page.waitForSelector('[data-node-surface]')
      await page.waitForSelector('[data-workbench-status-bar] button[aria-label="Tasks: 1 active, 2 unfinished"]')
      await page.waitForSelector(`${nodesTrigger}[title="Nodes: 9 online, 15 total"]`)
      assert.equal(await page.$eval(`${nodesTrigger} span:last-child`, element => element.textContent), '9/15')
      assert.match(await page.$eval('[data-node-surface]', element => element.textContent), /Online 9 · Total 15/)
      assert.equal(await page.$$eval('[data-node-surface] article', cards => cards.length), 15)
      assert.match(await page.$eval('[data-node-surface] article:nth-child(4)', card => card.textContent), /Online.*Upgrade required/)
      await workbenchScreenshot(page, `nodes-page-${label}.png`)
      const nodePageBadge = await badgePresentation(page, '[data-node-surface] [data-status="online"]')
      assert.deepEqual({ font: nodePageBadge.font, line: nodePageBadge.line, padding: nodePageBadge.padding, radius: nodePageBadge.radius, gap: nodePageBadge.gap, dot: nodePageBadge.dot.slice(0, 3) }, { font: '11px', line: '18px', padding: '3px 7px', radius: '5px', gap: '5px', dot: ['5px', '5px', '50%'] })
      const directoryReads = await page.evaluate(() => window.__fetches.filter(request => request.path.endsWith('/api/nodes')).length)
      await page.click(nodesTrigger)
      await page.waitForSelector(popup, { visible: true })
      await workbenchScreenshot(page, `nodes-popup-${label}.png`)
      const summary = await page.$eval(popup, element => element.textContent)
      assert.match(summary, /Online9Total15/)
      const list = `${popup} [role="list"]`
      assert.deepEqual(await badgePresentation(page, `${list} [data-status="online"]`), { ...nodePageBadge, padding: '1px 5px', line: '16px' })
      assert.equal(await page.$$eval(`${list} .status-badge`, badges => badges.every(badge => { const style = getComputedStyle(badge); return style.padding === '1px 5px' && style.lineHeight === '16px' })), true)
      const rowOverflow = await page.$$eval(`${list} [role="listitem"]`, rows => rows.some(row => row.scrollWidth > row.clientWidth))
      assert.equal(rowOverflow, false)
      assert.equal(await page.$eval(`${list} [role="listitem"]:nth-child(2) > span:first-child`, name => name.scrollWidth > name.clientWidth), true)
      assert.equal(await page.$$eval(`${list} [role="listitem"]`, rows => rows.length), 15)
      assert.deepEqual(await page.$$eval(`${list} [role="listitem"] > span:first-child`, names => names.map(name => name.title)), ['master', ...nodeDirectory.map(node => node.id)])
      assert.match(await page.$eval(`${list} [role="listitem"]:nth-child(4)`, row => row.textContent), /Online.*Upgrade required/)
      const initial = await page.$eval(popup, element => {
        const rect = element.getBoundingClientRect()
        const list = element.querySelector('[role=list]')
        return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, body: document.body.scrollHeight, bodyClient: document.body.clientHeight, popupScroll: element.scrollTop, listHeight: list.clientHeight, listScrollHeight: list.scrollHeight }
      })
      assert.ok(initial.top >= 8 && initial.bottom <= initial.viewport - 8, JSON.stringify(initial))
      assert.ok(initial.listScrollHeight > initial.listHeight)
      const listBounds = await (await page.$(list)).boundingBox()
      await page.mouse.move(listBounds.x + listBounds.width / 2, listBounds.y + listBounds.height / 2)
      await page.mouse.wheel({ deltaY: 100 })
      await page.waitForFunction(() => document.querySelector('[aria-label="Node directory"]').scrollTop > 0)
      const seventhVisible = await page.$eval(`${list} [role="listitem"]:nth-child(7)`, row => { const rect = row.getBoundingClientRect(); const parent = row.parentElement.getBoundingClientRect(); return rect.top >= parent.top && rect.bottom <= parent.bottom })
      assert.equal(seventhVisible, true)
      await page.focus(list)
      await page.keyboard.press('End')
      await page.waitForFunction(() => { const list = document.querySelector('[aria-label="Node directory"]'); return list.scrollTop + list.clientHeight >= list.scrollHeight - 1 })
      const scroll = await page.$eval(popup, element => {
        const list = element.querySelector('[role=list]'); const last = list.lastElementChild.getBoundingClientRect(); const rect = list.getBoundingClientRect()
        return { listScroll: list.scrollTop, popupScroll: element.scrollTop, windowScroll: scrollY, bodyScroll: document.body.scrollTop, pageScroll: document.querySelector('[data-node-surface]').parentElement.parentElement.scrollTop, lastVisible: last.top >= rect.top && last.bottom <= rect.bottom + 1 }
      })
      await workbenchScreenshot(page, `nodes-popup-last-${label}.png`)
      assert.equal(scroll.lastVisible, true); assert.equal(scroll.popupScroll, 0); assert.equal(scroll.windowScroll, 0); assert.equal(scroll.bodyScroll, 0); assert.equal(scroll.pageScroll, 0)
      assert.equal(await page.evaluate(() => window.__fetches.filter(request => request.path.endsWith('/api/nodes')).length), directoryReads)
      console.info('status popup geometry', label, { initial, scroll })
      console.info('status popup styles', label, await page.$eval(popup, element => {
        const style = getComputedStyle(element)
        const section = element.querySelector('.foxwarm-status-popup-section')
        const sectionStyle = getComputedStyle(section)
        return { surface: style.backgroundColor, divider: sectionStyle.borderTopColor, dividerWidth: sectionStyle.borderTopWidth, marginTop: sectionStyle.marginTop, paddingTop: sectionStyle.paddingTop, height: element.getBoundingClientRect().height }
      }))
      assert.equal(await page.$eval(`${popup} .foxwarm-status-popup-section`, element => getComputedStyle(element).borderTopColor !== getComputedStyle(element.parentElement).backgroundColor), true)
      await page.evaluate(() => [...document.querySelectorAll('[data-workbench-status-popup] button')].find(button => button.textContent === 'Open Nodes').focus())
      await page.keyboard.press('Enter')
      await page.waitForSelector(popup, { hidden: true })
      assert.equal((await state(page)).hash, '#tab/system:nodes')
      await page.click('[data-workbench-status-bar] button[aria-label="Tasks: 1 active, 2 unfinished"]')
      await page.waitForFunction(() => document.querySelector('[data-workbench-status-popup]')?.textContent.includes('Review Node status'))
      await workbenchScreenshot(page, `tasks-popup-${label}.png`)
      const taskPopupBadge = await badgePresentation(page, `${popup} .task-status[data-status="active"]`)
      assert.deepEqual(taskPopupBadge, { ...nodePageBadge, padding: '1px 5px', line: '16px' })
      console.info('badge sizes', label, { page: { padding: nodePageBadge.padding, line: nodePageBadge.line }, popup: { padding: taskPopupBadge.padding, line: taskPopupBadge.line }, font: taskPopupBadge.font, dot: taskPopupBadge.dot.slice(0, 2) })
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(resource => /TasksView-.*\.css/.test(resource.name))), false, 'first popup is styled before the lazy Tasks page/CSS is loaded')
      assert.equal(await page.$eval(`${popup} .task-status`, badge => badge.textContent), 'Active')
      assert.equal(await page.$eval(`${popup} .task-status`, badge => badge.parentElement.scrollWidth > badge.parentElement.clientWidth), false)
      assert.equal(await page.$eval(`${popup} .task-status`, badge => { const name = badge.previousElementSibling; return name.scrollWidth > name.clientWidth }), true)
      const tasksGeometry = await page.$eval(popup, element => {
        const sections = [...element.querySelectorAll('.foxwarm-status-popup-section')].map(section => { const style = getComputedStyle(section); return { border: style.borderTopColor, margin: parseFloat(style.marginTop), padding: parseFloat(style.paddingTop) } })
        return { height: element.getBoundingClientRect().height, surface: getComputedStyle(element).backgroundColor, sections }
      })
      assert.ok(tasksGeometry.height < 230, JSON.stringify(tasksGeometry))
      assert.ok(tasksGeometry.sections.every(section => section.border !== tasksGeometry.surface && section.margin + section.padding <= 12))
      console.info('task popup geometry', label, tasksGeometry)
      assert.ok((await page.evaluate(() => window.__fetches.filter(request => request.path.endsWith('/tasks') && new URLSearchParams(request.search).get('limit') === '3'))).length === 2)
      if (themeId === 'foxwarm.default') {
        await page.evaluate(() => [...document.querySelectorAll('[data-workbench-status-popup] button')].find(button => button.textContent === 'Open Tasks').focus())
        await page.keyboard.press('Enter')
        await page.waitForSelector('.tasks-table .task-status[data-status="active"]')
        assert.deepEqual(await badgePresentation(page, '.tasks-table .task-status[data-status="active"]'), { ...taskPopupBadge, padding: '3px 7px', line: '18px' })
        await workbenchScreenshot(page, `tasks-page-${label}.png`)
        await page.click('[data-workbench-status-bar] button[aria-label="Tasks: 1 active, 2 unfinished"]')
        await page.waitForFunction(() => document.querySelector('[data-workbench-status-popup] .task-status')?.textContent === 'Active')
        await workbenchScreenshot(page, `tasks-page-popup-${label}.png`)
      }

    } finally { await page.close() }
  }
})

for (const reducedMotion of [false, true]) {
  test(`startup splash unmounts and releases pointer input with reduced motion ${reducedMotion}`, async () => {
    const page = await openFixture({ tabs: [chat('e2e-a', false)], activeTabId: 'chat:e2e-a', reducedMotion, waitForSplash: false })
    try {
      if (reducedMotion) {
        const animations = await page.$$eval('[data-fox-splash] svg path', paths => paths.map(path => getComputedStyle(path).animationName))
        assert.ok(animations.every(name => name === 'none'))
      }
      await page.waitForFunction(() => !document.querySelector('[data-fox-splash]'), { timeout: 8_000 })
      await clickReadyControl(page, '.foxwarm-chat-composer-textarea')
      assert.equal(await page.$eval('.foxwarm-chat-composer-textarea', editor => document.activeElement === editor), true)
    } finally { await page.close() }
  })
}

test('cross-window theme changes close a deleted preview and release the background', async () => {
  const setup = { id: 'system:setup', type: 'setup', title: 'Setup' }
  const first = await openFixture({ tabs: [setup], activeTabId: setup.id, hash: '#setup' })
  let second
  try {
    await clickReadyControl(first, '[data-theme-color-mode="light"]')
    const exported = await themePackageFromPreview(first, 'foxwarm.default', 'light')
    exported.id = 'custom.cross-window'; exported.name = 'Cross-window fixture'
    await importThemePackage(first, exported)
    second = await openFixture({ tabs: [setup], activeTabId: setup.id, hash: '#setup' })
    await clickReadyControl(second, '[data-theme-option-mode="light"][data-theme-option="custom.cross-window"]')
    await first.bringToFront()
    await first.waitForFunction(() => document.documentElement.dataset.foxwarmTheme === 'custom.cross-window')
    await second.bringToFront()
    await clickReadyControl(second, '[data-theme-preview-mode="light"][data-theme-preview="custom.cross-window"]')
    second.once('dialog', dialog => dialog.accept())
    await second.click('[aria-label="Delete theme"]')
    await first.bringToFront()
    await first.waitForFunction(() => !document.querySelector('[data-theme-preview-dialog]') && !document.getElementById('root').inert)
    assert.notEqual(await first.evaluate(() => document.body.style.overflow), 'hidden')
    assert.equal(await first.evaluate(() => document.documentElement.dataset.foxwarmTheme), 'foxwarm.default')
    await clickReadyControl(first, '[data-theme-color-mode="dark"]')
    await second.bringToFront()
    await second.waitForFunction(() => document.documentElement.dataset.foxwarmThemeMode === 'dark')
  } finally { await first.close(); await second?.close() }
})


test('playful runtime and short right-side queue work in App and Appearance', async () => {
  const page = await openFixture({ responsiveChat: true, chatMessages: idleViewportMessages.slice(0, 35), timelineView: 'detailed', hash: '#tab/chat:e2e-a', themeId: 'foxwarm.default', colorMode: 'dark', width: 1400 })
  const publish = () => page.evaluate(() => {
    const session = { id: 'e2e-a', busy: true, queueLength: 3, messageCount: 35, historyVersion: 1,
      runtimeState: { state: 'requesting-model', busy: true, queueLength: 3 } }
    window.__historySessionState = session
    window.__emitRealtime({ type: 'session-state', sessionId: 'e2e-a', session })
  })
  try {
    await page.waitForSelector('.foxwarm-chat-composer-textarea')
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.down('Control')
    await page.keyboard.press('A')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await publish()
    await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('3 queued'))
    assert.equal(await page.$eval('[data-fox-thinking-copy] .sr-only', el => el.textContent), 'Requesting model…')
    await page.locator('[data-processing-queue-status] button').click()
    await page.waitForFunction(() => window.__sent.length === 1)
    await page.locator('button[aria-label="Stop session"]').click()
    await page.waitForFunction(() => window.__sent.length === 2)
    assert.deepEqual(await page.evaluate(() => window.__sent.map(item => JSON.parse(item.body).text)), ['/dequeue', '/stop'])
    await publish()
    const bottom = await page.$('[aria-label="Scroll to bottom"]')
    if (bottom) await bottom.click()
    await page.waitForFunction(() => {
      const status = document.querySelector('.fw-processing-main')?.getBoundingClientRect()
      const scroll = document.querySelector('.foxwarm-chat-messages')?.getBoundingClientRect()
      const form = document.querySelector('.foxwarm-chat-composer-form')?.getBoundingClientRect()
      return status && scroll && form && status.top >= scroll.top && status.bottom <= form.top
    })
    assert.ok(await page.$eval('[data-processing-queue-status]', el => el.getBoundingClientRect().left > document.querySelector('.fw-processing-main').getBoundingClientRect().right))
    if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/app-status-wide.png` })
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector('.foxwarm-desktop-workbench-shell', { hidden: true })
    await page.waitForSelector('.foxwarm-chat-composer-textarea')
    await publish()
    await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('3 queued'))
    assert.ok(await page.$$eval('[data-processing-status-slot] button', buttons => buttons.every(button => {
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth
    })))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/app-status-narrow.png` })
  } finally { await page.close() }
  const setup = { id: 'system:setup', type: 'setup', title: 'Setup' }
  const appearance = await openFixture({ tabs: [setup], activeTabId: setup.id, hash: '#setup', themeId: 'foxwarm.default', colorMode: 'dark' })
  try {
    await appearance.waitForSelector('[data-fox-thinking-copy]')
    assert.deepEqual(await appearance.$eval('[data-fox-thinking-copy]', copy => ({
      label: copy.querySelector('.sr-only').textContent,
      font: getComputedStyle(copy).fontSize,
      fox: copy.parentElement.querySelector('svg')?.getBoundingClientRect().width,
    })), { label: 'Thinking...', font: '18px', fox: 24 })
    assert.equal(await appearance.evaluate(() => !!window.foxwarmBoot && !document.querySelector('[data-fox-splash]')), true)
    if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await appearance.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/appearance-playful-status.png` })
  } finally { await appearance.close() }
})

test('mobile home is a flat session-first layout and mobile Chats omit desktop tabs without deleting them', async () => {
  const page = await openFixture({width: 390, height: 844, themeId: 'foxwarm.foxwarm', tabs: [system, chat('e2e-a', false), chat('e2e-b', false)]})
  try {
    await page.waitForSelector('[data-mobile-session-home]')
    await page.waitForSelector('button[aria-label="Session display options"]')
    assert.deepEqual(await page.$$eval('[data-sidebar-footer] button', buttons => buttons.map(button => button.textContent.trim())), ['Sessions', 'Tasks', 'Search', 'Settings'])
    assert.equal(await page.$('[data-mobile-session-home] button[title="Create terminal tab"]'), null)
    assert.equal(await page.$('[data-mobile-session-home] button[title="Open code"]'), null)
    assert.equal(await page.$('.session-pin'), null)
    const primaryWorkspace = Object.keys((await state(page)).tabsById).sort()
    for (const tab of ['tasks', 'search', 'setup', 'sessions']) {
      await page.click(`#mobile-tab-${tab}`)
      await page.waitForFunction(tab => document.getElementById(`mobile-tab-${tab}`)?.getAttribute('aria-selected') === 'true' && document.getElementById(`mobile-panel-${tab}`)?.getBoundingClientRect().height > 0, {}, tab)
      assert.ok(await page.$('[data-mobile-session-home] [data-sidebar-footer]'))
      assert.deepEqual(Object.keys((await state(page)).tabsById).sort(), primaryWorkspace, 'mobile primary tabs do not create desktop workbench pages')
      assert.ok(await page.$eval('.mobile-primary-nav', el => { const c=getComputedStyle(el),r=el.getBoundingClientRect(); return parseFloat(c.borderRadius)>=20 && c.backdropFilter==='blur(5px)' && c.backgroundColor.includes('/ 0.75)') && r.left>=12 && r.right<=innerWidth-12 && r.bottom<=innerHeight-12 }), `floating frosted navigation on ${tab}`)
      await workbenchScreenshot(page, `mobile-primary-${tab}.png`)

    }
    const spacing = await page.$eval('[data-session-id="e2e-a"]', row => {
      const title = row.querySelector('span[title]'), bounds = row.getBoundingClientRect()
      return {inset: title.getBoundingClientRect().left - bounds.left, disclosure: !!row.querySelector('.session-compact-disclosure'), height: bounds.height}
    })
    assert.ok(spacing.inset >= 10 && spacing.inset <= 14 && !spacing.disclosure && spacing.height >= 56, JSON.stringify(spacing))
    await workbenchScreenshot(page, 'mobile-session-home.png')
    await page.click('button[aria-label="Workspace tools"]')
    await page.waitForSelector('[role="menu"]')
    await page.click('[role="menu"] button::-p-text(Code)')
    await page.waitForSelector('dialog[open]')
    assert.equal(await page.$eval('dialog', node => node.querySelector('#mobile-tool-title').textContent), 'Code')
    assert.ok(await page.$('dialog select'))
    await workbenchScreenshot(page, 'mobile-code-tools.png')
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog', {hidden: true})
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Workspace tools')
    await page.click('button[aria-label="New session"]')
    await page.waitForSelector('[role="dialog"][aria-labelledby="creation-dialog-title"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"][aria-labelledby="creation-dialog-title"]', {hidden: true})
    const before = Object.keys((await state(page)).tabsById).sort()
    await page.click('[data-session-id="e2e-a"]')
    await page.waitForSelector('.foxwarm-chat-root')
    const header = '.foxwarm-chat-root > div:first-of-type'
    assert.equal(await page.$('.foxwarm-chat-root button[aria-label="Find in chat"]'), null)
    assert.equal(await page.$('.foxwarm-chat-root button[title="Code"]'), null)
    assert.equal(await page.$('.foxwarm-chat-root button[title="Terminal"]'), null)
    assert.equal(await page.$eval('.foxwarm-chat-root [data-session-header-subtitle]', node => !!node).catch(() => false), false)
    await page.click('.foxwarm-chat-root button[aria-label="Open session options"]')
    await page.waitForSelector('[data-session-ui-settings-menu]')
    assert.equal(await page.$$eval('[data-session-ui-settings-menu] button', buttons => buttons.some(button => button.textContent.includes('Show usage badges'))), false)
    await page.click('[data-session-ui-settings-menu] button::-p-text(Find in chat)')
    await page.waitForSelector('[data-chat-search] input')
    await page.click('button[aria-label="Close search"]')
    assert.ok(await page.$(header))
    assert.equal(await page.$('[data-tab-id]'), null)
    assert.equal(await page.$('[role="tablist"][aria-label="Pane tabs"]'), null)
    assert.equal(await page.$('[data-workbench-tab-close]'), null)
    assert.deepEqual(Object.keys((await state(page)).tabsById).sort(), before)
    await workbenchScreenshot(page, 'mobile-chat-without-tabs.png')
    await page.click('.foxwarm-chat-root button[title="Back"]')
    await page.waitForSelector('[data-mobile-session-home]')
    await page.setViewport({width: 1400, height: 900})
    await page.waitForSelector('[data-tab-id="chat:e2e-a"]')
    assert.equal(await page.$('[data-mobile-session-home]'), null)
    assert.deepEqual(Object.keys((await state(page)).tabsById).sort(), before)
  } finally { await page.close() }
})


test('mobile suppresses per-round and reasoning token statistics without changing desktop usage preference', async () => {
  const messages = [
    {role:'user',parts:[{text:'A small fixture request'}],__meta:{seq:1,timestamp:1700000000000}},
    {role:'model',parts:[{thinking:'A short fixture analysis.'},{text:'A complete fixture answer.'}],__meta:{seq:2,timestamp:1700000001000,usage:{cachedTokens:120,inputTokens:40,outputTokens:20,reasoningTokens:10}}},
  ]
  const page = await openFixture({responsiveChat:true,chatMessages:messages,hash:'#tab/chat:e2e-a',tabs:[chat('e2e-a',false)]})
  try {
    await page.waitForSelector('[data-usage-badge-anchor]')
    const preference = await page.evaluate(() => localStorage.getItem('foxwarm_show_usage_badge_v1'))
    await page.setViewport({width:390,height:844})
    await page.waitForSelector('[data-usage-badge-anchor]', {hidden:true})
    assert.equal(await page.$('[data-reasoning-token-badge]'), null)
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_show_usage_badge_v1')), preference)
    await page.waitForFunction(()=>document.querySelector('.foxwarm-assistant-message-card')&&!document.querySelector('.foxwarm-assistant-action-buttons'))
    await page.setViewport({width:1400,height:900})
    await page.waitForSelector('.foxwarm-assistant-action-buttons')
    await page.waitForSelector('[data-usage-badge-anchor]')
  } finally {await page.close()}
})

test('mobile navigation is capped on tablet widths and mobile Conversation preferences stay independent', async () => {
  const page = await openFixture({width:390,height:844,chatMessages:[{role:'model',parts:[{text:'A visible answer.'}],__meta:{seq:1,timestamp:1}}],timelineView:'grouped'})
  const options = async () => {
    await waitForWebUiReady(page)
    if (await page.$eval('[data-mobile-session-home]', el => !!el.getClientRects().length).catch(() => false)) await clickReadyControl(page, '[data-session-id="e2e-a"]')
    await page.waitForSelector('.foxwarm-chat-root button[aria-label="Open session options"]', {visible:true})
    if (!await page.$('[data-session-ui-settings-menu]')) await clickReadyControl(page, '.foxwarm-chat-root button[aria-label="Open session options"]')
    await page.waitForSelector('[data-session-ui-settings-menu]')
  }
  try {
    await page.waitForSelector('.mobile-primary-nav')
    await page.setViewport({width:740,height:900})
    await page.waitForFunction(()=>Math.abs(document.querySelector('.mobile-primary-nav')?.getBoundingClientRect().width-440)<1)
    assert.ok(await page.$eval('.mobile-primary-nav',el=>{const r=el.getBoundingClientRect();return Math.abs(r.left-(innerWidth-r.width)/2)<1}))
    await workbenchScreenshot(page,'mobile-nav-tablet.png')
    await page.setViewport({width:390,height:844})
    await options()
    await page.waitForFunction(()=>document.querySelector('[role="radiogroup"][aria-label="Timeline view"] [aria-checked="true"]')?.textContent==='Conversation')
    await page.click('[role="radio"]::-p-text(Detailed)')
    assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('foxwarm_mobile_timeline_view_v1'),localStorage.getItem('foxwarm_timeline_view_v1')]),['detailed','grouped'])
    await page.keyboard.press('Escape')
    const header=await page.$eval('[data-mobile-chat-header]',el=>{const css=getComputedStyle(el),back=el.querySelector('.mobile-header-back'),capsule=el.querySelector('.mobile-header-capsule');return {position:css.position,background:css.backgroundColor,image:css.backgroundImage,border:css.borderTopWidth,backRadius:getComputedStyle(back).borderRadius,capsuleRadius:getComputedStyle(capsule).borderRadius,blur:getComputedStyle(capsule).backdropFilter}})
    assert.deepEqual(header,{position:'absolute',background:'rgba(0, 0, 0, 0)',image:'none',border:'0px',backRadius:'50%',capsuleRadius:'28px',blur:'blur(5px)'})
    await page.reload({waitUntil:'load'});await options()
    await page.waitForFunction(()=>document.querySelector('[role="radio"][aria-checked="true"]')?.textContent==='Detailed')
    await page.keyboard.press('Escape')
    await page.setViewport({width:1400,height:900})
    await page.waitForSelector('[data-tab-id="chat:e2e-a"]')
    await options()
    await page.waitForFunction(()=>document.querySelector('[role="radio"][aria-checked="true"]')?.textContent==='Grouped')
    assert.equal(await page.$('[data-mobile-chat-header]'),null)
    assert.equal(await page.evaluate(()=>localStorage.getItem('foxwarm_mobile_timeline_view_v1')),'detailed')
  } finally {await page.close()}
})

test('compact theme swatches retain direct selection and independent preview on desktop and mobile', async () => {
  const setup = {id:'system:setup',type:'setup',title:'Setup'}
  for (const width of [1400,390]) {
    const page=await openFixture(width<768 ? {width,height:900} : {tabs:[setup],activeTabId:setup.id,hash:'#setup',width,height:900})
    try {
      if(width<768){await clickReadyControl(page,'#mobile-tab-setup')}
      await page.waitForSelector('[data-theme-manager]',{visible:true})
      const geometry=await page.$eval('[data-theme-manager]',root=>{
        const grid=root.querySelector('.theme-card-grid'),card=grid.querySelector('.theme-option-card'),preview=card.querySelector('.theme-card-preview'),rect=card.getBoundingClientRect()
        return {height:rect.height,width:rect.width,previewHeight:preview.getBoundingClientRect().height,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,overflow:root.scrollWidth>root.clientWidth}
      })
      assert.ok(geometry.height<=135&&geometry.previewHeight<90&&!geometry.overflow,JSON.stringify({width,geometry}))
      if(width<768)assert.equal(geometry.columns,2)
      await workbenchScreenshot(page,`compact-theme-gallery-${width}.png`)
      const selection=await page.evaluate(()=>localStorage.getItem('foxwarm_theme_selection_v3'))
      await clickReadyControl(page,'[data-theme-preview="foxwarm.vector"]')
      await page.waitForSelector('[data-theme-preview-dialog]')
      assert.equal(await page.evaluate(()=>localStorage.getItem('foxwarm_theme_selection_v3')),selection,'preview does not apply a theme')
      await page.keyboard.press('Escape')
      await clickReadyControl(page,'[data-theme-option="foxwarm.vector"]')
      assert.equal(await page.$eval('[data-theme-option="foxwarm.vector"]',el=>el.getAttribute('aria-pressed')),'true')
    }finally{await page.close()}
  }
})

test('Sidebar navigation stages one bounded history read and swaps directly to populated content without an empty target frame', async () => {
  const page=await openFixture({responsiveChat:true,chatMessages:[{role:'model',parts:[{text:'Source A content'}],__meta:{seq:1}}],timelineView:'conversation'})
  try {
    await page.waitForFunction(()=>document.querySelector('[data-workbench-content-tab="chat:e2e-a"]')?.textContent.includes('Source A content'))
    await page.evaluate(()=>{
      const original=window.fetch
      window.navigationFrames=[];window.preparedReads=0;window.traceNavigation=true
      const trace=()=>{if(!window.traceNavigation)return;const host=document.querySelector('[data-workbench-content-tab="chat:e2e-b"]');window.navigationFrames.push({target:!!host,body:!!host?.textContent.includes('Target B content')});requestAnimationFrame(trace)};requestAnimationFrame(trace)
      window.fetch=(input,options={})=>{
        const url=String(input)
        if(url.includes('/sessions/e2e-b/history/continuous'))return Promise.resolve(new Response(JSON.stringify({messages:[{role:'model',parts:[{text:'Target B content'}],__meta:{seq:1}}],firstSeq:1,lastSeq:1,hasMore:false}),{status:200,headers:{'Content-Type':'application/json'}}))
        if(url.includes('/sessions/e2e-b/history')){window.preparedReads++;return new Promise(resolve=>{window.releasePrepared=()=>resolve(new Response(JSON.stringify({session:{id:'e2e-b',messageCount:1,historyVersion:1,busy:false,runtimeState:{state:'idle',busy:false,queueLength:0}},messages:[{role:'model',parts:[{text:'Target B content'}],__meta:{seq:1}}],historyVersion:1,historyComplete:true,latestSeq:1,queueLength:0,queuedMessages:[]}),{status:200,headers:{'Content-Type':'application/json'}}))})}
        return original(input,options)
      }
    })
    await page.click('[data-session-id="e2e-b"]')
    await page.waitForSelector('[data-pane-navigation-pending="e2e-b"] [role="status"]')
    assert.equal((await state(page)).root.activeTabId,'chat:e2e-a')
    assert.match(await page.$eval('[data-workbench-content-tab="chat:e2e-a"]',el=>el.textContent),/Source A content/)
    assert.equal(await page.$eval('[data-workbench-content-tab="chat:e2e-a"] > div',el=>el.inert),true)
    await page.evaluate(()=>window.releasePrepared())
    await page.waitForFunction(()=>document.querySelector('[data-workbench-content-tab="chat:e2e-b"]')?.textContent.includes('Target B content'))
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{window.traceNavigation=false;resolve()}))))
    const evidence=await page.evaluate(()=>({frames:window.navigationFrames,reads:window.preparedReads}))
    assert.equal(evidence.reads,1)
    assert.ok(evidence.frames.some(frame=>frame.target&&frame.body))
    assert.equal(evidence.frames.some(frame=>frame.target&&!frame.body),false,JSON.stringify(evidence))
    assert.equal(await page.$('[data-pane-navigation-pending]'),null)
  }finally{await page.close()}
})

test('a later sidebar choice wins even when an abandoned history response ignores AbortSignal', async () => {
 const page=await openFixture({reducedMotion:true})
 try{
  await page.evaluate(()=>{const original=window.fetch;window.fetch=(input,options={})=>{
   const url=String(input)
   if(url.includes('/sessions/e2e-b/history'))return new Promise(resolve=>{window.releaseOldNavigation=()=>original(input,{}).then(resolve)})
   return original(input,options)
  }})
  await page.click('[data-session-id="e2e-b"]');await page.waitForFunction(()=>typeof window.releaseOldNavigation==='function')
  await page.click('[data-session-id="e2e-c"]');await page.waitForSelector('[data-tab-id="chat:e2e-c"]')
  await page.evaluate(()=>window.releaseOldNavigation());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  assert.equal((await state(page)).root.activeTabId,'chat:e2e-c')
  assert.equal(await page.$('[data-pane-navigation-pending]'),null)
  assert.equal(await page.$eval('[data-workbench-content-tab="chat:e2e-c"]',el=>el.getAnimations().length),0)
 }finally{await page.close()}
})

for (const liveDuringCatchup of [false, true]) test(`prepared continuous history catches up between the two prepared snapshots${liveDuringCatchup ? ' while merging live commits without draining newer pages' : ''}`, async () => {
  const page = await openFixture({ responsiveChat: true, chatMessages: [{ role: 'model', parts: [{ text: 'Source A content' }], __meta: { seq: 1 } }], timelineView: 'conversation' })
  try {
    await page.evaluate(liveDuringCatchup => {
      const original = window.fetch
      window.probeArchiveReads = []
      const first = { role: 'model', parts: [{ text: 'Earlier B message' }], __meta: { seq: 1, timestamp: 1700000000000 } }
      const second = { role: 'model', parts: [{ text: 'Newest B message' }], __meta: { seq: 2, timestamp: 1700000001000 } }
      window.probeBState = { id: 'e2e-b', messageCount: 2, historyVersion: 2, busy: false, runtimeState: { state: 'idle', busy: false, queueLength: 0 } }
      const json = data => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      window.fetch = (input, options = {}) => {
        const url = String(input)
        if (url.includes('/sessions/e2e-b/history/continuous')) {
          window.probeArchiveReads.push(url)
          if (window.probeArchiveReads.length === 1) return json({ messages: [first], firstSeq: 1, lastSeq: 1, hasMore: false })
          if (liveDuringCatchup) {
            window.__emitRealtime({ type: 'message', sessionId: 'e2e-b', message: second })
            window.__emitRealtime({ type: 'message', sessionId: 'e2e-b', message: { role: 'model', parts: [{ text: 'Live B message' }], __meta: { seq: 3, timestamp: 1700000002000 } } })
          }
          return json({ messages: [second], firstSeq: 2, lastSeq: 2, hasMore: liveDuringCatchup })
        }
        if (url.includes('/sessions/e2e-b/history')) return json({ session: window.probeBState, messages: [first, second], historyVersion: 2, historyComplete: true, latestSeq: 2, queueLength: 0, queuedMessages: [] })
        return original(input, options)
      }
    }, liveDuringCatchup)
    await page.click('[data-session-id="e2e-b"]')
    await page.waitForSelector('[data-workbench-content-tab="chat:e2e-b"]')
    await page.evaluate(() => window.__emitRealtime({ type: 'session-state', session: window.probeBState }))
    await page.waitForFunction(() => document.querySelector('[data-workbench-content-tab="chat:e2e-b"]')?.textContent.includes('Newest B message'), { timeout: 3000 })
    const result = await page.evaluate(() => ({ archiveReads: window.probeArchiveReads, body: document.querySelector('[data-workbench-content-tab="chat:e2e-b"]').textContent }))
    assert.equal(result.archiveReads.length, 2)
    assert.match(result.archiveReads[1], /afterSeq=1/)
    assert.match(result.body, /Earlier B message/)
    assert.match(result.body, /Newest B message/)
    assert.equal(result.body.match(/Newest B message/g).length, 1, 'page/live duplicates render once')
    if (liveDuringCatchup) assert.match(result.body, /Live B message/)
  } finally {
    await page.close()
  }
})

test('Session switching request budget follows one focus transition without reloading an unchanged exact set', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a', false), chat('e2e-b', false), chat('e2e-c', false)], responsiveChat: true, chatMessages: [{ role: 'model', parts: [{ text: 'Switch fixture' }], __meta: { seq: 1 } }] })
  try {
    await page.waitForFunction(() => window.__fetches.filter(request => request.path.endsWith('/session-list/architecture')).length >= 2)
    await new Promise(resolve => setTimeout(resolve, 100))
    await page.evaluate(() => { window.__fetches = [] })
    await page.click('[data-session-id="e2e-b"]')
    await page.waitForFunction(() => decodeURIComponent(location.hash).includes('chat:e2e-b'))
    await new Promise(resolve => setTimeout(resolve, 500))
    await page.click('[data-session-id="e2e-a"]')
    await page.waitForFunction(() => decodeURIComponent(location.hash).includes('chat:e2e-a'))
    await new Promise(resolve => setTimeout(resolve, 500))
    const requests = await page.evaluate(() => window.__fetches.filter(request => request.path.includes('/session-list/')))
    const sidebar = requests.filter(request => request.path.endsWith('/sidebar'))
    console.log('switch-request-budget', JSON.stringify({
      counts: Object.fromEntries(['sidebar', 'by-id', 'children', 'descendant-activity', 'architecture']
        .map(endpoint => [endpoint, requests.filter(request => request.path.endsWith('/' + endpoint)).length])),
      focusIds: sidebar.map(request => new URLSearchParams(request.search).getAll('focusSessionId')),
      exactSets: requests.filter(request => request.path.endsWith('/by-id')).map(request => JSON.parse(request.body).ids),
    }))
    assert.deepEqual(sidebar.map(request => new URLSearchParams(request.search).getAll('focusSessionId')), [['e2e-b'], ['e2e-a']], 'one real focus query per selection, without bouncing to the previous route')
    assert.equal(requests.filter(request => request.path.endsWith('/by-id')).length, 0, 'focus reordering does not refetch the unchanged open/watch ID set')
    assert.equal(requests.filter(request => request.path.endsWith('/architecture')).length, 0, 'focus is not a global-summary invalidation')
    assert.equal(requests.filter(request => request.path.endsWith('/descendant-activity')).length, 2, 'each accepted structural replay retains its complete descendant projection')

    await page.evaluate(() => {
      window.__fetches = []
      window.__emitRealtime({ type: 'session-list-delta', sessions: [{ id: 'e2e-b', displayName: 'Renamed live B', aliases: [], parentSessionId: null, runtimeState: { state: 'running-tool', toolName: 'fixture' }, messageCount: 9, sequenceMessageCount: 12 }], deletedIds: [] })
    })
    await page.waitForFunction(() => document.querySelector('[data-session-id="e2e-b"]')?.textContent.includes('Renamed live B') && document.querySelector('[data-tab-id="chat:e2e-b"]')?.textContent.includes('Renamed live B'))
    assert.ok(await page.$('[data-session-id="e2e-b"] .runtime-busy-spinner'), 'the watched row retains live runtime status')
    assert.equal(await page.evaluate(() => window.__fetches.filter(request => request.path.includes('/session-list/')).length), 0, 'row and tab metadata still update directly through the exact subscription')
    await page.evaluate(() => {
      const original = window.fetch
      window.fetch = async (input, options) => {
        const response = await original(input, options)
        if (!String(input).includes('/session-list/architecture')) return response
        return new Response(JSON.stringify({ summary: { total: 3, busy: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      window.__emitRealtime({ type: 'session-list-invalidated', eventId: 'fixture-1', presentationRevision: 'r2' })
      window.__emitRealtime({ type: 'session-list-invalidated', eventId: 'fixture-1', presentationRevision: 'r2' })
    })
    await page.waitForSelector('[data-workbench-status-bar] [aria-label="Running sessions: 1"]')
    const invalidated = await page.evaluate(() => window.__fetches.filter(request => request.path.includes('/session-list/')))
    assert.equal(invalidated.filter(request => request.path.endsWith('/sidebar')).length, 1, 'duplicate live invalidations keep one scheduled refresh')
    assert.equal(invalidated.filter(request => request.path.endsWith('/by-id')).length, 1, 'an actual invalidation still refreshes exact rows')
    assert.equal(invalidated.filter(request => request.path.endsWith('/architecture')).length, 1, 'an actual invalidation still refreshes counters')
    assert.deepEqual(JSON.parse(invalidated.find(request => request.path.endsWith('/by-id')).body), { ids: ['e2e-a', 'e2e-b', 'e2e-c'], includePaths: false })
  } finally { await page.close() }
})

test('rapid Session preview switches retain the latest focus and exact generation when older list responses finish last', async () => {
  const page = await openFixture({ tabs: [chat('e2e-a')], responsiveChat: true })
  try {
    await page.waitForFunction(() => window.__fetches.filter(request => request.path.endsWith('/session-list/architecture')).length >= 2)
    await page.evaluate(() => {
      const original = window.fetch
      window.__fetches = []
      window.__releaseOldList = []
      window.fetch = async (input, options = {}) => {
        const url = new URL(String(input), location.href)
        const response = await original(input, options)
        const oldRoot = url.pathname.endsWith('/session-list/sidebar') && url.searchParams.get('focusSessionId') === 'e2e-b'
        const oldExact = url.pathname.endsWith('/session-list/by-id') && JSON.parse(options.body).ids.includes('e2e-b')
        if (!oldRoot && !oldExact) return response
        const session = id => ({ id, aliases: [], displayName: 'Stale response', archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, busy: false })
        const payload = oldRoot
          ? { version: 1, revision: 'r1', sessions: [session('stale-root'), session('e2e-c')], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} }
          : { results: [{ requestedId: 'e2e-b', session: session('e2e-b') }] }
        await new Promise(resolve => window.__releaseOldList.push(resolve))
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
    })
    await page.click('[data-session-id="e2e-b"]')
    await page.waitForFunction(() => window.__releaseOldList.length === 2)
    await page.click('[data-session-id="e2e-c"]')
    await page.waitForFunction(() => decodeURIComponent(location.hash).includes('chat:e2e-c') && !!document.querySelector('[data-workbench-content-tab="chat:e2e-c"]'))
    await page.evaluate(() => { for (const release of window.__releaseOldList) release() })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await state(page)).root.activeTabId, 'chat:e2e-c')
    assert.equal(await page.$('[data-session-id="stale-root"]'), null, 'an older focus window cannot replace the current forest')
    assert.equal(await page.$eval('[data-session-list-scroll-container]', element => element.textContent.includes('Stale response')), false, 'older root and exact rows cannot overwrite current metadata')
    const requests = await page.evaluate(() => window.__fetches.filter(request => request.path.includes('/session-list/')))
    assert.deepEqual(requests.filter(request => request.path.endsWith('/sidebar')).map(request => new URLSearchParams(request.search).getAll('focusSessionId')), [['e2e-b'], ['e2e-c']])
    assert.deepEqual(requests.filter(request => request.path.endsWith('/by-id')).map(request => JSON.parse(request.body).ids), [['e2e-b'], ['e2e-c']], 'each genuinely changed preview exact set loads once')
    assert.equal(requests.filter(request => request.path.endsWith('/architecture')).length, 0)
  } finally { await page.close() }
})

test('fresh browsers keep an empty workbench rather than opening implicit main; explicit selection restores normally',async()=>{
 const page=await openFixture({freshBrowser:true,tabs:[],activeTabId:null,responsiveChat:true})
 try{
  await page.waitForFunction(()=>document.body.innerText.includes('e2e-a'))
  assert.equal(await page.evaluate(()=>location.hash),'')
  assert.equal(await page.evaluate(()=>window.__fetches.some(r=>r.path.includes('/sessions/main/'))),false)
  assert.equal(await page.$('[data-chat-session-id="main"]'),null)
  assert.equal(await page.evaluate(()=>document.body.innerText.includes('Session not found')),false)
  await page.evaluate(()=>window.foxwarmTest.switchToSession('e2e-a'))
  await page.waitForFunction(()=>decodeURIComponent(location.hash).includes('chat:e2e-a'))
  await page.reload();await waitForWebUiReady(page)
  assert.equal(await page.evaluate(()=>decodeURIComponent(location.hash)),'#tab/chat:e2e-a')
  assert.equal(await page.evaluate(()=>window.__fetches.some(r=>r.path.includes('/sessions/main/'))),false)
 }finally{await page.close()}
})
