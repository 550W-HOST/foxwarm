import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactObjectPreview, formatToolResponsePayload } from './toolResponseFormatting'

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

test('WebUI payload formatting keeps structured fields and applies single-key shorthand narrowly', () => {
  assert.equal(formatToolResponsePayload({
    count: 1,
    totalMatched: 1,
    tools: [{ name: 'read', toolId: 'builtin:read' }],
  }), 'count: 1\ntotalMatched: 1\ntools: [{name: read, toolId: builtin:read}]')
  assert.equal(formatCompactObjectPreview({ count: 3 }), '3')
  assert.equal(formatToolResponsePayload({ count: 3 }), 'count: 3')
  assert.equal(formatToolResponsePayload({ content: 'hello' }), 'content: hello')
  assert.equal(formatToolResponsePayload({ output: 'ok' }), 'ok')
  assert.equal(formatToolResponsePayload({ output: 'ok', count: 2 }), 'output: ok\ncount: 2')
  assert.equal(formatToolResponsePayload({ error: { message: 'failed', code: 'E_FAIL' } }), 'error: {message: failed, code: E_FAIL}')
  assert.equal(formatToolResponsePayload({ error: 'bad' }), 'error: bad')
})

test('WebUI response formatting preserves apply_patch line-count summaries', () => {
  const response = [
    'Patch applied successfully.',
    '- Updated src/example.ts (+3 -2)',
    '- Added src/new.ts (+4)',
  ].join('\n')

  assert.equal(formatToolResponsePayload(response), response)
  assert.equal(formatToolResponsePayload({ output: response }), response)
})
