import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function record(sessionId: string, seq: number, text: string) {
  return { v: 1 as const, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq, role: 'user' as const,
    message: { role: 'user', parts: [{ text }], __meta: { seq, timestamp: seq } } };
}

async function seedStaleGeneration(filePath: string, sessionId: string, text: string): Promise<void> {
  const { ArchiveSearchIndex } = await import('./archiveSearchIndex');
  const index = ArchiveSearchIndex.open(filePath);
  index.upsertRawDocuments(sessionId, [{
    sessionId, agent: 'main', memoryKind: 'raw', sourceKey: '99', sourceFamily: `${sessionId}:raw:99-99`,
    text, seq: 99, startSeq: 99, endSeq: 99, rawStartSeq: 99, rawEndSeq: 99, timestamp: 99,
  }], 99);
  index.close();
}

test('pre-init reset repairs every recoverable main/next/backup generation before ID reuse', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-preinit-generations-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n  hybridSearch: true\n');
  const mainPath = path.join(root, 'state', 'db', 'archive-search.sqlite');
  const nextPath = `${mainPath}.next`;
  const backupPath = `${mainPath}.bak`;
  try {
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorLexicalRuntime');
    const vector = await import('./vector');

    await seedStaleGeneration(nextPath, 'reuse/next', 'StaleNextLifetime_99');
    await vector.resetSessionArchiveDerived('reuse/next');
    assert.equal(await fs.pathExists(mainPath), false, 'pre-init reset never creates missing main DB');
    await store.ensureSessionBranch('reuse/next');
    await store.writeArchiveMessages([record('reuse/next', 1, 'FreshNextLifetime_1')] as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('reuse/next').rawLastIndexedSeq, 1);
    assert((await runtime.query('FreshNextLifetime_1', 10, { sessionIds: ['reuse/next'] })).hits.length > 0);
    assert.equal((await runtime.query('StaleNextLifetime_99', 10, { sessionIds: ['reuse/next'] })).hits.length, 0);
    await runtime.shutdown();
    await store.rollbackUncommittedSessionArchive('reuse/next');
    await fs.remove(mainPath); await fs.remove(nextPath); await fs.remove(backupPath);

    await seedStaleGeneration(backupPath, 'reuse/backup', 'StaleBackupLifetime_99');
    await vector.resetSessionArchiveDerived('reuse/backup');
    assert.equal(await fs.pathExists(mainPath), false);
    await store.ensureSessionBranch('reuse/backup');
    await store.writeArchiveMessages([record('reuse/backup', 1, 'FreshBackupLifetime_1')] as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('reuse/backup').rawLastIndexedSeq, 1);
    assert((await runtime.query('FreshBackupLifetime_1', 10, { sessionIds: ['reuse/backup'] })).hits.length > 0);
    assert.equal((await runtime.query('StaleBackupLifetime_99', 10, { sessionIds: ['reuse/backup'] })).hits.length, 0);
    await runtime.shutdown();
    await store.rollbackUncommittedSessionArchive('reuse/backup');
    await fs.remove(mainPath); await fs.remove(nextPath); await fs.remove(backupPath);

    await fs.outputFile(nextPath, Buffer.from('corrupt next generation'));
    await vector.resetSessionArchiveDerived('reuse/corrupt-next');
    assert.equal(await fs.pathExists(nextPath), false, 'rebuildable corrupt next cannot survive reset for later promotion');
    assert.equal(await fs.pathExists(mainPath), false);
    await store.ensureSessionBranch('reuse/corrupt-next');
    await store.writeArchiveMessages([record('reuse/corrupt-next', 1, 'FreshAfterCorruptNext_1')] as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('reuse/corrupt-next').rawLastIndexedSeq, 1);
    assert((await runtime.query('FreshAfterCorruptNext_1', 10, { sessionIds: ['reuse/corrupt-next'] })).hits.length > 0);
    await runtime.shutdown();
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
