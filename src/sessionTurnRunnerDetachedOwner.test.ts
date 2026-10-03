import test from 'node:test';
import assert from 'node:assert/strict';
import * as llm from './llm';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import * as configModule from './config';
import { loadModelsConfigFromObject } from './config';
import * as sessionManager from './sessionManager';
import { initArchiveStore } from './session/archiveStore';
import { readArchiveMessages } from './session/archive';
import { SessionAuthorityPostCommitError, writeAuthoritativeSessionState } from './session/stateFile';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { reconstructLlmRequest } from './llmRequestJournal';
import * as sessionHistory from './session/history';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { Message, QueueItem, Session } from './types';
import { logger } from './common';
import { putImageBlob, resolveImageBlobPath } from './imageBlobs';
import fs from 'fs-extra';
import sharp from 'sharp';

function createSession(id: string, text: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: 'detached system prompt',
    systemPromptFiles: [],
    snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [{ type: 'background', parts: [{ text }] }],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function createEffects(session: Session, events: string[]): llm.CurrentSessionTurnEffects {
  const persistSession = async (owner: Session) => {
    assert.strictEqual(owner, session);
    events.push(`persist:${owner.busy ? 'busy' : 'idle'}:${owner.history.length}`);
    await writeAuthoritativeSessionState(owner);
  };
  const notifyHistoryUpdate = (sessionId: string, message: Message) => {
    assert.equal(sessionId, session.id);
    events.push(`history:${message.role}`);
  };
  const appendMessages = async (owner: Session, messages: Message[]) => { await sessionManager.appendSessionMessagesForSession(
    owner,
    messages,
    () => persistSession(owner),
    notifyHistoryUpdate,
  ); };
  return {
    placement: 'local',
    appendMessage: (owner, message) => appendMessages(owner, [message]),
    appendMessages,
    appendQueuedMessages: (owner, messages) => sessionManager.appendQueuedSessionMessagesForSession(owner, messages, () => persistSession(owner), (_session, batch) => batch.forEach(message => notifyHistoryUpdate(owner.id, message))),
    persistSession,
    updateBusy: (owner, busy) => sessionManager.updateSessionBusyStateForSession(
      owner,
      busy,
      () => persistSession(owner),
      id => { events.push(`runtime-clear:${id}`); },
      id => { events.push(`state:${id}`); },
    ),
    startWait: (owner, options) => sessionManager.startSessionWaitForSession(owner, options, () => persistSession(owner)),
    notifyHistoryUpdate,
    notifySessionEvent: (_id, event) => { events.push(`stream:${event.type}`); },
    setRuntimeState: (_id, state) => { events.push(`runtime:${state.state}`); },
    clearRuntimeState: id => { events.push(`runtime-clear:${id}`); },
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async (_id, waitId) => {
      if (session.meta.wait?.id !== waitId) return false;
      delete session.meta.wait;
      await persistSession(session);
      return true;
    },
  };
}

async function withGlobalOwnerLookupsForbidden(run: () => Promise<void>): Promise<void> {
  const originals = {
    get: sessionManager.getSession,
    existing: sessionManager.getExistingSession,
    save: sessionManager.saveSession,
  };
  (sessionManager as any).getSession = async () => { throw new Error('global current-session get forbidden'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('global current-session existing lookup forbidden'); };
  (sessionManager as any).saveSession = async () => { throw new Error('global current-session save forbidden'); };
  try {
    await run();
  } finally {
    (sessionManager as any).getSession = originals.get;
    (sessionManager as any).getExistingSession = originals.existing;
    (sessionManager as any).saveSession = originals.save;
  }
}

test('detached exact owner completes canonical foreground provider turn', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_provider_${Date.now()}`, 'provider input');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session);
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
    assert.strictEqual(owner, session);
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'provider answer' }] });
    return { text: 'provider answer' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.history.length, 2);
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 0);
    const archived = await readArchiveMessages(session.id);
    assert.deepEqual(archived.map(record => record.message.role), ['user', 'model']);
    const persisted = await readSessionHistorySnapshot(session.id);
    assert.deepEqual((persisted?.history || []).map((message: Message) => message.role), ['user', 'model']);
    assert.equal(persisted?.busy, false);
    assert.deepEqual(events.filter(event => event.startsWith('history:')), ['history:user', 'history:model']);
    const modelNotify = events.indexOf('history:model');
    const modelPersist = events.findIndex((event, index) => index < modelNotify && event === 'persist:busy:2');
    assert.ok(modelPersist >= 0, 'archive/history mutation must persist before its history notification');
    assert.match(events[0], /^persist:busy:0$/);
    assert.equal(events.filter(event => event.startsWith('persist:')).at(-1), 'persist:idle:2');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('real exact-owner Responses stream durably archives commentary and error-checkpoint reasoning before retry input', async () => {
  await initArchiveStore();
  const session = createSession(`detached_responses_checkpoint_${Date.now()}`, 'work on an image');
  session.model = 'fixture/enabled';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="fixture/enabled" />\n\nsystem prompt';
  const effects = createEffects(session, []);
  const deliveries: string[] = [];
  session.broadcast = text => { if (text) deliveries.push(text); };
  const originalResolve = configModule.resolveModelConfig;
  const originalPost = axios.post;
  const models = loadModelsConfigFromObject({
    default: 'fixture/enabled',
    providers: { fixture: { providerType: 'openai-responses', baseUrl: 'https://example.test/v1',
      apiKey: 'test-key', keepReasoningOnError: true, models: ['enabled'] } },
  });
  (configModule as any).resolveModelConfig = () => ({ modelsConfig: models, defaultKey: models.default,
    currentKey: models.default, modelEntry: models.models[models.default], contextLimit: models.models[models.default].contextLimit });
  const firstStream = new PassThrough();
  const bodies: any[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) return { status: 200, statusText: 'OK', headers: {}, data: firstStream };
    const second = new PassThrough();
    process.nextTick(() => {
      for (const event of [
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] } },
        { type: 'response.completed', response: { output: [] as any[], usage: { input_tokens: 6, output_tokens: 3 } } },
      ]) second.write(`data: ${JSON.stringify(event)}\n\n`);
      second.end();
    });
    return { status: 200, statusText: 'OK', headers: {}, data: second };
  };
  const frame = (event: any) => firstStream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const running = withGlobalOwnerLookupsForbidden(() => new SessionTurnRunner(new LocalSessionTurnHost(effects, session))
      .processSessionQueue(session.id));
    for (let tries = 0; tries < 150 && bodies.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodies.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Drafting' }] } });
    for (let tries = 0; tries < 150 && !deliveries.includes('Drafting'); tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(deliveries.includes('Drafting'));
    let persisted = await readSessionHistorySnapshot(session.id);
    let archived = await readArchiveMessages(session.id);
    assert.deepEqual(persisted?.history.filter((message: Message) => message.role === 'model').map((message: Message) => message.parts[0]?.text), ['Drafting']);
    assert.deepEqual(archived.filter(record => record.message.role === 'model').map(record => record.message.parts[0]?.text), ['Drafting']);
    assert.equal(bodies.length, 1, 'commentary is durable before the first provider response ends');
    frame({ type: 'response.output_item.done', output_index: 1,
      item: { type: 'reasoning', id: 'drop-this-upstream-id', summary: [{ type: 'summary_text', text: 'opaque progress' }],
        encrypted_content: 'archive-opaque-checkpoint' } });
    frame({ type: 'response.failed', response: { error: { message: 'upstream interrupted' } } });
    firstStream.end();
    for (let tries = 0; tries < 150 && !session.history.some(message => message.__meta?.noticeType === 'llm-retry'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(session.history.some(message => message.__meta?.noticeType === 'llm-retry'));
    assert.equal(bodies.length, 1, 'queued correction arrives during the existing retry backoff');
    session.queue.push(
      { type: 'user', parts: [{ text: 'retry correction A' }] },
      { type: 'background', parts: [{ text: 'retry correction B' }] },
    );
    for (let tries = 0; tries < 150 && bodies.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodies.length, 2);
    persisted = await readSessionHistorySnapshot(session.id);
    archived = await readArchiveMessages(session.id);
    const persistedModels: Message[] = persisted?.history.filter((message: Message) => message.role === 'model') || [];
    assert.deepEqual(persistedModels.slice(0, 2).map(message => message.__meta?.llmSegment), [
      { outputStart: 0, outputEndExclusive: 1, complete: false },
      { outputStart: 1, outputEndExclusive: 2, complete: false },
    ]);
    assert.equal(persistedModels[1].parts[0].providerMeta?.encryptedThinking, 'archive-opaque-checkpoint');
    assert.equal(archived.filter(record => record.message.role === 'model')[1].message.parts[0].providerMeta?.encryptedThinking,
      'archive-opaque-checkpoint');
    assert.equal(JSON.stringify(bodies[1].input).includes('archive-opaque-checkpoint'), true);
    assert.equal(JSON.stringify(bodies[1].input).includes('drop-this-upstream-id'), false);
    for (const text of ['Drafting', 'archive-opaque-checkpoint', 'retry correction A', 'retry correction B']) {
      assert.equal(JSON.stringify(bodies[1].input).split(text).length - 1, 1);
    }
    const historyText = session.history.map(message => message.parts[0]?.text);
    assert.ok(historyText.indexOf('retry correction A') > historyText.indexOf(undefined));
    assert.equal(historyText.indexOf('retry correction B'), historyText.indexOf('retry correction A') + 1);
    await running;
    assert.deepEqual(session.history.filter(message => message.role === 'model' && message.modelVisible !== false)
      .map(message => message.parts[0]?.text), ['Drafting', undefined, 'done']);
    assert.equal(deliveries.filter(text => text === 'Drafting').length, 1);
    assert.equal(bodies.length, 2, 'queued corrections belong to the retry, not a later provider turn');
    const final = session.history.find(message => message.parts[0]?.text === 'done')!;
    assert.notEqual(final.__meta?.llmRequestId, persistedModels[0].__meta?.llmRequestId);
    const journal = await reconstructLlmRequest(final.__meta!.llmRequestId!);
    assert.equal(journal.completeness, 'complete');
    if (journal.completeness === 'complete') {
      for (const text of ['Drafting', 'archive-opaque-checkpoint', 'retry correction A', 'retry correction B']) {
        assert.equal(JSON.stringify(journal.messages).split(text).length - 1, 1);
      }
    }
  } finally {
    (axios as any).post = originalPost;
    (configModule as any).resolveModelConfig = originalResolve;
    firstStream.destroy();
  }
});

test('retry applies a real ready compact-only commit and rebuilds history and system snapshot within the same budget', async () => {
  await initArchiveStore();
  const session = createSession(`retry_compact_only_${Date.now()}`, 'current turn input');
  session.model = 'fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="fixture/model" />\n\nbefore compact snapshot';
  session.promptCacheKey = llm.generatePromptCacheKey();
  const originalKey = session.promptCacheKey;
  const events: string[] = [];
  const effects = createEffects(session, events);
  const phases: string[] = [];
  effects.setRuntimeState = (_id, state) => { phases.push(state.active?.phase || state.state); };
  await effects.appendMessages(session, [
    { role: 'user', parts: [{ text: `older compact input ${'alpha '.repeat(3000)}` }] },
    { role: 'model', parts: [{ text: `older compact answer ${'bravo '.repeat(3000)}` }] },
    { role: 'user', parts: [{ text: 'recent kept input' }] },
    { role: 'model', parts: [{ text: 'recent kept answer' }] },
  ]);
  const deps: sessionHistory.SessionHistoryDeps = {
    getSessionById: id => id === session.id ? session : undefined,
    getExistingSession: async id => id === session.id ? session : null,
    saveSession: () => effects.persistSession(session),
    enqueueSessionItem: async (_id, item) => { session.queue.push(item); },
  };
  const originalResolve = configModule.resolveModelConfig;
  const originalPost = axios.post;
  const originalChat = llm.chat;
  const originalSnapshot = llm.buildSessionSystemPromptSnapshotForSession;
  const models = loadModelsConfigFromObject({ default: 'fixture/model', providers: {
    fixture: { providerType: 'openai-completions', baseUrl: 'https://example.test/v1', apiKey: 'test-key', models: ['model'] },
  } });
  (configModule as any).resolveModelConfig = () => ({ modelsConfig: models, defaultKey: models.default,
    currentKey: models.default, modelEntry: models.models[models.default], contextLimit: models.models[models.default].contextLimit });
  (llm as any).buildSessionSystemPromptSnapshotForSession = async () => '<foxwarm-current-model model-id="fixture/model" />\n\nafter compact snapshot';
  (llm as any).chat = async (parts: any, owner: Session, iteration: number, options: any) => {
    if (options?.purpose !== 'compact-plan') return originalChat(parts, owner, iteration, options);
    const call = { id: 'retry-compact-plan', name: 'submit_compact_plan', args: { replaceAsBlocks: [
      { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'retry compact summary' },
    ] } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: call }] });
    return { text: '', toolCalls: [call], allParts: [{ functionCall: call }] };
  };
  const bodies: any[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) {
      await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.6 }, 'background');
      for (let tries = 0; tries < 150 && !sessionHistory.hasCompletedCompactJob(session.id); tries++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(sessionHistory.hasCompletedCompactJob(session.id), true);
      // Ready work is not discovered only by queue length or a wake marker.
      session.queue = session.queue.filter(item => item.type !== 'compact-commit');
      assert.equal(session.queue.length, 0);
      throw new Error('retry after compact becomes ready');
    }
    assert.equal(phases.at(-1), 'normal-turn', 'retry dispatch must not retain the completed compaction phase');
    assert.ok(phases.includes('compaction'));
    const stream = new PassThrough();
    process.nextTick(() => {
      stream.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'compact retry done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  const host = new LocalSessionTurnHost(effects, session, {
    hasCompletedCompactJob: sessionHistory.hasCompletedCompactJob,
    applyCompletedCompactJob: id => sessionHistory.applyCompletedCompactJob(deps, id),
  });
  try {
    await withGlobalOwnerLookupsForbidden(() => new SessionTurnRunner(host).processSessionQueue(session.id));
    assert.equal(bodies.length, 2);
    assert.equal(JSON.stringify(bodies[0]).includes('older compact input'), true);
    assert.equal(JSON.stringify(bodies[1]).includes('older compact input'), false);
    assert.equal(JSON.stringify(bodies[1]).split('retry compact summary').length - 1, 1);
    assert.equal(JSON.stringify(bodies[1]).split('current turn input').length - 1, 1);
    assert.equal(JSON.stringify(bodies[1]).includes('after compact snapshot'), true);
    assert.equal(JSON.stringify(bodies[1]).includes('before compact snapshot'), false);
    assert.equal(session.promptCacheKey, originalKey, 'compact inherits the current prefix lineage');
    const final = session.history.find(message => message.parts[0]?.text === 'compact retry done')!;
    assert.equal(final.__meta?.llmAttempt, 1);
    const journal = await reconstructLlmRequest(final.__meta!.llmRequestId!);
    assert.equal(journal.completeness, 'complete');
    if (journal.completeness === 'complete') {
      assert.equal(JSON.stringify(journal.messages).includes('retry compact summary'), true);
      assert.equal(journal.systemPrompt.includes('after compact snapshot'), true);
    }
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
  } finally {
    sessionHistory.discardPendingCompactWork(session.id);
    (axios as any).post = originalPost;
    (configModule as any).resolveModelConfig = originalResolve;
    (llm as any).chat = originalChat;
    (llm as any).buildSessionSystemPromptSnapshotForSession = originalSnapshot;
  }
});

test('normal turn delivers only this committed response images, independently of empty text and later turns', async () => {
  await initArchiveStore();
  const session = createSession(`generated_media_runner_${Date.now()}`, 'draw one');
  const effects = createEffects(session, []);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#4488aa' } }).png().toBuffer();
  const first = await putImageBlob({ buffer: png, mimeType: 'image/png', imageId: 'ig_one' });
  const second = { ...first, imageId: 'ig_two' };
  const deliveries: string[][] = [];
  const host = new LocalSessionTurnHost(effects, session, {
    deliverGeneratedImages: async (_session, images) => { deliveries.push(images.map(image => image.imageId)); },
  });
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let calls = 0;
  const toolCall = { id: 'generated_media_test_call', name: 'synthetic', args: {} };
  (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
    assert.strictEqual(owner, session);
    if (parts) await options.appendMessage({ role: 'user', parts });
    calls++;
    const assistant: Message = {
      role: 'model',
      parts: calls === 1
        ? [{ inlineDataRef: first, imageMeta: { imageId: first.imageId, origin: 'generated' } }]
        : calls === 2 ? [{ text: 'second reply' },
          { inlineDataRef: second, imageMeta: { imageId: second.imageId, origin: 'generated' } },
          { inlineDataRef: first, imageMeta: { imageId: first.imageId, origin: 'generated' } },
          { functionCall: toolCall }] : [{ text: 'follow-up after tool' }],
    };
    await options.appendMessage(assistant);
    await options.onCommittedAssistantMessage(assistant);
    return { text: calls === 1 ? '' : calls === 2 ? 'second reply' : 'follow-up after tool',
      allParts: assistant.parts, ...(calls === 2 ? { toolCalls: [toolCall] } : {}) };
  };
  (llm as any).executeTools = async () => ({ role: 'tool', parts: [{
    functionResponse: { tool_use_id: toolCall.id, name: toolCall.name, response: { output: 'ok' } },
  }] });
  try {
    await withGlobalOwnerLookupsForbidden(() => new SessionTurnRunner(host).processSessionQueue(session.id));
    assert.deepEqual(deliveries, [['ig_one']]);
    session.queue.push({ type: 'background', parts: [{ text: 'draw another' }] });
    await withGlobalOwnerLookupsForbidden(() => new SessionTurnRunner(host).processSessionQueue(session.id));
    assert.deepEqual(deliveries, [['ig_one'], ['ig_two', 'ig_one']]);
    assert.equal(calls, 3);
    assert.equal(session.history.filter(message => message.role === 'model').length, 3);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    await fs.remove(resolveImageBlobPath(first.blobId!));
  }
});

test('selected ordinary prefix commits one complete authority batch before postcommit interruption', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_partial_prefix_${Date.now()}`, 'first queued input');
  session.busy = true;
  session.queue.push({ type: 'background', parts: [{ text: 'second queued input' }] });
  const effects = createEffects(session, []);
  let persistCount = 0;
  const appendMessages = async (owner: Session, messages: Message[]) => { await sessionManager.appendSessionMessagesForSession(
    owner,
    messages,
    async () => {
      persistCount += 1;
      await writeAuthoritativeSessionState(owner);
      if (persistCount === 1) {
        throw new SessionAuthorityPostCommitError('stop after the first selected-prefix authority commit');
      }
    },
    () => {},
  ); };
  effects.appendMessage = (owner, message) => appendMessages(owner, [message]);
  effects.appendMessages = appendMessages;
  effects.appendQueuedMessages = async (owner, messages) => { await sessionManager.appendQueuedSessionMessagesForSession(owner, messages, async () => {
    persistCount += 1;
    await writeAuthoritativeSessionState(owner);
    throw new SessionAuthorityPostCommitError('stop after selected-prefix authority commit');
  }, () => {}); };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));

  const selected = (runner as any).drainLeadingQueuedTurnInputs(session) as QueueItem[];
  assert.equal(selected.length, 2);
  assert.equal(session.queue.length, 0);
  await assert.rejects(
    () => (runner as any).appendQueuedTurnInputs(session, session.id, selected),
    error => error instanceof SessionAuthorityPostCommitError,
  );

  const authority = await readSessionHistorySnapshot(session.id);
  assert.deepEqual(authority?.queue, []);
  assert.deepEqual((authority?.history || []).map((message: Message) => message.parts.find(part => part.text)?.text), ['first queued input', 'second queued input']);
});

