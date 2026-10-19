import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

test('existing SQLite blocks stay unscored while new scores round-trip through archive readers and export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-block-friction-'));
  process.env.FOXWARM_DATA_DIR = root;
  const config = await import('../config');
  await fs.ensureDir(config.STATE_DIR);
  const oldDb = new DatabaseSync(config.ARCHIVE_DB_PATH);
  oldDb.exec(`CREATE TABLE archive_blocks (
    session_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'main', id INTEGER NOT NULL,
    level INTEGER NOT NULL, source_kind TEXT NOT NULL, source_start INTEGER NOT NULL,
    source_end INTEGER NOT NULL, source_block_ids_json TEXT, raw_start_seq INTEGER NOT NULL,
    raw_end_seq INTEGER NOT NULL, raw_start_timestamp INTEGER, raw_end_timestamp INTEGER,
    summary TEXT NOT NULL, memory_facts_json TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  INSERT INTO archive_blocks (session_id, id, level, source_kind, source_start, source_end,
    raw_start_seq, raw_end_seq, summary, created_at)
  VALUES ('friction', 1, 1, 'message', 1, 1, 1, 1, 'old unscored block', 1000);`);
  oldDb.close();
  const store = await import('./archiveStore');
  const layered = await import('./layeredContext');
  try {
    const [legacy] = await store.readLocalArchiveBlocks('friction');
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'frictionScore'), false);
    assert.equal(legacy.summary, 'old unscored block');
    const records = [0, 73].map((frictionScore, index) => ({
      v: 1, kind: 'block' as const, sessionId: 'friction', agent: 'main', id: index + 2, level: 1,
      sourceKind: 'message' as const, sourceStart: index + 2, sourceEnd: index + 2,
      rawStartSeq: index + 2, rawEndSeq: index + 2, summary: `scored-${index + 2}`,
      createdAt: 2000 + index, frictionScore,
    }));
    const inserted = await store.writeArchiveBlocks(records);
    assert.deepEqual(await store.writeArchiveBlocks(records), []);
    await assert.rejects(() => store.writeArchiveBlocks([{ ...records[0], frictionScore: 1 }]), /Immutable archive block conflict/);
    const local = await store.readLocalArchiveBlocks('friction');
    assert.deepEqual(local.map(record => record.frictionScore), [undefined, 0, 73]);
    assert.deepEqual((await store.readLocalArchiveBlockBatch('friction', 0, 10)).map(record => record.frictionScore), [undefined, 0, 73]);
    const effective = await store.readEffectiveArchiveBlocks('friction');
    assert.deepEqual(effective.map(record => record.frictionScore), [undefined, 0, 73]);
    assert.deepEqual(effective.map(record => layered.renderBlockMessage(record).__meta?.contextBlock?.frictionScore), [undefined, 0, 73]);
    const located = await store.locateEffectiveArchiveCandidatesBySubstring('friction', ['scored-']);
    assert.deepEqual(located.filter(hit => hit.kind === 'block').map(hit => (hit.record as typeof records[0]).frictionScore), [73, 0]);
    const output = path.join(root, 'export');
    await store.exportSessionArchivesJsonl(output);
    const exported = (await fs.readFile(path.join(output, 'friction.blocks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(exported.map(record => record.frictionScore), [undefined, 0, 73]);
    assert.equal(Object.prototype.hasOwnProperty.call(exported[0], 'frictionScore'), false);
    await store.rollbackUncommittedArchiveBlocks(inserted);
    assert.deepEqual((await store.readLocalArchiveBlocks('friction')).map(record => record.summary), ['old unscored block']);
  } finally {
    await fs.remove(root);
  }
});
