import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const componentEntry = new URL('../src/components/TerminalVirtualKeyboard.tsx', import.meta.url).pathname
const keyboardEntry = new URL('../src/terminalVirtualKeyboard.ts', import.meta.url).pathname
const screenshotDir = process.env.FOXWARM_KEYBOARD_SCREENSHOTS_DIR
let browser
let page
let server
let fixtureUrl

async function buildFixture() {
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import TerminalVirtualKeyboard, { TerminalKeyboardHeaderControl } from ${JSON.stringify(componentEntry)}
    import { loadTerminalKeyboardMode, TERMINAL_KEYBOARD_STORAGE_KEY } from ${JSON.stringify(keyboardEntry)}

    class FakeTerminal {
      constructor() {
        this.inputs = []
        this.pastes = []
        this.selection = ''
        this.modes = { applicationCursorKeysMode: false }
        this.textarea = document.createElement('textarea')
        this.textarea.id = 'terminal-textarea'
        document.body.appendChild(this.textarea)
      }
      input(data) { this.inputs.push(data) }
      paste(data) { this.pastes.push(data) }
      getSelection() { return this.selection }
      focus() { this.textarea.focus() }
      blur() { this.textarea.blur() }
    }

    const terminal = new FakeTerminal()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      text: '',
      async writeText(value) { this.text = value },
      async readText() { return this.text },
    }})

    function Fixture() {
      const [resetToken, setResetToken] = useState('one')
      const [mode, setMode] = useState(() => loadTerminalKeyboardMode(localStorage, window.matchMedia('(pointer: coarse)').matches))
      const changeMode = value => {
        setMode(value)
        localStorage.setItem(TERMINAL_KEYBOARD_STORAGE_KEY, value)
      }
      window.keyboardFixture = {
        terminal,
        inputs: () => [...terminal.inputs],
        pastes: () => [...terminal.pastes],
        clear: () => { terminal.inputs.length = 0; terminal.pastes.length = 0 },
        selection: value => { terminal.selection = value },
        clipboard: value => { navigator.clipboard.text = value },
        reset: () => setResetToken(value => value + '!'),
      }
      return React.createElement('div', { style: { width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { className: 'fixture-header', style: { height: '34px', display: 'flex', alignItems: 'center', padding: '0 6px', background: '#e7e5e0' } },
          mode !== 'web' ? React.createElement(TerminalKeyboardHeaderControl, { nativeMode: mode === 'native', onActivate: () => changeMode('web') }) : null
        ),
        React.createElement('div', { style: { minHeight: 0, flex: 1, background: '#111' } }),
        React.createElement(TerminalVirtualKeyboard, { terminal, resetToken, mode, onModeChange: changeMode })
      )
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'terminal-keyboard-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    outdir: 'out',
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return {
    js: result.outputFiles.find(file => file.path.endsWith('.js')).text,
    css: result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '',
  }
}

before(async () => {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
  const fixture = await buildFixture()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#111827}${fixture.css}</style></head><body><div id="root"></div><script>${fixture.js}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function mount() {
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.keyboardFixture))
}

async function key(label) {
  return page.evaluateHandle(value => [...document.querySelectorAll('.terminal-key')].find(button => button.textContent.trim() === value || button.getAttribute('aria-label') === value || button.dataset.keyId === `abc-${value}` || button.dataset.keyId === `symbol-${value}`), label)
}

async function clickKey(label) {
  const handle = await key(label)
  await handle.click()
}

async function pressAndRelease(label) {
  const handle = await key(label)
  const box = await handle.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
}

