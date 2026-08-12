import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { getSessionHistoryFilePath, serializeSessionHistoryPayload } from './session/metadataStore';
import { performSessionWorkerHandback } from './sessionWorkerHandback';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerLifecycleError, SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';
import { SessionCatalogStore, sessionCatalogStore } from './session/catalogStore';

test.before(async () => {
  if (!sessionCatalogStore.exists()) sessionCatalogStore.initializeEmpty();
  else sessionCatalogStore.open();
});

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

function processDescendants(rootPid: number): number[] {
  if (process.platform !== 'linux') return [];
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const parentPid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
        const pid = Number(entry);
        if (descendants.has(parentPid) && !descendants.has(pid)) {
          descendants.add(pid); changed = true;
        }
      } catch {}
    }
  }
  descendants.delete(rootPid);
  return [...descendants];
}

function isMontyProcess(pid: number): boolean {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ');
    return comm === 'monty' || /(?:^|\/)monty(?:\s|$)/.test(cmdline);
  } catch { return false; }
}

async function createFixture(sessionId: string, options: {
  idleMs?: number;
  workerEnv?: Record<string, string>;
  handbackError?: boolean;
  persistCatalog?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-handback-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const persistentCatalog = options.persistCatalog ? new SessionCatalogStore(path.join(root, 'catalog.sqlite')) : undefined;
  persistentCatalog?.initializeEmpty();
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
      saveCatalog: async id => {
        catalogSaves += 1; statesAtCatalogSave.push(store.getOwnership(identity.sessionId).state);
        if (persistentCatalog) {
          const session = catalog.get(id);
          if (!session) throw new Error(`missing catalog stub ${id}`);
          persistentCatalog.upsertMany([session]);
        }
      },
      stateFilePath: id => path.join(root, 'state', 'sessions', `${id}.json`),
    }, identity);
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: options.idleMs ?? 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...options.workerEnv }, resolveExactFinalSourceContext: sourceContexts.resolve,
    handbackWorker,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  return {
    root, store, sourceContexts, supervisor, ingress, statePath, catalog, persistentCatalog,
    get catalogSaves() { return catalogSaves; },
    statesAtCatalogSave,
    async close() {
      await supervisor.shutdown(5_000).catch(() => {});
      store.close(); persistentCatalog?.close(); await fs.remove(root);
    },
  };
}

test('idle release hands back authority before fence release and refreshes the Main catalog stub', async () => {
  const sessionId = 'worker-handback-idle';
  const fixture = await createFixture(sessionId, { idleMs: 200 });
  const initialAuthority = await fs.readJson(fixture.statePath);
  initialAuthority.verbose = true;
  initialAuthority.effort = 'none';
  initialAuthority.childEffortDefault = 'max';
  await fs.writeJson(fixture.statePath, initialAuthority);
  fixture.catalog.set(sessionId, {
    ...baseSession(sessionId), pinned: true, displayName: 'old-name', verbose: false,
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
    assert.equal(stub.verbose, true, 'Worker-owned settings are refreshed from authority before fence release');
    assert.equal(stub.effort, 'none');
    assert.equal(stub.childEffortDefault, 'max');
    assert.equal(stub.busy, false); assert.deepEqual(stub.queue, []);
    assert.equal(stub.history.length, 0, 'handback must not hydrate authority history into the Main stub');
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, authority.lastAppliedMailboxId,
      'the mailbox cursor is reconciled against the authority during handback');

    const second = await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'replacement after handback' }] });
    assert.equal(second.generation, 2, 'replacement spawns only after handback released the fence');
  } finally { await fixture.close(); }
});

test('no-write Worker load and idle handback preserve catalog-owned agent in memory and SQLite', async () => {
  const sessionId = `worker-handback-agent-${Date.now()}`;
  const fixture = await createFixture(sessionId, { idleMs: 200, persistCatalog: true });
  const stub = { ...baseSession(sessionId), agent: 'catalog-agent', model: 'stale-model' } as Session;
  fixture.catalog.set(sessionId, stub);
  fixture.persistentCatalog!.upsertMany([stub]);
  const authority = await fs.readJson(fixture.statePath);
  authority.agent = 'authority-agent'; authority.model = 'authority-model';
  authority.stats = { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null };
  authority.meta = { lastMessageTime: 123, messageCount: 4 };
  await fs.writeJson(fixture.statePath, authority);
  const authorityBefore = await fs.readFile(fixture.statePath);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.ensureWorkerOwner(sessionId);
    await waitFor(() => fixture.store.getOwnership(sessionId).state === 'inactive');
    const refreshed = fixture.catalog.get(sessionId)!;
    assert.equal(refreshed.agent, 'catalog-agent');
    assert.equal(refreshed.model, 'authority-model');
    assert.equal(refreshed.stats.totalInputTokens, 2);
    assert.equal(refreshed.meta.lastMessageTime, 123);
    const persisted = fixture.persistentCatalog!.get(sessionId)!;
    assert.equal(persisted.agent, 'catalog-agent');
    assert.equal(persisted.model, 'authority-model');
    assert.equal(persisted.stats.totalInputTokens, 2);
    assert.deepEqual(await fs.readFile(fixture.statePath), authorityBefore, 'load-to-idle handback performs no semantic authority write');
  } finally { await fixture.close(); }
});

