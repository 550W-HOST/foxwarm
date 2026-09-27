import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

test('unknown archive readers remain pure and a later explicit write can claim the same ID', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-pure-read-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_SYNC_FILE_LOG = '1';

  const config = await import('../config');
  const archiveStore = await import('./archiveStore');
  const toolsSessionAgent = await import('../toolsSessionAgent');
  const unknownId = 'typo-session-id';

  try {
    assert.deepEqual(await archiveStore.readLocalArchiveMessages(unknownId), []);
    assert.deepEqual(await archiveStore.readEffectiveArchiveMessages(unknownId), []);
    assert.deepEqual(await archiveStore.readLocalArchiveBlocks(unknownId), []);
    assert.deepEqual(await archiveStore.readEffectiveArchiveBlocks(unknownId), []);
    assert.deepEqual(await archiveStore.getVectorSearchLineage(unknownId), [{
      sessionId: unknownId,
      inherited: false,
      maxMessageSeq: undefined,
      maxBlockId: undefined,
    }]);
    assert.equal(await archiveStore.getSessionBranch(unknownId), null);

    assert.match(String(await toolsSessionAgent.tool_get_archived_messages({ sessionId: unknownId })), /No archived messages/);
    assert.match(String(await toolsSessionAgent.tool_get_archived_blocks({ sessionId: unknownId })), /No archived blocks/);
    assert.match(String(await toolsSessionAgent.tool_recall({ sessionId: unknownId, target: 'overview' })), /Recall overview/);

    assert.equal(await archiveStore.getSessionBranch(unknownId), null);
    assert.equal(await fs.pathExists(config.SESSION_ID_RESERVATIONS_LOG_PATH), false,
      'ordinary readers must not create or rewrite the reservation ledger');
    assert.equal(await archiveStore.hasArchivedSessionId(unknownId), false);
    assert.equal(await fs.pathExists(config.SESSION_ID_RESERVATIONS_LOG_PATH), false,
      'pure reservation lookup must not create an empty ledger');

    await archiveStore.writeArchiveMessages([{
      v: 1,
      kind: 'message',
      sessionId: unknownId,
      agent: 'main',
      seq: 1,
      timestamp: 1000,
      role: 'user',
      message: { role: 'user', parts: [{ text: 'explicit owner write' }], __meta: { seq: 1, timestamp: 1000 } },
    }]);
    await archiveStore.writeArchiveBlocks([{
      v: 1,
      kind: 'block',
      sessionId: unknownId,
      agent: 'main',
      id: 1,
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 1,
      rawStartSeq: 1,
      rawEndSeq: 1,
      summary: 'explicit owner block',
      createdAt: 2000,
    }]);

    assert.equal((await archiveStore.getSessionBranch(unknownId))?.sessionId, unknownId);
    assert.equal(await archiveStore.hasArchivedSessionId(unknownId), true);
    assert.equal((await archiveStore.readEffectiveArchiveMessages(unknownId))[0]?.message.parts[0]?.text, 'explicit owner write');
    assert.equal((await archiveStore.readEffectiveArchiveBlocks(unknownId))[0]?.summary, 'explicit owner block');
  } finally {
    await fs.remove(tempRoot);
  }
});
