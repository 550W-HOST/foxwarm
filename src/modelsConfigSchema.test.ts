import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject } from './config';

test('legacy root models + entry model list schema still works', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'openai/gpt-5.2-codex',
    models: {
      openai: {
        provider: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        apiKey: 'legacy-key',
        model: ['gpt-5.2-codex', 'gpt-5.3-codex'],
        contextLimit: 200000,
      },
    },
  });

  assert.equal(parsed.default, 'openai/gpt-5.2-codex');
  assert.deepEqual(parsed.displayModels, ['openai/gpt-5.2-codex', 'openai/gpt-5.3-codex']);
  assert.equal(parsed.models['openai/gpt-5.2-codex'].providerType, 'openai-completions');
  assert.equal(parsed.models['openai/gpt-5.2-codex'].model, 'gpt-5.2-codex');
  assert.equal(parsed.models['openai/gpt-5.2-codex'].contextLimit, 200000);
});

test('new providers root + models object list applies model overrides and merge rules', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'openai/gpt-5.2-codex',
    providers: {
      openai: {
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        apiKey: 'new-key',
        contextLimit: 200000,
        extraHeaders: {
          'x-provider': 'yes',
          same: 'provider',
        },
        extraFields: {
          reasoning: {
            effort: 'medium',
            summary: 'auto',
          },
          flags: {
            provider: true,
          },
        },
        models: [
          {
            id: 'gpt-5.2-codex',
            contextLimit: 400000,
            extraHeaders: {
              same: 'model',
              'x-model': 'yes',
            },
            extraFields: {
              reasoning: {
                effort: 'high',
              },
              flags: {
                model: true,
              },
            },
          },
          'gpt-5.3-codex',
        ],
      },
    },
  });

  const overrideModel = parsed.models['openai/gpt-5.2-codex'];
  assert.equal(overrideModel.contextLimit, 400000);
  assert.deepEqual(overrideModel.extraHeaders, {
    'x-provider': 'yes',
    same: 'model',
    'x-model': 'yes',
  });
  assert.deepEqual(overrideModel.extraFields, {
    reasoning: {
      effort: 'high',
      summary: 'auto',
    },
    flags: {
      provider: true,
      model: true,
    },
  });

  const inheritedModel = parsed.models['openai/gpt-5.3-codex'];
  assert.equal(inheritedModel.contextLimit, 200000);
  assert.deepEqual(inheritedModel.extraHeaders, {
    'x-provider': 'yes',
    same: 'provider',
  });
  assert.deepEqual(inheritedModel.extraFields, {
    reasoning: {
      effort: 'medium',
      summary: 'auto',
    },
    flags: {
      provider: true,
    },
  });
});

test('single-model provider entries still expose provider key alias and keep displayModels behavior', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'qwen',
    providers: {
      qwen: {
        providerType: 'openai-completions',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'dummy-key',
        models: ['Qwen3.5-35B'],
      },
    },
  });

  assert.equal(parsed.default, 'qwen');
  assert.deepEqual(parsed.displayModels, ['qwen']);
  assert.equal(parsed.models.qwen.model, 'Qwen3.5-35B');
  assert.equal(parsed.models['qwen/Qwen3.5-35B'].model, 'Qwen3.5-35B');
  assert.deepEqual(parsed.models.qwen, parsed.models['qwen/Qwen3.5-35B']);
});

test('providers root takes precedence over legacy models root when both are present', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'preferred/model-a',
    providers: {
      preferred: {
        providerType: 'openai-completions',
        baseUrl: 'https://preferred.test/v1',
        apiKey: 'preferred-key',
        models: ['model-a'],
      },
    },
    models: {
      legacy: {
        provider: 'openai-completions',
        baseUrl: 'https://legacy.test/v1',
        apiKey: 'legacy-key',
        model: ['model-b'],
      },
    },
  });

  assert.ok(parsed.models.preferred);
  assert.equal(parsed.models.preferred.baseUrl, 'https://preferred.test/v1');
  assert.equal(parsed.models.legacy, undefined);
});

test('object list item without id throws a clear error', () => {
  assert.throws(
    () => loadModelsConfigFromObject({
      default: 'openai',
      providers: {
        openai: {
          providerType: 'openai-completions',
          models: [{ extraHeaders: { a: 'b' } }],
        },
      },
    }),
    /requires a non-empty `id`/i,
  );
});

