import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { resumeSessionWorkerPendingIntents, SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { QueueItem, Session } from './types';

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'trigger ingress prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

async function createFixture(sessionId: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-trigger-ingress-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  return {
    root, store, sourceContexts, supervisor, ingress, statePath,
    async close() {
      await sessionRuntime.shutdownSessionRuntime().catch(() => {});
      sessionManager.setSessionWorkerEnqueueSink(undefined);
      await supervisor.shutdown(5_000).catch(() => {});
      store.close(); await fs.remove(root);
    },
  };
}

test('timer, wait-timeout, ONBOOT, and node event triggers share the durable Worker ingress boundary', async () => {
  const sessionId = 'trigger-worker-session';
  const fixture = await createFixture(sessionId);
  const originalSaveSession = sessionManager.saveSession;
  let mainLocalSaves = 0; let localTriggerCalls = 0;
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress },
    });
    sessionManager.setSessionWorkerEnqueueSink(
      (id, item) => fixture.ingress.submitEnsuringWorker(id, item).then(() => {}),
    );
    // Create the managed stub before Main-local saves are forbidden.
    const managedId = `trigger-managed-${Date.now()}`;
    const managedSession = await sessionManager.getSession(managedId);
    (managedSession.meta as any).managedSession = { ownerSessionId: 'owner', leaseId: 'lease-1', revision: 1, pendingInbox: [] };
    sessionManager.setSessionTriggerCallback(() => { localTriggerCalls += 1; });
    (sessionManager as any).saveSession = async () => { mainLocalSaves += 1; throw new Error('Main local save forbidden'); };

    // timer / node-event system text, wait-timeout (with waitTimeoutId), ONBOOT type
    await sessionManager.queueSessionEvent(sessionId, 'timer fired', 'trigger');
    await sessionManager.queueSessionSystemEvent(sessionId, 'node event', 'background');
    await sessionManager.queueSessionWaitTimeoutEvent(sessionId, 'wait-1', 'wait timeout reached');
    await sessionManager.queueSessionEvent(sessionId, 'ONBOOT: boot', 'onboot');

    const ownership = fixture.store.getOwnership(sessionId);
    assert.equal(ownership.state, 'ready'); assert.equal(ownership.generation, 1);
    assert.equal(fixture.store.countMailboxIntents(), 4);
    assert.equal(ownership.mailboxCursor, 4);
    const authority = await fs.readJson(fixture.statePath);
    assert.equal(authority.lastAppliedMailboxId, 4);
    const systemEvents = authority.history.filter((message: any) => message.role === 'user');
    assert.equal(systemEvents.length, 3, 'each event is appended as its own canonical message; the unmatched wait-timeout is dropped by the canonical wait transition');
    assert.ok(authority.history.some((message: any) => message.role === 'model'));
    // Events carry no live source: delivery resolves to the attachment fallback semantics.
    assert.equal(fixture.sourceContexts.size, 0);
    // Nothing bypassed the durable boundary into Main-local queue/wait/trigger state.
    assert.equal(mainLocalSaves, 0); assert.equal(localTriggerCalls, 0);
    assert.equal(sessionManager.getAllSessions().has(sessionId), false);

    // Settings mutation and local turn controls fail closed for a worker-fenced session.
    await assert.rejects(
      () => sessionRuntime.updateSettings(sessionId, { model: 'other-model' }),
      (error: any) => error?.code === 'SESSION_WORKER_CONTROL_UNSUPPORTED',
    );
    assert.equal(mainLocalSaves, 0);

    // Managed sessions fail closed at the shared boundary instead of spawning a worker.
    await assert.rejects(
      () => sessionManager.queueSessionEvent(managedId, 'managed wakeup', 'background'),
      (error: any) => error?.code === 'SESSION_WORKER_QUEUE_UNSUPPORTED',
    );
    assert.equal(fixture.store.countMailboxIntents(), 4);
    assert.equal(fixture.supervisor.listStatuses().length, 1, 'no worker may spawn for a managed session');
    await sessionManager.deleteSession(managedId).catch(() => {});
  } finally {
    (sessionManager as any).saveSession = originalSaveSession;
    await fixture.close();
  }
});

test('all Main-side enqueue producers route through the sink without local queue or trigger writes', async () => {
  const submitted: Array<{ sessionId: string; item: QueueItem }> = [];
  let localTriggerCalls = 0;
  const targetA = `sink-target-a-${Date.now()}`;
  const targetB = `sink-target-b-${Date.now()}`;
  sessionManager.setSessionWorkerEnqueueSink(async (sessionId, item) => { submitted.push({ sessionId, item }); });
  sessionManager.setSessionTriggerCallback(() => { localTriggerCalls += 1; });
  try {
    await sessionManager.enqueueSessionItem(targetA, { type: 'background', parts: [{ system: 'direct producer' }] });
    await sessionManager.queueSessionEvent(targetB, 'wrapped event', 'onboot');
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].sessionId, targetA);
    assert.deepEqual(submitted[0].item, { type: 'background', parts: [{ system: 'direct producer' }] });
    assert.equal(submitted[1].sessionId, targetB);
    assert.equal(submitted[1].item.type, 'onboot');
    // No Main-local hydration, queue append, wait transition, or trigger callback ran.
    assert.equal(localTriggerCalls, 0);
    assert.equal(sessionManager.getAllSessions().has(targetA), false);
    assert.equal(sessionManager.getAllSessions().has(targetB), false);
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
  }
});

test('startup resume ensures owners and runs durable pending mailbox intents', async () => {
  const sessionId = 'resume-worker-session';
  const fixture = await createFixture(sessionId);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const intent = fixture.store.enqueueIntent(sessionId, crypto.randomUUID(), 'enqueue', {
      type: 'background', parts: [{ system: 'pending durable event' }],
    });
    assert.deepEqual(fixture.store.listSessionsWithPendingIntents(), [sessionId]);

    await resumeSessionWorkerPendingIntents(fixture.store, fixture.supervisor);
    const ownership = fixture.store.getOwnership(sessionId);
    assert.equal(ownership.state, 'ready'); assert.equal(ownership.generation, 1);
    assert.equal(ownership.mailboxCursor, intent.id);
    const authority = await fs.readJson(fixture.statePath);
    assert.equal(authority.lastAppliedMailboxId, intent.id);
    assert.equal(authority.history.length, 2);
    assert.equal(fixture.store.listSessionsWithPendingIntents().length, 0);

    // A session whose authoritative JSON cannot be hydrated keeps its durable
    // intents pending, and the failure does not abort the resume of others.
    const brokenId = 'resume-broken-session';
    fixture.store.enqueueIntent(brokenId, crypto.randomUUID(), 'enqueue', {
      type: 'background', parts: [{ system: 'cannot hydrate' }],
    });
    await resumeSessionWorkerPendingIntents(fixture.store, fixture.supervisor);
    assert.ok(fixture.store.listSessionsWithPendingIntents().includes(brokenId));
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, intent.id);
  } finally { await fixture.close(); }
});