test('mobile defaults to the Web keyboard and ABC, 123, and More keep one body height', async () => {
  await mount()
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'web')
  assert.deepEqual(await page.$$eval('.terminal-special-bar .terminal-key', buttons => buttons.map(button => button.textContent.trim())), ['Esc', 'Tab', 'Ctrl', 'Alt', '←', '↓', '↑', '→', 'More'])
  assert.ok(await page.evaluate(() => ['q', 'a', 'Shift', 'z', 'Backspace', '123', 'Space', 'Enter'].every(label => [...document.querySelectorAll('.terminal-key')].some(button => button.textContent.trim() === label || button.getAttribute('aria-label') === label))))
  assert.deepEqual(await page.$$eval('.terminal-keyboard-body .row-4 .terminal-key', buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent.trim())), ['123', 'Native keyboard', 'Space', 'Collapse keyboard', 'Enter'])
  const keyColors = await page.evaluate(() => ({
    character: getComputedStyle(document.querySelector('[data-key-id="abc-q"]')).backgroundColor,
    utility: getComputedStyle(document.querySelector('[data-key-id="abc-shift"]')).backgroundColor,
  }))
  assert.notEqual(keyColors.character, keyColors.utility)
  const layoutMetrics = await page.evaluate(() => {
    const rect = id => document.querySelector(`[data-key-id="${id}"]`).getBoundingClientRect()
    const style = id => getComputedStyle(document.querySelector(`[data-key-id="${id}"]`))
    return {
      letterFont: parseFloat(style('abc-q').fontSize),
      utilityFont: parseFloat(style('abc-shift').fontSize),
      backspaceIconWidth: rect('abc-backspace').width && document.querySelector('[data-key-id="abc-backspace"] svg').getBoundingClientRect().width,
      rowGap: parseFloat(getComputedStyle(document.querySelector('.terminal-keyboard-body')).rowGap),
      bottomPadding: parseFloat(getComputedStyle(document.querySelector('.terminal-keyboard-body')).paddingBottom),
      enterToPageRatio: rect('abc-enter').width / rect('abc-symbols').width,
      spaceWidth: rect('abc-space').width,
      enterWidth: rect('abc-enter').width,
      shiftGap: rect('abc-z').left - rect('abc-shift').right,
      ordinaryGap: rect('abc-x').left - rect('abc-z').right,
      backspaceGap: rect('abc-backspace').left - rect('abc-m').right,
    }
  })
  assert.ok(layoutMetrics.letterFont > layoutMetrics.utilityFont)
  assert.ok(layoutMetrics.backspaceIconWidth >= 24)
  assert.equal(layoutMetrics.rowGap, 7)
  assert.equal(layoutMetrics.bottomPadding, 1)
  assert.ok(layoutMetrics.enterToPageRatio > 1.4 && layoutMetrics.enterToPageRatio < 1.6, JSON.stringify(layoutMetrics))
  assert.ok(layoutMetrics.spaceWidth > layoutMetrics.enterWidth)
  assert.ok(layoutMetrics.shiftGap > layoutMetrics.ordinaryGap)
  assert.ok(layoutMetrics.backspaceGap > layoutMetrics.ordinaryGap)
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/terminal-keyboard-390x844.png` })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.screenshot({ path: `${screenshotDir}/terminal-keyboard-dark-390x844.png` })
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
  }
  const height = await page.$eval('.terminal-keyboard-body', element => element.getBoundingClientRect().height)
  await clickKey('123')
  assert.equal(await page.$eval('.terminal-keyboard-body', element => element.getBoundingClientRect().height), height)
  await clickKey('More')
  assert.equal(await page.$eval('.terminal-keyboard-body', element => element.getBoundingClientRect().height), height)
  assert.ok(await page.evaluate(() => ['Home', 'End', 'PgUp', 'PgDn', 'Insert', 'Delete', 'Copy', 'Paste', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)].every(label => [...document.querySelectorAll('.terminal-key')].some(button => button.textContent.trim() === label))))
  assert.deepEqual(await page.$$eval('.terminal-keyboard-body .row-4 .terminal-key', buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent.trim())), ['123', 'Native keyboard', 'Space', 'Collapse keyboard', 'Enter'])
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/terminal-keyboard-more-390x844.png` })
  await clickKey('123')
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.terminal-key')].some(button => button.textContent.trim() === 'ABC')))
})

