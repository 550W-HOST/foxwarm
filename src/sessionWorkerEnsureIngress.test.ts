import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerLifecycleError, SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], persistentMemorySnapshot: 'ensure ingress prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

async function createFixture(sessionId: string, options: { resolveAlias?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-ensure-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(
    store, supervisor, sourceContexts,
    options.resolveAlias ? (id => (id === 'alias' ? sessionId : id)) : (id => id),
    id => id === sessionId,
  );
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  return {
    root, store, sourceContexts, supervisor, ingress, statePath,
    async close() {
      await supervisor.shutdown(5_000).catch(() => {});
      store.close(); await fs.remove(root);
    },
  };
}

test('ensuring submit spawns, durably activates, and runs an inactive session worker', async () => {
  const sessionId = 'worker-ensure-spawn';
  const fixture = await createFixture(sessionId, { resolveAlias: true });
  const originals = {
    getExistingSession: sessionManager.getExistingSession, enqueueSessionItem: sessionManager.enqueueSessionItem,
    saveSession: sessionManager.saveSession,
  };
  let mainSemanticCalls = 0;
  (sessionManager as any).getExistingSession = async () => { mainSemanticCalls += 1; throw new Error('Main hydration forbidden'); };
  (sessionManager as any).enqueueSessionItem = async () => { mainSemanticCalls += 1; throw new Error('Main enqueue forbidden'); };
  (sessionManager as any).saveSession = async () => { mainSemanticCalls += 1; throw new Error('Main save forbidden'); };
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await assert.rejects(
      () => fixture.ingress.submitEnsuringWorker(sessionId, { type: 'compact-commit', parts: [{ text: 'compact' }] } as any),
      (error: any) => error?.code === 'SESSION_WORKER_QUEUE_UNSUPPORTED',
    );
    await assert.rejects(
      () => fixture.ingress.submitEnsuringWorker('alias', { type: 'user', parts: [{ text: 'alias rejected' }] }),
      (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID_SESSION',
    );
    assert.equal(fixture.store.findOwnership(sessionId), undefined, 'rejected submissions must not spawn or create a fence');
    assert.equal(fixture.supervisor.listStatuses().length, 0);

    const first = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'spawn and run' }] });
    assert.equal(first.generation, 1); assert.equal(first.busy, false); assert.equal(first.messageCount, 2);
    const ownership = fixture.store.getOwnership(sessionId);
    assert.equal(ownership.state, 'ready'); assert.ok(ownership.workerPid); assert.ok(ownership.processIdentity);
    assert.ok(ownership.activatedAt); assert.equal(ownership.incarnationId, fixture.supervisor.getStatus(sessionId)?.incarnationId);
    assert.equal(readSessionWorkerProcessIdentity(ownership.workerPid!), ownership.processIdentity);
    assert.equal(ownership.mailboxCursor, first.mailboxIntentId);
    const status = fixture.supervisor.getStatus(sessionId)!;
    assert.equal(status.ready, true); assert.equal(status.pid, ownership.workerPid);
    const authority = await fs.readJson(fixture.statePath);
    assert.equal(authority.lastAppliedMailboxId, first.mailboxIntentId); assert.equal(authority.history.length, 2);
    assert.equal(fixture.supervisor.projectionRegistry.get(sessionId)?.projection?.messageCount, 2);
    assert.equal(mainSemanticCalls, 0);

    const second = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'reuse ready worker' }] });
    assert.equal(second.generation, 1, 'a ready owner must be reused, not respawned');
    assert.equal(fixture.supervisor.getStatus(sessionId)?.pid, status.pid);
    assert.equal(fixture.supervisor.listStatuses().length, 1);
    assert.equal(fixture.store.countMailboxIntents(), 2);
    assert.equal((await fs.readJson(fixture.statePath)).history.length, 4);
    assert.equal(mainSemanticCalls, 0);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExistingSession;
    (sessionManager as any).enqueueSessionItem = originals.enqueueSessionItem;
    (sessionManager as any).saveSession = originals.saveSession;
    await fixture.close();
  }
});

test('ensureWorkerOwner loads authoritative state and publishes a committed projection without mailbox work', async () => {
  const sessionId = 'worker-ensure-owner-projection';
  const fixture = await createFixture(sessionId);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    assert.equal(fixture.supervisor.projectionRegistry.get(sessionId), undefined);
    const owner = await fixture.ingress.ensureWorkerOwner(sessionId);
    assert.equal(owner.generation, 1);
    assert.equal(fixture.store.countMailboxIntents(), 0);
    const projection = fixture.supervisor.projectionRegistry.get(sessionId)?.projection;
    assert.equal(projection?.messageCount, 0);
    assert.equal(projection?.busy, false);
    assert.equal(fixture.store.getOwnership(sessionId).state, 'ready');
  } finally { await fixture.close(); }
});

