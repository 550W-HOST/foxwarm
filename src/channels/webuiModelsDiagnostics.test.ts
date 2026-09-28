import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { loadModelsConfigFromObject } from '../config';
import { buildWebUiModelsPayloadFromConfig, getModelsSetupDiagnostics } from './webuiChannel';

test('WebUI model options expose exact provider/model identity and ordered virtual targets without secrets', () => {
  const modelsConfig = loadModelsConfigFromObject({
    default: 'alpha',
    providers: {
      alpha: {
        providerType: 'openai-completions',
        baseUrl: 'https://alpha.test/v1',
        apiKey: 'alpha-secret',
        extraHeaders: { Authorization: 'secret-header' },
        models: ['org/model-a'],
      },
      beta: {
        providerType: 'anthropic',
        apiKey: 'beta-secret',
        models: ['org/model-a'],
      },
      alias: 'alpha/org/model-a',
      sticky: {
        providerType: 'session-hash',
        targets: ['alpha/org/model-a', 'beta/org/model-a'],
      },
      fallback: {
        providerType: 'failover',
        targets: ['beta/org/model-a', 'alpha/org/model-a'],
      },
    },
  });

  const payload = buildWebUiModelsPayloadFromConfig(modelsConfig, 'beta');
  assert.equal(payload.defaultKey, 'alpha');
  assert.equal(payload.currentKey, 'beta');
  const alpha = payload.models.find(item => item.key === 'alpha');
  const beta = payload.models.find(item => item.key === 'beta');
  const alias = payload.models.find(item => item.key === 'alias');
  const fallback = payload.models.find(item => item.key === 'fallback');
  assert.deepEqual({ providerKey: alpha?.providerKey, modelId: alpha?.modelId }, { providerKey: 'alpha', modelId: 'org/model-a' });
  assert.deepEqual({ providerKey: beta?.providerKey, modelId: beta?.modelId }, { providerKey: 'beta', modelId: 'org/model-a' });
  assert.deepEqual({ providerKey: alias?.providerKey, modelId: alias?.modelId, providerType: alias?.providerType, targets: alias?.targets }, {
    providerKey: 'alias', modelId: null, providerType: 'session-hash', targets: ['alpha/org/model-a'],
  });
  assert.deepEqual(fallback?.targets, ['beta/org/model-a', 'alpha/org/model-a']);
  const serialized = JSON.stringify(payload);
  for (const secret of ['alpha-secret', 'beta-secret', 'secret-header', 'https://alpha.test/v1']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('setup diagnostics expose structured virtual routing fields without credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-model-diagnostics-'));
  const modelsPath = path.join(dir, 'models.yaml');
  await fs.writeFile(modelsPath, `
default: fallback
providers:
  leafA:
    providerType: anthropic
    baseUrl: https://a.test
    apiKey: secret-a
    models: [a]
  leafB:
    providerType: anthropic
    baseUrl: https://b.test
    apiKey: secret-b
    models: [b]
  fallback:
    providerType: failover
    targets: [leafA/a, leafB/b]
    failureThreshold: 7
    cooldownMs: 1234
`, 'utf8');

  try {
    const diagnostics = getModelsSetupDiagnostics(modelsPath);
    const fallback = diagnostics.providers.find(provider => provider.id === 'fallback');
    assert.deepEqual(fallback, {
      id: 'fallback',
      providerType: 'failover',
      isVirtual: true,
      baseUrl: '',
      apiKey: '',
      models: '',
      targets: ['leafA/a', 'leafB/b'],
      failureThreshold: 7,
      cooldownMs: 1234,
      defaultModel: '',
    });
  } finally {
    await fs.remove(dir);
  }
});

test('setup diagnostics classify provider string aliases as single-target session-hash entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-model-alias-diagnostics-'));
  const modelsPath = path.join(dir, 'models.yaml');
  await fs.writeFile(modelsPath, `
default: fast
providers:
  leaf:
    providerType: openai-completions
    models: [model-a]
  fast: " leaf/model-a "
`, 'utf8');

  try {
    const diagnostics = getModelsSetupDiagnostics(modelsPath);
    const fast = diagnostics.providers.find(provider => provider.id === 'fast');
    assert.deepEqual(fast, {
      id: 'fast',
      providerType: 'session-hash',
      isVirtual: true,
      baseUrl: '',
      apiKey: '',
      models: '',
      targets: ['leaf/model-a'],
      failureThreshold: null,
      cooldownMs: null,
      defaultModel: '',
    });
  } finally {
    await fs.remove(dir);
  }
});
