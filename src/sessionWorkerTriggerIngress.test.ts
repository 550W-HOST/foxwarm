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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for condition.');
}

async function createFixture(sessionId: string, workerEnv: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-trigger-ingress-'));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const catalogSession = baseSession(sessionId);
  sessionManager.getAllSessions().set(sessionId, catalogSession);
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...workerEnv }, resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(
    store, supervisor, sourceContexts,
    id => sessionManager.resolveLoadedSessionId(id),
    id => !!sessionManager.getSessionCatalog(id),
  );
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(catalogSession));
  return {
    root, store, sourceContexts, supervisor, ingress, statePath, catalogSession,
    async close() {
      await sessionRuntime.shutdownSessionRuntime().catch(() => {});
      sessionManager.setSessionWorkerEnqueueSink(undefined);
      await supervisor.shutdown(5_000).catch(() => {});
      sessionManager.getAllSessions().delete(sessionId);
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

    // Unknown ordinary queue and /trigger-style queueEvent requests fail at
    // the nonhydrating catalog preflight before store ownership/mailbox/spawn.
    const unknownId = `trigger-unknown-${Date.now()}`;
    await assert.rejects(
      () => sessionRuntime.submitAndRun(unknownId, { type: 'user', parts: [{ text: 'unknown queue' }] }),
      (error: any) => error?.code === 'SESSION_WORKER_SESSION_NOT_FOUND',
    );
    await assert.rejects(
      () => sessionRuntime.queueEvent(unknownId, 'unknown trigger', 'trigger'),
      (error: any) => error?.code === 'SESSION_WORKER_SESSION_NOT_FOUND',
    );
    assert.equal(fixture.store.findOwnership(unknownId), undefined);
    assert.equal(fixture.store.countMailboxIntents(), 0);
    assert.equal(fixture.supervisor.listStatuses().length, 0);

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
    assert.equal(fixture.catalogSession.history.length, 0);
    assert.equal(fixture.catalogSession.queue.length, 0);

    // Settings mutation reaches the exact Worker without hydrating/saving Main.
    const settings = await sessionRuntime.updateSettings(sessionId, { model: 'other-model', effort: 'none', childEffortDefault: 'max' });
    assert.equal(settings.current.model, 'other-model');
    assert.equal(settings.current.effort, 'none');
    assert.equal(settings.current.childEffortDefault, 'max');
    const projected = await sessionRuntime.getSession(sessionId);
    assert.equal(projected?.effort, 'none');
    assert.equal(projected?.childEffortDefault, 'max');
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

test('high-level persisted alias queueing canonicalizes only the target before exact Worker ingress', async () => {
  const sessionId = `trigger-worker-alias-${Date.now()}`;
  const alias = `${sessionId}-persisted-alias`;
  const fixture = await createFixture(sessionId);
  const originals = {
    getSession: sessionManager.getSession,
    getExistingSession: sessionManager.getExistingSession,
  };
  const routed: Array<{ sessionId: string; item: QueueItem }> = [];
  const source = {
    platform: 'qqbot', channelId: 'qq-instance', channelType: 'qqbot',
    channelUserId: 'c2c:openid', conversationId: 'c2c:openid',
    qqbotMessageId: 'alias-message-id', preferDirectReply: true,
  };
  const ordinaryItem: QueueItem = { type: 'user', source, parts: [{ text: 'alias ordinary queue' }] };
  try {
    fixture.catalogSession.aliases = [alias];
    sessionManager.updateAliasCache([alias], sessionId);
    await sessionManager.saveSessionCatalogEntries(sessionManager.getAllSessions().keys());
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });
    sessionManager.setSessionWorkerEnqueueSink(async (targetId, item) => {
      routed.push({ sessionId: targetId, item: structuredClone(item) });
      await fixture.ingress.enqueueEnsuringWorker(targetId, item);
    });
    (sessionManager as any).getSession = async () => { throw new Error('semantic hydration forbidden'); };
    (sessionManager as any).getExistingSession = async () => { throw new Error('semantic hydration forbidden'); };

    await sessionRuntime.queueEvent(alias, 'alias trigger queue', 'trigger');
    await sessionRuntime.enqueue(alias, ordinaryItem);
    await waitFor(() => fixture.store.getOwnership(sessionId).mailboxCursor === 2);

    assert.deepEqual(routed.map(entry => entry.sessionId), [sessionId, sessionId]);
    assert.equal(routed[0].item.type, 'trigger');
    assert.equal(routed[1].item.type, ordinaryItem.type);
    assert.deepEqual(routed[1].item.source, source, 'target canonicalization must not rewrite source/turn-boundary metadata');
    assert.deepEqual(routed[1].item.parts, ordinaryItem.parts);
    assert.equal(fixture.store.findOwnership(alias), undefined);
    assert.equal(fixture.store.getOwnership(sessionId).state, 'ready');
    assert.equal(fixture.supervisor.listStatuses().length, 1);

    const beforeRawAlias = fixture.store.countMailboxIntents();
    await assert.rejects(
      () => fixture.ingress.submitEnsuringWorker(alias, { type: 'user', parts: [{ text: 'raw alias rejected' }] }),
      (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID_SESSION',
    );
    assert.equal(fixture.store.countMailboxIntents(), beforeRawAlias);
    assert.equal(fixture.supervisor.listStatuses().length, 1);
  } finally {
    (sessionManager as any).getSession = originals.getSession;
    (sessionManager as any).getExistingSession = originals.getExistingSession;
    await fixture.close();
  }
});

test('busy manual-fork notification queues durably and joins the held canonical runner', async () => {
  const sessionId = `trigger-worker-busy-fork-${Date.now()}`;
  const fixture = await createFixture(sessionId, {
    FOXWARM_TEST_HOLD_PROVIDER: '1',
    FOXWARM_TEST_HOLD_SESSION: sessionId,
  });
  const startedPath = path.join(fixture.root, 'state', `hold-started-${sessionId}`);
  const releasePath = path.join(fixture.root, 'state', `hold-release-${sessionId}`);
  let initialSettled = false;
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });
    const initial = sessionRuntime.submitAndRun(sessionId, { type: 'user', parts: [{ text: 'held parent turn' }] })
      .finally(() => { initialSettled = true; });
    await waitFor(async () => await fs.pathExists(startedPath) || initialSettled);
    if (initialSettled) await initial;
    await waitFor(() => fixture.supervisor.projectionRegistry.get(sessionId)?.projection?.busy === true);

    const notification = await sessionRuntime.notifyManualForkCreated(sessionId, `${sessionId}_child`, 'child hello');
    assert.deepEqual(notification, { result: 'queued' });
    assert.equal(initialSettled, false, 'command-side notification must settle while the provider remains held');
    assert.equal(fixture.store.countMailboxIntents(), 2);
    assert.equal(fixture.store.getOwnership(sessionId).mailboxCursor, 1, 'busy notice remains durable until the current runner safe point');

    await fs.writeFile(releasePath, '1');
    await initial;
    await waitFor(() => fixture.store.getOwnership(sessionId).mailboxCursor === 2);
    const authority = await fs.readJson(fixture.statePath);
    assert.deepEqual(authority.history.map((message: any) => message.role), ['user', 'model', 'user', 'model']);
    assert.match(String(authority.history[2].parts[0].system), /manual-fork-created/);
    assert.match(String(authority.history[2].parts[0].system), new RegExp(`${sessionId}_child`));
    assert.equal(authority.history.filter((message: any) => message.role === 'model').length, 2,
      'the mailbox notice continues the held runner without an extra provider turn');
  } finally {
    await fs.outputFile(releasePath, '1').catch(() => {});
    await fixture.close();
  }
});

