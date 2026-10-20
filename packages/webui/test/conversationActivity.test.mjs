import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'conversation-activity-'))
after(() => rm(dir, { recursive: true, force: true }))
const file = join(dir, 'summary.mjs')
await build({
  entryPoints: [new URL('../src/components/conversationActivity.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent',
})
const { buildConversationActivitySummary } = await import(pathToFileURL(file).href)

const call = (id, name = 'task', args = { action: 'update', taskId: 'fixture-task' }) => ({
  role: 'model', parts: [{ functionCall: { id, name, args } }],
})
const result = (id, response, name = 'task') => ({
  role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name, response } }],
})
const receipt = sentNotifications => ({ taskId: 'fixture-task', status: 'active', sentNotifications })
const historical = sentNotifications => ({ output: JSON.stringify(receipt(sentNotifications)) })
const summary = messages => buildConversationActivitySummary(messages)(messages)

for (const [format, encode] of [['native', receipt], ['historical', historical]]) {
  for (const [invocation, taskCall] of [
    ['direct', call('task')],
    ['unified', call('task', 'call_tool', { toolId: 'builtin:task', args: { action: 'assign' } })],
  ]) {
    test(`${invocation} Task calls count ${format} notification receipts`, () => {
      assert.equal(summary([taskCall, result('task', encode(2), taskCall.parts[0].functionCall.name)]), '1 call · 2 sent')
    })
  }
}

test('explicit builtin dispatch reads the same native Task receipt', () => {
  assert.equal(summary([
    call('explicit', 'call_tool', { source: 'builtin', name: 'task', argsJson: '{"action":"update"}' }),
    result('explicit', receipt(1), 'call_tool'),
  ]), '1 call · 1 sent')
})

test('Task outcomes retain actual-call ownership, successful filtering and first-Activity deduplication', () => {
  const successful = [call('owned'), result('owned', receipt(1), 'call_tool')]
  const failed = [call('failed'), result('failed', { ...receipt(5), error: 'Not delivered' })]
  const external = [
    call('external', 'call_tool', { source: 'mcp', name: 'task', args: {} }),
    result('external', receipt(9)),
  ]
  const script = [call('script', 'run_script', { code: 'return task_receipt' }), result('script', {
    status: 'completed', result: receipt(900), output: JSON.stringify(receipt(900)), sentNotifications: 900,
  }, 'task')]
  const pending = [call('pending'), result('pending', receipt(7))].map(message => ({
    ...message, __meta: { temporary: true },
  }))
  const queued = [call('queued'), result('queued', receipt(8))].map(message => ({
    ...message, __meta: { queuedPreview: true },
  }))
  const repeated = structuredClone(successful[1])
  const records = [...successful, ...failed, ...external, ...script, ...pending, ...queued, repeated]
  const summarize = buildConversationActivitySummary(records)
  assert.equal(summarize(records), '4 calls · 1 sent')
  assert.equal(summarize([successful[1], repeated]), 'Activity')
  assert.equal(buildConversationActivitySummary([repeated], records)([repeated]), 'Activity',
    'viewport clipping does not reclaim an outcome from an earlier Activity')
})

test('notification counts retain nonnegative-integer semantics and prefer native facts including zero', () => {
  for (const value of [0, -1, 1.5, '2', null, undefined]) {
    for (const response of [receipt(value), historical(value)]) {
      assert.equal(summary([call('number'), result('number', response)]), '1 call')
    }
  }
  assert.equal(summary([call('zero'), result('zero', { ...historical(4), ...receipt(0) })]), '1 call')
  assert.equal(summary([call('missing'), result('missing', { taskId: 'fixture-task' })]), '1 call')
})
