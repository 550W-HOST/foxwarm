import test from 'node:test';
import assert from 'node:assert/strict';
import { toPersistedLlmRequestTiming } from './llmRequestTiming';

test('logical request timing persists monotonic duration with derived wall boundaries', () => {
  assert.deepEqual(toPersistedLlmRequestTiming({ completedAt: 10_000, durationMs: 1_234.5 }), {
    startedAt: 8_765.5,
    completedAt: 10_000,
    durationMs: 1_234.5,
  });
});

test('invalid internal timing is omitted rather than persisted as misleading metadata', () => {
  assert.equal(toPersistedLlmRequestTiming(undefined), undefined);
  assert.equal(toPersistedLlmRequestTiming({ completedAt: Number.NaN, durationMs: 1 }), undefined);
  assert.equal(toPersistedLlmRequestTiming({ completedAt: 100, durationMs: -1 }), undefined);
  assert.equal(toPersistedLlmRequestTiming({ completedAt: 100, durationMs: 101 }), undefined);
});