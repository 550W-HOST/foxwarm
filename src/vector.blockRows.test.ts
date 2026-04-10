import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('block indexing creates exactly one vector row and truncates only embedding input when needed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-block-row-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const config = await import('./config');
  const vector = await import('./vector');
  const tokenCount = await import('./tokenCount');

  const sessionId = 'block-test';
  const archivePath = config.getSessionArchiveLogPath(sessionId);
  const records = [
    {
      v: 1,
      kind: 'message' as const,
      sessionId,
      agent: 'test-agent',
      seq: 1,
      timestamp: 1000,
      role: 'user' as const,
      message: {
        role: 'user' as const,
        parts: [{ text: 'anchor message one' }],
        __meta: { seq: 1, timestamp: 1000 },
      },
    },
    {
      v: 1,
      kind: 'message' as const,
      sessionId,
      agent: 'test-agent',
      seq: 2,
      timestamp: 2000,
      role: 'model' as const,
      message: {
        role: 'model' as const,
        parts: [{ text: 'anchor message two' }],
        __meta: { seq: 2, timestamp: 2000 },
      },
    },
  ];

  await fs.outputFile(archivePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

  const summary = 'block-summary '.repeat(900);
  const row = await vector.createRowFromBlockRecord({
    v: 1,
    kind: 'block',
    sessionId,
    agent: 'test-agent',
    id: 7,
    level: 1,
    sourceKind: 'message',
    sourceStart: 1,
    sourceEnd: 2,
    rawStartSeq: 1,
    rawEndSeq: 2,
    summary,
    createdAt: 2500,
  });

  assert.ok(row, 'expected a block row to be created');
  assert.equal(row?.id, `${sessionId}:block:7:0`);
  assert.equal(row?.message_id, `${sessionId}:block:7`);
  assert.equal(row?.chunk_index, 0);
  assert.equal(row?.chunk_count, 1);
  assert.equal(row?.text, summary.trim());
  assert.ok(tokenCount.estimateTokenCount(row?.chunk_text || '') <= 1500);
  assert.ok((row?.chunk_text || '').length < summary.trim().length, 'embedding input should be truncated for oversized block summaries');
  assert.equal(row?.start_timestamp, 1000);
  assert.equal(row?.end_timestamp, 2000);
});
