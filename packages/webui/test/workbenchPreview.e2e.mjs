import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const dist = new URL('../dist/', import.meta.url)
const browserPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
let browser
let server
let baseUrl

const chat = (id, preview = true) => ({ id: `chat:${id}`, type: 'chat', sessionId: id, title: id, preview })
const system = { id: 'system:agents', type: 'agents', title: 'Agents' }

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
  browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  server = createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
})
after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function openFixture({ tabs = [system, chat('e2e-a')], activeTabId = 'chat:e2e-a', hash = '', split = false } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  await page.evaluateOnNewDocument(({ initialTabs, activeId, splitPanes }) => {
    const tabsById = Object.fromEntries(initialTabs.map(tab => [tab.id, tab]))
    const root = splitPanes
      ? { id: 'split-main', kind: 'split', direction: 'row', sizes: [50, 50], children: [
        { id: 'pane-main', kind: 'pane', tabIds: initialTabs.filter(tab => tab.id !== 'system:agents').map(tab => tab.id), activeTabId: activeId },
        { id: 'pane-other', kind: 'pane', tabIds: ['system:agents'], activeTabId: 'system:agents' },
      ] }
      : { id: 'pane-main', kind: 'pane', tabIds: initialTabs.map(tab => tab.id), activeTabId: activeId }
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({ state: { version: 4, tabsById, root, focusedPaneId: 'pane-main' }, version: 1 }))
    localStorage.setItem('foxwarm_last_active_tab_v1', activeId)
    const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    window.__sent = []
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const pathname = url.pathname
      if (pathname.endsWith('/api/setup/status')) return json({ oobe: false })
      if (pathname.endsWith('/api/terminals')) return json({ terminals: [] })
      if (pathname.endsWith('/api/nodes')) return json({ nodes: [] })
      if (pathname.endsWith('/api/agents')) return json({ agents: [] })
      if (pathname.endsWith('/api/webui/settings')) return json({ settings: {} })
      if (pathname.endsWith('/api/models')) return json({ models: [] })
      if (pathname.endsWith('/api/commands')) return json({ commands: [] })
      if (pathname.endsWith('/api/session-list/sidebar')) return json({ version: 1, revision: 'r1', sessions: [sessionFixture('e2e-a'), sessionFixture('e2e-b'), sessionFixture('e2e-c')], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} })
      if (pathname.endsWith('/api/session-list/by-id')) return json({ results: [] })
      if (pathname.endsWith('/api/session-list/descendant-activity')) return json({ results: [] })
      if (pathname.includes('/api/session-list/')) return json({ sessions: [], results: [] })
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/message')) {
        window.__sent.push({ path: pathname, body: options.body })
        return json({ ok: true })
      }
      if (pathname.includes('/api/sessions/') && pathname.endsWith('/history')) return json({ messages: [], queuedMessages: [], session: { id: decodeURIComponent(pathname.split('/').at(-2)), messageCount: 0, historyVersion: 1 }, latestSeq: 0, historyVersion: 1 })
      return json({})
    }
    function sessionFixture(id) { return { id, aliases: [], archived: false, parentSessionId: null, childTotal: 0, messageCount: 0, lastMessageTime: 1, busy: false } }
    class FixtureWebSocket {
      static OPEN = 1
      readyState = 1
      onopen = null; onmessage = null; onclose = null; onerror = null
      constructor() { queueMicrotask(() => this.onopen?.({})) }
      send() {}
      close() { this.readyState = 3; this.onclose?.({}) }
    }
    window.WebSocket = FixtureWebSocket
  }, { initialTabs: tabs, activeId: activeTabId, splitPanes: split })
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
    await otherPage.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    await drag(otherPage, '[data-tab-id="chat:e2e-a"]', '[data-pane-id="pane-other"] [data-tab-id="system:agents"]')
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
    await dockPage.waitForSelector('[data-tab-id="chat:e2e-a"][title$="(preview)"]')
    const source = await (await dockPage.$('[data-tab-id="chat:e2e-a"]')).boundingBox()
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
    assert.ok(await dockPage.$('[data-tab-id="chat:e2e-a"]'))
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
    await page.click('[data-tab-id="chat:e2e-b"] button[title="Close tab"]')
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem('foxwarm_workbench_state_v4')).state
      return state.root.tabIds.length === 1 && state.root.activeTabId === 'chat:e2e-a'
        && !document.querySelector('[data-tab-id]')
        && !!document.querySelector('[data-pane-id="pane-main"] [role="textbox"][aria-label="Message"]')
    })
    assert.equal(await page.$(paneButtons), null)
  } finally { await page.close() }
})

test('multi-pane single-tab strips remain visible while pane controls follow each tab count', async () => {
  const page = await openFixture({ split: true })
  try {
    await page.waitForSelector('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-a"]')
    await page.waitForSelector('[data-pane-id="pane-other"] [data-tab-id="system:agents"]')
    assert.equal(await page.$(paneButtons), null)
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-b'))
    await page.waitForSelector('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-b"]')
    assert.equal(await page.$(paneButtons), null, 'replacing the preview keeps one tab in the pane')
    await page.click('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-b"]', { clickCount: 2 })
    await page.evaluate(() => window.foxwarmTest.switchToSession('e2e-c'))
    await page.waitForSelector('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-c"]')
    assert.equal(await page.$$eval('[data-pane-id="pane-main"] [data-tab-id]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval('[data-pane-id="pane-main"] button[title="Split right with active tab"], [data-pane-id="pane-main"] button[title="Split down with active tab"], [data-pane-id="pane-main"] button[title="Close pane"]', nodes => nodes.length), 3)
    assert.equal(await page.$('[data-pane-id="pane-other"] ' + paneButtons.split(', ').join(', [data-pane-id="pane-other"] ')), null)
    await page.click('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-c"] button[title="Close tab"]')
    await page.waitForFunction(() => !document.querySelector('[data-tab-id="chat:e2e-c"]'))
    assert.ok(await page.$('[data-pane-id="pane-main"] [data-tab-id="chat:e2e-b"]'))
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
