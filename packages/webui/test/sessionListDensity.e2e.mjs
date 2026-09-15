import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

let server, browser, url
const toggle = 'button[aria-label="Compact session rows"]'
const row = id => `[data-session-id="demo/${id}"]`
before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: { loader: 'tsx', resolveDir: root, sourcefile: 'density-fixture.tsx', contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { DndContext, PointerSensor, useSensors, useSensor, pointerWithin } from '@dnd-kit/core'
      import Core from './src/components/SessionListCore'
      import { initializeThemeRuntime, setThemeSelection } from './src/theme'
      initializeThemeRuntime()
      window.fixtureTheme = setThemeSelection
      window.fixtureDrops = []
      window.fixturePinRequests = []
      window.fetch = async (url, options) => {
        if (String(url).endsWith('/pin')) {
          const id = decodeURIComponent(String(url).split('/').at(-2))
          const { pinned } = JSON.parse(options.body)
          window.fixturePinRequests.push({ id, pinned, method: options.method })
          window.fixtureSetPinned(id, pinned)
        }
        return new Response(JSON.stringify({ total: 1, busy: 0 }), { headers: { 'Content-Type': 'application/json' } })
      }
      const sessions = [
        { id: 'demo/main', displayName: 'Research workspace', childSessions: ['demo/child'], runtimeState: { state: 'requesting-model', active: { phase: 'compaction' } } },
        { id: 'demo/child', displayName: 'Evaluate the compact navigation', parentSessionId: 'demo/main', runtimeState: { state: 'running-tool', tool: { name: 'exec' } } },
        { id: 'demo/wait', displayName: 'Waiting for review', runtimeState: { state: 'waiting', waiting: { waitingFor: 'input' } } },
        { id: 'demo/idle', displayName: 'Completed experiment with a deliberately long descriptive title', runtimeState: { state: 'idle' }, busy: true },
        { id: 'demo/legacy', displayName: 'Legacy running session', busy: true, archived: true },
        { id: 'demo/archive', displayName: 'Archived notes', archived: true },
      ].map((s, i) => ({ parentSessionId: null, messageCount: 12, lastMessageTime: 100-i, ...s }))
      function Fixture() {
        const [current, setCurrent] = useState(location.search === '?descendants' ? 'demo/wait' : 'demo/child')
        const [fixtureSessions, setFixtureSessions] = useState(sessions)
        const [descendantBusy, setDescendantBusy] = useState(new Map())
        window.fixtureSetDescendantBusy = entries => setDescendantBusy(new Map(entries))
        window.fixtureSetSessions = setFixtureSessions
        const noop = () => {}
        const bounded = location.search === '?descendants' ? {
          serverOrdered: true, hasMoreRoots: false,
          childPages: new Map(fixtureSessions.map(s => [s.id, { ids: fixtureSessions.filter(c => c.parentSessionId === s.id).map(c => c.id), total: fixtureSessions.filter(c => c.parentSessionId === s.id).length, nextCursor: null }])),
          branchLoadStates: new Map(), descendantBusy, invalidationVersion: 0,
          onModeChange: noop, onFilterChange: noop, onLoadMoreRoots: noop, onLoadMoreChildren: noop,
          onExpandBranch: noop, onExpandBranches: noop, onRetryBranch: noop, onCollapseBranch: noop,
        } : undefined
        window.fixtureSetPinned = (id, pinned) => setFixtureSessions(previous => previous.map(s => s.id === id ? { ...s, pinned } : s))
        const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
        return <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={event => window.fixtureDrops.push(event.over?.data.current)}>
          <div style={{ width: 'min(340px, 100vw)', height: '100vh' }} className="bg-fw-surface border-r border-fw-border">
            <div className="p-4 text-fw-text-strong font-bold border-b border-fw-border">Foxwarm · Demo sessions</div>
            <div style={{ height: 'calc(100% - 57px)' }}><Core bounded={bounded} sessions={fixtureSessions} currentSession={current} unreadSessionIds={new Set(['demo/idle', 'demo/wait'])} onSelectSession={id => { window.fixtureSelected = id; setCurrent(id) }} /></div>
          </div>
        </DndContext>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { 'react': 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  })
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })
async function open(mobile = false) {
  const page = await browser.newPage()
  await page.setViewport({ width: mobile ? 390 : 1000, height: 700, isMobile: mobile, hasTouch: mobile })
  await page.goto(url)
  await page.waitForSelector(toggle)
  await page.evaluate(() => { localStorage.removeItem('foxwarm_session_list_compact_v1'); localStorage.removeItem('foxwarm_session_list_view_mode_v1') })
  await page.reload()
  await page.waitForSelector(row('child'))
  return page
}

