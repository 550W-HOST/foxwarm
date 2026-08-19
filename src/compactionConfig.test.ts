import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMPACT_KEEP_PERCENT,
  DEFAULT_COMPACT_THRESHOLD_PERCENT,
  normalizeCompactionConfig,
} from './config';

test('compaction config uses current defaults and current keys', () => {
  assert.equal(DEFAULT_COMPACT_KEEP_PERCENT, 0.3);
  assert.equal(DEFAULT_COMPACT_THRESHOLD_PERCENT, 0.85);
  assert.deepEqual(normalizeCompactionConfig(undefined), {
    compactKeepPercent: DEFAULT_COMPACT_KEEP_PERCENT,
    compactThresholdPercent: DEFAULT_COMPACT_THRESHOLD_PERCENT,
  });
  assert.deepEqual(normalizeCompactionConfig({
    compactKeepPercent: 0.4,
    compactThresholdPercent: 0.9,
  }), {
    compactKeepPercent: 0.4,
    compactThresholdPercent: 0.9,
  });
});

test('compaction config reads legacy keep percent only as a fallback', () => {
  assert.equal(normalizeCompactionConfig({ compactPercent: 0.2 }).compactKeepPercent, 0.2);
  assert.equal(normalizeCompactionConfig({ compactKeepPercent: 0.4, compactPercent: 2 }).compactKeepPercent, 0.4);
  assert.throws(() => normalizeCompactionConfig({ compactPercent: 2 }), /llm\.compactPercent.*finite number/);
});

test('compaction config rejects non-finite, non-number, and out-of-range percentages', () => {
  const invalidValues = [true, '0.5', Number.NaN, Number.POSITIVE_INFINITY, 0, -0.1, 1.1];
  for (const field of ['compactKeepPercent', 'compactThresholdPercent'] as const) {
    for (const value of invalidValues) {
      assert.throws(
        () => normalizeCompactionConfig({ [field]: value } as any),
        new RegExp(`llm\\.${field}.*finite number`),
      );
    }
  }
});
