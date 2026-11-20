import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

// The real Session list over synthetic rows: two Sessions with open questions above forty others.
let server, browser, url
const scroller = '[data-session-list-scroll-container]'
const section = '[data-session-section="questions"]'
const hint = '[data-session-question-hint]'
const status = '[data-session-question-hint-status]'
const displayToggle = 'button[aria-label="Session display options"]'

before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: { loader: 'tsx', resolveDir: root, sourcefile: 'question-hint-fixture.tsx', contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { DndContext } from '@dnd-kit/core'
      import Core from './src/components/SessionListCore'
      import { initializeThemeRuntime, setThemeSelection } from './src/theme'
      initializeThemeRuntime()
      window.fixtureTheme = setThemeSelection
      window.fetch = async () => new Response(JSON.stringify({ total: 0, busy: 0 }), { headers: { 'Content-Type': 'application/json' } })
      const params = new URLSearchParams(location.search)
      const regular = Array.from({ length: 40 }, (_, i) => ({ id: 'demo/s' + String(i + 1).padStart(2, '0'), displayName: 'Regular session ' + (i + 1), lastMessageTime: 1000 - i }))
      const initialQuestions = { 'demo/ask-a': { open: 1, revision: 1, waiting: true }, 'demo/ask-b': { open: 2, revision: 1 } }
      const sessions = [
        { id: 'demo/ask-a', displayName: 'Choose the database', lastMessageTime: 500 },
        { id: 'demo/ask-b', displayName: 'Review the release notes', lastMessageTime: 400 },
        ...regular,
      ].map(s => ({ parentSessionId: null, messageCount: 4, ...s }))
      const noop = () => {}
      function Fixture() {
        const [questions, setQuestions] = useState(initialQuestions)
        window.fixtureSetQuestion = (id, projection) => setQuestions(current => ({ ...current, [id]: projection }))
        const rows = sessions.map(s => questions[s.id] ? { ...s, questions: questions[s.id] } : s)
        const groupIds = rows.filter(s => !questions[s.id]).map(s => s.id)
        const bounded = params.has('grouped') ? {
          serverOrdered: true, hasMoreRoots: false, childPages: new Map(), branchLoadStates: new Map(), descendantBusy: new Map(), invalidationVersion: 0,
          onModeChange: noop, onFilterChange: noop, onLoadMoreRoots: noop, onLoadMoreChildren: noop,
          onExpandBranch: noop, onExpandBranches: noop, onRetryBranch: noop, onCollapseBranch: noop,
          groupView: { grouping: 'agent', groups: [{ key: 'agent:demo', label: 'demo', count: groupIds.length }], pages: new Map([['agent:demo', { key: 'agent:demo', ids: groupIds, total: groupIds.length, nextCursor: null }]]),
            presentationGroups: {}, collapsed: new Set(), setGrouping: noop, toggleGroup: noop, loadMoreGroup: noop },
        } : undefined
        if (params.has('mobile')) {
          return <div style={{ height: '100vh' }} className="flex flex-col bg-fw-canvas">
            <div className="relative min-h-0 flex-1">
              <Core sessions={rows} onSelectSession={noop} dragEnabled={false} toolbarContainerClassName="px-4 py-2" listContainerClassName="mobile-session-scroll px-4 pt-2"
                mobileHeaderActions={<button type="button" aria-label="Workspace tools" className="mobile-header-circle">…</button>} />
            </div>
          </div>
        }
        return <DndContext>
          <div style={{ width: 340, height: '100vh' }} className="bg-fw-sidebar-surface border-r border-fw-border">
            <Core bounded={bounded} sessions={rows} currentSession="demo/s03" onSelectSession={noop} />
          </div>
        </DndContext>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: webuiReactAliases,
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

async function open(query = '', mobile = false) {
  const page = await browser.newPage()
  await page.setViewport({ width: mobile ? 390 : 1000, height: mobile ? 760 : 640, isMobile: mobile, hasTouch: mobile })
  await page.goto(`${url}/${query}`)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector(section)
  return page
}
const scrollTo = (page, top) => page.$eval(scroller, (el, top) => { el.scrollTop = top }, top)
const hintText = page => page.$eval(hint, el => el.textContent.trim())
const statusText = page => page.$eval(status, el => el.textContent.trim())
const waitHint = (page, shown) => page.waitForFunction((selector, shown) => !!document.querySelector(selector) === shown, {}, hint, shown)
async function scrollAway(page) {
  await scrollTo(page, 600)
  await waitHint(page, true)
}
async function chooseDisplayOption(page, label) {
  await page.click(displayToggle)
  await page.waitForSelector('[role="menu"]')
  await page.evaluate(text => [...document.querySelectorAll('[role="menu"] button')].find(button => button.textContent.trim() === text).click(), label)
  await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
}
async function screenshot(page, name) {
  const output = process.env.FOXWARM_E2E_SCREENSHOT_DIR
  if (!output) return
  await mkdir(output, { recursive: true })
  // Let the hint's entrance and any theme transition settle.
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  await page.screenshot({ path: path.join(output, name) })
}

test('the hint appears once the section scrolls away, returns to it and follows open questions', async () => {
  const page = await open()
  try {
    assert.equal(await page.$(hint), null, 'no hint while the section is in view')
    assert.equal(await statusText(page), '')
    const before = await page.$eval(scroller, el => ({ height: el.clientHeight, width: el.clientWidth, row: document.querySelector('[data-session-id="demo/s20"]').getBoundingClientRect().top + el.scrollTop }))
    await scrollAway(page)
    assert.equal(await hintText(page), '2 sessions waiting for your answer')
    assert.equal(await page.$eval(hint, el => el.tagName), 'BUTTON')
    assert.equal(await statusText(page), '', 'scrolling alone announces nothing')
    // The hint overlays the list: rows and the scroll area keep their geometry.
    const after = await page.$eval(scroller, el => ({ height: el.clientHeight, width: el.clientWidth, row: document.querySelector('[data-session-id="demo/s20"]').getBoundingClientRect().top + el.scrollTop }))
    assert.deepEqual(after, before)
    // It sits inside the scroll area, below the list's own toolbar.
    const geometry = await page.evaluate((hintSelector, scrollerSelector) => ({
      hint: document.querySelector(hintSelector).getBoundingClientRect().toJSON(),
      scroller: document.querySelector(scrollerSelector).getBoundingClientRect().toJSON(),
      toolbar: document.querySelector(scrollerSelector).parentElement.previousElementSibling.getBoundingClientRect().toJSON(),
      display: document.querySelector('[data-session-list-display-options]').getBoundingClientRect().toJSON(),
    }), hint, scroller)
    assert.ok(geometry.hint.top >= geometry.scroller.top && geometry.hint.top >= geometry.toolbar.bottom && geometry.hint.top > geometry.display.bottom, JSON.stringify(geometry))
    assert.ok(geometry.hint.left >= geometry.scroller.left && geometry.hint.right <= geometry.scroller.right)
    await screenshot(page, 'question-hint-desktop-light.png')
    await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.default', colorMode: 'dark' }))
    await screenshot(page, 'question-hint-desktop-dark.png')
    await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.default', colorMode: 'light' }))

    // A readable part of the section hides the hint; a thin sliver does not.
    const sectionHeight = await page.$eval(section, el => el.getBoundingClientRect().height)
    await scrollTo(page, sectionHeight - 40)
    await waitHint(page, false)
    await scrollTo(page, sectionHeight - 4)
    await waitHint(page, true)

    // Live count: a question closing updates and announces the count.
    await scrollAway(page)
    await page.evaluate(() => window.fixtureSetQuestion('demo/ask-b', null))
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === '1 session waiting for your answer', {}, hint)
    assert.equal(await statusText(page), '1 session waiting for your answer')

    // Clicking scrolls back to the section and focuses it; the hint goes away at the top.
    await page.click(hint)
    await page.waitForFunction(selector => document.querySelector(selector).scrollTop === 0, {}, scroller)
    await waitHint(page, false)
    assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), section), true)
    assert.equal(await statusText(page), '')

    // Keyboard activation with reduced motion jumps without animation.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await scrollAway(page)
    await page.focus(hint)
    await page.keyboard.press('Enter')
    assert.equal(await page.$eval(scroller, el => el.scrollTop), 0)
    await waitHint(page, false)
    assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), section), true)

    // The last question closing removes the hint silently.
    await scrollAway(page)
    await page.evaluate(() => window.fixtureSetQuestion('demo/ask-a', null))
    await waitHint(page, false)
    assert.equal(await page.$(section), null)
    assert.equal(await statusText(page), '')

    // A question opening while the user is scrolled down brings the hint back and announces it.
    await page.evaluate(() => window.fixtureSetQuestion('demo/ask-b', { open: 1, revision: 2, waiting: true }))
    await page.waitForSelector(section)
    await waitHint(page, true)
    assert.equal(await hintText(page), '1 session waiting for your answer')
    assert.equal(await statusText(page), '1 session waiting for your answer')
  } finally {
    await page.close()
  }
})

