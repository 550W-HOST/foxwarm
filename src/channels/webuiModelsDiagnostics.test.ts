import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getModelsSetupDiagnostics } from './webuiChannel';

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
