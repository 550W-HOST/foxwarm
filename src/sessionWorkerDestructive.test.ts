import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { getSessionHistoryFilePath, serializeSessionHistoryPayload } from './session/metadataStore';
import * as sessionRuntime from './sessionRuntime';
import { createSessionRuntimeServiceHandler, sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { teardownSessionWorkerForDelete } from './sessionWorkerDelete';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';
import { registerChannel, unregisterChannel, type Channel } from './channel';
import { attachChannel, createChannelsStore, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { DATA_ROOT_DIR } from './config';
import { setBeforeCrossSessionDeletionAdmissionForTests } from './sessionDeletion';
import type { QueueSource } from './types';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], persistentMemorySnapshot: 'destructive prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeFixture(
  root: string,
  workerEnv: Record<string, string> = {},
  idleMs = 60_000,
  stopCompletionTimeoutMs?: number,
  readProcessIdentity?: (pid: number) => string | null,
) {
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...workerEnv }, stopCompletionTimeoutMs, readProcessIdentity,
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  const registry = new RpcServiceRegistry();
  registry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler({
    worker: { store, registry: supervisor.projectionRegistry, ingress, supervisor },
  }));
  const transport = new LocalRpcTransport(registry, { maxPendingRequests: 32 });
  const runtime = new RpcClient(sessionRuntimeServiceDescriptor, transport);
  return { store, sourceContexts, supervisor, ingress, registry, transport, runtime };
}

test('Worker crash before Stop acknowledgement returns outcome-unknown instead of false success', async () => {
  const sessionId = `mc-stop-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_HANG_TURN: '1', FOXWARM_TEST_HANG_SESSION: sessionId }, 60_000, 2_000);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  const stub = baseSession(sessionId);
  try {
    sessionManager.getAllSessions().set(sessionId, stub);
    await fixture.supervisor.reconcileStartupOwnerships();
    // Generation 1's first turn hangs mid-flight (ignores its abort in the deterministic child).
    void fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'start a long turn' }] }).catch(() => {});
    await waitFor(async () => JSON.parse(await fs.readFile(statePath, 'utf8')).busy === true);
    // Wait until the turn has registered its in-flight abort controller.
    await waitFor(() => fs.pathExists(path.join(root, 'state', `hang-started-${sessionId}`)));

    const stop = fixture.runtime.call('control', { sessionId, action: 'stop' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const active = fixture.supervisor.getStatus(sessionId);
    assert.ok(active?.pid);
    process.kill(active.pid!, 'SIGKILL');
    await assert.rejects(() => stop,
      (error: any) => error?.code === 'SESSION_WORKER_STOP_OUTCOME_UNKNOWN' && error?.retryable === true);
    assert.notEqual(stub.stopping, true, 'Main never mirrors a Stop that did not confirm durable finalization');
    assert.ok(sessionManager.getAllSessions().get(sessionId) === stub, 'the worker authority is never hydrated into Main');

    // An idle fenced worker has nothing in flight to abort and Stop is a no-op.
    const sessionId2 = `${sessionId}-idle`;
    await fs.outputJson(path.join(root, 'state', 'sessions', `${sessionId2}.json`), serializeSessionHistoryPayload(baseSession(sessionId2)));
    await fixture.ingress.submitEnsuringWorker(sessionId2, { type: 'user', parts: [{ text: 'quick turn' }] });
    const stoppedIdle: any = await fixture.runtime.call('control', { sessionId: sessionId2, action: 'stop' });
    assert.deepEqual(stoppedIdle, { action: 'stop', abortedInFlight: false });
    const idleAuthority = JSON.parse(await fs.readFile(path.join(root, 'state', 'sessions', `${sessionId2}.json`), 'utf8'));
    assert.notEqual(idleAuthority.stopping, true, 'idle Stop does not poison the next turn');

  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    sessionManager.getAllSessions().delete(`${sessionId}-idle`);
    await fs.remove(root);
  }
});

test('Stop never reports success after a busy Worker has already exited', async () => {
  const sessionId = `mc-stop-precrashed-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-precrashed-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_HANG_TURN: '1', FOXWARM_TEST_HANG_SESSION: sessionId });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  const stub = baseSession(sessionId);
  try {
    sessionManager.getAllSessions().set(sessionId, stub);
    await fixture.supervisor.reconcileStartupOwnerships();
    void fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'busy before crash and stop' }],
    }).catch(() => {});
    await waitFor(async () => (await fs.readJson(statePath)).busy === true);
    await waitFor(() => fs.pathExists(path.join(root, 'state', `hang-started-${sessionId}`)));
    const active = fixture.supervisor.getStatus(sessionId);
    assert.ok(active?.pid);
    process.kill(active.pid!, 'SIGKILL');
    await waitFor(() => !fixture.supervisor.getStatus(sessionId));

    await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'stop' }),
      (error: any) => error?.code === 'SESSION_WORKER_STOP_OUTCOME_UNKNOWN' && error?.retryable === true);
    assert.notEqual(stub.stopping, true, 'unavailable Stop never mutates the Main stub');
    assert.equal((await fs.readJson(statePath)).busy, true, 'crashed authority remains visibly unconfirmed');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
  }
});

