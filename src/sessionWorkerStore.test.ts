import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RpcError } from './rpc';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerStore } from './sessionWorkerStore';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-store-'));
  try { await run(root); } finally { await fs.remove(root); }
}

function assertRpcCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof RpcError); assert.equal(error.code, code); return true;
}

test('strict stable mailbox JSON round-trips across reopen and rejects invalid values before writes', async () => {
  await withRoot(async root => {
    const dbPath = path.join(root, 'runtime.sqlite');
    const store = new SessionWorkerStore(dbPath);
    const payload = { z: 1, a: [null, true, 'x', { b: 2, a: 1 }] };
    const first = store.enqueueIntent('s', 'same', 'enqueue', payload);
    const duplicate = store.enqueueIntent('s', 'same', 'enqueue', { a: [null, true, 'x', { a: 1, b: 2 }], z: 1 });
    assert.equal(duplicate.id, first.id);
    assert.throws(() => store.enqueueIntent('s', 'same', 'enqueue', { z: 2 }), error => assertRpcCode(error, 'SESSION_WORKER_INTENT_CONFLICT'));
    store.close();

    const reopened = new SessionWorkerStore(dbPath); reopened.open();
    assert.deepEqual(reopened.listPendingIntents('s')[0].payload, payload);
    assert.equal(reopened.countMailboxIntents(), 1);
    reopened.close();
    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    const rawPayload = (rawDb.prepare('SELECT payload_json FROM session_worker_mailbox WHERE session_id=? AND intent_id=?').get('s', 'same') as any).payload_json;
    assert.equal(rawPayload, '{"a":[null,true,"x",{"a":1,"b":2}],"z":1}');
    rawDb.close();

    const invalidStore = new SessionWorkerStore(path.join(root, 'invalid.sqlite'));
    const cyclic: any = {}; cyclic.self = cyclic;
    const sparse = new Array(2); sparse[1] = 'x';
    const extra: any[] = []; (extra as any).extra = true;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 });
    const values: unknown[] = [undefined, 1n, NaN, Infinity, -Infinity, sparse, extra, new Date(), cyclic, getter, Symbol('x')];
    for (const [index, value] of values.entries()) {
      assert.throws(() => invalidStore.enqueueIntent('s', `bad-${index}`, 'enqueue', value), error => assertRpcCode(error, 'SESSION_WORKER_INVALID_INTENT'));
    }
    assert.equal(invalidStore.countMailboxIntents(), 0);
    invalidStore.close();
  });
});

test('generation incarnation activation and ordered mailbox/head CAS fail closed', async () => {
  await withRoot(async root => {
    const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
    const first = store.enqueueIntent('agent/session', 'intent-1', 'enqueue', { value: 1 });
    const candidate = store.beginGeneration('agent/session', 'inc-1');
    assert.equal(candidate.state, 'candidate');
    assert.throws(() => store.publishHead({ sessionId: 'agent/session', generation: 1, incarnationId: 'inc-1', expectedRevision: 0,
      revision: 1, headPath: 'early', headSha256: 'early', appliedMailboxIds: [first.id] }), error => assertRpcCode(error, 'SESSION_WORKER_STALE_GENERATION'));
    const identity = readSessionWorkerProcessIdentity(process.pid)!;
    store.registerCandidate('agent/session', 1, 'inc-1', process.pid, identity);
    store.activateCandidate('agent/session', 1, 'inc-1', process.pid, identity);
    store.verifyActivatedIncarnation('agent/session', 1, 'inc-1', process.pid, identity);

    const published = store.publishHead({ sessionId: 'agent/session', generation: 1, incarnationId: 'inc-1', expectedRevision: 0,
      revision: 1, headPath: 'head-1', headSha256: 'hash-1', appliedMailboxIds: [first.id] });
    assert.equal(published.headRevision, 1);
    const second = store.enqueueIntent('agent/session', 'intent-2', 'control', { action: 'stop' });
    const third = store.enqueueIntent('agent/session', 'intent-3', 'enqueue', { text: 'later' });
    assert.throws(() => store.publishHead({ sessionId: 'agent/session', generation: 1, incarnationId: 'inc-1', expectedRevision: 1,
      revision: 2, headPath: 'skip', headSha256: 'skip', appliedMailboxIds: [third.id] }), error => assertRpcCode(error, 'SESSION_WORKER_MAILBOX_CONFLICT'));
    store.markDraining('agent/session', 1, 'inc-1');
    store.publishHead({ sessionId: 'agent/session', generation: 1, incarnationId: 'inc-1', expectedRevision: 1,
      revision: 2, headPath: 'head-2', headSha256: 'hash-2', appliedMailboxIds: [second.id] });
    assert.deepEqual(store.listPendingIntents('agent/session').map(item => item.id), [third.id]);
    store.markExitObserved('agent/session', 1, 'inc-1', 'stopped');
    assert.equal(store.beginGeneration('agent/session', 'inc-2').generation, 2);
    store.close();
  });
});

test('an unregistered fork candidate is inert and can only be abandoned, never activated', async () => {
  await withRoot(async root => {
    const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
    store.beginGeneration('candidate', 'abandoned-incarnation');
    assert.throws(
      () => store.verifyActivatedIncarnation('candidate', 1, 'abandoned-incarnation', process.pid, readSessionWorkerProcessIdentity(process.pid)!),
      error => assertRpcCode(error, 'SESSION_WORKER_NOT_ACTIVATED'),
    );
    store.clearUnregisteredCandidate('candidate', 1, 'abandoned-incarnation', 'parent-crashed-before-registration');
    assert.equal(store.beginGeneration('candidate', 'replacement').generation, 2);
    store.close();
  });
});

