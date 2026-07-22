import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const webuiRoot = path.resolve(new URL('..', import.meta.url).pathname)
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-config-editor-test-'))

async function loadModule(entry, outfile) {
  const output = path.join(tempDir, outfile)
  await build({
    entryPoints: [path.join(webuiRoot, entry)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
  return import(`${pathToFileURL(output).href}?${Date.now()}`)
}

const schemas = await loadModule('src/yamlConfigSchemas.ts', 'schemas.cjs')
const completions = await loadModule('src/modelsYamlCompletions.ts', 'completions.cjs')

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('static config schemas are distinct, permissive, and omit the removed models path field', () => {
  assert.notEqual(schemas.MODELS_YAML_MODEL_URI, schemas.APP_CONFIG_YAML_MODEL_URI)
  assert.equal(schemas.YAML_CONFIG_SCHEMAS.length, 2)
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.additionalProperties, true)
  assert.equal(schemas.APP_CONFIG_SCHEMA.additionalProperties, true)
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.properties.providers.additionalProperties.additionalProperties, true)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.channels.additionalProperties.additionalProperties, true)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.paths.properties, 'modelsConfigPath'), false)
})

test('models schema suggests known provider types while accepting custom strings and documents legacy readers', () => {
  const provider = schemas.MODELS_CONFIG_SCHEMA.properties.providers.additionalProperties
  assert.deepEqual(provider.properties.providerType.anyOf[0].enum, [...schemas.KNOWN_PROVIDER_TYPES])
  assert.equal(provider.properties.providerType.anyOf[1].type, 'string')
  assert.equal(provider.properties.provider.deprecated, true)
  assert.equal(provider.properties.model.deprecated, true)
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.properties.models.deprecated, true)

  const sessionHashRule = provider.allOf[0].then
  const failoverRule = provider.allOf[1].then
  assert.equal(sessionHashRule.properties.targets.minItems, 1)
  assert.equal(failoverRule.properties.targets.minItems, 2)
  assert.equal(provider.properties.failureThreshold.minimum, 1)
  assert.equal(provider.properties.cooldownMs.minimum, 1)
})

test('dynamic models suggestions use the current document and exclude virtual targets', () => {
  const parsed = completions.parseModelsYamlSuggestions(`
default: route
providers:
  one:
    providerType: openai-completions
    models: [model-a]
  many:
    providerType: anthropic
    models:
      - model-b
      - id: model-c
  custom:
    providerType: custom-protocol
  sticky:
    providerType: session-hash
    targets: [one]
  route:
    providerType: failover
    targets: [one, many/model-b]
`)
  assert.deepEqual(parsed.concreteKeys, ['one', 'many/model-b', 'many/model-c', 'custom'])
  assert.deepEqual(parsed.modelKeys, ['one', 'many/model-b', 'many/model-c', 'custom', 'sticky', 'route'])
})

test('invalid partial YAML returns null so the editor can retain its last valid suggestions', () => {
  assert.equal(completions.parseModelsYamlSuggestions('providers:\n  broken: [\n'), null)
  assert.deepEqual(completions.getModelsCompletionKind(['default: rou'], 0), 'default')
  assert.deepEqual(completions.getModelsCompletionKind(['providers:', '  route:', '    targets:', '      - one'], 3), 'targets')
  assert.equal(completions.getModelsCompletionKind(['providers:', '  route:', '    providerType: failover'], 2), null)
})
