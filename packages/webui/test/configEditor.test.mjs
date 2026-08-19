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
  const providerObject = schemas.MODELS_CONFIG_SCHEMA.properties.providers.additionalProperties.oneOf.find((entry) => entry.type === 'object')
  assert.equal(providerObject.additionalProperties, true)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.channels.additionalProperties.additionalProperties, true)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.paths.properties, 'modelsConfigPath'), false)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.llm.properties, 'thinkingBudget'), false)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.maxOutput.default, 32768)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.compactKeepPercent.default, 0.3)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.compactThresholdPercent.default, 0.85)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.llm.properties, 'compactPercent'), false)
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.required?.includes('default') || false, false)
})

test('app config schema suggests all managed channel types and QQ credential keys while accepting custom types', () => {
  const channel = schemas.APP_CONFIG_SCHEMA.properties.channels.additionalProperties
  assert.deepEqual(channel.properties.type.anyOf[0].enum, ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'])
  assert.equal(channel.properties.appId.type, 'string')
  assert.equal(channel.properties.clientSecret.type, 'string')
  assert.equal(channel.properties.requireMention.type, 'boolean')
  assert.equal(channel.properties.groupContextLimit.minimum, 0)
  assert.equal(channel.properties.groupContextLimit.maximum, 50)
  assert.equal(channel.properties.groupBatchWindowMs.anyOf[0].const, 0)
  assert.equal(channel.properties.groupBatchWindowMs.anyOf[1].minimum, 250)
  assert.equal(channel.properties.groupBatchWindowMs.anyOf[1].maximum, 30000)
  assert.equal(channel.properties.media.properties.imageMaxBytes.maximum, 20971520)
  assert.equal(channel.properties.media.properties.fileMaxBytes.maximum, 209715200)
  assert.match(channel.properties.media.properties.fileMaxBytes.description, /100 MiB/)
  assert.equal(channel.properties.media.properties.maxTotalBytes.maximum, 209715200)
  assert.equal(channel.properties.media.properties.maxAttachments.maximum, 16)
  assert.equal(channel.properties.allowedUsers.items.type, 'string')
  assert.equal(channel.properties.allowAllUsers.type, 'boolean')
  const vectorMaintenance = schemas.APP_CONFIG_SCHEMA.properties.vectorMaintenance
  assert.equal(vectorMaintenance.oneOf.some((entry) => entry.type === 'boolean'), true)
  assert.equal(vectorMaintenance.oneOf.find((entry) => entry.type === 'object').properties.retentionHours.minimum, 1)
  const vector = schemas.APP_CONFIG_SCHEMA.properties.vector
  assert.equal(vector.oneOf.some((entry) => entry.const === false), true)
  assert.equal(vector.oneOf.find((entry) => entry.type === 'object').properties.baseUrl.pattern, '^https?://')
  const executableNodeProvider = schemas.APP_CONFIG_SCHEMA.properties.nodeProviders.additionalProperties
  assert.equal(executableNodeProvider.additionalProperties, false)
  assert.deepEqual(executableNodeProvider.required, ['type', 'command'])
  assert.equal(executableNodeProvider.properties.type.const, 'executable')
  assert.equal(executableNodeProvider.properties.timeoutSeconds.default, 90)

  assert.equal(validateAppConfigSchema({
    channels: {
      telegram: { type: 'telegram', botToken: 'token' },
      matrix: { type: 'matrix', homeserver: 'https://matrix.example' },
      wework: { type: 'wework' },
      weixin: { type: 'weixin' },
      qq: {
        type: 'qqbot',
        appId: 'app-id',
        clientSecret: 'secret',
        requireMention: false,
        groupContextLimit: 10,
        groupBatchWindowMs: 5000,
        allowedUsers: ['openid'],
        media: { imageMaxBytes: 20971520, fileMaxBytes: 52428800, maxTotalBytes: 209715200, maxAttachments: 8 },
      },
      custom: { type: 'company-channel', customField: true },
    },
  }), true)
  assert.equal(validateAppConfigSchema({ vectorMaintenance: true }), true)
  assert.equal(validateAppConfigSchema({ vectorMaintenance: false }), true)
  assert.equal(validateAppConfigSchema({ vectorMaintenance: { retentionHours: 48 } }), true)
  assert.equal(validateAppConfigSchema({ vector: false }), true)
  assert.equal(validateAppConfigSchema({ vector: { baseUrl: 'https://example.test/openai/v1' } }), true)
  assert.equal(validateAppConfigSchema({ nodeProviders: { sandbox: { type: 'executable', command: '/opt/provider', args: ['serve'], timeoutSeconds: 30 } } }), true)
  assert.equal(validateAppConfigSchema({ nodeProviders: { sandbox: { type: 'executable', command: '/opt/provider', secret: true } } }), false)
  assert.equal(validateAppConfigSchema({ llm: { compactKeepPercent: 0.3, compactThresholdPercent: 0.85 } }), true)
  assert.equal(validateAppConfigSchema({ llm: { compactKeepPercent: 0 } }), false)
  assert.equal(validateAppConfigSchema({ llm: { compactThresholdPercent: 1.1 } }), false)
  assert.equal(validateAppConfigSchema({ vector: true }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupContextLimit: 51 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupBatchWindowMs: 249 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupBatchWindowMs: 0 } } }), true)
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
          effort: { allowed: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
          webSearch: true,
          extraHeaders: { nested: { supportedByLoader: true }, numeric: 42 },
          customExtension: { enabled: true },
        },
      },
    },
    {
      providers: {
        modelOverride: {
          providerType: 'openai-responses',
          models: [{ id: 'model-a', webSearch: false }],
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
    {
      default: 'fast',
      providers: {
        concrete: { providerType: 'openai-completions', models: ['model-a'] },
        fast: 'concrete/model-a',
      },
    },
  ]
  for (const fixture of fixtures) {
    assert.equal(validateModelsSchema(fixture), true, JSON.stringify(validateModelsSchema.errors))
  }
  assert.equal(validateModelsSchema({ providers: { empty: '   ' } }), false)
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
  const providerEntry = schemas.MODELS_CONFIG_SCHEMA.properties.providers.additionalProperties
  const provider = providerEntry.oneOf.find((entry) => entry.type === 'object')
  const alias = providerEntry.oneOf.find((entry) => entry.type === 'string')
  assert.equal(alias.pattern, '\\S')
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
  assert.equal(provider.properties.webSearch.oneOf.some((entry) => entry.type === 'boolean'), true)
  assert.deepEqual(provider.properties.effort.properties.allowed.items.enum, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(provider.properties.effort.properties.default.enum, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  const webSearchOptions = provider.properties.webSearch.oneOf.find((entry) => entry.type === 'object')
  assert.equal(webSearchOptions.properties.enabled.type, 'boolean')
  assert.deepEqual(webSearchOptions.properties.toolChoice.enum, ['auto', 'required'])
  assert.equal(provider.allOf[0].then.not.anyOf.some((rule) => rule.required.includes('webSearch')), true)
  assert.equal(provider.allOf[0].then.not.anyOf.some((rule) => rule.required.includes('effort')), true)
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
  fast: one/model-a
  route:
    providerType: failover
    targets: [one, many/model-b]
`)
  assert.deepEqual(parsed.concreteKeys, ['one', 'many/model-b', 'many/model-c', 'custom'])
  assert.deepEqual(parsed.modelKeys, ['one', 'many/model-b', 'many/model-c', 'custom', 'sticky', 'fast', 'route'])
})

test('invalid partial YAML returns null so the editor can retain its last valid suggestions', () => {
  assert.equal(completions.parseModelsYamlSuggestions('providers:\n  broken: [\n'), null)
  assert.deepEqual(completions.getModelsCompletionKind(['default: rou'], 0), 'default')
  assert.deepEqual(completions.getModelsCompletionKind(['providers:', '  route:', '    targets:', '      - one'], 3), 'targets')
  assert.equal(completions.getModelsCompletionKind(['providers:', '  route:', '    providerType: failover'], 2), null)
})

test('YAML scalar completion words retain model punctuation', () => {
  assert.deepEqual(
    'default: gpt-5.6-sol/provider'.match(completions.YAML_SCALAR_WORD_PATTERN),
    ['default', 'gpt-5.6-sol/provider'],
  )
  assert.deepEqual(
    '    providerType: openai-completions # comment'.match(completions.YAML_SCALAR_WORD_PATTERN),
    ['providerType', 'openai-completions', 'comment'],
  )
})
