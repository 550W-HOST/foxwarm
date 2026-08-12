import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject, MODEL_EFFORTS, normalizeOpenAIWebSearchConfig } from './config';

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

test('effort capabilities default, inherit, and replace at model level', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'openai/model-a',
    providers: {
      openai: {
        providerType: 'openai-responses',
        effort: { allowed: ['low', 'medium', 'high', 'xhigh'], default: 'high' },
        models: [
          'model-a',
          { id: 'model-b', effort: { allowed: ['none', 'high'], default: 'none' } },
        ],
      },
      defaults: {
        providerType: 'anthropic',
        models: ['model-c'],
      },
    },
  });

  assert.deepEqual(parsed.models['openai/model-a'].effort, {
    allowed: ['low', 'medium', 'high', 'xhigh'], default: 'high',
  });
  assert.deepEqual(parsed.models['openai/model-b'].effort, {
    allowed: ['none', 'high'], default: 'none',
  });
  assert.deepEqual(parsed.models.defaults.effort, {
    allowed: [...MODEL_EFFORTS], default: 'high',
  });
});

test('effort validation rejects invalid, duplicate, empty, and disallowed inherited defaults', () => {
  const parse = (effort: any, modelEffort?: any) => loadModelsConfigFromObject({
    default: 'provider/model',
    providers: {
      provider: {
        providerType: 'openai-completions',
        effort,
        models: [{ id: 'model', ...(modelEffort === undefined ? {} : { effort: modelEffort }) }],
      },
    },
  });
  assert.throws(() => parse({ allowed: [] }), /non-empty array/);
  assert.throws(() => parse({ allowed: ['high', 'high'] }), /duplicate/);
  assert.throws(() => parse({ allowed: ['middle'] }), /must be one of/);
  assert.throws(() => parse({ allowed: ['low'], default: 'high' }), /must be included/);
  assert.throws(
    () => parse({ allowed: ['low', 'high'], default: 'high' }, { allowed: ['low'] }),
    /Model `provider\/model` effort\.default `high` must be included/,
  );
});

test('OpenAI web search boolean/object settings normalize and merge at model level', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'openai/model-a',
    providers: {
      openai: {
        providerType: 'openai-responses',
        baseUrl: 'https://example.test/v1',
        webSearch: {
          enabled: false,
          toolChoice: 'auto',
          searchContextSize: 'high',
          allowedDomains: ['base.example'],
          userLocation: { country: 'CN', city: 'Shenzhen' },
        },
        models: [
          {
            id: 'model-a',
            webSearch: {
              enabled: true,
              toolChoice: 'required',
              allowedDomains: ['example.com'],
            },
          },
          { id: 'model-b', webSearch: false },
          { id: 'model-c', webSearch: { toolChoice: 'required' } },
          { id: 'model-d', webSearch: { enabled: false, searchContextSize: 'low' } },
        ],
      },
      providerTrue: {
        providerType: 'openai-responses',
        webSearch: true,
        models: ['model-e'],
      },
      providerFalse: {
        providerType: 'openai-responses',
        webSearch: false,
        models: ['model-f'],
      },
    },
  });

  assert.deepEqual(parsed.models['openai/model-a'].webSearch, {
    enabled: true,
    toolChoice: 'required',
    searchContextSize: 'high',
    allowedDomains: ['example.com'],
    userLocation: { country: 'CN', city: 'Shenzhen' },
  });
  assert.deepEqual(parsed.models['openai/model-b'].webSearch, {
    enabled: false,
    toolChoice: 'auto',
    searchContextSize: 'high',
    allowedDomains: ['base.example'],
    userLocation: { country: 'CN', city: 'Shenzhen' },
  });
  assert.deepEqual(parsed.models['openai/model-c'].webSearch, {
    enabled: true,
    toolChoice: 'required',
    searchContextSize: 'high',
    allowedDomains: ['base.example'],
    userLocation: { country: 'CN', city: 'Shenzhen' },
  });
  assert.deepEqual(parsed.models['openai/model-d'].webSearch, {
    enabled: false,
    toolChoice: 'auto',
    searchContextSize: 'low',
    allowedDomains: ['base.example'],
    userLocation: { country: 'CN', city: 'Shenzhen' },
  });
  assert.deepEqual(parsed.models['providerTrue/model-e'].webSearch, { enabled: true });
  assert.deepEqual(parsed.models['providerFalse/model-f'].webSearch, { enabled: false });
});

