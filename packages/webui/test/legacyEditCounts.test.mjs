import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadHelper() {
  const directory = await mkdtemp(path.join(tmpdir(), 'foxwarm-legacy-edit-counts-'))
  const output = path.join(directory, 'legacyEditCounts.mjs')
  await build({
    entryPoints: [new URL('../src/components/legacyEditCounts.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: output,
    logLevel: 'silent',
  })
  const module = await import(pathToFileURL(output).href)
  return { module, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

const { module: counts, cleanup } = await loadHelper()
after(cleanup)

test('countLogicalPayloadLines treats empty text and final line terminators correctly', () => {
  const cases = [
    ['', 0],
    ['one line', 1],
    ['one line\n', 1],
    ['one\ntwo', 2],
    ['one\ntwo\n', 2],
    ['\n', 1],
    ['\n\n', 2],
  ]

  for (const [text, expected] of cases) {
    assert.equal(counts.countLogicalPayloadLines(text), expected, JSON.stringify(text))
  }
})

test('countLogicalPayloadLines handles LF, CRLF, and lone CR consistently', () => {
  for (const text of ['one\ntwo\n', 'one\r\ntwo\r\n', 'one\rtwo\r']) {
    assert.equal(counts.countLogicalPayloadLines(text), 2, JSON.stringify(text))
  }
  for (const text of ['\n', '\r\n', '\r']) {
    assert.equal(counts.countLogicalPayloadLines(text), 1, JSON.stringify(text))
  }
})

test('getLegacyEditLineCounts covers pure deletion, insertion, and replacement', () => {
  assert.deepEqual(counts.getLegacyEditLineCounts('one line', ''), { removed: 1, added: 0 })
  assert.deepEqual(counts.getLegacyEditLineCounts('', 'one line'), { removed: 0, added: 1 })
  assert.deepEqual(counts.getLegacyEditLineCounts('old\nlines\n', 'new\r\nlines\r\n'), { removed: 2, added: 2 })
  assert.deepEqual(counts.getLegacyEditLineCounts('', ''), { removed: 0, added: 0 })
})