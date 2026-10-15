import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactObjectPreview, formatToolResponsePayload, formatToolScriptExecutionResponse } from './toolResponseFormatting'

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

test('ToolScript sections preserve literal print and string return content', () => {
  const stdout = 'printed "quotes" and \\path\n--- return ---\n'
  const result = '{"text":"not decoded"}\n---\nlast \\line'
  const response = { status: 'completed', runId: 'tsr_literal', stdout, result }
  assert.equal(formatToolScriptExecutionResponse(response),
    `--- print ---\n${stdout}--- return ---\n${result}\n---\nstatus: completed\nrunId: tsr_literal`)
  assert.equal(response.stdout, stdout)
  assert.equal(response.result, result)
})

test('ToolScript return uses block YAML while absent and falsy values stay distinct', () => {
  const metadata = { status: 'completed', runId: 'tsr_values' }
  assert.equal(formatToolScriptExecutionResponse(metadata), '---\nstatus: completed\nrunId: tsr_values')
  assert.equal(formatToolScriptExecutionResponse({ ...metadata, result: undefined, stdout: '' }), formatToolScriptExecutionResponse(metadata))
  for (const [result, text] of [[null, 'null'], [false, 'false'], [0, '0'], ['', ''], [[], '[]'], [{}, '{}']] as const) {
    assert.equal(formatToolScriptExecutionResponse({ ...metadata, result }), `--- return ---\n${text}\n---\nstatus: completed\nrunId: tsr_values`)
  }
  assert.equal(formatToolScriptExecutionResponse({ ...metadata, result: { items: [{ text: 'first\nsecond', done: false }] } }),
    '--- return ---\nitems:\n  - text: |-\n      first\n      second\n    done: false\n---\nstatus: completed\nrunId: tsr_values')
})

test('ToolScript metadata keeps waiting and multiline errors readable, and guard summaries intact', () => {
  const response = { status: 'waiting', runId: 'tsr_wait', waitingReason: 'agent', continuationId: 'next', question: 'Which label?' }
  assert.equal(formatToolScriptExecutionResponse(response),
    '---\nstatus: waiting\nrunId: tsr_wait\nwaitingReason: agent\ncontinuationId: next\nquestion: Which label?')
  assert.match(formatToolScriptExecutionResponse({ status: 'failed', runId: 'tsr_error', stdout: 'partial\n', error: 'Traceback:\nValueError: failed' }),
    /^--- print ---\npartial\n---\nstatus: failed\nrunId: tsr_error\nerror: \|-\n  Traceback:\n  ValueError: failed$/)
  const summary = { status: 'completed', runId: 'tsr_long', truncated: true, output: 'excerpt', fullOutputPath: 'saved.txt' }
  assert.equal(formatToolScriptExecutionResponse(summary), formatToolResponsePayload(summary))
  const historical = { output: 'head\n[historical response pruned; recall msg#3]\ntail', status: 'completed', runId: 'tsr_history' }
  assert.equal(formatToolScriptExecutionResponse(historical), formatToolResponsePayload(historical))
})
