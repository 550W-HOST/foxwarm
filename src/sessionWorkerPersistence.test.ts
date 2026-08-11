import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSessionSemanticState, serializeSessionHistoryPayload, SESSION_STATE_FORMAT_VERSION } from './session/metadataStore';
import { buildSessionWorkerProjection, SessionWorkerPersistence } from './sessionWorkerPersistence';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
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

async function withStore(
  run: (store: SessionWorkerStore, root: string) => Promise<void>,
  options: ConstructorParameters<typeof SessionWorkerStore>[1] = {},
) {
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

test('canonical bounded pending-prefix apply persists JSON before ack and leaves concurrent enqueue pending', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const first = store.enqueueIntent('s', 'a', 'enqueue', { text: 'a' });
    store.enqueueIntent('other', 'gap', 'enqueue', { text: 'other' });
    const second = store.enqueueIntent('s', 'b', 'enqueue', { text: 'b' });
    let durable: Record<string, any> | undefined;
    let laterId = 0;
    const persistence = new SessionWorkerPersistence(store, {
      writeState: async current => {
        assert.equal(store.getOwnership('s').mailboxCursor, 0);
        durable = structuredClone(serializeSessionHistoryPayload(current));
        laterId = store.enqueueIntent('s', 'later', 'enqueue', { text: 'later' }).id;
      },
    });
    const current = session('s');
    let callbackRows: Array<{ id: number; intentId: string; payload: unknown }> = [];
    const projection = await persistence.applyAndPersistPendingPrefix(
      current, owner.generation, owner.incarnationId, 2,
      (target, intents) => {
        callbackRows = structuredClone(intents);
        appendIntentMessages(target, intents);
      },
    );
    assert.deepEqual(callbackRows.map(row => ({ id: row.id, intentId: row.intentId, payload: row.payload })), [
      { id: first.id, intentId: 'a', payload: { text: 'a' } },
      { id: second.id, intentId: 'b', payload: { text: 'b' } },
    ]);
    assert.equal(durable?.lastAppliedMailboxId, second.id);
    assert.equal(durable?.history.length, 2);
    assert.equal(store.getOwnership('s').mailboxCursor, second.id);
    assert.deepEqual(store.listPendingIntents('s').map(item => item.id), [laterId]);
    assert.equal(projection.lastAppliedMailboxId, second.id);
    assert.equal(store.deleteAppliedMailboxThrough('s', second.id), 2);
  });
});

test('activated turn persistence verifies ownership and writes no mailbox acknowledgement', async () => {
  await withStore(async store => {
    const owner = activate(store, 'turn-save');
    const current = session('turn-save');
    current.history.push({ role: 'model', parts: [{ text: 'committed turn' }] });
    let durable: Session | undefined;
    const persistence = new SessionWorkerPersistence(store, {
      writeState: async value => { durable = structuredClone(value); },
    });
    const projection = await persistence.persistActivated(current, owner.generation, owner.incarnationId);
    assert.equal(durable?.history.length, 1);
    assert.equal(projection.messageCount, 1);
    assert.equal(store.getOwnership('turn-save').mailboxCursor, 0);
    await assert.rejects(
      () => persistence.persistActivated(current, owner.generation + 1, owner.incarnationId),
      (error: any) => error?.code === 'SESSION_WORKER_STALE_GENERATION',
    );
  });
});

test('pending-prefix limit is bounded and an empty prefix is a no-op projection', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const persistence = new SessionWorkerPersistence(store);
    for (const limit of [0, -1, 1.5, 4097, Number.NaN]) {
      await assert.rejects(() => persistence.applyAndPersistPendingPrefix(
        session('s'), owner.generation, owner.incarnationId, limit, appendIntentMessages,
      ), (error: any) => error?.code === 'SESSION_WORKER_MAILBOX_LIMIT');
    }
    const projection = await persistence.applyAndPersistPendingPrefix(
      session('s'), owner.generation, owner.incarnationId, 1, appendIntentMessages,
    );
    assert.equal(projection.lastAppliedMailboxId, 0);
  });
});

