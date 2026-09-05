import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { buildModelsConfigFromSetupForm, validateAppConfigYaml, writeAppConfigWithChannels, writeRawAppConfig, writeRawModelsConfig } from './setupConfig';
import { loadModelsConfigFromObject, normalizeHandoffConfirmationEnabled, normalizeNodeProvidersConfig } from './config';

test('handoff confirmation config defaults off and accepts only booleans', () => {
  assert.equal(normalizeHandoffConfirmationEnabled(undefined), false);
  assert.equal(normalizeHandoffConfirmationEnabled(false), false);
  assert.equal(normalizeHandoffConfirmationEnabled(true), true);
  assert.throws(() => normalizeHandoffConfirmationEnabled('true'), /handoffConfirmation.*boolean/);
  assert.equal(validateAppConfigYaml('').handoffConfirmation, undefined);
  assert.equal(validateAppConfigYaml('handoffConfirmation: false\n').handoffConfirmation, false);
  assert.equal(validateAppConfigYaml('handoffConfirmation: true\n').handoffConfirmation, true);
  assert.throws(() => validateAppConfigYaml('handoffConfirmation: yes\n'), /handoffConfirmation.*boolean/);
});

test('raw models setup save writes the provided YAML text exactly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-models-'));
  const filePath = path.join(dir, 'models.yaml');
  const rawYaml = `# keep top-level comment
default: "openai/gpt-5.2-codex"
providers:
  openai:
    # keep provider comment
    providerType: "openai-completions"
    historyReasoningField: "reasoning"
    baseUrl: "https://example.test/v1"
    customProviderField: true
    models:
      - id: "gpt-5.2-codex"
        historyReasoningField: "reasoning_content"
        contextLimit: 400000
        customModelField: "keep"
`;

  writeRawModelsConfig(rawYaml, filePath);

  assert.equal(await fs.readFile(filePath, 'utf8'), rawYaml);
  const loaded = loadModelsConfigFromObject(yaml.load(rawYaml));
  assert.equal(loaded.models.openai.historyReasoningField, 'reasoning_content');
  await fs.remove(dir);
});

test('raw models setup preserves virtual provider YAML byte-for-byte after validation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-virtual-models-'));
  const filePath = path.join(dir, 'models.yaml');
  const rawYaml = `# virtual route comment
default: sticky
providers:
  leaf:
    providerType: anthropic
    baseUrl: https://example.test
    models: [model-a]
  sticky:
    providerType: session-hash
    targets:
      - leaf/model-a
`;

  writeRawModelsConfig(rawYaml, filePath);

  assert.equal(await fs.readFile(filePath, 'utf8'), rawYaml);
  await fs.remove(dir);
});

test('raw models setup preserves provider string alias YAML byte-for-byte after validation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-alias-models-'));
  const filePath = path.join(dir, 'models.yaml');
  const rawYaml = `# alias shorthand comment
default: fast
providers:
  leaf:
    providerType: anthropic
    baseUrl: https://example.test
    models: [org/model-a]
  fast: "leaf/org/model-a" # keep inline comment
`;

  writeRawModelsConfig(rawYaml, filePath);

  assert.equal(await fs.readFile(filePath, 'utf8'), rawYaml);
  await fs.remove(dir);
});

test('raw app config setup save writes the provided YAML text exactly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-config-'));
  const filePath = path.join(dir, 'config.yaml');
  const rawYaml = `# keep app config comment
bot:
  name: foxwarm
channels:
  # keep channel comment
  telegram:
    type: telegram
    enabled: true
    botToken: "123456:token"
    customChannelField: "keep"
`;

  writeRawAppConfig(rawYaml, filePath);

  assert.equal(await fs.readFile(filePath, 'utf8'), rawYaml);
  await fs.remove(dir);
});

test('raw app config setup validates current compaction percentages and preserves YAML text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-compaction-'));
  const filePath = path.join(dir, 'config.yaml');
  const rawYaml = `# keep compaction comment
llm:
  compactKeepPercent: 0.4
  compactThresholdPercent: 0.9
`;

  const parsed = writeRawAppConfig(rawYaml, filePath);

  assert.equal(parsed.llm?.compactKeepPercent, 0.4);
  assert.equal(parsed.llm?.compactThresholdPercent, 0.9);
  assert.equal(await fs.readFile(filePath, 'utf8'), rawYaml);
  await fs.remove(dir);
});

