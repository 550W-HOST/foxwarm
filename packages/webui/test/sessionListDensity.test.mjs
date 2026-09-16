import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/sessionListDensity.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { loadSessionListCompact, SESSION_LIST_COMPACT_KEY } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('density is opt-in, versioned, and tolerates unavailable browser storage', () => {
  assert.equal(loadSessionListCompact(), false, 'missing browser storage safely defaults to normal')
  assert.equal(SESSION_LIST_COMPACT_KEY, 'foxwarm_session_list_compact_v1')
  for (const value of [null, '', 'false', '1', 'garbage']) assert.equal(loadSessionListCompact({ getItem: () => value }), false)
  assert.equal(loadSessionListCompact({ getItem: () => 'true' }), true)
  assert.equal(loadSessionListCompact({ getItem() { throw new Error('blocked') } }), false)
})