test('loaded idle release canonicalizes a missing v1 mailbox cursor before releasing ownership', async () => {
  const sessionId = `worker-handback-legacy-loaded-${Date.now()}`;
  const fixture = await createFixture(sessionId, { idleMs: 150 });
  const authority = await fs.readJson(fixture.statePath);
  delete authority.lastAppliedMailboxId;
  await fs.writeJson(fixture.statePath, authority);
  fixture.catalog.set(sessionId, baseSession(sessionId));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const owner = await fixture.ingress.ensureWorkerOwner(sessionId);
    const pid = fixture.supervisor.getStatus(sessionId)?.pid;
    assert.ok(pid); assert.equal(owner.generation, 1);
    await waitFor(() => fixture.store.getOwnership(sessionId).state === 'inactive');
    assert.equal(readSessionWorkerProcessIdentity(pid!), null);
    assert.equal((await fs.readJson(fixture.statePath)).lastAppliedMailboxId, 0);
  } finally { await fixture.close(); }
});

test('immediate stop before runtime load canonicalizes a missing v1 cursor during handback', async () => {
  const sessionId = `worker-handback-legacy-unloaded-${Date.now()}`;
  const fixture = await createFixture(sessionId);
  const authority = await fs.readJson(fixture.statePath);
  delete authority.lastAppliedMailboxId;
  await fs.writeJson(fixture.statePath, authority);
  fixture.catalog.set(sessionId, baseSession(sessionId));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const status = await fixture.supervisor.ensureWorker(sessionId);
    assert.ok(status.pid);
    await fixture.supervisor.stopWorker(sessionId, 10_000);
    assert.equal(fixture.store.getOwnership(sessionId).state, 'inactive');
    assert.equal(readSessionWorkerProcessIdentity(status.pid!), null);
    assert.equal((await fs.readJson(fixture.statePath)).lastAppliedMailboxId, 0);
  } finally { await fixture.close(); }
});

test('DB-ahead missing-cursor handback retains the draining fence without rewriting authority', async () => {
  const sessionId = `worker-handback-legacy-ahead-${Date.now()}`;
  const fixture = await createFixture(sessionId);
  const authority = await fs.readJson(fixture.statePath);
  delete authority.lastAppliedMailboxId;
  await fs.writeJson(fixture.statePath, authority);
  const before = await fs.readFile(fixture.statePath);
  fixture.catalog.set(sessionId, baseSession(sessionId));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const status = await fixture.supervisor.ensureWorker(sessionId);
    const intent = fixture.store.enqueueIntent(sessionId, 'already-acked', 'enqueue', { text: 'already acked' });
    fixture.store.acknowledgeMailboxPrefix({ sessionId, generation: status.generation,
      incarnationId: status.incarnationId, expectedCursor: 0, upToId: intent.id });
    await assert.rejects(() => fixture.supervisor.stopWorker(sessionId, 10_000), SessionWorkerLifecycleError);
    assert.equal(fixture.store.getOwnership(sessionId).state, 'draining');
    assert.equal(readSessionWorkerProcessIdentity(status.pid!), null);
    assert.deepEqual(await fs.readFile(fixture.statePath), before, 'DB-ahead must not rewrite the authority');
  } finally { await fixture.close(); }
});

