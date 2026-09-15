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
      window.fetch = async () => new Response(JSON.stringify({ total: 1, busy: 0 }), { headers: { 'Content-Type': 'application/json' } })
      const sessions = [
        { id: 'demo/main', displayName: 'Research workspace', childSessions: ['demo/child'], runtimeState: { state: 'requesting-model', active: { phase: 'compaction' } } },
        { id: 'demo/child', displayName: 'Evaluate the compact navigation', parentSessionId: 'demo/main', runtimeState: { state: 'running-tool', tool: { name: 'exec' } } },
        { id: 'demo/wait', displayName: 'Waiting for review', runtimeState: { state: 'waiting', waiting: { waitingFor: 'input' } } },
        { id: 'demo/idle', displayName: 'Completed experiment with a deliberately long descriptive title', runtimeState: { state: 'idle' }, busy: true },
        { id: 'demo/legacy', displayName: 'Legacy running session', busy: true },
        { id: 'demo/archive', displayName: 'Archived notes', archived: true },
      ].map((s, i) => ({ parentSessionId: null, messageCount: 12, lastMessageTime: 100-i, ...s }))
      function Fixture() {
        const [current, setCurrent] = useState('demo/child')
        const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
        return <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={event => window.fixtureDrops.push(event.over?.data.current)}>
          <div style={{ width: 'min(340px, 100vw)', height: '100vh' }} className="bg-fw-surface border-r border-fw-border">
            <div className="p-4 text-fw-text-strong font-bold border-b border-fw-border">Foxwarm · Demo sessions</div>
            <div style={{ height: 'calc(100% - 57px)' }}><Core sessions={sessions} currentSession={current} unreadSessionIds={new Set(['demo/idle'])} onSelectSession={id => { window.fixtureSelected = id; setCurrent(id) }} /></div>
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
    assert.ok(await page.$eval(row('main'), e => e.getBoundingClientRect().height) < normalHeight)
    assert.deepEqual(await page.$$eval('[data-session-status]', els => els.map(e => [e.dataset.sessionStatus, e.getAttribute('aria-label')])), [
      ['requesting-model', 'Status: compacting'], ['running-tool', 'Status: tool: exec'], ['waiting', 'Status: waiting: input'], ['idle', 'Status: idle'], ['requesting-model', 'Status: thinking'], ['idle', 'Status: idle'],
    ])
    assert.ok(await page.$(`${row('idle')} [aria-label="Unread idle completion"]`))
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
      await page.waitForFunction(() => document.body.textContent.includes('Drop here to detach to root'))
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
