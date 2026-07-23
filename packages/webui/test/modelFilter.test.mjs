import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const webuiRoot = path.resolve(new URL('..', import.meta.url).pathname)
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-model-filter-test-'))
const output = path.join(tempDir, 'model-filter.cjs')

await build({
  entryPoints: [path.join(webuiRoot, 'src/components/modelFilter.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
})

const { filterModelOptions } = await import(pathToFileURL(output).href)

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const options = [
  { key: 'provider/alpha-id', label: 'Friendly One' },
  { key: 'provider/beta-id', label: 'Second Display', isDefault: true },
  { key: 'route', label: 'Failover Route' },
]

test('model filtering matches visible labels and ids case-insensitively while preserving order', () => {
  assert.deepEqual(filterModelOptions(options, '  FRIENDLY '), [options[0]])
  assert.deepEqual(filterModelOptions(options, 'BETA-ID'), [options[1]])
  assert.deepEqual(filterModelOptions(options, 'provider/'), [options[0], options[1]])
  assert.deepEqual(filterModelOptions(options, 'route'), [options[2]])
})

test('empty and unmatched model filters stay exact rather than fuzzy', () => {
  assert.equal(filterModelOptions(options, ''), options)
  assert.equal(filterModelOptions(options, '   '), options)
  assert.deepEqual(filterModelOptions(options, 'friendly-two'), [])
})

test('the visible default suffix participates in natural-text filtering', () => {
  assert.deepEqual(filterModelOptions(options, 'DEFAULT', 'provider/alpha-id'), [options[0], options[1]])
})