test('one owned processor sends many different-source rows in one provider turn and one busy claim/release', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_many_sources_${Date.now()}`, 'unused');
  session.queue = Array.from({ length: 128 }, (_, index) => ({
    type: 'user' as const,
    source: {
      platform: 'qqbot', channelId: 'qq', channelUserId: `c2c:user-${index}`,
      conversationId: `c2c:user-${index}`, qqbotMessageId: `message-${index}`,
    },
    parts: [{ text: `turn-${index}` }],
  }));
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    turnIds.push(options.turnId);
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${turnIds.length}` }] });
    return { text: `done-${turnIds.length}` };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(turnIds.length, 1);
    assert.equal(new Set(turnIds).size, 1);
    assert.equal(session.history.length, 129);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2, 'one busy claim and one release own all turns');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('one owned processor applies ready compaction before all ordinary input across wake markers', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_compact_turn_compact_${Date.now()}`, 'unused');
  session.queue = [
    { type: 'user', parts: [{ text: 'before compact marker' }] },
    { type: 'compact-commit' },
    { type: 'background', parts: [{ text: 'after compact marker' }] },
    { type: 'compact-commit' },
  ];
  const events: string[] = [];
  let compactApplies = 0;
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session, {
    hasCompletedCompactJob: () => compactApplies === 0,
    applyCompletedCompactJob: async () => {
      assert.equal(session.history.length, 0, 'ready compaction precedes canonical queued input');
      compactApplies += 1;
      return true;
    },
  });
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    assert.equal(compactApplies, 1);
    assert.deepEqual(session.history.map(message => message.parts[0].text), ['before compact marker', 'after compact marker']);
    await options.appendMessage({ role: 'model', parts: [{ text: 'between done' }] });
    return { text: 'between done' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(compactApplies, 1);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'user', 'model']);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('provider continuation commits a ready job before all follow-ups even before its wake marker exists', async () => {
  await initArchiveStore();
  const session = createSession(`detached_ready_followups_${Date.now()}`, 'initial input');
  const events: string[] = [];
  let ready = false;
  let applies = 0;
  const host = new LocalSessionTurnHost(createEffects(session, events), session, {
    hasCompletedCompactJob: () => ready,
    applyCompletedCompactJob: async () => {
      assert.equal(session.history.at(-1)?.parts[0].text, 'first provider result');
      assert.equal(session.history.some(message => message.parts[0].text === 'follow-up A'), false);
      applies += 1;
      ready = false;
      return true;
    },
  });
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  let requests = 0;
  (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
    requests += 1;
    if (requests === 1) {
      await options.appendMessage({ role: 'model', parts: [{ text: 'first provider result' }] });
      owner.queue.push(
        { type: 'user', parts: [{ text: 'follow-up A' }] },
        { type: 'background', parts: [{ text: 'follow-up B' }] },
      );
      ready = true;
      return { text: 'first provider result' };
    }
    assert.equal(applies, 1);
    assert.deepEqual(owner.history.slice(-2).map(message => message.parts[0].text), ['follow-up A', 'follow-up B']);
    await options.appendMessage({ role: 'model', parts: [{ text: 'final provider result' }] });
    return { text: 'final provider result' };
  };
  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(requests, 2);
    assert.equal(applies, 1);
    assert.equal(session.queue.length, 0);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
  } finally { (llm as any).chat = originalChat; }
});

test('stale wake signals and failed or no-op jobs do not split or swallow ordinary input', async () => {
  await initArchiveStore();
  const originalChat = llm.chat;
  try {
    for (const outcome of ['signal-only', 'absent', 'noop', 'failed'] as const) {
      const session = createSession(`detached_compact_${outcome}_${Date.now()}`, 'unused');
      session.queue = outcome === 'signal-only' ? [{ type: 'compact-commit' }] : [
        { type: 'user', parts: [{ text: 'input A' }] },
        { type: 'compact-commit' },
        { type: 'background', parts: [{ text: 'input B' }] },
      ];
      const events: string[] = [];
      let ready = outcome === 'noop' || outcome === 'failed';
      let applies = 0;
      let requests = 0;
      const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, events), session, {
        hasCompletedCompactJob: () => ready,
        applyCompletedCompactJob: async () => {
          ready = false;
          applies += 1;
          if (outcome === 'failed') throw new Error('planning failed');
          return false;
        },
      }));
      (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
        requests += 1;
        assert.deepEqual(owner.history.map(message => message.parts[0].text), ['input A', 'input B']);
        await options.appendMessage({ role: 'model', parts: [{ text: 'done' }] });
        return { text: 'done' };
      };
      await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
      assert.equal(requests, outcome === 'signal-only' ? 0 : 1);
      assert.equal(applies, outcome === 'noop' || outcome === 'failed' ? 1 : 0);
      assert.equal(events.filter(event => event === 'runtime:requesting-model').length, applies + requests);
      assert.equal(session.queue.length, 0);
    }
  } finally { (llm as any).chat = originalChat; }
});

test('a failed canonical append replays the whole ordinary batch without replaying compact signals', async () => {
  await initArchiveStore();
  const session = createSession(`detached_compact_batch_rollback_${Date.now()}`, 'unused');
  session.queue = [
    { type: 'user', parts: [{ text: 'rollback input A' }] },
    { type: 'compact-commit' },
    { type: 'background', parts: [{ text: 'rollback input B' }] },
  ];
  const events: string[] = [];
  const effects = createEffects(session, events);
  let appends = 0;
  let ready = true;
  let applies = 0;
  effects.appendQueuedMessages = (owner, messages) => sessionManager.appendQueuedSessionMessagesForSession(owner, messages, async () => {
    appends += 1;
    assert.deepEqual(messages.map(message => message.parts[0].text), ['rollback input A', 'rollback input B']);
    if (appends === 1) throw new Error('injected queued append persistence failure');
    await writeAuthoritativeSessionState(owner);
  });
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session, {
    hasCompletedCompactJob: () => ready,
    applyCompletedCompactJob: async () => { ready = false; applies += 1; return true; },
  }));
  const originalChat = llm.chat;
  let requests = 0;
  (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
    requests += 1;
    assert.deepEqual(owner.history.filter(message => message.role === 'user').map(message => message.parts[0].text), ['rollback input A', 'rollback input B']);
    await options.appendMessage({ role: 'model', parts: [{ text: 'replayed batch done' }] });
    return { text: 'replayed batch done' };
  };
  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(appends, 2);
    assert.equal(applies, 1);
    assert.equal(requests, 1);
    assert.equal(session.queue.length, 0);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
  } finally { (llm as any).chat = originalChat; }
});

test('retry consumes a later different-source queued row in the same provider turn', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_retry_then_queue_${Date.now()}`, 'unused');
  session.history = [{
    role: 'user',
    parts: [{ system: '<foxwarm-system kind="event" type="trigger">interrupted continuation seed</foxwarm-system>' }],
  }];
  session.queue = [{
    type: 'user',
    source: { platform: 'qqbot', channelId: 'qq', channelUserId: 'c2c:later', conversationId: 'c2c:later', qqbotMessageId: 'later-message' } as any,
    parts: [{ text: 'later queued turn' }],
  }];
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    turnIds.push(options.turnId);
    await options.appendMessage({ role: 'model', parts: [{ text: `result-${turnIds.length}` }] });
    return { text: `result-${turnIds.length}` };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionRetry(session.id));
    assert.equal(turnIds.length, 1);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'user', 'model']);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('retry preparation selects one strict batch and leaves input arriving during persistence for a later safe point', async () => {
  await initArchiveStore();
  const session = createSession(`retry_finite_batch_${Date.now()}`, 'correction A');
  session.queue.push({ type: 'background', parts: [{ text: 'correction B' }] });
  const effects = createEffects(session, []);
  const originalAppend = effects.appendQueuedMessages;
  let appends = 0;
  effects.appendQueuedMessages = async (owner, messages) => {
    appends++;
    assert.deepEqual(messages.map(message => message.parts[0].text), ['correction A', 'correction B']);
    await new Promise(resolve => setImmediate(resolve));
    session.queue.push({ type: 'user', parts: [{ text: 'later correction' }] });
    await originalAppend(owner, messages);
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  assert.equal(await (runner as any).prepareLlmRetry(session, 0, new AbortController().signal), true);
  assert.equal(appends, 1);
  assert.deepEqual(session.history.map(message => message.parts[0].text), ['correction A', 'correction B']);
  assert.equal(session.queue[0].parts[0].text, 'later correction');
});

test('Stop during retry compact prevents queue selection after the awaited compact boundary', async () => {
  const session = createSession(`retry_compact_stop_${Date.now()}`, 'must remain queued');
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, []), session, {
    hasCompletedCompactJob: () => true,
    applyCompletedCompactJob: async () => {
      await new Promise(resolve => setImmediate(resolve));
      session.stopping = true;
      return true;
    },
  }));
  await assert.rejects(() => (runner as any).prepareLlmRetry(session, 0, new AbortController().signal), llm.isAbortError);
  assert.equal(session.queue.length, 1);
  assert.equal(session.history.length, 0);
});

