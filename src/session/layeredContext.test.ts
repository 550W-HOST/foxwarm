import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateHistoryWithContextFrontierMetadata, formatArchiveBlockContextText, formatArchiveBlockTimeRange, isIgnoredCompactLifecycleSystemText, renderBlockMessage, shouldIgnoreMessageInCompactCandidates } from './layeredContext';
import { formatCompactionCompletionMarker } from './history';
import { Message } from '../types';
import { formatLocalTimeRange } from '../utils/localTime';

test('recognizes compact lifecycle system texts that should be ignored in compact candidates', () => {
  assert.equal(isIgnoredCompactLifecycleSystemText('This session has been compacted. Messages before this are removed.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compacted message placeholder: 4 message(s) from #1-#4 were removed from working history here.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compaction completed. You can continue working now.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('**COMPACTION COMPLETED. PARENT SESSION `parent-456`. CURRENT SESSION ID IS `session-123`.**'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" />'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Manual compaction completed.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('current time = 2026-03-18 00:00'), false);
});

test('ignores pure compact lifecycle messages but keeps messages with real non-system content', () => {
  const lifecycleOnly: Message = {
    role: 'user',
    parts: [{ system: 'Compaction completed. You can continue working now.' }],
    __meta: { seq: 10 },
  };
  assert.equal(shouldIgnoreMessageInCompactCandidates(lifecycleOnly), true);

  const foxwarmLifecycleWithPayload: Message = {
    role: 'user',
    parts: [
      { system: '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" />' },
      { text: 'You can continue working now.', systemPayload: true },
    ],
    __meta: { seq: 10 },
  };
  assert.equal(shouldIgnoreMessageInCompactCandidates(foxwarmLifecycleWithPayload), true);

  const mixedContent: Message = {
    role: 'user',
    parts: [
      { system: 'Compaction completed. You can continue working now.' },
      { text: 'Also, please continue with the bugfix.' },
    ],
    __meta: { seq: 11 },
  };
  assert.equal(shouldIgnoreMessageInCompactCandidates(mixedContent), false);
});

test('formatCompactionCompletionMarker uses foxwarm metadata without a duplicate legacy prefix', () => {
  const text = formatCompactionCompletionMarker('session-123', 'Compaction completed. You can continue working now.', 'parent-456');
  assert.equal(text, '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" />\nYou can continue working now.');
  assert.equal(formatCompactionCompletionMarker('session-123', 'Compaction completed.', 'parent-456'), '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" />');
  assert.equal(isIgnoredCompactLifecycleSystemText(text.split('\n')[0]), true);
});

test('renderBlockMessage includes raw message local time range when available', () => {
  const record: any = {
    sourceKind: 'message',
    sourceStart: 10,
    sourceEnd: 12,
    id: 3,
    level: 1,
    rawStartSeq: 10,
    rawEndSeq: 12,
    rawStartTimestamp: 1_700_000_000_000,
    rawEndTimestamp: 1_700_000_060_000,
    summary: 'block summary',
    createdAt: 1_700_000_070_000,
  };

  const message = renderBlockMessage(record);
  const expectedRange = formatLocalTimeRange(record.rawStartTimestamp, record.rawEndTimestamp);
  const expectedBlockText = `[CTX-BLOCK L1 B#3 raw#10-#12 time ${expectedRange}] block summary`;
  assert.equal(formatArchiveBlockTimeRange(record), ` time ${expectedRange}`);
  assert.equal(formatArchiveBlockContextText(record), expectedBlockText);
  assert.equal(message.parts[0].text, expectedBlockText);
  assert.deepEqual(message.__meta?.contextBlock, {
    id: 3,
    level: 1,
    rawStartSeq: 10,
    rawEndSeq: 12,
    sourceKind: 'message',
    sourceStart: 10,
    sourceEnd: 12,
    rawStartTimestamp: record.rawStartTimestamp,
    rawEndTimestamp: record.rawEndTimestamp,
    createdAt: record.createdAt,
  });
  assert.deepEqual(message.__meta?.contextFrontierItem, {
    kind: 'block',
    id: 3,
    level: 1,
    rawStartSeq: 10,
    rawEndSeq: 12,
  });
});

test('annotateHistoryWithContextFrontierMetadata adds block and preserved raw metadata', async () => {
  const history: Message[] = [
    {
      role: 'model',
      parts: [{ text: '[CTX-BLOCK L1 B#7 raw#10-#12] block summary' }],
      __meta: { timestamp: 2000 },
    },
    {
      role: 'user',
      parts: [{ text: 'exact preserved instruction' }],
      __meta: { seq: 11, timestamp: 1000 },
    },
  ];

  const result = await annotateHistoryWithContextFrontierMetadata('session-a', history, [
    { kind: 'block', id: 7, level: 1, rawStartSeq: 10, rawEndSeq: 12 },
    { kind: 'message', seq: 11, preservedFromBlockId: 7 },
  ], {
    readBlocksByIdRange: async () => [{
      v: 1,
      kind: 'block',
      sessionId: 'session-a',
      agent: 'main',
      id: 7,
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 12,
      rawStartSeq: 10,
      rawEndSeq: 12,
      summary: 'block summary',
      createdAt: 2000,
    }],
  });

  assert.equal(result.matched, true);
  assert.equal(result.history[0].__meta?.contextBlock?.id, 7);
  assert.equal(result.history[0].__meta?.contextBlock?.sourceKind, 'message');
  assert.deepEqual(result.history[0].__meta?.contextFrontierItem, { kind: 'block', id: 7, level: 1, rawStartSeq: 10, rawEndSeq: 12 });
  assert.equal(result.history[1].__meta?.preservedFromBlockId, 7);
  assert.deepEqual(result.history[1].__meta?.contextFrontierItem, { kind: 'message', seq: 11, preservedFromBlockId: 7 });
});
