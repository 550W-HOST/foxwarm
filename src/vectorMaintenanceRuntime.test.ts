import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('startup maintenance compacts an existing fragmented table before startup work completes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-maintenance-runtime-'));
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(
    path.join(root, 'state', 'config.yaml'),
    'vectorMaintenance:\n  enabled: true\n  retentionHours: 24\n',
  );

  const lancedb = await import('@lancedb/lancedb');
  const dbPath = path.join(root, 'state', 'db');
  const db = await lancedb.connect(dbPath);
  const table = await db.createTable('messages_v7', [{ id: 0, vector: [0, 1] }]);
  for (let id = 1; id <= 260; id += 1) {
    await table.add([{ id, vector: [id, id + 1] }]);
  }
  const before = await table.stats();
  table.close?.();
  db.close?.();

  let vector: typeof import('./vector') | undefined;
  try {
    vector = await import('./vector');
    await vector.init({ useWorker: false });
    assert.equal(vector.getVectorServiceStatus().ready, true, 'table-open readiness must not await maintenance');
    await vector.waitForStartupArchiveVectorBackfill();
    await vector.shutdown();

    const verifyDb = await lancedb.connect(dbPath);
    const verifyTable = await verifyDb.openTable('messages_v7');
    const after = await verifyTable.stats();
    assert.equal(after.numRows, before.numRows);
    assert.ok(after.fragmentStats.numFragments < before.fragmentStats.numFragments);
    verifyTable.close?.();
    verifyDb.close?.();
  } finally {
    await vector?.shutdown();
    await fs.remove(root);
  }
});
