import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject } from '../config';
import {
  applyNormalizedSessionModelEffortSettings,
  normalizeProspectiveSessionModelEffortSettings,
} from './modelEffortSettings';
import type { Session } from '../types';

function models() {
  return loadModelsConfigFromObject({
    default: 'first/a',
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
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'settings', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, ...overrides,
  };
}

test('old authorities keep absent effort fields canonically unset', () => {
  assert.deepEqual(normalizeProspectiveSessionModelEffortSettings({}, {}, models()), {});
});

test('prospective model changes preserve supported effort and atomically clear incompatible current and child overrides', () => {
  const owner = session({
    model: 'first/a', effort: 'low',
    childEffortDefault: 'none',
  });
  const prospective = normalizeProspectiveSessionModelEffortSettings(owner, { model: 'second/b' }, models());
  assert.deepEqual(prospective, { model: 'second/b' });
  assert.deepEqual(applyNormalizedSessionModelEffortSettings(owner, prospective), [
    'model', 'effort', 'childEffortDefault',
  ]);
  assert.equal(owner.model, 'second/b');
  assert.equal(owner.effort, undefined);
  assert.equal(owner.childEffortDefault, undefined);
});

test('concrete and virtual effort validation uses concrete allowed sets and virtual union', () => {
  assert.throws(
    () => normalizeProspectiveSessionModelEffortSettings({}, { model: 'first/a', effort: 'medium' }, models()),
    /effort `medium` is not allowed by model `first\/a`/,
  );
  assert.deepEqual(
    normalizeProspectiveSessionModelEffortSettings({}, { model: 'route', effort: 'medium' }, models()),
    { model: 'route', effort: 'medium' },
  );
  assert.deepEqual(
    normalizeProspectiveSessionModelEffortSettings({}, { childModelDefault: 'route', childEffortDefault: 'max' }, models()),
    { childModelDefault: 'route', childEffortDefault: 'max' },
  );
});

test('failed explicit effort validation leaves the owner unchanged until one apply step', () => {
  const owner = session({ model: 'first/a', effort: 'low', childModelDefault: 'second/b', childEffortDefault: 'max' });
  const before = structuredClone(owner);
  assert.throws(
    () => normalizeProspectiveSessionModelEffortSettings(owner, {
      model: 'second/b', effort: 'low', childModelDefault: 'first/a', childEffortDefault: 'medium',
    }, models()),
    /effort `low` is not allowed by model `second\/b`/,
  );
  assert.deepEqual(owner, before);
});
