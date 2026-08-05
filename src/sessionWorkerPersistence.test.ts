import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RpcError } from './rpc';
import { captureSessionSemanticState, serializeSessionHistoryPayload, SESSION_STATE_FORMAT_VERSION, stripSessionMetadataForSave, withSessionsMetadataWriteLock } from './session/metadataStore';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { mergeSessionWorkerCatalogProjection, SessionWorkerCatalogCoordinator, writeSessionWorkerCatalogProjection } from './sessionWorkerCatalog';
import { buildSessionWorkerCatalogProjection, SessionWorkerPersistence } from './sessionWorkerPersistence';
import { SessionWorkerStore, type SessionWorkerMailboxIntent } from './sessionWorkerStore';
import type { Session } from './types';
import type { SessionWorkerMainMutationClaim } from './sessionWorkerSupervisor';

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

function activeClaim(sessionId: string): SessionWorkerMainMutationClaim {
  const controller = new AbortController();
  return { id: `claim-${sessionId}`, sessionId, signal: controller.signal, assertActive: () => assert.equal(controller.signal.aborted, false) };
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
    const tamperedSelection = prefix.map(item => ({ ...item, intentId: 'tampered', kind: 'tampered', payload: { text: 'tampered' } }));
    let callbackIntents: SessionWorkerMailboxIntent[] = [];
    const projection = await persistence.applyAndPersistPrefix(current, owner.generation, owner.incarnationId, tamperedSelection, (target, intents) => {
      callbackIntents = structuredClone(intents);
      appendIntentMessages(target, intents);
    });
    assert.deepEqual(callbackIntents.map(item => ({ intentId: item.intentId, kind: item.kind, payload: item.payload })), [
      { intentId: 'a', kind: 'enqueue', payload: { text: 'a' } },
      { intentId: 'b', kind: 'enqueue', payload: { text: 'b' } },
    ]);
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

test('mailbox selection rejects ID, session, and order mismatches before callback or state write', async () => {
  await withStore(async store => {
    const owner = activate(store, 's');
    const first = store.enqueueIntent('s', 'a', 'enqueue', { text: 'a' });
    const second = store.enqueueIntent('s', 'b', 'enqueue', { text: 'b' });
    let callbacks = 0; let writes = 0;
    const persistence = new SessionWorkerPersistence(store, { writeState: async () => { writes += 1; } });
    const apply = () => { callbacks += 1; };
    await assert.rejects(() => persistence.applyAndPersistPrefix(session('s'), owner.generation, owner.incarnationId,
      [second, first], apply), (error: any) => error?.code === 'SESSION_WORKER_MAILBOX_CONFLICT');
    await assert.rejects(() => persistence.applyAndPersistPrefix(session('s'), owner.generation, owner.incarnationId,
      [{ ...first, sessionId: 'other' }], apply), (error: any) => error?.code === 'SESSION_WORKER_MAILBOX_CONFLICT');
    await assert.rejects(() => persistence.applyAndPersistPrefix(session('s'), owner.generation, owner.incarnationId,
      [{ ...first, id: first.id + 100 }], apply), (error: any) => error?.code === 'SESSION_WORKER_MAILBOX_CONFLICT');
    assert.equal(callbacks, 0); assert.equal(writes, 0);
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

test('unversioned state upgrades once by seeding historically catalog-only fields while file fields win', async () => {
  await withStore(async store => {
    const owner = activate(store, 'legacy');
    const base = session('legacy');
    base.stats.totalInputTokens = 77;
    base.vectorIndexPosition = 12;
    base.meta = {
      lastMessageTime: 90,
      lastChannel: { channelId: 'web', channelUserId: 'u' },
      wait: { id: 'catalog-wait' },
      managedSession: { ownerSessionId: 'owner', leaseId: 'lease', revision: 1, pendingInbox: [] },
    };
    base.model = 'catalog-stale';
    const legacyRaw: any = {
      history: [{ role: 'user', parts: [{ text: 'legacy' }] }],
      persistentMemorySnapshot: 'legacy-prompt',
      model: 'file-wins',
      queue: [{ type: 'background', parts: [{ text: 'queued' }] }],
    };
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
    assert.equal(durable.stats.totalInputTokens, 77);
    assert.equal(durable.meta.wait.id, 'catalog-wait');
    assert.equal(durable.meta.lastChannel, undefined);
  });
});

test('current state exactly replaces stale catalog semantics while preserving explicit catalog-only fields', async () => {
  await withStore(async store => {
    const owner = activate(store, 'current');
    const base = session('current');
    base.queue = [{ type: 'trigger', parts: [{ text: 'stale' }] }];
    base.model = 'stale-model';
    base.childModelDefault = 'stale-child';
    base.vectorIndexPosition = 99;
    base.contextFrontier = [{ kind: 'message', seq: 99 }];
    base.meta = { lastMessageTime: 99, wait: { id: 'stale' }, managedSession: { pendingInbox: ['stale'] },
      lastChannel: { channelId: 'telegram', channelUserId: 'u' } };
    base.pinned = true; base.sidebarOrder = 3; base.archived = true;
    const broadcast = (() => {}) as any; base.broadcast = broadcast;
    let writes = 0;
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => ({ sessionStateVersion: SESSION_STATE_FORMAT_VERSION, history: [], persistentMemorySnapshot: '' }),
      writeState: async () => { writes += 1; },
    });
    const loaded = await persistence.loadActivated(base, owner.generation, owner.incarnationId);
    assert.deepEqual(loaded.queue, []);
    assert.equal(loaded.model, undefined);
    assert.equal(loaded.childModelDefault, undefined);
    assert.equal(loaded.vectorIndexPosition, undefined);
    assert.equal(loaded.contextFrontier, undefined);
    assert.equal(loaded.meta.wait, undefined);
    assert.equal(loaded.meta.managedSession, undefined);
    assert.equal(loaded.meta.lastChannel.channelId, 'telegram');
    assert.equal(loaded.pinned, true); assert.equal(loaded.sidebarOrder, 3); assert.equal(loaded.archived, true);
    assert.equal(loaded.broadcast, broadcast);
    assert.equal(writes, 0);
  });
});

test('unknown or malformed current state fails closed before rewrite', async () => {
  await withStore(async store => {
    const owner = activate(store, 'invalid-state');
    let writes = 0;
    const invalidPayloads: Array<Record<string, any>> = [
      { sessionStateVersion: SESSION_STATE_FORMAT_VERSION + 1, history: [] },
      { sessionStateVersion: SESSION_STATE_FORMAT_VERSION, history: 'not-an-array' },
      { sessionStateVersion: SESSION_STATE_FORMAT_VERSION, history: [], lastAppliedMailboxId: -1 },
    ];
    for (const [index, raw] of invalidPayloads.entries()) {
      const persistence = new SessionWorkerPersistence(store, {
        readState: async () => structuredClone(raw), writeState: async () => { writes += 1; },
      });
      await assert.rejects(() => persistence.loadActivated(session('invalid-state'), owner.generation, owner.incarnationId),
        (error: any) => error?.code === (index === 0 ? 'SESSION_WORKER_STATE_VERSION' : 'SESSION_WORKER_STATE_INVALID'));
    }
    assert.equal(writes, 0);
  });
});

test('failed state replacement restores exact semantic property presence across optional and nested state', async () => {
  await withStore(async store => {
    const owner = activate(store, 'rollback');
    const intent = store.enqueueIntent('rollback', 'intent', 'enqueue', { text: 'canonical' });
    const current = session('rollback');
    current.model = 'before'; current.cwd = '/before'; current.stopping = true;
    current.history = [{ role: 'user', parts: [{ inlineData: { data: 'before-image', mimeType: 'image/png' } }] }];
    current.queue = [{ type: 'background', parts: [{ inlineData: { data: 'before-queue', mimeType: 'image/png' } }] }];
    current.meta.wait = { id: 'before-wait' };
    current.meta.lastChannel = { channelId: 'before-channel', channelUserId: 'u' };
    current.meta.managedSession = { ownerSessionId: 'owner', leaseId: 'before-lease', revision: 1,
      pendingInbox: [{ type: 'background', parts: [{ text: 'before-managed' }] }] };
    current.contextFrontier = [{ kind: 'message', seq: 1 }];
    const before = captureSessionSemanticState(current);
    const persistence = new SessionWorkerPersistence(store, { writeState: async () => { throw new Error('replace failed'); } });
    await assert.rejects(() => persistence.applyAndPersistPrefix(current, owner.generation, owner.incarnationId, [intent], target => {
      delete target.model; delete target.stopping;
      target.cwd = '/after'; target.childModelDefault = 'added';
      target.history = [{ role: 'model', parts: [{ inlineData: { data: 'after-image', mimeType: 'image/png' } }] }];
      target.queue = [];
      target.meta.wait = { id: 'after-wait' };
      target.meta.lastChannel = { channelId: 'after-channel', channelUserId: 'u' };
      target.meta.managedSession = { ownerSessionId: 'owner', leaseId: 'after-lease', revision: 2, pendingInbox: [] };
      target.contextFrontier = [{ kind: 'block', id: 2, level: 1, rawStartSeq: 1, rawEndSeq: 2 }];
    }), /replace failed/);
    assert.deepEqual(captureSessionSemanticState(current), before);
    assert.equal(Object.prototype.hasOwnProperty.call(current, 'childModelDefault'), false);
    assert.equal(store.getOwnership('rollback').mailboxCursor, 0);
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
    const coordinator = new SessionWorkerCatalogCoordinator();
    coordinator.registerWorker('s', 'owner-1', buildSessionWorkerCatalogProjection(durableSession));
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async current => { durable = structuredClone(serializeSessionHistoryPayload(current)); },
      writeCatalogProjection: async projection => { projections.push(structuredClone(projection)); },
      catalogCoordinator: coordinator,
      catalogOwnerId: 'owner-1',
    });
    const liveStub = session('s');
    liveStub.displayName = 'Old';
    liveStub.meta.lastChannel = { channelId: 'old', channelUserId: 'u' };
    const mutation = await persistence.runMainMutation(liveStub, async (_sessionId, operation) => {
      store.markDraining('s', owner.generation, owner.incarnationId);
      store.markExitObserved('s', owner.generation, owner.incarnationId, 'quiesced');
      return operation(activeClaim('s'));
    }, async reloaded => {
      assert.equal(reloaded.queue.length, 1);
      assert.equal(reloaded.meta.wait.id, 'wait-1');
      assert.equal(reloaded.meta.managedSession.pendingInbox.length, 1);
      assert.deepEqual(reloaded.contextFrontier, [{ kind: 'message', seq: intent.id }]);
      reloaded.history.push({ role: 'model', parts: [{ text: 'main mutation' }], __meta: { seq: intent.id + 1, timestamp: 20 } });
      reloaded.displayName = 'New';
      reloaded.meta.lastChannel = { channelId: 'new', channelUserId: 'u' };
      return 'mutated';
    });
    assert.equal(store.getOwnership('s').mailboxCursor, intent.id);
    const projection = mutation.projection;
    assert.equal(durable.history.length, 2);
    assert.equal(projections.length, 1);
    assert.equal((projections[0] as any).queue, undefined);
    assert.equal(projection.queueLength, 1);
    assert.equal(coordinator.getOwnership('s')?.mainClaimId, undefined);
    assert.equal(coordinator.getOwnership('s')?.projection.messageCount, 2);
    assert.equal(liveStub.displayName, 'New');
    assert.equal(liveStub.meta.lastChannel.channelId, 'new');
    assert.equal(liveStub.history.length, 0);
    assert.equal(liveStub.queue.length, 0);
    assert.equal(liveStub.meta.wait, undefined);
    const staleLaterInput = stripSessionMetadataForSave(liveStub) as any;
    staleLaterInput.busy = false;
    staleLaterInput.stats = { ...liveStub.stats, totalInputTokens: 999 };
    staleLaterInput.queue = [{ type: 'trigger', parts: [{ text: 'stale' }] }];
    const laterFullSave = coordinator.mergeFullSave('s', mergeSessionWorkerCatalogProjection({ id: 's' }, projection), {
      ...staleLaterInput,
    });
    assert.equal(laterFullSave.displayName, 'New');
    assert.equal(laterFullSave.meta.lastChannel.channelId, 'new');
    assert.equal(laterFullSave.stats.totalInputTokens, projection.stats.totalInputTokens);
    assert.equal('queue' in laterFullSave, false);
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
    await assert.rejects(() => persistence.runMainMutation(session('s'), async (_sessionId, operation) =>
      operation(activeClaim('s')), async current => {
        current.history.push({ role: 'user', parts: [{ text: 'committed' }] });
      }), (error: any) =>
      error?.code === 'SESSION_WORKER_CATALOG_AFTER_STATE_FAILED'
      && error?.details?.stateCommitted === true);
    assert.equal(durable.history[0].parts[0].text, 'committed');
  });
});

test('aborted noncooperative main mutation cannot write late or mutate the catalog stub', async () => {
  await withStore(async store => {
    const base = session('late'); base.model = 'catalog-stub';
    const durable = serializeSessionHistoryPayload(session('late'));
    let stateWrites = 0; let catalogWrites = 0;
    const persistence = new SessionWorkerPersistence(store, {
      readState: async () => structuredClone(durable),
      writeState: async () => { stateWrites += 1; },
      writeCatalogProjection: async () => { catalogWrites += 1; },
    });
    let entered!: () => void; let release!: () => void; let active = true;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const claim: SessionWorkerMainMutationClaim = {
      id: 'late-claim', sessionId: 'late', signal: controller.signal,
      assertActive: () => { if (!active || controller.signal.aborted) throw new RpcError('SESSION_WORKER_STALE_MAIN_MUTATION', 'stale'); },
    };
    const mutation = persistence.runMainMutation(base, async (_sessionId, operation) => operation(claim), async working => {
      working.model = 'late-write'; entered(); await blocker;
    });
    mutation.catch(() => {});
    await enteredPromise;
    active = false; controller.abort(); release();
    await assert.rejects(() => mutation, (error: any) => error?.code === 'SESSION_WORKER_STALE_MAIN_MUTATION');
    assert.equal(stateWrites, 0); assert.equal(catalogWrites, 0);
    assert.equal(base.model, 'catalog-stub');
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

  const mainMutationProjection = structuredClone(projection);
  mainMutationProjection.mainOwned.displayName = 'Claimed Rename';
  await writeSessionWorkerCatalogProjection(mainMutationProjection, {
    load: async () => ({ data: structuredClone(written), source: 'test' }),
    write: async data => { written = data; },
    claim: activeClaim('catalog'),
  });
  assert.equal(written.sessions.catalog.displayName, 'Claimed Rename');

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

test('catalog ownership preserves worker projections and main-only updates in both save orderings and concurrency', async () => {
  const coordinator = new SessionWorkerCatalogCoordinator();
  const worker = session('owned');
  worker.busy = true; worker.stats.totalInputTokens = 12;
  const firstProjection = buildSessionWorkerCatalogProjection(worker);
  coordinator.registerWorker('owned', 'generation-1', firstProjection);
  const latest = mergeSessionWorkerCatalogProjection({ id: 'owned', displayName: 'Old', pinned: true,
    meta: { lastChannel: { channelId: 'old', channelUserId: 'u' } } }, firstProjection);
  const staleFullSave = { id: 'owned', displayName: 'New', pinned: false, busy: false,
    stats: { totalCachedTokens: 0, totalInputTokens: 999, totalOutputTokens: 0, lastUsage: null as any },
    queue: [{ type: 'trigger', parts: [{ text: 'stale' }] }],
    meta: { lastChannel: { channelId: 'new', channelUserId: 'u' }, wait: { id: 'stale' } } };
  const projectionThenFull = coordinator.mergeFullSave('owned', latest, staleFullSave);
  assert.equal(projectionThenFull.displayName, 'New'); assert.equal(projectionThenFull.pinned, false);
  assert.equal(projectionThenFull.meta.lastChannel.channelId, 'new');
  assert.equal(projectionThenFull.busy, true); assert.equal(projectionThenFull.stats.totalInputTokens, 12);
  assert.equal('queue' in projectionThenFull, false); assert.equal('wait' in projectionThenFull.meta, false);

  const secondWorker = session('owned'); secondWorker.stats.totalInputTokens = 22;
  const secondProjection = buildSessionWorkerCatalogProjection(secondWorker);
  coordinator.updateWorker('owned', 'generation-1', secondProjection);
  const localThenProjection = mergeSessionWorkerCatalogProjection(staleFullSave, secondProjection);
  assert.equal(localThenProjection.displayName, 'New'); assert.equal(localThenProjection.stats.totalInputTokens, 22);
  assert.equal('queue' in localThenProjection, false);

  let data: any = { sessions: { owned: projectionThenFull, unrelated: { id: 'unrelated', displayName: 'Keep' } } };
  const thirdWorker = session('owned'); thirdWorker.stats.totalInputTokens = 33;
  const thirdProjection = buildSessionWorkerCatalogProjection(thirdWorker);
  const io = {
    load: async () => ({ data: structuredClone(data), source: 'test' }),
    write: async (next: any) => { data = structuredClone(next); },
  };
  await Promise.all([
    withSessionsMetadataWriteLock(async () => {
      const incoming = { ...staleFullSave, displayName: 'Concurrent Main' };
      data.sessions.owned = coordinator.mergeFullSave('owned', data.sessions.owned, incoming);
    }),
    writeSessionWorkerCatalogProjection(thirdProjection, {
      ...io, coordinator, ownerId: 'generation-1',
    }),
  ]);
  assert.equal(data.sessions.owned.displayName, 'Concurrent Main');
  assert.equal(data.sessions.owned.stats.totalInputTokens, 33);
  assert.equal(data.sessions.unrelated.displayName, 'Keep');

  const staleMainStub = session('owned');
  staleMainStub.displayName = 'Stale Main';
  staleMainStub.queue = [{ type: 'trigger', parts: [{ text: 'stale queue' }] }];
  staleMainStub.meta.wait = { id: 'stale-wait' };
  staleMainStub.meta.managedSession = { ownerSessionId: 'old', leaseId: 'old', revision: 1, pendingInbox: [], openedAt: 1, leaseTouchedAt: 1 };
  const reconciled = session('owned');
  reconciled.displayName = 'Current Main';
  reconciled.stats.totalInputTokens = 44;
  reconciled.queue = [{ type: 'trigger', parts: [{ text: 'current queue' }] }];
  reconciled.meta.wait = { id: 'current-wait' };
  reconciled.meta.managedSession = { ownerSessionId: 'current', leaseId: 'current', revision: 2, pendingInbox: [], openedAt: 2, leaseTouchedAt: 2 };
  reconciled.meta.lastChannel = { channelId: 'current-channel', channelUserId: 'u' };
  const releaseProjection = buildSessionWorkerCatalogProjection(reconciled);
  assert.throws(() => coordinator.releaseWorker('owned', 'generation-1'),
    (error: any) => error?.code === 'SESSION_WORKER_CATALOG_HANDOFF');
  assert.throws(() => coordinator.releaseWorker('owned', 'generation-1', {
    mainStub: staleMainStub, reconciledSession: reconciled, projection: releaseProjection,
  }), (error: any) => error?.code === 'SESSION_WORKER_CATALOG_HANDOFF');
  coordinator.beginMainMutation('owned', 'generation-1', 'release-claim');
  coordinator.updateWorker('owned', 'generation-1', releaseProjection);
  const claimConcurrentFull = coordinator.mergeFullSave('owned', data.sessions.owned, {
    ...stripSessionMetadataForSave(staleMainStub), displayName: 'Stale Main',
  } as any);
  assert.equal(claimConcurrentFull.displayName, 'Current Main');
  assert.equal(claimConcurrentFull.meta.lastChannel.channelId, 'current-channel');
  assert.throws(() => coordinator.releaseWorker('owned', 'generation-1', {
    mainStub: staleMainStub, reconciledSession: reconciled, projection: releaseProjection,
  }), (error: any) => error?.code === 'SESSION_WORKER_CATALOG_CLAIMED');
  coordinator.cancelMainMutation('owned', 'generation-1', 'release-claim');
  const mismatchedReconciled = structuredClone(reconciled);
  mismatchedReconciled.stats.totalInputTokens = 999;
  assert.throws(() => coordinator.releaseWorker('owned', 'generation-1', {
    mainStub: staleMainStub, reconciledSession: mismatchedReconciled, projection: releaseProjection,
  }), (error: any) => error?.code === 'SESSION_WORKER_CATALOG_HANDOFF');
  coordinator.releaseWorker('owned', 'generation-1', {
    mainStub: staleMainStub, reconciledSession: reconciled, projection: releaseProjection,
  });
  assert.equal(coordinator.getOwnership('owned'), undefined);
  assert.equal(staleMainStub.displayName, 'Current Main');
  assert.equal(staleMainStub.stats.totalInputTokens, 44);
  assert.equal(staleMainStub.queue[0].parts[0].text, 'current queue');
  assert.equal(staleMainStub.meta.wait.id, 'current-wait');
  assert.equal(staleMainStub.meta.managedSession.leaseId, 'current');
  assert.equal(staleMainStub.meta.lastChannel.channelId, 'current-channel');
  const afterReleaseFullSave = coordinator.mergeFullSave('owned', data.sessions.owned, stripSessionMetadataForSave(staleMainStub) as any);
  assert.equal(afterReleaseFullSave.displayName, 'Current Main');
  assert.equal(afterReleaseFullSave.stats.totalInputTokens, 44);
  assert.equal(afterReleaseFullSave.queue[0].parts[0].text, 'current queue');
  assert.equal(afterReleaseFullSave.meta.wait.id, 'current-wait');
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
    assert.equal(result.stateVersion, SESSION_STATE_FORMAT_VERSION);
    assert.deepEqual(result.frontier, [{ kind: 'message', seq: 1 }]);
    assert.equal(result.promptCacheKey, 'cache');
    assert.equal(result.catalogExists, false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.remove(root);
  }
});