test('compact toggle, persistence, canonical status, theme parity, tree and context menu', async () => {
  const page = await open()
  try {
    assert.equal(await page.$eval(toggle, e => e.getAttribute('aria-pressed')), 'false')
    const normalHeight = await page.$eval(row('main'), e => e.getBoundingClientRect().height)
    await page.click(toggle)
    await page.waitForSelector('[data-session-list-density="compact"]')
    assert.equal(await page.$eval(row('main'), e => e.getBoundingClientRect().height), 40)
    assert.ok(40 < normalHeight)
    assert.deepEqual(await page.$$eval('[data-session-status]', els => els.map(e => [e.dataset.sessionStatus, e.getAttribute('aria-label')])), [
      ['requesting-model', 'Status: compacting'], ['running-tool', 'Status: tool: exec'], ['waiting', 'Status: waiting: input'], ['requesting-model', 'Status: thinking'],
    ])
    assert.ok(await page.$(`${row('idle')} [aria-label="Unread idle completion"]`))
    assert.equal(await page.$('[data-session-status="idle"]'), null)
    for (const id of ['idle', 'archive']) assert.equal(await page.$(`${row(id)} [data-session-status]`), null)
    assert.equal(await page.$$eval('[data-session-status]', els => els.every(e => {
      const previous = e.previousElementSibling
      return e === e.parentElement.lastElementChild
        && previous.getBoundingClientRect().right <= e.getBoundingClientRect().left
    })), true)
    assert.equal(await page.$eval(`${row('wait')} [data-session-status]`, e => e.previousElementSibling.previousElementSibling.getAttribute('aria-label')), 'Unread idle completion')
    assert.equal(await page.$eval(`${row('legacy')} [data-session-status]`, e => e.previousElementSibling.previousElementSibling.getAttribute('aria-label')), 'Archived session')
    const disclosure = `${row('main')} button[aria-expanded]`
    await page.mouse.move(800, 650)
    assert.equal(await page.$eval(disclosure, e => getComputedStyle(e).opacity), '0')
    const titleLeft = await page.$eval(`${row('main')} span[title]`, e => e.getBoundingClientRect().left)
    await page.hover(row('main'))
    assert.equal(await page.$eval(disclosure, e => getComputedStyle(e).opacity), '1')
    assert.equal(await page.$eval(`${row('main')} span[title]`, e => e.getBoundingClientRect().left), titleLeft)
    await page.mouse.move(800, 650)
    await page.focus(disclosure)
    assert.equal(await page.$eval(disclosure, e => getComputedStyle(e).opacity), '1')
    assert.equal(await page.$eval(`${row('main')} span[title]`, e => e.getBoundingClientRect().left), titleLeft)
    await page.focus(toggle)
    assert.equal(await page.$eval(disclosure, e => getComputedStyle(e).opacity), '0')
    await page.hover(row('main'))
    await page.click(`${row('main')} button[aria-expanded]`)
    assert.equal(await page.$(row('child')), null)
    await page.focus(`${row('main')} button[aria-expanded]`)
    await page.keyboard.press('Enter')
    await page.waitForSelector(row('child'))
    await page.click(row('wait'))
    assert.equal(await page.evaluate(() => window.fixtureSelected), 'demo/wait')
    await page.click(row('wait'), { button: 'right' })
    await page.waitForSelector('[role="menu"]')
    await page.keyboard.press('Escape')
    await page.reload()
    await page.waitForSelector('[data-session-list-density="compact"]')
    for (const themeId of ['foxwarm.default', 'foxwarm.550a-mono', 'foxwarm.seaglass']) {
      for (const colorMode of ['light', 'dark']) {
        await page.evaluate(({ themeId, colorMode }) => window.fixtureTheme({ themeId, colorMode }), { themeId, colorMode })
        const result = await page.$eval('[data-session-status="requesting-model"]', e => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor, animation: getComputedStyle(e).animationName }))
        assert.equal(result.color, result.background)
        assert.notEqual(result.animation, 'none')
        assert.equal(await page.$eval(row('idle'), e => e.scrollWidth <= e.clientWidth), true)
      }
    }
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    assert.equal(await page.$eval('[data-session-status]', e => getComputedStyle(e).animationName), 'none')
    await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.default', colorMode: 'light' }))
    const output = process.env.FOXWARM_E2E_SCREENSHOT_DIR
    if (output) {
      await mkdir(output, { recursive: true })
      await page.mouse.move(800, 650)
      await page.screenshot({ path: path.join(output, 'sidebar-compact-mock.png'), clip: { x: 0, y: 0, width: 340, height: 500 } })
      await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.550a-mono', colorMode: 'light' }))
      await page.screenshot({ path: path.join(output, 'sidebar-compact-mono-mock.png'), clip: { x: 0, y: 0, width: 340, height: 500 } })
      await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.default', colorMode: 'light' }))
    }
    await page.click(toggle)
    await page.waitForSelector('[data-session-list-density="normal"]')
    assert.equal(await page.$eval(row('main'), e => e.getBoundingClientRect().height), normalHeight)
    await page.mouse.move(800, 650)
    await page.focus(toggle)
    assert.equal(await page.$eval(`${row('main')} button[aria-expanded]`, e => getComputedStyle(e).opacity), '1')
  } finally { await page.close() }
})

