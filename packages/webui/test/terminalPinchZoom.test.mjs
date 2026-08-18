import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadModule() {
  const result = await build({
    entryPoints: [new URL('../src/terminalPinchZoom.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

class FakeTouchTarget {
  listeners = new Map()

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type)
  }

  dispatch(type, touches) {
    const event = {
      touches,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true },
      stopPropagation() { this.stopped = true },
    }
    this.listeners.get(type)?.(event)
    return event
  }
}

const points = distance => [
  { clientX: 0, clientY: 0 },
  { clientX: distance, clientY: 0 },
]

class FakeStorage {
  values = new Map()
  writes = []

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  setItem(key, value) {
    this.values.set(key, value)
    this.writes.push([key, value])
  }
}

test('global font preference loads, rounds, clamps to 5–24px, and persists safely', async () => {
  const {
    clampTerminalFontSize,
    loadTerminalFontSize,
    persistTerminalFontSize,
    TERMINAL_DEFAULT_FONT_SIZE,
    TERMINAL_FONT_SIZE_STORAGE_KEY,
  } = await loadModule()
  const storage = new FakeStorage()

  assert.equal(loadTerminalFontSize(storage), TERMINAL_DEFAULT_FONT_SIZE)
  storage.values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, '')
  assert.equal(loadTerminalFontSize(storage), TERMINAL_DEFAULT_FONT_SIZE)
  storage.values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, '12.3')
  assert.equal(loadTerminalFontSize(storage), 12.5)
  storage.values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, '-4')
  assert.equal(loadTerminalFontSize(storage), 5)
  storage.values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, '80')
  assert.equal(loadTerminalFontSize(storage), 24)
  storage.values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, 'not-a-number')
  assert.equal(loadTerminalFontSize(storage), TERMINAL_DEFAULT_FONT_SIZE)
  assert.equal(clampTerminalFontSize(Infinity), TERMINAL_DEFAULT_FONT_SIZE)

  assert.equal(persistTerminalFontSize(storage, 7.24), true)
  assert.deepEqual(storage.writes.at(-1), [TERMINAL_FONT_SIZE_STORAGE_KEY, '7'])
})

test('desktop Ctrl physical Minus and Equal map to one-pixel steps only', async () => {
  const { terminalFontSizeShortcutDelta } = await loadModule()
  const event = (overrides = {}) => ({ type: 'keydown', code: 'Minus', ctrlKey: true, altKey: false, metaKey: false, ...overrides })

  assert.equal(terminalFontSizeShortcutDelta(event()), -1)
  assert.equal(terminalFontSizeShortcutDelta(event({ code: 'Equal' })), 1)
  assert.equal(terminalFontSizeShortcutDelta(event({ type: 'keyup' })), null)
  assert.equal(terminalFontSizeShortcutDelta(event({ ctrlKey: false })), null)
  assert.equal(terminalFontSizeShortcutDelta(event({ altKey: true })), null)
  assert.equal(terminalFontSizeShortcutDelta(event({ metaKey: true })), null)
  assert.equal(terminalFontSizeShortcutDelta(event({ code: 'Digit0' })), null)
})

test('pinch distance and font calculation zoom in/out from the gesture baseline and clamp', async () => {
  const {
    terminalPinchDistance,
    terminalPinchFontSize,
    TERMINAL_PINCH_MIN_FONT_SIZE,
    TERMINAL_PINCH_MAX_FONT_SIZE,
  } = await loadModule()

  assert.equal(terminalPinchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }), 5)
  assert.equal(terminalPinchFontSize(14, 100, 150), 21)
  assert.equal(terminalPinchFontSize(14, 100, 75), 10.5)
  assert.equal(terminalPinchFontSize(14, 100, 20), TERMINAL_PINCH_MIN_FONT_SIZE)
  assert.equal(terminalPinchFontSize(14, 100, 300), TERMINAL_PINCH_MAX_FONT_SIZE)
  assert.equal(terminalPinchFontSize(14, 0, 200), 14)
})

test('two-touch movement coalesces exact option updates and refits while single touch is untouched', async () => {
  const { attachTerminalPinchZoom } = await loadModule()
  const target = new FakeTouchTarget()
  let fontSize = 14
  const updates = []
  let refits = 0
  let frameCallback = null
  let requestedFrames = 0

  const dispose = attachTerminalPinchZoom({
    target,
    getFontSize: () => fontSize,
    setFontSize: value => { fontSize = value; updates.push(value) },
    refit: () => { refits += 1 },
    requestFrame: callback => { requestedFrames += 1; frameCallback = callback; return requestedFrames },
    cancelFrame: () => { frameCallback = null },
  })

  const singleStart = target.dispatch('touchstart', points(0).slice(0, 1))
  const singleMove = target.dispatch('touchmove', points(20).slice(0, 1))
  assert.equal(singleStart.prevented, false)
  assert.equal(singleStart.stopped, false)
  assert.equal(singleMove.prevented, false)
  assert.equal(singleMove.stopped, false)
  assert.deepEqual(updates, [])

  const pinchStart = target.dispatch('touchstart', points(100))
  const firstMove = target.dispatch('touchmove', points(140))
  const secondMove = target.dispatch('touchmove', points(160))
  assert.equal(pinchStart.prevented, true)
  assert.equal(pinchStart.stopped, true)
  assert.equal(firstMove.prevented, true)
  assert.equal(firstMove.stopped, true)
  assert.equal(secondMove.prevented, true)
  assert.equal(secondMove.stopped, true)
  assert.equal(requestedFrames, 1)
  assert.deepEqual(updates, [])

  frameCallback(0)
  assert.deepEqual(updates, [22.5])
  assert.equal(fontSize, 22.5)
  assert.equal(refits, 1)

  const end = target.dispatch('touchend', points(0).slice(0, 1))
  assert.equal(end.prevented, false)
  assert.equal(end.stopped, true)
  assert.deepEqual(updates, [22.5])

  dispose()
  assert.equal(target.listeners.size, 0)
})

test('unexpected third touch and disposal cancel pending work without browser interception', async () => {
  const { attachTerminalPinchZoom } = await loadModule()
  const target = new FakeTouchTarget()
  const updates = []
  let frameCallback = null

  const dispose = attachTerminalPinchZoom({
    target,
    getFontSize: () => 14,
    setFontSize: value => updates.push(value),
    refit: () => updates.push('refit'),
    requestFrame: callback => { frameCallback = callback; return 1 },
    cancelFrame: () => { frameCallback = null },
  })

  target.dispatch('touchstart', points(100))
  target.dispatch('touchmove', points(150))
  const thirdTouch = target.dispatch('touchmove', [...points(150), { clientX: 75, clientY: 30 }])
  assert.equal(thirdTouch.prevented, false)
  assert.equal(thirdTouch.stopped, true)
  assert.equal(frameCallback, null)
  assert.deepEqual(updates, [])

  target.dispatch('touchstart', points(100))
  target.dispatch('touchmove', points(150))
  dispose()
  assert.equal(frameCallback, null)
  assert.deepEqual(updates, [])
})
