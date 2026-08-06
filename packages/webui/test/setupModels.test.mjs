import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-setup-models-test-'))
const bundledPath = path.join(tempDir, 'setupModels.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/setupModels.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  buildConcreteTestRequest,
  buildModelsYaml,
  buildStructuredSetupRequest,
  canTestProvider,
  changeDefaultForProviderType,
  changeProviderType,
  hydrateProviderDrafts,
  makeDefaultProvider,
  validateProviderDrafts,
} = await import(pathToFileURL(bundledPath).href)

function concrete(overrides = {}) {
  return {
    ...makeDefaultProvider(0),
    id: 'leaf',
    providerType: 'openai-completions',
    isVirtual: false,
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    models: 'model-a\nmodel-b',
    defaultModel: 'model-a',
    ...overrides,
  }
}

function virtual(providerType, overrides = {}) {
  return {
    ...makeDefaultProvider(1),
    id: 'route',
    providerType,
    isVirtual: true,
    baseUrl: '',
    apiKey: '',
    models: '',
    defaultModel: '',
    targets: providerType === 'failover' ? 'leaf/model-a\nleaf/model-b' : 'leaf/model-a',
    failureThreshold: '',
    cooldownMs: '',
    ...overrides,
  }
}

test('generated OOBE provider uses the current OpenAI model set and default', () => {
  const provider = makeDefaultProvider(0)
  assert.equal(provider.defaultModel, 'gpt-5.6-sol')
  assert.equal(provider.models, 'gpt-5.6-sol\ngpt-5.6-terra\ngpt-5.6-luna')
  assert.match(buildModelsYaml([provider], 'openai/gpt-5.6-sol'), /^default: "openai\/gpt-5\.6-sol"$/m)
})

test('setup status hydrates virtual targets and round-trips through structured request and YAML', () => {
  const drafts = hydrateProviderDrafts([
    {
      id: 'leaf',
      providerType: 'openai-completions',
      isVirtual: false,
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      models: 'model-a\nmodel-b',
      defaultModel: 'model-a',
    },
    {
      id: 'sticky',
      providerType: 'session-hash',
      isVirtual: true,
      targets: ['leaf/model-a'],
    },
    {
      id: 'route',
      providerType: 'failover',
      isVirtual: true,
      targets: ['leaf/model-a', 'leaf/model-b'],
      failureThreshold: 7,
      cooldownMs: 12345,
    },
  ])

  assert.equal(drafts[1].targets, 'leaf/model-a')
  assert.equal(drafts[2].targets, 'leaf/model-a\nleaf/model-b')
  assert.equal(drafts[2].failureThreshold, '7')
  assert.equal(drafts[2].cooldownMs, '12345')

  const request = buildStructuredSetupRequest(drafts, 'route')
  assert.deepEqual(request.providers[1], {
    id: 'sticky',
    providerType: 'session-hash',
    isVirtual: true,
    targets: ['leaf/model-a'],
  })
  assert.deepEqual(request.providers[2], {
    id: 'route',
    providerType: 'failover',
    isVirtual: true,
    targets: ['leaf/model-a', 'leaf/model-b'],
    failureThreshold: 7,
    cooldownMs: 12345,
  })
  for (const forbidden of ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'contextLimit', 'asyncCompact']) {
    assert.equal(Object.hasOwn(request.providers[1], forbidden), false)
    assert.equal(Object.hasOwn(request.providers[2], forbidden), false)
  }

  const yaml = buildModelsYaml(drafts, 'route')
  assert.match(yaml, /^default: "route"$/m)
  assert.match(yaml, /sticky:\n    providerType: "session-hash"\n    targets:\n      - "leaf\/model-a"/)
  assert.match(yaml, /route:\n    providerType: "failover"[\s\S]*failureThreshold: 7\n    cooldownMs: 12345/)
  assert.doesNotMatch(yaml, /sticky:[\s\S]*?baseUrl:/)
})