test('strict queued append failure during real retry restores input and blocks the next provider attempt', async () => {
  await initArchiveStore();
  const session = createSession(`retry_strict_append_failure_${Date.now()}`, 'unused');
  session.queue = [];
  session.busy = true;
  session.model = 'fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="fixture/model" />\n\nretry prompt';
  const effects = createEffects(session, []);
  effects.appendQueuedMessages = (owner, messages) => sessionManager.appendQueuedSessionMessagesForSession(owner, messages, async () => {
    throw new Error('retry queue strict persistence failed');
  });
  const originalPost = axios.post;
  const originalResolve = configModule.resolveModelConfig;
  const models = loadModelsConfigFromObject({ default: 'fixture/model', providers: {
    fixture: { providerType: 'openai-completions', baseUrl: 'https://example.test/v1', apiKey: 'test-key', models: ['model'] },
  } });
  (configModule as any).resolveModelConfig = () => ({ modelsConfig: models, defaultKey: models.default,
    currentKey: models.default, modelEntry: models.models[models.default], contextLimit: models.models[models.default].contextLimit });
  let requests = 0;
  (axios as any).post = async () => {
    requests++;
    session.queue.push({ type: 'user', parts: [{ text: 'uncommitted correction' }] });
    throw new Error('initial mock provider outage');
  };
  try {
    const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
    await withGlobalOwnerLookupsForbidden(() => (runner as any).runSessionTurn(session.id, { parts: [{ text: 'initial request' }], session }));
    assert.equal(requests, 1);
    assert.equal(session.queue.length, 1, 'existing strict append rollback restores the selected input');
    assert.equal(session.history.some(message => message.parts[0].text === 'uncommitted correction'), false);
    assert.ok(session.history.some(message => message.parts[0].text?.includes('retry queue strict persistence failed')),
      'preparation failure follows the ordinary local owner error path');
    assert.equal(session.history.filter(message => message.__meta?.noticeType === 'llm-retry').length, 1,
      'local preparation failure does not generate another provider retry notice');
  } finally {
    (axios as any).post = originalPost;
    (configModule as any).resolveModelConfig = originalResolve;
  }
});

