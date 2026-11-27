// The shared Select in a real browser: the drawn desktop list (keyboard, pointer, ARIA,
// placement, dialogs and enclosing popovers) and the native picker on coarse pointers.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const componentEntry = new URL('../src/components/Select.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let server
let fixtureUrl

const fixtureSource = `
  import React, { useEffect, useRef, useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import Select from ${JSON.stringify(componentEntry)}

  const MANY = Array.from({ length: 40 }, (_, index) => ({ value: 'v' + index, label: 'Option ' + String(index).padStart(2, '0'), disabled: index === 3 }))
  const GROUPS = [{ value: 'agent', label: 'Agent' }, { value: 'session', label: 'Session' }, { value: 'model', label: 'Model' }, { value: 'memory', label: 'Memory' }]
  window.changes = []

  function Field({ name, options, initial, ...props }) {
    const [value, setValue] = useState(initial)
    return <Select {...props} data-fixture={name} value={value} options={options} onChange={next => { window.changes.push(name + ':' + next); setValue(next) }} />
  }

  function Popover() {
    const [open, setOpen] = useState(true)
    const ref = useRef(null)
    useEffect(() => {
      if (!open) return
      const outside = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
      document.addEventListener('mousedown', outside)
      document.addEventListener('pointerdown', outside)
      return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('pointerdown', outside) }
    }, [open])
    return open ? <div ref={ref} data-popover style={{ border: '1px solid', padding: 8, width: 220 }}><Field name="popover" options={GROUPS} initial="agent" aria-label="Popover choice" /></div> : <span data-popover-closed>closed</span>
  }

  function Modal() {
    const ref = useRef(null)
    const [closed, setClosed] = useState(0)
    return <>
      <button type="button" data-open-dialog onClick={() => ref.current.showModal()}>Open dialog</button>
      <span data-dialog-closed={closed} />
      <dialog ref={ref} onClose={() => setClosed(count => count + 1)} style={{ width: 360, padding: 16 }}>
        <label>Launch method<Field name="dialog" options={GROUPS} initial="session" className="mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2 text-sm" /></label>
      </dialog>
    </>
  }

  function App() {
    return <div style={{ padding: 24 }}>
      <label data-label>Group by <Field name="group" variant="toolbar" options={GROUPS} initial="session" aria-label="Group usage by" /></label>
      <button type="button" data-after>After</button>
      <div style={{ height: 120, overflow: 'auto', border: '1px solid', marginTop: 12 }} data-scroller>
        <div style={{ height: 60 }} />
        <Field name="many" options={MANY} initial="v25" aria-label="Many" className="w-60 rounded border px-2 py-1" />
        <div style={{ height: 200 }} />
      </div>
      <Field name="disabled" options={GROUPS} initial="agent" aria-label="Disabled choice" disabled />
      <Modal />
      <Popover />
      <div style={{ position: 'fixed', bottom: 12, right: 24 }}><Field name="bottom" options={MANY} initial="v39" aria-label="Bottom" variant="toolbar" /></div>
    </div>
  }
  createRoot(document.getElementById('root')).render(<App />)
`

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssCandidates = assetNames.filter(name => /^index-.*\.css$/.test(name))
  const cssStats = await Promise.all(cssCandidates.map(async name => ({ name, mtimeMs: (await stat(new URL(name, assetsDirectory))).mtimeMs })))
  const cssAsset = cssStats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
  assert.ok(cssAsset, 'build packages/webui before running the Select browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const result = await build({
    stdin: { contents: fixtureSource, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'select-fixture.tsx', loader: 'tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html data-foxwarm-theme="550a"><head><style>${css}</style></head><body><div id="root"></div><script>${result.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function openPage({ coarse = false } = {}) {
  const page = await browser.newPage()
  // Touch emulation makes the primary pointer coarse, as on a phone.
  await page.setViewport(coarse ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 900, height: 700 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('[data-fixture="group"]')
  page.errors = errors
  return page
}

const trigger = name => `[data-fixture="${name}"]`
const listState = page => page.evaluate(() => {
  const list = document.querySelector('[role="listbox"]')
  if (!list) return null
  const active = list.querySelector('[data-active="true"]')
  return {
    parent: list.parentElement.tagName,
    active: active?.textContent ?? null,
    activeId: active?.id ?? null,
    selected: [...list.querySelectorAll('[aria-selected="true"]')].map(option => option.textContent),
    rect: list.getBoundingClientRect().toJSON(),
  }
})
const changes = page => page.evaluate(() => window.changes.splice(0))
const focused = page => page.evaluate(() => document.activeElement?.getAttribute('data-fixture') ?? (document.activeElement?.hasAttribute('data-after') ? 'after' : document.activeElement?.tagName))

test('the trigger is a combobox that opens a listbox on press and chooses an option on click', async () => {
  const page = await openPage()
  const closed = await page.$eval(trigger('group'), element => ({ role: element.getAttribute('role'), expanded: element.getAttribute('aria-expanded'), popup: element.getAttribute('aria-haspopup'), value: element.value, text: element.querySelector('[data-select-value]').textContent, name: element.getAttribute('aria-label'), tag: element.tagName }))
  assert.deepEqual(closed, { role: 'combobox', expanded: 'false', popup: 'listbox', value: 'session', text: 'Session', name: 'Group usage by', tag: 'BUTTON' })
  // The trigger keeps the width of its longest option, as a native select does.
  const width = await page.$eval(trigger('group'), element => element.getBoundingClientRect().width)

  await page.click(trigger('group'))
  let state = await listState(page)
  assert.equal(state.parent, 'BODY')
  assert.equal(state.active, 'Session')
  assert.deepEqual(state.selected, ['Session'])
  const aria = await page.$eval(trigger('group'), element => ({ expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), activedescendant: element.getAttribute('aria-activedescendant') }))
  assert.equal(aria.expanded, 'true')
  assert.equal(aria.activedescendant, state.activeId)
  assert.equal(aria.controls, await page.$eval('[role="listbox"]', element => element.id))
  assert.equal(await focused(page), 'group')
  const triggerRect = await page.$eval(trigger('group'), element => element.getBoundingClientRect().toJSON())
  assert.ok(state.rect.top >= triggerRect.bottom && state.rect.top - triggerRect.bottom <= 8, 'opens just below the trigger')
  assert.ok(state.rect.width >= triggerRect.width - 0.5, 'at least as wide as the trigger')

  await page.click('[role="option"][data-select-option="model"]')
  assert.equal(await listState(page), null)
  assert.deepEqual(await changes(page), ['group:model'])
  assert.equal(await page.$eval(trigger('group'), element => element.value), 'model')
  assert.equal(await page.$eval(trigger('group'), element => element.getBoundingClientRect().width), width)
  assert.equal(await focused(page), 'group')

  // Choosing the current option is not a change; a press on the trigger or outside closes the list.
  await page.click(trigger('group'))
  await page.click('[role="option"][data-select-option="model"]')
  await page.click(trigger('group'))
  await page.click(trigger('group'))
  assert.equal(await listState(page), null)
  await page.click(trigger('group'))
  await page.mouse.click(860, 300)
  assert.equal(await listState(page), null)
  assert.deepEqual(await changes(page), [])
  assert.deepEqual(page.errors, [])
  await page.close()
})

test('keyboard: arrows, Home/End, type-ahead, Enter/Space choose; Escape and Tab close without a change', async () => {
  const page = await openPage()
  await page.focus(trigger('group'))
  await page.keyboard.press('ArrowDown')
  assert.equal((await listState(page)).active, 'Session')
  await page.keyboard.press('ArrowDown')
  assert.equal((await listState(page)).active, 'Model')
  await page.keyboard.press('Home')
  assert.equal((await listState(page)).active, 'Agent')
  await page.keyboard.press('End')
  assert.equal((await listState(page)).active, 'Memory')
  await page.keyboard.press('ArrowDown')
  assert.equal((await listState(page)).active, 'Memory')
  await page.keyboard.press('Escape')
  assert.equal(await listState(page), null)
  assert.equal(await focused(page), 'group')
  assert.deepEqual(await changes(page), [])

  await page.keyboard.press('Enter')
  await page.keyboard.type('mo')
  assert.equal((await listState(page)).active, 'Model')
  await page.keyboard.press('Enter')
  assert.equal(await listState(page), null)
  assert.deepEqual(await changes(page), ['group:model'])

  await page.keyboard.press(' ')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press(' ')
  assert.deepEqual(await changes(page), ['group:session'])
  assert.equal(await focused(page), 'group')

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  assert.equal(await listState(page), null)
  assert.equal(await focused(page), 'after')
  assert.deepEqual(await changes(page), [])
  assert.equal(await page.$eval(trigger('group'), element => element.value), 'session')

  // A label click focuses the trigger without opening it, like a native select.
  await page.click('[data-label]', { offset: { x: 4, y: 4 } })
  assert.equal(await focused(page), 'group')
  assert.equal(await listState(page), null)
  await page.close()
})

test('a long list scrolls to the selected option, skips disabled options and is not clipped by its scroller', async () => {
  const page = await openPage()
  await page.click(trigger('many'))
  const scroll = await page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]')
    const option = list.querySelector('[aria-selected="true"]')
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    const hit = document.elementFromPoint(optionRect.left + 10, optionRect.top + optionRect.height / 2)
    return { scrolled: list.scrollTop > 0, visible: optionRect.top >= listRect.top && optionRect.bottom <= listRect.bottom, hit: option.contains(hit), height: listRect.height, label: option.textContent }
  })
  assert.deepEqual([scroll.scrolled, scroll.visible, scroll.hit, scroll.label], [true, true, true, 'Option 25'])
  assert.ok(scroll.height <= 320)

  // Scrolling the list itself keeps it open; scrolling the container that moves the trigger closes it.
  await page.$eval('[role="listbox"]', list => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')) })
  assert.ok(await listState(page))
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')))
  assert.ok(await listState(page), 'a scroll that leaves the trigger in place keeps the list open')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  assert.equal((await listState(page)).active, 'Option 02')
  await page.keyboard.press('ArrowDown')
  assert.equal((await listState(page)).active, 'Option 04', 'disabled option skipped')
  await page.click('[role="option"][data-select-option="v3"]')
  assert.ok(await listState(page), 'a disabled option does not close the list')
  assert.equal(await page.$eval('[role="option"][data-select-option="v3"]', option => option.getAttribute('aria-disabled')), 'true')
  await page.$eval('[data-scroller]', element => { element.scrollTop = 20 })
  await page.waitForFunction(() => !document.querySelector('[role="listbox"]'))
  assert.deepEqual(await changes(page), [])

  // Near the bottom edge the list opens above its trigger, inside the viewport.
  await page.click(trigger('bottom'))
  const state = await listState(page)
  const triggerRect = await page.$eval(trigger('bottom'), element => element.getBoundingClientRect().toJSON())
  assert.ok(state.rect.bottom <= triggerRect.top, 'flipped above')
  assert.ok(state.rect.top >= 8)
  assert.equal(state.active, 'Option 39')
  await page.keyboard.press('Escape')

  // A disabled Select does not open.
  assert.equal(await page.$eval(trigger('disabled'), element => element.disabled), true)
  await page.click(trigger('disabled')).catch(() => {})
  assert.equal(await listState(page), null)
  await page.close()
})