test('startup-reconciled activated lineage keeps Stop outcome unknown before detached recovery', async () => {
  for (const scenario of [
    { name: 'old-exited', actualIdentity: null, reason: 'startup-old-incarnation-exited' },
    { name: 'pid-reused', actualIdentity: 'new-process:2', reason: 'startup-pid-reused' },
  ] as ReadonlyArray<{ name: string; actualIdentity: string | null; reason: string }>) {
    const sessionId = `mc-stop-startup-${scenario.name}-${Date.now()}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-worker-stop-startup-${scenario.name}-`));
    const fixture = makeFixture(root, {}, 60_000, undefined, () => scenario.actualIdentity);
    const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
    await fs.outputJson(statePath, serializeSessionHistoryPayload({ ...baseSession(sessionId), busy: true }));
    const stub = baseSession(sessionId);
    try {
      sessionManager.getAllSessions().set(sessionId, stub);
      fixture.store.beginGeneration(sessionId, 'old-incarnation');
      fixture.store.registerCandidate(sessionId, 1, 'old-incarnation', 999_999, 'old-process:1');
      fixture.store.activateCandidate(sessionId, 1, 'old-incarnation', 999_999, 'old-process:1');
      await fixture.supervisor.reconcileStartupOwnerships();
      assert.equal(fixture.store.getOwnership(sessionId).lastExitReason, scenario.reason);
      assert.equal(fixture.supervisor.getStatus(sessionId), undefined, 'Stop does not spawn detached recovery');

      await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'stop' }),
        (error: any) => error?.code === 'SESSION_WORKER_STOP_OUTCOME_UNKNOWN' && error?.retryable === true);
      assert.equal(fixture.supervisor.getStatus(sessionId), undefined, 'unknown Stop never ensures a replacement');
      assert.equal(fixture.store.getOwnership(sessionId).generation, 1);
      assert.equal((await fs.readJson(statePath)).busy, true, 'Main never mutates unrecovered authority');
      assert.notEqual(stub.stopping, true, 'Main stub remains untouched');
    } finally {
      fixture.transport.close();
      await fixture.supervisor.shutdown(3_000).catch(() => {});
      fixture.store.close();
      sessionManager.getAllSessions().delete(sessionId);
      await fs.remove(root);
    }
  }
});

test('never-started and confirmed-clean inactive idle Stop remain harmless no-ops', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-clean-inactive-'));
  const fixture = makeFixture(root);
  const neverStartedId = `mc-stop-never-started-${Date.now()}`;
  const cleanInactiveId = `${neverStartedId}-clean`;
  try {
    sessionManager.getAllSessions().set(neverStartedId, baseSession(neverStartedId));
    sessionManager.getAllSessions().set(cleanInactiveId, baseSession(cleanInactiveId));
    fixture.store.beginGeneration(cleanInactiveId, 'clean-incarnation');
    fixture.store.registerCandidate(cleanInactiveId, 1, 'clean-incarnation', 999_998, 'clean-process:1');
    fixture.store.activateCandidate(cleanInactiveId, 1, 'clean-incarnation', 999_998, 'clean-process:1');
    fixture.store.markExitObserved(cleanInactiveId, 1, 'clean-incarnation', 'stopped:0');
    await fixture.supervisor.reconcileStartupOwnerships();

    assert.deepEqual(await fixture.runtime.call('control', { sessionId: neverStartedId, action: 'stop' }), {
      action: 'stop', abortedInFlight: false,
    });
    assert.deepEqual(await fixture.runtime.call('control', { sessionId: cleanInactiveId, action: 'stop' }), {
      action: 'stop', abortedInFlight: false,
    });
    assert.equal(fixture.supervisor.listStatuses().length, 0);
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(neverStartedId);
    sessionManager.getAllSessions().delete(cleanInactiveId);
    await fs.remove(root);
  }
});

test('signal-terminated intentional Worker lineage is not a clean inactive Stop no-op', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-signalled-inactive-'));
  const fixture = makeFixture(root);
  const sessionId = `mc-stop-signalled-inactive-${Date.now()}`;
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload({ ...baseSession(sessionId), busy: true }));
  const stub = baseSession(sessionId);
  try {
    sessionManager.getAllSessions().set(sessionId, stub);
    fixture.store.beginGeneration(sessionId, 'signalled-incarnation');
    fixture.store.registerCandidate(sessionId, 1, 'signalled-incarnation', 999_997, 'signalled-process:1');
    fixture.store.activateCandidate(sessionId, 1, 'signalled-incarnation', 999_997, 'signalled-process:1');
    fixture.store.markExitObserved(sessionId, 1, 'signalled-incarnation', 'stopped:SIGKILL');
    await fixture.supervisor.reconcileStartupOwnerships();

    await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'stop' }),
      (error: any) => error?.code === 'SESSION_WORKER_STOP_OUTCOME_UNKNOWN' && error?.retryable === true);
    assert.equal(fixture.supervisor.listStatuses().length, 0, 'ambiguous inactive Stop never spawns a Worker');
    assert.equal((await fs.readJson(statePath)).busy, true, 'busy authority is not Main-mutated');
    assert.notEqual(stub.stopping, true, 'Main stub remains untouched');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
  }
});