test('app config validates bounded per-instance ordinary-text channel progress', () => {
  const parsed = validateAppConfigYaml(`channels:\n  telegram-a:\n    type: telegram\n    channelProgress:\n      intervalMs: 60000\n  telegram-b:\n    type: telegram\n    channelProgress: false\n`);
  assert.equal((parsed.channels?.['telegram-a'] as any).channelProgress.intervalMs, 60_000);
  assert.equal((parsed.channels?.['telegram-b'] as any).channelProgress, false);
  for (const value of ['true', '{}', '{ intervalMs: 29999 }', '{ intervalMs: 1800001 }', '{ intervalMs: 60000.5 }']) {
    assert.throws(
      () => validateAppConfigYaml(`channels:\n  telegram:\n    type: telegram\n    channelProgress: ${value}\n`),
      /channels\.telegram\.channelProgress/,
    );
  }
});

test('raw app config setup rejects invalid compaction percentages', () => {
  for (const [field, value] of [
    ['compactKeepPercent', 'true'],
    ['compactKeepPercent', '"0.5"'],
    ['compactKeepPercent', '.inf'],
    ['compactKeepPercent', '0'],
    ['compactKeepPercent', '1.1'],
    ['compactThresholdPercent', 'true'],
    ['compactThresholdPercent', '"0.85"'],
    ['compactThresholdPercent', '.nan'],
    ['compactThresholdPercent', '-0.1'],
    ['compactThresholdPercent', '1.1'],
  ]) {
    assert.throws(
      () => validateAppConfigYaml(`llm:\n  ${field}: ${value}\n`),
      new RegExp(`llm\\.${field}.*finite number`),
    );
  }
});

test('app config validates startup executable Node providers with fixed trusted commands', () => {
  const parsed = validateAppConfigYaml(`nodeProviders:
  sandbox-script:
    type: executable
    command: /opt/example/provider
    args: [serve, ""]
    timeoutSeconds: 45
`);
  assert.deepEqual(normalizeNodeProvidersConfig(parsed.nodeProviders), [{
    id: 'sandbox-script',
    type: 'executable',
    command: '/opt/example/provider',
    args: ['serve', ''],
    timeoutMs: 45_000,
  }]);
  assert.deepEqual(normalizeNodeProvidersConfig(undefined), []);
  const defaulted = normalizeNodeProvidersConfig({
    defaulted: { type: 'executable', command: '/opt/example/provider' },
  })[0];
  assert.equal(defaulted.type === 'executable' ? defaulted.timeoutMs : 0, 90_000);
});

test('app config rejects malformed executable Node provider definitions', () => {
  for (const [yaml, pattern] of [
    ['nodeProviders: []\n', /nodeProviders.*object/],
    ['nodeProviders:\n  bad id:\n    type: executable\n    command: provider\n', /provider id/],
    ['nodeProviders:\n  p:\n    type: socket\n    command: provider\n', /type.*executable/],
    ['nodeProviders:\n  p:\n    type: executable\n    command: ""\n', /command.*non-empty/],
    ['nodeProviders:\n  p:\n    type: executable\n    command: provider\n    args: value\n', /args.*array/],
    ['nodeProviders:\n  p:\n    type: executable\n    command: provider\n    timeoutSeconds: 0\n', /timeoutSeconds.*between/],
    ['nodeProviders:\n  p:\n    type: executable\n    command: provider\n    secret: value\n', /unsupported field.*secret/],
  ] as const) {
    assert.throws(() => validateAppConfigYaml(yaml), pattern);
  }
});