test('active managed step without a matching yield executes once and releases the one outer claim', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_managed_release_${Date.now()}`, 'managed pending input');
  session.meta.managedSession = {
    ownerSessionId: 'controller', leaseId: 'lease', revision: 1, pendingInbox: [],
    openedAt: Date.now(), leaseTouchedAt: Date.now(), currentStep: { stepId: 'step', runMode: 'idle' },
  };
  const events: string[] = [];
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, events), session));
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    providerCalls += 1;
    await options.appendMessage({ role: 'model', parts: [{ text: 'managed step done' }] });
    return { text: 'managed step done' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(providerCalls, 1);
    assert.equal(session.queue.length, 0);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.meta.managedSession?.lastStepResult?.stepId, 'step');
    assert.equal(session.meta.managedSession?.lastStepResult?.yieldReason, 'idle');
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('already-yielded matching managed step leaves queued work durable without reentry', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_managed_yielded_${Date.now()}`, 'managed retained input');
  session.meta.managedSession = {
    ownerSessionId: 'controller', leaseId: 'lease', revision: 1, pendingInbox: [],
    openedAt: Date.now(), leaseTouchedAt: Date.now(), currentStep: { stepId: 'step', runMode: 'idle' },
    lastStepResult: { stepId: 'step', yieldReason: 'idle', yieldedAt: Date.now() },
  };
  const events: string[] = [];
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, events), session));
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async () => { providerCalls += 1; throw new Error('yielded managed step must not reenter provider'); };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(providerCalls, 0);
    assert.equal(session.queue.length, 1);
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(providerCalls, 0);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('local post-final child-reminder failure keeps one provider final and releases busy', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_post_final_reminder_${Date.now()}`, 'provider input');
  session.parentSessionId = 'parent-session';
  const events: string[] = [];
  const finals: Array<{ text: string; options?: any }> = [];
  let postFinalCompactChecks = 0;
  session.broadcast = (text, options) => { finals.push({ text, options }); };
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session, {
    queueSessionSystemEvent: async () => { throw new Error('local reminder persistence failed'); },
    checkAndCompactIfNeeded: async () => { postFinalCompactChecks += 1; },
  });
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'provider success' }] });
    return { text: 'provider success' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.deepEqual(finals.map(item => [item.text, item.options?.turnFinal]), [['provider success', true]]);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.history.some(message => JSON.stringify(message.parts).includes('local reminder persistence failed')), false);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(postFinalCompactChecks, 1);
    assert.equal(events.filter(event => event.startsWith('persist:')).at(-1), 'persist:idle:2');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('persisted child-handoff state exclusively drives reminder boundaries, resolution, and transparency', async () => {
  await initArchiveStore();
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;

  async function runCase(options: {
    name: string;
    queue: QueueItem[];
    initialState?: Session['childHandoffState'];
    response?: string;
    successfulSendTargets?: string[];
    failedSend?: boolean;
    addPendingInput?: boolean;
    addStaleCompactSignal?: boolean;
  }): Promise<{ session: Session; reminders: string[] }> {
    const session = createSession(`child_handoff_${options.name}_${Date.now()}_${Math.random()}`, 'unused');
    session.parentSessionId = 'parent-session';
    session.queue = structuredClone(options.queue);
    if (options.initialState) session.childHandoffState = structuredClone(options.initialState);
    const reminders: string[] = [];
    const effects = createEffects(session, []);
    let addedPendingInput = false;
    const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session, {
      deliverCommittedFinal: async () => {
        if (options.addPendingInput && !addedPendingInput) {
          addedPendingInput = true;
          session.queue.push({ type: 'user', parts: [{ text: 'pending ordinary input at final delivery' }] });
        }
      },
      queueSessionSystemEvent: async (_id, reminder) => { reminders.push(reminder); },
      checkAndCompactIfNeeded: async () => {},
      applyCompletedCompactJob: async () => true,
    }));
    let providerIteration = 0;
    (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, chatOptions: any) => {
      if (options.successfulSendTargets || options.failedSend) {
        if (providerIteration++ === 0) {
          await chatOptions.appendMessage({ role: 'model', parts: [{ functionCall: {
            id: 'send', name: 'send_to_session', args: { sessionId: options.failedSend ? 'missing' : options.successfulSendTargets![0] },
          } }] });
          return { text: '', toolCalls: [{
            id: 'send', name: 'send_to_session', args: { sessionId: options.failedSend ? 'missing' : options.successfulSendTargets![0] },
          }] };
        }
      }
      if (options.addStaleCompactSignal) {
        session.queue.push({ type: 'compact-commit' });
      }
      const text = options.response ?? 'done';
      await chatOptions.appendMessage({ role: 'model', parts: [{ text }] });
      return { text };
    };
    (llm as any).executeTools = async () => ({
      role: 'tool',
      parts: [{ functionResponse: {
        tool_use_id: 'send', name: 'send_to_session',
        response: options.failedSend ? { error: 'failed send' } : { output: 'sent' },
      } }],
      ...(!options.failedSend && options.successfulSendTargets
        ? { __toolPostAction: { successfulSendToSessionTargets: options.successfulSendTargets } }
        : {}),
    });
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    return { session, reminders };
  }

  try {
    for (const relation of ['parent', 'other'] as const) {
      const result = await runCase({
        name: relation,
        queue: [{ type: 'intersession', sourceSessionId: `${relation}-source`, sourceSessionRelation: relation, parts: [{ text: 'assignment' }] }],
      });
      assert.deepEqual(result.session.childHandoffState, { boundary: 'report-required', resolved: false });
      assert.equal(result.reminders.length, 1);
    }

    const transparentChild = await runCase({
      name: 'child-transparent',
      initialState: { boundary: 'report-required', resolved: false },
      queue: [{ type: 'intersession', sourceSessionId: 'direct-child', sourceSessionRelation: 'direct-child', parts: [{ text: 'child report' }] }],
    });
    assert.deepEqual(transparentChild.session.childHandoffState, { boundary: 'report-required', resolved: false });
    assert.equal(transparentChild.reminders.length, 1);

    for (const type of ['background', 'trigger', 'onboot'] as const) {
      const transparentMaintenance = await runCase({
        name: `maintenance-${type}`,
        initialState: { boundary: 'report-required', resolved: false },
        queue: [{ type, parts: [{ system: `<foxwarm-system kind="${type}">maintenance</foxwarm-system>` }] }],
      });
      assert.deepEqual(transparentMaintenance.session.childHandoffState, { boundary: 'report-required', resolved: false });
      assert.equal(transparentMaintenance.reminders.length, 1);
    }

    const alreadyResolved = await runCase({
      name: 'already-resolved',
      initialState: { boundary: 'report-required', resolved: true },
      queue: [{ type: 'background', parts: [{ text: 'transparent maintenance after report' }] }],
    });
    assert.deepEqual(alreadyResolved.session.childHandoffState, { boundary: 'report-required', resolved: true });
    assert.equal(alreadyResolved.reminders.length, 0);

    const directUser = await runCase({
      name: 'direct-user',
      initialState: { boundary: 'report-required', resolved: false },
      queue: [{ type: 'user', parts: [{ text: 'new direct user request' }] }],
    });
    assert.deepEqual(directUser.session.childHandoffState, { boundary: 'direct-user', resolved: true });
    assert.equal(directUser.reminders.length, 0);

    const parentSend = await runCase({
      name: 'parent-send',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      successfulSendTargets: ['parent-session'],
    });
    assert.deepEqual(parentSend.session.childHandoffState, { boundary: 'report-required', resolved: true });
    assert.equal(parentSend.reminders.length, 0);

    const wrongTarget = await runCase({
      name: 'wrong-target-send',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      successfulSendTargets: ['unrelated-session'],
    });
    assert.deepEqual(wrongTarget.session.childHandoffState, { boundary: 'report-required', resolved: false });
    assert.equal(wrongTarget.reminders.length, 1);

    const failedSend = await runCase({
      name: 'failed-send',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      failedSend: true,
    });
    assert.deepEqual(failedSend.session.childHandoffState, { boundary: 'report-required', resolved: false });
    assert.equal(failedSend.reminders.length, 1);

    const noAction = await runCase({
      name: 'no-action',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      response: 'Nothing further is needed. [NO_ACTION]',
    });
    assert.deepEqual(noAction.session.childHandoffState, { boundary: 'report-required', resolved: true });
    assert.equal(noAction.reminders.length, 0);

    const queueGuard = await runCase({
      name: 'queue-guard',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      addPendingInput: true,
    });
    assert.deepEqual(queueGuard.session.childHandoffState, { boundary: 'direct-user', resolved: true });
    assert.equal(queueGuard.session.history.filter(message => message.parts[0].text === 'pending ordinary input at final delivery').length, 1);
    assert.equal(queueGuard.reminders.length, 0);
    assert.equal(queueGuard.session.queue.length, 0);

    const staleSignal = await runCase({
      name: 'stale-signal',
      queue: [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
      addStaleCompactSignal: true,
    });
    assert.deepEqual(staleSignal.session.childHandoffState, { boundary: 'report-required', resolved: false });
    assert.equal(staleSignal.reminders.length, 1, 'a compact wake signal is not pending input');
    assert.equal(staleSignal.session.queue.length, 0);

    const absentState = await runCase({
      name: 'absent-state-history',
      queue: [{ type: 'background', parts: [{ text: 'history that previously looked report-required' }] }],
    });
    assert.equal(absentState.session.childHandoffState, undefined);
    assert.equal(absentState.reminders.length, 0, 'no explicit state means no inferred reminder');
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
  }
});

test('Stop bulk commit applies child-handoff boundaries in queue order and preserves persistence failure semantics', async () => {
  await initArchiveStore();

  async function finalize(
    name: string,
    queue: QueueItem[],
    initialState?: Session['childHandoffState'],
    appendError?: Error,
  ): Promise<Session> {
    const session = createSession(`child_handoff_stop_${name}_${Date.now()}_${Math.random()}`, 'unused');
    session.parentSessionId = 'parent-session';
    session.queue = structuredClone(queue);
    session.busy = true;
    session.stopping = true;
    if (initialState) session.childHandoffState = structuredClone(initialState);
    const effects = createEffects(session, []);
    if (appendError) effects.appendQueuedMessages = async () => { throw appendError; };
    const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
    if (appendError) {
      await assert.rejects(() => (runner as any).finalizeStoppedSession(session), error => error === appendError);
    } else {
      await (runner as any).finalizeStoppedSession(session);
    }
    return session;
  }

  for (const relation of ['parent', 'other'] as const) {
    const session = await finalize(relation, [{
      type: 'intersession', sourceSessionRelation: relation, parts: [{ text: `${relation} assignment` }],
    }]);
    assert.deepEqual(session.childHandoffState, { boundary: 'report-required', resolved: false });
  }

  const directUser = await finalize(
    'direct-user',
    [{ type: 'user', parts: [{ text: 'new direct user request' }] }],
    { boundary: 'report-required', resolved: false },
  );
  assert.deepEqual(directUser.childHandoffState, { boundary: 'direct-user', resolved: true });

  const ordered = await finalize('ordered', [
    { type: 'user', parts: [{ text: 'direct first' }] },
    { type: 'intersession', sourceSessionRelation: 'direct-child', parts: [{ text: 'transparent child' }] },
    { type: 'background', parts: [{ system: 'transparent maintenance' }] },
    { type: 'intersession', sourceSessionRelation: 'other', parts: [{ text: 'other assignment last' }] },
  ]);
  assert.deepEqual(ordered.childHandoffState, { boundary: 'report-required', resolved: false });

  const prior: Session['childHandoffState'] = { boundary: 'direct-user', resolved: true };
  const precommitError = new Error('injected precommit failure');
  const rolledBack = await finalize(
    'precommit-rollback',
    [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
    prior,
    precommitError,
  );
  assert.deepEqual(rolledBack.childHandoffState, prior);

  const postcommitError = new SessionAuthorityPostCommitError('injected postcommit failure');
  const retained = await finalize(
    'postcommit-retention',
    [{ type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'assignment' }] }],
    prior,
    postcommitError,
  );
  assert.deepEqual(retained.childHandoffState, { boundary: 'report-required', resolved: false });
});

test('detached exact owner completes one real local-tool iteration', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_tool_${Date.now()}`, 'set a goal');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  let iteration = 0;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
    assert.strictEqual(owner, session);
    turnIds.push(options.turnId);
    if (parts) await options.appendMessage({ role: 'user', parts });
    if (iteration++ === 0) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: { id: 'goal-call', name: 'set_goal', args: { goal: 'detached goal' } } }] });
      return { text: '', toolCalls: [{ id: 'goal-call', name: 'set_goal', args: { goal: 'detached goal' } }] };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'tool complete' }] });
    return { text: 'tool complete' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(session.goalState?.goal, 'detached goal');
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model', 'tool', 'model']);
    assert.equal(session.history.length, 4);
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 0);
    assert.deepEqual((await readArchiveMessages(session.id)).map(record => record.message.role), ['user', 'model', 'tool', 'model']);
    assert.equal(turnIds.length, 2);
    assert.match(turnIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(turnIds[0], turnIds[1], 'one session turn keeps one TURN_ID across its tool loop');

    session.queue.push({ type: 'background', parts: [{ text: 'second turn' }] });
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(turnIds.length, 3);
    assert.notEqual(turnIds[0], turnIds[2], 'a later runSessionTurn receives a new TURN_ID');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('exact host preserves append-many, wait, identity mismatch, and persistence failure behavior', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_effects_${Date.now()}`, 'unused');
  session.queue = [];
  const events: string[] = [];
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session);
  const batch: Message[] = [
    { role: 'user', parts: [{ text: 'one' }] },
    { role: 'model', parts: [{ text: 'two' }] },
  ];
  await host.appendSessionMessages(session, batch);
  assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
  assert.deepEqual(events.slice(-3), ['persist:idle:2', 'history:user', 'history:model']);

  const wait = await host.startSessionWait(session, { reason: '  fallback  ', waitExecIds: ['exec-a'] });
  assert.equal(wait.reason, 'fallback');
  assert.equal(session.meta.wait?.id, wait.id);
  assert.deepEqual(wait.waitExecIds, ['exec-a']);
  assert.equal(await effects.clearWaitById(session.id, wait.id), true);
  assert.equal(session.meta.wait, undefined);

  const mismatch = createSession(`${session.id}_other`, 'other');
  await withGlobalOwnerLookupsForbidden(() => assert.rejects(
    () => host.getExistingSession(mismatch.id),
    /bound to session/,
  ));
  const effectCountBeforeClone = events.length;
  assert.throws(
    () => host.appendSessionMessage(mismatch, { role: 'user', parts: [{ text: 'wrong owner' }] }),
    /bound to session/,
  );
  const sameIdClone = { ...session } as Session;
  assert.throws(() => host.saveSession(sameIdClone), /different Session object/);
  assert.throws(() => host.chat(null, sameIdClone, 0), /different Session object/);
  assert.throws(() => host.executeTools([], { sessionId: session.id }, sameIdClone), /different Session object/);
  assert.throws(() => host.clearActiveSessionRuntimeState(mismatch.id), /bound to session/);
  assert.equal(events.length, effectCountBeforeClone);

  const failedEffects = createEffects(session, events);
  const failPersist = async () => { throw new Error('detached persist failed'); };
  failedEffects.persistSession = failPersist;
  failedEffects.appendMessages = async (owner, messages) => { await sessionManager.appendSessionMessagesForSession(
    owner, messages, failPersist, failedEffects.notifyHistoryUpdate,
  ); };
  failedEffects.appendMessage = (owner, message) => failedEffects.appendMessages(owner, [message]);
  const failedHost = new LocalSessionTurnHost(failedEffects, session);
  await assert.rejects(() => failedHost.saveSession(session), /detached persist failed/);
  const notificationCount = events.filter(event => event.startsWith('history:')).length;
  await assert.rejects(
    () => failedHost.appendSessionMessage(session, { role: 'user', parts: [{ text: 'persist failure' }] }),
    /detached persist failed/,
  );
  assert.equal(events.filter(event => event.startsWith('history:')).length, notificationCount);
});

test('claim persistence failure blocks the turn without later append or unhandled rejection', async () => {
  const session = createSession(`detached_runner_claim_failure_${Date.now()}`, 'must not run');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  const originalAppendMessage = effects.appendMessage;
  const originalAppendMessages = effects.appendMessages;
  let appendCount = 0;
  effects.appendMessage = async () => { appendCount += 1; };
  effects.appendMessages = async () => { appendCount += 1; };
  effects.updateBusy = (owner, busy) => sessionManager.updateSessionBusyStateForSession(
    owner,
    busy,
    async () => { throw new Error('claim persist rejected'); },
    effects.clearRuntimeState,
    () => {},
  );
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(() => runner.processSessionQueue(session.id), /claim persist rejected/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(appendCount, 0);
    assert.equal(session.queue.length, 1);
    assert.equal(session.busy, false);
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'busyStartedAt'), false);
    assert.deepEqual(unhandled, []);

    effects.updateBusy = originalUpdateBusy;
    effects.appendMessage = originalAppendMessage;
    effects.appendMessages = originalAppendMessages;
    const originalChat = llm.chat;
    (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
      if (parts) await options.appendMessage({ role: 'user', parts });
      await options.appendMessage({ role: 'model', parts: [{ text: 'retry succeeded' }] });
      return { text: 'retry succeeded' };
    };
    try {
      await new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id);
    } finally {
      (llm as any).chat = originalChat;
    }
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.busy, false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('claim persistence completes before any turn append begins', async () => {
  const session = createSession(`detached_runner_claim_order_${Date.now()}`, 'ordered input');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
  let claimStarted!: () => void;
  const started = new Promise<void>(resolve => { claimStarted = resolve; });
  effects.updateBusy = async (owner, busy) => {
    if (busy) {
      claimStarted();
      await claimGate;
    }
    await originalUpdateBusy(owner, busy);
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'ordered' }] });
    return { text: 'ordered' };
  };
  try {
    const running = runner.processSessionQueue(session.id);
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.history.length, 0);
    assert.equal(events.some(event => event.startsWith('persist:')), false);
    releaseClaim();
    await running;
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(events[0], 'persist:busy:0');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('release persistence failure restores ownership and suppresses trailing handoff', async () => {
  const session = createSession(`detached_runner_release_failure_${Date.now()}`, 'first turn');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let chatCount = 0;
  let releaseStartedAt: number | undefined;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseStartedAt = owner.busyStartedAt;
    owner.queue.push({ type: 'background', parts: [{ text: 'finish-window input' }] });
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'first done' }] });
    return { text: 'first done' };
  };
  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /release persist rejected/,
    );
    assert.equal(session.busy, true);
    assert.equal(typeof releaseStartedAt, 'number');
    assert.equal(session.busyStartedAt, releaseStartedAt);
    assert.equal(session.queue.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.busyStartedAt, releaseStartedAt);
    assert.equal(chatCount, 1);
    assert.equal(session.queue.length, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('stop-owned release failure is attempted once and is not retried by outer cleanup', async () => {
  const session = createSession(`detached_runner_stop_release_failure_${Date.now()}`, 'stop-retained input');
  session.stopping = true;
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseAttempts = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseAttempts += 1;
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('stop release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async () => { providerCalls += 1; throw new Error('stopped turn must not enter provider'); };

  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /stop release persist rejected/,
    );
    assert.equal(releaseAttempts, 1);
    assert.equal(providerCalls, 0);
    assert.equal(session.busy, true);
    assert.equal(session.history.filter(message => message.role === 'user').length, 1);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('fenced turn-owned release failure is attempted once and propagates without outer retry', async () => {
  const session = createSession(`detached_runner_fenced_release_failure_${Date.now()}`, 'fenced input');
  session.queue[0] = {
    type: 'user',
    source: { platform: 'test', channelId: 'test', channelUserId: 'direct', conversationId: 'direct' },
    parts: [{ text: 'fenced input' }],
  };
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseAttempts = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseAttempts += 1;
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('fenced release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session, {
    deliverCommittedFinal: async () => {},
  }));
  const originalChat = llm.chat;
  (llm as any).chat = async () => {
    const error = new Error('fenced semantic failure') as Error & { code: string };
    error.code = 'SESSION_WORKER_AUTO_COMPACTION_FATAL';
    throw error;
  };

  try {
    await assert.rejects(() => runner.processSessionQueue(session.id), /fenced release persist rejected/);
    assert.equal(releaseAttempts, 1);
    assert.equal(session.busy, true);
    assert.equal(session.history.filter(message => message.role === 'user').length, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('processor failure gate suppresses handoff even when a custom release leaves idle state', async () => {
  const session = createSession(`detached_runner_adversarial_release_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let chatCount = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    owner.busy = false;
    owner.busyStartedAt = undefined;
    owner.queue.push({ type: 'background', parts: [{ text: 'must stay queued' }] });
    throw new Error('adversarial release rejected');
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'done' }] });
    return { text: 'done' };
  };
  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /adversarial release rejected/,
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 1);
    assert.equal(chatCount, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('successful finish-window input still starts the next processor', async () => {
  const session = createSession(`detached_runner_finish_window_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let injected = false;
  let chatCount = 0;
  effects.updateBusy = async (owner, busy) => {
    if (!busy && !injected) {
      injected = true;
      owner.queue.push({ type: 'background', parts: [{ text: 'second turn' }] });
    }
    return originalUpdateBusy(owner, busy);
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${chatCount}` }] });
    return { text: `done-${chatCount}` };
  };
  try {
    await new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id);
    for (let attempt = 0; attempt < 100 && (chatCount < 2 || session.busy); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(chatCount, 2);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('failed spawned finish-window claim is logged once and remains explicitly retryable', async () => {
  const session = createSession(`detached_runner_spawn_failure_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let injected = false;
  let claimAttempt = 0;
  let chatCount = 0;
  effects.updateBusy = (owner, busy) => {
    if (busy) {
      claimAttempt += 1;
      if (claimAttempt === 2) {
        return sessionManager.updateSessionBusyStateForSession(
          owner,
          true,
          async () => { throw new Error('spawned claim persist rejected'); },
          effects.clearRuntimeState,
          () => {},
        );
      }
    } else if (!injected) {
      injected = true;
      owner.queue.push({ type: 'background', parts: [{ text: 'spawned second turn' }] });
    }
    return originalUpdateBusy(owner, busy);
  };
  const originalChat = llm.chat;
  const originalLoggerError = logger.error;
  const logged: Array<{ details: any; message: string }> = [];
  (logger as any).error = (details: any, message: string) => { logged.push({ details, message }); };
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${chatCount}` }] });
    return { text: `done-${chatCount}` };
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  try {
    await runner.processSessionQueue(session.id);
    for (let attempt = 0; attempt < 100 && logged.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(chatCount, 1);
    assert.equal(claimAttempt, 2);
    assert.equal(session.busy, false);
    assert.equal(session.busyStartedAt, undefined);
    assert.equal(session.queue.length, 1);
    assert.deepEqual(unhandled, []);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].details.sessionId, session.id);
    assert.match(String(logged[0].details.err?.message), /spawned claim persist rejected/);
    assert.equal(logged[0].message, 'Trailing queued work failed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claimAttempt, 2, 'failed spawned processor must not start a third processor');

    await runner.processSessionQueue(session.id);
    assert.equal(claimAttempt, 3);
    assert.equal(chatCount, 2);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(logged.length, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    (llm as any).chat = originalChat;
    (logger as any).error = originalLoggerError;
  }
});