test('closed delete tears down the exact worker, clears the fence, and never resurrects authority', async () => {
  const sessionId = `mc-delete-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-delete-'));
  const fixture = makeFixture(root);
  const rootStatePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const realStatePath = getSessionHistoryFilePath(sessionId);
  try {
    // The authority lives in the real Main state root (mirrored into the worker tree).
    await sessionManager.getSession(sessionId);
    await fs.ensureDir(path.dirname(rootStatePath));
    await fs.copy(realStatePath, rootStatePath);
    sessionManager.setSessionWorkerDeleteHandler(id => teardownSessionWorkerForDelete({ store: fixture.store, supervisor: fixture.supervisor }, id));
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'some work' }] });
    assert.ok(fixture.supervisor.getStatus(sessionId)?.ready, 'worker is live before delete');
    assert.equal(fixture.store.findOwnership(sessionId)?.state, 'ready');

    const deleted = await sessionManager.deleteSession(sessionId);
    assert.equal(deleted, true);
    assert.ok(!fixture.supervisor.getStatus(sessionId), 'the exact worker generation is stopped');
    assert.equal(fixture.store.findOwnership(sessionId), undefined, 'the durable fence row is deleted');
    assert.ok(!await fs.pathExists(realStatePath), 'the authoritative JSON is deleted');
    assert.ok(!sessionManager.getAllSessions().has(sessionId), 'the catalog entry is deleted');
    // No resurrection: the stopped worker never writes the authority again.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(!await fs.pathExists(realStatePath));
  } finally {
    sessionManager.setSessionWorkerDeleteHandler(undefined);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
  }
});

test('a wedged lifecycle fails delete closed without touching the authority', async () => {
  const sessionId = `mc-wedge-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-wedge-'));
  const fixture = makeFixture(root);
  const rootStatePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(rootStatePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    // Simulate a handback-failure wedge: a ready fence whose worker already exited.
    fixture.store.beginGeneration(sessionId, 'inc-wedge');
    fixture.store.registerCandidate(sessionId, 1, 'inc-wedge', 999_999, 'fake-identity');
    fixture.store.activateCandidate(sessionId, 1, 'inc-wedge', 999_999, 'fake-identity');
    sessionManager.setSessionWorkerDeleteHandler(id => teardownSessionWorkerForDelete({ store: fixture.store, supervisor: fixture.supervisor }, id));
    const authorityBefore = await fs.readFile(rootStatePath);
    await assert.rejects(() => sessionManager.deleteSession(sessionId),
      (error: any) => error?.code === 'SESSION_WORKER_OWNED' && error?.retryable === true);
    assert.deepEqual(await fs.readFile(rootStatePath), authorityBefore, 'the authority is untouched when teardown cannot prove exit');
    assert.equal(fixture.store.findOwnership(sessionId)?.state, 'ready', 'the wedged fence is retained');
  } finally {
    sessionManager.setSessionWorkerDeleteHandler(undefined);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('fenced fork derives from the detached authority and archive stays Main-owned metadata', async () => {
  const sessionId = `mc-forktgt-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-forktgt-'));
  const fixture = makeFixture(root);
  try {
    const parent = await sessionManager.getSession(sessionId);
    await sessionManager.appendSessionMessage(sessionId, { role: 'user', parts: [{ text: 'fenced parent message' }] } as any);
    // Simulate a ready fence with the Main stub unhydrated (production shape).
    fixture.store.beginGeneration(sessionId, 'inc-forktgt');
    fixture.store.registerCandidate(sessionId, 1, 'inc-forktgt', 999_999, 'fake-identity');
    fixture.store.activateCandidate(sessionId, 1, 'inc-forktgt', 999_999, 'fake-identity');
    parent.history = [];
    sessionManager.setSessionWorkerForkSourceProvider(async id =>
      fixture.store.findOwnership(id) ? readDetachedWorkerSession(id, sessionManager.getAllSessions().get(id)!) : undefined);
    const parentBytesBefore = await fs.readFile(getSessionHistoryFilePath(sessionId));

    const forkedId = await sessionManager.forkSession(sessionId, 'forktgt', false);
    const forked = await sessionManager.getSession(forkedId);
    assert.ok(JSON.stringify(forked.history).includes('fenced parent message'), 'the fork inherits the fenced authority');
    assert.deepEqual(await fs.readFile(getSessionHistoryFilePath(sessionId)), parentBytesBefore, 'fork never writes the fenced authority');
    assert.equal(parent.history.length, 0, 'fork never hydrates the fenced stub into Main');

    // Archive is Main-owned presentation metadata: catalog-only writes stay open.
    assert.equal(await sessionManager.archiveSession(sessionId, true), true);
    assert.equal(sessionManager.getAllSessions().get(sessionId)!.archived, true);
    assert.deepEqual(await fs.readFile(getSessionHistoryFilePath(sessionId)), parentBytesBefore, 'archive never writes the fenced authority');

    await sessionManager.deleteSession(forkedId).catch(() => {});
  } finally {
    sessionManager.setSessionWorkerForkSourceProvider(undefined);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
  }
});

test('parent moves on a fenced child stay catalog-only and never write the authority', async () => {
  const sessionId = `mc-move-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-move-'));
  const fixture = makeFixture(root);
  try {
    const session = await sessionManager.getSession(sessionId);
    await sessionManager.appendSessionMessage(sessionId, { role: 'user', parts: [{ text: 'move guard message' }] } as any);
    session.history = []; // production fenced stubs are unhydrated
    fixture.store.beginGeneration(sessionId, 'inc-move');
    fixture.store.registerCandidate(sessionId, 1, 'inc-move', 999_999, 'fake-identity');
    fixture.store.activateCandidate(sessionId, 1, 'inc-move', 999_999, 'fake-identity');
    sessionManager.setSessionWorkerFenceChecker(id => {
      const ownership = fixture.store.findOwnership(id);
      return !!ownership && ownership.state !== 'inactive';
    });
    const authorityBefore = await fs.readFile(getSessionHistoryFilePath(sessionId));

    const moved = await sessionManager.setSessionParent(sessionId, 'some/parent');
    assert.equal(moved.parentSessionId, 'some/parent');
    assert.equal(sessionManager.getAllSessions().get(sessionId)!.parentSessionId, 'some/parent');
    assert.deepEqual(await fs.readFile(getSessionHistoryFilePath(sessionId)), authorityBefore,
      'the fenced authority is never written by a parent move');
    const detached = await sessionManager.setSessionParent(sessionId, undefined);
    assert.equal(detached.parentSessionId, undefined);
  } finally {
    sessionManager.setSessionWorkerFenceChecker(undefined);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
  }
});

test('interrupt aborts a slow provider request and ends the turn with stopped semantics', async () => {
  const sessionId = `mc-slow-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-slow-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_SLOW_PROVIDER: '1', FOXWARM_TEST_SLOW_SESSION: sessionId });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const mainHistoryPath = getSessionHistoryFilePath(sessionId);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.remove(mainHistoryPath);
  await fs.ensureSymlink(statePath, mainHistoryPath);
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'slow question' }] }).catch(error => error);
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${sessionId}`)));

    const stopStarted = Date.now();
    const stopped: any = await fixture.runtime.call('control', { sessionId, action: 'stop' });
    assert.deepEqual(stopped, { action: 'stop', abortedInFlight: true }, 'interrupt aborts the in-flight provider request');
    assert.ok(Date.now() - stopStarted < 2_000, 'abort-aware provider Stop confirms durable finalization promptly');

    const acknowledged = await fs.readJson(statePath);
    assert.equal(acknowledged.busy, false, 'successful Stop returns only after busy release is durable');
    assert.equal(acknowledged.stopping, false, 'successful Stop returns only after stopping is durably cleared');

    const started = Date.now();
    const turnResult = await turn;
    assert.ok(!(turnResult instanceof Error), `the stopped turn completes without an RPC error: ${(turnResult as any)?.message}`);
    assert.ok(Date.now() - started < 8_000, 'the turn ends promptly after the abort instead of running the full slow request');
    // Canonical local parity: the stopped-turn marker is channel presentation,
    // not committed history; the slow answer is never appended or delivered,
    // and finalization clears stopping before releasing the exact owner.
    await waitFor(async () => {
      const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return authority.stopping === false && authority.busy === false
        && !JSON.stringify(authority.history).includes('deterministic child answer');
    });
    const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(authority.stopping, false, 'the stopping flag is durably cleared');
    assert.equal(authority.busy, false, 'the turn released busy');

    const fresh = await fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'fresh question after stop' }],
    });
    assert.equal(fresh.busy, false);
    const afterFresh = await fs.readJson(statePath);
    assert.equal(JSON.stringify(afterFresh.history).split('fresh question after stop').length - 1, 1);
    assert.equal(JSON.stringify(afterFresh.history).split('deterministic child answer').length - 1, 1);
    assert.equal(afterFresh.stopping, false);
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(mainHistoryPath);
    await fs.remove(root);
  }
});

