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

const { filterModelOptions, formatVirtualModelDetail, resolveModelDisplayName, resolveModelTriggerDisplayName } = await import(pathToFileURL(output).href)

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

test('model display names fall back to the model id for absent or blank labels', () => {
  assert.equal(resolveModelDisplayName('provider/family/model', [{ key: 'provider/family/model' }]), 'family/model')
  assert.equal(resolveModelDisplayName('provider/model', [{ key: 'provider/model', label: '  ' }]), 'model')
  assert.equal(resolveModelDisplayName('provider/model', [{ key: 'provider/model', label: 'Friendly name' }]), 'Friendly name')
})

test('trigger labels qualify only actual model ids duplicated across providers', () => {
  const duplicateOptions = [
    { key: 'alpha', label: 'Friendly Alpha', providerKey: 'alpha', modelId: 'org/model-a' },
    { key: 'beta', label: 'beta', providerKey: 'beta', modelId: 'org/model-a' },
    { key: 'alpha-alias', label: 'Same Provider Alias', providerKey: 'alpha', modelId: 'org/model-a' },
    { key: 'gamma/unique', label: 'gamma/Unique Label', providerKey: 'gamma', modelId: 'unique' },
    { key: 'route', label: 'Virtual route', providerKey: 'route', modelId: null, isVirtual: true },
  ]
  assert.equal(resolveModelTriggerDisplayName('alpha', duplicateOptions), 'alpha/Friendly Alpha')
  assert.equal(resolveModelTriggerDisplayName('beta', duplicateOptions), 'beta/org/model-a')
  assert.equal(resolveModelTriggerDisplayName('gamma/unique', duplicateOptions), 'Unique Label')
  assert.equal(resolveModelTriggerDisplayName('route', duplicateOptions), 'Virtual route')
  assert.equal(resolveModelTriggerDisplayName('alpha', duplicateOptions.filter(option => option.providerKey !== 'beta')), 'Friendly Alpha')
})

test('virtual model details preserve target order and distinguish aliases, session hashing, and failover', () => {
  assert.equal(formatVirtualModelDetail({ key: 'alias', label: 'alias', isVirtual: true, providerType: 'session-hash', targets: ['alpha/org/model-a'] }), 'alpha/org/model-a')
  assert.equal(formatVirtualModelDetail({ key: 'sticky', label: 'sticky', isVirtual: true, providerType: 'session-hash', targets: ['alpha/a', 'beta/b'] }), 'session-hash: alpha/a, beta/b')
  assert.equal(formatVirtualModelDetail({ key: 'route', label: 'route', isVirtual: true, providerType: 'failover', targets: ['beta/b', 'alpha/a'] }), 'failover: beta/b, alpha/a')
  assert.equal(formatVirtualModelDetail({ key: 'leaf', label: 'leaf', isVirtual: false, providerType: 'openai', targets: ['ignored'] }), null)
})
