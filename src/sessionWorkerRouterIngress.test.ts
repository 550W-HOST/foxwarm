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

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'router ingress prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeCtx(replies: any[]): ChannelContext {
  return {
    platform: 'test', channelId: 'test-channel', channelType: 'test',
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
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id);
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.ensureFile(SESSIONS_FILE); const sessionsBefore = await fs.readFile(SESSIONS_FILE);
  const stubSession = { id: sessionId, busy: false, queue: [], meta: {}, history: [] } as any as Session;
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

    // Destructive local turn controls fail closed for a worker-fenced session.
    for (const action of ['stop', 'dequeue', 'retry'] as const) {
      await assert.rejects(
        () => sessionRuntime.control(sessionId, action),
        (error: any) => error?.code === 'SESSION_WORKER_CONTROL_UNSUPPORTED',
      );
    }
    assert.equal(mainLocalMutationCalls, 0);
    assert.deepEqual(await fs.readFile(SESSIONS_FILE), sessionsBefore);
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