test('busy Worker history exposes durable queued input and Stop passively commits it without another turn', async () => {
  const sessionId = `mc-stop-pending-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-pending-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_SLOW_PROVIDER: '1', FOXWARM_TEST_SLOW_SESSION: sessionId });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const mainHistoryPath = getSessionHistoryFilePath(sessionId);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.outputJson(mainHistoryPath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'slow stop boundary question' }],
    }).catch(error => error);
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${sessionId}`)));
    await fixture.ingress.enqueueEnsuringWorker(sessionId, {
      type: 'user', clientMessageId: 'pending-stop-client', parts: [{ text: 'passively commit me' }],
    });

    const beforeStop = await fixture.runtime.call('getHistory', { sessionId });
    assert.ok(beforeStop);
    assert.equal(beforeStop!.session.queueLength, 1);
    const queuedClientRows = beforeStop!.queue.filter(item => item.clientMessageId === 'pending-stop-client');
    assert.equal(queuedClientRows.length, 1, 'the pending WebUI item appears exactly once in the composed queue snapshot');

    assert.deepEqual(await fixture.runtime.call('control', { sessionId, action: 'stop' }), {
      action: 'stop', abortedInFlight: true,
    });
    const turnResult = await turn;
    assert.ok(!(turnResult instanceof Error), `the stopped turn completes cleanly: ${turnResult?.message}`);
    await waitFor(async () => {
      const authority = await fs.readJson(statePath);
      return authority.busy === false && authority.stopping === false && authority.queue.length === 0
        && JSON.stringify(authority.history).includes('passively commit me');
    });

    const authority = await fs.readJson(statePath);
    const text = JSON.stringify(authority.history);
    assert.equal(text.split('slow stop boundary question').length - 1, 1);
    assert.equal(text.split('passively commit me').length - 1, 1);
    assert.equal(text.split('deterministic child answer').length - 1, 0, 'Stop never runs the queued input');
    assert.equal(fixture.store.countPendingIntents(sessionId), 0);

    const stoppedGeneration = fixture.supervisor.getStatus(sessionId);
    assert.ok(stoppedGeneration?.pid);
    process.kill(stoppedGeneration.pid!, 'SIGKILL');
    await waitFor(() => fixture.store.findOwnership(sessionId)?.state === 'inactive');
    await fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'fresh input after acknowledged stop crash' }],
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    const settledText = JSON.stringify((await fs.readJson(statePath)).history);
    assert.equal(settledText.split('passively commit me').length - 1, 1);
    assert.equal(settledText.split('fresh input after acknowledged stop crash').length - 1, 1);
    assert.equal(settledText.split('deterministic child answer').length - 1, 1,
      'restart runs only the fresh post-Stop input, never the passively committed pre-Stop queue');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(mainHistoryPath);
    await fs.remove(root);
  }
});

