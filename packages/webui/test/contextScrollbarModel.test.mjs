import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-context-scrollbar-test-'))
const bundledPath = path.join(tempDir, 'contextScrollbarModel.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/components/contextScrollbarModel.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  buildContextScrollbarSegments,
  getContextScrollbarContextUsage,
  getContextScrollbarLegendStats,
  interpolateContextScrollbarBoundary,
} = await import(pathToFileURL(bundledPath).href)

const message = (role, text, seq, extra = {}) => ({ role, parts: [{ text }], __meta: { seq, ...extra } })

test('full committed history gets segments while temporary and synthetic messages stay out', () => {
  const segments = buildContextScrollbarSegments([
    message('user', 'first user', 1),
    message('model', 'first answer', 2),
    { ...message('model', 'stream draft', 3), __meta: { temporary: true, synthetic: 'stream' } },
    message('user', 'second user', 4),
  ])

  assert.equal(segments.length, 3)
  assert.deepEqual(segments.map(segment => segment.key), ['seq-local-1-message', 'seq-local-2-content', 'seq-local-4-message'])
  assert.ok(segments.every(segment => segment.endTokens > segment.startTokens))
})

test('an immediate tool response folds into its preceding model-call overview segment with final tone', () => {
  const segments = buildContextScrollbarSegments([
    {
      role: 'model',
      parts: [{ functionCall: { id: 'call-1', name: 'read', args: { filePath: '/tmp/a' } } }],
      __meta: { seq: 1 },
    },
    {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }],
      __meta: { seq: 2 },
    },
    {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call-2', name: 'edit', response: { error: 'failed' } } }],
      __meta: { seq: 3 },
    },
  ])

  assert.equal(segments.length, 2)
  assert.equal(segments[0].anchorKey, 'seq-local-1')
  assert.equal(segments[0].tone, 'tool-success')
  assert.equal(segments[0].category, 'tools')
  assert.equal(segments[1].tone, 'tool-error')
  assert.equal(segments[1].category, 'tools')
  assert.equal(interpolateContextScrollbarBoundary(segments, 'seq-local-1', 0.5), (segments[0].startTokens + segments[0].endTokens) / 2)
})

test('a history longer than a scrollbar keeps proportional segment height without a minimum-pixel budget', () => {
  const segments = buildContextScrollbarSegments(Array.from({ length: 1200 }, (_, index) => message('user', 'x', index + 1)))
  const total = segments.at(-1).endTokens
  const proportionalTotal = segments.reduce((sum, segment) => sum + segment.estimatedTokens / total, 0)
  assert.equal(segments.length, 1200)
  assert.ok(Math.abs(proportionalTotal - 1) < 1e-10)
})

test('real prompt usage anchors free context and estimates only later committed tail', () => {
  const messages = [
    message('user', 'old request '.repeat(20), 1),
    message('model', 'model output '.repeat(5), 2, { usage: { inputTokens: 400, cachedTokens: 100, outputTokens: 20 } }),
    message('tool', 'later tool content '.repeat(10), 3),
  ]
  const usage = getContextScrollbarContextUsage(messages, 1000)

  assert.equal(usage.capacityTokens, 1000)
  assert.equal(usage.usageAnchorKey, 'seq-local-2')
  assert.ok(usage.usedTokens > 500)
  assert.ok(usage.usedTokens < 1000)
  assert.equal(usage.freeTokens, 1000 - usage.usedTokens)
})

test('missing persisted provider usage has no synthetic free-context measurement', () => {
  assert.equal(getContextScrollbarContextUsage([message('user', 'not yet sent', 1)], 1000), null)
})

test('legend keeps the stable six-category order and includes snapshot, system events, and paired tools', () => {
  const snapshot = { role: 'tool', parts: [{ text: '<foxwarm-system kind="snapshot" />\npersisted prompt' }], __meta: { synthetic: 'persistentMemorySnapshot' } }
  const segments = buildContextScrollbarSegments([
    { role: 'user', parts: [{ system: '<foxwarm-system kind="event" type="wait" />' }], __meta: { seq: 1 } },
    { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'read', args: {} } }], __meta: { seq: 2 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }], __meta: { seq: 3 } },
    message('user', 'direct prompt', 4),
    message('model', 'model content', 5),
  ], snapshot)
  const stats = getContextScrollbarLegendStats(segments)

  assert.deepEqual(stats.map(stat => stat.category), ['snapshot', 'system', 'tools', 'user', 'reasoning', 'model'])
  assert.ok(stats.filter(stat => stat.category !== 'reasoning').every(stat => stat.estimatedTokens > 0))
  assert.equal(Math.round(stats.reduce((sum, stat) => sum + stat.percentage, 0)), 100)
  assert.equal(segments[0].category, 'snapshot')
  assert.equal(segments[0].anchorKey, 'seq-local-1', 'snapshot navigation targets the true first committed message, even before it mounts')
})

test('persisted model reasoning is a separate anchored slice and contributes to the legend', () => {
  const segments = buildContextScrollbarSegments([{
    role: 'model',
    parts: [{ thinking: 'reasoning trace'.repeat(10) }, { text: 'visible answer'.repeat(10) }],
    __meta: { seq: 1 },
  }])
  assert.deepEqual(segments.map(segment => segment.category), ['reasoning', 'model'])
  assert.equal(segments[0].anchorKey, 'seq-local-1')
  assert.equal(segments[1].anchorKey, 'seq-local-1')
  assert.ok(getContextScrollbarLegendStats(segments).find(stat => stat.category === 'reasoning').estimatedTokens > 0)
})

test('model-visible lightweight user metadata is estimated, while a display-only row retains a zero-token boundary', () => {
  const visible = buildContextScrollbarSegments([
    { role: 'user', parts: [{ system: '<foxwarm-system kind="time" />' }], __meta: { seq: 1 } },
  ])
  assert.ok(visible[0].estimatedTokens > 0)
  assert.equal(visible[0].category, 'user')

  const segments = buildContextScrollbarSegments([
    { role: 'user', parts: [{ system: '<foxwarm-system kind="time" />' }], modelVisible: false, __meta: { seq: 1 } },
    message('user', 'following visible prompt', 2),
  ])
  const boundary = segments.find(segment => segment.key === 'seq-local-1-boundary')
  assert.equal(boundary?.estimatedTokens, 0)
  assert.equal(boundary?.startTokens, boundary?.endTokens)
  assert.equal(interpolateContextScrollbarBoundary(segments, 'seq-local-1', 0.5), boundary?.startTokens)
  assert.equal(getContextScrollbarLegendStats(segments).reduce((sum, stat) => sum + stat.estimatedTokens, 0), segments[1].estimatedTokens)
})
