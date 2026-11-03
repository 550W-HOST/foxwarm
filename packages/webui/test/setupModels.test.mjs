import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-setup-models-test-'))
const bundledPath = path.join(tempDir, 'setupModels.cjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/setupModels.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  addModel,
  buildModelSetupYaml,
  connectionTestRequest,
  defaultModelsYaml,
  describeModelLimits,
  formFromPreset,
  isPlaceholderApiKey,
  presetFor,
  readListedModels,
  readModelSetupForm,
  removeModel,
  requiresApiKey,
  validateModelSetupForm,
} = await import(pathToFileURL(bundledPath).href)
const { parse } = await import('yaml')

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const ids = (...values) => values.map((id) => ({ id }))

const form = (overrides = {}) => ({
  providerId: 'leaf',
  providerType: 'openai-completions',
  baseUrl: 'https://gateway.example.test/v1',
  apiKey: 'secret',
  models: ids('model-a', 'model-b'),
  defaultModel: 'model-a',
  ...overrides,
})

test('generated first-run YAML is the OpenAI preset with an API key placeholder line', () => {
  const yaml = defaultModelsYaml()
  assert.match(yaml, /^default: "openai\/gpt-5\.6-sol"$/m)
  assert.match(yaml, /^ {4}apiKey: "your-openai-api-key"$/m)
  const reading = readModelSetupForm(yaml)
  assert.equal(reading.ok, true)
  assert.deepEqual(reading.form.models, ids('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'))
  assert.equal(presetFor(reading.form).id, 'openai')
  assert.equal(validateModelSetupForm(reading.form), 'Replace the placeholder API key with your key.')
})