test('dequeue aborts a busy provider and the same worker action loop consumes queued work once', async () => {
  const sessionId = `mc-dequeue-${Date.now()}`;
  const idleSessionId = `${sessionId}-idle`;
  const emptySessionId = `${sessionId}-empty`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-dequeue-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_SLOW_PROVIDER: '1', FOXWARM_TEST_SLOW_SESSION: sessionId });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const idle = baseSession(idleSessionId);
  idle.queue.push({ type: 'user', parts: [{ text: 'idle queued input' }] });
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.outputJson(path.join(root, 'state', 'sessions', `${idleSessionId}.json`), serializeSessionHistoryPayload(idle));
  await fs.outputJson(path.join(root, 'state', 'sessions', `${emptySessionId}.json`), serializeSessionHistoryPayload(baseSession(emptySessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    sessionManager.getAllSessions().set(idleSessionId, { ...idle, queue: [] });
    sessionManager.getAllSessions().set(emptySessionId, baseSession(emptySessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'slow dequeue question' }],
    });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${sessionId}`)));
    await fixture.ingress.enqueueEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'queued dequeue follow-up' }],
    });

    const started = Date.now();
    assert.deepEqual(await fixture.runtime.call('control', { sessionId, action: 'dequeue' }), {
      action: 'dequeue', queuedItems: 1, stoppedCurrent: true, abortedInFlight: true,
    });
    assert.ok(Date.now() - started < 2_000, 'busy dequeue signals immediately instead of waiting behind the turn');
    await turn;
    await waitFor(async () => {
      const authority = await fs.readJson(statePath);
      return authority.busy === false && authority.queue.length === 0
        && JSON.stringify(authority.history).includes('deterministic child answer');
    });

    const authority = await fs.readJson(statePath);
    const text = JSON.stringify(authority.history);
    assert.equal(text.split('slow dequeue question').length - 1, 1);
    assert.equal(text.split('queued dequeue follow-up').length - 1, 1);
    assert.equal(text.split('deterministic child answer').length - 1, 1, 'queued work produces one final answer');
    assert.equal(authority.stopping, false);
    assert.equal(authority.meta.runQueuedAfterStop, undefined);
    assert.equal(authority.history.length, 3, 'the aborted provider contributes no duplicate model/final row');

    assert.deepEqual(await fixture.runtime.call('control', { sessionId: idleSessionId, action: 'dequeue' }), {
      action: 'dequeue', queuedItems: 1, stoppedCurrent: false, abortedInFlight: false,
    });
    const idleAuthority = await fs.readJson(path.join(root, 'state', 'sessions', `${idleSessionId}.json`));
    assert.equal(idleAuthority.queue.length, 0);
    assert.equal(JSON.stringify(idleAuthority.history).split('idle queued input').length - 1, 1);
    assert.equal(JSON.stringify(idleAuthority.history).split('deterministic child answer').length - 1, 1);

    assert.deepEqual(await fixture.runtime.call('control', { sessionId: emptySessionId, action: 'dequeue' }), {
      action: 'dequeue', queuedItems: 0, stoppedCurrent: false, abortedInFlight: false,
    });
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    sessionManager.getAllSessions().delete(idleSessionId);
    sessionManager.getAllSessions().delete(emptySessionId);
    await fs.remove(root);
  }
});

test('tool-noise compaction is serialized behind a busy worker turn and persists the exact projection', async () => {
  const sessionId = `mc-tool-compact-${Date.now()}`;
  const emptySessionId = `${sessionId}-empty`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-tool-compact-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_HOLD_PROVIDER: '1', FOXWARM_TEST_HOLD_SESSION: sessionId });
  const initial = baseSession(sessionId);
  const oversized = 'large-tool-payload '.repeat(2_000);
  initial.history = [
    { role: 'user', parts: [{ text: 'old tool request' }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'model', parts: [{ functionCall: { id: 'large-call', name: 'read', args: { payload: oversized }, rawArgsText: JSON.stringify({ payload: oversized }) } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'large-call', name: 'read', response: { output: oversized } } }], __meta: { seq: 3, timestamp: 3 } },
    { role: 'user', parts: [{ text: 'recent tail' }], __meta: { seq: 4, timestamp: 4 } },
  ] as any;
  initial.nextMessageSeq = 5;
  initial.historyVersion = 2;
  initial.meta.messageCount = 4;
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const emptyStatePath = path.join(root, 'state', 'sessions', `${emptySessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(initial));
  await fs.outputJson(emptyStatePath, serializeSessionHistoryPayload(baseSession(emptySessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, { ...initial, history: [] });
    sessionManager.getAllSessions().set(emptySessionId, baseSession(emptySessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'busy turn before compact tools' }],
    });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `hold-started-${sessionId}`)));

    let compactSettled = false;
    const compact = fixture.runtime.call('requestCompaction', {
      sessionId, keepPercent: 0.5, toolNoise: true,
    }).finally(() => { compactSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(compactSettled, false, 'history transform waits behind the busy exact-owner lane');
    assert.match(JSON.stringify((await fs.readJson(statePath)).history), /large-tool-payload/,
      'no concurrent history mutation occurs while the provider turn is active');

    await fs.outputFile(path.join(root, 'state', `hold-release-${sessionId}`), '1');
    await turn;
    const result: any = await compact;
    assert.equal(result.kind, 'tool-noise');
    assert.equal(result.result.replacedFunctionCalls, 1);
    assert.equal(result.result.replacedFunctionResponses, 1);
    assert.equal(result.result.touchedMessages, 2);

    const authority = await fs.readJson(statePath);
    assert.equal(authority.history[1].parts[0].functionCall.args.__compacted, true);
    assert.equal(authority.history[2].parts[0].functionResponse.response.__compacted, true);
    assert.equal(JSON.stringify(authority.history).includes('large-tool-payload'), false);
    assert.equal(authority.queue.length, 0);
    assert.equal(authority.busy, false);
    const projection = fixture.supervisor.projectionRegistry.get(sessionId)?.projection;
    assert.equal(projection?.messageCount, authority.history.length);
    assert.equal(projection?.queueLength, 0);
    assert.equal(projection?.busy, false);

    const emptyBefore = await fs.readFile(emptyStatePath);
    assert.deepEqual(await fixture.runtime.call('requestCompaction', {
      sessionId: emptySessionId, keepPercent: 0.5, toolNoise: true,
    }), { kind: 'empty' });
    assert.deepEqual(await fs.readFile(emptyStatePath), emptyBefore,
      'empty tool-noise compaction has no persistence side effect');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    sessionManager.getAllSessions().delete(emptySessionId);
    await fs.remove(root);
  }
});

