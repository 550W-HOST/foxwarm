import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RpcError } from './rpc';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerStore, SessionWorkerStoreOperation } from './sessionWorkerStore';
import { normalizeSessionWorkerCompactCancelTransportError, SessionWorkerLifecycleError, SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import { buildSessionWorkerProjection } from './sessionWorkerPersistence';

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for condition.');
}

test('compact cancellation transport loss is a stable retryable unknown outcome', () => {
  for (const code of ['RPC_DEADLINE_EXCEEDED', 'RPC_CLOSED', 'RPC_SEND_FAILED']) {
    assert.throws(
      () => normalizeSessionWorkerCompactCancelTransportError(new RpcError(code, 'lost', true)),
      (error: any) => error?.code === 'SESSION_WORKER_COMPACTION_CANCEL_OUTCOME_UNKNOWN'
        && error?.retryable === true
        && error?.details?.transportCode === code
        && /may already have taken effect/i.test(error.message)
        && /state and history/i.test(error.message),
    );
  }
  const definite = new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'definite');
  assert.throws(() => normalizeSessionWorkerCompactCancelTransportError(definite), error => error === definite);
});

async function createFixture(idleMs: number, options: {
  shouldRestart?: (sessionId: string) => boolean;
  faultInjector?: (operation: SessionWorkerStoreOperation, sessionId: string) => void;
  readProcessIdentity?: (pid: number) => string | null;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-supervisor-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite'), { faultInjector: options.faultInjector }); store.open();
  const handbackCalls: Array<{ sessionId: string; generation: number; stateAtCall: string }> = [];
  const supervisor = new SessionWorkerSupervisor({ store, idleMs, restartBaseDelayMs: 20, restartMaxDelayMs: 50,
    shouldRestart: options.shouldRestart, readProcessIdentity: options.readProcessIdentity,
    handbackWorker: async identity => {
      handbackCalls.push({ sessionId: identity.sessionId, generation: identity.generation, stateAtCall: store.getOwnership(identity.sessionId).state });
    } });
  await supervisor.reconcileStartupOwnerships();
  return { root, store, supervisor, handbackCalls, async close() { await supervisor.shutdown(2_000).catch(() => {}); store.close(); await fs.remove(root); } };
}

test('supervisor durably activates one incarnation and confirms idle exit before replacement', async () => {
  const fixture = await createFixture(120);
  try {
    const [first, duplicate] = await Promise.all([fixture.supervisor.ensureWorker('idle-session'), fixture.supervisor.ensureWorker('idle-session')]);
    assert.equal(first.generation, 1); assert.equal(duplicate.pid, first.pid);
    const identity = await fixture.supervisor.callStatus('idle-session');
    assert.equal(identity.active, true); assert.equal(identity.incarnationId, first.incarnationId);
    const owned = fixture.store.getOwnership('idle-session');
    assert.equal(owned.state, 'ready'); assert.equal(owned.incarnationId, first.incarnationId); assert.ok(owned.activatedAt);
    await fixture.supervisor.projectionRegistry.apply({ sessionId: 'idle-session', generation: first.generation, incarnationId: first.incarnationId },
      buildSessionWorkerProjection({ id: 'idle-session', history: [], queue: [], meta: {},
        stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null } } as any));
    assert.equal(fixture.supervisor.projectionRegistry.get('idle-session')?.stale, false);
    await waitFor(() => fixture.supervisor.getStatus('idle-session') === undefined, 4_000);
    assert.equal(fixture.supervisor.projectionRegistry.get('idle-session')?.stale, true);
    assert.equal(fixture.store.getOwnership('idle-session').state, 'inactive');
    assert.deepEqual(fixture.handbackCalls, [{ sessionId: 'idle-session', generation: 1, stateAtCall: 'draining' }],
      'the handback step runs exactly once, while the fence is still draining');
    const replacement = await fixture.supervisor.ensureWorker('idle-session');
    assert.equal(replacement.generation, 2); assert.notEqual(replacement.incarnationId, first.incarnationId);
    assert.equal(fixture.supervisor.projectionRegistry.get('idle-session')?.generation, 2);
    assert.equal(fixture.supervisor.projectionRegistry.get('idle-session')?.stale, true);
    await fixture.supervisor.stopWorker('idle-session', 2_000);
  } finally { await fixture.close(); }
});

test('unexpected child restart begins only after old exit and durable fence release', async () => {
  const fixture = await createFixture(5_000, { shouldRestart: id => id === 'restart-session' });
  try {
    const first = await fixture.supervisor.ensureWorker('restart-session');
    process.kill(first.pid!, 'SIGKILL');
    await waitFor(() => fixture.supervisor.getStatus('restart-session')?.generation === 2, 5_000);
    const replacement = fixture.supervisor.getStatus('restart-session')!;
    assert.notEqual(replacement.pid, first.pid); assert.notEqual(replacement.incarnationId, first.incarnationId);
    await fixture.supervisor.stopWorker('restart-session', 2_000);
  } finally { await fixture.close(); }
});

