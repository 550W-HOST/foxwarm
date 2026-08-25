import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/usageTiming.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const {
  deriveRequestTimings,
  formatCompactDuration,
  formatDetailedDuration,
  summarizeDurationSamples,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const model = (timing) => ({
  role: 'model',
  __meta: timing === undefined ? {} : { llmRequestTiming: timing },
})

const timing = (startedAt, completedAt, durationMs = completedAt - startedAt) => ({ startedAt, completedAt, durationMs })

test('request timing derives API latency and the gap around intervening tool work', () => {
  const derived = deriveRequestTimings([
    model(timing(1000, 2000)),
    { role: 'tool' },
    { role: 'user' },
    model(timing(5000, 6500)),
  ])

  assert.deepEqual(derived, [
    { apiDurationMs: 1000, betweenRequestsMs: null },
    { apiDurationMs: null, betweenRequestsMs: null },
    { apiDurationMs: null, betweenRequestsMs: null },
    { apiDurationMs: 1500, betweenRequestsMs: 3000 },
  ])
})

test('missing or invalid model timing breaks the request chain instead of spanning unknown history', () => {
  const derived = deriveRequestTimings([
    model(timing(1000, 2000)),
    model(),
    model(timing(9000, 10000)),
    model({ startedAt: 11000, completedAt: 10000, durationMs: -1 }),
    model(timing(12000, 13000)),
  ])

  assert.deepEqual(derived, [
    { apiDurationMs: 1000, betweenRequestsMs: null },
    { apiDurationMs: null, betweenRequestsMs: null },
    { apiDurationMs: 1000, betweenRequestsMs: null },
    { apiDurationMs: 'invalid', betweenRequestsMs: 'invalid' },
    { apiDurationMs: 1000, betweenRequestsMs: null },
  ])
})

test('overlapping request boundaries are marked invalid without corrupting later API timing', () => {
  assert.deepEqual(deriveRequestTimings([
    model(timing(1000, 3000)),
    model(timing(2500, 4000)),
  ]), [
    { apiDurationMs: 2000, betweenRequestsMs: null },
    { apiDurationMs: 1500, betweenRequestsMs: 'invalid' },
  ])
})

test('compact durations use no more than two non-zero units', () => {
  assert.equal(formatCompactDuration(842), '842ms')
  assert.equal(formatCompactDuration(1000), '1s')
  assert.equal(formatCompactDuration(62_000), '1m2s')
  assert.equal(formatCompactDuration(3_720_000), '1h2m')
  assert.equal(formatCompactDuration(93_600_000), '1d2h')
  assert.equal(formatCompactDuration(90_061_000), '1d1h')
  assert.equal(formatDetailedDuration(62_345), '1m2s (62345ms)')
})

test('duration summaries total valid samples while retaining missing and invalid attribution', () => {
  assert.deepEqual(summarizeDurationSamples([1000, null, 'invalid', 2500]), {
    totalMs: 3500,
    unavailableCount: 1,
    invalidCount: 1,
  })
  assert.deepEqual(summarizeDurationSamples([null]), {
    totalMs: null,
    unavailableCount: 1,
    invalidCount: 0,
  })
})
