import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('dark lexical Archive batch/maxima reads are bounded and authority-pure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-archive-read-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  try {
    const store = await import('./archiveStore');
    assert.deepEqual(await store.readLocalArchiveMessageBatch('unknown/lexical-read', 0, 5000), []);
    assert.deepEqual(await store.readLocalArchiveBlockBatch('unknown/lexical-read', 0, 5000), []);
    assert.equal(await store.getSessionBranch('unknown/lexical-read'), null);

    await store.ensureSessionBranch('known/lexical-read');
    await store.writeArchiveMessages(Array.from({ length: 3 }, (_, index) => ({
      v: 1, kind: 'message', sessionId: 'known/lexical-read', agent: 'main', seq: index + 1,
      timestamp: index + 1, role: 'user', message: { role: 'user', parts: [{ text: `row-${index + 1}` }], __meta: { seq: index + 1, timestamp: index + 1 } },
    })) as any);
    const batch = await store.readLocalArchiveMessageBatch('known/lexical-read', 0, 2);
    assert.deepEqual(batch.map(row => row.seq), [1, 2]);
    const maxima = await store.listLocalArchiveSessionMaxima();
    assert.deepEqual(maxima.find(row => row.sessionId === 'known/lexical-read'), {
      sessionId: 'known/lexical-read', latestLocalMessageSeq: 3, latestLocalBlockId: 0,
    });
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
