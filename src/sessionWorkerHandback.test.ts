import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { performSessionWorkerHandback } from './sessionWorkerHandback';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerLifecycleError, SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'handback prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

async function createFixture(sessionId: string, options: {
  idleMs?: number;
  workerEnv?: Record<string, string>;
  handbackError?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-handback-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const catalog = new Map<string, Session>();
  const statesAtCatalogSave: string[] = [];
  let catalogSaves = 0;
  const handbackWorker = options.handbackError
    ? async () => { throw new Error('injected handback failure'); }
    : (identity: { sessionId: string; generation: number; incarnationId: string }) => performSessionWorkerHandback({
      store,
      getCatalogSession: id => catalog.get(id),
      upsertCatalogSession: session => catalog.set(session.id, session),
      saveCatalog: async () => { catalogSaves += 1; statesAtCatalogSave.push(store.getOwnership(identity.sessionId).state); },
      stateFilePath: id => path.join(root, 'state', 'sessions', `${id}.json`),
    }, identity);
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: options.idleMs ?? 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...options.workerEnv }, resolveExactFinalSourceContext: sourceContexts.resolve,
    handbackWorker,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  return {
    root, store, sourceContexts, supervisor, ingress, statePath, catalog,
    get catalogSaves() { return catalogSaves; },
    statesAtCatalogSave,
    async close() {
      await supervisor.shutdown(5_000).catch(() => {});
      store.close(); await fs.remove(root);
    },
  };
}

test('idle release hands back authority before fence release and refreshes the Main catalog stub', async () => {
  const sessionId = 'worker-handback-idle';
  const fixture = await createFixture(sessionId, { idleMs: 200 });
  fixture.catalog.set(sessionId, {
    ...baseSession(sessionId), pinned: true, displayName: 'old-name',
    meta: { lastMessageTime: 1, lastChannel: { channelType: 'webui', conversationId: 'c1' } as any }, model: 'stale-model',
  });
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const first = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'hello handback' }] });
    assert.equal(first.generation, 1); assert.equal(first.messageCount, 2);
    const firstOwnership = fixture.store.getOwnership(sessionId);

    const status = await fixture.supervisor.idleStatusActivated(
      sessionId, { generation: firstOwnership.generation, incarnationId: firstOwnership.incarnationId! },
    );
    assert.deepEqual(status, { busy: false, queueLength: 0, runningExecCount: 0 });
    await assert.rejects(
      () => fixture.supervisor.idleStatusActivated(sessionId, { generation: 99, incarnationId: 'stale' }),
      (error: any) => error?.code === 'SESSION_WORKER_INGRESS_UNAVAILABLE',
    );

    await waitFor(() => fixture.store.getOwnership(sessionId).state === 'inactive');
    assert.ok(fixture.catalogSaves >= 1, 'handback must refresh the Main catalog');
    assert.ok(fixture.statesAtCatalogSave.every(state => state === 'draining'),
      'catalog refresh must happen while the fence is still held (draining), never after release');

    const stub = fixture.catalog.get(sessionId)!;
    const authority = await fs.readJson(fixture.statePath);
    assert.ok(stub.meta!.lastMessageTime! > 1, 'stub meta mirrors the authority');
    assert.deepEqual((stub.meta as any)!.lastChannel, { channelType: 'webui', conversationId: 'c1' },
      'catalog-only meta.lastChannel survives the authority mirror');
    assert.equal(stub.pinned, true, 'Main-owned presentation fields are never derived from the authority');
    assert.equal(stub.displayName, 'old-name', 'an authority payload without displayName never erases the Main-owned name');
    assert.equal(stub.busy, false); assert.deepEqual(stub.queue, []);
    assert.equal(stub.history.length, 0, 'handback must not hydrate authority history into the Main stub');
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, authority.lastAppliedMailboxId,
      'the mailbox cursor is reconciled against the authority during handback');

    const second = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'replacement after handback' }] });
    assert.equal(second.generation, 2, 'replacement spawns only after handback released the fence');
  } finally { await fixture.close(); }
});