test('app config validates strict Docker worktree Node provider settings', () => {
  const parsed = validateAppConfigYaml(`nodeProviders:
  worktrees:
    type: docker-worktree
    command: sudo
    args: [-n, docker]
    image: sandbox:fixed
    allowedWorktreeRoots: [/srv/worktrees]
    networkModes: [none, bridge]
    memory: 4g
    cpus: 3
    pidsLimit: 512
    tmpfsSize: 128m
`);
  const normalized = normalizeNodeProvidersConfig(parsed.nodeProviders)[0];
  assert.equal(normalized.type, 'docker-worktree');
  if (normalized.type === 'docker-worktree') {
    assert.deepEqual(normalized.args, ['-n', 'docker']);
    assert.deepEqual(normalized.networkModes, ['none', 'bridge']);
    assert.equal(normalized.image, 'sandbox:fixed');
  }
});

test('app config rejects model-mutable Docker worktree authority fields', () => {
  for (const yaml of [
    `nodeProviders:\n  p:\n    type: docker-worktree\n    command: docker\n    image: fixed\n    allowedWorktreeRoots: [/srv/worktrees]\n    mounts: [/host]\n`,
    `nodeProviders:\n  p:\n    type: docker-worktree\n    command: docker\n    image: fixed\n    allowedWorktreeRoots: [/srv/worktrees]\n    networkModes: [host]\n`,
    `nodeProviders:\n  p:\n    type: docker-worktree\n    command: docker\n    image: fixed\n    allowedWorktreeRoots: []\n`,
  ]) assert.throws(() => validateAppConfigYaml(yaml));
});

test('models setup form preserves unknown provider and model fields', () => {
  const existing = {
    default: 'openai/gpt-5.2-codex',
    topLevelCustom: 'keep',
    providers: {
      openai: {
        providerType: 'openai-completions',
        baseUrl: 'https://old.example.test/v1',
        apiKey: 'old-key',
        customProviderField: { nested: true },
        extraFields: {
          providerExtra: 'keep',
        },
        historyReasoningField: 'reasoning',
        webSearch: {
          enabled: true,
          toolChoice: 'auto',
        },
        models: [
          {
            id: 'gpt-5.2-codex',
            contextLimit: 400000,
            customModelField: 'keep',
          },
          'gpt-5.3-codex',
        ],
      },
    },
  };

  const next = buildModelsConfigFromSetupForm({
    defaultModel: 'openai/gpt-5.2-codex',
    providers: [{
      id: 'openai',
      providerType: 'openai-responses',
      baseUrl: 'https://new.example.test/v1',
      apiKey: 'new-key',
      models: 'gpt-5.2-codex\ngpt-5.4',
    }],
  }, existing);

  assert.equal(next.topLevelCustom, 'keep');
  assert.equal(next.providers?.openai.providerType, 'openai-responses');
  assert.equal(next.providers?.openai.baseUrl, 'https://new.example.test/v1');
  assert.equal(next.providers?.openai.apiKey, 'new-key');
  assert.deepEqual((next.providers?.openai as any).customProviderField, { nested: true });
  assert.deepEqual(next.providers?.openai.extraFields, { providerExtra: 'keep' });
  assert.equal(next.providers?.openai.historyReasoningField, undefined);
  assert.deepEqual(next.providers?.openai.webSearch, { enabled: true, toolChoice: 'auto' });
  assert.deepEqual(next.providers?.openai.models?.[0], {
    id: 'gpt-5.2-codex',
    contextLimit: 400000,
    customModelField: 'keep',
  });
  assert.equal(next.providers?.openai.models?.[1], 'gpt-5.4');

  const loaded = loadModelsConfigFromObject(next);
  assert.equal(loaded.default, 'openai/gpt-5.2-codex');
});

test('models setup removes provider-only web search when converting a concrete provider to virtual routing', () => {
  const next = buildModelsConfigFromSetupForm({
    defaultModel: 'route',
    providers: [{
      id: 'route',
      providerType: 'session-hash',
      targets: 'leaf/model-a',
    }, {
      id: 'leaf',
      providerType: 'openai-completions',
      models: 'model-a',
    }],
  }, {
    default: 'route',
    providers: {
      route: {
        providerType: 'openai-responses',
        webSearch: { enabled: true },
        models: ['model-a'],
      },
      leaf: { providerType: 'openai-completions', models: ['model-a'] },
    },
  });

  assert.equal((next.providers?.route as any).webSearch, undefined);
  assert.doesNotThrow(() => loadModelsConfigFromObject(next));
});