test('graceful Worker drain closes and reaps its real native ToolScript pool before ownership release', {
  skip: process.platform !== 'linux' ? 'native Monty process lifecycle is Linux-specific' : false,
}, async () => {
  const sessionId = `worker-handback-toolscript-${Date.now()}`;
  const fixture = await createFixture(sessionId, {
    workerEnv: { FOXWARM_TEST_NATIVE_TOOLSCRIPT: '1' },
  });
  fixture.catalog.set(sessionId, baseSession(sessionId));
  let montyPid: number | undefined;
  let montyPresentAtFenceRelease: boolean | undefined;
  const originalMarkExitObserved = fixture.store.markExitObserved.bind(fixture.store);
  (fixture.store as any).markExitObserved = (...args: any[]) => {
    montyPresentAtFenceRelease = montyPid === undefined ? undefined : fs.pathExistsSync(`/proc/${montyPid}`);
    return originalMarkExitObserved(args[0], args[1], args[2], args[3]);
  };
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'run native ToolScript' }] });
    const authority = await fs.readJson(fixture.statePath);
    assert.ok(authority.history.some((message: any) => message.parts?.some((part: any) => part.functionCall?.name === 'run_script')));
    assert.ok(authority.history.some((message: any) => message.parts?.some((part: any) => part.functionResponse?.name === 'run_script')));
    const workerPid = fixture.supervisor.getStatus(sessionId)?.pid;
    assert.ok(workerPid);
    await waitFor(() => processDescendants(workerPid!).some(isMontyProcess));
    montyPid = processDescendants(workerPid!).find(isMontyProcess);
    assert.ok(montyPid, 'the real native ToolScript pool owns a Monty subprocess before drain');

    await fixture.supervisor.stopWorker(sessionId, 10_000);
    assert.equal(montyPresentAtFenceRelease, false,
      'the Monty child must be gone before markExitObserved releases Worker ownership');
    assert.equal(fs.pathExistsSync(`/proc/${montyPid}`), false, 'no live or zombie Monty PID survives graceful drain');
    assert.equal(fixture.store.getOwnership(sessionId).state, 'inactive');
    const runFiles = (await fs.readdir(path.join(fixture.root, 'state', 'toolscript-runs'))).filter(name => name.endsWith('.json'));
    assert.equal(runFiles.length, 1, 'runtime shutdown preserves the completed ToolScript run record');
  } finally {
    (fixture.store as any).markExitObserved = originalMarkExitObserved;
    await fixture.close();
  }
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

