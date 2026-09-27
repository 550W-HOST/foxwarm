import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

function record(sessionId: string, seq: number, text: string) {
  return { v: 1 as const, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq, role: 'user' as const,
    message: { role: 'user', parts: [{ text }], __meta: { seq, timestamp: seq } } };
}

function makeIncompatible(filePath: string): void {
  const db = new DatabaseSync(filePath);
  db.prepare(`UPDATE archive_search_metadata SET value = '999' WHERE key = 'schema_version'`).run();
  db.close();
}

test('failed-lifetime reset fences active shadow and promotion-gap generations before ID reuse', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-reset-rebuild-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n  hybridSearch: true\n');
  const mainPath = path.join(root, 'state', 'db', 'archive-search.sqlite');
  try {
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorLexicalRuntime');
    await store.ensureSessionBranch('a-reset-target');
    await store.writeArchiveMessages([record('a-reset-target', 1, 'StaleShadowLifetime_1')] as any);
    await store.ensureSessionBranch('z-retained-history');
    await store.writeArchiveMessages([record('z-retained-history', 1, 'RetainedHistoricalToken_1')] as any);
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
    await store.rollbackUncommittedSessionArchive('a-reset-target');
    const resetDuringBatch = runtime.resetSessionDerived('a-reset-target');
    releaseBatch();
    await resetDuringBatch;
    runtime.setTestHooks();
    await runtime.waitForStartupBackfill();
    const removed = await runtime.query('StaleShadowLifetime_1', 10, { sessionIds: ['a-reset-target'] });
    assert.equal(removed.metadata.coverageComplete, false);
    assert.equal(removed.hits.length, 0, 'reset Session is absent from promoted shadow generation');
    const retained = await runtime.query('RetainedHistoricalToken_1', 10, { sessionIds: ['z-retained-history'] });
    assert.equal(retained.metadata.coverageComplete, true);
    assert(retained.hits.some(hit => hit.session_id === 'z-retained-history'), 'Archive-retained Session is not orphan-pruned');

    await store.ensureSessionBranch('a-reset-target');
    await store.writeArchiveMessages([record('a-reset-target', 1, 'FreshShadowLifetime_1')] as any);
    runtime.force('a-reset-target');
    await runtime.waitForIdleForTests();
    const fresh = await runtime.query('FreshShadowLifetime_1', 10, { sessionIds: ['a-reset-target'] });
    assert.equal(fresh.metadata.coverageComplete, true);
    assert(fresh.hits.some(hit => hit.session_id === 'a-reset-target'));
    const stale = await runtime.query('StaleShadowLifetime_1', 10, { sessionIds: ['a-reset-target'] });
    assert.equal(stale.hits.length, 0, 'reused seq1 indexes only new Archive lifetime');

    await store.ensureSessionBranch('gap-reset-target');
    await store.writeArchiveMessages([record('gap-reset-target', 1, 'StalePromotionGap_1')] as any);
    runtime.force('gap-reset-target');
    await runtime.waitForIdleForTests();
    await runtime.shutdown();
    makeIncompatible(mainPath);
    let releasePromotion!: () => void;
    let markPromotion!: () => void;
    const promotionEntered = new Promise<void>(resolve => { markPromotion = resolve; });
    const promotionRelease = new Promise<void>(resolve => { releasePromotion = resolve; });
    runtime.setTestHooks({ beforePromotionValidation: async () => { markPromotion(); await promotionRelease; } });
    await runtime.init();
    await promotionEntered;
    await store.rollbackUncommittedSessionArchive('gap-reset-target');
    const gapReset = runtime.resetSessionDerived('gap-reset-target');
    releasePromotion();
    await gapReset;
    runtime.setTestHooks();
    await runtime.waitForStartupBackfill();
    const gapRemoved = await runtime.query('StalePromotionGap_1', 10, { sessionIds: ['gap-reset-target'] });
    assert.equal(gapRemoved.metadata.coverageComplete, false);
    assert.equal(gapRemoved.hits.length, 0, 'promotion-gap reset is applied before lexical readiness');
    await runtime.shutdown();
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
