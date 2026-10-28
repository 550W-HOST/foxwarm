import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedToolOutcomes } from './publishedToolOutcomes.mjs'

const outcome = (id, name, response) => ({ parts: [{ functionResponse: { tool_use_id: id, name, response } }] })
const failure = message => ({ error: { type: 'tool_error', message } })

test('published diagnostics retain the initiating browser error alongside later failure and success', () => {
  const rows = [
    outcome('packaged-toolscript', 'run_script', { status: 'completed' }),
    outcome('packaged-browser-open', 'browse_open', failure('Originating browser failure')),
    outcome('packaged-browser-image', 'browse_get', failure('Tab tab1 not found')),
    outcome('packaged-react-artifact', 'artifact', { output: 'artifact published' }),
  ]
  assert.deepEqual(publishedToolOutcomes(rows), [
    { id: 'packaged-toolscript', name: 'run_script', status: 'completed' },
    { id: 'packaged-browser-open', name: 'browse_open', status: 'error', error: { type: 'tool_error', message: 'Originating browser failure' } },
    { id: 'packaged-browser-image', name: 'browse_get', status: 'error', error: { type: 'tool_error', message: 'Tab tab1 not found' } },
    { id: 'packaged-react-artifact', name: 'artifact', status: 'completed' },
  ])
})

test('published diagnostics cover an earlier native failure and a later artifact failure', () => {
  const rows = [
    outcome('packaged-toolscript', 'run_script', { status: 'failed', error: 'Native resource read failed' }),
    outcome('packaged-browser-open', 'browse_open', { output: 'Tab opened: tab1' }),
    outcome('packaged-browser-image', 'browse_get', { inlineData: { data: 'image payload' } }),
    outcome('packaged-react-artifact', 'artifact', failure('Artifact preparation failed')),
  ]
  const tools = publishedToolOutcomes(rows)
  assert.equal(tools[0].status, 'failed')
  assert.equal(tools[0].error.message, 'Native resource read failed')
  assert.equal(tools[1].status, 'completed')
  assert.equal(tools[2].status, 'completed')
  assert.equal(tools[3].error.message, 'Artifact preparation failed')
})

test('published diagnostics are bounded and exclude unrelated calls, output, images and nested error data', () => {
  const rows = [
    { parts: [{ text: 'private history' }, { inlineData: { data: 'image payload' } }] },
    outcome('unrelated', 'browse_open', failure('unrelated failure')),
    outcome('packaged-browser-open', 'wrong-tool', failure('wrong identity')),
    ...Array.from({ length: 10 }, () => outcome('packaged-browser-open', 'browse_open', {
      output: 'private output', inlineData: { data: 'image payload' }, token: 'private credential',
      status: 's'.repeat(100), error: { type: 't'.repeat(100), message: 'm'.repeat(2000), details: 'private details' },
    })),
    outcome('packaged-react-artifact', 'artifact', { error: { message: { token: 'nested credential' } } }),
  ]
  const tools = publishedToolOutcomes(rows)
  assert.equal(tools.length, 2)
  assert.equal(tools[0].status.length, 80)
  assert.equal(tools[0].error.type.length, 80)
  assert.equal(tools[0].error.message.length, 1500)
  assert.equal(tools[1].error.message, undefined)
  assert.doesNotMatch(JSON.stringify(tools), /private|payload|unrelated|wrong identity|credential|details/)
  assert.deepEqual(publishedToolOutcomes(), [])
})
