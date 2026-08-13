import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChannelContext } from './channel';
import { SESSIONS_FILE } from './config';
import { MessageRouter } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { createChannelsStore, resetChannelsForTests, setChannelsStoreForTests } from './session/channels';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { Session } from './types';
import { COMMANDS } from './commands';

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], persistentMemorySnapshot: 'router ingress prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeCtx(replies: any[], platform = 'test'): ChannelContext {
  return {
    platform, channelId: platform === 'webui' ? 'webui' : 'test-channel', channelType: platform,
    channelUserId: 'room', conversationId: 'room', username: 'user', senderId: 'sender-1',
    preferDirectReply: true,
    reply: async (text: string, options: any) => { replies.push({ text, options }); },
    sendTyping: async () => {},
  } as ChannelContext;
}

test('MessageRouter routes ordinary and busy channel input through the durable Worker path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-router-ingress-'));
  const sessionId = 'router-worker-session';
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, id => id === sessionId);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.ensureFile(SESSIONS_FILE); const sessionsBefore = await fs.readFile(SESSIONS_FILE);
  const stubSession = { id: sessionId, busy: false, queue: [], meta: {}, history: [] } as any as Session;
  sessionManager.getAllSessions().set(sessionId, stubSession);
  const originals = {
    getOrCreateSessionForChannel: sessionManager.getOrCreateSessionForChannel,
    enqueueSessionItem: sessionManager.enqueueSessionItem,
    saveSession: sessionManager.saveSession,
    requestSessionStop: sessionManager.requestSessionStop,
    requestSessionDequeue: sessionManager.requestSessionDequeue,
    retrySession: sessionManager.retrySession,
  };
  let mainLocalMutationCalls = 0; // counts forbidden Main-local semantic mutation calls (enqueue/save/control)
  (sessionManager as any).getOrCreateSessionForChannel = async () => ({ sessionId, session: stubSession });
  (sessionManager as any).enqueueSessionItem = async () => { mainLocalMutationCalls += 1; throw new Error('Main local enqueue forbidden'); };
  (sessionManager as any).saveSession = async () => { mainLocalMutationCalls += 1; throw new Error('Main save forbidden'); };
  (sessionManager as any).requestSessionStop = async () => { mainLocalMutationCalls += 1; throw new Error('Main stop forbidden'); };
  (sessionManager as any).requestSessionDequeue = async () => { mainLocalMutationCalls += 1; throw new Error('Main dequeue forbidden'); };
  (sessionManager as any).retrySession = async () => { mainLocalMutationCalls += 1; throw new Error('Main retry forbidden'); };
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  const router = new MessageRouter(
    [{ platform: 'test-channel', userId: 'sender-1' }],
    (id, item, ctx) => sessionRuntime.submitAndRun(id, item, ctx),
  );
  let localRuns = 0;
  (router as any).turnRunner.processSessionQueue = async () => { localRuns += 1; throw new Error('local runner forbidden'); };
  (router as any).turnRunner.processSessionRetry = async () => { localRuns += 1; throw new Error('local runner forbidden'); };
  const replies: any[] = [];
  try {
    await supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });

    await router.handleMessage(makeCtx(replies), { parts: [{ text: 'router worker ingress' }], clientMessageId: 'router-client-1' } as any);
    assert.equal(replies.length, 1); assert.equal(replies[0].text, 'deterministic child answer');
    const ownership = store.getOwnership(sessionId);
    assert.equal(ownership.state, 'ready'); assert.equal(ownership.generation, 1);
    assert.equal(supervisor.getStatus(sessionId)?.ready, true);
    let authority = await fs.readJson(statePath);
    assert.equal(authority.lastAppliedMailboxId, ownership.mailboxCursor);
    assert.equal(authority.history.length, 2);
    assert.equal(authority.history[0].__meta.clientMessageId, 'router-client-1');
    assert.equal(localRuns, 0); assert.equal(mainLocalMutationCalls, 0);
    assert.deepEqual(await fs.readFile(SESSIONS_FILE), sessionsBefore);

    // Busy Main stubs must not divert input to a local queue: the mailbox owns queuing.
    stubSession.busy = true;
    await router.handleMessage(makeCtx(replies), { parts: [{ text: 'busy router worker ingress' }], clientMessageId: 'router-client-2' } as any);
    assert.equal(replies.length, 2); assert.equal(replies[1].text, 'deterministic child answer');
    assert.equal(store.countMailboxIntents(), 2);
    authority = await fs.readJson(statePath);
    assert.equal(authority.history.length, 4);
    assert.equal(localRuns, 0); assert.equal(mainLocalMutationCalls, 0);

    // Continue uses the exact Worker owner and canonical parts:null turn without
    // appending a mailbox/queue record; its serialized source keeps direct
    // channel final delivery equivalent to ordinary ingress.
    stubSession.busy = false;
    await sessionRuntime.deleteMessages(sessionId, -1);
    authority = await fs.readJson(statePath);
    assert.equal(authority.history.length, 3);
    assert.equal(authority.history[2].role, 'user');
    const continueCtx = makeCtx(replies, 'webui');
    await COMMANDS['/continue'].handler(continueCtx, [], sessionId, stubSession);
    authority = await fs.readJson(statePath);
    assert.equal(authority.history.length, 4);
    assert.equal(authority.history[3].role, 'model');
    assert.equal(store.countMailboxIntents(), 2, 'continue does not invent a queue/mailbox intent');
    assert.equal(replies.length, 4);
    assert.equal(replies[2].text, '▶️ Continuing interrupted turn...');
    assert.equal(replies[3].text, 'deterministic child answer');
    await COMMANDS['/continue'].handler(continueCtx, [], sessionId, stubSession);
    authority = await fs.readJson(statePath);
    assert.equal(authority.history.length, 4, 'a completed Worker answer cannot be continued again');
    assert.equal(replies[4].text, '▶️ Continuing interrupted turn...');
    assert.equal(replies[5].text, '⚠️ Session has no interrupted turn to continue.');
    assert.deepEqual(await sessionRuntime.control(sessionId, 'dequeue'), {
      action: 'dequeue', queuedItems: 0, stoppedCurrent: false, abortedInFlight: false,
    });
    await assert.rejects(() => sessionRuntime.control(`${sessionId}-unknown`, 'retry', makeCtx(replies)),
      (error: any) => error?.code === 'SESSION_WORKER_SESSION_NOT_FOUND');
    assert.equal(store.findOwnership(`${sessionId}-unknown`), undefined);
    assert.equal(sourceContexts.size, 0);
    assert.equal(mainLocalMutationCalls, 0);
  } finally {
    (sessionManager as any).getOrCreateSessionForChannel = originals.getOrCreateSessionForChannel;
    (sessionManager as any).enqueueSessionItem = originals.enqueueSessionItem;
    (sessionManager as any).saveSession = originals.saveSession;
    (sessionManager as any).requestSessionStop = originals.requestSessionStop;
    (sessionManager as any).requestSessionDequeue = originals.requestSessionDequeue;
    (sessionManager as any).retrySession = originals.retrySession;
    await sessionRuntime.shutdownSessionRuntime().catch(() => {});
    await supervisor.shutdown(5_000).catch(() => {}); store.close();
    resetChannelsForTests(); setChannelsStoreForTests(null);
    await fs.remove(root);
    sessionManager.getAllSessions().delete(sessionId);
  }
});