test('compact drag keeps sibling, child, and root drop targets; touch remains scrollable', async () => {
  const page = await open()
  try {
    await page.click(toggle)
    for (const target of ['before', 'child', 'root']) {
      const source = await (await page.$(row('legacy'))).boundingBox()
      await page.mouse.move(source.x + 170, source.y + source.height / 2)
      await page.mouse.down()
      await page.mouse.move(source.x + 180, source.y + source.height / 2, { steps: 4 })
      await page.waitForFunction(() => [...document.querySelectorAll('span')].some(e => e.textContent === 'Drop here to detach to root'))
      const box = target === 'root'
        ? await page.evaluate(() => { const e = [...document.querySelectorAll('div')].find(e => e.textContent === 'Drop here to detach to root')?.parentElement?.parentElement; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
        : await (await page.$(row('wait'))).boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + (target === 'before' ? 2 : box.height / 2), { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => window.fixtureDrops.length > 0)
      const drop = await page.evaluate(() => window.fixtureDrops.pop())
      assert.equal(drop?.type, target === 'root' ? 'sidebar-root-drop' : `sidebar-session-${target}`)
    }
  } finally { await page.close() }
  const mobile = await open(true)
  try {
    await mobile.click(toggle)
    assert.equal(await mobile.evaluate(() => matchMedia('(pointer: coarse)').matches), true)
    assert.equal(await mobile.$eval(`${row('main')} .session-compact-pin`, e => getComputedStyle(e).opacity), '1')
    await mobile.tap(`${row('wait')} .session-compact-pin`)
    await mobile.waitForSelector(`${row('wait')} .session-compact-pin[aria-pressed="true"]`)
    assert.deepEqual(await mobile.evaluate(() => window.fixturePinRequests), [{ id: 'demo/wait', pinned: true, method: 'POST' }])
    assert.equal(await mobile.evaluate(() => window.fixtureSelected), undefined)
    assert.equal(await mobile.$eval(`${row('main')} button[aria-expanded]`, e => getComputedStyle(e).opacity), '1')
    await mobile.tap(`${row('main')} button[aria-expanded]`)
    assert.equal(await mobile.$(row('child')), null)
    await mobile.tap(`${row('main')} button[aria-expanded]`)
    await mobile.waitForSelector(row('child'))
    assert.equal(await mobile.$eval(row('wait'), e => e.getAttribute('role')), null)
    assert.ok(await mobile.$eval(row('wait'), e => e.getBoundingClientRect().height) >= 44)
    assert.equal(await mobile.$eval('[data-session-list-scroll-container]', e => getComputedStyle(e).touchAction), 'pan-y')
    await mobile.click(`${row('wait')} button[title="More options"]`)
    await mobile.waitForSelector('[role="menu"]')
  } finally { await mobile.close() }
})


test('density synchronizes browser tabs and stays independent of search and ordering', async () => {
  const page = await open()
  const other = await browser.newPage()
  try {
    await other.goto(url)
    await other.waitForSelector(toggle)
    await page.bringToFront()
    await page.click(toggle)
    await other.bringToFront()
    await other.waitForSelector('[data-session-list-density="compact"]')
    await page.bringToFront()
    await page.click('button[aria-label="Session list mode: Default"]')
    await page.waitForSelector('button[aria-label="Session list mode: Time"]')
    await page.click('button[aria-label="Session list mode: Time"]')
    await page.waitForSelector('button[aria-label="Session list mode: Flat"]')
    assert.ok(await page.$('[data-session-list-density="compact"]'))
    assert.equal(await page.$(`${row('main')} button[aria-expanded]`), null)
    await page.type('input[aria-label="Search sessions"]', 'Waiting for review')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1)
    await page.click('button[aria-label="Clear session search"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 6)
    await other.bringToFront()
    await other.click(toggle)
    await page.bringToFront()
    await page.waitForSelector('[data-session-list-density="normal"]')
    await page.waitForSelector('button[aria-label="Session list mode: Flat"]')
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_session_list_compact_v1')), 'false')
  } finally { await page.close(); await other.close() }
})


test('compact pin actions reserve a right-side slot and isolate navigation and dragging', async () => {
  const page = await open()
  const pin = `${row('wait')} .session-compact-pin`
  const title = `${row('wait')} span[title]`
  try {
    await page.click(toggle)
    await page.mouse.move(800, 650)
    const bounds = () => page.$eval(title, e => ({ x: e.getBoundingClientRect().x, width: e.getBoundingClientRect().width }))
    const initialBounds = await bounds()
    assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '0')
    assert.equal(await page.$eval(pin, e => e.previousElementSibling.hasAttribute('title') && e.previousElementSibling.tagName === 'SPAN'), true)
    await page.hover(row('wait'))
    assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
    assert.deepEqual(await bounds(), initialBounds)
    const box = await (await page.$(pin)).boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 })
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('span')].some(e => e.textContent === 'Drop here to detach to root')), false)
    await page.mouse.up()
    assert.deepEqual(await page.evaluate(() => window.fixtureDrops), [])
    await page.mouse.move(800, 650)
    await page.focus(pin)
    assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
    assert.deepEqual(await bounds(), initialBounds)
    await page.keyboard.press('Enter')
    await page.waitForSelector(`${pin}[aria-pressed="true"]`)
    await page.focus(toggle)
    assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
    assert.equal(await page.$eval(pin, e => e.getAttribute('aria-label')), 'Unpin from top')
    assert.deepEqual(await bounds(), initialBounds)
    assert.equal(await page.evaluate(() => window.fixtureSelected), undefined)
    await page.click(pin)
    await page.waitForSelector(`${pin}[aria-pressed="false"]`)
    assert.deepEqual(await page.evaluate(() => window.fixturePinRequests), [
      { id: 'demo/wait', pinned: true, method: 'POST' },
      { id: 'demo/wait', pinned: false, method: 'POST' },
    ])
    assert.equal(await page.evaluate(() => window.fixtureSelected), undefined)
    await page.focus(toggle)
    await page.mouse.move(800, 650)
    assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '0')
    await page.click(toggle)
    assert.equal(await page.$('.session-compact-pin'), null)
  } finally { await page.close() }
})