test('authoritative JSON write failure restores exact semantic state and leaves mailbox unacknowledged', async () => {
  await withStore(async store => {
    const owner = activate(store, 'rollback');
    const intent = store.enqueueIntent('rollback', 'intent', 'enqueue', { text: 'canonical' });
    const current = session('rollback');
    current.model = 'before'; current.cwd = '/before'; current.stopping = true;
    current.history = [{ role: 'user', parts: [{ inlineData: { data: 'before-image', mimeType: 'image/png' } }] }];
    current.queue = [{ type: 'background', parts: [{ text: 'before-queue' }] }];
    current.meta.wait = { id: 'before-wait' };
    current.meta.managedSession = { ownerSessionId: 'owner', leaseId: 'before-lease', revision: 1,
      pendingInbox: [{ type: 'background', parts: [{ text: 'before-managed' }] }] };
    current.contextFrontier = [{ kind: 'message', seq: 1 }];
    const before = captureSessionSemanticState(current);
    const persistence = new SessionWorkerPersistence(store, { writeState: async () => { throw new Error('replace failed'); } });
    await assert.rejects(() => persistence.applyAndPersistPendingPrefix(
      current, owner.generation, owner.incarnationId, 1,
      target => {
        delete target.model; delete target.stopping;
        target.cwd = '/after'; target.childModelDefault = 'added';
        target.history = [{ role: 'model', parts: [{ text: 'after' }] }];
        target.queue = [];
        target.meta.wait = { id: 'after-wait' };
        target.meta.managedSession = { ownerSessionId: 'owner', leaseId: 'after-lease', revision: 2, pendingInbox: [] };
        target.contextFrontier = [{ kind: 'block', id: 2, level: 1, rawStartSeq: 1, rawEndSeq: 2 }];
      },
    ), /replace failed/);
    assert.deepEqual(captureSessionSemanticState(current), before);
    assert.equal(Object.prototype.hasOwnProperty.call(current, 'childModelDefault'), false);
    assert.equal(store.getOwnership('rollback').mailboxCursor, 0);
    assert.deepEqual(store.listPendingIntents('rollback').map(row => row.id), [intent.id]);
  });
});

test('crash after JSON replacement but before SQLite ack reconciles without duplicate application', async () => {
  let failAck = true;
  await withStore(async store => {
    const owner = activate(store, 's');
    store.enqueueIntent('s', 'a', 'enqueue', { text: 'once' });
    store.enqueueIntent('other', 'global-gap', 'enqueue', { text: 'other' });
    const second = store.enqueueIntent('s', 'b', 'enqueue', { text: 'twice' });
    let applyCount = 0;
    let durable = serializeSessionHistoryPayload(session('s'));
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async current => { durable = structuredClone(serializeSessionHistoryPayload(current)); },
    });
    await assert.rejects(() => persistence.applyAndPersistPendingPrefix(
      session('s'), owner.generation, owner.incarnationId, 2,
      (current, intents) => { applyCount += 1; appendIntentMessages(current, intents); },
    ), (error: any) => error?.code === 'SESSION_WORKER_ACK_AFTER_STATE_FAILED' && error?.details?.stateCommitted === true);
    assert.equal(durable.lastAppliedMailboxId, second.id);
    assert.equal(store.getOwnership('s').mailboxCursor, 0);

    failAck = false;
    const recovered = await persistence.loadActivated(session('s'), owner.generation, owner.incarnationId);
    assert.deepEqual(recovered.history.map(message => message.parts[0].text), ['once', 'twice']);
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
    await assert.rejects(() => persistence.loadActivated(session('s'), firstOwner.generation, firstOwner.incarnationId),
      (error: any) => error?.code === 'SESSION_WORKER_CURSOR_AHEAD');
    assert.equal(writes, 0);

    store.markDraining('s', firstOwner.generation, firstOwner.incarnationId);
    store.markExitObserved('s', firstOwner.generation, firstOwner.incarnationId, 'test');
    const secondOwner = activate(store, 's', 'inc-2');
    await assert.rejects(() => persistence.applyAndPersistPendingPrefix(
      session('s'), firstOwner.generation, firstOwner.incarnationId, 1, appendIntentMessages,
    ), (error: any) => error?.code === 'SESSION_WORKER_STALE_GENERATION');
    assert.equal(store.getOwnership('s').generation, secondOwner.generation);
    assert.equal(writes, 0);
  });
});

