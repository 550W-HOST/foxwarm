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
  assert.deepEqual(segments.map(segment => segment.key), ['seq-local-1', 'seq-local-2', 'seq-local-4'])
  assert.ok(segments.every(segment => segment.endTokens > segment.startTokens))
})

test('tool response reuses its preceding rendered model row and preserves success/error tones', () => {
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

  assert.equal(segments[0].anchorKey, 'seq-local-1')
  assert.equal(segments[1].anchorKey, 'seq-local-1')
  assert.equal(segments[1].tone, 'tool-success')
  assert.equal(segments[2].tone, 'tool-error')
  assert.equal(interpolateContextScrollbarBoundary(segments, 'seq-local-1', 0.5), (segments[0].startTokens + segments[1].endTokens) / 2)
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