test('sections in both density modes partition visible roots without duplicating pinned descendants or flattening trees', async () => {
  const page = await open()
  const sectionRows = section => page.$$eval(`[data-session-section="${section}"] [data-session-id]`, els => els.map(e => e.dataset.sessionId))
  try {
    assert.equal((await sectionRows('sessions')).length, 6)
    await page.click(toggle)
    assert.equal(await page.$('[data-session-section="pinned"]'), null)
    assert.equal((await sectionRows('sessions')).length, 6)
    await page.evaluate(() => window.fixtureSetPinned('demo/main', true))
    await page.waitForSelector('[data-session-section="pinned"]')
    assert.deepEqual(await sectionRows('pinned'), ['demo/main', 'demo/child'])
    assert.equal((await sectionRows('sessions')).length, 4)
    await page.click(`${row('main')} button[aria-expanded]`)
    assert.equal(await page.$(row('child')), null)
    await page.focus(`${row('main')} button[aria-expanded]`)
    await page.keyboard.press('Enter')
    await page.waitForSelector(row('child'))
    await page.evaluate(() => window.fixtureSetPinned('demo/main', false))
    await page.evaluate(() => window.fixtureSetPinned('demo/child', true))
    await page.waitForFunction(() => document.querySelector('[data-session-section="pinned"] [data-session-id]')?.dataset.sessionId === 'demo/child')
    assert.deepEqual(await sectionRows('pinned'), ['demo/child'])
    assert.equal(await page.$$eval(row('child'), els => els.length), 1)
    assert.equal((await sectionRows('sessions')).includes('demo/main'), true)
    assert.equal((await sectionRows('sessions')).includes('demo/child'), false)
    for (const mode of ['Default', 'Time']) {
      await page.click(`button[aria-label="Session list mode: ${mode}"]`)
      assert.deepEqual(await sectionRows('pinned'), ['demo/child'])
      assert.equal(await page.$$eval('[data-session-id]', els => new Set(els.map(e => e.dataset.sessionId)).size), 6)
    }
    assert.equal(await page.$(`${row('main')} button[aria-expanded]`), null)
    await page.type('input[aria-label="Search sessions"]', 'Evaluate the compact navigation')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1)
    assert.equal(await page.$('[data-session-section="sessions"]'), null)
    await page.click('button[aria-label="Clear session search"]')
    await page.type('input[aria-label="Search sessions"]', 'Waiting for review')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1)
    assert.equal(await page.$('[data-session-section="pinned"]'), null)
    await page.click('button[aria-label="Clear session search"]')
    await page.type('input[aria-label="Search sessions"]', 'no matching session')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 0)
    assert.equal(await page.$('[data-session-section]'), null)
    await page.click('button[aria-label="Clear session search"]')
    await page.click(toggle)
    assert.deepEqual(await sectionRows('pinned'), ['demo/child'])
    assert.equal((await sectionRows('sessions')).length, 5)
  } finally { await page.close() }
})