test('inside a modal dialog the list renders in the dialog, and Escape closes the list before the dialog', async () => {
  const page = await openPage()
  await page.click('[data-open-dialog]')
  await page.click(trigger('dialog'))
  const state = await listState(page)
  assert.equal(state.parent, 'DIALOG')
  const hit = await page.$eval('[role="option"][data-select-option="memory"]', option => {
    const rect = option.getBoundingClientRect()
    return option.contains(document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2))
  })
  assert.ok(hit, 'the list is above the dialog content')
  await page.keyboard.press('Escape')
  assert.equal(await listState(page), null)
  assert.equal(await page.$eval('dialog', dialog => dialog.open), true)
  await page.click(trigger('dialog'))
  await page.click('[role="option"][data-select-option="memory"]')
  assert.deepEqual(await changes(page), ['dialog:memory'])
  assert.equal(await page.$eval('dialog', dialog => dialog.open), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('dialog', dialog => dialog.open), false)
  await page.close()
})

test('choosing in the list is not an outside press for an enclosing popover', async () => {
  const page = await openPage()
  await page.click(trigger('popover'))
  await page.click('[role="option"][data-select-option="model"]')
  assert.ok(await page.$('[data-popover]'), 'popover stays open')
  assert.deepEqual(await changes(page), ['popover:model'])
  await page.mouse.click(860, 300)
  assert.ok(await page.$('[data-popover-closed]'))
  await page.close()
})