test('concrete and virtual type changes clear mutually exclusive fields and stale secrets', () => {
  const original = concrete({
    targets: 'stale/target',
    failureThreshold: '9',
    cooldownMs: '999',
  })
  const hash = changeProviderType(original, 'session-hash')
  assert.deepEqual({
    baseUrl: hash.baseUrl,
    apiKey: hash.apiKey,
    models: hash.models,
    defaultModel: hash.defaultModel,
    targets: hash.targets,
    failureThreshold: hash.failureThreshold,
    cooldownMs: hash.cooldownMs,
  }, {
    baseUrl: '', apiKey: '', models: '', defaultModel: '', targets: '', failureThreshold: '', cooldownMs: '',
  })

  const failover = changeProviderType({ ...hash, targets: 'leaf/model-a\nleaf/model-b' }, 'failover')
  assert.equal(failover.targets, 'leaf/model-a\nleaf/model-b')
  assert.equal(failover.failureThreshold, '')
  assert.equal(failover.cooldownMs, '')

  const backToHash = changeProviderType({ ...failover, failureThreshold: '8', cooldownMs: '8000' }, 'session-hash')
  assert.equal(backToHash.targets, failover.targets)
  assert.equal(backToHash.failureThreshold, '')
  assert.equal(backToHash.cooldownMs, '')

  const backToConcrete = changeProviderType(backToHash, 'anthropic')
  assert.equal(backToConcrete.targets, '')
  assert.equal(backToConcrete.failureThreshold, '')
  assert.equal(backToConcrete.cooldownMs, '')
  assert.equal(backToConcrete.apiKey, '')
  assert.equal(backToConcrete.models, '')

  assert.equal(changeDefaultForProviderType('leaf/model-a', original, 'session-hash'), 'leaf')
  assert.equal(changeDefaultForProviderType('leaf', hash, 'anthropic'), '')
  assert.equal(changeDefaultForProviderType('other/model', original, 'session-hash'), 'other/model')
})

test('blank failover controls omit backend defaults while explicit values require positive integers', () => {
  const request = buildStructuredSetupRequest([concrete(), virtual('failover')], 'route')
  const route = request.providers[1]
  assert.equal(Object.hasOwn(route, 'failureThreshold'), false)
  assert.equal(Object.hasOwn(route, 'cooldownMs'), false)

  const yaml = buildModelsYaml([concrete(), virtual('failover')], 'route')
  assert.doesNotMatch(yaml, /failureThreshold|cooldownMs/)

  for (const [field, value] of [['failureThreshold', '0'], ['failureThreshold', '1.5'], ['cooldownMs', '-1'], ['cooldownMs', '2.5']]) {
    assert.throws(
      () => buildStructuredSetupRequest([concrete(), virtual('failover', { [field]: value })], 'route'),
      new RegExp(`${field} must be a positive integer`),
    )
  }
})

test('session hash accepts one exact target and rejects exact duplicate target lines', () => {
  const providers = [concrete({ models: 'model-a' }), virtual('session-hash', { targets: 'leaf' })]
  assert.doesNotThrow(() => validateProviderDrafts(providers))

  assert.throws(
    () => validateProviderDrafts([concrete(), virtual('session-hash', { targets: 'leaf/model-a\nleaf/model-a' })]),
    /duplicate target `leaf\/model-a`/,
  )
})

test('failover requires at least two targets', () => {
  assert.throws(
    () => validateProviderDrafts([concrete(), virtual('failover', { targets: 'leaf/model-a' })]),
    /requires at least 2 targets/,
  )
})

test('virtual provider tests are disabled and concrete test payload stays compatible', () => {
  const leaf = concrete()
  assert.equal(canTestProvider(virtual('session-hash')), false)
  assert.throws(() => buildConcreteTestRequest(virtual('failover')), /tested after saving/)
  assert.deepEqual(buildConcreteTestRequest(leaf), {
    providerKey: 'leaf',
    providerType: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    models: 'model-a\nmodel-b',
    defaultModel: 'model-a',
    testModel: 'model-a',
  })
})

test('blank default uses a virtual provider key without appending a model id', () => {
  const request = buildStructuredSetupRequest([virtual('session-hash', { id: 'sticky' })], '')
  assert.equal(request.defaultModel, 'sticky')
  assert.match(buildModelsYaml([virtual('session-hash', { id: 'sticky' })], ''), /^default: "sticky"$/m)
})

test('concrete structured request and YAML behavior remains unchanged', () => {
  const leaf = concrete()
  const request = buildStructuredSetupRequest([leaf], 'leaf/model-a')
  assert.deepEqual(request.providers[0], {
    id: 'leaf',
    providerType: 'openai-completions',
    isVirtual: false,
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    models: 'model-a\nmodel-b',
    defaultModel: 'model-a',
  })
  const yaml = buildModelsYaml([leaf], 'leaf/model-a')
  assert.match(yaml, /baseUrl: "https:\/\/example\.test\/v1"/)
  assert.match(yaml, /apiKey: "secret"/)
  assert.match(yaml, /models:\n      - "model-a"\n      - "model-b"/)
  assert.doesNotMatch(yaml, /targets:/)
})