test('map form for provider entry models is rejected with a clear error', () => {
  assert.throws(
    () => loadModelsConfigFromObject({
      default: 'openai',
      providers: {
        openai: {
          providerType: 'openai-completions',
          models: {
            'gpt-5.2-codex': {
              contextLimit: 400000,
            },
          },
        },
      },
    }),
    /map\/object form is not supported/i,
  );
});

test('virtual providers resolve strict concrete leaves with safe context and async compact values', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'sticky',
    providers: {
      sticky: {
        providerType: 'session-hash',
        targets: ['openai/a', 'anthropic/b'],
      },
      openai: {
        providerType: 'openai-completions',
        baseUrl: 'https://openai.test/v1',
        contextLimit: 200000,
        models: ['a'],
      },
      anthropic: {
        providerType: 'anthropic',
        baseUrl: 'https://anthropic.test',
        contextLimit: 100000,
        asyncCompact: false,
        models: ['b'],
      },
      fallback: {
        providerType: 'failover',
        targets: ['openai/a', 'anthropic/b'],
        failureThreshold: 3,
        cooldownMs: 1234,
      },
    },
  });

  assert.deepEqual(parsed.displayModels, ['sticky', 'openai', 'anthropic', 'fallback']);
  assert.equal(parsed.models.sticky.contextLimit, 100000);
  assert.equal(parsed.models.sticky.asyncCompact, false);
  assert.deepEqual(parsed.models.sticky.virtualRouting?.targets, ['openai/a', 'anthropic/b']);
  assert.equal(parsed.models.sticky.virtualRouting?.failureThreshold, 5);
  assert.equal(parsed.models.sticky.virtualRouting?.cooldownMs, 600000);
  assert.equal(parsed.models.fallback.virtualRouting?.failureThreshold, 3);
  assert.equal(parsed.models.fallback.virtualRouting?.cooldownMs, 1234);
  assert.match(parsed.models.fallback.virtualRouting?.fingerprint || '', /^[0-9a-f]{64}$/);
});

test('session-hash accepts one concrete target as an alias and canonicalizes single-model aliases', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'alias',
    providers: {
      concrete: {
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        models: ['model-a'],
      },
      alias: {
        providerType: 'session-hash',
        targets: ['concrete'],
      },
    },
  });
  assert.deepEqual(parsed.models.alias.virtualRouting?.targets, ['concrete/model-a']);
  assert.equal(parsed.models.alias.asyncCompact, true);
});

test('virtual schema rejects forbidden fields, invalid target counts, unknown/nested/self targets, and canonical duplicates', () => {
  const concrete = {
    providerType: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    models: ['model-a'],
  };
  const parseVirtual = (entry: any, extraProviders: any = {}) => loadModelsConfigFromObject({
    default: 'virtual',
    providers: { concrete, ...extraProviders, virtual: entry },
  });

  assert.throws(() => parseVirtual({ providerType: 'session-hash', targets: ['concrete'], apiKey: 'forbidden' }), /forbids field `apiKey`/);
  assert.throws(() => parseVirtual({ providerType: 'failover', targets: ['concrete'] }), /at least 2 targets/);
  assert.throws(() => parseVirtual({ providerType: 'session-hash', targets: ['missing/model'] }), /unknown concrete target/);
  assert.throws(() => parseVirtual({ providerType: 'session-hash', targets: ['virtual'] }), /cannot target itself/);
  assert.throws(() => parseVirtual(
    { providerType: 'session-hash', targets: ['other'] },
    { other: { providerType: 'session-hash', targets: ['virtual'] } },
  ), /is virtual; nested virtual routing is not supported/);
  assert.throws(() => parseVirtual({ providerType: 'failover', targets: ['concrete', 'concrete/model-a'] }), /duplicate canonical target/);
});

test('providerType continues to take precedence over the legacy provider reader', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'concrete',
    providers: {
      concrete: {
        providerType: 'openai-completions',
        provider: 'failover',
        baseUrl: 'https://example.test/v1',
        models: ['model-a'],
      },
    },
  });
  assert.equal(parsed.models.concrete.providerType, 'openai-completions');
  assert.equal(parsed.models.concrete.virtualRouting, undefined);
});

test('legacy provider remains a fallback reader for virtual providerType values', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'legacy-route',
    providers: {
      concrete: {
        providerType: 'anthropic',
        baseUrl: 'https://example.test',
        models: ['model-a'],
      },
      'legacy-route': {
        provider: 'session-hash',
        targets: ['concrete/model-a'],
      },
    },
  });
  assert.equal(parsed.models['legacy-route'].providerType, 'session-hash');
  assert.deepEqual(parsed.models['legacy-route'].virtualRouting?.targets, ['concrete/model-a']);
});