test('normal rows share right-side pin actions with stable title space and touch visibility', async () => {
  for (const mobile of [false, true]) {
    const page = await open(mobile)
    const pin = `${row('wait')} .session-pin`
    const title = `${row('wait')} [data-session-title]`
    try {
      assert.ok(await page.$('[data-session-list-density="normal"]'))
      assert.equal(await page.$('.session-compact-pin'), null)
      const bounds = () => page.$eval(title, e => ({ x: e.getBoundingClientRect().x, width: e.getBoundingClientRect().width }))
      const initialBounds = await bounds()
      assert.equal(await page.$eval(pin, e => e.previousElementSibling.hasAttribute('data-session-title') && e.getBoundingClientRect().left >= e.previousElementSibling.getBoundingClientRect().right), true)
      assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), mobile ? '1' : '0')
      if (!mobile) {
        await page.hover(row('wait'))
        assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
        assert.deepEqual(await bounds(), initialBounds)
        const box = await (await page.$(pin)).boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 })
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('span')].some(e => e.textContent === 'Drop here to detach to root')), false)
        await page.mouse.up()
        await page.mouse.move(800, 650)
        await page.focus(pin)
        assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
        await page.keyboard.press('Enter')
      } else {
        assert.ok(await page.$eval(pin, e => e.getBoundingClientRect().height) >= 40)
        await page.tap(pin)
      }
      await page.waitForSelector(`${pin}[aria-pressed="true"]`)
      await page.focus(toggle)
      assert.equal(await page.$eval(pin, e => getComputedStyle(e).opacity), '1')
      assert.deepEqual(await bounds(), initialBounds)
      assert.equal(await page.$(`${row('wait')} [data-session-title] svg`), null)
      assert.equal(await page.$eval(`${pin} svg`, e => e.getAttribute('stroke-width')), '1.5')
      assert.equal(await page.evaluate(() => window.fixtureSelected), undefined)
      if (mobile) await page.tap(pin)
      else await page.click(pin)
      await page.waitForSelector(`${pin}[aria-pressed="false"]`)
      assert.deepEqual(await page.evaluate(() => window.fixturePinRequests), [
        { id: 'demo/wait', pinned: true, method: 'POST' },
        { id: 'demo/wait', pinned: false, method: 'POST' },
      ])
      assert.equal(await page.evaluate(() => window.fixtureSelected), undefined)
      assert.deepEqual(await bounds(), initialBounds)
    } finally { await page.close() }
  }
})


