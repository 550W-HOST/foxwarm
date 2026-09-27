import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-commit-marker-test-'))
const bundlePath = path.join(tempDir, 'commitMarker.mjs')
await esbuild.build({
  entryPoints: [new URL('../src/commitMarker.ts', import.meta.url).pathname],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})
const { parseCommitMarkerLine, splitCommitMarkers } = await import(pathToFileURL(bundlePath).href)

test('parses strict commit markers with normalized XML-escaped targets', () => {
  assert.deepEqual(parseCommitMarkerLine('<foxwarm-commit id="85AD4D1B" path="/repo/a&amp;b/../src" node="worker-1" />'), {
    nodeId: 'worker-1',
    path: '/repo/src',
    commitId: '85ad4d1b',
  })
})

test('rejects malformed, incomplete, unsafe, or extended commit markers', () => {
  const invalid = [
    '<foxwarm-commit node="master" path="/repo" />',
    '<foxwarm-commit node="master" path="/repo" id="abc" />',
    '<foxwarm-commit node="../master" path="/repo" id="85ad4d1b" />',
    '<foxwarm-commit node="master" path="relative" id="85ad4d1b" />',
    '<foxwarm-commit node="master" path="/repo" id="85ad4d1b" command="evil" />',
    '<foxwarm-commit node="master" node="worker" path="/repo" id="85ad4d1b" />',
    '<foxwarm-commit node=master path="/repo" id="85ad4d1b" />',
    '<foxwarm-commit node="master" path="/repo&bad;" id="85ad4d1b" />',
    '<foxwarm-commit node="master" path="/repo<script>" id="85ad4d1b" />',
    ' <foxwarm-commit node="master" path="/repo" id="85ad4d1b" />',
    '<foxwarm-commit node="master" path="/repo" id="85ad4d1b"></foxwarm-commit>',
  ]
  for (const value of invalid) assert.equal(parseCommitMarkerLine(value), null, value)
})

test('splits standalone model text markers but leaves fenced and inline examples as markdown', () => {
  const marker = '<foxwarm-commit node="master" path="/repo" id="85ad4d1b" />'
  assert.deepEqual(splitCommitMarkers(`Created commit.\n${marker}\nDone.`), [
    { kind: 'markdown', text: 'Created commit.' },
    { kind: 'commit', raw: marker, target: { nodeId: 'master', path: '/repo', commitId: '85ad4d1b' } },
    { kind: 'markdown', text: 'Done.' },
  ])
  assert.deepEqual(splitCommitMarkers(`\`\`\`text\n${marker}\n\`\`\``), [
    { kind: 'markdown', text: `\`\`\`text\n${marker}\n\`\`\`` },
  ])
  assert.deepEqual(splitCommitMarkers(`Use ${marker} inline.`), [
    { kind: 'markdown', text: `Use ${marker} inline.` },
  ])
})

test('preserves invalid standalone candidates as explicit inert segments', () => {
  const raw = '<foxwarm-commit node="master" path="/repo" id="not-a-commit" />'
  assert.deepEqual(splitCommitMarkers(raw), [{ kind: 'invalid', raw }])
})
