import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Local-time boundaries are the contract; pin a zone with daylight saving changes.
process.env.TZ = 'America/New_York'
globalThis.window = { location: { pathname: '/foxwarm/' } }

const sourcePath = new URL('../src/usageOverview.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { usageRange, usageQuery, usageSeries, usageGroupLabel, usageGroupDetail, parseDateInput, msUntilNextDay } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const local = (...parts) => new Date(...parts).getTime()
const totals = (requests, cost, tokens = 0) => ({ requests, cachedTokens: 0, inputTokens: tokens, outputTokens: 0, unpricedRequests: 0, ...(cost === undefined ? {} : { cost }) })

test('periods use local calendar boundaries with Monday weeks', () => {
  const now = new Date(2026, 10, 8, 15, 30) // Sunday
  const today = usageRange('today', now)
  assert.equal(today.unit, 'hour')
  assert.equal(today.boundaries.length, 25)
  assert.equal(today.boundaries[0], local(2026, 10, 8))
  assert.equal(today.boundaries[24], local(2026, 10, 9))
  const week = usageRange('week', now)
  assert.deepEqual([week.unit, week.boundaries.length, week.boundaries[0], week.boundaries[7]], ['day', 8, local(2026, 10, 2), local(2026, 10, 9)])
  const month = usageRange('month', now)
  assert.deepEqual([month.boundaries.length, month.boundaries[0], month.boundaries[30]], [31, local(2026, 10, 1), local(2026, 11, 1)])
  assert.equal(msUntilNextDay(now), local(2026, 10, 9) - now.getTime())
})

test('daylight saving days keep strictly increasing boundaries', () => {
  const spring = usageRange('today', new Date(2026, 2, 8, 12)).boundaries
  assert.equal(spring.length, 24)
  assert.ok(spring.every((value, index) => index === 0 || value > spring[index - 1]))
  const fall = usageRange('month', new Date(2026, 10, 1, 12)).boundaries
  assert.equal(fall[1] - fall[0], 25 * 3_600_000)
})

test('custom ranges include both dates and reject invalid or oversized ranges', () => {
  const range = usageRange('custom', new Date(), { from: '2026-02-27', to: '2026-03-02' })
  assert.deepEqual(range.boundaries, [local(2026, 1, 27), local(2026, 1, 28), local(2026, 2, 1), local(2026, 2, 2), local(2026, 2, 3)])
  assert.equal(usageRange('custom', new Date(), { from: '2026-03-02', to: '2026-03-01' }), null)
  assert.equal(usageRange('custom', new Date(), { from: '2025-01-01', to: '2026-03-01' }), null)
  assert.equal(usageRange('custom', new Date(), { from: '2026-02-30', to: '2026-03-01' }), null)
  assert.equal(parseDateInput('2026-2-1'), null)
  assert.equal(usageRange('custom', new Date(), { from: '2025-02-01', to: '2026-03-07' }).boundaries.length, 401)
  assert.equal(usageRange('custom', new Date(), { from: '2025-02-01', to: '2026-03-08' }), null)
})

test('queries carry boundaries, grouping, Agent and limit under the deployment base path', () => {
  const url = new URL(usageQuery({ unit: 'day', boundaries: [1, 2, 3] }, { groupBy: 'tree', agent: 'a b', limit: 50 }), 'http://host')
  assert.equal(url.pathname, '/foxwarm/api/usage')
  assert.deepEqual(Object.fromEntries(url.searchParams), { boundaries: '1,2,3', groupBy: 'tree', agent: 'a b', limit: '50' })
  assert.equal(new URL(usageQuery({ unit: 'day', boundaries: [1, 2] }), 'http://host').search, '?boundaries=1%2C2')
})

test('chart series keep top groups and an Other remainder without float noise', () => {
  const report = {
    boundaries: [0, 1, 2], buckets: [totals(3, 0.3, 30), totals(2, 0.2, 20)], total: totals(5, 0.5, 50),
    groups: [
      { key: 'a', kind: 'agent', usage: totals(2, 0.1 + 0.2, 20), buckets: [totals(2, 0.1 + 0.2, 20), totals(0, undefined)] },
      { key: 'b', kind: 'agent', usage: totals(3, 0.2, 30), buckets: [totals(0, undefined), totals(2, 0.2, 10)] },
      { key: 'c', kind: 'agent', usage: totals(0, 0, 20) },
    ],
  }
  const cost = usageSeries(report, 'cost')
  assert.deepEqual(cost.map(item => item.id), ['agent:a', 'agent:b'])
  const tokens = usageSeries(report, 'tokens')
  assert.deepEqual(tokens.map(item => [item.id, item.values]), [['agent:a', [20, 0]], ['agent:b', [0, 10]], ['other', [10, 10]]])
  assert.deepEqual(usageSeries({ ...report, groups: undefined }, 'tokens'), [{ id: 'total', label: 'Total', values: [30, 20] }])
})

test('group labels name special groups and keep technical keys as detail', () => {
  assert.equal(usageGroupLabel({ key: null, kind: 'none' }), 'Outside sessions')
  assert.equal(usageGroupLabel({ key: '', kind: 'unknown' }), 'Unattributed sessions')
  assert.equal(usageGroupLabel({ key: 'main', kind: 'deleted', agent: 'main' }), 'Deleted sessions')
  assert.equal(usageGroupDetail({ key: 'main', kind: 'deleted', agent: 'main' }), 'main')
  assert.equal(usageGroupLabel({ key: 'compact-plan', kind: 'purpose' }), 'Context compaction')
  assert.equal(usageGroupDetail({ key: 'compact-plan', kind: 'purpose' }), 'compact-plan')
  assert.equal(usageGroupLabel({ key: 'future-purpose', kind: 'purpose' }), 'future-purpose')
  assert.equal(usageGroupLabel({ key: 'main/x1', kind: 'tree', label: 'Release work', agent: 'main' }), 'Release work')
  assert.equal(usageGroupDetail({ key: 'main/x1', kind: 'tree', label: 'Release work', agent: 'main' }), 'main/x1')
  assert.equal(usageGroupLabel({ key: 'main/x1', kind: 'session', agent: 'main' }), 'main/x1')
  assert.equal(usageGroupDetail({ key: 'main/x1', kind: 'session', agent: 'main' }), 'main')
})
