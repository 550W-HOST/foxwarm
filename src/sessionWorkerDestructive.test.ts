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
    // The transactional persist is detached (queued on the host chain behind
    // the turn's own writes/publications), so poll for the final durable state.
    await waitFor(async () => JSON.parse(await fs.readFile(path.join(root, 'state', 'sessions', `${sessionId2}.json`), 'utf8')).stopping === true);
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
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    sessionManager.getAllSessions().set(sessionId, baseSession(sessionId));
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'slow question' }] }).catch(error => error);
    await waitFor(() => fs.pathExists(path.join(root, 'state', `slow-started-${sessionId}`)));

    const stopped: any = await fixture.runtime.call('control', { sessionId, action: 'stop' });
    assert.deepEqual(stopped, { action: 'stop', abortedInFlight: true }, 'interrupt aborts the in-flight provider request');

    const started = Date.now();
    const turnResult = await turn;
    assert.ok(!(turnResult instanceof Error), `the stopped turn completes without an RPC error: ${(turnResult as any)?.message}`);
    assert.ok(Date.now() - started < 8_000, 'the turn ends promptly after the abort instead of running the full slow request');
    // Canonical local parity: the stopped-turn marker is channel presentation,
    // not committed history; what matters is the slow answer is never appended
    // or delivered and the stopping flag is durably persisted. The detached
    // transactional persist lands after the turn's own writes on the host
    // chain, so poll for the final durable state.
    await waitFor(async () => {
      const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return authority.stopping === true && authority.busy === false
        && !JSON.stringify(authority.history).includes('deterministic child answer');
    });
    const authority = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(authority.stopping, true, 'the stopping flag is durably persisted');
    assert.equal(authority.busy, false, 'the turn released busy');
  } finally {
    fixture.transport.close();
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
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