test('the hint works in every list mode and in Agent groups', async () => {
  for (const [query, modes] of [['', ['Time', 'Flat', 'Default']], ['?grouped', ['Default', 'Flat']]]) {
    const page = await open(query)
    try {
      if (query) await page.waitForSelector('[data-session-group="agent:demo"]')
      for (const mode of modes) {
        await chooseDisplayOption(page, mode)
        await page.waitForSelector(section)
        await scrollTo(page, 0)
        await waitHint(page, false)
        await scrollAway(page)
        assert.equal(await hintText(page), '2 sessions waiting for your answer', `${query} ${mode}`)
        await page.click(hint)
        await page.waitForFunction(selector => document.querySelector(selector).scrollTop === 0, {}, scroller)
        await waitHint(page, false)
      }
    } finally {
      await page.close()
    }
  }
})

test('a filtered list without the section shows no hint', async () => {
  const page = await open()
  try {
    await page.type('input[aria-label="Search sessions"]', 'Regular')
    await page.waitForFunction(selector => !document.querySelector(selector), {}, section)
    await scrollTo(page, 600)
    assert.ok(await page.$eval(scroller, el => el.scrollTop) > 0)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await page.$(hint), null)
  } finally {
    await page.close()
  }
})

test('the mobile Sessions page shows the hint below its header', async () => {
  const page = await open('?mobile', true)
  try {
    await page.waitForSelector('[data-mobile-page-header]')
    await scrollAway(page)
    assert.equal(await hintText(page), '2 sessions waiting for your answer')
    const geometry = await page.evaluate(selector => ({
      hint: document.querySelector(selector).getBoundingClientRect().toJSON(),
      header: document.querySelector('[data-mobile-page-header]').getBoundingClientRect().toJSON(),
    }), hint)
    assert.ok(geometry.hint.top >= geometry.header.bottom, JSON.stringify(geometry))
    assert.ok(geometry.hint.height >= 36, 'touch-sized')
    await screenshot(page, 'question-hint-mobile-light.png')
    await page.evaluate(() => window.fixtureTheme({ themeId: 'foxwarm.default', colorMode: 'dark' }))
    await screenshot(page, 'question-hint-mobile-dark.png')
    await page.tap(hint)
    await page.waitForFunction(selector => document.querySelector(selector).scrollTop === 0, {}, scroller)
    await waitHint(page, false)
    // At the top the section starts below the header, so it counts as visible.
    const top = await page.evaluate(selector => ({ section: document.querySelector(selector).getBoundingClientRect().top, header: document.querySelector('[data-mobile-page-header]').getBoundingClientRect().bottom }), section)
    assert.ok(top.section >= top.header, JSON.stringify(top))
  } finally {
    await page.close()
  }
})
