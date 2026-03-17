import test from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredCompactLifecycleSystemText, shouldIgnoreMessageInCompactCandidates } from './layeredContext';
import { Message } from '../types';

test('recognizes compact lifecycle system texts that should be ignored in compact candidates', () => {
  assert.equal(isIgnoredCompactLifecycleSystemText('This session has been compacted. Messages before this are removed.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compacted message placeholder: 4 message(s) from #1-#4 were removed from working history here.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compaction completed. You can continue working now.'), true);
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