test('compact descendant activity is separate from own status and persists on collapsed unselected ancestors', async () => {
  const page = await open()
  try {
    await page.goto(url + '?descendants')
    await page.waitForSelector(toggle)
    await page.click(toggle)
    await page.evaluate(() => {
      window.fixtureSetSessions([
        { id: 'demo/main', displayName: 'A deliberately very long parent title that must remain readable with ellipsis', parentSessionId: null, runtimeState: { state: 'idle' }, childTotal: 1, messageCount: 1 },
        { id: 'demo/child', displayName: 'Middle ancestor', parentSessionId: 'demo/main', runtimeState: { state: 'idle' }, childTotal: 1, messageCount: 1 },
        { id: 'demo/grandchild', displayName: 'Deep active worker', parentSessionId: 'demo/child', runtimeState: { state: 'running-tool' }, messageCount: 1 },
        { id: 'demo/wait', displayName: 'Selected session', parentSessionId: null, runtimeState: { state: 'idle' }, messageCount: 1 },
        { id: 'demo/legacy', displayName: 'Own activity only', parentSessionId: null, busy: true, messageCount: 1 },
      ])
      window.fixtureSetDescendantBusy([['demo/main', 1], ['demo/child', 1]])
    })
    await page.waitForSelector(`${row('main')} [data-descendant-activity]`)
    await page.mouse.move(800, 650)
    await page.focus(toggle)
    assert.equal(await page.$(row('child')), null)
    assert.equal(await page.$(`${row('main')} [data-session-status]`), null)
    assert.equal(await page.$eval(`${row('main')} [data-descendant-activity]`, e => getComputedStyle(e).opacity), '1')
    assert.equal(await page.$eval(`${row('main')} [data-descendant-activity]`, e => e.title), '1 active descendant session')
    assert.equal(await page.$eval(`${row('main')} [data-descendant-activity]`, e => e.textContent), '')
    const title = `${row('main')} span[title]`
    const titleBounds = () => page.$eval(title, e => ({ x: e.getBoundingClientRect().x, width: e.getBoundingClientRect().width }))
    const initialBounds = await titleBounds()
    assert.equal(await page.$eval(title, e => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis'), true)
    assert.equal(await page.$eval(row('main'), e => e.scrollWidth <= e.clientWidth), true)
    assert.equal(await page.$(`${row('legacy')} [data-descendant-activity]`), null)
    assert.ok(await page.$(`${row('legacy')} [data-session-status]`))
    assert.equal(await page.$(`${row('wait')} [data-descendant-activity]`), null)
    await page.click(`${row('main')} button[aria-expanded]`)
    await page.waitForSelector(`${row('child')} [data-descendant-activity]`)
    assert.equal(await page.$(row('grandchild')), null)
    await page.evaluate(() => window.fixtureSetDescendantBusy([['demo/main', 0], ['demo/child', 0]]))
    await page.waitForFunction(() => !document.querySelector('[data-descendant-activity]'))
    assert.deepEqual(await titleBounds(), initialBounds)
    await page.evaluate(() => {
      window.fixtureSetSessions(previous => previous.map(s => s.id === 'demo/main' ? { ...s, runtimeState: { state: 'requesting-model' } } : s))
      window.fixtureSetDescendantBusy([['demo/main', 2], ['demo/child', 1]])
    })
    await page.waitForSelector(`${row('main')} [data-session-status]`)
    assert.deepEqual(await titleBounds(), initialBounds)
    assert.equal(await page.$eval(`${row('main')} [data-descendant-activity]`, e => e.title), '2 active descendant sessions')
    assert.equal(await page.$eval(`${row('main')} [data-descendant-activity-slot]`, e => e.previousElementSibling.matches('.session-pin') && e.nextElementSibling.matches('[data-session-status]')), true)
    await page.click(toggle)
    assert.equal(await page.$('[data-descendant-activity-slot]'), null)
    assert.ok(await page.$eval(row('main'), e => e.textContent.includes('2 active')))
  } finally { await page.close() }
})
