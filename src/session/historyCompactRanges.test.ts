import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBlockCandidateItem } from './compactPlan';
import { resolveCreateBlockRanges, type LayeredCompactCandidateEntry } from './history';

function blockEntry(id: number, level: number, index: number): LayeredCompactCandidateEntry {
  return {
    item: buildBlockCandidateItem(id, level, index * 10 + 1, index * 10 + 10, `block ${id}`),
    frontierStartIndex: index,
    frontierEndIndex: index,
  };
}

test('resolveCreateBlockRanges follows frontier order for non-consecutive block ids', () => {
  const entries = [
    blockEntry(11, 2, 0),
    blockEntry(18, 2, 1),
    blockEntry(24, 2, 2),
    blockEntry(118, 2, 3),
  ];

  const [operation] = resolveCreateBlockRanges({
    createBlocks: [{
      level: 3,
      sourceKind: 'block',
      sourceStart: 11,
      sourceEnd: 118,
      summary: 'summary for non-consecutive L2 block ids',
    }],
  }, entries);

  assert.equal(operation.startIndex, 0);
  assert.equal(operation.endIndex, 3);
  assert.equal(operation.frontierStartIndex, 0);
  assert.equal(operation.frontierEndIndex, 3);
  assert.deepEqual(operation.sourceBlockIds, [11, 18, 24, 118]);
  assert.equal(operation.rawStartSeq, 1);
  assert.equal(operation.rawEndSeq, 40);
});

test('resolveCreateBlockRanges supports decreasing block id endpoints in frontier order', () => {
  const entries = [
    blockEntry(120, 1, 0),
    blockEntry(118, 1, 1),
  ];

  const [operation] = resolveCreateBlockRanges({
    createBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 120,
      sourceEnd: 118,
      summary: 'summary for decreasing endpoint ids',
    }],
  }, entries);

  assert.equal(operation.startIndex, 0);
  assert.equal(operation.endIndex, 1);
  assert.deepEqual(operation.sourceBlockIds, [120, 118]);
});

test('resolveCreateBlockRanges rejects block ranges that cross a different source level', () => {
  const entries = [
    blockEntry(11, 2, 0),
    blockEntry(127, 1, 1),
    blockEntry(118, 2, 2),
  ];

  assert.throws(() => resolveCreateBlockRanges({
    createBlocks: [{
      level: 3,
      sourceKind: 'block',
      sourceStart: 11,
      sourceEnd: 118,
      summary: 'invalid cross-level summary',
    }],
  }, entries), /Unable to resolve layered compact block range 11-118/);
});
