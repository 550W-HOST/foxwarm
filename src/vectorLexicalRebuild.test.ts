import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

function record(sessionId: string, seq: number) {
  return { v: 1 as const, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq, role: 'user' as const,
    message: { role: 'user', parts: [{ text: `RebuildToken_${seq}` }], __meta: { seq, timestamp: seq } } };
}

function makeIncompatible(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.prepare(`UPDATE archive_search_metadata SET value = '999' WHERE key = 'schema_version'`).run();
  db.close();
}

function makeMalformedSchema(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.exec(`DROP TRIGGER archive_search_documents_ai`);
  db.close();
}

test('lexical incompatible-schema shadow rebuild is resumable, promotes safely, and keeps bounded failure states', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-rebuild-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n  hybridSearch: true\n');
  const mainPath = path.join(root, 'state', 'db', 'archive-search.sqlite');
  const nextPath = `${mainPath}.next`;
  const backupPath = `${mainPath}.bak`;
  try {
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorLexicalRuntime');
    const { ArchiveSearchIndex } = await import('./archiveSearchIndex');
    await store.ensureSessionBranch('rebuild/session');
    await store.writeArchiveMessages(Array.from({ length: 520 }, (_, index) => record('rebuild/session', index + 1)) as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    await runtime.shutdown();
    makeIncompatible(mainPath);

    let releaseBatch!: () => void;
    let markBatch!: () => void;
    const batchEntered = new Promise<void>(resolve => { markBatch = resolve; });
    const batchRelease = new Promise<void>(resolve => { releaseBatch = resolve; });
    runtime.setTestHooks({ yieldControl: async () => { markBatch(); await batchRelease; } });
    await runtime.init();
    await batchEntered;
    const rebuilding = runtime.getStatus('rebuild/session');
    assert.equal(rebuilding.ready, false);
    assert.equal(rebuilding.rebuilding, true);
    assert.equal(rebuilding.backfilling, true);
    assert.equal(JSON.stringify(rebuilding).includes(root), false);
    assert.equal(JSON.stringify(rebuilding).includes('RebuildToken'), false);
    const unavailableDuringRebuild = await runtime.query('RebuildToken_1', 10, { sessionIds: ['rebuild/session'] });
    assert.equal(unavailableDuringRebuild.metadata.coverageComplete, false);
    assert.equal(unavailableDuringRebuild.metadata.ready, false);
    await store.writeArchiveMessages([record('rebuild/session', 521)] as any);
    const shutting = runtime.shutdown();
    releaseBatch();
    await shutting;
    assert.equal(await fs.pathExists(nextPath), true, 'committed partial next remains restart-resumable');

    runtime.setTestHooks();
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('rebuild/session').ready, true);
    assert.equal(runtime.getStatus('rebuild/session').rawLastIndexedSeq, 521, 'Archive hint committed during rebuild is caught before promotion');
    assert.equal(await fs.pathExists(nextPath), false);
    assert.equal(await fs.pathExists(backupPath), false);
    const rebuilt = await runtime.query('RebuildToken_521', 10, { sessionIds: ['rebuild/session'] });
    assert.equal(rebuilt.metadata.coverageComplete, true);
    await runtime.shutdown();

    await fs.rename(mainPath, backupPath);
    const partialNext = ArchiveSearchIndex.open(nextPath);
    const resumedGeneration = partialNext.getGeneration();
    partialNext.close();
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('rebuild/session').generation, resumedGeneration, 'main-to-backup gap resumes the existing valid next generation');
    assert.equal(await fs.pathExists(backupPath), false);
    await runtime.shutdown();

    await fs.copy(mainPath, backupPath);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('rebuild/session').ready, true);
    assert.equal(await fs.pathExists(backupPath), false, 'healthy promoted main wins and cleans stale backup');
    await runtime.shutdown();

    await fs.outputFile(mainPath, Buffer.from('this is not sqlite'));
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('rebuild/session').ready, true, 'non-SQLite derived main is quarantined and rebuilt through next');
    await runtime.shutdown();

    makeMalformedSchema(mainPath);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('rebuild/session').ready, true, 'malformed derived schema rebuilds without in-place mutation');
    await runtime.shutdown();

    makeIncompatible(mainPath);
    runtime.setTestHooks({ getFreeBytes: async () => 0 });
    await runtime.init();
    await runtime.waitForStartupBackfill();
    const noSpace = runtime.getStatus('rebuild/session');
    assert.equal(noSpace.ready, false);
    assert.equal(noSpace.rebuilding, false);
    assert.equal(noSpace.lastErrorCode, 'LEXICAL_REBUILD_SPACE');
    await runtime.shutdown();

    runtime.setTestHooks({
      beforePromotionValidation: async () => { makeIncompatible(mainPath); },
      getFreeBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    await runtime.init();
    await runtime.waitForStartupBackfill();
    const rolledBack = runtime.getStatus('rebuild/session');
    assert.equal(rolledBack.ready, false);
    assert.equal(rolledBack.lastErrorCode, 'LEXICAL_REBUILD_PROMOTION_FAILED');
    assert.equal(await fs.pathExists(mainPath), true, 'promotion validation failure restores backup main');
    assert.equal(await fs.pathExists(nextPath), true, 'failed promoted generation remains as resumable next');
    await runtime.shutdown();
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
