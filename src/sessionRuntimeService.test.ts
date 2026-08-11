import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
} from './rpc';
import * as sessionManager from './sessionManager';
import { sessionCatalogStore } from './session/catalogStore';
import * as vector from './vector';
import {
  createSessionRuntimeServiceHandler,
  sessionRuntimeServiceDescriptor,
} from './sessionRuntimeService';
import type { Message, SessionStreamEvent } from './types';
import type { Session } from './types';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import { buildSessionWorkerProjection, type SessionWorkerProjection } from './sessionWorkerPersistence';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { getSessionHistoryFilePath } from './session/metadataStore';
import { SESSIONS_FILE } from './config';
import {
  getSessionRuntimeStatus,
  initializeSessionRuntime,
  shutdownSessionRuntime,
  startEvents,
  subscribe,
} from './sessionRuntime';

function makeSessionId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createLocalClient() {
  const registry = new RpcServiceRegistry();
  registry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler());
  const transport = new LocalRpcTransport(registry);
  return {
    transport,
    client: new RpcClient(sessionRuntimeServiceDescriptor, transport),
  };
}

const flushEvents = () => new Promise<void>(resolve => setImmediate(resolve));

test('local empty-history compaction classifies normal and tool-noise requests without persistence', async () => {
  const sessionId = makeSessionId('session_runtime_empty_compact');
  const session: Session = { id: sessionId, agent: 'main', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, busy: false, queue: [], meta: { lastMessageTime: 0 } };
  sessionManager.getAllSessions().set(sessionId, session);
  const { transport, client } = createLocalClient(); const sessionsBefore = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null;
  const originals = { save: sessionManager.saveSession, schedule: vector.scheduleSessionArchiveIndex }; let saves = 0; let indexes = 0;
  (sessionManager as any).saveSession = async () => { saves += 1; };
  (vector as any).scheduleSessionArchiveIndex = async () => { indexes += 1; };
  try {
    assert.deepEqual(await client.call('requestCompaction', { sessionId, keepPercent: 0.3 }), { kind: 'empty' });
    assert.deepEqual(await client.call('requestCompaction', { sessionId, keepPercent: 0.3, toolNoise: true }), { kind: 'empty' });
    assert.equal(session.promptCacheKey, undefined); assert.equal(saves, 0); assert.equal(indexes, 0);
    const sessionsAfter = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null; assert.deepEqual(sessionsAfter, sessionsBefore);
  } finally {
    (sessionManager as any).saveSession = originals.save; (vector as any).scheduleSessionArchiveIndex = originals.schedule;
    transport.close(); sessionManager.getAllSessions().delete(sessionId);
  }
});

