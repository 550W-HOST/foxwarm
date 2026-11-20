import assert from 'node:assert/strict'
import test from 'node:test'
import { killProcessTree, runCleanup } from '../../dotnet/scripts/desktop-cleanup.mjs'

const running = { pid: 4242, exitCode: null, signalCode: null }
const failing = status => () => { throw Object.assign(new Error(`taskkill exited with ${status}`), { status }) }

test('ending an already exited process tree is not an error', () => {
  killProcessTree(running, failing(128))
  killProcessTree({ ...running, exitCode: 0 }, failing(1))
})

test('ending a process tree runs taskkill for the whole tree and reports other failures', () => {
  const calls = []
  killProcessTree(running, (...call) => { calls.push(call) })
  assert.deepEqual(calls, [['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore' }]])
  assert.throws(() => killProcessTree(running, failing(1)), /exited with 1/)
})

test('every cleanup step runs and a failed acceptance keeps its own error', async () => {
  const ran = [], reported = []
  await runCleanup([
    ['first', () => { ran.push('first'); throw new Error('first failed') }],
    ['second', async () => { ran.push('second') }],
    ['third', async () => { ran.push('third'); throw new Error('third failed') }],
  ], true, message => reported.push(message))
  assert.deepEqual(ran, ['first', 'second', 'third'])
  assert.deepEqual(reported, ['Cleanup step failed (first): first failed', 'Cleanup step failed (third): third failed'])
  const acceptance = new Error('acceptance failed')
  await assert.rejects(async () => {
    try { throw acceptance } finally { await runCleanup([['only', () => { throw new Error('cleanup failed') }]], true, () => {}) }
  }, error => error === acceptance)
})

test('cleanup failures after a passed acceptance are thrown', async () => {
  const one = new Error('one')
  await assert.rejects(runCleanup([['a', () => { throw one }]], false, () => {}), error => error === one)
  await assert.rejects(runCleanup([['a', () => { throw one }], ['b', () => { throw new Error('two') }]], false, () => {}),
    error => error instanceof AggregateError && error.errors.length === 2)
  await runCleanup([['a', () => {}]], false, () => {})
})