test('worker BTW snapshots a busy owner concurrently and serializes display-only publication and idle lifetime', async () => {
  const sessionId = `mc-btw-${Date.now()}`;
  const channelId = `btw-channel-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-btw-'));
  const fixture = makeFixture(root, {
    FOXWARM_TEST_HOLD_PROVIDER: '1', FOXWARM_TEST_HOLD_SESSION: sessionId,
  }, 200);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const initial = baseSession(sessionId);
  initial.promptCacheKey = `btw-cache-${sessionId}`;
  const stub = baseSession(sessionId);
  const sent: Array<{ conversationId: string; text: string; options: any }> = [];
  let turn: Promise<any> | undefined;
  let busyBtw: Promise<any> | undefined;
  let idleBtw: Promise<any> | undefined;
  const channel: Channel = {
    name: channelId, platform: 'telegram', start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (conversationId, text, options) => { sent.push({ conversationId, text, options }); },
  };
  await fs.outputJson(statePath, serializeSessionHistoryPayload(initial));
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  registerChannel(channelId, channel); attachChannel(channelId, 'btw-room', sessionId); await saveChannels();
  try {
    sessionManager.getAllSessions().set(sessionId, stub);
    await fixture.supervisor.reconcileStartupOwnerships();
    turn = fixture.ingress.submitEnsuringWorker(sessionId, {
      type: 'user', parts: [{ text: 'busy owner input' }],
    });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `hold-started-${sessionId}`)));

    let busySettled = false;
    busyBtw = fixture.runtime.call('runBtw', {
      sessionId, message: 'hold-busy side question',
    }).finally(() => { busySettled = true; });
    const busyMarkerPath = path.join(root, 'state', `btw-started-busy-${sessionId}.json`);
    await waitFor(() => fs.pathExists(busyMarkerPath));
    const busyMarker = await fs.readJson(busyMarkerPath);
    const authorityAtSnapshot = await fs.readJson(statePath);
    assert.equal(fixture.supervisor.getStatus(sessionId)?.activeCalls, 2, 'turn and concurrent BTW RPC are both accepted active calls');
    assert.equal(busyMarker.purpose, 'btw');
    assert.equal(busyMarker.notifySessionEvents, false);
    assert.equal(busyMarker.registerAbortController, false);
    assert.equal(busyMarker.hasCurrentSessionEffects, false);
    assert.equal(busyMarker.promptCacheKey, authorityAtSnapshot.promptCacheKey);
    assert.equal(busyMarker.history.length, 1);
    assert.equal(JSON.stringify(busyMarker.history).includes('busy owner input'), true);
    assert.equal(JSON.stringify(authorityAtSnapshot.history).includes('hold-busy side question'), false,
      'temporary BTW input never mutates the hot owner');

    await fs.outputFile(path.join(root, 'state', `btw-release-busy-${sessionId}`), '1');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(busySettled, false, 'provider completion waits only for the owner serialized append lane');
    assert.equal(JSON.stringify((await fs.readJson(statePath)).history).includes('[BTW result]'), false);
    await fs.outputFile(path.join(root, 'state', `hold-release-${sessionId}`), '1');
    await turn;
    const busyResult: any = await busyBtw;
    assert.equal(busyResult.toolDenied, false);
    assert.match(busyResult.text, /deterministic BTW busy answer/);

    const denied: any = await fixture.runtime.call('runBtw', { sessionId, message: 'tool-deny side question' });
    const failed: any = await fixture.runtime.call('runBtw', { sessionId, message: 'provider-error side question' });
    assert.equal(denied.toolDenied, true);
    assert.match(denied.text, /BTW aborted/);
    assert.equal(failed.toolDenied, false);
    assert.match(failed.text, /BTW error/);
    assert.match(failed.text, /deterministic BTW provider failure/);

    let idleSettled = false;
    idleBtw = fixture.runtime.call('runBtw', {
      sessionId, message: 'hold-idle side question',
    }).finally(() => { idleSettled = true; });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `btw-started-idle-${sessionId}.json`)));
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(idleSettled, false);
    assert.equal(fixture.supervisor.getStatus(sessionId)?.ready, true, 'accepted BTW RPC prevents idle release while its provider is active');
    assert.equal(fixture.supervisor.getStatus(sessionId)?.activeCalls, 1);
    await fs.outputFile(path.join(root, 'state', `btw-release-idle-${sessionId}`), '1');
    await idleBtw;

    const authority = await fs.readJson(statePath);
    const displayRows = authority.history.filter((message: any) => message.modelVisible === false && message.__meta?.noticeType === 'btw');
    assert.equal(displayRows.length, 4);
    assert.equal(displayRows.filter((message: any) => JSON.stringify(message).includes('deterministic BTW busy answer')).length, 1);
    assert.equal(displayRows.filter((message: any) => JSON.stringify(message).includes('BTW aborted')).length, 1);
    assert.equal(displayRows.filter((message: any) => JSON.stringify(message).includes('BTW error')).length, 1);
    assert.equal(displayRows.filter((message: any) => JSON.stringify(message).includes('deterministic BTW idle answer')).length, 1);
    assert.equal(authority.busy, false);
    assert.equal(authority.queue.length, 0);
    assert.equal(stub.history.length, 0, 'Main catalog stub never hydrates Worker authority');
    assert.equal(sent.length, 4, 'each committed display row receives one attachment broadcast');
    assert.ok(sent.every(item => item.conversationId === 'btw-room'
      && item.options.excludePlatforms.includes('webui') && item.options.turnFinal === undefined));
    const projection = fixture.supervisor.projectionRegistry.get(sessionId)?.projection;
    assert.equal(projection?.messageCount, authority.history.length);
    assert.equal(projection?.busy, false);
    assert.equal(projection?.queueLength, 0);
  } finally {
    await fs.outputFile(path.join(root, 'state', `hold-release-${sessionId}`), '1').catch(() => {});
    await fs.outputFile(path.join(root, 'state', `btw-release-busy-${sessionId}`), '1').catch(() => {});
    await fs.outputFile(path.join(root, 'state', `btw-release-idle-${sessionId}`), '1').catch(() => {});
    await Promise.allSettled([turn, busyBtw, idleBtw].filter(Boolean) as Promise<any>[]);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    unregisterChannel(channelId); resetChannelsForTests(); setChannelsStoreForTests(null);
    await fs.remove(root);
  }
});

test('worker model delete_session removes local, idle-worker, and busy-worker targets without deleting its source', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sourceId = `mc-delete-source-${nonce}`;
  const sourceAlias = `${sourceId}-alias`;
  const localTargetId = `mc-delete-local-${nonce}`;
  const idleWorkerTargetId = `mc-delete-idle-worker-${nonce}`;
  const workerSurvivorId = `${idleWorkerTargetId}-child`;
  const busyWorkerTargetId = `mc-delete-busy-worker-${nonce}`;
  const root = DATA_ROOT_DIR;
  const fixture = makeFixture(root, {
    FOXWARM_TEST_SLOW_PROVIDER: '1',
    FOXWARM_TEST_SLOW_SESSION: busyWorkerTargetId,
    FOXWARM_TEST_MAIN_TOOLS_SESSION: sourceId,
    FOXWARM_TEST_MAIN_TOOLS: JSON.stringify([
      { id: 'delete-local', name: 'delete_session', args: { sessionId: localTargetId } },
      { id: 'delete-idle-worker', name: 'delete_session', args: { sessionId: idleWorkerTargetId } },
      { id: 'delete-busy-worker', name: 'delete_session', args: { sessionId: busyWorkerTargetId } },
      { id: 'delete-source-alias', name: 'delete_session', args: { sessionId: sourceAlias } },
    ]),
  });
  const ids = [sourceId, localTargetId, idleWorkerTargetId, workerSurvivorId, busyWorkerTargetId];
  try {
    await sessionManager.loadSessions();
    for (const id of ids) {
      const session = baseSession(id);
      session.promptCacheKey = `delete-cache-${id}`;
      if (id === sourceId) session.aliases = [sourceAlias];
      if (id === workerSurvivorId) session.parentSessionId = idleWorkerTargetId;
      sessionManager.getAllSessions().set(id, session);
      await sessionManager.saveSession(id);
    }
    sessionManager.setSessionWorkerDeleteHandler(id => teardownSessionWorkerForDelete({ store: fixture.store, supervisor: fixture.supervisor }, id));
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });

    await fixture.ingress.ensureWorkerOwner(idleWorkerTargetId);
    await fixture.ingress.ensureWorkerOwner(workerSurvivorId);
    const busyTurn = fixture.ingress.submitEnsuringWorker(busyWorkerTargetId, {
      type: 'user', parts: [{ text: 'busy target work' }],
    });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${busyWorkerTargetId}`)));

    await fixture.ingress.submitEnsuringWorker(sourceId, {
      type: 'user', parts: [{ text: 'delete the three other targets' }],
    });
    await busyTurn;

    const sourceAuthority = await fs.readJson(getSessionHistoryFilePath(sourceId));
    for (const targetId of [localTargetId, idleWorkerTargetId, busyWorkerTargetId]) {
      assert.equal(sessionManager.getAllSessions().has(targetId), false, JSON.stringify(sourceAuthority.history));
      assert.equal(await fs.pathExists(getSessionHistoryFilePath(targetId)), false);
      assert.equal(fixture.store.findOwnership(targetId), undefined);
      assert.equal(fixture.store.countPendingIntents(targetId), 0);
    }
    assert.equal(sessionManager.getAllSessions().has(sourceId), true);
    assert.equal(await fs.pathExists(getSessionHistoryFilePath(sourceId)), true);
    assert.equal(fixture.supervisor.getStatus(sourceId)?.ready, true);
    assert.equal(fixture.store.findOwnership(sourceId)?.state, 'ready');
    assert.equal(JSON.stringify(sourceAuthority.history).split('deleted successfully').length - 1, 3);
    assert.equal(JSON.stringify(sourceAuthority.history).split('Cannot delete current session').length - 1, 1);
    assert.equal(sourceAuthority.busy, false);
    assert.equal(sourceAuthority.queue.length, 0);

    assert.equal(sessionManager.getAllSessions().has(workerSurvivorId), true);
    assert.equal(sessionManager.getSessionCatalog(workerSurvivorId)?.parentSessionId, undefined);
    assert.equal(fixture.store.findOwnership(workerSurvivorId)?.state, 'ready');
    await fixture.ingress.submitEnsuringWorker(workerSurvivorId, {
      type: 'user', parts: [{ text: 'continue after parent deletion' }],
    });
    assert.equal(sessionManager.getSessionCatalog(workerSurvivorId)?.parentSessionId, undefined,
      'later Worker publication must not recreate the deleted parent relation');
  } finally {
    sessionManager.setSessionWorkerDeleteHandler(undefined);
    await sessionRuntime.shutdownSessionRuntime().catch(() => {});
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    for (const id of ids) {
      sessionManager.getAllSessions().delete(id);
      await fs.remove(getSessionHistoryFilePath(id)).catch(() => {});
    }
    for (const suffix of ['', '-shm', '-wal']) await fs.remove(path.join(root, `session-runtime.sqlite${suffix}`)).catch(() => {});
  }
});

