import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RpcError } from './rpc';
import { SessionWorkerStore } from './sessionWorkerStore';

async function withStore(run: (store: SessionWorkerStore, root: string) => Promise<void> | void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-store-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite'));
  store.open();
  try {
    await run(store, root);
  } finally {
    store.close();
    await fs.remove(root);
  }
}

function assertRpcCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof RpcError);
  assert.equal(error.code, code);
  return true;
}

test('session worker store durably fences generations and publishes mailbox cursor with head CAS', async () => {
  await withStore(store => {
    assert.equal(store.recoverOrphanedOwnerships(), 0);
    assert.deepEqual(store.getOwnership('agent/session'), {
      sessionId: 'agent/session', generation: 0, state: 'inactive', headRevision: 0,
      mailboxCursor: 0, lastActivityAt: 0, updatedAt: store.getOwnership('agent/session').updatedAt,
    });

    const first = store.enqueueIntent('agent/session', 'intent-1', 'enqueue', { z: 1, a: ['x'] });
    const duplicate = store.enqueueIntent('agent/session', 'intent-1', 'enqueue', { a: ['x'], z: 1 });
    assert.equal(duplicate.id, first.id);
    assert.throws(
      () => store.enqueueIntent('agent/session', 'intent-1', 'enqueue', { z: 2 }),
      error => assertRpcCode(error, 'SESSION_WORKER_INTENT_CONFLICT'),
    );

    const starting = store.beginGeneration('agent/session');
    assert.equal(starting.generation, 1);
    assert.equal(starting.state, 'starting');
    assert.throws(
      () => store.beginGeneration('agent/session'),
      error => assertRpcCode(error, 'SESSION_WORKER_OWNED'),
    );
    const ready = store.markReady('agent/session', 1, 1234);
    assert.equal(ready.workerPid, 1234);
    assert.equal(ready.state, 'ready');
    assert.throws(
      () => store.markReady('agent/session', 0, 999),
      error => assertRpcCode(error, 'SESSION_WORKER_STALE_GENERATION'),
    );

    const published = store.publishHead({
      sessionId: 'agent/session', generation: 1, expectedRevision: 0, revision: 1,
      headPath: 'snapshots/agent/session/1-1.json', headSha256: 'abc', appliedMailboxIds: [first.id],
    });
    assert.equal(published.headRevision, 1);
    assert.equal(published.mailboxCursor, first.id);
    assert.deepEqual(store.listPendingIntents('agent/session'), []);
    assert.throws(
      () => store.publishHead({
        sessionId: 'agent/session', generation: 1, expectedRevision: 0, revision: 1,
        headPath: 'stale', headSha256: 'stale', appliedMailboxIds: [],
      }),
      error => assertRpcCode(error, 'SESSION_WORKER_STALE_GENERATION'),
    );

    const second = store.enqueueIntent('agent/session', 'intent-2', 'control', { action: 'stop' });
    const third = store.enqueueIntent('agent/session', 'intent-3', 'enqueue', { text: 'later' });
    assert.throws(
      () => store.publishHead({
        sessionId: 'agent/session', generation: 1, expectedRevision: 1, revision: 2,
        headPath: 'out-of-order', headSha256: 'bad', appliedMailboxIds: [third.id],
      }),
      error => assertRpcCode(error, 'SESSION_WORKER_MAILBOX_CONFLICT'),
    );
    store.markDraining('agent/session', 1);
    const drainedHead = store.publishHead({
      sessionId: 'agent/session', generation: 1, expectedRevision: 1, revision: 2,
      headPath: 'snapshots/agent/session/1-2.json', headSha256: 'def', appliedMailboxIds: [second.id],
    });
    assert.equal(drainedHead.headRevision, 2);
    assert.deepEqual(store.listPendingIntents('agent/session').map(item => item.id), [third.id]);
    const exited = store.markExitObserved('agent/session', 1, 'stopped:0');
    assert.equal(exited.state, 'inactive');
    assert.equal(exited.workerPid, undefined);
    assert.equal(store.beginGeneration('agent/session').generation, 2);
  });
});

test('session worker store startup recovery clears only process ownership and preserves durable heads/mailbox', async () => {
  await withStore(store => {
    const intent = store.enqueueIntent('s', 'i', 'enqueue', { value: 1 });
    store.beginGeneration('s');
    store.markReady('s', 1, 4321);
    store.publishHead({
      sessionId: 's', generation: 1, expectedRevision: 0, revision: 1,
      headPath: 'head.json', headSha256: 'hash', appliedMailboxIds: [intent.id],
    });
    assert.equal(store.recoverOrphanedOwnerships('test-restart'), 1);
    const recovered = store.getOwnership('s');
    assert.equal(recovered.state, 'inactive');
    assert.equal(recovered.workerPid, undefined);
    assert.equal(recovered.generation, 1);
    assert.equal(recovered.headRevision, 1);
    assert.equal(recovered.mailboxCursor, intent.id);
    assert.equal(recovered.lastExitReason, 'test-restart');
  });
});
