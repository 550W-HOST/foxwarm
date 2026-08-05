import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RpcError } from './rpc';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { mergeSessionWorkerCatalogProjection, writeSessionWorkerCatalogProjection } from './sessionWorkerCatalog';
import { buildSessionWorkerCatalogProjection, SessionWorkerPersistence } from './sessionWorkerPersistence';
import { SessionWorkerStore } from './sessionWorkerStore';
import type { Session } from './types';

function session(id: string): Session {
  return {
    id,
    agent: 'agent',
    history: [],
    persistentMemorySnapshot: 'prompt snapshot',
    promptCacheKey: 'cache-key',
    stats: { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: 10 },
    currentNode: 'master',
    lastAppliedMailboxId: 0,
  };
}

function activate(store: SessionWorkerStore, sessionId: string, incarnationId = 'inc') {
  const generation = store.beginGeneration(sessionId, incarnationId).generation;
  const identity = readSessionWorkerProcessIdentity(process.pid)!;
  store.registerCandidate(sessionId, generation, incarnationId, process.pid, identity);
  store.activateCandidate(sessionId, generation, incarnationId, process.pid, identity);
  return { generation, incarnationId };
}

async function withStore(run: (store: SessionWorkerStore, root: string) => Promise<void>, options: ConstructorParameters<typeof SessionWorkerStore>[1] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-persistence-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite'), options); store.open();
  try { await run(store, root); } finally { store.close(); await fs.remove(root); }
}

function appendIntentMessages(target: Session, intents: Array<{ id: number; payload: unknown }>): void {
  for (const intent of intents) {
    target.history.push({ role: 'user', parts: [{ text: String((intent.payload as any).text) }], __meta: { seq: intent.id, timestamp: intent.id } });
  }
  target.meta.lastMessageTime = intents[intents.length - 1].id;
}

test('save-before-ack accepts a session-local prefix across global ID gaps and leaves concurrent enqueue pending', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const first = store.enqueueIntent('s', 'a', 'enqueue', { text: 'a' });
    store.enqueueIntent('other', 'gap', 'enqueue', { text: 'other' });
    const second = store.enqueueIntent('s', 'b', 'enqueue', { text: 'b' });
    let durable: Record<string, any> | undefined;
    let laterId = 0;
    let projectionWrites = 0;
    const persistence = new SessionWorkerPersistence(store, {
      writeState: async current => {
        assert.equal(store.getOwnership('s').mailboxCursor, 0, 'SQLite ack must be after authoritative JSON write');
        durable = structuredClone(serializeSessionHistoryPayload(current));
        laterId = store.enqueueIntent('s', 'later', 'enqueue', { text: 'later' }).id;
      },
      writeCatalogProjection: async projection => {
        projectionWrites += 1;
        assert.equal('history' in projection, false);
        assert.equal('queue' in projection, false);
      },
    });
    const current = session('s');
    const prefix = store.listPendingIntents('s');
    assert.deepEqual(prefix.map(item => item.id), [first.id, second.id]);
    const projection = await persistence.applyAndPersistPrefix(current, owner.generation, owner.incarnationId, prefix, appendIntentMessages);
    assert.equal(durable?.lastAppliedMailboxId, second.id);
    assert.equal(durable?.history.length, 2);
    assert.equal(store.getOwnership('s').mailboxCursor, second.id);
    assert.deepEqual(store.listPendingIntents('s').map(item => item.id), [laterId]);
    assert.equal(projection.lastAppliedMailboxId, second.id);
    assert.equal(projectionWrites, 1);
    assert.equal(store.deleteAppliedMailboxThrough('s', second.id), 2);
    assert.deepEqual(store.listPendingIntents('s').map(item => item.id), [laterId]);
  });
});

test('authoritative JSON write failure leaves mailbox unacknowledged', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const intent = store.enqueueIntent('s', 'a', 'enqueue', { text: 'a' });
    const current = session('s');
    const persistence = new SessionWorkerPersistence(store, {
      writeState: async () => { throw new Error('injected atomic replacement failure'); },
    });
    await assert.rejects(() => persistence.applyAndPersistPrefix(
      current, owner.generation, owner.incarnationId, [intent], appendIntentMessages,
    ), /injected atomic replacement failure/);
    assert.equal(current.lastAppliedMailboxId, 0);
    assert.equal(current.history.length, 0);
    assert.equal(store.getOwnership('s').mailboxCursor, 0);
    assert.deepEqual(store.listPendingIntents('s').map(item => item.id), [intent.id]);
  });
});