test('reciprocal Worker delete_session calls admit one pair and let its surviving source settle', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sourceA = `mc-delete-reciprocal-a-${nonce}`;
  const sourceB = `mc-delete-reciprocal-b-${nonce}`;
  const root = DATA_ROOT_DIR;
  const fixture = makeFixture(root, {
    FOXWARM_TEST_MAIN_TOOLS_BY_SESSION: JSON.stringify({
      [sourceA]: [{ id: 'delete-b', name: 'delete_session', args: { sessionId: sourceB } }],
      [sourceB]: [{ id: 'delete-a', name: 'delete_session', args: { sessionId: sourceA } }],
    }),
  });
  const replies: Array<{ sessionId: string; text: string }> = [];
  const drainedAuthorities = new Map<string, any>();
  let releaseAdmissionBarrier!: () => void;
  const admissionBarrier = new Promise<void>(resolve => { releaseAdmissionBarrier = resolve; });
  const admissionSources = new Set<string>();
  setBeforeCrossSessionDeletionAdmissionForTests(async ({ sourceSessionId }) => {
    admissionSources.add(sourceSessionId);
    if (admissionSources.size === 2) releaseAdmissionBarrier();
    await admissionBarrier;
  });
  const queueSource = (sessionId: string): QueueSource => ({
    platform: 'test', channelId: 'reciprocal-delete', channelType: 'test',
    channelUserId: sessionId, conversationId: sessionId, senderId: sessionId,
    preferDirectReply: true,
  });
  const registrations: Array<() => void> = [];
  try {
    await sessionManager.loadSessions();
    for (const id of [sourceA, sourceB]) {
      const session = baseSession(id);
      session.promptCacheKey = `reciprocal-delete-cache-${id}`;
      sessionManager.getAllSessions().set(id, session);
      await sessionManager.saveSession(id);
    }
    sessionManager.setSessionWorkerDeleteHandler(async id => {
      const tornDown = await teardownSessionWorkerForDelete({ store: fixture.store, supervisor: fixture.supervisor }, id);
      if ([sourceA, sourceB].includes(id) && await fs.pathExists(getSessionHistoryFilePath(id))) {
        drainedAuthorities.set(id, await fs.readJson(getSessionHistoryFilePath(id)));
      }
      return tornDown;
    });
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });
    await fixture.ingress.ensureWorkerOwner(sourceA);
    await fixture.ingress.ensureWorkerOwner(sourceB);

    for (const id of [sourceA, sourceB]) {
      const source = queueSource(id);
      registrations.push(fixture.sourceContexts.register(id, source, {
        ...source,
        reply: async text => { replies.push({ sessionId: id, text }); },
        sendTyping: async () => {},
      }));
    }

    const [turnA, turnB] = await Promise.allSettled([
      fixture.ingress.submitEnsuringWorker(sourceA, {
        type: 'user', source: queueSource(sourceA), clientMessageId: `reciprocal-a-${nonce}`,
        parts: [{ text: 'delete the reciprocal source B' }],
      }),
      fixture.ingress.submitEnsuringWorker(sourceB, {
        type: 'user', source: queueSource(sourceB), clientMessageId: `reciprocal-b-${nonce}`,
        parts: [{ text: 'delete the reciprocal source A' }],
      }),
    ]);

    assert.equal(admissionSources.size, 2, 'both production reverse delete calls reached pair admission');
    for (const result of [turnA, turnB]) {
      if (result.status === 'rejected') {
        assert.fail(`reciprocal turn failed outside the tool result: ${result.reason?.code || result.reason?.message || result.reason}`);
      }
    }
    assert.equal(JSON.stringify([turnA, turnB, replies]).includes('RPC_DRAIN_TIMEOUT'), false);
    assert.equal(JSON.stringify([turnA, turnB, replies]).includes('RPC_CLOSED'), false);

    const survivingIds = [sourceA, sourceB].filter(id => sessionManager.getSessionCatalog(id));
    assert.equal(survivingIds.length, 1, 'exactly one reciprocal delete commits');
    const survivorId = survivingIds[0];
    const deletedId = survivorId === sourceA ? sourceB : sourceA;
    const deletedAuthority = drainedAuthorities.get(deletedId);
    assert.ok(deletedAuthority, 'target teardown observes the drained source authority before deletion');
    assert.match(JSON.stringify(deletedAuthority.history), /SESSION_DELETE_CONFLICT/);
    assert.match(JSON.stringify(deletedAuthority.history), /"retryable":true/);
    assert.ok(replies.some(reply => reply.sessionId === deletedId && reply.text === '_[Execution stopped by user]_'),
      'the conflicting target commits a terminal turn response before deletion');
    assert.ok(replies.some(reply => reply.sessionId === survivorId && reply.text === 'deterministic child answer'));

    const survivorAuthority = await fs.readJson(getSessionHistoryFilePath(survivorId));
    assert.match(JSON.stringify(survivorAuthority.history), /deleted successfully/);
    assert.equal(survivorAuthority.busy, false);
    assert.equal(survivorAuthority.queue.length, 0);
    assert.equal(fixture.supervisor.getStatus(survivorId)?.ready, true);
    assert.equal(fixture.store.findOwnership(survivorId)?.state, 'ready');
    assert.equal(sessionManager.getSessionCatalog(deletedId), undefined);
    assert.equal(await fs.pathExists(getSessionHistoryFilePath(deletedId)), false);
    assert.equal(fixture.supervisor.getStatus(deletedId), undefined);
    assert.equal(fixture.store.findOwnership(deletedId), undefined);
  } finally {
    releaseAdmissionBarrier();
    setBeforeCrossSessionDeletionAdmissionForTests(undefined);
    for (const unregister of registrations) unregister();
    sessionManager.setSessionWorkerDeleteHandler(undefined);
    await sessionRuntime.shutdownSessionRuntime().catch(() => {});
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    for (const id of [sourceA, sourceB]) {
      sessionManager.getAllSessions().delete(id);
      await fs.remove(getSessionHistoryFilePath(id)).catch(() => {});
    }
    for (const suffix of ['', '-shm', '-wal']) await fs.remove(path.join(root, `session-runtime.sqlite${suffix}`)).catch(() => {});
  }
});

