import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from './types';

function messageRecord(sessionId: string, seq: number, text: string) {
  const message: Message = { role: 'user', parts: [{ text }], __meta: { seq, timestamp: seq * 1000 } };
  return { v: 1 as const, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq * 1000, role: 'user' as const, message };
}

test('dark lexical owner backfills and schedules independently with fixed freshness bounds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-runtime-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n  hybridSearch: true\n');
  let embeddingCalls = 0;
  globalThis.fetch = (async () => { embeddingCalls += 1; throw new Error('embedding must not be called'); }) as any;
  try {
    const store = await import('./session/archiveStore');
    await store.ensureSessionBranch('lexical/runtime');
    await store.writeArchiveMessages(Array.from({ length: 55 }, (_, index) => messageRecord(
      'lexical/runtime', index + 1, index === 20 ? '部署节点 中文检索' : `RawToken_${index + 1}`,
    )) as any);
    await store.writeArchiveMessages([{
      ...messageRecord('lexical/runtime', 56, 'display hidden'),
      message: { role: 'user', modelVisible: false, parts: [{ text: 'HiddenToken_56' }], __meta: { seq: 56, timestamp: 56000 } },
    }] as any);
    await store.writeArchiveBlocks([{
      v: 1, kind: 'block', sessionId: 'lexical/runtime', agent: 'main', id: 1, level: 1,
      sourceKind: 'message', sourceStart: 1, sourceEnd: 56, rawStartSeq: 1, rawEndSeq: 56,
      summary: 'BlockToken_1 summary', memoryFacts: [{ kind: 'fact', text: 'FactToken_1 durable' }], createdAt: 60000,
    }] as any);

    const runtime = await import('./vectorLexicalRuntime');
    const callbacks = new Map<number, () => void>();
    let nextTimer = 1;
    let clock = 1000;
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => {},
    });
    await runtime.init();
    await runtime.waitForStartupBackfill();
    let status = runtime.getStatus('lexical/runtime');
    assert.equal(status.ready, true);
    assert.equal(status.backfilling, false);
    assert.equal(status.rawLastIndexedSeq, 56, 'non-substantive rows still advance scanned checkpoint');
    assert.equal(status.lastIndexedBlockId, 1);
    assert.equal(embeddingCalls, 0);

    await store.ensureSessionBranch('lexical/failure');
    await store.writeArchiveMessages([messageRecord('lexical/failure', 1, 'FailureRetryToken_1')] as any);
    const lexicalDbPath = path.join(root, 'state', 'db', 'archive-search.sqlite');
    const corruptDb = new DatabaseSync(lexicalDbPath);
    corruptDb.exec(`
      DROP TRIGGER archive_search_documents_ai;
      CREATE TRIGGER archive_search_documents_ai BEFORE INSERT ON archive_search_documents BEGIN
        SELECT RAISE(ABORT, 'injected lexical failure');
      END;
    `);
    corruptDb.close();
    runtime.force('lexical/failure', 1, 0);
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/failure').rawLastIndexedSeq, 0);
    assert.match(runtime.getStatus('lexical/failure').lastErrorCode || '', /ERR_SQLITE_ERROR|ERR_SQLITE_CONSTRAINT_TRIGGER|LEXICAL_INDEX_FAILED/);
    assert.equal(callbacks.size, 1, 'failed pending suffix is rearmed');
    assert.equal(runtime.getStatus('lexical/failure').maxLatencyDeadline, 301000);
    await store.writeArchiveMessages([messageRecord('lexical/failure', 2, 'OrdinaryBeforeRetryDeadline_2')] as any);
    runtime.schedule('lexical/failure', 2, 0);
    assert.equal(runtime.getStatus('lexical/failure').maxLatencyDeadline, 301000, 'ordinary suffix does not slide the failed-force deadline');
    const repairDb = new DatabaseSync(lexicalDbPath);
    repairDb.exec(`
      DROP TRIGGER archive_search_documents_ai;
      CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
        INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
      END;
    `);
    repairDb.close();
    const [retryTimerId, retryTimerCallback] = [...callbacks.entries()][0];
    callbacks.delete(retryTimerId);
    clock = 301000;
    retryTimerCallback();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/failure').rawLastIndexedSeq, 2);
    assert.equal(callbacks.size, 0, 'all content present when the retry deadline fired shares that one deadline');

    await store.ensureSessionBranch('lexical/retry-inflight-suffix');
    await store.writeArchiveMessages([messageRecord('lexical/retry-inflight-suffix', 1, 'RetryInflightToken_1')] as any);
    const secondCorruptDb = new DatabaseSync(lexicalDbPath);
    secondCorruptDb.exec(`
      DROP TRIGGER archive_search_documents_ai;
      CREATE TRIGGER archive_search_documents_ai BEFORE INSERT ON archive_search_documents BEGIN
        SELECT RAISE(ABORT, 'injected second lexical failure');
      END;
    `);
    secondCorruptDb.close();
    runtime.force('lexical/retry-inflight-suffix', 1, 0);
    await runtime.waitForIdleForTests();
    await store.writeArchiveMessages([messageRecord('lexical/retry-inflight-suffix', 2, 'RetryBeforeDeadline_2')] as any);
    runtime.schedule('lexical/retry-inflight-suffix', 2, 0);
    assert.equal(runtime.getStatus('lexical/retry-inflight-suffix').maxLatencyDeadline, 601000);
    const secondRepairDb = new DatabaseSync(lexicalDbPath);
    secondRepairDb.exec(`
      DROP TRIGGER archive_search_documents_ai;
      CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
        INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
      END;
    `);
    secondRepairDb.close();
    let releaseRetryRun!: () => void;
    let markRetryRunEntered!: () => void;
    const retryRunEntered = new Promise<void>(resolve => { markRetryRunEntered = resolve; });
    const retryRunRelease = new Promise<void>(resolve => { releaseRetryRun = resolve; });
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => { markRetryRunEntered(); await retryRunRelease; },
    });
    const [secondRetryTimerId, secondRetryTimerCallback] = [...callbacks.entries()][0];
    callbacks.delete(secondRetryTimerId);
    clock = 601000;
    secondRetryTimerCallback();
    await retryRunEntered;
    await store.writeArchiveMessages([messageRecord('lexical/retry-inflight-suffix', 3, 'RetryDuringRun_3')] as any);
    runtime.schedule('lexical/retry-inflight-suffix', 3, 0);
    releaseRetryRun();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/retry-inflight-suffix').rawLastIndexedSeq, 2);
    assert.equal(runtime.getStatus('lexical/retry-inflight-suffix').maxLatencyDeadline, 901000);
    const [postRetryTimerId, postRetryTimerCallback] = [...callbacks.entries()][0];
    callbacks.delete(postRetryTimerId);
    clock = 901000;
    postRetryTimerCallback();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/retry-inflight-suffix').rawLastIndexedSeq, 3);
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => {},
    });

    await store.ensureSessionBranch('lexical/suffix');
    await store.writeArchiveMessages(Array.from({ length: 50 }, (_, index) => messageRecord('lexical/suffix', index + 1, `SuffixToken_${index + 1}`)) as any);
    let releaseSuffix!: () => void;
    let markSuffixEntered!: () => void;
    const suffixEntered = new Promise<void>(resolve => { markSuffixEntered = resolve; });
    const suffixRelease = new Promise<void>(resolve => { releaseSuffix = resolve; });
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => { markSuffixEntered(); await suffixRelease; },
    });
    runtime.schedule('lexical/suffix', 50, 0);
    await suffixEntered;
    await store.writeArchiveMessages([messageRecord('lexical/suffix', 51, 'SuffixToken_51')] as any);
    runtime.schedule('lexical/suffix', 51, 0);
    releaseSuffix();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/suffix').rawLastIndexedSeq, 50);
    assert.ok(runtime.getStatus('lexical/suffix').maxLatencyDeadline, 'in-flight suffix gets a later deadline');
    const [suffixTimerId, suffixTimerCallback] = [...callbacks.entries()][0];
    callbacks.delete(suffixTimerId);
    suffixTimerCallback();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/suffix').rawLastIndexedSeq, 51);
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => {},
    });

    await store.ensureSessionBranch('lexical/force-no-hint');
    await store.writeArchiveMessages([messageRecord('lexical/force-no-hint', 1, 'NoHintForceToken_1')] as any);
    await store.writeArchiveBlocks([{
      v: 1, kind: 'block', sessionId: 'lexical/force-no-hint', agent: 'main', id: 1, level: 1,
      sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1,
      summary: 'NoHintForceBlock_1', createdAt: 1,
    }] as any);
    runtime.force('lexical/force-no-hint');
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/force-no-hint').rawLastIndexedSeq, 1);
    assert.equal(runtime.getStatus('lexical/force-no-hint').lastIndexedBlockId, 1);

    await store.ensureSessionBranch('lexical/force-active');
    await store.writeArchiveMessages(Array.from({ length: 50 }, (_, index) => messageRecord('lexical/force-active', index + 1, `ActiveForceToken_${index + 1}`)) as any);
    let releaseActiveForce!: () => void;
    let markActiveForceEntered!: () => void;
    const activeForceEntered = new Promise<void>(resolve => { markActiveForceEntered = resolve; });
    const activeForceRelease = new Promise<void>(resolve => { releaseActiveForce = resolve; });
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => { markActiveForceEntered(); await activeForceRelease; },
    });
    runtime.schedule('lexical/force-active', 50, 0);
    await activeForceEntered;
    await store.writeArchiveMessages([
      messageRecord('lexical/force-active', 51, 'ActiveForceToken_51'),
      messageRecord('lexical/force-active', 52, 'ActiveForceToken_52'),
      messageRecord('lexical/force-active', 53, 'OrdinarySuffixToken_53'),
    ] as any);
    runtime.force('lexical/force-active', 51, 0);
    runtime.force('lexical/force-active', 52, 0);
    runtime.schedule('lexical/force-active', 53, 0);
    releaseActiveForce();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/force-active').rawLastIndexedSeq, 52, 'coalesced force follows the active run immediately');
    assert.ok(runtime.getStatus('lexical/force-active').maxLatencyDeadline, 'ordinary suffix beyond force target gets a later deadline');
    const [ordinaryTimerId, ordinaryTimerCallback] = [...callbacks.entries()][0];
    callbacks.delete(ordinaryTimerId);
    ordinaryTimerCallback();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/force-active').rawLastIndexedSeq, 53);
    runtime.setTestHooks({
      now: () => clock,
      setTimer: (callback) => {
        const id = nextTimer++;
        callbacks.set(id, callback);
        return { id, unref() {} } as any;
      },
      clearTimer: (handle: any) => { callbacks.delete(handle.id); },
      yieldControl: async () => {},
    });

    await store.writeArchiveMessages([messageRecord('lexical/runtime', 57, 'TimerToken_57')] as any);
    runtime.schedule('lexical/runtime', 57, 1);
    const firstDeadline = runtime.getStatus('lexical/runtime').maxLatencyDeadline;
    assert.equal(firstDeadline, clock + 5 * 60_000);
    await store.writeArchiveMessages([messageRecord('lexical/runtime', 58, 'TimerToken_58')] as any);
    clock += 1000;
    runtime.schedule('lexical/runtime', 58, 1);
    assert.equal(runtime.getStatus('lexical/runtime').maxLatencyDeadline, firstDeadline, 'deadline is non-sliding');
    assert.equal(callbacks.size, 1);
    const [timerId, timerCallback] = [...callbacks.entries()][0];
    callbacks.delete(timerId);
    timerCallback();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/runtime').rawLastIndexedSeq, 58);

    await store.writeArchiveMessages(Array.from({ length: 50 }, (_, index) => messageRecord('lexical/runtime', 59 + index, `ThresholdToken_${59 + index}`)) as any);
    runtime.schedule('lexical/runtime', 108, 1);
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/runtime').rawLastIndexedSeq, 108);
    assert.equal(callbacks.size, 0);

    await store.writeArchiveBlocks([{
      v: 1, kind: 'block', sessionId: 'lexical/runtime', agent: 'main', id: 2, level: 1,
      sourceKind: 'message', sourceStart: 57, sourceEnd: 108, rawStartSeq: 57, rawEndSeq: 108,
      summary: 'BlockToken_2 immediate', memoryFacts: [{ kind: 'decision', text: 'FactToken_2 immediate' }], createdAt: 109000,
    }] as any);
    runtime.schedule('lexical/runtime', 108, 2);
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/runtime').lastIndexedBlockId, 2);

    await store.writeArchiveMessages([messageRecord('lexical/runtime', 109, 'ForceToken_109')] as any);
    runtime.schedule('lexical/runtime', 109, 2);
    assert.equal(callbacks.size, 1);
    runtime.force('lexical/runtime', 109, 2);
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('lexical/runtime').rawLastIndexedSeq, 109);
    assert.equal(callbacks.size, 0);

    await store.writeArchiveMessages([messageRecord('lexical/runtime', 110, 'ShutdownToken_110')] as any);
    runtime.schedule('lexical/runtime', 110, 2);
    await runtime.runMaintenance();
    await runtime.shutdown();
    assert.equal(callbacks.size, 0);

    const { ArchiveSearchIndex } = await import('./archiveSearchIndex');
    const dbPath = path.join(root, 'state', 'db', 'archive-search.sqlite');
    const index = ArchiveSearchIndex.open(dbPath);
    assert.equal(index.getCheckpoint('lexical/runtime').rawLastIndexedSeq, 110);
    assert.equal(index.getCheckpoint('lexical/runtime').lastIndexedBlockId, 2);
    assert.equal(index.getStatus().rawCount, 219, 'one display-only raw row is omitted across all forced/retry Sessions');
    assert.equal(index.getStatus().blockCount, 3);
    assert.equal(index.getStatus().factCount, 2);
    index.close();

    await runtime.init();
    await runtime.waitForStartupBackfill();
    assert.equal(runtime.getStatus('lexical/runtime').pendingMessageCount, 0);
    const identifierQuery = await runtime.query('NoHintForceToken_1', 10, { sessionIds: ['lexical/force-no-hint'] });
    assert.equal(identifierQuery.metadata.coverageComplete, true);
    assert.equal(identifierQuery.metadata.used, true);
    assert(identifierQuery.hits.some(hit => hit.source_family === 'lexical/force-no-hint:raw:1-1'));
    assert.equal(Object.prototype.hasOwnProperty.call(identifierQuery.hits[0], 'chunk_text'), false, 'derived lexical text is never presentation authority');
    const proseQuery = await runtime.query('immediate', 10, { sessionIds: ['lexical/runtime'] });
    assert(proseQuery.hits.some(hit => hit.kind === 'block' && hit.lexical_lane === 'prose'));
    const factQuery = await runtime.query('FactToken_2', 10, { sessionIds: ['lexical/runtime'] });
    assert(factQuery.hits.some(hit => hit.kind === 'block' && hit.source_family === 'lexical/runtime:block:2'));
    const cjkQuery = await runtime.query('中文检索', 10, { sessionIds: ['lexical/runtime'] });
    assert(cjkQuery.hits.some(hit => hit.kind === 'raw' && hit.lexical_lane === 'prose'));

    await store.ensureSessionBranch('lexical/toctou');
    await store.writeArchiveMessages([messageRecord('lexical/toctou', 1, 'StableSnapshotToken_1')] as any);
    runtime.force('lexical/toctou');
    await runtime.waitForIdleForTests();
    const stableSnapshot = await runtime.query('StableSnapshotToken_1', 10, { sessionIds: ['lexical/toctou'] });
    assert.equal(stableSnapshot.metadata.coverageComplete, true);
    runtime.setTestHooks({
      afterCoveragePre: async () => {
        await store.writeArchiveMessages([messageRecord('lexical/toctou', 2, 'AppendBetweenCoverageAndFts_2')] as any);
      },
    });
    const appendDuringQuery = await runtime.query('StableSnapshotToken_1', 10, { sessionIds: ['lexical/toctou'] });
    assert.equal(appendDuringQuery.metadata.coverageComplete, false, 'authority append between pre-coverage and FTS cannot suppress fallback');
    runtime.setTestHooks();
    runtime.force('lexical/toctou');
    await runtime.waitForIdleForTests();
    runtime.setTestHooks({
      afterCoveragePre: async () => {
        await store.writeArchiveMessages([messageRecord('lexical/toctou', 3, 'AppendAndCatchUpBeforePost_3')] as any);
        runtime.force('lexical/toctou');
        await runtime.waitForIdleForTests();
      },
    });
    const caughtUpDuringQuery = await runtime.query('StableSnapshotToken_1', 10, { sessionIds: ['lexical/toctou'] });
    assert.equal(caughtUpDuringQuery.metadata.coverageComplete, false, 'changed authority signature remains incomplete even if lexical catches up before post-check');
    runtime.setTestHooks();

    await store.writeArchiveMessages([messageRecord('lexical/runtime', 111, 'CoveragePendingToken_111')] as any);
    const cappedLineage = await runtime.query('immediate', 10, {
      lineageSessions: [{ sessionId: 'lexical/runtime', maxMessageSeq: 110, maxBlockId: 2 }],
    });
    assert.equal(cappedLineage.metadata.coverageComplete, true, 'fork caps bound exact coverage requirements');
    const incompleteExact = await runtime.query('CoveragePendingToken_111', 10, { sessionIds: ['lexical/runtime'] });
    assert.equal(incompleteExact.metadata.coverageComplete, false);
    assert.deepEqual(incompleteExact.hits, []);
    const partialAgent = await runtime.query('NoHintForceToken_1', 10, { agent: 'main' });
    assert.equal(partialAgent.metadata.coverageComplete, false);
    assert.equal(partialAgent.metadata.used, true);
    runtime.setTestHooks({ beforeQuery: () => { throw Object.assign(new Error('do not expose query'), { code: 'INJECTED_QUERY_FAILURE' }); } });
    const failedQuery = await runtime.query('NoHintForceToken_1', 10, { sessionIds: ['lexical/force-no-hint'] });
    assert.deepEqual(failedQuery.hits, []);
    assert.equal(failedQuery.metadata.errorCode, 'INJECTED_QUERY_FAILURE');
    runtime.setTestHooks();
    await runtime.disableForDeferredLifecycle();
    const lifecycleDisabled = await runtime.query('NoHintForceToken_1', 10, { sessionIds: ['lexical/force-no-hint'] });
    assert.equal(lifecycleDisabled.metadata.ready, false);
    assert.equal(lifecycleDisabled.metadata.errorCode, 'LEXICAL_LIFECYCLE_DEFERRED');
    await runtime.shutdown();
    assert.equal(embeddingCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