test('a failing handback retains the fence fail-closed on both stop and crash paths', async () => {
  const stopSession = 'worker-handback-fail-stop';
  const crashSession = 'worker-handback-fail-crash';
  const stopFixture = await createFixture(stopSession, { idleMs: 150, handbackError: true });
  const crashFixture = await createFixture(crashSession, { handbackError: true });
  try {
    // Intentional idle release path: drain completes, exit is observed, handback fails.
    await stopFixture.supervisor.reconcileStartupOwnerships();
    await stopFixture.ingress.submitEnsuringWorker(stopSession, { type: 'user', parts: [{ text: 'release me' }] });
    await waitFor(() => stopFixture.store.getOwnership(stopSession).state === 'draining');
    await waitFor(() => stopFixture.supervisor.getStatus(stopSession) === undefined);
    const stopOwnership = stopFixture.store.getOwnership(stopSession);
    assert.equal(stopOwnership.state, 'draining', 'a failed handback must retain the durable fence');
    assert.equal(readSessionWorkerProcessIdentity(stopOwnership.workerPid!), null, 'the old process is really gone');
    await assert.rejects(
      () => stopFixture.ingress.submitEnsuringWorker(stopSession, { type: 'user', parts: [{ text: 'must fail closed' }] }),
      (error: any) => error?.code === 'SESSION_WORKER_RECOVERY_REQUIRED' || error instanceof SessionWorkerLifecycleError,
    );
    assert.equal(stopFixture.supervisor.listStatuses().length, 0, 'fail-closed must not spawn a replacement');

    // Crash path: unexpected exit also routes through the handback boundary.
    await crashFixture.supervisor.reconcileStartupOwnerships();
    await crashFixture.ingress.submitEnsuringWorker(crashSession, { type: 'user', parts: [{ text: 'crash me' }] });
    const crashPid = crashFixture.supervisor.getStatus(crashSession)!.pid!;
    process.kill(crashPid, 'SIGKILL');
    await waitFor(() => crashFixture.store.getOwnership(crashSession).state === 'draining');
    await waitFor(() => readSessionWorkerProcessIdentity(crashPid) === null);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(crashFixture.store.getOwnership(crashSession).state, 'draining', 'the failed crash handback keeps the fence');
    assert.equal(crashFixture.supervisor.getStatus(crashSession), undefined, 'no replacement spawns after a failed handback');
  } finally { await stopFixture.close(); await crashFixture.close(); }
});

test('an exit inside the activation window releases the candidate fence without handback', async () => {
  const sessionId = 'worker-handback-activation-exit';
  const fixture = await createFixture(sessionId, { workerEnv: { FOXWARM_TEST_CRASH_GENERATION: '1' } });
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await assert.rejects(
      () => fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'crash inside activation' }] }),
      (error: any) => !(error instanceof SessionWorkerLifecycleError),
    );
    await waitFor(() => {
      const ownership = fixture.store.findOwnership(sessionId);
      return !ownership || ownership.state === 'inactive';
    });
    assert.equal(fixture.catalogSaves, 0, 'a candidate never touched the authority and needs no handback');
    const retry = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'retry after activation crash' }] });
    assert.ok(retry.busy === false, 'the session is retryable, not wedged');
  } finally { await fixture.close(); }
});

test('active background exec blocks idle release until its durable completion', async () => {
  const sessionId = 'worker-handback-exec';
  const fixture = await createFixture(sessionId, { idleMs: 250, workerEnv: { FOXWARM_TEST_BACKGROUND_EXEC: '1' } });
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'start the background exec' }] });
    assert.ok(fixture.supervisor.getStatus(sessionId)?.ready, 'worker is ready with a running background exec');

    // Several idle cycles pass while the exec runs; the worker must not be released.
    await new Promise(resolve => setTimeout(resolve, 1_200));
    assert.equal(fixture.store.getOwnership(sessionId).state, 'ready', 'a worker with a running background exec is not released');
    assert.ok(fixture.supervisor.getStatus(sessionId)?.ready);

    // After the exec finishes and its completion is durably committed, idle release proceeds.
    await waitFor(() => fixture.store.getOwnership(sessionId).state === 'inactive');
    const authority = await fs.readJson(fixture.statePath);
    assert.ok(authority.history.length >= 4, 'the exec completion notification was durably committed before release');
    assert.ok(fixture.catalogSaves >= 1, 'handback refreshed the catalog after the exec completed');
    const stub = fixture.catalog.get(sessionId)!;
    assert.ok(stub.meta!.lastMessageTime! > 0);
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, authority.lastAppliedMailboxId);
  } finally { await fixture.close(); }
});
