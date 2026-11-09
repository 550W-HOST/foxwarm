import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

globalThis.window = { location: { pathname: '/foxwarm/' } }

const sourcePath = new URL('../src/activity.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { loadActivity, activityInitiatorLabel, activityToolLabel } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const item = patch => ({ origin: 'model', tool: 'exec', server: null, action: null, initiator: null, principal: null, ...patch })

test('initiators read as product labels and unknown stays unknown', () => {
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'administrator' } })), 'Administrator')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'identity', id: 'alice' } })), 'Identity alice')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'timer', id: 'tmr_1' } })), 'Timer tmr_1')
  assert.equal(activityInitiatorLabel(item({ initiator: { kind: 'event' } })), 'Background event')
  assert.equal(activityInitiatorLabel(item({})), 'Not recorded')
  assert.equal(activityInitiatorLabel(item({ origin: 'external-mcp', principal: 'external:ci' })), 'External client ci')
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