test('parent crash reconciliation keeps generation fenced until exact activated incarnation exits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-crash-'));
  const dbPath = path.join(root, 'runtime.sqlite'); const markerPath = path.join(root, 'ready.json');
  let oldPid: number | undefined;
  const parent = fork(path.join(__dirname, 'sessionWorkerCrashParent.js'), [], {
    env: { ...process.env, FOXWARM_TEST_STORE_PATH: dbPath, FOXWARM_TEST_MARKER_PATH: markerPath }, silent: true,
  });
  try {
    await new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('exit', code => code === 77 ? resolve() : reject(new Error(`crash parent exited ${code}`))); });
    const old = await fs.readJson(markerPath) as { pid: number; generation: number; incarnationId: string };
    oldPid = old.pid;
    assert.equal(readSessionWorkerProcessIdentity(old.pid) !== null, true);
    const store = new SessionWorkerStore(dbPath); store.open();
    assert.equal(store.getOwnership('parent-crash-session').state, 'ready');
    assert.throws(() => store.beginGeneration('parent-crash-session', 'too-early'), (error: any) => error?.code === 'SESSION_WORKER_OWNED');
    assert.throws(() => store.acknowledgeMailboxPrefix({ sessionId: 'parent-crash-session', generation: 2, incarnationId: 'too-early',
      expectedCursor: 0, upToId: 1 }), (error: any) => error?.code === 'SESSION_WORKER_STALE_GENERATION');

    const supervisor = new SessionWorkerSupervisor({ store, idleMs: 5_000 });
    const recovery = supervisor.reconcileStartupOwnerships(800);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readSessionWorkerProcessIdentity(old.pid) !== null, true, 'old TERM-resistant incarnation should still be alive during the fence');
    assert.throws(() => store.beginGeneration('parent-crash-session', 'still-too-early'), (error: any) => error?.code === 'SESSION_WORKER_OWNED');
    await recovery;
    assert.equal(readSessionWorkerProcessIdentity(old.pid), null);
    const replacement = await supervisor.ensureWorker('parent-crash-session');
    assert.equal(replacement.generation, old.generation + 1);
    await supervisor.shutdown(2_000); store.close();
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL');
    if (oldPid && readSessionWorkerProcessIdentity(oldPid) !== null) {
      try { process.kill(oldPid, 'SIGKILL'); } catch {}
    }
    await fs.remove(root);
  }
});

test('shutdown kills every child despite DB transition failures and retains unsafe fences', async () => {
  let failuresEnabled = false;
  const fixture = await createFixture(5_000, {
    faultInjector(operation, sessionId) {
      if (!failuresEnabled) return;
      if (operation === 'exit' || (operation === 'drain' && sessionId === 'one')) throw new Error(`injected-${operation}-${sessionId}`);
    },
  });
  try {
    const one = await fixture.supervisor.ensureWorker('one');
    const two = await fixture.supervisor.ensureWorker('two');
    failuresEnabled = true;
    await assert.rejects(() => fixture.supervisor.shutdown(2_000), error => {
      assert.ok(error instanceof SessionWorkerLifecycleError); assert.ok(error.errors.length >= 2); return true;
    });
    await waitFor(() => readSessionWorkerProcessIdentity(one.pid!) === null && readSessionWorkerProcessIdentity(two.pid!) === null);
    assert.notEqual(fixture.store.getOwnership('one').state, 'inactive');
    assert.notEqual(fixture.store.getOwnership('two').state, 'inactive');
  } finally {
    failuresEnabled = false;
    fixture.store.close(); await fs.remove(fixture.root);
  }
});

test('supervisor refuses spawn before explicit startup reconciliation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-reconcile-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
  const supervisor = new SessionWorkerSupervisor({ store, idleMs: 1_000 });
  try {
    await assert.rejects(() => supervisor.ensureWorker('s'), error => {
      assert.ok(error instanceof RpcError); assert.equal(error.code, 'SESSION_WORKER_RECOVERY_REQUIRED'); return true;
    });
  } finally { store.close(); await fs.remove(root); }
});

test('startup reconciliation distinguishes PID reuse without signalling the reused process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-pid-reuse-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
  store.beginGeneration('reused', 'old-incarnation');
  store.registerCandidate('reused', 1, 'old-incarnation', process.pid, 'different-boot:1');
  store.activateCandidate('reused', 1, 'old-incarnation', process.pid, 'different-boot:1');
  const supervisor = new SessionWorkerSupervisor({ store, idleMs: 1_000 });
  try {
    assert.equal(await supervisor.reconcileStartupOwnerships(), 1);
    assert.equal(readSessionWorkerProcessIdentity(process.pid) !== null, true);
    const ownership = store.getOwnership('reused');
    assert.equal(ownership.state, 'inactive');
    assert.equal(ownership.lastExitReason, 'startup-pid-reused');
  } finally { store.close(); await fs.remove(root); }
});

test('post-fork identity throw/null both terminate the provisional child before clearing its candidate', async () => {
  for (const mode of ['throw', 'null'] as const) {
    let forkedPid: number | undefined;
    let clearObservedAfterExit = false;
    const fixture = await createFixture(5_000, {
      faultInjector(operation) {
        if (operation === 'clear') {
          assert.ok(forkedPid);
          assert.equal(readSessionWorkerProcessIdentity(forkedPid!) === null, true);
          clearObservedAfterExit = true;
        }
      },
      readProcessIdentity(pid) {
        forkedPid = pid;
        if (mode === 'throw') throw new RpcError('SESSION_WORKER_PROCESS_IDENTITY_UNAVAILABLE', 'injected identity read failure', true);
        return null;
      },
    });
    try {
      await assert.rejects(() => fixture.supervisor.ensureWorker(`identity-${mode}`));
      assert.ok(forkedPid);
      await waitFor(() => readSessionWorkerProcessIdentity(forkedPid!) === null);
      const ownership = fixture.store.getOwnership(`identity-${mode}`);
      assert.equal(ownership.state, 'inactive');
      assert.equal(ownership.incarnationId, undefined);
      assert.match(ownership.lastExitReason || '', /post-fork-startup-failure/);
      assert.equal(clearObservedAfterExit, true);
    } finally { await fixture.close(); }
  }
});