test('with a coarse pointer a transparent native select covers the same trigger', async () => {
  const page = await openPage({ coarse: true })
  const native = await page.$eval('select[aria-label="Group usage by"]', select => {
    const box = select.parentElement
    const selectRect = select.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    return {
      opacity: getComputedStyle(select).opacity,
      covers: Math.abs(selectRect.width - box.clientWidth) < 1 && Math.abs(selectRect.height - box.clientHeight) < 1 && boxRect.width - selectRect.width <= 2,
      shown: box.querySelector('[data-select-value]').textContent,
      mode: box.getAttribute('data-select-mode'),
      fixture: select.getAttribute('data-fixture'),
      options: [...select.options].map(option => option.value),
    }
  })
  assert.deepEqual(native, { opacity: '0', covers: true, shown: 'Session', mode: 'native', fixture: 'group', options: ['agent', 'session', 'model', 'memory'] })
  await page.select('select[aria-label="Group usage by"]', 'memory')
  assert.deepEqual(await changes(page), ['group:memory'])
  assert.equal(await page.$eval('[data-select-mode="native"] [data-select-value]', element => element.textContent), 'Memory')
  assert.equal(await page.$('[role="combobox"]'), null)
  assert.equal(await page.$eval('select[data-fixture="many"] option[value="v3"]', option => option.disabled), true)
  await page.close()
})