test('Worker retry response loss is reported as ambiguous after exactly one committed and delivered result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-router-retry-ambiguous-'));
  const sessionId = 'router-worker-retry-ambiguous';
  const authority = baseSession(sessionId);
  authority.history = [{ role: 'user', parts: [{ text: 'retry this request' }], __meta: { timestamp: Date.now(), seq: 1 } } as any];
  authority.nextMessageSeq = 2;
  const stubSession = { ...baseSession(sessionId), history: authority.history.slice() } as Session;
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_DROP_RETRY_RESPONSE_AFTER_COMMIT: '1' },
    resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, id => id === sessionId);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  const replies: any[] = [];
  try {
    await fs.outputJson(statePath, serializeSessionHistoryPayload(authority));
    sessionManager.getAllSessions().set(sessionId, stubSession);
    await supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });

    await COMMANDS['/continue'].handler(makeCtx(replies, 'webui'), [], sessionId, stubSession);

    const committed = await fs.readJson(statePath);
    assert.equal(committed.history.filter((message: any) => message.role === 'user').length, 1);
    assert.equal(committed.history.filter((message: any) => message.role === 'model').length, 1);
    assert.equal(committed.history.at(-1)?.parts?.[0]?.text, 'deterministic child answer');
    assert.equal(store.countMailboxIntents(), 0, 'retry ambiguity does not create or replay a mailbox intent');
    assert.equal(replies.filter(reply => reply.text === 'deterministic child answer').length, 1, 'the committed final was delivered exactly once before response loss');
    assert.ok(replies.some(reply => String(reply.text).startsWith('⚠️ Continue outcome is unknown:')));
    assert.ok(!replies.some(reply => String(reply.text).startsWith('❌ Continue failed:')));
    assert.equal(sourceContexts.size, 0);
  } finally {
    await sessionRuntime.shutdownSessionRuntime().catch(() => {});
    await supervisor.shutdown(5_000).catch(() => {}); store.close();
    sessionManager.getAllSessions().delete(sessionId);
    await fs.remove(root);
  }
});

