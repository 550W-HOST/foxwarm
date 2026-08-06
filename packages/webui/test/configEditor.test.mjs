import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import Ajv from 'ajv'

const webuiRoot = path.resolve(new URL('..', import.meta.url).pathname)
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-config-editor-test-'))

async function loadModule(entry, outfile) {
  const output = path.join(tempDir, outfile)
  await build({
    entryPoints: [path.isAbsolute(entry) ? entry : path.join(webuiRoot, entry)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
  return import(`${pathToFileURL(output).href}?${Date.now()}`)
}

const schemas = await loadModule('src/yamlConfigSchemas.ts', 'schemas.cjs')
const sharedSchemas = await loadModule(path.resolve(webuiRoot, '../shared/src/configSchemas.ts'), 'shared-schemas.cjs')
const completions = await loadModule('src/modelsYamlCompletions.ts', 'completions.cjs')
const validateModelsSchema = new Ajv({ allErrors: true, strict: false }).compile(schemas.MODELS_CONFIG_SCHEMA)
const validateAppConfigSchema = new Ajv({ allErrors: true, strict: false }).compile(schemas.APP_CONFIG_SCHEMA)

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
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.required?.includes('default') || false, false)
})

test('app config schema suggests all managed channel types and QQ credential keys while accepting custom types', () => {
  const channel = schemas.APP_CONFIG_SCHEMA.properties.channels.additionalProperties
  assert.deepEqual(channel.properties.type.anyOf[0].enum, ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'])
  assert.equal(channel.properties.appId.type, 'string')
  assert.equal(channel.properties.clientSecret.type, 'string')
  assert.equal(channel.properties.allowedUsers.items.type, 'string')
  assert.equal(channel.properties.allowAllUsers.type, 'boolean')

  assert.equal(validateAppConfigSchema({
    channels: {
      telegram: { type: 'telegram', botToken: 'token' },
      matrix: { type: 'matrix', homeserver: 'https://matrix.example' },
      wework: { type: 'wework' },
      weixin: { type: 'weixin' },
      qq: { type: 'qqbot', appId: 'app-id', clientSecret: 'secret', allowedUsers: ['openid'] },
      custom: { type: 'company-channel', customField: true },
    },
  }), true)
})

test('WebUI schema wrappers reuse the shared canonical schema objects without a duplicate copy', async () => {
  assert.deepEqual(schemas.MODELS_CONFIG_SCHEMA, sharedSchemas.MODELS_CONFIG_SCHEMA)
  assert.deepEqual(schemas.APP_CONFIG_SCHEMA, sharedSchemas.APP_CONFIG_SCHEMA)
  assert.deepEqual([...schemas.KNOWN_PROVIDER_TYPES], [...sharedSchemas.KNOWN_PROVIDER_TYPES])
  const wrapperSource = await readFile(path.join(webuiRoot, 'src/yamlConfigSchemas.ts'), 'utf8')
  assert.match(wrapperSource, /shared\/src\/configSchemas/)
  assert.doesNotMatch(wrapperSource, /Foxwarm models configuration|providerEntry|channelEntry/)
})

test('models schema deliberately accepts current, legacy, custom, and backend-tolerant fixtures', () => {
  const fixtures = [
    {
      providers: {
        current: {
          providerType: 'openai-completions',
          models: ['model-a'],
          extraHeaders: { nested: { supportedByLoader: true }, numeric: 42 },
          customExtension: { enabled: true },
        },
      },
    },
    {
      default: 'sticky',
      models: {
        legacy: { provider: 'anthropic', model: 'model-a' },
        sticky: { provider: 'session-hash', targets: ['legacy'] },
      },
    },
    {
      default: 'custom/model-a',
      providers: {
        custom: { providerType: 'company-protocol', baseUrl: 'https://example.invalid', models: ['model-a'] },
      },
    },
    {
      providers: {
        precedence: { providerType: 'openai-completions', provider: 'failover', models: ['model-a'] },
      },
    },
  ]
  for (const fixture of fixtures) {
    assert.equal(validateModelsSchema(fixture), true, JSON.stringify(validateModelsSchema.errors))
  }
})

test('legacy virtual providers receive the same target and forbidden-field diagnostics', () => {
  const invalidFixtures = [
    { default: 'missing-providers' },
    { providers: { sticky: { provider: 'session-hash' } } },
    { providers: { route: { provider: 'failover', targets: ['one'] } } },
    { providers: { route: { provider: 'failover', targets: ['one', 'two'], baseUrl: 'https://forbidden.invalid' } } },
  ]
  for (const fixture of invalidFixtures) {
    assert.equal(validateModelsSchema(fixture), false)
  }
})

test('Monaco stays on the worker-compatible pinned release used by the real-worker E2E', async () => {
  // Compatibility probe: install monaco-editor@0.55.1, then run
  // `npm run test:setup-models-e2e`. The real marker test times out because
  // monaco-yaml@5.5.1 / monaco-worker-manager@2.0.1 falls back to the generic
  // editor worker, which reports a missing `doValidation` foreign method.
  const packageJson = JSON.parse(await readFile(path.join(webuiRoot, 'node_modules/monaco-editor/package.json'), 'utf8'))
  assert.equal(packageJson.version, '0.54.0')
})

test('Setup gives both YAML editors the exact responsive height contract', async () => {
  const setupSource = await readFile(path.join(webuiRoot, 'src/components/SetupView.tsx'), 'utf8')
  assert.match(setupSource, /SETUP_EDITOR_HEIGHT\s*=\s*['"]calc\(min\(600px, 80vh\)\)['"]/)
  assert.equal((setupSource.match(/height=\{SETUP_EDITOR_HEIGHT\}/g) || []).length, 2)
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