test('structured models setup accepts virtual providers and preserves their routing fields', () => {
  const existing = {
    default: 'concrete',
    providers: {
      concrete: {
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
        models: ['model-a', 'model-b'],
      },
    },
  };

  const next = buildModelsConfigFromSetupForm({
    default: 'fallback',
    providers: [
      {
        id: 'concrete',
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
        models: 'model-a\nmodel-b',
      },
      {
        id: 'sticky',
        providerType: 'session-hash',
        targets: ['concrete/model-a'],
      },
      {
        id: 'fallback',
        providerType: 'failover',
        targets: 'concrete/model-a\nconcrete/model-b',
        failureThreshold: '7',
        cooldownMs: '12345',
      },
    ],
  }, existing);

  assert.deepEqual(next.providers?.sticky, {
    providerType: 'session-hash',
    targets: ['concrete/model-a'],
  });
  assert.deepEqual(next.providers?.fallback, {
    providerType: 'failover',
    targets: ['concrete/model-a', 'concrete/model-b'],
    failureThreshold: 7,
    cooldownMs: 12345,
  });
});

test('structured setup conversion between concrete and virtual removes incompatible fields', () => {
  const next = buildModelsConfigFromSetupForm({
    default: 'route',
    providers: [
      {
        id: 'leaf',
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        models: 'model-a',
      },
      {
        id: 'route',
        providerType: 'session-hash',
        targets: ['leaf/model-a'],
      },
    ],
  }, {
    providers: {
      route: {
        providerType: 'openai-completions',
        baseUrl: 'https://old.test/v1',
        apiKey: 'old-secret',
        contextLimit: 1234,
        effort: { allowed: ['low', 'high'], default: 'high' },
        asyncCompact: false,
        models: ['old-model'],
        extraFields: { old: true },
      },
    },
  });

  assert.deepEqual(next.providers?.route, {
    providerType: 'session-hash',
    targets: ['leaf/model-a'],
  });
});

test('structured virtual setup rejects failover fields on session-hash and non-positive or fractional failover values', () => {
  const baseProviders = [{
    id: 'leaf',
    providerType: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    models: 'model-a\nmodel-b',
  }];
  assert.throws(
    () => buildModelsConfigFromSetupForm({
      default: 'route',
      providers: [...baseProviders, {
        id: 'route',
        providerType: 'session-hash',
        targets: ['leaf/model-a'],
        failureThreshold: 1,
      }],
    }),
    /session-hash.*forbids failover field `failureThreshold`/,
  );

  for (const [field, value] of [['failureThreshold', '1.5'], ['failureThreshold', '0'], ['cooldownMs', '1.5'], ['cooldownMs', '0']] as const) {
    assert.throws(
      () => buildModelsConfigFromSetupForm({
        default: 'route',
        providers: [...baseProviders, {
          id: 'route',
          providerType: 'failover',
          targets: ['leaf/model-a', 'leaf/model-b'],
          [field]: value,
        }],
      }),
      new RegExp(`${field} must be a positive integer`),
    );
  }
});

test('structured channel setup updates channels without rewriting unrelated config text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-channels-'));
  const filePath = path.join(dir, 'config.yaml');
  const rawYaml = `# keep leading comment
bot:
  name: foxwarm

# keep comment before channels
channels:
  old:
    type: telegram
    enabled: false

# keep trailing section
asrService:
  enabled: false
`;
  await fs.writeFile(filePath, rawYaml, 'utf8');

  writeAppConfigWithChannels({
    telegram: {
      type: 'telegram',
      enabled: true,
      botToken: '123456:token',
      customChannelField: 'keep',
    },
  }, filePath);

  const saved = await fs.readFile(filePath, 'utf8');
  assert.match(saved, /^# keep leading comment\nbot:\n  name: foxwarm/m);
  assert.match(saved, /# keep trailing section\nasrService:\n  enabled: false\n?$/m);
  assert.match(saved, /channels:\n  telegram:\n    type: telegram\n    enabled: true\n    botToken: 123456:token\n    customChannelField: keep/m);
  await fs.remove(dir);
});