test('serialized retry handler cancellation and deadline rejections remain definite', async () => {
  for (const code of ['RPC_CANCELLED', 'RPC_DEADLINE_EXCEEDED']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-router-retry-${code.toLowerCase()}-`));
    const sessionId = `router-worker-retry-${code.toLowerCase()}`;
    const authority = baseSession(sessionId);
    authority.history = [{ role: 'user', parts: [{ text: 'retry this request' }], __meta: { timestamp: Date.now(), seq: 1 } } as any];
    authority.nextMessageSeq = 2;
    const stubSession = { ...baseSession(sessionId), history: authority.history.slice() } as Session;
    const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
    const sourceContexts = new SessionWorkerSourceContextRegistry();
    const supervisor = new SessionWorkerSupervisor({
      store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
      workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_REJECT_RETRY_CODE: code },
      resolveExactFinalSourceContext: sourceContexts.resolve,
    });
    const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, id => id === sessionId);
    const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
    try {
      await fs.outputJson(statePath, serializeSessionHistoryPayload(authority));
      sessionManager.getAllSessions().set(sessionId, stubSession);
      await supervisor.reconcileStartupOwnerships();
      await sessionRuntime.initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });

      await assert.rejects(
        () => sessionRuntime.control(sessionId, 'retry', makeCtx([], 'webui')),
        (error: any) => error?.code === code && error?.code !== 'SESSION_WORKER_RETRY_OUTCOME_UNKNOWN',
      );
      const unchanged = await fs.readJson(statePath);
      assert.equal(unchanged.history.filter((message: any) => message.role === 'model').length, 0);
      assert.equal(store.countMailboxIntents(), 0);
      assert.equal(sourceContexts.size, 0);
    } finally {
      await sessionRuntime.shutdownSessionRuntime().catch(() => {});
      await supervisor.shutdown(5_000).catch(() => {}); store.close();
      sessionManager.getAllSessions().delete(sessionId);
      await fs.remove(root);
    }
  }
});

test('MessageRouter without worker placement keeps the local enqueue and runner path', async () => {
  const sessionId = 'router-local-session';
  const stubSession = { id: sessionId, busy: false, queue: [], meta: {}, history: [] } as any as Session;
  const originals = {
    getOrCreateSessionForChannel: sessionManager.getOrCreateSessionForChannel,
    enqueue: sessionRuntime.enqueue,
  };
  let enqueued = 0; let localRuns = 0;
  (sessionManager as any).getOrCreateSessionForChannel = async () => ({ sessionId, session: stubSession });
  (sessionRuntime as any).enqueue = async () => { enqueued += 1; };
  const router = new MessageRouter([{ platform: 'test-channel', userId: 'sender-1' }]);
  (router as any).turnRunner.processSessionQueue = async () => { localRuns += 1; };
  const replies: any[] = [];
  try {
    await router.handleMessage(makeCtx(replies), { parts: [{ text: 'local idle' }] } as any);
    assert.equal(enqueued, 1); assert.equal(localRuns, 1);
    stubSession.busy = true;
    await router.handleMessage(makeCtx(replies), { parts: [{ text: 'local busy' }] } as any);
    assert.equal(enqueued, 2); assert.equal(localRuns, 1, 'busy local input queues without a new runner');
  } finally {
    (sessionManager as any).getOrCreateSessionForChannel = originals.getOrCreateSessionForChannel;
    (sessionRuntime as any).enqueue = originals.enqueue;
  }
});
