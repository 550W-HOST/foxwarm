import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

globalThis.window = { location: { pathname: '/foxwarm/' } }

const sourcePath = new URL('../src/activity.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { loadActivity, activityInitiatorLabel, activityToolLabel, activityApproverLabel, activityRuleLabel, activityErrorLabel, mergeActivity } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const item = patch => ({ origin: 'model', tool: 'exec', server: null, action: null, initiator: null, ...patch })

test('initiators read as product labels and unknown stays unknown', () => {
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'administrator' } })), 'Administrator')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'identity', id: 'alice' } })), 'alice')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'timer', id: 'tmr_1' } })), 'Timer tmr_1')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'task', id: 'task_1', from: 'lead' } })), 'Task task_1 from lead')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'mcp-client', id: 'ci' } })), 'MCP client ci')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'mcp-server', id: 'ci' } })), 'MCP server ci')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'channel', id: 'tg:1', from: 'bob' } })), 'bob via tg:1')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'user', id: 'webui' } })), 'WebUI user')
  assert.equal(activityInitiatorLabel(item({})), 'Not recorded')
})

test('approvers, rules and errors read without machine values', () => {
  assert.equal(activityApproverLabel('identity:alice'), 'alice')
  assert.equal(activityApproverLabel('administrator'), 'Administrator')
  assert.equal(activityRuleLabel({ layer: 'global', id: 'defaultAction', effect: 'allow' }), 'Global rules · Default action · Allow')
  assert.equal(activityRuleLabel({ layer: 'agent:ops', id: 'no-secret', effect: 'deny' }), 'Agent ops rules · no-secret · Deny')
  assert.equal(activityErrorLabel('tool_authorization_denied'), 'Denied by a rule')
  assert.equal(activityErrorLabel('image_materialization_failed'), 'Image materialization failed')
})

test('a fresh page goes on top and keeps loaded earlier pages', () => {
  const row = (time, key = `k${time}`) => item({ startedAt: time, key })
  const loaded = { items: [row(10), row(9), row(8), row(7)], next: { beforeTime: 7, beforeKey: 'k7' } }
  // One new call: the first page now ends one row earlier.
  const merged = mergeActivity(loaded, { items: [row(11), row(10), row(9)], next: { beforeTime: 9, beforeKey: 'k9' } })
  assert.deepEqual(merged.items.map(entry => entry.startedAt), [11, 10, 9, 8, 7])
  assert.equal(merged.next, loaded.next)
  // A fresh page that does not reach the loaded rows leaves a gap to fill first.
  assert.equal(mergeActivity(loaded, { items: [row(14), row(13), row(12)], next: { beforeTime: 12, beforeKey: 'k12' } }), null)
  // A complete fresh list replaces rows that are gone.
  assert.deepEqual(mergeActivity(loaded, { items: [row(11), row(10)], next: null }).items.map(entry => entry.startedAt), [11, 10])
  assert.deepEqual(mergeActivity({ items: [], next: null }, { items: [row(1)], next: null }).items.map(entry => entry.startedAt), [1])
})

test('tool labels name the MCP server and action', () => {
  assert.equal(activityToolLabel(item({ tool: 'node', action: 'create' })), 'node create')
  assert.equal(activityToolLabel(item({ tool: 'search', server: 'docs' })), 'docs · search')
})

test('loadActivity posts only set filters and the cursor under the deployment base', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ items: [], hasMore: false, next: null, coverage: { complete: true, earliest: null } }) }
  }
  await loadActivity({ kind: 'changes', node: 'gpu', text: '', tree: false, outcome: undefined }, { beforeTime: 5, beforeKey: 's:x' }, 50)
  assert.equal(calls[0].url, '/foxwarm/api/activity')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { limit: 50, kind: 'changes', node: 'gpu', beforeTime: 5, beforeKey: 's:x' })

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Unknown activity kind.' }) })
  await assert.rejects(loadActivity({}), /Unknown activity kind/)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  await assert.rejects(loadActivity({}), /Activity is unavailable/)
})
