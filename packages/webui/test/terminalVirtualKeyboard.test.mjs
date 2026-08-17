import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadModule() {
  const result = await build({
    entryPoints: [new URL('../src/terminalVirtualKeyboard.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const modes = applicationCursorKeysMode => ({ applicationCursorKeysMode })
const mods = (ctrl = false, alt = false, shift = false) => ({ ctrl, alt, shift })

test('printable keys apply visible Shift, Ctrl control bytes, and Alt prefixes', async () => {
  const { encodeTerminalVirtualKey } = await loadModule()
  assert.equal(encodeTerminalVirtualKey({ kind: 'printable', value: 'a' }, mods(), modes(false)), 'a')
  assert.equal(encodeTerminalVirtualKey({ kind: 'printable', value: 'A' }, mods(false, false, true), modes(false)), 'A')
  assert.equal(encodeTerminalVirtualKey({ kind: 'printable', value: 'A' }, mods(true, false, true), modes(false)), '\x01')
  assert.equal(encodeTerminalVirtualKey({ kind: 'printable', value: '[' }, mods(true, true), modes(false)), '\x1b\x1b')
  assert.equal(encodeTerminalVirtualKey({ kind: 'printable', value: '?' }, mods(true, false), modes(false)), '\x7f')
})

test('cursor keys honor application mode only when unmodified and encode combined modifiers', async () => {
  const { encodeTerminalVirtualKey } = await loadModule()
  const up = { kind: 'special', value: 'ArrowUp' }
  assert.equal(encodeTerminalVirtualKey(up, mods(), modes(false)), '\x1b[A')
  assert.equal(encodeTerminalVirtualKey(up, mods(), modes(true)), '\x1bOA')
  assert.equal(encodeTerminalVirtualKey(up, mods(true, true, true), modes(true)), '\x1b[1;8A')
  assert.equal(encodeTerminalVirtualKey({ kind: 'special', value: 'Home' }, mods(false, true), modes(false)), '\x1b[1;3H')
})

test('navigation, editing, tab, backspace, enter, escape, and F1-F12 use VT sequences', async () => {
  const { encodeTerminalVirtualKey } = await loadModule()
  const encode = (value, modifiers = mods()) => encodeTerminalVirtualKey({ kind: 'special', value }, modifiers, modes(false))
  assert.equal(encode('PageUp'), '\x1b[5~')
  assert.equal(encode('PageDown', mods(true)), '\x1b[6;5~')
  assert.equal(encode('Insert', mods(false, true, true)), '\x1b[2;4~')
  assert.equal(encode('Delete', mods(true, true, true)), '\x1b[3;8~')
  assert.equal(encode('Tab', mods(false, false, true)), '\x1b[Z')
  assert.equal(encode('Backspace', mods(true, true)), '\x1b\x08')
  assert.equal(encode('Enter', mods(false, true)), '\x1b\r')
  assert.equal(encode('Escape', mods(false, true)), '\x1b\x1b')
  const expected = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~']
  assert.deepEqual(Array.from({ length: 12 }, (_, index) => encode(`F${index + 1}`)), expected)
  assert.equal(encode('F1', mods(true, true, true)), '\x1b[1;8P')
  assert.equal(encode('F12', mods(true, true, true)), '\x1b[24;8~')
})

test('Shift state supports one-shot, double-tap lock, slow cancel, and locked unlock', async () => {
  const { nextShiftState, TERMINAL_SHIFT_DOUBLE_TAP_MS } = await loadModule()
  assert.equal(nextShiftState('off', 0), 'armed')
  assert.equal(nextShiftState('armed', TERMINAL_SHIFT_DOUBLE_TAP_MS), 'locked')
  assert.equal(nextShiftState('armed', TERMINAL_SHIFT_DOUBLE_TAP_MS + 1), 'off')
  assert.equal(nextShiftState('locked', 0), 'off')
})

test('mobile defaults to Web while desktop defaults collapsed and persisted modes win', async () => {
  const { defaultTerminalKeyboardMode, loadTerminalKeyboardMode } = await loadModule()
  assert.equal(defaultTerminalKeyboardMode(true), 'web')
  assert.equal(defaultTerminalKeyboardMode(false), 'collapsed')
  assert.equal(loadTerminalKeyboardMode({ getItem: () => 'native' }, true), 'native')
  assert.equal(loadTerminalKeyboardMode({ getItem: () => null }, true), 'web')
})

test('only the approved editing and navigation keys repeat', async () => {
  const { REPEATING_TERMINAL_KEYS } = await loadModule()
  assert.deepEqual([...REPEATING_TERMINAL_KEYS], ['Backspace', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'PageUp', 'PageDown'])
})

test('native header control offset uses only local pane overlap with the visible viewport', async () => {
  const { terminalKeyboardViewportOverlap } = await loadModule()
  assert.equal(terminalKeyboardViewportOverlap(420, 500), 0)
  assert.equal(terminalKeyboardViewportOverlap(500, 500), 0)
  assert.equal(terminalKeyboardViewportOverlap(575, 500), 75)
  assert.equal(terminalKeyboardViewportOverlap(900, 500), 400)
})
