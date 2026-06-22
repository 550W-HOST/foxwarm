import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactObjectPreview } from './toolResponseFormatting'

test('formatCompactObjectPreview unwraps single-key error and output objects', () => {
  assert.equal(formatCompactObjectPreview({ error: 'bad' }), 'bad')
  assert.equal(formatCompactObjectPreview({ output: 'ok' }), 'ok')
})

test('formatCompactObjectPreview keeps multi-key objects structured', () => {
  const formatted = formatCompactObjectPreview({ output: 'ok', extra: 1 })
  assert.match(formatted, /^output: ok/m)
  assert.match(formatted, /^extra: 1/m)
})

test('formatCompactObjectPreview covers default WebUI tool response formatting', () => {
  assert.equal(formatCompactObjectPreview('plain'), 'plain')

  const structured = formatCompactObjectPreview({ output: 'ok', extra: 1 })
  assert.match(structured, /^output: ok/m)
  assert.match(structured, /^extra: 1/m)
})