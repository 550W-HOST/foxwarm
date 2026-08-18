import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const pinchEntry = new URL('../src/terminalPinchZoom.ts', import.meta.url).pathname
const xtermEntry = new URL('../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url).pathname
const fitAddonEntry = new URL('../node_modules/@xterm/addon-fit/lib/addon-fit.mjs', import.meta.url).pathname
const xtermCssEntry = new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url).pathname
let browser
let page
let client
let server
let fixtureUrl

before(async () => {
  const source = `
    import {
      attachTerminalPinchZoom,
      clampTerminalFontSize,
      loadTerminalFontSize,
      persistTerminalFontSize,
      terminalFontSizeShortcutDelta,
      TERMINAL_DEFAULT_FONT_SIZE,
    } from ${JSON.stringify(pinchEntry)}
    import { Terminal } from ${JSON.stringify(xtermEntry)}
    import { FitAddon } from ${JSON.stringify(fitAddonEntry)}
    import ${JSON.stringify(xtermCssEntry)}
    const target = document.getElementById('terminal')
    const controlTarget = document.getElementById('control-terminal')
    const otherTarget = document.getElementById('other-terminal')
    const initialFontSize = loadTerminalFontSize(localStorage)
    const terminal = new Terminal({ fontSize: initialFontSize, scrollback: 500, theme: { background: '#111111' } })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(target)
    fitAddon.fit()
    const controlTerminal = new Terminal({ fontSize: initialFontSize, scrollback: 500, theme: { background: '#111111' } })
    const controlFitAddon = new FitAddon()
    controlTerminal.loadAddon(controlFitAddon)
    controlTerminal.open(controlTarget)
    controlFitAddon.fit()
    const otherTerminal = new Terminal({ fontSize: initialFontSize, scrollback: 500, theme: { background: '#111111' } })
    otherTerminal.open(otherTarget)
    const state = { updates: [], refits: 0, moves: [], keyEvents: [], data: [], persists: 0, ready: false }
    const save = value => {
      if (persistTerminalFontSize(localStorage, value)) state.persists += 1
    }
    const applyShortcutSize = value => {
      const next = clampTerminalFontSize(value)
      const current = clampTerminalFontSize(terminal.options.fontSize ?? TERMINAL_DEFAULT_FONT_SIZE)
      if (next === current) return false
      terminal.options.fontSize = next
      save(next)
      fitAddon.fit()
      state.refits += 1
      return true
    }
    terminal.attachCustomKeyEventHandler(event => {
      const delta = terminalFontSizeShortcutDelta(event)
      if (delta === null) return true
      event.preventDefault()
      applyShortcutSize((terminal.options.fontSize ?? TERMINAL_DEFAULT_FONT_SIZE) + delta)
      return false
    })
    terminal.onData(data => state.data.push(data))
    terminal.element.querySelector('textarea').addEventListener('keydown', event => {
      state.keyEvents.push({ code: event.code, prevented: event.defaultPrevented })
    })
    const dispose = attachTerminalPinchZoom({
      target,
      getFontSize: () => terminal.options.fontSize,
      setFontSize: value => {
        const next = clampTerminalFontSize(value)
        if (next === terminal.options.fontSize) return false
        terminal.options.fontSize = next
        controlTerminal.options.fontSize = next
        save(next)
        state.updates.push(next)
        return true
      },
      refit: () => { fitAddon.fit(); controlFitAddon.fit(); state.refits += 1 },
    })
    target.addEventListener('touchmove', event => {
      state.moves.push({ touches: event.touches.length, prevented: event.defaultPrevented })
    }, { passive: false })
    const content = Array.from({ length: 220 }, (_, index) => 'scrollback-line-' + index).join('\\r\\n')
    let readyCount = 0
    const markReady = () => {
      readyCount += 1
      if (readyCount === 2) {
        terminal.scrollToLine(80)
        controlTerminal.scrollToLine(80)
        state.ready = true
      }
    }
    terminal.write(content, markReady)
    controlTerminal.write(content, markReady)
    window.pinchFixture = {
      terminal,
      controlTerminal,
      otherTerminal,
      state,
      dispose,
      fitAddon,
      controlFitAddon,
      resetTracking: () => {
        state.updates.length = 0
        state.refits = 0
        state.keyEvents.length = 0
        state.data.length = 0
        state.persists = 0
      },
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'terminal-pinch-fixture.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outdir: 'out',
    write: false,
    logLevel: 'silent',
  })
  const script = result.outputFiles.find(file => file.path.endsWith('.js'))?.text || ''
  const styles = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || ''
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>${styles}\nbody{margin:0}#terminal,#control-terminal,#other-terminal{width:390px;height:700px;background:#111}#control-terminal,#other-terminal{position:absolute;left:-1000px;top:0}</style></head><body><script>if(localStorage.getItem('foxwarm.terminal.fontSize')===null)localStorage.setItem('foxwarm.terminal.fontSize','12')</script><div id="terminal"></div><div id="control-terminal"></div><div id="other-terminal"></div><script>${script}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  client = await page.createCDPSession()
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

const touchPoint = (id, x, y = 200) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 })

async function touch(type, touchPoints) {
  await client.send('Input.dispatchTouchEvent', { type, touchPoints })
}

async function startPinch(left, right, y = 200) {
  await touch('touchStart', [touchPoint(1, left, y), touchPoint(2, right, y)])
}

async function movePinch(left, right, y = 200) {
  await touch('touchMove', [touchPoint(1, left, y), touchPoint(2, right, y)])
}

async function endTouches() {
  await touch('touchEnd', [])
}

async function ctrlKey(code, key, windowsVirtualKeyCode) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers: 2, windowsVirtualKeyCode })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers: 2, windowsVirtualKeyCode })
}

test('actual xterm pinch changes font/refits without terminal gesture drift and later one-touch scroll still works', async (context) => {
  const consoleMessages = []
  const onConsole = message => consoleMessages.push(message.text())
  page.on('console', onConsole)
  context.after(() => page.off('console', onConsole))
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.pinchFixture?.state.ready)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    controlFontSize: window.pinchFixture.controlTerminal.options.fontSize,
    otherFontSize: window.pinchFixture.otherTerminal.options.fontSize,
  })), { fontSize: 12, controlFontSize: 12, otherFontSize: 12 })

  await startPinch(100, 200, 240)
  await movePinch(75, 225, 320)
  await page.waitForFunction(() => window.pinchFixture.terminal.options.fontSize === 18)
  await endTouches()
  await new Promise(resolve => setTimeout(resolve, 150))
  const afterPinch = await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    updates: window.pinchFixture.state.updates,
    refits: window.pinchFixture.state.refits,
    lastMove: window.pinchFixture.state.moves.at(-1),
    viewportY: window.pinchFixture.terminal.buffer.active.viewportY,
    selection: window.pinchFixture.terminal.getSelection(),
    controlViewportY: window.pinchFixture.controlTerminal.buffer.active.viewportY,
    controlSelection: window.pinchFixture.controlTerminal.getSelection(),
    otherFontSize: window.pinchFixture.otherTerminal.options.fontSize,
    storedFontSize: localStorage.getItem('foxwarm.terminal.fontSize'),
    persists: window.pinchFixture.state.persists,
  }))
  assert.equal(afterPinch.fontSize, 18)
  assert.deepEqual(afterPinch.updates, [18])
  assert.equal(afterPinch.refits, 1)
  assert.deepEqual(afterPinch.lastMove, { touches: 2, prevented: true })
  assert.equal(afterPinch.viewportY, afterPinch.controlViewportY)
  assert.equal(afterPinch.selection, afterPinch.controlSelection)
  assert.equal(afterPinch.selection, '')
  assert.equal(afterPinch.otherFontSize, 12)
  assert.equal(afterPinch.storedFontSize, '18')
  assert.equal(afterPinch.persists, 1)

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.pinchFixture?.state.ready)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    otherFontSize: window.pinchFixture.otherTerminal.options.fontSize,
    storedFontSize: localStorage.getItem('foxwarm.terminal.fontSize'),
  })), { fontSize: 18, otherFontSize: 18, storedFontSize: '18' })

  await startPinch(100, 200)
  await movePinch(40, 340)
  await page.waitForFunction(() => window.pinchFixture.terminal.options.fontSize === 24)
  await endTouches()

  await page.evaluate(() => { window.pinchFixture.resetTracking(); window.pinchFixture.terminal.focus() })
  await ctrlKey('Equal', '=', 187)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    refits: window.pinchFixture.state.refits,
    persists: window.pinchFixture.state.persists,
    data: window.pinchFixture.state.data,
    keyEvent: window.pinchFixture.state.keyEvents.at(-1),
  })), { fontSize: 24, refits: 0, persists: 0, data: [], keyEvent: { code: 'Equal', prevented: true } })

  await ctrlKey('Minus', '-', 189)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    storedFontSize: localStorage.getItem('foxwarm.terminal.fontSize'),
    refits: window.pinchFixture.state.refits,
    persists: window.pinchFixture.state.persists,
    data: window.pinchFixture.state.data,
    otherFontSize: window.pinchFixture.otherTerminal.options.fontSize,
  })), { fontSize: 23, storedFontSize: '23', refits: 1, persists: 1, data: [], otherFontSize: 18 })

  await ctrlKey('Equal', '=', 187)
  assert.equal(await page.evaluate(() => window.pinchFixture.terminal.options.fontSize), 24)

  await startPinch(80, 280)
  await movePinch(160, 200)
  await page.waitForFunction(() => window.pinchFixture.terminal.options.fontSize === 5)
  await endTouches()

  await page.evaluate(() => { window.pinchFixture.resetTracking(); window.pinchFixture.terminal.focus() })
  await ctrlKey('Minus', '-', 189)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    refits: window.pinchFixture.state.refits,
    persists: window.pinchFixture.state.persists,
    data: window.pinchFixture.state.data,
    keyEvent: window.pinchFixture.state.keyEvents.at(-1),
  })), { fontSize: 5, refits: 0, persists: 0, data: [], keyEvent: { code: 'Minus', prevented: true } })

  await ctrlKey('Equal', '=', 187)
  assert.deepEqual(await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    storedFontSize: localStorage.getItem('foxwarm.terminal.fontSize'),
    refits: window.pinchFixture.state.refits,
    persists: window.pinchFixture.state.persists,
    data: window.pinchFixture.state.data,
    otherFontSize: window.pinchFixture.otherTerminal.options.fontSize,
  })), { fontSize: 6, storedFontSize: '6', refits: 1, persists: 1, data: [], otherFontSize: 18 })

  await page.evaluate(() => {
    window.pinchFixture.terminal.scrollToTop()
    window.pinchFixture.controlTerminal.scrollToTop()
  })
  const viewportBeforeSingle = await page.evaluate(() => window.pinchFixture.terminal.buffer.active.viewportY)
  const controlViewportBeforeSingle = await page.evaluate(() => window.pinchFixture.controlTerminal.buffer.active.viewportY)
  const beforeSingle = await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    refits: window.pinchFixture.state.refits,
  }))
  await touch('touchStart', [touchPoint(1, 160, 400)])
  await touch('touchMove', [touchPoint(1, 160, 380)])
  await endTouches()
  await new Promise(resolve => setTimeout(resolve, 50))
  const afterSingle = await page.evaluate(() => ({
    fontSize: window.pinchFixture.terminal.options.fontSize,
    refits: window.pinchFixture.state.refits,
    lastMove: window.pinchFixture.state.moves.at(-1),
    viewportY: window.pinchFixture.terminal.buffer.active.viewportY,
    selection: window.pinchFixture.terminal.getSelection(),
  }))
  assert.equal(afterSingle.fontSize, beforeSingle.fontSize)
  assert.equal(afterSingle.refits, beforeSingle.refits)
  assert.deepEqual(afterSingle.lastMove, { touches: 1, prevented: false })
  assert.equal(afterSingle.viewportY, viewportBeforeSingle)
  assert.equal(afterSingle.selection, '')
  assert.equal(await page.evaluate(() => window.pinchFixture.controlTerminal.buffer.active.viewportY), controlViewportBeforeSingle)

  await client.send('Input.synthesizeScrollGesture', {
    x: 160,
    y: 400,
    yDistance: -240,
    speed: 800,
    sourceType: 'touch',
  })
  await page.waitForFunction(viewportY => window.pinchFixture.terminal.buffer.active.viewportY !== viewportY, {}, viewportBeforeSingle)
  assert.notEqual(await page.evaluate(() => window.pinchFixture.terminal.buffer.active.viewportY), viewportBeforeSingle)
  assert.equal(consoleMessages.some(message => message.includes('UNKNOWN touch')), false)

  const terminalViewSource = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/components/TerminalView.tsx', import.meta.url), 'utf8'))
  assert.match(terminalViewSource, /attachTerminalPinchZoom\(\{[\s\S]*target: hostRef\.current/)
  assert.match(terminalViewSource, /fontSize: initialFontSize/)
  assert.match(terminalViewSource, /term\.attachCustomKeyEventHandler/)
  assert.match(terminalViewSource, /term\.options\.fontSize = nextFontSize/)
  assert.match(terminalViewSource, /persistTerminalFontSize\(terminalStorage, nextFontSize\)/)
  assert.match(terminalViewSource, /refit: fitAndNotifyResize/)
})