test('local SessionRuntime DTO seam clones projections and preserves event order', async () => {
  const originalScheduleIndex = vector.scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async (): Promise<void> => {};
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_runtime_contract');
  const { session } = await sessionManager.createEmptySession(sessionId);
  const { transport, client } = createLocalClient();
  const events: Array<{ name: string; payload: any; sequence: number }> = [];
  const unsubscribe = client.subscribe((name, payload: any, meta) => {
    events.push({ name, payload, sequence: meta.sequence });
    if (name === 'history') {
      payload.message.parts[0].text = 'caller-mutated-event';
    }
  });

  try {
    const started = await client.call('startEvents', {});
    assert.equal(started.started, true);

    const first = await client.call('getSession', { sessionId });
    assert.ok(first.session);
    first.session!.aliases.push('caller-only-alias');
    first.session!.runtimeState.queueLength = 999;
    const second = await client.call('getSession', { sessionId });
    assert.deepEqual(second.session!.aliases, []);
    assert.equal(second.session!.runtimeState.queueLength, 0);

    events.length = 0;
    const settings = await client.call('updateSettings', {
      sessionId,
      patch: {
        cwd: '/tmp/runtime-cwd',
        model: 'provider/model',
        effort: 'none',
        childModelDefault: 'provider/child',
        childEffortDefault: 'max',
        currentNode: 'node-a',
        displayName: 'Runtime DTO',
        compactThresholdTokens: 4321.9,
      },
    });
    assert.deepEqual(settings.changed, ['cwd', 'model', 'effort', 'childModelDefault', 'childEffortDefault', 'currentNode', 'displayName', 'compactThresholdTokens']);
    assert.equal(settings.previous.cwd, null);
    assert.equal(settings.current.cwd, '/tmp/runtime-cwd');
    assert.equal(settings.current.effort, 'none');
    assert.equal(settings.current.childEffortDefault, 'max');
    assert.equal(settings.current.compactThresholdTokens, 4321);
    settings.session.displayName = 'caller-only-name';
    await flushEvents();
    assert.deepEqual(events.map(event => event.name), ['listChanged', 'stateChanged']);
    assert.ok(events[1].sequence > events[0].sequence);
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'Runtime DTO');
    await assert.rejects(
      client.call('updateSettings', {
        sessionId,
        patch: { displayName: 'must-not-apply', unknownSetting: true } as any,
      }),
      (error: any) => error instanceof RpcError && error.code === 'SESSION_RUNTIME_INVALID_SETTING',
    );
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'Runtime DTO');

    events.length = 0;
    await client.call('enqueue', {
      sessionId,
      item: { type: 'background', parts: [{ text: 'queued-through-runtime' }] },
    });
    await flushEvents();
    assert.deepEqual(events.map(event => event.name), ['listChanged', 'stateChanged']);

    const historyBefore = await client.call('getHistory', { sessionId });
    assert.ok(historyBefore);
    assert.equal(historyBefore!.queue.length, 1);
    historyBefore!.queue[0].parts![0].text = 'caller-mutated-queue';
    const historyAfter = await client.call('getHistory', { sessionId });
    assert.equal(historyAfter!.queue[0].parts![0].text, 'queued-through-runtime');

    session.busy = true;
    await sessionManager.saveSession(sessionId);
    assert.deepEqual(await client.call('control', { sessionId, action: 'dequeue' }), {
      action: 'dequeue',
      queuedItems: 1,
      stoppedCurrent: true,
      abortedInFlight: false,
    });
    assert.equal(session.meta.runQueuedAfterStop, true);
    session.busy = false;
    session.stopping = false;
    session.meta.runQueuedAfterStop = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);

    let retryCount = 0;
    sessionManager.setSessionRetryCallback(async (retrySessionId) => {
      if (retrySessionId === sessionId) retryCount += 1;
    });
    assert.deepEqual(await client.call('control', { sessionId, action: 'retry' }), { action: 'retry' });
    assert.equal(retryCount, 1);

    session.busy = true;
    await client.call('queueEvent', { sessionId, text: 'runtime-trigger-event', type: 'trigger' });
    assert.equal(session.queue[0].type, 'trigger');
    assert.match(String(session.queue[0].parts?.[0]?.system), /runtime-trigger-event/);
    session.busy = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);

    const message: Message = { role: 'user', parts: [{ text: 'canonical-history' }] };
    events.length = 0;
    await sessionManager.appendSessionMessage(session, message);
    sessionManager.notifySessionEvent(sessionId, {
      type: 'model-stream-update',
      data: { text: 'delta' },
    } as SessionStreamEvent);
    await flushEvents();
    const historyIndex = events.findIndex(event => event.name === 'history');
    const streamIndex = events.findIndex(event => event.name === 'stream');
    assert.ok(historyIndex >= 0 && streamIndex > historyIndex, 'history and stream events preserve publication order');
    assert.ok(events[streamIndex].sequence > events[historyIndex].sequence);
    assert.equal(session.history.at(-1)?.parts[0].text, 'canonical-history');

    session.busy = true;
    const controller = new AbortController();
    sessionManager.registerSessionAbortController(sessionId, controller);
    const stopped = await client.call('control', { sessionId, action: 'stop' });
    assert.deepEqual(stopped, { action: 'stop', abortedInFlight: true });
    assert.equal(controller.signal.aborted, true);

    await assert.rejects(
      client.call('enqueue', { sessionId, item: { type: 'background', parts: [] } as any }),
      (error: any) => error instanceof RpcError && error.code === 'SESSION_RUNTIME_INVALID_QUEUE_ITEM',
    );
    assert.equal((await client.call('getSession', { sessionId: 'missing-session-runtime-id' })).session, null);

    const stoppedEvents = await client.call('stopEvents', {});
    assert.equal(stoppedEvents.stopped, true);
  } finally {
    unsubscribe();
    transport.close();
    session.busy = false;
    session.stopping = false;
    session.queue = [];
    await sessionManager.deleteSession(sessionId).catch(() => {});
    sessionManager.setOnHistoryUpdated(() => {});
    sessionManager.setOnSessionEventUpdated(() => {});
    sessionManager.setOnSessionListUpdated(() => {});
    sessionManager.setOnSessionStateUpdated(() => {});
    sessionManager.setSessionRetryCallback(async () => {});
    (vector as any).scheduleSessionArchiveIndex = originalScheduleIndex;
  }
});

