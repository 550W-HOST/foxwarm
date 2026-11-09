import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/textRedaction.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', define: { 'window.location.pathname': '"/"' } })
const {
  isSentVersion, isUsageRedaction, readTextRedaction, redactionFailureCount, sentVersionSegments, sentVersionSlotLabel,
  summarizeTextRedaction, textRedactionRows,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const turn = (overrides = {}) => ({
  replaced: 3,
  labels: { private_person: { detected: 2, literal: 0 }, private_phone: { detected: 0, literal: 1 } },
  slots: 4,
  cachedSlots: 1,
  detectorCalls: 3,
  detectionMs: 42.4,
  ...overrides,
})

test('turns without redaction show nothing', () => {
  assert.equal(readTextRedaction(undefined), null)
  assert.equal(readTextRedaction({ replaced: -1 }), null)
  assert.equal(readTextRedaction({ ...turn(), labels: { x: { detected: 'a', literal: 0 } } }), null)
  assert.equal(summarizeTextRedaction([null, undefined]), null)
})

test('a turn summary sums its requests with a per-label breakdown and cache share', () => {
  const summary = summarizeTextRedaction([readTextRedaction(turn()), null, readTextRedaction(turn({ replaced: 1, labels: { private_phone: { detected: 1, literal: 0 } }, slots: 4, cachedSlots: 3, detectionMs: 7.6 }))])
  assert.deepEqual(summary.labels, [
    { label: 'private_person', detected: 2, literal: 0 },
    { label: 'private_phone', detected: 1, literal: 1 },
  ])
  assert.deepEqual(textRedactionRows(summary), [
    ['Redacted', '4 · person 2, phone 2'],
    ['Detection', '50ms · 50% cached'],
  ])
  assert.deepEqual(textRedactionRows(summarizeTextRedaction([turn({ replaced: 0, labels: {}, slots: 0, cachedSlots: 0, detectionMs: 1500 })])), [
    ['Redacted', 'None'],
    ['Detection', '1.5s'],
  ])
})

test('usage redaction statistics are validated and failures are totalled', () => {
  const value = { attempts: 2, replacements: 3, detected: 2, literal: 1, labels: { private_person: 3 }, slots: 4, cachedSlots: 1, detectorCalls: 3, detectionMs: 10, failures: { busy: 2, timeout: 1 }, omitted: 0 }
  assert.equal(isUsageRedaction(value), true)
  assert.equal(redactionFailureCount(value), 3)
  assert.equal(isUsageRedaction({ ...value, failures: { busy: -1 } }), false)
  assert.equal(isUsageRedaction({ ...value, labels: undefined }), false)
})

test('sent-version ranges split the text without guessing at invalid ranges', () => {
  const text = 'Call Alice at 138'
  const ranges = [
    { start: 14, length: 3, label: 'private_phone', source: 'detected' },
    { start: 5, length: 5, label: 'private_person', source: 'literal' },
    { start: 6, length: 2, label: 'overlap', source: 'detected' },
    { start: 16, length: 5, label: 'outside', source: 'detected' },
  ]
  assert.deepEqual(sentVersionSegments(text, ranges).map(segment => [segment.text, segment.range?.label]), [
    ['Call ', undefined], ['Alice', 'private_person'], [' at ', undefined], ['138', 'private_phone'],
  ])
  assert.deepEqual(sentVersionSegments('', []), [{ text: '' }])
  assert.equal(sentVersionSlotLabel({ kind: 'argument', path: 'command', name: 'exec' }), 'exec · command')
  assert.equal(sentVersionSlotLabel({ kind: 'output', name: 'exec' }), 'exec · result')
  assert.equal(sentVersionSlotLabel({ kind: 'text' }), 'Text')
})

test('sent-version responses are validated', () => {
  assert.equal(isSentVersion({ enabled: false, seq: 1 }), true)
  assert.equal(isSentVersion({ enabled: true, seq: 1, state: 'unavailable', slots: [{ kind: 'text', part: 0, text: 'x', available: false }] }), true)
  assert.equal(isSentVersion({ enabled: true, seq: 1, state: 'available', slots: [{ kind: 'text', part: 0, text: 'x', available: true, ranges: [{ start: 0, length: 1, label: 'a', source: 'guess' }] }] }), false)
  assert.equal(isSentVersion({ enabled: true, seq: 1, state: 'other', slots: [] }), false)
})