test('concurrent ensuring submits share one spawn and apply both mailbox intents once', async () => {
  const sessionId = 'worker-ensure-concurrent';
  const fixture = await createFixture(sessionId);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const [a, b] = await Promise.all([
      fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'concurrent ensure a' }] }),
      fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'concurrent ensure b' }] }),
    ]);
    assert.equal(a.generation, 1); assert.equal(b.generation, 1);
    assert.notEqual(a.mailboxIntentId, b.mailboxIntentId);
    assert.equal(fixture.supervisor.listStatuses().length, 1);
    assert.equal(fixture.store.countMailboxIntents(), 2);
    assert.equal(fixture.store.listPendingIntents(sessionId).length, 0);
    const authority = await fs.readJson(fixture.statePath);
    const userMessages = authority.history.filter((message: any) => message.role === 'user');
    assert.equal(userMessages.length, 2, 'each mailbox intent is appended as its own canonical message');
    assert.ok(authority.history.some((message: any) => message.role === 'model'));
    assert.equal(authority.lastAppliedMailboxId, Math.max(a.mailboxIntentId, b.mailboxIntentId));
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, authority.lastAppliedMailboxId);
  } finally { await fixture.close(); }
});

test('a crashed generation stays fenced until its exact exit is durably observed, then is replaced', async () => {
  const sessionId = 'worker-ensure-fence';
  const fixture = await createFixture(sessionId);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'first generation' }] });
    const firstStatus = fixture.supervisor.getStatus(sessionId)!;
    const firstPid = firstStatus.pid!;

    // Kill the real child. The durable fence still belongs to generation 1 in this same
    // synchronous window: the exit event has not been observed or recorded yet.
    process.kill(firstPid, 'SIGKILL');
    assert.equal(fixture.store.getOwnership(sessionId).state, 'ready', 'an unobserved exit must not release the durable fence');
    assert.throws(() => fixture.store.beginGeneration(sessionId, 'stale-attempt'), (error: any) => error?.code === 'SESSION_WORKER_OWNED');

    // Replacement is allowed only after the exact process exit is observed and recorded.
    await waitFor(() => fixture.store.getOwnership(sessionId).state === 'inactive');
    assert.match(fixture.store.getOwnership(sessionId).lastExitReason || '', /^unexpected:/);
    assert.equal(readSessionWorkerProcessIdentity(firstPid), null);
    const second = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'replacement generation' }] });
    assert.equal(second.generation, 2); assert.equal(second.busy, false); assert.equal(second.messageCount, 4);
    const replacementStatus = fixture.supervisor.getStatus(sessionId)!;
    assert.equal(replacementStatus.ready, true);
    assert.notEqual(replacementStatus.pid, firstPid);
    assert.notEqual(replacementStatus.incarnationId, firstStatus.incarnationId);
    assert.equal(fixture.store.countMailboxIntents(), 2);
    assert.equal((await fs.readJson(fixture.statePath)).lastAppliedMailboxId, second.mailboxIntentId);
  } finally { await fixture.close(); }
});

test('an unprovable durable identity retains its fence and fails ensuring submit closed', async () => {
  const sessionId = 'worker-ensure-unproven';
  const fixture = await createFixture(sessionId);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(sleeper.pid);
    const identity = readSessionWorkerProcessIdentity(sleeper.pid)!;
    assert.ok(identity);
    fixture.store.beginGeneration(sessionId, 'incarnation-unproven');
    fixture.store.registerCandidate(sessionId, 1, 'incarnation-unproven', sleeper.pid, identity);
    fixture.store.activateCandidate(sessionId, 1, 'incarnation-unproven', sleeper.pid, identity);
    fixture.store.markDraining(sessionId, 1, 'incarnation-unproven');
    // Simulate a legacy unproven fence: identity fields were never recorded durably.
    const db = new DatabaseSync(fixture.store.filePath);
    try {
      db.prepare('UPDATE session_worker_ownership SET worker_pid=NULL,process_identity=NULL,activated_at=NULL WHERE session_id=?').run(sessionId);
    } finally { db.close(); }

    await assert.rejects(() => fixture.supervisor.reconcileStartupOwnerships(800), (error: any) => {
      assert.ok(error instanceof SessionWorkerLifecycleError);
      assert.ok(error.errors.some((failure: any) => failure?.code === 'SESSION_WORKER_RECOVERY_IDENTITY_MISSING'));
      return true;
    });
    assert.equal(fixture.store.getOwnership(sessionId).state, 'draining', 'the unprovable fence must be retained');
    assert.equal(readSessionWorkerProcessIdentity(sleeper.pid) !== null, true, 'an unproven process must never be signalled');
    await assert.rejects(
      () => fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'must fail closed' }] }),
      (error: any) => error?.code === 'SESSION_WORKER_RECOVERY_REQUIRED',
    );
    assert.equal(fixture.supervisor.listStatuses().length, 0, 'fail-closed must not spawn a replacement');
    assert.equal(fixture.store.countMailboxIntents(), 0);
  } finally {
    if (sleeper.exitCode === null) sleeper.kill('SIGKILL');
    await fixture.close();
  }
});