test('loaded alias resolution rejects stale, forged, and duplicate cache identities', async () => {
  const originalScheduleIndex = vector.scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async (): Promise<void> => {};
  await sessionManager.loadSessions();
  const firstId = makeSessionId('loaded_alias_first'); const secondId = makeSessionId('loaded_alias_second');
  const { session: first } = await sessionManager.createEmptySession(firstId);
  const { session: second } = await sessionManager.createEmptySession(secondId);
  const alias = `${firstId}-alias`; const forged = `${firstId}-forged`;
  try {
    first.aliases = [alias]; second.aliases = [];
    await sessionManager.saveSessionCatalogEntries([firstId, secondId]);
    sessionManager.updateAliasCache([alias], firstId);
    assert.equal(sessionManager.resolveLoadedSessionId(alias), firstId, 'valid cached membership resolves');
    sessionManager.updateAliasCache([forged], firstId);
    assert.equal(sessionManager.resolveLoadedSessionId(forged), forged, 'cache-only membership is ignored');
    first.aliases = [];
    await sessionManager.saveSessionCatalogEntries([firstId]);
    assert.equal(sessionManager.resolveLoadedSessionId(alias), alias, 'removed alias invalidates its cache hit');
    sessionManager.updateAliasCache([alias], firstId); second.aliases = [alias];
    await sessionManager.saveSessionCatalogEntries([firstId, secondId]);
    assert.equal(sessionManager.resolveLoadedSessionId(alias), secondId, 'stale cache yields to unique current membership');
    first.aliases = [alias];
    await sessionManager.saveSessionCatalogEntries([firstId]);
    assert.equal(sessionManager.resolveLoadedSessionId(alias), alias, 'duplicate current owners fail unresolved');
    second.aliases = [firstId];
    assert.equal(sessionManager.resolveLoadedSessionId(firstId), firstId, 'an exact real ID wins before aliases');
  } finally {
    first.aliases = []; second.aliases = [];
    await sessionManager.deleteSession(firstId).catch(() => {}); await sessionManager.deleteSession(secondId).catch(() => {});
    (vector as any).scheduleSessionArchiveIndex = originalScheduleIndex;
  }
});

