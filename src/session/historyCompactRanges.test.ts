import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBlockCandidateItem, validateCompactPlanArgs } from './compactPlan';
import { resolveCreateBlockRanges, type LayeredCompactCandidateEntry } from './history';

function blockEntry(id: number, level: number, index: number): LayeredCompactCandidateEntry {
  return {
    item: buildBlockCandidateItem(id, level, index * 10 + 1, index * 10 + 10, `block ${id}`),
    historyStartIndex: index,
    historyEndIndex: index,
  };
}

function messageEntry(startSeq: number, endSeq: number, index: number, segmentId?: number): LayeredCompactCandidateEntry {
  return {
    item: {
      kind: 'message',
      key: startSeq === endSeq ? `M#${startSeq}` : `M#${startSeq}-#${endSeq}`,
      startSeq,
      endSeq,
      preview: `message ${startSeq}`,
      estimatedTokens: 10,
      ...(typeof segmentId === 'number' ? { segmentId } : {}),
    },
    historyStartIndex: index,
    historyEndIndex: index,
  };
}

function validatePlan(createBlocks: Record<string, unknown>[], entries: LayeredCompactCandidateEntry[], extraArgs: Record<string, unknown> = {}) {
  return validateCompactPlanArgs(
    { replaceAsBlocks: createBlocks, ...extraArgs },
    entries.map(entry => entry.item),
  );
}

test('resolveCreateBlockRanges follows history order for non-consecutive block ids', () => {
  const entries = [
    blockEntry(11, 2, 0),
    blockEntry(18, 2, 1),
    blockEntry(24, 2, 2),
    blockEntry(118, 2, 3),
  ];

  const plan = validatePlan([{
      level: 3,
      sourceKind: 'block',
      sourceStart: 11,
      sourceEnd: 118,
      summary: 'summary for non-consecutive L2 block ids',
  }], entries);
  const [operation] = resolveCreateBlockRanges(plan, entries);

  assert.deepEqual(plan.createBlocks[0].candidateRange, [0, 3]);
  assert.equal(operation.startIndex, 0);
  assert.equal(operation.endIndex, 3);
  assert.equal(operation.historyStartIndex, 0);
  assert.equal(operation.historyEndIndex, 3);
  assert.deepEqual(operation.sourceBlockIds, [11, 18, 24, 118]);
  assert.equal(operation.rawStartSeq, 1);
  assert.equal(operation.rawEndSeq, 40);
});

test('resolveCreateBlockRanges supports decreasing block id endpoints in history order', () => {
  const entries = [
    blockEntry(120, 1, 0),
    blockEntry(118, 1, 1),
  ];

  const plan = validatePlan([{
      level: 2,
      sourceKind: 'block',
      sourceStart: 120,
      sourceEnd: 118,
      summary: 'summary for decreasing endpoint ids',
  }], entries);
  const [operation] = resolveCreateBlockRanges(plan, entries);

  assert.deepEqual(plan.createBlocks[0].candidateRange, [0, 1]);
  assert.equal(operation.startIndex, 0);
  assert.equal(operation.endIndex, 1);
  assert.deepEqual(operation.sourceBlockIds, [120, 118]);
});

test('validation rejects block ranges that cross a different source level', () => {
  const entries = [
    blockEntry(11, 2, 0),
    blockEntry(127, 1, 1),
    blockEntry(118, 2, 2),
  ];

  assert.throws(() => validatePlan([{
      level: 3,
      sourceKind: 'block',
      sourceStart: 11,
      sourceEnd: 118,
      summary: 'invalid cross-level summary',
  }], entries), /continuous active candidate block range/i);
});

test('validated preserved-message ranges materialize once and cannot cross segment boundaries', () => {
  const entries = [
    messageEntry(1, 1, 0, 1),
    messageEntry(2, 2, 1, 1),
    messageEntry(4, 4, 3, 2),
  ];

  const validPlan = validatePlan([{
    level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'valid range with one preserved raw message',
  }], entries, { preserveMessages: [2] });
  const [operation] = resolveCreateBlockRanges(validPlan, entries);
  assert.deepEqual(validPlan.createBlocks[0].candidateRange, [0, 1]);
  assert.deepEqual([operation.startIndex, operation.endIndex], [0, 1]);

  assert.throws(() => validatePlan([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 4,
      summary: 'invalid range across a preserved raw message boundary',
  }], entries), /continuous message range/i);
});
