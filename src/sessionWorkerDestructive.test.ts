import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { getSessionHistoryFilePath, serializeSessionHistoryPayload } from './session/metadataStore';
import { createSessionRuntimeServiceHandler, sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { teardownSessionWorkerForDelete } from './sessionWorkerDelete';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
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
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'destructive prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeFixture(root: string, workerEnv: Record<string, string> = {}) {
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...workerEnv },
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id);
  const registry = new RpcServiceRegistry();
  registry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler({
    worker: { store, registry: supervisor.projectionRegistry, ingress, supervisor },
  }));
  const transport = new LocalRpcTransport(registry, { maxPendingRequests: 32 });
  const runtime = new RpcClient(sessionRuntimeServiceDescriptor, transport);
  return { store, sourceContexts, supervisor, ingress, registry, transport, runtime };
}

test('closed stop interrupts a fenced worker turn and mirrors stopping catalog-only', async () => {
  const sessionId = `mc-stop-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-stop-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_HANG_TURN: '1', FOXWARM_TEST_HANG_SESSION: sessionId });
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

    const stopped: any = await fixture.runtime.call('control', { sessionId, action: 'stop' });
    assert.deepEqual(stopped, { action: 'stop', abortedInFlight: true }, 'interrupt aborts the active provider request without waiting on the turn');
    assert.equal(stub.stopping, true, 'Main mirrors stopping via a catalog-only stub write');
    assert.ok(sessionManager.getAllSessions().get(sessionId) === stub, 'the worker authority is never hydrated into Main');

    // An idle fenced worker has nothing in flight to abort.
    const sessionId2 = `${sessionId}-idle`;
    await fs.outputJson(path.join(root, 'state', 'sessions', `${sessionId2}.json`), serializeSessionHistoryPayload(baseSession(sessionId2)));
    await fixture.ingress.submitEnsuringWorker(sessionId2, { type: 'user', parts: [{ text: 'quick turn' }] });
    const stoppedIdle: any = await fixture.runtime.call('control', { sessionId: sessionId2, action: 'stop' });
    assert.equal(stoppedIdle.action, 'stop');
    assert.equal(stoppedIdle.abortedInFlight, false);
    const idleAuthority = JSON.parse(await fs.readFile(path.join(root, 'state', 'sessions', `${sessionId2}.json`), 'utf8'));
    assert.equal(idleAuthority.stopping, true, 'idle interrupt still persists the stopping flag transactionally');

    // dequeue and retry remain explicitly unsupported for fenced sessions.
    await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'dequeue' }),
      (error: any) => error?.code === 'SESSION_WORKER_CONTROL_UNSUPPORTED' && error?.retryable === true);
    await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'retry' }),
      (error: any) => error?.code === 'SESSION_WORKER_CONTROL_UNSUPPORTED' && error?.retryable === true);
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    sessionManager.getAllSessions().delete(`${sessionId}-idle`);
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
