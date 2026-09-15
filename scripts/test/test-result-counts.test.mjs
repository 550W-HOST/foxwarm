import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTestResultCounts } from './test-result-counts.mjs'

test('aggregates multiple TAP summaries', () => {
  assert.deepEqual(parseTestResultCounts('ℹ tests 4\nℹ pass 4\nℹ fail 0\nℹ tests 3\nℹ pass 2\nℹ fail 1\n'), {
    tests: 7, pass: 6, fail: 1,
  })
})

test('reports unittest successes and skips truthfully', () => {
  assert.deepEqual(parseTestResultCounts('Ran 5 tests in 0.01s\n\nOK (skipped=2)\n'), {
    tests: 5, pass: 3, fail: 0, cancelled: 0, skipped: 2, todo: 0,
  })
})

test('reports unittest failures, errors, expected failures, and unexpected successes', () => {
  assert.deepEqual(parseTestResultCounts('Ran 9 tests in 0.01s\n\nFAILED (failures=2, errors=1, skipped=1, expected failures=2, unexpected successes=1)\n'), {
    tests: 9, pass: 2, fail: 4, cancelled: 0, skipped: 1, todo: 2,
  })
})

test('does not fabricate counts from missing or truncated unittest summaries', () => {
  assert.equal(parseTestResultCounts('ordinary output only\n'), null)
  assert.equal(parseTestResultCounts('Ran 5 tests in 0.01s\n'), null)
  assert.equal(parseTestResultCounts('Ran 5 tests in 0.01s\n\nFAILED (skipped=1)\n'), null)
})

test('counts standalone explicit PASS lines', () => {
  assert.deepEqual(parseTestResultCounts('PASS one\nPASS two\n'), {
    tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0,
  })
})
