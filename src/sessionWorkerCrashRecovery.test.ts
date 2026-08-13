import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { getSessionHistoryFilePath, serializeSessionHistoryPayload } from './session/metadataStore';
import { resumeSessionWorkerPendingIntents, SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], persistentMemorySnapshot: 'crash prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeFixture(root: string, hangSessionId: string) {
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_HANG_TURN: '1', FOXWARM_TEST_HANG_SESSION: hangSessionId },
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  return { store, sourceContexts, supervisor, ingress };
}

async function crashMidTurn(root: string, fixture: ReturnType<typeof makeFixture>, sessionId: string): Promise<void> {
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fixture.supervisor.reconcileStartupOwnerships();
  // Generation 1's first turn hangs forever, simulating a mid-turn incarnation.
  void fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'user hi' }] }).catch(() => {});
  await waitFor(async () => JSON.parse(await fs.readFile(statePath, 'utf8')).busy === true);
  const status = fixture.supervisor.getStatus(sessionId);
  assert.ok(status?.ready && status.pid, 'generation 1 worker is live mid-turn');
  process.kill(status.pid!, 'SIGKILL');
  await waitFor(() => fixture.store.findOwnership(sessionId)?.state === 'inactive');
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).busy, true, 'the crash leaves a stale busy flag');
}

test('stale busy from an unconfirmed exit recovers on the next durable ingress', async () => {
  const sessionId = `mc-crash-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-crash-'));
  const fixture = makeFixture(root, sessionId);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    await crashMidTurn(root, fixture, sessionId);
    // The next durable ingress spawns generation 2; load-time recovery clears the
    // stale busy flag and enqueues the restart event inside the new worker's ownership.
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'user again' }] });
    const recovered = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(recovered.busy, false);
    const text = JSON.stringify(recovered.history);
    assert.ok(text.includes('Session worker restarted after an unconfirmed exit'), 'the restart system event is consumed by the canonical runner');
    assert.ok(text.includes('deterministic child answer'), 'the recovered session processes the new input');
    assert.ok(fixture.store.getOwnership(sessionId).mailboxCursor > 0, 'mailbox intents are acknowledged');
  } finally {
    await fixture.supervisor.shutdown(5_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('startup resume eagerly recovers busy sessions without pending intents', async () => {
  const sessionId = `mc-resume-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-resume-'));
  const fixture = makeFixture(root, sessionId);
  const rootStatePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  try {
    // The authority lives in the real Main state root (mirrored into the worker
    // tree) so the eager scan can read it through the Main-owned path.
    await sessionManager.getSession(sessionId);
    await fs.ensureDir(path.dirname(rootStatePath));
    await fs.copy(getSessionHistoryFilePath(sessionId), rootStatePath);
    await crashMidTurn(root, fixture, sessionId);
    // Simulate the drain-window acknowledgement the crash raced past (the exact
    // worker applied the intents and saved before exit): no pending mailbox
    // intents remain, so the pending-intents resume path alone is a no-op.
    const ownership = fixture.store.getOwnership(sessionId);
    const db = (fixture.store as any).getDb();
    db.prepare('UPDATE session_worker_mailbox SET applied_at=?, applied_generation=?, applied_incarnation_id=? WHERE session_id=? AND applied_at IS NULL')
      .run(Date.now(), ownership.generation, 'drained-incarnation', sessionId);
    db.prepare("UPDATE session_worker_ownership SET mailbox_cursor=(SELECT COALESCE(MAX(id),0) FROM session_worker_mailbox WHERE session_id=?) WHERE session_id=?")
      .run(sessionId, sessionId);
    assert.deepEqual(fixture.store.listSessionsWithPendingIntents(), []);
    // Bridge the split test state root: the Main-side scan reads the crashed authority.
    await fs.copy(rootStatePath, getSessionHistoryFilePath(sessionId));

    await resumeSessionWorkerPendingIntents(fixture.store, fixture.supervisor);
    assert.ok(!fixture.supervisor.getStatus(sessionId), 'no pending intents and no busy candidates spawns nothing');
    await resumeSessionWorkerPendingIntents(fixture.store, fixture.supervisor, () => [sessionId]);
    await waitFor(async () => JSON.parse(await fs.readFile(rootStatePath, 'utf8')).busy === false);
    const recovered = JSON.parse(await fs.readFile(rootStatePath, 'utf8'));
    assert.ok(JSON.stringify(recovered.history).includes('Session worker restarted after an unconfirmed exit'),
      'the eagerly resumed worker recovers the stale busy state inside its own ownership');
  } finally {
    await fixture.supervisor.shutdown(5_000).catch(() => {});
    fixture.store.close();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
  }
});

test('stale stopping residue from a previous incarnation never silently stops the next turn', async () => {
  const sessionId = `mc-stopping-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stopping-'));
  // No hang hook: the worker's turn runs to completion normally.
  const fixture = makeFixture(root, '__none__');
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  // Simulates the residue a stopped turn can leave: the interrupt's detached
  // persist lands stopping=true after the stopped turn's final writes, while
  // busy is already false. A new incarnation must not inherit the stop signal.
  await fs.outputJson(statePath, serializeSessionHistoryPayload({ ...baseSession(sessionId), stopping: true }));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'final verification ok' }] });
    const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(authority.stopping, false, 'the stale stopping flag is cleared at load');
    const text = JSON.stringify(authority.history);
    assert.ok(text.includes('deterministic child answer'), 'the first turn of the new incarnation runs normally');
    assert.ok(!text.includes('Session worker restarted after an unconfirmed exit'), 'a clean stale-stopping recovery enqueues no restart event');
  } finally {
    await fixture.supervisor.shutdown(5_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});