test('base effects fallback persists both busy transitions with one notification each', async () => {
  const session = createSession(`detached_runner_base_busy_${Date.now()}`, 'unused');
  session.queue = [];
  const persistedBusy: boolean[] = [];
  const notified: string[] = [];
  const originalNotify = sessionManager.notifySessionStateUpdated;
  (sessionManager as any).notifySessionStateUpdated = (sessionId: string) => { notified.push(sessionId); };
  const effects: llm.CurrentSessionEffects = {
    placement: 'local',
    appendMessage: async () => {},
    persistSession: async owner => { persistedBusy.push(owner.busy); },
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
  };
  try {
    const host = new LocalSessionTurnHost(effects, session);
    await host.updateSessionBusyState(session, true);
    await host.updateSessionBusyState(session, false);
    assert.deepEqual(persistedBusy, [true, false]);
    assert.deepEqual(notified, [session.id, session.id]);
  } finally {
    (sessionManager as any).notifySessionStateUpdated = originalNotify;
  }
});

test('full turn effects own both busy persistence and notification exactly once', async () => {
  const session = createSession(`detached_runner_full_busy_${Date.now()}`, 'unused');
  session.queue = [];
  const events: string[] = [];
  const host = new LocalSessionTurnHost(createEffects(session, events), session);
  await host.updateSessionBusyState(session, true);
  await host.updateSessionBusyState(session, false);
  assert.deepEqual(events.filter(event => event.startsWith('persist:')), ['persist:busy:0', 'persist:idle:0']);
  assert.deepEqual(events.filter(event => event.startsWith('state:')), [`state:${session.id}`, `state:${session.id}`]);
});

