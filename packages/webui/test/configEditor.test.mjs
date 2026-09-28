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
const validateSharedModelsSchema = new Ajv({ allErrors: true, strict: false }).compile(sharedSchemas.MODELS_CONFIG_SCHEMA)
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
  assert.deepEqual(providerObject.properties.historyReasoningField.enum, ['reasoning_content', 'reasoning'])
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.channels.additionalProperties.additionalProperties, true)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.paths.properties, 'modelsConfigPath'), false)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.llm.properties, 'thinkingBudget'), false)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.maxOutput.default, 32768)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.compactKeepPercent.default, 0.3)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.llm.properties.compactThresholdPercent.default, 0.85)
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.handoffConfirmation.type, 'boolean')
  assert.equal(schemas.APP_CONFIG_SCHEMA.properties.handoffConfirmation.default, false)
  assert.match(schemas.APP_CONFIG_SCHEMA.properties.handoffConfirmation.description, /requires restart/i)
  assert.equal(Object.hasOwn(schemas.APP_CONFIG_SCHEMA.properties.llm.properties, 'compactPercent'), false)
  assert.equal(schemas.MODELS_CONFIG_SCHEMA.required?.includes('default') || false, false)
})

test('app config schema suggests all managed channel types and QQ credential keys while accepting custom types', () => {
  const channels = schemas.APP_CONFIG_SCHEMA.properties.channels
  const channel = channels.additionalProperties
  const channelBranch = (type) => channel.allOf.find((entry) => entry.if?.properties?.type?.pattern === `^\\s*${type}\\s*$`).then
  const qqbot = channelBranch('qqbot')
  assert.deepEqual(channel.properties.type.anyOf[0].enum, ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'])
  assert.equal(qqbot.properties.appId.type, 'string')
  assert.equal(qqbot.properties.clientSecret.type, 'string')
  assert.equal(qqbot.properties.requireMention.type, 'boolean')
  assert.equal(qqbot.properties.groupContextLimit.minimum, 0)
  assert.equal(qqbot.properties.groupContextLimit.maximum, 50)
  assert.equal(qqbot.properties.groupBatchWindowMs.anyOf[0].const, 0)
  assert.equal(qqbot.properties.groupBatchWindowMs.anyOf[1].minimum, 250)
  assert.equal(qqbot.properties.groupBatchWindowMs.anyOf[1].maximum, 30000)
  assert.equal(qqbot.properties.media.properties.imageMaxBytes.maximum, 20971520)
  assert.equal(qqbot.properties.media.properties.fileMaxBytes.maximum, 209715200)
  assert.match(qqbot.properties.media.properties.fileMaxBytes.description, /100 MiB/)
  assert.equal(qqbot.properties.media.properties.maxTotalBytes.maximum, 209715200)
  assert.equal(qqbot.properties.media.properties.maxAttachments.maximum, 16)
  assert.equal(channel.properties.allowedUsers.items.type, 'string')
  assert.equal(qqbot.properties.allowAllUsers.type, 'boolean')
  assert.deepEqual(Object.keys(channels.patternProperties), ['^telegram$', '^matrix$', '^wework$', '^weixin$', '^qqbot$'])
  const telegramByKey = channels.patternProperties['^telegram$']
  const keyFallback = telegramByKey.allOf.at(-1)
  assert.equal(keyFallback.if.anyOf[0].not.required[0], 'type')
  assert.equal(keyFallback.if.anyOf[1].properties.type.pattern, '^\\s*$')
  assert.equal(keyFallback.then.properties.botToken.type, 'string')
  const vectorMaintenance = schemas.APP_CONFIG_SCHEMA.properties.vectorMaintenance
  assert.equal(vectorMaintenance.oneOf.some((entry) => entry.type === 'boolean'), true)
  assert.equal(vectorMaintenance.oneOf.find((entry) => entry.type === 'object').properties.retentionHours.minimum, 1)
  const vector = schemas.APP_CONFIG_SCHEMA.properties.vector
  assert.equal(vector.oneOf.some((entry) => entry.const === false), true)
  assert.equal(vector.oneOf.find((entry) => entry.type === 'object').properties.baseUrl.pattern, '^https?://')
  const nodeProvider = schemas.APP_CONFIG_SCHEMA.properties.nodeProviders.additionalProperties
  assert.equal(nodeProvider.oneOf.length, 2)
  const executableNodeProvider = nodeProvider.oneOf.find((entry) => entry.properties.type.const === 'executable')
  const dockerWorktreeNodeProvider = nodeProvider.oneOf.find((entry) => entry.properties.type.const === 'docker-worktree')

  assert.equal(executableNodeProvider.additionalProperties, false)
  assert.deepEqual(executableNodeProvider.required, ['type', 'command'])
  assert.deepEqual(executableNodeProvider.properties.command, {
    type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S(?:.*\\S)?$',
  })
  assert.equal(executableNodeProvider.properties.args.maxItems, 64)
  assert.equal(executableNodeProvider.properties.args.items.maxLength, 4096)
  assert.deepEqual(executableNodeProvider.properties.timeoutSeconds, {
    type: 'integer', minimum: 1, maximum: 300, default: 90,
  })

  assert.equal(dockerWorktreeNodeProvider.additionalProperties, false)
  assert.deepEqual(dockerWorktreeNodeProvider.required, ['type', 'command', 'image', 'allowedWorktreeRoots'])
  assert.equal(dockerWorktreeNodeProvider.properties.command.minLength, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.command.maxLength, 4096)
  assert.equal(dockerWorktreeNodeProvider.properties.command.pattern, '^\\S(?:.*\\S)?$')
  assert.equal(dockerWorktreeNodeProvider.properties.args.maxItems, 64)
  assert.equal(dockerWorktreeNodeProvider.properties.args.items.maxLength, 4096)
  assert.equal(dockerWorktreeNodeProvider.properties.image.minLength, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.image.maxLength, 4096)
  assert.equal(dockerWorktreeNodeProvider.properties.allowedWorktreeRoots.minItems, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.allowedWorktreeRoots.maxItems, 64)
  assert.equal(dockerWorktreeNodeProvider.properties.allowedWorktreeRoots.items.minLength, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.allowedWorktreeRoots.items.maxLength, 4096)
  assert.deepEqual(dockerWorktreeNodeProvider.properties.networkModes.default, ['none'])
  assert.equal(dockerWorktreeNodeProvider.properties.networkModes.minItems, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.networkModes.uniqueItems, true)
  assert.deepEqual(dockerWorktreeNodeProvider.properties.networkModes.items.enum, ['none', 'bridge'])
  assert.equal(dockerWorktreeNodeProvider.properties.stateDir.minLength, 1)
  assert.equal(dockerWorktreeNodeProvider.properties.stateDir.maxLength, 4096)
  assert.deepEqual(dockerWorktreeNodeProvider.properties.memory, {
    type: 'string', pattern: '^[1-9]\\d*[kKmMgG]$', default: '2g',
  })
  assert.deepEqual(dockerWorktreeNodeProvider.properties.cpus, {
    type: 'number', exclusiveMinimum: 0, maximum: 64, default: 2,
  })
  assert.deepEqual(dockerWorktreeNodeProvider.properties.pidsLimit, {
    type: 'integer', minimum: 16, maximum: 65536, default: 256,
  })
  assert.deepEqual(dockerWorktreeNodeProvider.properties.tmpfsSize, {
    type: 'string', pattern: '^[1-9]\\d*[kKmMgG]$', default: '256m',
  })

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
  const validNodeProviderFixtures = [
    { nodeProviders: { sandbox: { type: 'executable', command: '/opt/provider', args: ['serve', ''], timeoutSeconds: 300 } } },
    { nodeProviders: { worktrees: {
      type: 'docker-worktree', command: 'sudo', args: ['-n', 'docker'], image: 'foxwarm-sandbox:fixed',
      allowedWorktreeRoots: ['/srv/worktrees'], networkModes: ['none', 'bridge'], stateDir: '/var/lib/foxwarm/provider',
      memory: '4g', cpus: 3.5, pidsLimit: 512, tmpfsSize: '128m',
    } } },
  ]
  for (const fixture of validNodeProviderFixtures) assert.equal(validateAppConfigSchema(fixture), true)

  const invalidNodeProviderFixtures = [
    { nodeProviders: { sandbox: { type: 'executable', command: '/opt/provider', secret: true } } },
    { nodeProviders: { sandbox: { type: 'executable', command: '/opt/provider', timeoutSeconds: 301 } } },
    { nodeProviders: { worktrees: { type: 'docker-worktree', command: 'docker', image: 'fixed' } } },
    { nodeProviders: { worktrees: { type: 'docker-worktree', command: 'docker', image: 'fixed', allowedWorktreeRoots: [], networkModes: ['host'] } } },
    { nodeProviders: { worktrees: { type: 'docker-worktree', command: 'docker', image: 'fixed', allowedWorktreeRoots: ['/srv/worktrees'], cpus: 0 } } },
    { nodeProviders: { worktrees: { type: 'docker-worktree', command: 'docker', image: 'fixed', allowedWorktreeRoots: ['/srv/worktrees'], mounts: ['/host'] } } },
  ]
  for (const fixture of invalidNodeProviderFixtures) assert.equal(validateAppConfigSchema(fixture), false)
  assert.equal(validateAppConfigSchema({ llm: { compactKeepPercent: 0.3, compactThresholdPercent: 0.85 } }), true)
  assert.equal(validateAppConfigSchema({ llm: { compactKeepPercent: 0 } }), false)
  assert.equal(validateAppConfigSchema({ llm: { compactThresholdPercent: 1.1 } }), false)
  assert.equal(validateAppConfigSchema({ vector: true }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupContextLimit: 51 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupBatchWindowMs: 249 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qq: { type: 'qqbot', groupBatchWindowMs: 0 } } }), true)
  assert.equal(validateAppConfigSchema({ channels: { qqbot: { groupContextLimit: 51 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qqbot: { type: '', groupContextLimit: 51 } } }), false)
  assert.equal(validateAppConfigSchema({ channels: { qqbot: { type: ' matrix ', groupContextLimit: 51, homeserver: 'https://matrix.example' } } }), true)
  assert.equal(validateAppConfigSchema({ channels: { custom: { type: 'custom-platform', groupContextLimit: 51, extension: true } } }), true)
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
          models: [{ id: 'model-a', historyReasoningField: 'reasoning_content' }],
          historyReasoningField: 'reasoning',
          effort: { allowed: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
          webSearch: true,
          imageGeneration: { enabled: true, outputFormat: 'png' },
          extraHeaders: { nested: { supportedByLoader: true }, numeric: 42 },
          customExtension: { enabled: true },
        },
      },
    },
    {
      providers: {
        modelOverride: {
          providerType: 'openai-responses',
          models: [{ id: 'model-a', webSearch: false, imageGeneration: true }],
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
    assert.equal(validateSharedModelsSchema(fixture), true, JSON.stringify(validateSharedModelsSchema.errors))
  }
  const invalidFixtures = [
    { providers: { empty: '   ' } },
    { providers: { invalid: { providerType: 'openai-completions', models: ['model'], historyReasoningField: 'other' } } },
    { providers: { invalid: { providerType: 'openai-responses', models: ['model'], historyReasoningField: 'reasoning' } } },
    { providers: { invalid: { providerType: 'openai-responses', models: [{ id: 'model', historyReasoningField: 'reasoning' }] } } },
    { providers: { invalid: { providerType: 'anthropic', model: [{ id: 'model', historyReasoningField: 'reasoning_content' }] } } },
    { providers: { invalid: { providerType: 'company-protocol', models: [{ id: 'model', historyReasoningField: 'reasoning' }] } } },
  ]
  for (const fixture of invalidFixtures) {
    assert.equal(validateModelsSchema(fixture), false)
    assert.equal(validateSharedModelsSchema(fixture), false)
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

test('Setup lets both YAML editors fill their flex-owned panel space', async () => {
  const setupSource = await readFile(path.join(webuiRoot, 'src/components/SetupView.tsx'), 'utf8')
  assert.doesNotMatch(setupSource, /SETUP_EDITOR_HEIGHT|calc\(min\(600px, 80vh\)\)/)
  assert.equal((setupSource.match(/height="100%"/g) || []).length, 2)
  assert.equal((setupSource.match(/mt-4 min-h-72 flex-1/g) || []).length, 2)
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
  assert.equal(provider.properties.imageGeneration.oneOf.some((entry) => entry.type === 'boolean'), true)
  const imageGenerationOptions = provider.properties.imageGeneration.oneOf.find((entry) => entry.type === 'object')
  assert.equal(imageGenerationOptions.properties.enabled.type, 'boolean')
  assert.deepEqual(imageGenerationOptions.properties.action.enum, ['auto', 'generate', 'edit'])
  assert.deepEqual(imageGenerationOptions.properties.quality.enum, ['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(imageGenerationOptions.properties.background.enum, ['auto', 'opaque', 'transparent'])
  assert.deepEqual(imageGenerationOptions.properties.outputFormat.enum, ['png', 'jpeg', 'webp'])
  assert.equal(imageGenerationOptions.properties.outputCompression.minimum, 0)
  assert.equal(imageGenerationOptions.properties.outputCompression.maximum, 100)
  assert.equal(provider.allOf[0].then.not.anyOf.some((rule) => rule.required.includes('webSearch')), true)
  assert.equal(provider.allOf[0].then.not.anyOf.some((rule) => rule.required.includes('effort')), true)
  assert.equal(provider.allOf[0].then.not.anyOf.some((rule) => rule.required.includes('imageGeneration')), true)
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

test('provider model completion context uses only the current concrete provider and preserves scalar quotes', () => {
  const yaml = `providers:
  open:
    providerType: openai-completions
    baseUrl: https://open.test/v1
    apiKey: open-secret
    extraHeaders:
      X-Project: project-a
    models:
      - 'gpt-5.6/x'
  anthropic:
    providerType: anthropic
    apiKey: anthropic-secret
    models:
      - id: claude-
  route:
    providerType: failover
    targets: [open]
    models:
      - should-not-request
`
  const quotedStart = yaml.indexOf("'gpt-5.6/x'")
  const open = completions.getProviderModelCompletionContext(yaml, quotedStart + 5)
  assert.deepEqual(open, {
    providerKey: 'open',
    connection: {
      providerType: 'openai-completions',
      baseUrl: 'https://open.test/v1',
      apiKey: 'open-secret',
      extraHeaders: { 'X-Project': 'project-a' },
    },
    replaceStartOffset: quotedStart + 1,
    replaceEndOffset: quotedStart + "'gpt-5.6/x'".length - 1,
  })
  const anthropicOffset = yaml.indexOf('claude-') + 'claude-'.length
  assert.equal(completions.getProviderModelCompletionContext(yaml, anthropicOffset).providerKey, 'anthropic')
  assert.equal(completions.getProviderModelCompletionContext(yaml, yaml.indexOf('should-not-request') + 3), null)
  assert.equal(completions.getProviderModelCompletionContext(yaml, yaml.indexOf('targets:') + 2), null)
})

test('provider model completion context handles empty, partial, and legacy model values without stale fallback', () => {
  const current = `providers:
  partial:
    providerType: openai-responses
    models:
      - ft:gpt-5.6/
      - id:\x20
`
  const partialOffset = current.indexOf('ft:gpt-5.6/') + 'ft:gpt-5.6/'.length
  const partial = completions.getProviderModelCompletionContext(current, partialOffset)
  assert.equal(current.slice(partial.replaceStartOffset, partial.replaceEndOffset), 'ft:gpt-5.6/')
  const emptyOffset = current.indexOf('      - id: ') + '      - id: '.length
  const empty = completions.getProviderModelCompletionContext(current, emptyOffset)
  assert.equal(empty.providerKey, 'partial')
  assert.equal(empty.replaceStartOffset, empty.replaceEndOffset)

  const legacy = `models:
  old:
    provider: anthropic
    model:\x20
`
  const legacyOffset = legacy.indexOf('    model: ') + '    model: '.length
  assert.deepEqual(completions.getProviderModelCompletionContext(legacy, legacyOffset).connection, { providerType: 'anthropic' })
  assert.equal(completions.getProviderModelCompletionContext('providers:\n  broken: [\n', 20), null)

  const ambiguous = `providers:
  valid:
    providerType: openai
    apiKey: saved-looking-key
    models: [one]
  invalid:
    providerType: openai
    apiKey: [not, scalar]
    models: [two]
`
  assert.equal(completions.getProviderModelCompletionContext(ambiguous, ambiguous.indexOf('two') + 2), null)
  const duplicate = `providers:
  repeated:
    providerType: openai
    apiKey: first
    apiKey: second
    models: [three]
`
  assert.equal(completions.getProviderModelCompletionContext(duplicate, duplicate.indexOf('three') + 3), null)
})

test('provider model requests are completion-time only, cache successes and failures, and isolate connection changes', async () => {
  let provider
  const monaco = {
    languages: {
      CompletionItemKind: { Value: 12 },
      registerCompletionItemProvider(_language, value) {
        provider = value
        return { dispose() {} }
      },
    },
  }
  const calls = []
  let fail = false
  const support = completions.createModelsYamlCompletionProvider(monaco, async (connection) => {
    calls.push(connection)
    if (fail) throw new Error('unavailable')
    return ['gpt-5.6/x', 'gpt-5.6/x', 'ft:gpt-5.6']
  })
  assert.equal(calls.length, 0)

  const makeModel = (apiKey) => {
    const value = `providers:\n  open:\n    providerType: openai-completions\n    apiKey: ${apiKey}\n    models:\n      - gpt-5.\n`
    return {
      uri: { toString: () => schemas.MODELS_YAML_MODEL_URI },
      getLinesContent: () => value.split('\n'),
      getValue: () => value,
      getVersionId: () => 1,
      getOffsetAt: () => value.indexOf('gpt-5.') + 'gpt-5.'.length,
      getPositionAt(offset) {
        const before = value.slice(0, offset).split('\n')
        return { lineNumber: before.length, column: before.at(-1).length + 1 }
      },
    }
  }
  const position = { lineNumber: 6, column: 15 }
  const token = { isCancellationRequested: false }
  let result = await provider.provideCompletionItems(makeModel('first-secret'), position, { triggerKind: 0 }, token)
  assert.equal(calls.length, 1)
  assert.deepEqual(result.suggestions.map(item => item.label), ['gpt-5.6/x', 'ft:gpt-5.6'])
  assert.equal(result.suggestions[0].range.startColumn, 9)
  await provider.provideCompletionItems(makeModel('first-secret'), position, { triggerKind: 0 }, token)
  assert.equal(calls.length, 1)
  await provider.provideCompletionItems(makeModel('second-secret'), position, { triggerKind: 0 }, token)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].apiKey, 'second-secret')

  fail = true
  result = await provider.provideCompletionItems(makeModel('failure-secret'), position, { triggerKind: 0 }, token)
  assert.deepEqual(result.suggestions, [])
  await provider.provideCompletionItems(makeModel('failure-secret'), position, { triggerKind: 0 }, token)
  assert.equal(calls.length, 3)
  support.dispose()
})

test('provider model inflight requests merge and editor removal aborts late results', async () => {
  let provider
  const monaco = {
    languages: {
      CompletionItemKind: { Value: 12 },
      registerCompletionItemProvider(_language, value) {
        provider = value
        return { dispose() {} }
      },
    },
  }
  let calls = 0
  let release
  let aborted = false
  const support = completions.createModelsYamlCompletionProvider(monaco, (_connection, signal) => {
    calls += 1
    return new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      }, { once: true })
    })
  })
  const value = 'providers:\n  open:\n    providerType: openai\n    models:\n      - gpt\n'
  const model = {
    uri: { toString: () => schemas.MODELS_YAML_MODEL_URI },
    getLinesContent: () => value.split('\n'),
    getValue: () => value,
    getVersionId: () => 1,
    getOffsetAt: () => value.indexOf('gpt') + 3,
    getPositionAt: () => ({ lineNumber: 5, column: 9 }),
  }
  const token = { isCancellationRequested: false }
  const first = provider.provideCompletionItems(model, { lineNumber: 5, column: 12 }, { triggerKind: 0 }, token)
  const second = provider.provideCompletionItems(model, { lineNumber: 5, column: 12 }, { triggerKind: 0 }, token)
  assert.equal(calls, 1)
  release(['one'])
  assert.deepEqual((await first).suggestions.map(item => item.label), ['one'])
  assert.deepEqual((await second).suggestions.map(item => item.label), ['one'])

  const changedValue = value.replace('openai', 'openai-responses')
  const late = provider.provideCompletionItems({
    ...model,
    getValue: () => changedValue,
    getLinesContent: () => changedValue.split('\n'),
    getOffsetAt: () => changedValue.indexOf('gpt') + 3,
  }, { lineNumber: 5, column: 12 }, { triggerKind: 0 }, token)
  assert.equal(calls, 2)
  support.remove(schemas.MODELS_YAML_MODEL_URI)
  assert.equal(aborted, true)
  assert.deepEqual((await late).suggestions, [])
  support.dispose()
})
