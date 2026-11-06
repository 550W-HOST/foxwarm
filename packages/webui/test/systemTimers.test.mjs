import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/systemTimers.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { buildTimerUpdate, filterTimers, orderTimers, timerOwnerAgent, timerState, timerSummary, timerTarget } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const timers = [
  { id: 'a', sessionId: 'lead', message: 'Daily report', cron: '0 9 * * *', mode: 'cron', nextRunAt: 3000, paused: false, recentRuns: [{ at: 1, outcome: 'delivered' }] },
  { id: 'b', sessionId: 'research/scan', action: 'toolscript', script: { filePath: 'checks/disk.py', node: 'linux' }, cron: '*/5 * * * *', mode: 'cron', nextRunAt: 2000, paused: false, recentRuns: [{ at: 2, outcome: 'failed', error: 'boom' }] },
  { id: 'c', sessionId: 'lead', message: 'One-off', at: 5000, mode: 'once', nextRunAt: null, paused: true, newSession: true, agentName: 'research', sessionPrefix: 'nightly' },
  { id: 'd', sessionId: 'lead', action: 'toolscript', script: { code: '# check\nresult = probe()\n' }, cron: 'bad', mode: 'cron', nextRunAt: null, paused: false },
]
const none = { query: '', agent: null, action: null, state: 'all', sessionId: null }
const ids = rows => rows.map(row => row.id)

test('summaries describe action, target and owner Agent', () => {
  assert.equal(timerSummary(timers[0]), 'Daily report')
  assert.equal(timerSummary(timers[1]), 'Script file checks/disk.py')
  assert.equal(timerSummary(timers[3]), 'Inline script: result = probe()')
  assert.equal(timerTarget(timers[0]), 'Owner session')
  assert.equal(timerTarget(timers[2]), 'New session in research · prefix nightly')
  assert.equal(timerOwnerAgent(timers[1]), 'research')
  assert.equal(timerOwnerAgent(timers[0]), 'main')
  assert.equal(timerOwnerAgent(timers[0], { agent: 'moved' }), 'moved')
  assert.deepEqual(timers.map(timerState), ['scheduled', 'scheduled', 'paused', 'inactive'])
})

test('filters combine Agent, action, state, Session and search', () => {
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, agent: 'research' })), ['b'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, action: 'toolscript' })), ['b', 'd'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, state: 'paused' })), ['c'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, state: 'failing' })), ['b'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, state: 'inactive' })), ['d'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, sessionId: 'lead', action: 'message' })), ['a', 'c'])
  assert.deepEqual(ids(filterTimers(timers, { lead: { displayName: 'Lead desk' } }, { ...none, query: 'lead desk' })), ['a', 'c', 'd'])
  assert.deepEqual(ids(filterTimers(timers, {}, { ...none, query: 'DISK.PY' })), ['b'])
})

test('order puts scheduled timers by next run, then unscheduled, then paused', () => {
  assert.deepEqual(ids(orderTimers(timers)), ['b', 'a', 'd', 'c'])
})

test('edit builds only changed fields with exactly one schedule field', () => {
  assert.deepEqual(buildTimerUpdate(timers[0], { schedule: { kind: 'cron', cron: ' 0 10 * * * ' }, message: 'Daily report' }), { cron: '0 10 * * *' })
  assert.deepEqual(buildTimerUpdate(timers[0], { schedule: { kind: 'keep' }, message: 'Changed' }), { message: 'Changed' })
  assert.deepEqual(buildTimerUpdate(timers[0], { schedule: { kind: 'after', seconds: '90' }, message: 'Daily report' }), { afterSeconds: 90 })
  const at = buildTimerUpdate(timers[2], { schedule: { kind: 'at', local: '2030-01-02T03:04' }, message: 'One-off' })
  assert.deepEqual(Object.keys(at), ['at'])
  assert.equal(at.at, new Date('2030-01-02T03:04').getTime())
  assert.throws(() => buildTimerUpdate(timers[0], { schedule: { kind: 'keep' }, message: 'Daily report' }), /No changes/)
  assert.throws(() => buildTimerUpdate(timers[0], { schedule: { kind: 'after', seconds: '0' } }), /positive/)
  assert.throws(() => buildTimerUpdate(timers[0], { schedule: { kind: 'cron', cron: ' ' } }), /cron/)
  assert.throws(() => buildTimerUpdate(timers[0], { schedule: { kind: 'keep' }, message: '  ' }), /message/)
  assert.deepEqual(buildTimerUpdate(timers[1], { schedule: { kind: 'keep' }, script: '{"filePath":"checks/mem.py"}' }), { script: { filePath: 'checks/mem.py' } })
  assert.throws(() => buildTimerUpdate(timers[1], { schedule: { kind: 'keep' }, script: '[1]' }), /JSON object/)
  assert.throws(() => buildTimerUpdate(timers[1], { schedule: { kind: 'keep' }, script: JSON.stringify(timers[1].script) }), /No changes/)
})
