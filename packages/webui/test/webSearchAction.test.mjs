import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/webSearchAction.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { getWebSearchAction } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('normalizes proven search actions with a primary query and deduplicated expanded queries', () => {
  assert.deepEqual(getWebSearchAction({
    type: 'web_search_call',
    action: {
      type: 'search',
      query: 'primary query',
      queries: ['primary query', 'secondary query', 'secondary query', '  '],
    },
  }), {
    type: 'search',
    query: 'primary query',
    queries: ['primary query', 'secondary query'],
  })
})

test('falls back to the first nonempty search query and supports open_page', () => {
  assert.deepEqual(getWebSearchAction({
    type: 'web_search_call',
    action: { type: 'search', queries: ['', 'fallback query', 'later query'] },
  }), {
    type: 'search',
    query: 'fallback query',
    queries: ['fallback query', 'later query'],
  })
  assert.deepEqual(getWebSearchAction({
    type: 'web_search_call',
    action: { type: 'open_page', url: ' https://example.com/page ' },
  }), {
    type: 'open_page',
    url: 'https://example.com/page',
  })
  assert.equal(getWebSearchAction({
    type: 'web_search_call',
    action: { type: 'open_page', url: 'javascript:alert(1)' },
  }), null)
})

test('rejects malformed and unknown hosted output items', () => {
  assert.equal(getWebSearchAction(null), null)
  assert.equal(getWebSearchAction({ type: 'reasoning', action: { type: 'search', query: 'hidden' } }), null)
  assert.equal(getWebSearchAction({ type: 'web_search_call', action: { type: 'search', query: ' ' } }), null)
  assert.equal(getWebSearchAction({ type: 'web_search_call', action: { type: 'find_in_page', pattern: 'term' } }), null)
})