test('crash after JSON replacement but before SQLite ack reconciles cursor without duplicate application', async () => {
  let failAck = true;
  await withStore(async store => {
    const owner = activate(store, 's');
    const intent = store.enqueueIntent('s', 'a', 'enqueue', { text: 'once' });
    store.enqueueIntent('other', 'global-gap', 'enqueue', { text: 'other' });
    const second = store.enqueueIntent('s', 'b', 'enqueue', { text: 'twice' });
    let applyCount = 0;
    let durable = serializeSessionHistoryPayload(session('s'));
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async current => { durable = structuredClone(serializeSessionHistoryPayload(current)); },
    });
    await assert.rejects(() => persistence.applyAndPersistPrefix(
      session('s'), owner.generation, owner.incarnationId, [intent, second], (current, intents) => {
        applyCount += 1; appendIntentMessages(current, intents);
      },
    ), (error: any) => error?.code === 'SESSION_WORKER_ACK_AFTER_STATE_FAILED'
      && error?.details?.stateCommitted === true
      && /injected ack failure/.test(error.message));
    assert.equal(durable.lastAppliedMailboxId, second.id);
    assert.equal(durable.history.length, 2);
    assert.equal(store.getOwnership('s').mailboxCursor, 0);

    failAck = false;
    const recovered = await persistence.loadActivated(session('s'), owner.generation, owner.incarnationId);
    assert.equal(recovered.history.length, 2);
    assert.equal(recovered.history[0].parts[0].text, 'once');
    assert.equal(recovered.history[1].parts[0].text, 'twice');
    assert.equal(store.getOwnership('s').mailboxCursor, second.id);
    assert.deepEqual(store.listPendingIntents('s'), []);
    assert.equal(applyCount, 1);
  }, { faultInjector(operation) { if (operation === 'ack' && failAck) throw new Error('injected ack failure'); } });
});

test('DB cursor ahead of JSON and stale generations fail closed before state writes', async () => {
  await withStore(async store => {
    const firstOwner = activate(store, 's', 'inc-1');
    const intent = store.enqueueIntent('s', 'a', 'enqueue', { text: 'a' });
    store.acknowledgeMailboxPrefix({ sessionId: 's', generation: firstOwner.generation, incarnationId: firstOwner.incarnationId,
      expectedCursor: 0, upToId: intent.id });
    let writes = 0;
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => serializeSessionHistoryPayload(session('s')),
      writeState: async () => { writes += 1; },
    });
    await assert.rejects(() => persistence.loadActivated(session('s'), firstOwner.generation, firstOwner.incarnationId), error => {
      assert.ok(error instanceof RpcError); assert.equal(error.code, 'SESSION_WORKER_CURSOR_AHEAD'); return true;
    });
    assert.equal(writes, 0);

    store.markDraining('s', firstOwner.generation, firstOwner.incarnationId);
    store.markExitObserved('s', firstOwner.generation, firstOwner.incarnationId, 'test');
    const secondOwner = activate(store, 's', 'inc-2');
    await assert.rejects(() => persistence.applyAndPersistPrefix(
      session('s'), firstOwner.generation, firstOwner.incarnationId, [], appendIntentMessages,
    ), error => {
      assert.ok(error instanceof RpcError); assert.equal(error.code, 'SESSION_WORKER_STALE_GENERATION'); return true;
    });
    assert.equal(store.getOwnership('s').generation, secondOwner.generation);
    assert.equal(writes, 0);
  });
});

test('quiesce/reload reconciles lagging ack and main mutation writes state plus bounded catalog projection', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const intent = store.enqueueIntent('s', 'a', 'enqueue', { text: 'already durable' });
    const durableSession = session('s');
    appendIntentMessages(durableSession, [intent]);
    durableSession.lastAppliedMailboxId = intent.id;
    durableSession.queue = [{ type: 'background', parts: [{ text: 'queued' }] }];
    durableSession.meta.wait = { id: 'wait-1', startedAt: 1 };
    durableSession.meta.managedSession = { ownerSessionId: 'owner', leaseId: 'lease', revision: 1,
      pendingInbox: [{ type: 'background', parts: [{ text: 'managed' }] }], openedAt: 1, leaseTouchedAt: 1 };
    durableSession.contextFrontier = [{ kind: 'message', seq: intent.id }];
    let durable = structuredClone(serializeSessionHistoryPayload(durableSession));
    const projections: unknown[] = [];
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async current => { durable = structuredClone(serializeSessionHistoryPayload(current)); },
      writeCatalogProjection: async projection => { projections.push(structuredClone(projection)); },
    });
    const reloaded = await persistence.quiesceAndReload(session('s'), async () => {
      store.markDraining('s', owner.generation, owner.incarnationId);
      store.markExitObserved('s', owner.generation, owner.incarnationId, 'quiesced');
    });
    assert.equal(store.getOwnership('s').mailboxCursor, intent.id);
    assert.equal(reloaded.queue.length, 1);
    assert.equal(reloaded.meta.wait.id, 'wait-1');
    assert.equal(reloaded.meta.managedSession.pendingInbox.length, 1);
    assert.deepEqual(reloaded.contextFrontier, [{ kind: 'message', seq: intent.id }]);
    reloaded.history.push({ role: 'model', parts: [{ text: 'main mutation' }], __meta: { seq: intent.id + 1, timestamp: 20 } });
    const projection = await persistence.saveMainMutation(reloaded);
    assert.equal(durable.history.length, 2);
    assert.equal(projections.length, 1);
    assert.equal((projections[0] as any).queue, undefined);
    assert.equal(projection.queueLength, 1);
  });
});

