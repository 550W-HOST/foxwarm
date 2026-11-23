import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { reduceSelectKey, stepEnabledIndex, typeaheadIndex } = await (async () => {
  const result = await build({
    entryPoints: [new URL('../src/components/selectKeyboard.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
})()

const options = [
  { label: 'Agent' },
  { label: 'Session' },
  { label: 'Model' },
  { label: 'Maintenance', disabled: true },
  { label: 'Memory' },
  { label: 'Purpose' },
]
const closed = { open: false, active: -1, selected: 1, typeahead: '' }
const opened = active => ({ open: true, active, selected: 1, typeahead: '' })
const key = (state, value, extra = {}) => reduceSelectKey(state, { key: value, ...extra }, options)

test('opening keys open the list on the current option, or the first or last one', () => {
  for (const value of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
    assert.deepEqual(key(closed, value), { open: true, active: 1, typeahead: '', handled: true }, value)
  }
  assert.equal(key(closed, 'Home').active, 0)
  assert.equal(key(closed, 'End').active, 5)
  assert.equal(key({ ...closed, selected: -1 }, 'ArrowDown').active, 0)
  // Keys that do not belong to the Select pass through while it is closed.
  for (const value of ['Escape', 'Tab', 'ArrowLeft']) assert.equal(key(closed, value).handled, false, value)
  assert.equal(key(closed, 'a', { ctrlKey: true }).handled, false)
})

test('arrow, page and edge keys move the active option and skip disabled options without wrapping', () => {
  assert.equal(key(opened(2), 'ArrowDown').active, 4)
  assert.equal(key(opened(4), 'ArrowUp').active, 2)
  assert.equal(key(opened(5), 'ArrowDown').active, 5)
  assert.equal(key(opened(0), 'ArrowUp').active, 0)
  assert.equal(key(opened(0), 'PageDown').active, 5)
  assert.equal(key(opened(5), 'PageUp').active, 0)
  assert.equal(key(opened(3), 'Home').active, 0)
  assert.equal(key(opened(0), 'End').active, 5)
  assert.ok(key(opened(0), 'ArrowDown').handled)
  const lastDisabled = [{ label: 'One' }, { label: 'Two', disabled: true }]
  assert.equal(stepEnabledIndex(lastDisabled, 0, 1), 0)
  assert.equal(stepEnabledIndex(lastDisabled, 0, 10), 0)
  assert.equal(stepEnabledIndex([{ label: 'a', disabled: true }], -1, 1), -1)
})

test('Enter, Space and Alt+ArrowUp choose the active option; Escape and Tab close without a change', () => {
  assert.deepEqual(key(opened(4), 'Enter'), { open: false, active: -1, typeahead: '', commit: 4, handled: true })
  assert.deepEqual(key(opened(4), ' '), { open: false, active: -1, typeahead: '', commit: 4, handled: true })
  assert.equal(key(opened(2), 'ArrowUp', { altKey: true }).commit, 2)
  assert.deepEqual(key(opened(4), 'Escape'), { open: false, active: -1, typeahead: '', handled: true })
  // Tab is not handled, so focus moves on as usual.
  assert.deepEqual(key(opened(4), 'Tab'), { open: false, active: -1, typeahead: '', handled: false })
  assert.equal(key(opened(3), 'Enter').commit, undefined)
})

test('type-ahead matches label prefixes, cycles on a repeated character and skips disabled options', () => {
  assert.equal(typeaheadIndex(options, 'm', 1), 2)
  assert.equal(typeaheadIndex(options, 'mm', 2), 4)
  assert.equal(typeaheadIndex(options, 'mmm', 4), 2)
  assert.equal(typeaheadIndex(options, 'me', 2), 4)
  assert.equal(typeaheadIndex(options, 'MO', 0), 2)
  assert.equal(typeaheadIndex(options, 'x', 0), -1)

  let state = opened(0)
  let result = key(state, 'm')
  assert.deepEqual([result.open, result.active, result.typeahead, result.handled], [true, 2, 'm', true])
  state = { ...state, active: result.active, typeahead: result.typeahead }
  result = key(state, 'e')
  assert.deepEqual([result.active, result.typeahead], [4, 'me'])
  // Space continues a search in progress instead of choosing.
  result = reduceSelectKey({ open: true, active: 0, selected: 0, typeahead: 'a' }, { key: ' ' }, [{ label: 'a b' }, { label: 'a c' }])
  assert.deepEqual([result.open, result.commit, result.typeahead], [true, undefined, 'a '])
  // A printable key opens a closed Select on its match; without one, on the current option.
  assert.deepEqual([key(closed, 'p').open, key(closed, 'p').active], [true, 5])
  assert.equal(key(closed, 'z').active, 1)
})