type ChildAction = { type: string; [key: string]: unknown };
async function runConcurrent(dbPath: string, actions: ChildAction[]): Promise<any[]> {
  const children = actions.map(action => fork(path.join(__dirname, 'sessionWorkerStoreConcurrencyChild.js'), [], {
    env: { ...process.env, FOXWARM_TEST_STORE_PATH: dbPath, FOXWARM_TEST_STORE_ACTION: JSON.stringify(action) },
    serialization: 'advanced', silent: true,
  }));
  try {
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('message', message => (message as any)?.kind === 'opened' && resolve());
      child.send({ kind: 'open' });
    })));
    const results = await Promise.all(children.map(child => new Promise<any>((resolve, reject) => {
      child.once('error', reject); child.on('message', message => { if ((message as any)?.kind === 'result') resolve((message as any).value); });
      child.send({ kind: 'run' });
    })));
    return results;
  } finally {
    for (const child of children) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
}

test('two process connections safely open, deduplicate/enqueue, claim generation, and race publication CAS', async () => {
  await withRoot(async root => {
    const dbPath = path.join(root, 'runtime.sqlite');
    const same = await runConcurrent(dbPath, [
      { type: 'enqueue', sessionId: 's', intentId: 'same', kind: 'enqueue', payload: { b: 2, a: 1 } },
      { type: 'enqueue', sessionId: 's', intentId: 'same', kind: 'enqueue', payload: { a: 1, b: 2 } },
    ]);
    assert.equal(same[0].ok, true); assert.equal(same[1].ok, true); assert.equal(same[0].result.id, same[1].result.id);
    const conflict = await runConcurrent(dbPath, [
      { type: 'enqueue', sessionId: 's', intentId: 'conflict', kind: 'enqueue', payload: { value: 1 } },
      { type: 'enqueue', sessionId: 's', intentId: 'conflict', kind: 'enqueue', payload: { value: 2 } },
    ]);
    assert.equal(conflict.filter(item => item.ok).length, 1);
    assert.equal(conflict.filter(item => item.code === 'SESSION_WORKER_INTENT_CONFLICT').length, 1);
    const different = await runConcurrent(dbPath, [
      { type: 'enqueue', sessionId: 's', intentId: 'a', kind: 'enqueue', payload: 1 },
      { type: 'enqueue', sessionId: 's', intentId: 'b', kind: 'enqueue', payload: 2 },
    ]);
    assert.notEqual(different[0].result.id, different[1].result.id);
    const claims = await runConcurrent(dbPath, [
      { type: 'begin', sessionId: 'owner', incarnationId: 'inc-a' },
      { type: 'begin', sessionId: 'owner', incarnationId: 'inc-b' },
    ]);
    assert.equal(claims.filter(item => item.ok).length, 1);
    assert.equal(claims.filter(item => item.code === 'SESSION_WORKER_OWNED').length, 1);

    const store = new SessionWorkerStore(dbPath); store.open();
    const owner = store.getOwnership('owner');
    const identity = readSessionWorkerProcessIdentity(process.pid)!;
    store.registerCandidate('owner', owner.generation, owner.incarnationId!, process.pid, identity);
    store.activateCandidate('owner', owner.generation, owner.incarnationId!, process.pid, identity);
    store.close();
    const publications = await runConcurrent(dbPath, [
      { type: 'publish', sessionId: 'owner', generation: owner.generation, incarnationId: owner.incarnationId,
        expectedRevision: 0, revision: 1, headPath: 'a', headSha256: 'a', appliedMailboxIds: [] },
      { type: 'publish', sessionId: 'owner', generation: owner.generation, incarnationId: owner.incarnationId,
        expectedRevision: 0, revision: 1, headPath: 'b', headSha256: 'b', appliedMailboxIds: [] },
    ]);
    assert.equal(publications.filter(item => item.ok).length, 1);
    assert.equal(publications.filter(item => item.code === 'SESSION_WORKER_STALE_GENERATION').length, 1);
  });
});

test('schema migration upgrades known v0 and rejects unknown newer versions', async () => {
  await withRoot(async root => {
    const legacyPath = path.join(root, 'legacy.sqlite');
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE session_worker_ownership(session_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'inactive',worker_pid INTEGER,head_revision INTEGER NOT NULL DEFAULT 0,
        head_path TEXT,head_sha256 TEXT,mailbox_cursor INTEGER NOT NULL DEFAULT 0,last_activity_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,last_exit_reason TEXT);
      CREATE TABLE session_worker_mailbox(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,applied_generation INTEGER,applied_revision INTEGER);
      CREATE INDEX idx_session_worker_mailbox_pending ON session_worker_mailbox(session_id,id) WHERE applied_revision IS NULL;
      INSERT INTO session_worker_ownership(session_id,generation,state,worker_pid,updated_at) VALUES('old',3,'ready',999,1);
    `); db.close();
    const migrated = new SessionWorkerStore(legacyPath); migrated.open();
    const old = migrated.getOwnership('old');
    assert.equal(old.generation, 3); assert.equal(old.state, 'draining');
    assert.equal(old.incarnationId, 'legacy-unproven-3'); assert.equal(old.lastExitReason, 'schema-v0-unproven-fence'); migrated.close();

    const newerPath = path.join(root, 'newer.sqlite'); const newer = new DatabaseSync(newerPath); newer.exec('PRAGMA user_version=2'); newer.close();
    assert.throws(() => new SessionWorkerStore(newerPath).open(), error => assertRpcCode(error, 'SESSION_WORKER_SCHEMA_NEWER'));
  });
});