test('handback clears hydrated stub state so later reads rehydrate the fresh authority', async () => {
  const sessionId = `mc-stale-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stale-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  const realStatePath = getSessionHistoryFilePath(sessionId);
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 150, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
    handbackWorker: identity => performSessionWorkerHandback({
      store,
      getCatalogSession: id => sessionManager.getAllSessions().get(id),
      upsertCatalogSession: session => sessionManager.getAllSessions().set(session.id, session),
      saveCatalog: sessionId => sessionManager.saveSessionCatalogProjectionStrict(sessionId),
      stateFilePath: () => statePath,
    }, identity),
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  try {
    // A stub polluted by a past Main-side hydration: 16 fake stale messages.
    const polluted = baseSession(sessionId);
    polluted.history = Array.from({ length: 16 }, (_, i) => ({ role: 'user', parts: [{ text: `stale message ${i}` }] })) as any;
    polluted.meta = { lastMessageTime: 1 };
    sessionManager.getAllSessions().set(sessionId, polluted);

    await supervisor.reconcileStartupOwnerships();
    await ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'fresh input' }] });
    assert.equal(sessionManager.getAllSessions().get(sessionId)!.history.length, 16, 'the worker never touches the Main stub');
    await waitFor(() => store.getOwnership(sessionId).state === 'inactive');

    // Handback cleared the hydrated copy; the stub is a pure presentation mirror again.
    const stub = sessionManager.getAllSessions().get(sessionId)!;
    assert.equal(stub.history.length, 0, 'handback clears the hydrated stub history');
    assert.ok(stub.meta!.lastMessageTime! > 1, 'presentation fields still mirror the authority');

    // Bridge the split test state root; later reads lazily rehydrate the fresh authority.
    await fs.copy(statePath, realStatePath);
    const rehydrated = await sessionManager.getExistingSession(sessionId);
    assert.ok(JSON.stringify(rehydrated!.history).includes('deterministic child answer'), 'reads serve the fresh authority, not the stale stub');
    assert.ok(!JSON.stringify(rehydrated!.history).includes('stale message 0'));
  } finally {
    await supervisor.shutdown(5_000).catch(() => {});
    store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(realStatePath).catch(() => {});
    await sessionManager.saveSessionCatalogEntries(sessionManager.getAllSessions().keys()).catch(() => {});
    await fs.remove(root);
  }
});

test('handback never rolls back a Main-owned displayName rename but adopts one into an unnamed stub', async () => {
  const renamedId = `mc-rename-${Date.now()}`;
  const fixture = await createFixture(renamedId, { idleMs: 150 });
  const unnamedId = `${renamedId}-unnamed`;
  const fixture2 = await createFixture(unnamedId, { idleMs: 150 });
  try {
    // The authority carries an older name; Main renamed catalog-only while fenced.
    const auth = await fs.readJson(fixture.statePath);
    auth.displayName = 'authority-old-name';
    await fs.writeJson(fixture.statePath, auth);
    fixture.catalog.set(renamedId, { ...baseSession(renamedId), displayName: 'main-new-name' });
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(renamedId, { type: 'user', parts: [{ text: 'work' }] });
    await waitFor(() => fixture.store.getOwnership(renamedId).state === 'inactive');
    assert.equal(fixture.catalog.get(renamedId)!.displayName, 'main-new-name', 'handback never rolls back the Main-owned rename');

    // A never-named stub adopts the authority name so a worker self-rename stays visible.
    const auth2 = await fs.readJson(fixture2.statePath);
    auth2.displayName = 'worker-self-name';
    await fs.writeJson(fixture2.statePath, auth2);
    fixture2.catalog.set(unnamedId, baseSession(unnamedId));
    await fixture2.supervisor.reconcileStartupOwnerships();
    await fixture2.ingress.submitEnsuringWorker(unnamedId, { type: 'user', parts: [{ text: 'work' }] });
    await waitFor(() => fixture2.store.getOwnership(unnamedId).state === 'inactive');
    assert.equal(fixture2.catalog.get(unnamedId)!.displayName, 'worker-self-name', 'a never-named stub adopts the authority name');
  } finally {
    await fixture.close();
    await fixture2.close();
  }
});

test('rehydration after release preserves the Main-owned displayName (rename and adopted worker name)', async () => {
  const renamedId = `mc-rehydrate-${Date.now()}`;
  const unnamedId = `${renamedId}-unnamed`;
  const roots: string[] = [];
  const stores: SessionWorkerStore[] = [];
  const supervisors: SessionWorkerSupervisor[] = [];
  async function run(sessionId: string, authorityDisplayName: string, stubDisplayName: string | undefined) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-rehydrate-'));
    roots.push(root);
    const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open(); stores.push(store);
    const sourceContexts = new SessionWorkerSourceContextRegistry();
    const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
    const authority = { ...baseSession(sessionId), displayName: authorityDisplayName } as Session;
    await fs.outputJson(statePath, serializeSessionHistoryPayload(authority));
    const supervisor = new SessionWorkerSupervisor({
      store, idleMs: 150, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
      workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
      handbackWorker: identity => performSessionWorkerHandback({
        store,
        getCatalogSession: id => sessionManager.getAllSessions().get(id),
        upsertCatalogSession: session => sessionManager.getAllSessions().set(session.id, session),
        saveCatalog: sessionId => sessionManager.saveSessionCatalogProjectionStrict(sessionId),
        stateFilePath: () => statePath,
      }, identity),
    });
    supervisors.push(supervisor);
    const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
    const stub = baseSession(sessionId);
    if (stubDisplayName !== undefined) stub.displayName = stubDisplayName;
    sessionManager.getAllSessions().set(sessionId, stub);
    await supervisor.reconcileStartupOwnerships();
    await ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'fresh input' }] });
    await waitFor(() => store.getOwnership(sessionId).state === 'inactive');
    // Bridge the split test state root, then force a lazy authoritative rehydration.
    await fs.copy(statePath, getSessionHistoryFilePath(sessionId));
    const rehydrated = await sessionManager.getExistingSession(sessionId);
    return { rehydrated: rehydrated!, statePath };
  }
  try {
    const renamed = await run(renamedId, 'authority-old-name', 'main-new-name');
    assert.equal(renamed.rehydrated.displayName, 'main-new-name', 'rehydration never rolls back the Main-owned rename');
    assert.ok(JSON.stringify(renamed.rehydrated.history).includes('deterministic child answer'), 'rehydration still serves the fresh authority');

    const unnamed = await run(unnamedId, 'worker-self-name', undefined);
    assert.equal(unnamed.rehydrated.displayName, 'worker-self-name', 'the adopted worker self-rename survives rehydration');
  } finally {
    for (const supervisor of supervisors) await supervisor.shutdown(3_000).catch(() => {});
    for (const store of stores) store.close();
    sessionManager.getAllSessions().delete(renamedId);
    sessionManager.getAllSessions().delete(unnamedId);
    await fs.remove(getSessionHistoryFilePath(renamedId)).catch(() => {});
    await fs.remove(getSessionHistoryFilePath(unnamedId)).catch(() => {});
    await sessionManager.saveSessionCatalogEntries(sessionManager.getAllSessions().keys()).catch(() => {});
    for (const root of roots) await fs.remove(root);
  }
});
