import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { registerChannel, unregisterChannel, type ChannelContext } from './channel';
import { SESSIONS_FILE } from './config';
import { shutdownSessionRuntime, initializeSessionRuntime, submitAndRun } from './sessionRuntime';
import { createChannelsStore, attachChannel, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import * as sessionManager from './sessionManager';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { QueueSource, Session } from './types';

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], contextFrontier: [], persistentMemorySnapshot: 'worker ingress prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function sourceContext(source: QueueSource, replies: any[]): ChannelContext {
  return {
    platform: source.platform, channelId: source.channelId, channelType: source.channelType,
    channelUserId: source.channelUserId, conversationId: source.conversationId,
    username: source.username, senderId: source.senderId, weworkStreamId: source.weworkStreamId,
    qqbotMessageId: source.qqbotMessageId, preferDirectReply: source.preferDirectReply,
    reply: async (text, options) => { replies.push({ text, options }); }, sendTyping: async () => {},
  };
}

const itemFor = (text: string, source: QueueSource, clientMessageId: string) => ({
  type: 'user' as const, source, clientMessageId,
  parts: [{ text, imageMeta: { imageId: `image-${clientMessageId}`, mimeType: 'image/png', width: 2, height: 3 } }],
});

test('Main submitAndRun owns exact activated-worker ingress without Main semantic fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-ingress-'));
  const sessionId = 'worker-ingress-real';
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
  const originals = {
    getExistingSession: sessionManager.getExistingSession, enqueueSessionItem: sessionManager.enqueueSessionItem,
    saveSession: sessionManager.saveSession,
  };
  let mainSemanticCalls = 0;
  (sessionManager as any).getExistingSession = async () => { mainSemanticCalls += 1; throw new Error('Main hydration forbidden'); };
  (sessionManager as any).enqueueSessionItem = async () => { mainSemanticCalls += 1; throw new Error('Main enqueue forbidden'); };
  (sessionManager as any).saveSession = async () => { mainSemanticCalls += 1; throw new Error('Main save forbidden'); };
  const replies: any[] = []; const attachmentSends: any[] = [];
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  registerChannel('telegram-stage3', {
    name: 'telegram-stage3', platform: 'telegram', start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (conversationId, text, options) => { attachmentSends.push({ conversationId, text, options }); },
  });
  try {
    await supervisor.reconcileStartupOwnerships();
    await initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });
    const unavailableSource: QueueSource = { platform: 'test', channelUserId: 'missing', preferDirectReply: true };
    await assert.rejects(
      () => submitAndRun(sessionId, itemFor('must not fall back', unavailableSource, 'client-missing'), sourceContext(unavailableSource, replies)),
      (error: any) => error?.code === 'SESSION_WORKER_INGRESS_UNAVAILABLE',
    );
    assert.equal(store.countMailboxIntents(), 0); assert.equal(sourceContexts.size, 0); assert.equal(mainSemanticCalls, 0);
    const activated = await supervisor.ensureWorker(sessionId);
    await assert.rejects(
      () => submitAndRun(sessionId, { type: 'compact-commit', request: {} } as any),
      (error: any) => error?.code === 'SESSION_WORKER_QUEUE_UNSUPPORTED',
    );
    assert.equal(store.countMailboxIntents(), 0);
    const qqSource: QueueSource = {
      platform: 'qqbot', channelId: 'qq-main', channelType: 'qqbot', channelUserId: 'c2c:user', conversationId: 'c2c:user',
      senderId: 'sender-qq', qqbotMessageId: 'qq-inbound-1', preferDirectReply: true,
    };
    let firstDeliveryObservation: any;
    const firstContext = sourceContext(qqSource, replies);
    firstContext.reply = async (text, options) => {
      replies.push({ text, options });
      firstDeliveryObservation = {
        authority: await fs.readJson(statePath), ownership: store.getOwnership(sessionId),
        projection: supervisor.projectionRegistry.get(sessionId)?.projection,
      };
    };
    const first = await submitAndRun(sessionId, itemFor('first ingress', qqSource, 'client-1'), firstContext);
    assert.equal(first.generation, activated.generation); assert.equal(first.busy, false); assert.equal(first.messageCount, 2);
    assert.equal(store.countMailboxIntents(), 1); assert.equal(store.listPendingIntents(sessionId).length, 0);
    assert.equal(replies.length, 1); assert.equal(replies[0].text, 'deterministic child answer');
    assert.equal(replies[0].options.qqbotMessageId, 'qq-inbound-1');
    const firstAuthority = await fs.readJson(statePath);
    assert.equal(firstAuthority.lastAppliedMailboxId, first.mailboxIntentId);
    assert.equal(firstAuthority.history[0].__meta.clientMessageId, 'client-1');
    assert.equal(firstAuthority.history[0].parts.find((part: any) => part.imageMeta)?.imageMeta.imageId, 'image-client-1');
    assert.equal(store.getOwnership(sessionId).mailboxCursor, first.mailboxIntentId);
    assert.equal(supervisor.projectionRegistry.get(sessionId)?.projection?.messageCount, 2);
    assert.equal(firstDeliveryObservation.authority.lastAppliedMailboxId, first.mailboxIntentId);
    assert.equal(firstDeliveryObservation.ownership.mailboxCursor, first.mailboxIntentId);
    assert.equal(firstDeliveryObservation.projection.messageCount, 2);
    assert.equal(firstDeliveryObservation.projection.busy, true, 'final delivery precedes existing busy release');
    assert.equal(sourceContexts.size, 0); assert.equal(mainSemanticCalls, 0);
    assert.deepEqual(await fs.readFile(SESSIONS_FILE), sessionsBefore);

    const sourceA: QueueSource = { platform: 'test', channelId: 'test', channelType: 'test', channelUserId: 'a', conversationId: 'a', senderId: 'a', preferDirectReply: true };
    const sourceB: QueueSource = { platform: 'wework', channelId: 'wework', channelType: 'wework', channelUserId: 'b', conversationId: 'b', senderId: 'b', weworkStreamId: 'stream-b', preferDirectReply: true };
    const [concurrentA, concurrentB] = await Promise.all([
      submitAndRun(sessionId, itemFor('concurrent a', sourceA, 'client-a'), sourceContext(sourceA, replies)),
      submitAndRun(sessionId, itemFor('concurrent b', sourceB, 'client-b'), sourceContext(sourceB, replies)),
    ]);
    assert.equal(concurrentA.generation, activated.generation); assert.equal(concurrentB.generation, activated.generation);
    assert.equal(supervisor.listStatuses().length, 1); assert.equal(supervisor.getStatus(sessionId)?.pid, activated.pid);
    assert.equal(store.countMailboxIntents(), 3); assert.equal((await fs.readJson(statePath)).history.length, 6);
    assert.equal(replies.length, 3); assert.equal(sourceContexts.size, 0);

    attachChannel('telegram-stage3', 'room', sessionId); await saveChannels();
    const fallbackSource: QueueSource = { platform: 'telegram', channelId: 'telegram-stage3', channelType: 'telegram', channelUserId: 'room', conversationId: 'room', senderId: 'fallback', preferDirectReply: true };
    const wrongContext = sourceContext({ ...fallbackSource, conversationId: 'wrong', channelUserId: 'wrong' }, replies);
    await submitAndRun(sessionId, itemFor('fallback ingress', fallbackSource, 'client-fallback'), wrongContext);
    assert.equal(attachmentSends.length, 1); assert.equal(attachmentSends[0].text, 'deterministic child answer');
    assert.equal(replies.length, 3); assert.equal(sourceContexts.size, 0);

    const extraRegistration = sourceContexts.register(sessionId, fallbackSource, sourceContext(fallbackSource, replies));
    try {
      await submitAndRun(sessionId, itemFor('ambiguous context ingress', fallbackSource, 'client-context-ambiguous'), sourceContext(fallbackSource, replies));
      assert.equal(attachmentSends.length, 2); assert.equal(replies.length, 3);
      assert.equal(sourceContexts.size, 1, 'submit cleanup must leave only the deliberately ambiguous registration');
    } finally { extraRegistration(); }
    assert.equal(sourceContexts.size, 0);

    const ambiguousSource: QueueSource = { ...sourceA, channelUserId: 'ambiguous', conversationId: 'ambiguous', senderId: 'ambiguous' };
    const originalRun = supervisor.runPendingActivated.bind(supervisor);
    (supervisor as any).runPendingActivated = async (...args: any[]) => {
      await originalRun(args[0], args[1], args[2]);
      throw new Error('injected ambiguous reply loss');
    };
    const repliesBeforeAmbiguity = replies.length; const cursorBeforeAmbiguity = store.getOwnership(sessionId).mailboxCursor;
    await assert.rejects(() => submitAndRun(sessionId, itemFor('ambiguous ingress', ambiguousSource, 'client-ambiguous'), sourceContext(ambiguousSource, replies)), /ambiguous reply loss/);
    (supervisor as any).runPendingActivated = originalRun;
    const afterAmbiguity = await fs.readJson(statePath);
    assert.ok(afterAmbiguity.lastAppliedMailboxId > cursorBeforeAmbiguity);
    assert.equal(store.getOwnership(sessionId).mailboxCursor, afterAmbiguity.lastAppliedMailboxId);
    assert.equal(replies.length, repliesBeforeAmbiguity + 1); assert.equal(attachmentSends.length, 2);
    assert.equal(sourceContexts.size, 0); assert.equal(mainSemanticCalls, 0);
    assert.deepEqual(await fs.readFile(SESSIONS_FILE), sessionsBefore);

    const archive = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true });
    try {
      const count = Number((archive.prepare('SELECT COUNT(*) AS count FROM archive_messages WHERE session_id=?').get(sessionId) as any).count);
      assert.equal(count, afterAmbiguity.history.length);
    } finally { archive.close(); }
  } finally {
    (sessionManager as any).getExistingSession = originals.getExistingSession;
    (sessionManager as any).enqueueSessionItem = originals.enqueueSessionItem;
    (sessionManager as any).saveSession = originals.saveSession;
    await shutdownSessionRuntime().catch(() => {});
    await supervisor.shutdown(5_000).catch(() => {}); store.close();
    unregisterChannel('telegram-stage3'); resetChannelsForTests(); setChannelsStoreForTests(null);
    await fs.remove(root);
  }
});
