import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function fullVectorRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    message_id: `${id}:message`,
    session_id: 'upsert-session',
    agent: 'test-agent',
    memory_kind: 'block',
    seq: 1,
    start_seq: 1,
    end_seq: 1,
    raw_start_seq: 1,
    raw_end_seq: 1,
    message_count: 1,
    role: 'model',
    timestamp: 1_700_000_000_000,
    start_timestamp: 1_700_000_000_000,
    end_timestamp: 1_700_000_000_000,
    chunk_index: 0,
    chunk_count: 1,
    text: `text-${id}`,
    chunk_text: `chunk-${id}`,
    vector: new Array(8).fill(id === 'existing' ? 1 : 2),
    block_id: 1,
    block_level: 1,
    source_kind: 'message',
    source_start: 1,
    source_end: 1,
    ...overrides,
  };
}

test('full vector rows merge in one version and retry without duplicate IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-upsert-'));
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(root);
  let table: any;
  try {
    table = await db.createTable('messages_v7', [
      fullVectorRow('existing', { text: 'old text', chunk_text: 'old chunk' }),
    ]);
    const rows = [
      fullVectorRow('existing', { text: 'updated text', chunk_text: 'updated chunk', block_level: 2 }),
      fullVectorRow('new', { block_id: 2, source_start: 2, source_end: 2 }),
    ];
    const beforeVersions = (await table.listVersions()).length;

    const first = await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
    const afterFirstVersions = (await table.listVersions()).length;
    assert.equal(afterFirstVersions, beforeVersions + 1);
    assert.equal(first.numUpdatedRows, 1);
    assert.equal(first.numInsertedRows, 1);

    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
    const afterRetryVersions = (await table.listVersions()).length;
    assert.equal(afterRetryVersions, afterFirstVersions + 1, 'each retry must remain one atomic version');

    const result = await table.query().select([
      'id',
      'text',
      'chunk_text',
      'block_id',
      'block_level',
      'source_start',
      'source_end',
    ]).toArray();
    const byId = new Map<string, any>(result.map((row: any) => [row.id, row]));
    assert.equal(result.length, 2);
    assert.equal(byId.size, 2, 'retry must leave exactly one row per deterministic ID');
    assert.deepEqual({ ...byId.get('existing') }, {
      id: 'existing',
      text: 'updated text',
      chunk_text: 'updated chunk',
      block_id: 1,
      block_level: 2,
      source_start: 1,
      source_end: 1,
    });
    assert.deepEqual({ ...byId.get('new') }, {
      id: 'new',
      text: 'text-new',
      chunk_text: 'chunk-new',
      block_id: 2,
      block_level: 1,
      source_start: 2,
      source_end: 2,
    });
  } finally {
    table?.close?.();
    db.close?.();
    await fs.remove(root);
  }
});