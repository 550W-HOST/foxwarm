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

function makeFixture(root: string, workerEnv: Record<string, string> = {}, idleMs = 60_000) {
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...workerEnv },
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

    // With no queued work, dequeue preserves the local no-op contract and does
    // not alter the already-stopped current turn.
    assert.deepEqual(await fixture.runtime.call('control', { sessionId, action: 'dequeue' }), {
      action: 'dequeue', queuedItems: 0, stoppedCurrent: false, abortedInFlight: false,
    });
    // Retry is closed, but an active Worker call rejects immediately rather
    // than queuing a second retry behind it.
    await assert.rejects(() => fixture.runtime.call('control', { sessionId, action: 'retry' }),
      (error: any) => error?.code === 'SESSION_WORKER_RETRY_BUSY' && error?.retryable === true);
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
  initial.contextFrontier = [1, 2, 3, 4].map(seq => ({ kind: 'message' as const, seq }));
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
