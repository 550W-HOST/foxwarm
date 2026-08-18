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
