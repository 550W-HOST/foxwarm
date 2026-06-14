import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createSessionFrontierStore, formatArchiveBlockContextText, formatArchiveBlockTimeRange, isIgnoredCompactLifecycleSystemText, renderBlockMessage, shouldIgnoreMessageInCompactCandidates } from './layeredContext';
import { formatCompactionCompletionMarker } from './history';
import { Message } from '../types';
import { formatLocalTimeRange } from '../utils/localTime';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-frontier-store-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('recognizes compact lifecycle system texts that should be ignored in compact candidates', () => {
  assert.equal(isIgnoredCompactLifecycleSystemText('This session has been compacted. Messages before this are removed.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compacted message placeholder: 4 message(s) from #1-#4 were removed from working history here.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('Compaction completed. You can continue working now.'), true);
  assert.equal(isIgnoredCompactLifecycleSystemText('**COMPACTION COMPLETED. PARENT SESSION `parent-456`. CURRENT SESSION ID IS `session-123`.**'), true);
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

test('formatCompactionCompletionMarker uses the bold completion identity hint without a duplicate prefix or newline', () => {
  const text = formatCompactionCompletionMarker('session-123', 'Compaction completed. You can continue working now.', 'parent-456');
  assert.equal(text, '**COMPACTION COMPLETED. PARENT SESSION `parent-456`. CURRENT SESSION ID IS `session-123`.** You can continue working now.');
  assert.equal(formatCompactionCompletionMarker('session-123', 'Compaction completed.', 'parent-456'), '**COMPACTION COMPLETED. PARENT SESSION `parent-456`. CURRENT SESSION ID IS `session-123`.**');
  assert.equal(isIgnoredCompactLifecycleSystemText(text), true);
});

test('session frontier store uses lightweight no-backup writes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'session-a.frontier.json');
    const store = createSessionFrontierStore(filePath);

    assert.deepEqual(store.listCandidatePaths(), [filePath]);

    await store.write({
      v: 1,
      sessionId: 'session-a',
      nextBlockId: 4,
      frontier: [
        { kind: 'message', seq: 1 },
        { kind: 'block', id: 3, level: 1, rawStartSeq: 1, rawEndSeq: 2 },
      ],
    });

    const loaded = await store.readFromPath();
    assert.deepEqual(loaded, {
      v: 1,
      sessionId: 'session-a',
      nextBlockId: 4,
      frontier: [
        { kind: 'message', seq: 1 },
        { kind: 'block', id: 3, level: 1, rawStartSeq: 1, rawEndSeq: 2 },
      ],
    });

    const siblingFiles = await fs.readdir(dirPath);
    assert.deepEqual(siblingFiles, ['session-a.frontier.json']);
  });
});

test('renderBlockMessage includes raw message local time range when available', () => {
  const record: any = {
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
});