test('compact landscape keeps the same integrated control row and neutral hierarchy', async () => {
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await mount()
  assert.deepEqual(await page.$$eval('.terminal-keyboard-body .row-4 .terminal-key', buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent.trim())), ['123', 'Native keyboard', 'Space', 'Collapse keyboard', 'Enter'])
  assert.ok((await page.$eval('.terminal-keyboard-body', element => element.getBoundingClientRect().height)) < 200)
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/terminal-keyboard-844x390.png` })
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
})

test('pointer down sends nothing, release sends once, and drag outside cancels', async () => {
  await mount()
  await page.evaluate(() => window.keyboardFixture.clear())
  const q = await key('q')
  const box = await q.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), [])
  await page.mouse.up()
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), ['q'])
  await page.evaluate(() => window.keyboardFixture.clear())
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 30, box.y + box.height + 30)
  await page.mouse.up()
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), [])

  await page.evaluate(() => window.keyboardFixture.clear())
  const accessibleQ = await key('q')
  await accessibleQ.focus()
  await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), ['q'])

  const ctrl = await key('Ctrl')
  const ctrlBox = await ctrl.boundingBox()
  await page.mouse.move(ctrlBox.x + ctrlBox.width / 2, ctrlBox.y + ctrlBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(ctrlBox.x + ctrlBox.width + 30, ctrlBox.y + ctrlBox.height + 30)
  await page.mouse.up()
  assert.ok(!(await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Ctrl'))
})

test('Vim-order Down and Up keys retain their actual VT meanings', async () => {
  await mount()
  await page.evaluate(() => window.keyboardFixture.clear())
  await pressAndRelease('↓')
  await pressAndRelease('↑')
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), ['\x1b[B', '\x1b[A'])
})

test('repeat waits for the hold delay, repeats, and release adds no final key', async () => {
  await mount()
  await page.evaluate(() => window.keyboardFixture.clear())
  await clickKey('Alt')
  const backspace = await key('Backspace')
  const box = await backspace.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal((await page.evaluate(() => window.keyboardFixture.inputs())).length, 0)
  await new Promise(resolve => setTimeout(resolve, 240))
  const beforeRelease = await page.evaluate(() => window.keyboardFixture.inputs())
  assert.ok(beforeRelease.length >= 2)
  assert.ok(beforeRelease.every(value => value === '\x1b\x7f'))
  await page.mouse.up()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), beforeRelease)
  assert.ok(!(await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Alt'))
})

test('Ctrl and Alt are one-shot, Shift is one-shot or double-tap locked, and page switches retain modifiers', async () => {
  await mount()
  await page.evaluate(() => window.keyboardFixture.clear())
  await clickKey('Ctrl')
  await clickKey('Alt')
  await pressAndRelease('q')
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.inputs()), ['\x1b\x11'])
  assert.deepEqual(await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim())), [])

  await clickKey('Shift')
  await pressAndRelease('q')
  assert.equal((await page.evaluate(() => window.keyboardFixture.inputs())).at(-1), 'Q')

  await clickKey('123')
  await clickKey('Shift')
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.terminal-key')].some(button => button.textContent.trim() === '!')))
  await pressAndRelease('1')
  assert.equal((await page.evaluate(() => window.keyboardFixture.inputs())).at(-1), '!')
  await clickKey('ABC')

  await clickKey('Shift')
  await clickKey('Shift')
  await pressAndRelease('q')
  assert.equal((await page.evaluate(() => window.keyboardFixture.inputs())).at(-1), 'Q')
  assert.ok((await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Shift'))
  await clickKey('Shift')

  await clickKey('Ctrl')
  await clickKey('123')
  await clickKey('More')
  await clickKey('More')
  assert.ok((await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Ctrl'))
  await pressAndRelease('1')
  assert.ok(!(await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Ctrl'))
})

test('Copy and Paste use xterm selection/paste without consuming modifiers', async () => {
  await mount()
  await clickKey('Ctrl')
  await page.evaluate(() => { window.keyboardFixture.selection('selected text'); window.keyboardFixture.clipboard('') })
  await clickKey('More')
  await clickKey('Copy')
  await page.waitForFunction(() => navigator.clipboard.text === 'selected text')
  assert.ok((await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Ctrl'))
  await page.evaluate(() => window.keyboardFixture.clipboard('paste text'))
  await clickKey('Paste')
  await page.waitForFunction(() => window.keyboardFixture.pastes().length === 1)
  assert.deepEqual(await page.evaluate(() => window.keyboardFixture.pastes()), ['paste text'])
  assert.ok((await page.$$eval('button[aria-pressed="true"]', buttons => buttons.map(button => button.textContent.trim()))).includes('Ctrl'))
})

test('integrated mode keys and the header control cover Web, Native, and Collapsed states', async () => {
  await mount()
  await clickKey('Ctrl')
  await page.evaluate(() => window.keyboardFixture.reset())
  await page.waitForFunction(() => ![...document.querySelectorAll('button[aria-pressed="true"]')].some(button => button.textContent.trim() === 'Ctrl'))
  await clickKey('Ctrl')
  const nativeButton = await key('Native keyboard')
  const nativeBox = await nativeButton.boundingBox()
  await page.mouse.move(nativeBox.x + nativeBox.width / 2, nativeBox.y + nativeBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(nativeBox.x + nativeBox.width + 30, nativeBox.y + nativeBox.height + 30)
  await page.mouse.up()
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'web')
  await pressAndRelease('Native keyboard')
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'native')
  assert.deepEqual(await page.$eval('#terminal-textarea', element => ({ readOnly: element.readOnly, inputMode: element.inputMode, focused: document.activeElement === element })), { readOnly: false, inputMode: 'text', focused: true })
  assert.equal(await page.$('.terminal-keyboard-footer'), null)
  assert.ok(await page.$('button[aria-label="Show Web keyboard"]'))
  await page.click('button[aria-label="Show Web keyboard"]')
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'web')
  await pressAndRelease('Collapse keyboard')
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'collapsed')
  assert.deepEqual(await page.$eval('#terminal-textarea', element => ({ readOnly: element.readOnly, inputMode: element.inputMode })), { readOnly: true, inputMode: 'none' })
  assert.ok(await page.$('button[aria-label="Show Web keyboard"]'))
  await page.click('button[aria-label="Show Web keyboard"]')
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'web')
})

test('TerminalView keeps xterm onData as the canonical WebSocket input route', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/components/TerminalView.tsx', import.meta.url), 'utf8'))
  assert.match(source, /term\.onData\(\(input\) => \{\s*forwardInput\(input\)/)
  assert.match(source, /<TerminalVirtualKeyboard[\s\S]*terminal=\{terminalInstance\}/)
  const component = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/components/TerminalVirtualKeyboard.tsx', import.meta.url), 'utf8'))
  const styles = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/components/TerminalVirtualKeyboard.css', import.meta.url), 'utf8'))
  assert.match(component, /window\.visualViewport/)
  assert.match(styles, /env\(safe-area-inset-bottom\)/)
  assert.doesNotMatch(styles, /terminal-keyboard-footer/)
  assert.doesNotMatch(styles, /#(?:2563eb|1d4ed8|60a5fa|bfdbfe|0f172a|172033|334155|475569|64748b|94a3b8)/i)
})

test('fine-pointer desktop defaults collapsed without disabling the physical-keyboard textarea', async () => {
  await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.keyboardFixture))
  assert.equal(await page.$eval('[data-terminal-keyboard-mode]', element => element.dataset.terminalKeyboardMode), 'collapsed')
  assert.deepEqual(await page.$eval('#terminal-textarea', element => ({ readOnly: element.readOnly, inputMode: element.inputMode })), { readOnly: false, inputMode: 'text' })
})