test('default unbound busy claim honors destructive fencing while bound custom effects stay independent', async () => {
  const session = createSession(`detached_runner_destructive_claim_${Date.now()}`, 'unused');
  session.queue = [];
  sessionManager.getAllSessions().set(session.id, session);
  const claim = await sessionManager.claimSessionsForDestructiveLifecycle([session.id]);
  const originalSave = sessionManager.saveSession;
  let defaultPersistCount = 0;
  (sessionManager as any).saveSession = async () => { defaultPersistCount += 1; };
  try {
    const defaultHost = new LocalSessionTurnHost();
    assert.throws(
      () => defaultHost.updateSessionBusyState(session, true),
      /prepared for deletion/,
    );
    assert.equal(session.busy, false);
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'busyStartedAt'), false);
    assert.equal(defaultPersistCount, 0);

    const events: string[] = [];
    const boundHost = new LocalSessionTurnHost(createEffects(session, events), session);
    await boundHost.updateSessionBusyState(session, true);
    assert.equal(session.busy, true);
    assert.equal(events.filter(event => event.startsWith('persist:')).length, 1);
    await boundHost.updateSessionBusyState(session, false);
  } finally {
    (sessionManager as any).saveSession = originalSave;
    sessionManager.releaseSessionsForDestructiveLifecycle(claim.claimId);
    sessionManager.getAllSessions().delete(session.id);
  }
});
