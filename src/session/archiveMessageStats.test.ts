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
      parts: [{ text: `${sessionId} message ${seq}` }],
      __meta: { seq, timestamp: seq * 1000 },
    },
  };
}

function statsFromRows(rows: Array<{ seq: number }>) {
  return {
    count: rows.length,
    ...(rows.length > 0 ? { minSeq: rows[0].seq, maxSeq: rows[rows.length - 1].seq } : {}),
  };
}

test('effective and local archive message stats exactly mirror bounded lineage reads', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-message-stats-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  try {
    const store = await import('./archiveStore');
    await store.initArchiveStore();

    await store.ensureSessionBranch('stats-parent');
    await store.writeArchiveMessages([1, 2, 3, 5].map(seq => messageRecord('stats-parent', seq)));
    await store.ensureSessionBranch('stats-child', {
      parentSessionId: 'stats-parent',
      forkMessageSeq: 3,
      forkBlockId: 0,
    });
    await store.writeArchiveMessages([4, 7].map(seq => messageRecord('stats-child', seq)));
    await store.ensureSessionBranch('stats-empty');
    await store.commitSessionIdRename('stats-child-alias', 'stats-child');

    const ranges = [
      {} as { startSeq?: number; endSeq?: number },
      { startSeq: 2, endSeq: 4 },
      { startSeq: 3, endSeq: 3 },
      { startSeq: 4, endSeq: 4 },
      { startSeq: 6 },
      { endSeq: 2 },
      { startSeq: 8, endSeq: 9 },
      { startSeq: 5, endSeq: 2 },
    ];

    for (const range of ranges) {
      const effectiveRows = await store.readEffectiveArchiveMessages('stats-child-alias', range.startSeq, range.endSeq);
      const effectiveStats = await store.getEffectiveArchiveMessageStats('stats-child-alias', range.startSeq, range.endSeq);
      assert.deepEqual(effectiveStats, statsFromRows(effectiveRows), `effective range ${JSON.stringify(range)}`);

      const localRows = await store.readLocalArchiveMessages('stats-child-alias', range.startSeq, range.endSeq);
      const localStats = await store.getLocalArchiveMessageStats('stats-child-alias', range.startSeq, range.endSeq);
      assert.deepEqual(localStats, statsFromRows(localRows), `local range ${JSON.stringify(range)}`);
    }

    assert.deepEqual((await store.readEffectiveArchiveMessages('stats-child-alias')).map(row => row.seq), [1, 2, 3, 4, 7]);
    assert.deepEqual(await store.getEffectiveArchiveMessageStats('stats-child-alias'), { count: 5, minSeq: 1, maxSeq: 7 });
    assert.deepEqual(await store.getLocalArchiveMessageStats('stats-child-alias'), { count: 2, minSeq: 4, maxSeq: 7 });
    assert.deepEqual(await store.getEffectiveArchiveMessageStats('stats-empty'), { count: 0 });
    assert.deepEqual(await store.getLocalArchiveMessageStats('stats-empty'), { count: 0 });
    assert.deepEqual(await store.getEffectiveArchiveMessageStats('stats-unknown'), { count: 0 });
    assert.deepEqual(await store.getLocalArchiveMessageStats('stats-unknown'), { count: 0 });
    assert.equal(await store.hasArchivedSessionId('stats-unknown'), false, 'stats reads must not claim an unknown ID');

    await store.ensureSessionBranch('list-ordinary');
    await store.writeArchiveMessages([1, 2, 9].map(seq => messageRecord('list-ordinary', seq)));

    // A Session-tree child is not an archive fork unless archive_branches says so.
    await store.ensureSessionBranch('list-nonfork-child');
    await store.writeArchiveMessages([1, 6].map(seq => messageRecord('list-nonfork-child', seq)));

    await store.ensureSessionBranch('list-fork', {
      parentSessionId: 'list-ordinary',
      forkMessageSeq: 4,
      forkBlockId: 0,
    });
    await store.writeArchiveMessages([5, 8].map(seq => messageRecord('list-fork', seq)));

    await store.ensureSessionBranch('list-fork-chain', {
      parentSessionId: 'list-fork',
      forkMessageSeq: 8,
      forkBlockId: 0,
    });
    await store.writeArchiveMessages([9, 11].map(seq => messageRecord('list-fork-chain', seq)));
    await store.ensureSessionBranch('list-empty');

    assert.deepEqual(store.getSessionListSequenceMessageCounts([
      'list-ordinary', 'list-nonfork-child', 'list-fork', 'list-fork-chain', 'list-empty',
    ]), [
      { sessionId: 'list-ordinary', sequenceMessageCount: 9 },
      { sessionId: 'list-nonfork-child', sequenceMessageCount: 6 },
      { sessionId: 'list-fork', sequenceMessageCount: 4 },
      { sessionId: 'list-fork-chain', sequenceMessageCount: 3 },
      { sessionId: 'list-empty', sequenceMessageCount: 0 },
    ]);
    assert.deepEqual(store.getSessionListSequenceMessageCounts(['list-ordinary', 'list-ordinary']), [
      { sessionId: 'list-ordinary', sequenceMessageCount: 9 },
    ]);
  } finally {
    await fs.remove(tempRoot);
  }
});
