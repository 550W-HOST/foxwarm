import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import type { Message } from './types';

function record(sessionId: string, seq: number, text: string) {
  const message: Message = { role: 'user', parts: [{ text }], __meta: { seq, timestamp: seq } };
  return { v: 1 as const, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq, role: 'user' as const, message };
}

test('lexical lifecycle serializes rename, reconciles aliases, and initializes fork baselines without copying documents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-lifecycle-'));
  const previous = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = root;
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n  hybridSearch: true\n');
  try {
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorLexicalRuntime');
    const vectorFacade = await import('./vector');
    await store.ensureSessionBranch('rename/old');
    await store.writeArchiveMessages([record('rename/old', 1, 'RenameToken_1')] as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();

    await store.renameSessionArchiveStore('rename/old', 'rename/new');
    await store.commitSessionIdRename('rename/old', 'rename/new');
    await runtime.renameSession('rename/old', 'rename/new');
    await runtime.waitForIdleForTests();
    const renamed = await runtime.query('RenameToken_1', 10, { sessionIds: ['rename/new'] });
    assert.equal(renamed.metadata.coverageComplete, true);
    assert(renamed.hits.some(hit => hit.session_id === 'rename/new' && hit.source_family.startsWith('rename/new:')));

    await store.ensureSessionBranch('active/old');
    await store.writeArchiveMessages(Array.from({ length: 50 }, (_, index) => record('active/old', index + 1, `ActiveRename_${index + 1}`)) as any);
    let releaseActive!: () => void;
    let markActive!: () => void;
    const activeEntered = new Promise<void>(resolve => { markActive = resolve; });
    const activeRelease = new Promise<void>(resolve => { releaseActive = resolve; });
    runtime.setTestHooks({ yieldControl: async () => { markActive(); await activeRelease; } });
    runtime.schedule('active/old', 50, 0);
    await activeEntered;
    await store.renameSessionArchiveStore('active/old', 'active/new');
    await store.commitSessionIdRename('active/old', 'active/new');
    let renameSettled = false;
    const activeRename = runtime.renameSession('active/old', 'active/new').then(() => { renameSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(renameSettled, false, 'lifecycle mutation waits behind the active lexical writer');
    releaseActive();
    await activeRename;
    runtime.setTestHooks();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('active/new').rawLastIndexedSeq, 50);

    await store.ensureSessionBranch('failure/old');
    await store.writeArchiveMessages([record('failure/old', 1, 'FailureRecoveryToken_1')] as any);
    runtime.force('failure/old');
    await runtime.waitForIdleForTests();
    await store.renameSessionArchiveStore('failure/old', 'failure/new');
    await store.commitSessionIdRename('failure/old', 'failure/new');
    runtime.setTestHooks({ beforeLifecycleMutation: () => { throw Object.assign(new Error('injected'), { code: 'LEXICAL_RENAME_INJECTED' }); } });
    await assert.doesNotReject(runtime.renameSession('failure/old', 'failure/new'));
    runtime.setTestHooks();
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('failure/new').rawLastIndexedSeq, 1, 'failed derived rename clears and backfills authoritative target');

    await store.ensureSessionBranch('conflict/old');
    await store.ensureSessionBranch('conflict/target');
    await store.writeArchiveMessages([record('conflict/old', 1, 'ConflictOld_1')] as any);
    await store.writeArchiveMessages([record('conflict/target', 1, 'ConflictTarget_1')] as any);
    runtime.force('conflict/old'); runtime.force('conflict/target');
    await runtime.waitForIdleForTests();
    await runtime.renameSession('conflict/old', 'conflict/target');
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('conflict/target').rawLastIndexedSeq, 1, 'target is rebuilt from its own Archive authority after conflict');
    assert.match(runtime.getStatus('conflict/target').lastErrorCode || '', /LEXICAL_RENAME_CONFLICT/);

    await store.ensureSessionBranch('fork/parent');
    await store.writeArchiveMessages(Array.from({ length: 3 }, (_, index) => record('fork/parent', index + 1, `ParentToken_${index + 1}`)) as any);
    runtime.force('fork/parent');
    await runtime.waitForIdleForTests();
    await store.ensureSessionBranch('fork/child', { parentSessionId: 'fork/parent', forkMessageSeq: 2, forkBlockId: 0 });
    await store.writeArchiveMessages([record('fork/child', 3, 'ChildLocalToken_3')] as any);
    await runtime.initializeForkCheckpoint('fork/child');
    await runtime.waitForIdleForTests();
    assert.equal(runtime.getStatus('fork/child').rawLastIndexedSeq, 3);
    const childLocal = await runtime.query('ChildLocalToken_3', 10, { sessionIds: ['fork/child'] });
    assert(childLocal.hits.some(hit => hit.session_id === 'fork/child'));
    const parentNotCopied = await runtime.query('ParentToken_1', 10, { sessionIds: ['fork/child'] });
    assert.equal(parentNotCopied.hits.length, 0, 'fork checkpoint copies no parent documents');

    await store.ensureSessionBranch('fork/status', { parentSessionId: 'fork/parent', forkMessageSeq: 2, forkBlockId: 0 });
    await runtime.initializeForkCheckpoint('fork/status');
    assert.equal(runtime.getStatus('fork/status').rawLastIndexedSeq, 2);
    assert.equal(runtime.getStatus('fork/status').pendingMessageCount, 0);
    await store.writeArchiveMessages([record('fork/status', 3, 'ForkPendingToken_3')] as any);
    runtime.schedule('fork/status', 3, 0);
    assert.equal(runtime.getStatus('fork/status').pendingMessageCount, 1, 'fork pending count starts at target-local suffix only');
    runtime.force('fork/status');
    await runtime.waitForIdleForTests();

    await store.ensureSessionBranch('fork/failure', { parentSessionId: 'fork/parent', forkMessageSeq: 2, forkBlockId: 0 });
    await store.writeArchiveMessages([record('fork/failure', 3, 'ForkFailureToken_3')] as any);
    runtime.force('fork/failure');
    await runtime.waitForIdleForTests();
    runtime.setTestHooks({ beforeLifecycleMutation: () => { throw Object.assign(new Error('fork injected'), { code: 'LEXICAL_FORK_INJECTED' }); } });
    await assert.doesNotReject(runtime.initializeForkCheckpoint('fork/failure'));
    runtime.setTestHooks();
    const failedFork = await runtime.query('ForkFailureToken_3', 10, { sessionIds: ['fork/failure'] });
    assert.equal(failedFork.metadata.coverageComplete, false, 'failed fork lifecycle clears derived target and forces exact fallback');

    await store.ensureSessionBranch('stale/old');
    await store.writeArchiveMessages([record('stale/old', 1, 'StartupReconcileToken_1')] as any);
    runtime.force('stale/old');
    await runtime.waitForIdleForTests();
    await runtime.shutdown();
    await store.renameSessionArchiveStore('stale/old', 'stale/new');
    await store.commitSessionIdRename('stale/old', 'stale/new');
    await runtime.init();
    await runtime.waitForStartupBackfill();
    const reconciled = await runtime.query('StartupReconcileToken_1', 10, { sessionIds: ['stale/new'] });
    assert.equal(reconciled.metadata.coverageComplete, true);
    assert(reconciled.hits.some(hit => hit.session_id === 'stale/new'));

    await store.ensureSessionBranch('rollback/new');
    await store.writeArchiveMessages([record('rollback/new', 1, 'PreInitRollbackToken_1')] as any);
    runtime.force('rollback/new');
    await runtime.waitForIdleForTests();
    await runtime.shutdown();
    await store.renameSessionArchiveStore('rollback/new', 'rollback/old');
    await store.commitSessionIdRename('rollback/new', 'rollback/old');
    await vectorFacade.renameSessionArchiveIndex('rollback/new', 'rollback/old');
    await runtime.init();
    await runtime.waitForStartupBackfill();
    const repairedRollback = await runtime.query('PreInitRollbackToken_1', 10, { sessionIds: ['rollback/old'] });
    assert.equal(repairedRollback.metadata.coverageComplete, true);
    assert(repairedRollback.hits.some(hit => hit.session_id === 'rollback/old'));
    const staleRollbackTarget = await runtime.query('PreInitRollbackToken_1', 10, { sessionIds: ['rollback/new'] });
    assert.equal(staleRollbackTarget.hits.length, 0, 'pre-init rollback reset leaves no stale target identity');

    await store.ensureSessionBranch('reuse/target');
    await store.writeArchiveMessages([record('reuse/target', 1, 'StaleLifetimeToken_1')] as any);
    runtime.force('reuse/target');
    await runtime.waitForIdleForTests();
    await runtime.shutdown();
    await store.rollbackUncommittedSessionArchive('reuse/target');
    await vectorFacade.resetSessionArchiveDerived('reuse/target');
    await store.ensureSessionBranch('reuse/target');
    await store.writeArchiveMessages([record('reuse/target', 1, 'FreshLifetimeToken_1')] as any);
    await runtime.init();
    await runtime.waitForStartupBackfill();
    const freshLifetime = await runtime.query('FreshLifetimeToken_1', 10, { sessionIds: ['reuse/target'] });
    assert.equal(freshLifetime.metadata.coverageComplete, true);
    assert(freshLifetime.hits.some(hit => hit.session_id === 'reuse/target'));
    const staleLifetime = await runtime.query('StaleLifetimeToken_1', 10, { sessionIds: ['reuse/target'] });
    assert.equal(staleLifetime.hits.length, 0, 'reused lower/equal sequence ID cannot inherit prior-lifetime lexical hits');

    await runtime.initializeForkCheckpoint('not/a/branch');
    assert.match(runtime.getStatus('not/a/branch').lastErrorCode || '', /LEXICAL_FORK_INVALID/);
    await runtime.shutdown();
  } finally {
    if (previous === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous;
    await fs.remove(root);
  }
});
