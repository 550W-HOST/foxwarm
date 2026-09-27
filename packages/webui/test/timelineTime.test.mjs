import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

process.env.TZ = 'America/New_York'
const bundle = await build({ entryPoints: [new URL('../src/components/timelineTime.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { deriveTimelineTimeMarkers, formatTimelineTimeMarker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const t = value => Date.parse(value)
const msg = (role, timestamp, extra = {}) => ({ role, parts: [{ text: role }], __meta: { timestamp, ...extra } })
const markers = messages => deriveTimelineTimeMarkers(messages, message => message.parts[0]?.text === 'grouped event')

test('adjacent persisted timestamps use the exact 59,999/60,000ms boundary, not request metadata', () => {
  const first = t('2026-09-26T09:00:00-04:00')
  const legacyRequest = { startedAt: first + 1000, completedAt: first + 8 * 3600_000, durationMs: 8 * 3600_000 - 1000 }
  assert.deepEqual(markers([msg('user', first), msg('model', first + 59_999, { llmRequestTiming: legacyRequest })]), [
    { timestamp: first, laterMs: null }, null,
  ])
  assert.deepEqual(markers([msg('user', first), msg('model', first + 60_000, { llmRequestTiming: legacyRequest })]), [
    { timestamp: first, laterMs: null }, { timestamp: first + 60_000, laterMs: 60_000 },
  ])
})

test('tool/result and grouped event times are adjacent clock boundaries without orphan separator rows', () => {
  const first = t('2026-09-26T09:00:00-04:00')
  assert.deepEqual(markers([
    msg('model', first), msg('user', first + 20 * 60_000, { synthetic: 'temporary-event' }),
    msg('tool', first + 40 * 60_000, { executionTiming: { completedAt: first + 1000 } }),
    msg('model', first + 40 * 60_000 + 59_999), msg('tool', first + 41 * 60_000), msg('model', first + 42 * 60_000),
  ]), [
    { timestamp: first, laterMs: null }, null, null, null, null,
    { timestamp: first + 42 * 60_000, laterMs: 60_000 },
  ])
  const event = msg('user', first + 10 * 60_000)
  event.parts[0].text = 'grouped event'
  assert.deepEqual(markers([msg('model', first), event, msg('tool', first + 11 * 60_000), msg('model', first + 12 * 60_000)]), [
    { timestamp: first, laterMs: null }, null, null, { timestamp: first + 12 * 60_000, laterMs: 60_000 },
  ])
})

test('missing/invalid/negative values never invent elapsed time; temporary rows are ignored', () => {
  const first = t('2026-09-26T09:00:00-04:00')
  assert.deepEqual(markers([
    msg('user', first), msg('user', 'bad'), msg('user', first + 3600_000),
    msg('model', first + 90 * 60_000, { temporary: true }),
    msg('user', first + 2 * 3600_000), msg('model', first + 30 * 60_000),
  ]), [
    { timestamp: first, laterMs: null }, null,
    { timestamp: first + 3600_000, laterMs: null }, null,
    { timestamp: first + 2 * 3600_000, laterMs: 3600_000 },
    { timestamp: first + 30 * 60_000, laterMs: null },
  ])
  assert.equal(markers([msg('user', Number.NaN), msg('user', first)])[1]?.laterMs, null)
})

test('local calendar rollover shows under-minute elapsed; DST spring-forward alone is not a date change', () => {
  const rollover = markers([msg('user', t('2026-09-26T23:59:40-04:00')), msg('model', t('2026-09-27T00:00:10-04:00'))])
  assert.equal(rollover[1]?.laterMs, 30_000)
  const dst = markers([msg('user', t('2026-03-08T01:59:40-05:00')), msg('model', t('2026-03-08T03:00:20-04:00'))])
  assert.equal(dst[1], null)
})

test('English 24-hour local date and at most two nonzero spaced elapsed units', () => {
  const stamp = t('2026-09-26T23:08:00-04:00')
  const today = t('2026-09-27T12:00:00-04:00')
  const detail = formatTimelineTimeMarker({ timestamp: stamp, laterMs: 3 * 3600_000 + 12 * 60_000 }, today)
  assert.equal(detail.text, 'Sep 26, 23:08 · 3h 12m later')
  assert.match(detail.title, /September 26, 2026.*23:08:00.*GMT-4/)
  assert.equal(formatTimelineTimeMarker({ timestamp: today, laterMs: null }, today).text, '12:00')
  assert.equal(formatTimelineTimeMarker({ timestamp: t('2025-12-31T23:59:40-05:00'), laterMs: 20_000 }, today).text, 'Dec 31, 2025, 23:59 · 20s later')
})

test('dense adjacent history yields one initial clock instead of a separator per message', () => {
  const start = t('2026-09-26T09:00:00-04:00')
  const many = Array.from({ length: 1200 }, (_, index) => msg('model', start + index))
  assert.equal(markers(many).filter(Boolean).length, 1)
})