test('unversioned state seeds historical catalog-only fields once while file values win', async () => {
  await withStore(async store => {
    const owner = activate(store, 'legacy');
    const base = session('legacy');
    base.stats.totalInputTokens = 77;
    base.vectorIndexPosition = 12;
    base.meta = { lastMessageTime: 90, lastChannel: { channelId: 'web', channelUserId: 'u' },
      wait: { id: 'catalog-wait' }, managedSession: { ownerSessionId: 'owner', leaseId: 'lease', revision: 1, pendingInbox: [] } };
    base.model = 'catalog-stale';
    const legacyRaw: any = { history: [{ role: 'user', parts: [{ text: 'legacy' }] }],
      persistentMemorySnapshot: 'legacy-prompt', model: 'file-wins', queue: [{ type: 'background', parts: [{ text: 'queued' }] }] };
    let durable: any;
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(legacyRaw),
      writeState: async current => { durable = structuredClone(serializeSessionHistoryPayload(current)); },
    });
    const loaded = await persistence.loadActivated(base, owner.generation, owner.incarnationId);
    assert.equal(loaded.model, 'file-wins');
    assert.equal(loaded.stats.totalInputTokens, 77);
    assert.equal(loaded.vectorIndexPosition, 12);
    assert.equal(loaded.meta.wait.id, 'catalog-wait');
    assert.equal(loaded.meta.lastChannel.channelId, 'web');
    assert.equal(durable.sessionStateVersion, SESSION_STATE_FORMAT_VERSION);
    assert.equal(durable.meta.lastChannel, undefined);
  });
});

test('current state replaces stale semantic stub fields while preserving catalog-only fields', async () => {
  await withStore(async store => {
    const owner = activate(store, 'current');
    const base = session('current');
    base.queue = [{ type: 'trigger', parts: [{ text: 'stale' }] }];
    base.model = 'stale-model'; base.childModelDefault = 'stale-child'; base.vectorIndexPosition = 99;
    base.contextFrontier = [{ kind: 'message', seq: 99 }];
    base.meta = { lastMessageTime: 99, wait: { id: 'stale' }, managedSession: { pendingInbox: ['stale'] },
      lastChannel: { channelId: 'telegram', channelUserId: 'u' } };
    base.pinned = true; base.sidebarOrder = 3; base.archived = true;
    const broadcast = (() => {}) as any; base.broadcast = broadcast;
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => ({ sessionStateVersion: SESSION_STATE_FORMAT_VERSION, history: [], persistentMemorySnapshot: '' }),
    });
    const loaded = await persistence.loadActivated(base, owner.generation, owner.incarnationId);
    assert.deepEqual(loaded.queue, []);
    assert.equal(loaded.model, undefined); assert.equal(loaded.childModelDefault, undefined);
    assert.equal(loaded.vectorIndexPosition, undefined); assert.equal(loaded.contextFrontier, undefined);
    assert.equal(loaded.meta.wait, undefined); assert.equal(loaded.meta.managedSession, undefined);
    assert.equal(loaded.meta.lastChannel.channelId, 'telegram');
    assert.equal(loaded.pinned, true); assert.equal(loaded.sidebarOrder, 3); assert.equal(loaded.archived, true);
    assert.equal(loaded.broadcast, broadcast);
  });
});

test('bounded projection remains a pure cloned DTO with no catalog writer protocol', () => {
  const current = session('projection');
  current.history = [{ role: 'user', parts: [{ text: 'secret' }] }];
  current.queue = [{ type: 'trigger', parts: [{ text: 'secret queue' }] }];
  const projection = buildSessionWorkerProjection(current);
  assert.equal(projection.messageCount, 1);
  assert.equal(projection.queueLength, 1);
  assert.equal(projection.runtimeState.state, 'idle');
  assert.equal(projection.runtimeState.busy, false);
  assert.equal(projection.runtimeState.queueLength, 1);
  assert.equal('history' in projection, false);
  assert.equal('queue' in projection, false);
  projection.stats.totalInputTokens = 999;
  assert.equal(current.stats.totalInputTokens, 2);
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
    assert.equal(result.historyRef, true); assert.equal(result.queueRef, true); assert.equal(result.managedRef, true);
    assert.equal(result.cursor, 9); assert.equal(result.stateVersion, SESSION_STATE_FORMAT_VERSION);
    assert.deepEqual(result.frontier, [{ kind: 'message', seq: 1 }]);
    assert.equal(result.promptCacheKey, 'cache'); assert.equal(result.catalogExists, false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.remove(root);
  }
});
