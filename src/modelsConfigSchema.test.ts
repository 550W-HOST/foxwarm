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
