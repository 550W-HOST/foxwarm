import test from 'node:test';
import assert from 'node:assert/strict';
import { formatArchiveBlockContextText, formatArchiveBlockSummary, formatArchiveBlockTimeRange, isCompactCompletionSystemText, isIgnoredCompactLifecycleSystemText, renderBlockMessage, shouldIgnoreMessageInCompactCandidates, shouldRemoveOldCompactCompletionMessage } from './layeredContext';
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
      { system: '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" hint="You can continue working now." />' },
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

test('identifies only removable compact-completion notices without treating other boundaries or real content as disposable', () => {
  const completion = '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent" currentSessionId="child" />';
  assert.equal(isCompactCompletionSystemText(completion), true);
  assert.equal(isCompactCompletionSystemText('Compaction completed. You can continue working now.'), true);
  assert.equal(isCompactCompletionSystemText('<foxwarm-system kind="session-boundary" event="history-inherited" parentSessionId="parent" currentSessionId="child" />'), false);

  assert.equal(shouldRemoveOldCompactCompletionMessage({
    role: 'user',
    parts: [{ system: completion }, { system: '<foxwarm-system kind="goal-reminder" />' }],
  }), true);
  assert.equal(shouldRemoveOldCompactCompletionMessage({
    role: 'user',
    parts: [{ system: completion }, { text: 'actual user content must survive' }],
  }), false);
  assert.equal(shouldRemoveOldCompactCompletionMessage({
    role: 'user',
    parts: [{ system: '<foxwarm-system kind="session-boundary" event="history-inherited" parentSessionId="parent" currentSessionId="child" />' }],
  }), false);
});

test('formatCompactionCompletionMarker uses foxwarm metadata without a duplicate legacy prefix', () => {
  const text = formatCompactionCompletionMarker('session-123', 'Compaction completed. You can continue working now.', 'parent-456');
  assert.equal(text, '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" hint="You can continue working now." />');
  assert.equal(formatCompactionCompletionMarker('session-123', 'Compaction completed.', 'parent-456'), '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" />');
  assert.equal(
    formatCompactionCompletionMarker('session-123', 'Compaction completed. You can continue working now.', 'parent-456', ['code-index']),
    '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-456" currentSessionId="session-123" hint="You can continue working now. Note: The following skill(s) were loaded with skill(action=&quot;load&quot;) but their content was compacted away: `code-index`. If you still need them, call skill with action=&quot;load&quot; again." />'
  );
  assert.equal(isIgnoredCompactLifecycleSystemText(text), true);
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
});

test('block summary appends a stable generated memory-facts section', () => {
  const summary = formatArchiveBlockSummary('Original continuation summary.', [{
    kind: 'decision',
    text: 'Use block-associated durable facts.',
    context: 'Compaction contract',
    attributedTo: 'user',
  }]);
  assert.equal(summary, 'Original continuation summary.\n\n### Memory facts\n- **decision:** Use block-associated durable facts. _(context: Compaction contract; attributed to: user)_');
  assert.equal(formatArchiveBlockSummary('Old block summary.'), 'Old block summary.');
});