test('OpenAI web search normalizer validates supported tuning fields', () => {
  assert.deepEqual(normalizeOpenAIWebSearchConfig(true), { enabled: true });
  assert.deepEqual(normalizeOpenAIWebSearchConfig(false), { enabled: false });
  assert.deepEqual(normalizeOpenAIWebSearchConfig({}), { enabled: true });
  assert.throws(() => normalizeOpenAIWebSearchConfig('enabled'), /boolean or object/);
  assert.throws(() => normalizeOpenAIWebSearchConfig({ toolChoice: 'never' }), /toolChoice/);
  assert.throws(() => normalizeOpenAIWebSearchConfig({ allowedDomains: [''] }), /allowedDomains/);
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
  assert.deepEqual(parsed.models.sticky.effort, { allowed: [...MODEL_EFFORTS] });
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

test('virtual effort capabilities are the canonical union of concrete leaf sets', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'route',
    providers: {
      first: {
        providerType: 'openai-responses',
        effort: { allowed: ['none', 'low', 'high'], default: 'high' },
        models: ['a'],
      },
      second: {
        providerType: 'anthropic',
        effort: { allowed: ['medium', 'high', 'max'], default: 'medium' },
        models: ['b'],
      },
      route: { providerType: 'failover', targets: ['first/a', 'second/b'] },
    },
  });
  assert.deepEqual(parsed.models.route.effort, {
    allowed: ['none', 'low', 'medium', 'high', 'max'],
  });
});

test('canonical targets preserve slash-containing and provider-prefixed model ids as actual expansion keys', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'alias',
    providers: {
      foo: {
        providerType: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        models: ['foo/bar'],
      },
      alias: {
        providerType: 'session-hash',
        targets: ['foo'],
      },
    },
  });
  assert.ok(parsed.models['foo/foo/bar']);
  assert.equal(parsed.models.foo.canonicalModelKey, 'foo/foo/bar');
  assert.equal(parsed.models['foo/foo/bar'].canonicalModelKey, 'foo/foo/bar');
  assert.deepEqual(parsed.models.alias.virtualRouting?.targets, ['foo/foo/bar']);
  assert.equal(parsed.models[parsed.models.alias.virtualRouting!.targets[0]].model, 'foo/bar');
  assert.throws(
    () => loadModelsConfigFromObject({
      default: 'duplicate',
      providers: {
        foo: {
          providerType: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          models: ['foo/bar'],
        },
        duplicate: {
          providerType: 'failover',
          targets: ['foo', 'foo/foo/bar'],
        },
      },
    }),
    /duplicate canonical target `foo\/foo\/bar`/,
  );
});

