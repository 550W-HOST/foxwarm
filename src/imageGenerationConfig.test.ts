import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject, normalizeOpenAIImageGenerationConfig } from './config';

const RESPONSES_PROVIDER = {
  providerType: 'openai-responses',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
};

test('imageGeneration normalization covers booleans, objects, and defaults', () => {
  assert.equal(normalizeOpenAIImageGenerationConfig(undefined), undefined);
  assert.deepEqual(normalizeOpenAIImageGenerationConfig(true), { enabled: true });
  assert.deepEqual(normalizeOpenAIImageGenerationConfig(false), { enabled: false });
  // An object without `enabled` is enabled.
  assert.deepEqual(normalizeOpenAIImageGenerationConfig({ action: 'auto' }), { enabled: true, action: 'auto' });
  assert.deepEqual(normalizeOpenAIImageGenerationConfig({ enabled: false, size: '1024x1024' }), { enabled: false, size: '1024x1024' });
  assert.deepEqual(
    normalizeOpenAIImageGenerationConfig({
      model: '  gpt-image-1  ',
      action: 'edit',
      size: '1024x1024',
      quality: 'xhigh',
      background: 'transparent',
      outputFormat: 'webp',
      outputCompression: 0,
    }),
    {
      enabled: true,
      model: 'gpt-image-1',
      action: 'edit',
      size: '1024x1024',
      quality: 'xhigh',
      background: 'transparent',
      outputFormat: 'webp',
      outputCompression: 0,
    },
  );
  // No hardcoded image model name or size collection is imposed.
  assert.deepEqual(normalizeOpenAIImageGenerationConfig({}), { enabled: true });
});

test('imageGeneration rejects invalid shapes with field paths', () => {
  assert.throws(() => normalizeOpenAIImageGenerationConfig('yes'), /must be a boolean or object/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig([1]), /must be a boolean or object/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ enabled: 'yes' }), /imageGeneration\.enabled` must be a boolean/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ model: '   ' }), /imageGeneration\.model` must be a non-empty string/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ action: 'paint' }), /imageGeneration\.action` must be/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ size: '' }), /imageGeneration\.size` must be a non-empty string/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ quality: 'ultra' }), /imageGeneration\.quality` must be/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ background: 'solid' }), /imageGeneration\.background` must be/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ outputFormat: 'bmp' }), /imageGeneration\.outputFormat` must be/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ outputCompression: 101 }), /must be an integer between 0 and 100/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ outputCompression: 1.5 }), /must be an integer between 0 and 100/);
  assert.throws(() => normalizeOpenAIImageGenerationConfig({ outputCompression: -1 }), /must be an integer between 0 and 100/);
  assert.throws(
    () => normalizeOpenAIImageGenerationConfig({ outputFormat: 'jpeg', background: 'transparent' }),
    /cannot combine `outputFormat: jpeg` with `background: transparent`/,
  );
});

test('provider and model imageGeneration merge with the documented inheritance rules', () => {
  const parsed = loadModelsConfigFromObject({
    default: 'p/openai-responses-a',
    providers: {
      p: {
        ...RESPONSES_PROVIDER,
        imageGeneration: { enabled: true, outputFormat: 'png', background: 'auto', action: 'auto' },
        models: [
          'plain',
          { id: 'disabled', imageGeneration: false },
          { id: 'disabled-object', imageGeneration: { enabled: false } },
          { id: 'enabled-true', imageGeneration: true },
          { id: 'override', imageGeneration: { quality: 'high', outputFormat: 'webp' } },
        ],
      },
      off: { ...RESPONSES_PROVIDER, imageGeneration: false, models: ['m'] },
      bare: { ...RESPONSES_PROVIDER, models: ['m'] },
    },
  });

  assert.deepEqual(parsed.models['p/plain'].imageGeneration, {
    enabled: true,
    action: 'auto',
    background: 'auto',
    outputFormat: 'png',
  });
  assert.deepEqual(parsed.models['p/disabled'].imageGeneration, {
    enabled: false,
    action: 'auto',
    background: 'auto',
    outputFormat: 'png',
  });
  assert.deepEqual(parsed.models['p/disabled-object'].imageGeneration, {
    enabled: false,
    action: 'auto',
    background: 'auto',
    outputFormat: 'png',
  });
  assert.deepEqual(parsed.models['p/enabled-true'].imageGeneration, {
    enabled: true,
    action: 'auto',
    background: 'auto',
    outputFormat: 'png',
  });
  assert.deepEqual(parsed.models['p/override'].imageGeneration, {
    enabled: true,
    action: 'auto',
    background: 'auto',
    outputFormat: 'webp',
    quality: 'high',
  });
  assert.deepEqual(parsed.models['off/m'].imageGeneration, { enabled: false });
  assert.equal(parsed.models['bare/m'].imageGeneration, undefined);
});

test('imageGeneration participates in virtual routing fingerprints without leaking into them', () => {
  const base = {
    default: 'route',
    providers: {
      leaf: { ...RESPONSES_PROVIDER, imageGeneration: { enabled: true, outputFormat: 'png' }, models: ['model-a'] },
      backup: { ...RESPONSES_PROVIDER, baseUrl: 'https://backup.test/v1', models: ['model-b'] },
      route: { providerType: 'failover', targets: ['leaf/model-a', 'backup/model-b'] },
    },
  };
  const fingerprint = (config: any) => loadModelsConfigFromObject(config).models.route.virtualRouting!.fingerprint;
  const baseFingerprint = fingerprint(base);

  for (const mutate of [
    (value: any) => { value.providers.leaf.imageGeneration.outputFormat = 'webp'; },
    (value: any) => { value.providers.leaf.imageGeneration = false; },
    (value: any) => { value.providers.leaf.imageGeneration = { enabled: true, outputFormat: 'png', quality: 'high' }; },
  ]) {
    const mutated = structuredClone(base);
    mutate(mutated);
    assert.notEqual(fingerprint(mutated), baseFingerprint);
  }

  const routingJson = JSON.stringify(loadModelsConfigFromObject(base).models.route.virtualRouting);
  assert.equal(routingJson.includes('imageGeneration'), false);
});

test('virtual providers forbid imageGeneration and setup drafts drop it on conversion', () => {
  const concrete = { providerType: 'openai-responses', baseUrl: 'https://example.test/v1', models: ['model-a'] };
  assert.throws(
    () => loadModelsConfigFromObject({
      default: 'virtual',
      providers: { concrete, virtual: { providerType: 'session-hash', targets: ['concrete'], imageGeneration: true } },
    }),
    /forbids field `imageGeneration`/,
  );

  // Concrete providers keep the field for the setup form round trip.
  const parsed = loadModelsConfigFromObject({
    default: 'concrete/model-a',
    providers: { concrete: { ...concrete, imageGeneration: true } },
  });
  assert.deepEqual(parsed.models['concrete/model-a'].imageGeneration, { enabled: true });
});
