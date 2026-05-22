import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { buildModelsConfigFromSetupForm, writeAppConfigWithChannels, writeRawAppConfig, writeRawModelsConfig } from './setupConfig';
import { loadModelsConfigFromObject } from './config';

test('raw models setup save writes the provided YAML text exactly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-setup-models-'));
  const filePath = path.join(dir, 'models.yaml');
  const rawYaml = `# keep top-level comment
default: "openai/gpt-5.2-codex"
providers:
  openai:
    # keep provider comment
    providerType: "openai-completions"
    baseUrl: "https://example.test/v1"
    customProviderField: true
    models:
      - id: "gpt-5.2-codex"
        contextLimit: 400000
        customModelField: "keep"
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
  assert.deepEqual(next.providers?.openai.models?.[0], {
    id: 'gpt-5.2-codex',
    contextLimit: 400000,
    customModelField: 'keep',
  });
  assert.equal(next.providers?.openai.models?.[1], 'gpt-5.4');

  const loaded = loadModelsConfigFromObject(next);
  assert.equal(loaded.default, 'openai/gpt-5.2-codex');
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