test('route fingerprint deterministically covers resolved concrete request plans without storing secrets', () => {
  const raw = {
    default: 'route',
    providers: {
      leaf: {
        providerType: 'openai-completions',
        baseUrl: 'https://leaf.test/v1',
        apiKey: 'super-secret-value',
        contextLimit: 1000,
        asyncCompact: true,
        extraFields: { z: 1, nested: { b: 2, a: 1 } },
        extraHeaders: { 'x-z': 'z', Authorization: 'secret-header' },
        models: ['model-a'],
      },
      backup: {
        providerType: 'anthropic',
        baseUrl: 'https://backup.test',
        apiKey: 'backup-secret',
        models: ['model-b'],
      },
      route: {
        providerType: 'failover',
        targets: ['leaf/model-a', 'backup/model-b'],
      },
    },
  };
  const fingerprint = (config: any) => loadModelsConfigFromObject(config).models.route.virtualRouting!.fingerprint;
  const baseFingerprint = fingerprint(raw);
  const changedFingerprints = [
    (() => { const value = structuredClone(raw); value.providers.leaf.baseUrl = 'https://changed.test/v1'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.apiKey = 'changed-secret'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.providerType = 'anthropic'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.models = ['leaf/model-a']; value.providers.route.targets[0] = 'leaf/leaf/model-a'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); (value.providers.leaf.extraHeaders as any)['x-new'] = 'yes'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); (value.providers.leaf as any).requestCompression = 'gzip'; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.extraFields.nested.a = 9; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.contextLimit = 2000; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); value.providers.leaf.asyncCompact = false; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); (value.providers.leaf as any).webSearch = { enabled: true }; return fingerprint(value); })(),
    (() => { const value = structuredClone(raw); (value.providers.leaf as any).effort = { allowed: ['low', 'high'], default: 'low' }; return fingerprint(value); })(),
  ];
  assert.ok(changedFingerprints.every(value => value !== baseFingerprint));

  const reordered = structuredClone(raw);
  reordered.providers.leaf.extraHeaders = { Authorization: 'secret-header', 'x-z': 'z' };
  reordered.providers.leaf.extraFields = { nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(fingerprint(reordered), baseFingerprint);

  const routingJson = JSON.stringify(loadModelsConfigFromObject(raw).models.route.virtualRouting);
  assert.doesNotMatch(routingJson, /super-secret-value|secret-header|backup-secret/);
  assert.match(baseFingerprint, /^[0-9a-f]{64}$/);
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

test('provider entries and concrete/virtual routing fields are strictly separated', () => {
  const invalidProviderValues: unknown[] = [null, 'text', 1, []];
  for (const value of invalidProviderValues) {
    assert.throws(
      () => loadModelsConfigFromObject({ default: 'bad', providers: { bad: value } }),
      /Provider `bad` must be a plain object/,
    );
  }

  const concrete = {
    providerType: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    models: ['model-a'],
  };
  for (const field of ['targets', 'failureThreshold', 'cooldownMs']) {
    assert.throws(
      () => loadModelsConfigFromObject({
        default: 'concrete',
        providers: { concrete: { ...concrete, [field]: field === 'targets' ? ['concrete'] : 1 } },
      }),
      new RegExp(`Concrete provider .* forbids routing field .*${field}`),
    );
  }

  const parseVirtual = (entry: any) => loadModelsConfigFromObject({
    default: 'virtual',
    providers: { concrete, virtual: entry },
  });
  for (const field of ['contextLimit', 'asyncCompact', 'webSearch']) {
    assert.throws(
      () => parseVirtual({ providerType: 'session-hash', targets: ['concrete'], [field]: field === 'contextLimit' ? 1000 : true }),
      new RegExp(`forbids field .*${field}`),
    );
  }
  for (const field of ['failureThreshold', 'cooldownMs']) {
    assert.throws(
      () => parseVirtual({ providerType: 'session-hash', targets: ['concrete'], [field]: 1 }),
      new RegExp(`session-hash.*forbids failover field .*${field}`),
    );
  }
  for (const [field, value] of [['failureThreshold', 1.5], ['failureThreshold', 0], ['cooldownMs', 1.5], ['cooldownMs', 0]] as const) {
    assert.throws(
      () => loadModelsConfigFromObject({
        default: 'virtual',
        providers: {
          concrete,
          second: { ...concrete, models: ['model-b'] },
          virtual: {
            providerType: 'failover',
            targets: ['concrete/model-a', 'second/model-b'],
            [field]: value,
          },
        },
      }),
      new RegExp(`${field} must be a positive integer`),
    );
  }
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