test('SessionRuntime overlays only the exact current Worker and reads detached authority', async () => {
  const originalScheduleIndex = vector.scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async (): Promise<void> => {};
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_runtime_worker_projection');
  const { session: stub } = await sessionManager.createEmptySession(sessionId);
  const alias = `${sessionId}-alias`;
  stub.displayName = 'Catalog name'; stub.pinned = true; stub.sidebarOrder = 7; stub.aliases = [alias];
  stub.meta.wait = { id: 'catalog-timer-wait', startedAt: 10, timeoutSeconds: 30 };
  await sessionManager.saveSession(sessionId);
  const catalogBefore = JSON.stringify(sessionCatalogStore.get(sessionId));
  const worker = {
    ...stub,
    history: [{ role: 'user', parts: [{ text: 'authoritative worker history' }], __meta: { seq: 1, timestamp: 123 } }],
    queue: [1, 2, 3].map(index => ({ type: 'background', parts: [{ text: `authoritative worker queue ${index}` }] })),
    contextFrontier: [{ kind: 'message', seq: 1 }],
    persistentMemorySnapshot: 'worker prompt',
    busy: true, busyStartedAt: 100, currentNode: 'worker-node', cwd: '/worker/cwd', model: 'worker/model',
    meta: { lastMessageTime: 123, messageCount: 1, wait: { id: 'worker-exec-wait', startedAt: 20, waitExecIds: ['worker-exec'] } },
    stats: { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null },
  } as Session;
  await writeAuthoritativeSessionState(worker);
  const authorityPath = getSessionHistoryFilePath(sessionId);
  const authorityBefore = await fs.readFile(authorityPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-runtime-worker-view-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
  assert.equal(store.findOwnership(sessionId), undefined);
  const incarnationId = 'runtime-worker-incarnation'; const ownership = store.beginGeneration(sessionId, incarnationId);
  store.registerCandidate(sessionId, ownership.generation, incarnationId, process.pid, 'runtime-worker-process');
  store.activateCandidate(sessionId, ownership.generation, incarnationId, process.pid, 'runtime-worker-process');
  const registry = new SessionWorkerProjectionRegistry();
  const identity = { sessionId, generation: ownership.generation, incarnationId };
  const ingress = {
    ensureWorkerOwner: async () => ({ sessionId, generation: identity.generation, incarnationId: identity.incarnationId }),
  } as any;
  const services = new RpcServiceRegistry();
  services.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler({ worker: { store, registry, ingress } }));
  const transport = new LocalRpcTransport(services); const client = new RpcClient(sessionRuntimeServiceDescriptor, transport);
  const events: string[] = []; const unsubscribe = client.subscribe(name => { events.push(name); });
  try {
    await client.call('startEvents', {});
    const originalGetExistingSession = sessionManager.getExistingSession;
    let semanticLoads = 0;
    (sessionManager as any).getExistingSession = async (...args: any[]) => {
      semanticLoads += 1; return originalGetExistingSession(...args as [string]);
    };
    try {
      await assert.rejects(() => client.call('getSession', { sessionId: alias }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
      await assert.rejects(() => client.call('getHistory', { sessionId: alias }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
      const catalogOnly = (await client.call('listSessions', {})).sessions.find(item => item.id === sessionId)!;
      assert.equal(catalogOnly.busy, false); assert.equal(semanticLoads, 0);
    } finally {
      (sessionManager as any).getExistingSession = originalGetExistingSession;
    }

    registry.establish(identity);
    const projection = buildSessionWorkerProjection(worker);
    await registry.apply(identity, projection); await flushEvents();
    assert.deepEqual(events, ['stateChanged', 'listChanged']); events.length = 0;
    const originalListFenced = store.listFencedOwnerships.bind(store); let ownershipBatchReads = 0;
    (store as any).listFencedOwnerships = () => { ownershipBatchReads += 1; return originalListFenced(); };
    const projectionBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(ownershipBatchReads, 1, 'one batched ownership read covers the volatile projection union');
    assert.equal(projectionBatch.sessions.find(item => item.id === sessionId)?.lastMessageTime, 123);
    assert.equal(projectionBatch.sessions.find(item => item.id === sessionId)?.model, 'worker/model');
    (store as any).listFencedOwnerships = originalListFenced;
    await registry.apply(identity, projection); await flushEvents();
    assert.deepEqual(events, ['stateChanged']);
    const identicalBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(identicalBatch.revision, projectionBatch.revision, 'byte-identical publication does not reset list cursors'); events.length = 0;
    const mailboxOnlyProjection = { ...projection, lastAppliedMailboxId: projection.lastAppliedMailboxId + 1 };
    await registry.apply(identity, mailboxOnlyProjection); await flushEvents();
    assert.deepEqual(events, ['stateChanged']);
    const mailboxOnlyBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(mailboxOnlyBatch.revision, projectionBatch.revision, 'non-list publication fields do not reset list cursors'); events.length = 0;
    const listChangedProjection = { ...mailboxOnlyProjection, messageCount: mailboxOnlyProjection.messageCount + 1 };
    await registry.apply(identity, listChangedProjection); await flushEvents();
    assert.deepEqual(events, ['stateChanged','listChanged']);
    const changedBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.notEqual(changedBatch.revision, projectionBatch.revision, 'real list-visible publication changes reset cursors'); events.length = 0;
    stub.busy = true; await sessionManager.saveSessionCatalogEntries([sessionId]);
    const { busyStartedAt: _busyStartedAt, ...idleWorkerBase } = listChangedProjection;
    const idleWorkerProjection: SessionWorkerProjection = { ...idleWorkerBase, busy: false, busyStartedAt: null,
      runtimeState: { state: 'idle' as const, queueLength: idleWorkerBase.queueLength, busy: false } };
    await registry.apply(identity, idleWorkerProjection); await flushEvents(); events.length = 0;
    const currentIdle = await client.call('getSessionListProjections', { sessionIds: [sessionId], currentOwnersOnly: true });
    assert.equal(currentIdle.sessions[0]?.busy, false, 'current idle Worker projection overrides stale catalog busy');
    await registry.apply(identity, listChangedProjection); await flushEvents(); events.length = 0;
    stub.busy = false; await sessionManager.saveSessionCatalogEntries([sessionId]);

    const originalForgedLoader = sessionManager.getExistingSession; let forgedLoads = 0;
    (sessionManager as any).getExistingSession = async (...args: any[]) => {
      forgedLoads += 1; return originalForgedLoader(...args as [string]);
    };
    stub.aliases = []; await sessionManager.saveSessionCatalogEntries([sessionId]); sessionManager.updateAliasCache([alias], sessionId);
    try {
      assert.equal((await client.call('getSession', { sessionId: alias })).session, null);
      await assert.rejects(() => client.call('getHistory', { sessionId: alias }), { code: 'SESSION_NOT_FOUND' });
      assert.equal(forgedLoads, 0);
    } finally {
      stub.aliases = [alias]; await sessionManager.saveSessionCatalogEntries([sessionId]); (sessionManager as any).getExistingSession = originalForgedLoader;
    }

    const projected = (await client.call('getSession', { sessionId: alias })).session!;
    assert.equal(projected.id, sessionId); assert.deepEqual(projected.aliases, [alias]);
    assert.equal(projected.busy, true); assert.equal(projected.currentNode, 'worker-node');
    assert.equal(projected.displayName, 'Catalog name'); assert.equal(projected.pinned, true); assert.equal(projected.sidebarOrder, 7);
    projected.runtimeState.queueLength = 999; projected.tokenUsage.inputTokens = 999;
    assert.equal((await client.call('getSession', { sessionId })).session!.runtimeState.queueLength, 3);
    assert.equal((await client.call('getSession', { sessionId })).session!.tokenUsage.inputTokens, 2);
    const listed = (await client.call('listSessions', {})).sessions.find(item => item.id === sessionId)!;
    assert.equal(listed.model, 'worker/model');
    assert.equal(listed.queueLength, 3); assert.equal(listed.runtimeState.queueLength, 3); assert.notEqual(listed.runtimeState.state, 'idle');
    assert.equal(listed.runtimeState.waiting?.waitingFor, 'exec'); assert.deepEqual(listed.runtimeState.waiting?.waitExecIds, ['worker-exec']);
    const history = await client.call('getHistory', { sessionId: alias });
    assert.equal(history!.session.id, sessionId); assert.deepEqual(history!.session.aliases, [alias]);
    assert.equal(history!.messages[0].parts[0].text, 'authoritative worker history');
    assert.equal(history!.messages[0].__meta?.seq, 1);
    assert.deepEqual(history!.messages[0].__meta?.contextFrontierItem, { kind: 'message', seq: 1 });
    assert.equal(history!.queue[0].parts![0].text, 'authoritative worker queue 1');
    assert.equal(history!.persistentMemorySnapshot, 'worker prompt');
    history!.messages[0].parts[0].text = 'caller mutation'; history!.queue[0].parts![0].text = 'caller queue mutation';
    assert.equal((await client.call('getHistory', { sessionId }))!.messages[0].parts[0].text, 'authoritative worker history');
    assert.deepEqual(await fs.readFile(authorityPath), authorityBefore);
    assert.equal(JSON.stringify(sessionCatalogStore.get(sessionId)), catalogBefore);

    const { claimId } = await sessionManager.claimSessionsForDestructiveLifecycle([sessionId]);
    try {
      await assert.rejects(
        () => client.call('submitAndRun', { sessionId: alias, item: { type: 'user', parts: [{ text: 'late claimed ingress' }] } }),
        (error: any) => error?.code === 'SESSION_DELETE_IN_PROGRESS' && error?.retryable === true,
      );
    } finally {
      sessionManager.releaseSessionsForDestructiveLifecycle(claimId);
    }

    const mismatchRegistry = new SessionWorkerProjectionRegistry();
    mismatchRegistry.establish({ sessionId, generation: identity.generation + 1, incarnationId: 'mismatched-incarnation' });
    const mismatchServices = new RpcServiceRegistry();
    mismatchServices.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler({ worker: { store, registry: mismatchRegistry, ingress } }));
    const mismatchTransport = new LocalRpcTransport(mismatchServices);
    const mismatchClient = new RpcClient(sessionRuntimeServiceDescriptor, mismatchTransport);
    const originalMismatchLoader = sessionManager.getExistingSession; let mismatchLoads = 0;
    (sessionManager as any).getExistingSession = async (...args: any[]) => {
      mismatchLoads += 1; return originalMismatchLoader(...args as [string]);
    };
    try {
      await assert.rejects(() => mismatchClient.call('getSession', { sessionId: alias }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
      await assert.rejects(() => mismatchClient.call('getHistory', { sessionId: alias }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
      assert.equal(mismatchLoads, 0);
    } finally { (sessionManager as any).getExistingSession = originalMismatchLoader; mismatchTransport.close(); }
    assert.deepEqual(await fs.readFile(authorityPath), authorityBefore);
    assert.equal(JSON.stringify(sessionCatalogStore.get(sessionId)), catalogBefore);

    await fs.remove(authorityPath);
    await assert.rejects(() => client.call('getHistory', { sessionId }), { code: 'SESSION_WORKER_HISTORY_UNAVAILABLE' });
    assert.equal(await fs.pathExists(authorityPath), false);
    await fs.writeFile(authorityPath, '{malformed worker authority');
    const malformed = await fs.readFile(authorityPath);
    await assert.rejects(() => client.call('getHistory', { sessionId }), { code: 'SESSION_WORKER_HISTORY_UNAVAILABLE' });
    assert.deepEqual(await fs.readFile(authorityPath), malformed);
    await fs.writeFile(authorityPath, authorityBefore);

    events.length = 0;
    const beforeLiveClear = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(registry.clear(identity), true); await flushEvents();
    assert.deepEqual(events, ['stateChanged','listChanged'], 'clear of a live effective overlay invalidates exactly once'); events.length = 0;
    const liveCleared = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.notEqual(liveCleared.revision, beforeLiveClear.revision); assert.equal(liveCleared.sessions.some(item => item.id === sessionId), false);
    registry.establish(identity); await flushEvents();
    assert.deepEqual(events, [], 'establish without a visible projection is presentation-stable');
    assert.equal((await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true })).revision, liveCleared.revision);
    await registry.apply(identity, listChangedProjection); await flushEvents(); events.length = 0;
    const beforeStale = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(registry.markStale(identity), true); await flushEvents();
    assert.deepEqual(events, ['stateChanged','listChanged'], 'live-to-stale invalidates bounded lists exactly once'); events.length = 0;
    const staleBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.notEqual(staleBatch.revision, beforeStale.revision); assert.equal(staleBatch.sessions.some(item => item.id === sessionId), false);
    const staleCurrentOnly = await client.call('getSessionListProjections', { sessionIds: [sessionId], currentOwnersOnly: true });
    assert.equal(staleCurrentOnly.sessions.some(item => item.id === sessionId), false, 'stale Worker projection cannot revive catalog busy');
    await assert.rejects(() => client.call('getSession', { sessionId }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
    assert.equal(registry.clear(identity), true); await flushEvents();
    assert.deepEqual(events, [], 'clear after already-stale is presentation-stable');
    const clearedBatch = await client.call('getSessionListProjections', { sessionIds: [], includeVolatile: true });
    assert.equal(clearedBatch.revision, staleBatch.revision); assert.equal(clearedBatch.sessions.some(item => item.id === sessionId), false);

    store.markDraining(sessionId, identity.generation, identity.incarnationId);
    store.markExitObserved(sessionId, identity.generation, identity.incarnationId, 'released');
    stub.busy = false;
    await writeAuthoritativeSessionState({
      ...stub, busy: false, currentNode: 'master',
      history: [{ role: 'user', parts: [{ text: 'later local authority' }], __meta: { seq: 1, timestamp: 456 } }],
      queue: [], contextFrontier: [{ kind: 'message', seq: 1 }], meta: { lastMessageTime: 456, messageCount: 1 },
    } as Session);
    assert.equal(stub.busy, false);
    const localAgain = (await client.call('getSession', { sessionId })).session!;
    assert.equal(localAgain.busy, false); assert.equal(localAgain.currentNode, 'master');
    // This isolated seam supplies only a no-op ingress fixture. Production
    // history reads ensure/spawn the exact owner before returning authority;
    // without that owner transition this fixture must fail closed.
    await assert.rejects(() => client.call('getHistory', { sessionId }), { code: 'SESSION_WORKER_STATE_UNAVAILABLE' });
    await client.call('stopEvents', {});
  } finally {
    unsubscribe(); transport.close(); store.close(); await fs.remove(root);
    await fs.writeFile(authorityPath, authorityBefore).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => {});
    sessionManager.setOnHistoryUpdated(() => {}); sessionManager.setOnSessionEventUpdated(() => {});
    sessionManager.setOnSessionListUpdated(() => {}); sessionManager.setOnSessionStateUpdated(() => {});
    (vector as any).scheduleSessionArchiveIndex = originalScheduleIndex;
  }
});

test('SessionRuntime facade starts event publication and drains locally', async () => {
  await initializeSessionRuntime();
  const unsubscribe = subscribe(() => {});
  try {
    await startEvents();
    assert.deepEqual(getSessionRuntimeStatus(), {
      placement: 'local',
      ready: true,
      eventsStarted: true,
    });
  } finally {
    unsubscribe();
    await shutdownSessionRuntime();
  }
  assert.deepEqual(getSessionRuntimeStatus(), {
    placement: 'local',
    ready: false,
    eventsStarted: false,
  });
});

test('SessionRuntime list pagination is catalog-indexed and returns a stable total', async () => {
  await sessionManager.loadSessions();
  const ids = [makeSessionId('runtime_page_a'), makeSessionId('runtime_page_b'), makeSessionId('runtime_page_c')];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const { session } = await sessionManager.createEmptySession(ids[index]);
      session.meta = { ...(session.meta || {}), lastMessageTime: Number.MAX_SAFE_INTEGER - index, messageCount: index };
      if (index === 0) {
        session.promptCacheKey = 'normal-save-cache-key'; session.lastAppliedMailboxId = 8;
        session.goalState = { goal: 'normal body', remindEvery: 5, anchorSeq: 0, updatedAt: 1 };
        session.systemPromptFiles = ['MEMORY.md']; session.indexingState = { inProgress: true, startedAt: 1 } as any;
        session.contextFrontier = []; (session.meta as any).managedSession = { pendingInbox: [] };
        (session.meta as any).wait = {
          id: 'normal-save-wait', startedAt: 1, waitExecIds: ['exec-a'],
          waitAll: {
            sessions: ['child-a'], satisfiedSessions: [],
            deferredQueue: [{ type: 'background', parts: [{ text: 'never project this body' }] }],
          },
        };
      }
      await sessionManager.saveSession(ids[index]);
      const catalogProjection = sessionCatalogStore.get(ids[index]);
      assert.equal(Object.prototype.hasOwnProperty.call(catalogProjection, 'queue'), false);
      assert.equal(catalogProjection?.queueLength, 0);
      if (index === 0) {
        const rawDb = new DatabaseSync(sessionCatalogStore.filePath, { readOnly: true });
        const raw = JSON.parse((rawDb.prepare('SELECT metadata_json FROM session_catalog WHERE session_id=?').get(ids[index]) as any).metadata_json);
        rawDb.close();
        for (const field of ['queue', 'history', 'contextFrontier', 'promptCacheKey', 'lastAppliedMailboxId', 'goalState', 'systemPromptFiles', 'indexingState']) {
          assert.equal(Object.prototype.hasOwnProperty.call(raw, field), false, `${field} leaked from normal save`);
        }
        assert.equal(Object.prototype.hasOwnProperty.call(raw.meta || {}, 'managedSession'), false);
        assert.deepEqual(raw.meta.wait, {
          id: 'normal-save-wait', startedAt: 1, waitExecIds: ['exec-a'], waitAll: { sessions: ['child-a'] },
        });
      }
    }
    const { client, transport } = createLocalClient();
    try {
      const page = await client.call('listSessions', { limit: 2, offset: 1 });
      assert.ok(page.total >= 3);
      assert.deepEqual(page.sessions.map(session => session.id), [ids[1], ids[2]]);
    } finally { transport.close(); }
  } finally {
    for (const id of ids) await sessionManager.deleteSession(id).catch(() => {});
  }
});