test('/messages serves a fenced session from the runtime DTO and a detached authority read', async () => {
  const sessionId = `mc-msgs-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-msgs-'));
  const fixture = makeFixture(root);
  try {
    // The authority (shared-root production shape) holds real messages; the
    // Main catalog stub stays an unhydrated mirror. A live worker supplies the
    // projection the runtime DTO overlays.
    await sessionManager.getSession(sessionId);
    await sessionManager.appendSessionMessage(sessionId, { role: 'user', parts: [{ text: 'messages test question' }] } as any);
    await sessionManager.appendSessionMessage(sessionId, { role: 'model', parts: [{ text: 'messages test answer' }] } as any);
    const rootStatePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
    await fs.ensureDir(path.dirname(rootStatePath));
    await fs.copy(getSessionHistoryFilePath(sessionId), rootStatePath);
    const stub = baseSession(sessionId);
    stub.meta = { lastMessageTime: 1, messageCount: 2 } as any;
    sessionManager.getAllSessions().set(sessionId, stub);
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'messages test follow-up' }] });
    // Bridge the split test state root for the detached read.
    await fs.copy(rootStatePath, getSessionHistoryFilePath(sessionId));
    sessionManager.setSessionWorkerFenceChecker(id => {
      const ownership = fixture.store.findOwnership(id);
      return !!ownership && ownership.state !== 'inactive';
    });
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });

    const replies: string[] = [];
    const ctx = { reply: (text: string) => { replies.push(text); } };
    const { COMMANDS } = await import('./commands');
    await COMMANDS['/messages'].handler(ctx as any, ['5'], sessionId, stub as any);
    const output = replies.join('\n');
    assert.ok(output.includes('messages test question') && output.includes('messages test answer'),
      `preview serves the fenced authority: ${output.slice(0, 200)}`);
    assert.equal(stub.history.length, 0, 'the preview never hydrates the fenced stub into Main');
  } finally {
    await sessionRuntime.shutdownSessionRuntime(2_000).catch(() => {});
    sessionManager.setSessionWorkerFenceChecker(undefined);
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
  }
});

test('committed projections track turn phases and settle to idle while the worker stays alive', async () => {
  const sessionId = `mc-phases-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-phases-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_SLOW_PROVIDER: '1', FOXWARM_TEST_SLOW_SESSION: sessionId });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'slow question' }] }).catch(error => error);
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${sessionId}`)));

    // Mid-turn: the transient runtime-state publication reaches the registry.
    await waitFor(() => {
      const projection = fixture.supervisor.projectionRegistry.get(sessionId)?.projection;
      return projection?.busy === true && projection?.runtimeState?.state === 'requesting-model';
    });

    await fixture.runtime.call('control', { sessionId, action: 'stop' });
    await turn;
    // Turn end while the worker is still alive: the served projection settles
    // to idle instead of sticking on the last committed phase until handback.
    await waitFor(() => {
      const projection = fixture.supervisor.projectionRegistry.get(sessionId)?.projection;
      return projection?.busy === false && projection?.runtimeState?.state === 'idle';
    });
    assert.ok(fixture.supervisor.getStatus(sessionId)?.ready, 'the worker is still alive after the turn');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
  }
});

test('the real llm.chat pipeline dispatches its HTTP request through a worker turn (mocked network boundary)', async () => {
  const sessionId = `mc-axios-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-axios-'));
  // Mock-axios mode keeps the REAL llm.chat path (model resolution, request
  // plan, journal, request logging, HTTP dispatch, response parsing) and stubs
  // only the network boundary — a regression that hangs the pre-HTTP pipeline
  // fails this test instead of slipping through the deterministic chat hook.
  const fixture = makeFixture(root, { FOXWARM_TEST_MOCK_AXIOS: '1' });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'axios mock question' }] });
    assert.ok(await fs.pathExists(path.join(root, 'state', 'axios-mock-1')), 'the LLM HTTP request was actually dispatched');
    const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.ok(JSON.stringify(authority.history).includes('mock axios answer'), 'the parsed provider answer completes the turn');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
  }
});
