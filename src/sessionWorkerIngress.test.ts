import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { registerChannel, unregisterChannel, type ChannelContext } from './channel';
import { SESSIONS_FILE } from './config';
import { shutdownSessionRuntime, initializeSessionRuntime, requestCompaction, submitAndRun } from './sessionRuntime';
import { createSessionRuntimeServiceHandler, sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { createChannelsStore, attachChannel, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import * as sessionManager from './sessionManager';
import { normalizeSessionWorkerIngressRequest, SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { QueueSource, Session } from './types';
import * as vector from './vector';

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

test('idle Main runtime compacts a real Worker archive through the canonical awaited plan engine', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-compact-')); const sessionId = 'worker-compact-real';
  const initial = baseSession(sessionId); initial.historyVersion = 3; initial.promptCacheKey = 'pre-compact-cache';
  initial.history = Array.from({ length: 12 }, (_, index) => ({
    role: 'user' as const, parts: [{ text: `message-${index + 1} ${'payload '.repeat(180)}` }],
    __meta: { seq: index + 1, timestamp: 1_700_000_000_000 + index },
  }));
  initial.contextFrontier = initial.history.map((_message, index) => ({ kind: 'message' as const, seq: index + 1 }));
  initial.nextMessageSeq = 13; initial.nextBlockId = 1; initial.meta.messageCount = 12;
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`); await fs.outputJson(statePath, serializeSessionHistoryPayload(initial));
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const plan = { createBlocksJson: JSON.stringify([{ level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 8,
    summary: 'Canonical compacted summary.', memoryFacts: [{ kind: 'decision', text: 'durable compact fact' }] }]) };
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, FOXWARM_TEST_SEED_ARCHIVE: '1', FOXWARM_TEST_COMPACT_PLAN: JSON.stringify(plan) },
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
  const catalog = sessionManager.getAllSessions(); catalog.set(sessionId, { ...initial, history: [] });
  const sessionsBefore = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null;
  const originals = { getExistingSession: sessionManager.getExistingSession, saveSession: sessionManager.saveSession,
    enqueueSessionItem: sessionManager.enqueueSessionItem, indexFacts: vector.indexMemoryFactsFromCompaction };
  let mainSemanticCalls = 0; const factCalls: any[] = [];
  (sessionManager as any).getExistingSession = async () => { mainSemanticCalls += 1; throw new Error('Main hydration forbidden'); };
  (sessionManager as any).saveSession = async () => { mainSemanticCalls += 1; throw new Error('Main save forbidden'); };
  (sessionManager as any).enqueueSessionItem = async () => { mainSemanticCalls += 1; throw new Error('Main enqueue forbidden'); };
  (vector as any).indexMemoryFactsFromCompaction = async (input: any) => { factCalls.push(input); return input.facts.length; };
  try {
    await supervisor.reconcileStartupOwnerships(); const activated = await supervisor.ensureWorker(sessionId);
    await supervisor.runPendingActivated(sessionId, { generation: activated.generation, incarnationId: activated.incarnationId });
    await initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });
    const result = await requestCompaction(sessionId, 0.3);
    assert.deepEqual(result, { kind: 'worker', completed: true, compacted: true, messageCount: 6 });
    const authority = await fs.readJson(statePath);
    assert.equal(authority.historyVersion, 4); assert.notEqual(authority.promptCacheKey, 'pre-compact-cache');
    assert.equal(authority.contextFrontier[0].kind, 'block'); assert.equal(authority.contextFrontier[0].rawStartSeq, 1); assert.equal(authority.contextFrontier[0].rawEndSeq, 8);
    assert.match(JSON.stringify(authority.history.at(-1)?.parts), /compact-completed/);
    assert.equal(authority.queue.some((item: any) => item.type === 'compact-commit'), false); assert.equal(store.countMailboxIntents(), 0);
    const projection = supervisor.projectionRegistry.get(sessionId)!;
    assert.equal(projection.generation, activated.generation); assert.equal(projection.projection?.messageCount, authority.history.length);
    const archive = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'));
    const block = archive.prepare('SELECT id, raw_start_seq, raw_end_seq, summary, memory_facts_json FROM archive_blocks WHERE session_id=?').get(sessionId) as any;
    archive.close(); assert.equal(block.raw_start_seq, 1); assert.equal(block.raw_end_seq, 8); assert.match(block.summary, /Canonical compacted summary/); assert.match(block.memory_facts_json, /durable compact fact/);
    for (let i = 0; i < 50 && factCalls.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(factCalls.length, 1); assert.equal(factCalls[0].sessionId, sessionId);
    const liveEntry = (supervisor as any).entries.get(sessionId); liveEntry.activeCalls = 1;
    await assert.rejects(() => requestCompaction(sessionId, 0.3), (error: any) => error?.code === 'SESSION_WORKER_COMPACTION_BUSY');
    liveEntry.activeCalls = 0;
    assert.deepEqual(await requestCompaction(sessionId, 0.3, true), {
      kind: 'unsupported', message: 'Tool-noise compaction is not supported by Session-worker placement yet.',
    });
    assert.equal(mainSemanticCalls, 0); assert.equal(sourceContexts.size, 0);
    const sessionsAfter = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null; assert.deepEqual(sessionsAfter, sessionsBefore);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExistingSession; (sessionManager as any).saveSession = originals.saveSession;
    (sessionManager as any).enqueueSessionItem = originals.enqueueSessionItem; (vector as any).indexMemoryFactsFromCompaction = originals.indexFacts;
    await shutdownSessionRuntime().catch(() => {}); await supervisor.shutdown(5_000).catch(() => {}); store.close(); catalog.delete(sessionId); await fs.remove(root);
  }
});

test('Main submitAndRun ensures, spawns, and owns exact worker ingress without Main semantic fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-ingress-'));
  const sessionId = 'worker-ingress-real';
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const sourceContexts = new SessionWorkerSourceContextRegistry();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root }, resolveExactFinalSourceContext: sourceContexts.resolve,
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, sourceContexts, id => id, () => true);
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
    let invalidRunCalls = 0; let invalidOwnershipLookups = 0; let invalidEnqueueCalls = 0; let invalidRegistryCalls = 0;
    const originalPrecheckRun = supervisor.runPendingActivated.bind(supervisor);
    const originalFindOwnership = store.findOwnership.bind(store); const originalEnqueueIntent = store.enqueueIntent.bind(store);
    const originalRegisterSource = sourceContexts.register.bind(sourceContexts);
    (supervisor as any).runPendingActivated = async (...args: any[]) => { invalidRunCalls += 1; return originalPrecheckRun(args[0], args[1], args[2]); };
    (store as any).findOwnership = (...args: any[]) => { invalidOwnershipLookups += 1; return originalFindOwnership(args[0]); };
    (store as any).enqueueIntent = (...args: any[]) => { invalidEnqueueCalls += 1; return originalEnqueueIntent(args[0], args[1], args[2], args[3]); };
    (sourceContexts as any).register = (...args: any[]) => { invalidRegistryCalls += 1; return originalRegisterSource(args[0], args[1], args[2]); };
    const validRef = { imageId: 'image-ref', blobId: 'blob-ref', mimeType: 'image/png', byteLength: 12, sha256: 'a'.repeat(64), width: 2, height: 3 };
    const validMeta = { imageId: 'image-ref', mimeType: 'image/png', width: 2, height: 3, sizeBytes: 12, sha256: 'a'.repeat(64) };
    const validPartsItem = itemFor('valid normalized parts', {
      platform: 'qqbot', channelId: 'qq', channelType: 'qqbot', channelUserId: 'room', conversationId: 'room',
      username: 'name', senderId: 'sender', weworkStreamId: 'stream', qqbotMessageId: 'message', preferDirectReply: true,
    }, 'valid-client');
    (validPartsItem.parts[0] as any).inlineDataRef = validRef; validPartsItem.parts[0].imageMeta = validMeta;
    assert.deepEqual(normalizeSessionWorkerIngressRequest({ sessionId, item: validPartsItem }), { sessionId, item: validPartsItem });
    const validMessageItem = { type: 'intersession' as const, sourceSessionId: 'origin', message: {
      role: 'user' as const, parts: [{ system: 'canonical message' }], modelVisible: true, __meta: { timestamp: 1, seq: 2 },
    } };
    assert.deepEqual(normalizeSessionWorkerIngressRequest({ sessionId, item: validMessageItem }), { sessionId, item: validMessageItem });
    const validSystemPayloadItem = { type: 'intersession' as const, message: {
      role: 'user' as const, parts: [{ text: 'payload', systemPayload: true }, { system: 'ordinary system', systemPayload: false }],
    } };
    assert.deepEqual(normalizeSessionWorkerIngressRequest({ sessionId, item: validSystemPayloadItem }), { sessionId, item: validSystemPayloadItem });

    const accessorPart: any = {}; Object.defineProperty(accessorPart, 'text', { enumerable: true, get() { throw new Error('accessor executed'); } });
    const cyclicRef: any = { ...validRef }; cyclicRef.path = cyclicRef;
    const symbolItem: any = itemFor('symbol', { platform: 'test', channelUserId: 'room' }, 'symbol'); symbolItem[Symbol('extra')] = true;
    const invalidItems: any[] = [
      { ...itemFor('extra', { platform: 'test', channelUserId: 'room' }, 'extra'), extra: true },
      { type: 'user', parts: [{}] }, { type: 'intersession', message: {} },
      { type: 'intersession', message: { role: 'user', parts: [{ text: 'x' }], extra: true } },
      { type: 'intersession', message: { role: 'user', parts: [{ system: 'inverted payload', systemPayload: true }] } },
      { type: 'user', parts: [{ text: 'x' }], message: { role: 'user', parts: [{ text: 'x' }] } },
      { type: 'user', parts: [{ text: 'x' }], clientMessageId: 7 },
      { type: 'user', parts: [{ text: 'x' }], clientMessageId: 'x'.repeat(513) },
      { type: 'user', parts: [{ text: 'x' }], source: { platform: 'test', channelUserId: 7 } },
      { type: 'user', parts: [{ text: 'x' }], source: { platform: 'test', channelUserId: 'x'.repeat(513) } },
      { type: 'intersession', parts: [{ system: 'x' }], sourceSessionId: 7 },
      { type: 'background', parts: [{ system: 'x' }], waitTimeoutId: 7 },
      { type: 'background', parts: [{ system: 'x' }], waitTimeoutId: 'x'.repeat(257) },
      { type: 'user', parts: [{ text: 'x', inlineDataRef: { ...validRef, sha256: 'bad' } }] },
      { type: 'user', parts: [{ text: 'x', imageMeta: { ...validMeta, width: Number.POSITIVE_INFINITY } }] },
      { type: 'user', parts: [accessorPart] },
      { type: 'user', parts: [{ text: 'x', inlineDataRef: cyclicRef }] },
      { type: 'user', parts: [{ text: () => 'x' }] }, symbolItem,
      { type: 'user', parts: [{ text: 'x'.repeat(1024 * 1024 + 1) }] },
    ];
    for (const invalidItem of invalidItems) {
      await assert.rejects(() => submitAndRun(sessionId, invalidItem), (error: any) => ['SESSION_WORKER_INGRESS_INVALID', 'SESSION_WORKER_INGRESS_TOO_LARGE'].includes(error?.code));
    }
    await assert.rejects(() => submitAndRun('x'.repeat(257), validPartsItem), (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID');
    await assert.rejects(() => submitAndRun(` ${sessionId}`, validPartsItem), (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID');

    let sourceGetterCalls = 0;
    const getterSource: any = { channelUserId: 'room' };
    Object.defineProperty(getterSource, 'platform', { enumerable: true, get() { sourceGetterCalls += 1; return 'test'; } });
    const symbolSource: any = { platform: 'test', channelUserId: 'room' }; symbolSource[Symbol('extra')] = true;
    const nonEnumerableSource: any = { platform: 'test', channelUserId: 'room' };
    Object.defineProperty(nonEnumerableSource, 'hidden', { enumerable: false, value: true });
    const probeContext = sourceContext({ platform: 'test', channelUserId: 'room', preferDirectReply: true }, replies);
    for (const source of [getterSource, symbolSource, nonEnumerableSource]) {
      await assert.rejects(
        () => submitAndRun(sessionId, { type: 'user', parts: [{ text: 'source probe' }], source } as any, probeContext),
        (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID',
      );
    }
    assert.equal(sourceGetterCalls, 0);
    const requestRegistry = new RpcServiceRegistry();
    requestRegistry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler({ worker: { store, registry: supervisor.projectionRegistry, ingress } }));
    const requestTransport = new LocalRpcTransport(requestRegistry); const requestClient = new RpcClient(sessionRuntimeServiceDescriptor, requestTransport);
    try {
      await assert.rejects(
        () => requestClient.call('submitAndRun', { sessionId, item: validPartsItem, extra: true } as any),
        (error: any) => error?.code === 'SESSION_WORKER_INGRESS_INVALID',
      );
    } finally { requestTransport.close(); }
    assert.equal(store.countMailboxIntents(), 0); assert.equal(sourceContexts.size, 0);
    assert.equal(invalidRunCalls, 0); assert.equal(invalidOwnershipLookups, 0); assert.equal(invalidEnqueueCalls, 0); assert.equal(invalidRegistryCalls, 0);
    assert.equal(mainSemanticCalls, 0);
    (supervisor as any).runPendingActivated = originalPrecheckRun;
    (store as any).findOwnership = originalFindOwnership; (store as any).enqueueIntent = originalEnqueueIntent;
    (sourceContexts as any).register = originalRegisterSource;
    await initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress } });
    await assert.rejects(
      () => submitAndRun(sessionId, { type: 'compact-commit', parts: [{ text: 'compact' }] } as any),
      (error: any) => error?.code === 'SESSION_WORKER_QUEUE_UNSUPPORTED',
    );
    assert.equal(store.countMailboxIntents(), 0); assert.equal(mainSemanticCalls, 0);
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
    // The first ordinary submission ensures and spawns the inactive exact Worker itself.
    const first = await submitAndRun(sessionId, itemFor('first ingress', qqSource, 'client-1'), firstContext);
    const activated = supervisor.getStatus(sessionId)!;
    assert.equal(activated.ready, true); assert.equal(store.getOwnership(sessionId).state, 'ready');
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