test('committed-idle manual-fork admission appends through the exact owner without starting a turn', async () => {
  const sessionId = `trigger-worker-idle-fork-${Date.now()}`;
  const fixture = await createFixture(sessionId);
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({
      worker: { store: fixture.store, registry: fixture.supervisor.projectionRegistry, ingress: fixture.ingress, supervisor: fixture.supervisor },
    });
    await fixture.ingress.ensureWorkerOwner(sessionId);
    assert.equal(fixture.supervisor.projectionRegistry.get(sessionId)?.projection?.busy, false);

    const notification = await sessionRuntime.notifyManualForkCreated(sessionId, `${sessionId}_child`);
    assert.deepEqual(notification, { result: 'appended' });
    assert.equal(fixture.store.countMailboxIntents(), 0);
    const authority = await fs.readJson(fixture.statePath);
    assert.deepEqual(authority.history.map((message: any) => message.role), ['user']);
    assert.match(String(authority.history[0].parts[0].system), /manual-fork-created/);
  } finally { await fixture.close(); }
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

test('worker placement never runs residual Main-local busy/queue state through the local resume path', async () => {
  const sessionId = `resume-local-residual-${Date.now()}`;
  const submitted: string[] = [];
  let localTriggerCalls = 0;
  const session = await sessionManager.getSession(sessionId);
  session.busy = true; session.busyStartedAt = Date.now();
  session.queue.push({ type: 'background', parts: [{ system: 'residual local work' }] });
  await sessionManager.saveSession(sessionId);
  sessionManager.setSessionWorkerEnqueueSink(async id => { submitted.push(id); });
  sessionManager.setSessionTriggerCallback(() => { localTriggerCalls += 1; });
  try {
    await sessionManager.resumeBusySessions();
    // Fail-loud and skip: no local trigger, no sink submission, no authority mutation.
    assert.equal(localTriggerCalls, 0);
    assert.deepEqual(submitted, []);
    const reloaded = await sessionManager.getExistingSession(sessionId);
    assert.equal(reloaded?.busy, true);
    assert.equal(reloaded?.queue.length, 1);
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    const residual = await sessionManager.getExistingSession(sessionId);
    if (residual) { residual.busy = false; residual.busyStartedAt = undefined; residual.queue = []; }
    await sessionManager.deleteSession(sessionId).catch(() => {});
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

    const orphanId = 'resume-orphan-not-in-catalog';
    fixture.store.enqueueIntent(orphanId, crypto.randomUUID(), 'enqueue', {
      type: 'background', parts: [{ system: 'orphaned durable event' }],
    });
    await resumeSessionWorkerPendingIntents(fixture.store, fixture.supervisor, () => [sessionId]);
    assert.equal(fixture.store.findOwnership(orphanId), undefined, 'startup resume must not spawn an unknown catalog session');
    assert.equal(fixture.store.listPendingIntents(orphanId).length, 1, 'orphaned durable input remains untouched for explicit repair');

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