test('catalog projection is cloned and bounded', () => {
  const current = session('projection');
  current.history = [{ role: 'user', parts: [{ text: 'secret' }] }];
  current.queue = [{ type: 'trigger', parts: [{ text: 'secret queue' }] }];
  const projection = buildSessionWorkerCatalogProjection(current);
  assert.equal(projection.messageCount, 1);
  assert.equal(projection.queueLength, 1);
  assert.equal('history' in projection, false);
  assert.equal('queue' in projection, false);
  projection.stats.totalInputTokens = 999;
  assert.equal(current.stats.totalInputTokens, 2);
});

test('main catalog failure reports that authoritative state already committed', async () => {
  await withStore(async store => {
    let durable: any = structuredClone(serializeSessionHistoryPayload(session('s')));
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async current => { durable = structuredClone(current); },
      writeCatalogProjection: async () => { throw new Error('injected catalog failure'); },
    });
    const current = session('s');
    current.history.push({ role: 'user', parts: [{ text: 'committed' }] });
    await assert.rejects(() => persistence.saveMainMutation(current), (error: any) =>
      error?.code === 'SESSION_WORKER_CATALOG_AFTER_STATE_FAILED'
      && error?.details?.stateCommitted === true);
    assert.equal(durable.history[0].parts[0].text, 'committed');
  });
});

test('main catalog projection preserves topology/UI fields and removes stale full hot state', async () => {
  const projection = buildSessionWorkerCatalogProjection(session('catalog'));
  const existing = {
    id: 'catalog', agent: 'agent', parentSessionId: 'parent', displayName: 'Display', pinned: true, sidebarOrder: 4,
    queue: [{ type: 'trigger', parts: [{ text: 'stale' }] }],
    meta: { lastChannel: { channelId: 'web', channelUserId: 'u' }, wait: { id: 'stale' }, managedSession: { pendingInbox: ['stale'] } },
  };
  const merged = mergeSessionWorkerCatalogProjection(existing, projection);
  assert.equal(merged.parentSessionId, 'parent');
  assert.equal(merged.displayName, 'Display');
  assert.equal(merged.pinned, true);
  assert.equal(merged.sidebarOrder, 4);
  assert.equal('queue' in merged, false);
  assert.equal('wait' in merged.meta, false);
  assert.equal('managedSession' in merged.meta, false);
  assert.equal(merged.meta.lastChannel.channelId, 'web');

  let written: any;
  await writeSessionWorkerCatalogProjection(projection, {
    load: async () => ({ data: { sessions: { catalog: existing, other: { id: 'other', displayName: 'Keep' } } }, source: 'test' }),
    write: async data => { written = data; },
  });
  assert.equal(written.sessions.other.displayName, 'Keep');
  assert.equal(written.sessions.catalog.displayName, 'Display');
  assert.equal('queue' in written.sessions.catalog, false);

  let concurrentData: any = { sessions: { catalog: existing, other: { id: 'other', displayName: 'Keep', meta: {} } } };
  const otherProjection = { ...projection, sessionId: 'other', lastMessageTime: 99 };
  const dependencies = {
    load: async () => ({ data: structuredClone(concurrentData), source: 'test' }),
    write: async (data: any) => { concurrentData = structuredClone(data); },
  };
  await Promise.all([
    writeSessionWorkerCatalogProjection(projection, dependencies),
    writeSessionWorkerCatalogProjection(otherProjection, dependencies),
  ]);
  assert.equal(concurrentData.sessions.catalog.displayName, 'Display');
  assert.equal(concurrentData.sessions.other.displayName, 'Keep');
  assert.equal(concurrentData.sessions.other.meta.lastMessageTime, 99);
});

test('real state-file writer atomically canonicalizes history/queue/managed images without touching shared catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-state-file-'));
  const child = fork(path.join(__dirname, 'sessionWorkerStateFileChild.js'), [], {
    env: { ...process.env, FOXWARM_DATA_DIR: root }, serialization: 'advanced', silent: true,
  });
  try {
    const result = await new Promise<any>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', resolve);
      child.once('exit', code => { if (code && code !== 0) reject(new Error(`state-file child exited ${code}`)); });
    });
    assert.equal(result.historyRef, true);
    assert.equal(result.queueRef, true);
    assert.equal(result.managedRef, true);
    assert.equal(result.cursor, 9);
    assert.deepEqual(result.frontier, [{ kind: 'message', seq: 1 }]);
    assert.equal(result.promptCacheKey, 'cache');
    assert.equal(result.catalogExists, false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.remove(root);
  }
});