test('form output round-trips exactly through YAML for every API type and incomplete drafts', () => {
  const drafts = [
    form(),
    form({ providerType: 'openai-responses', providerId: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    form({ providerType: 'anthropic', providerId: 'claude', baseUrl: 'https://api.anthropic.com', models: [{ id: 'claude-opus-5', contextLimit: 1000000, maxOutput: 128000 }], defaultModel: 'claude-opus-5' }),
    form({ providerId: 'openrouter', models: [{ id: 'anthropic/claude-opus-5', contextLimit: 200000 }, { id: 'x:free' }, { id: 'y', maxOutput: 8192 }], defaultModel: 'anthropic/claude-opus-5' }),
    form({ apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1' }),
    form({ models: [], defaultModel: '' }),
    form({ baseUrl: '', apiKey: 'quote " and \\ backslash: # not a comment' }),
    form({ providerId: 'with space', defaultModel: 'model-b' }),
  ]
  for (const draft of drafts) {
    const yaml = buildModelSetupYaml(draft)
    const reading = readModelSetupForm(yaml)
    assert.equal(reading.ok, true, yaml)
    assert.deepEqual(reading.form, draft)
    assert.equal(buildModelSetupYaml(reading.form), yaml)
  }
})

test('hand-written single-provider files are read when every value fits the form', () => {
  const yaml = 'default: local/m\nproviders:\n  local:\n    providerType: openai-completions\n    baseUrl: http://localhost:8080/v1\n    models: [m, n]\n'
  const reading = readModelSetupForm(yaml)
  assert.equal(reading.ok, true)
  assert.deepEqual(reading.form, { providerId: 'local', providerType: 'openai-completions', baseUrl: 'http://localhost:8080/v1', apiKey: '', models: ids('m', 'n'), defaultModel: 'm' })
  // Writing back keeps every configured value; an omitted key is the server's empty key.
  const written = parse(buildModelSetupYaml(reading.form))
  assert.deepEqual(written, { ...parse(yaml), providers: { local: { ...parse(yaml).providers.local, apiKey: '' } } })
})

test('files the form cannot represent faithfully stay in YAML', () => {
  const base = 'default: a/m\nproviders:\n  a:\n    providerType: openai-completions\n    baseUrl: https://x.test/v1\n    apiKey: k\n    models: [m]\n'
  const cases = {
    comment: base.replace('    apiKey: k\n', '    apiKey: k # rotate monthly\n'),
    leadingComment: `# my models\n${base}`,
    secondProvider: `${base}  b:\n    providerType: anthropic\n    baseUrl: https://y.test\n    models: [c]\n`,
    alias: `${base}  fast: a/m\n`,
    failover: `${base}  route:\n    providerType: failover\n    targets: [a/m, a/m]\n`,
    modelObjectExtraField: base.replace('models: [m]', 'models: [{id: m, maxOutput: 100, reasoning: true}]'),
    modelObjectIdOnly: base.replace('models: [m]', 'models: [{id: m}]'),
    modelObjectFractionalLimit: base.replace('models: [m]', 'models: [{id: m, contextLimit: 1000.5}]'),
    modelObjectStringLimit: base.replace('models: [m]', 'models: [{id: m, contextLimit: "1000"}]'),
    duplicateModelObject: base.replace('models: [m]', 'models: [m, {id: m, contextLimit: 1000}]'),
    extraProviderField: base.replace('    apiKey: k\n', '    apiKey: k\n    extraHeaders: {x-a: b}\n'),
    rootDefaults: `${base}defaults:\n  contextLimit: 1000\n`,
    otherDefault: base.replace('default: a/m', 'default: elsewhere/m'),
    bareDefault: base.replace('default: a/m', 'default: a'),
    legacyProviderType: base.replace('openai-completions', 'openai'),
    websocketType: base.replace('openai-completions', 'openai-ws'),
    duplicateModel: base.replace('[m]', '[m, m]'),
    anchor: base.replace('apiKey: k', 'apiKey: &key k'),
    numberKey: base.replace('apiKey: k', 'apiKey: 12345'),
  }
  for (const [name, yaml] of Object.entries(cases)) {
    const reading = readModelSetupForm(yaml)
    assert.deepEqual(reading, { ok: false, reason: 'unsupported' }, name)
  }
  assert.deepEqual(readModelSetupForm('providers: [\n'), { ok: false, reason: 'invalid' })
  assert.equal(readModelSetupForm(base).ok, true)
  const withLimits = readModelSetupForm(base.replace('models: [m]', 'models: [{id: m, contextLimit: 200000, maxOutput: 64000}, n]'))
  assert.deepEqual(withLimits.ok && withLimits.form.models, [{ id: 'm', contextLimit: 200000, maxOutput: 64000 }, { id: 'n' }])
})

test('declared listing limits are written with the selected model, and only when declared', () => {
  const listed = readListedModels([
    { id: 'claude-a', contextLimit: 1000000, maxOutput: 128000, imageInput: true },
    { id: 'claude-b', contextLimit: 200000, imageInput: false },
    { id: 'plain' },
    'legacy-string',
    { id: 'claude-a', contextLimit: 1 },
    { id: 'bad', contextLimit: -1, maxOutput: 1.5, imageInput: 'yes' },
    { id: '' },
    null,
  ])
  assert.deepEqual(listed, [
    { id: 'claude-a', contextLimit: 1000000, maxOutput: 128000, imageInput: true },
    { id: 'claude-b', contextLimit: 200000, imageInput: false },
    { id: 'plain' },
    { id: 'legacy-string' },
    { id: 'bad' },
  ])
  let draft = { ...formFromPreset('anthropic'), models: [], defaultModel: '', apiKey: 'k' }
  draft = addModel(draft, 'claude-a', listed)
  draft = addModel(draft, 'claude-b', listed)
  draft = addModel(draft, 'plain', listed)
  draft = addModel(draft, 'typed-by-hand', listed)
  // Image input support is listed but not written to the model configuration yet.
  assert.deepEqual(draft.models, [
    { id: 'claude-a', contextLimit: 1000000, maxOutput: 128000 },
    { id: 'claude-b', contextLimit: 200000 },
    { id: 'plain' },
    { id: 'typed-by-hand' },
  ])
  const yaml = buildModelSetupYaml(draft)
  assert.equal(yaml, [
    'default: "anthropic/claude-a"',
    'providers:',
    '  anthropic:',
    '    providerType: "anthropic"',
    '    baseUrl: "https://api.anthropic.com"',
    '    apiKey: "k"',
    '    models:',
    '      - id: "claude-a"',
    '        contextLimit: 1000000',
    '        maxOutput: 128000',
    '      - id: "claude-b"',
    '        contextLimit: 200000',
    '      - "plain"',
    '      - "typed-by-hand"',
    '',
  ].join('\n'))
  assert.deepEqual(readModelSetupForm(yaml), { ok: true, form: draft })
  assert.equal(describeModelLimits(draft.models[0]), '1M context · 128K output')
  assert.equal(describeModelLimits(draft.models[1]), '200K context')
  assert.equal(describeModelLimits({ contextLimit: 131072 }), '128K context')
  assert.equal(describeModelLimits(draft.models[2]), '')
})

test('validation names the first problem that blocks saving', () => {
  assert.equal(validateModelSetupForm(form()), null)
  assert.match(validateModelSetupForm(form({ providerId: 'a/b' })), /provider name/)
  assert.match(validateModelSetupForm(form({ baseUrl: 'api.example.test' })), /API base URL/)
  assert.equal(validateModelSetupForm(form({ apiKey: 'replace-with-your-key' })), 'Replace the placeholder API key with your key.')
  assert.equal(validateModelSetupForm(form({ apiKey: '', baseUrl: 'https://api.openai.com/v1' })), 'Enter your API key.')
  assert.equal(validateModelSetupForm(form({ apiKey: '', baseUrl: 'http://localhost:11434/v1' })), null)
  assert.equal(validateModelSetupForm(form({ apiKey: '', baseUrl: 'https://gateway.example.test/v1' })), null)
  assert.equal(validateModelSetupForm(form({ models: [], defaultModel: '' })), 'Add at least one model.')
  assert.equal(validateModelSetupForm(form({ defaultModel: 'missing' })), 'Choose a default model.')
})

test('placeholder and hosted-endpoint detection matches the server rules', () => {
  for (const key of ['your-openai-key', 'YOUR_API_KEY', 'replace-me', 'changeme', 'sk-...', 'sk-xxxx', '<api key>', 'paste-your-key-here']) {
    assert.equal(isPlaceholderApiKey(key), true, key)
  }
  for (const key of ['', 'sk-proj-abc123', 'ollama', 'none']) assert.equal(isPlaceholderApiKey(key), false, key)
  assert.equal(requiresApiKey('https://api.openai.com/v1'), true)
  assert.equal(requiresApiKey('https://openrouter.ai/api/v1'), true)
  assert.equal(requiresApiKey('https://api.openai.com.example.test/v1'), false)
  assert.equal(requiresApiKey('http://127.0.0.1:1234/v1'), false)
})

test('presets, model editing and connection requests', () => {
  const anthropic = formFromPreset('anthropic')
  assert.deepEqual(anthropic, { providerId: 'anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', models: ids('claude-opus-5'), defaultModel: 'claude-opus-5' })
  assert.equal(presetFor({ providerType: 'openai-completions', baseUrl: 'http://localhost:11434/v1/' }).id, 'ollama')
  assert.equal(presetFor({ providerType: 'openai-responses', baseUrl: 'http://localhost:11434/v1' }).id, 'custom')
  let draft = formFromPreset('openrouter')
  assert.deepEqual(draft.models, [])
  draft = addModel(draft, ' vendor/model-a ')
  draft = addModel(draft, 'vendor/model-b')
  assert.equal(addModel(draft, 'vendor/model-b'), draft)
  assert.equal(draft.defaultModel, 'vendor/model-a')
  draft = removeModel(draft, 'vendor/model-a')
  assert.equal(draft.defaultModel, 'vendor/model-b')
  assert.deepEqual(connectionTestRequest({ ...draft, apiKey: ' key ' }), {
    providerKey: 'openrouter',
    providerType: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'key',
    models: 'vendor/model-b',
    testModel: 'vendor/model-b',
  })
})
