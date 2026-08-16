import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function messageRecord(sessionId: string, seq: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'main',
    seq,
    timestamp: seq * 1000,
    role: 'user' as const,
    message: {
      role: 'user' as const,
      parts: [{ text: `history range ${seq}` }],
      __meta: { seq, timestamp: seq * 1000 },
    },
  };
}

test('getArchivedMessages reports the full available range while reading only the selected SQL range', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-history-archive-range-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const store = require('./archiveStore') as typeof import('./archiveStore');
  const originalRead = store.readEffectiveArchiveMessages;
  const calls: Array<{ startSeq?: number; endSeq?: number }> = [];

  try {
    await store.initArchiveStore();
    await store.ensureSessionBranch('history-range');
    await store.writeArchiveMessages([1, 2, 3, 4, 5].map(seq => messageRecord('history-range', seq)));

    store.readEffectiveArchiveMessages = (async (sessionId: string, startSeq?: number, endSeq?: number) => {
      calls.push({ startSeq, endSeq });
      return originalRead(sessionId, startSeq, endSeq);
    }) as typeof store.readEffectiveArchiveMessages;

    const history = require('./history') as typeof import('./history');
    const result = await history.getArchivedMessages('history-range', { startSeq: 2, endSeq: 3 });

    assert.deepEqual(result.availableRange, { startSeq: 1, endSeq: 5 });
    assert.deepEqual(result.requestedRange, { startSeq: 2, endSeq: 3 });
    assert.deepEqual(result.records.map(record => record.seq), [2, 3]);
    assert.equal(result.totalMatched, 2);
    assert.equal(result.returnedCount, 2);
    assert.deepEqual(calls, [{ startSeq: 2, endSeq: 3 }], 'selected retrieval must not issue an unbounded content read');
  } finally {
    store.readEffectiveArchiveMessages = originalRead;
    await fs.remove(tempRoot);
  }
});
