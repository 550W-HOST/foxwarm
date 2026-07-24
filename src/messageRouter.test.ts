import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter, shouldBroadcastChannelText } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import type { Message, MessagePart, Session } from './types';

function makeRouterQueueTestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createRouterQueueTestSession(prefix: string): Promise<Session> {
  await sessionManager.loadSessions();
  const session = await sessionManager.getSession(makeRouterQueueTestId(prefix)) as Session;
  session.history = [];
  session.contextFrontier = [];
  session.nextMessageSeq = 1;
  session.nextBlockId = 1;
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  await sessionManager.saveSession(session.id);
  return session;
}

async function appendMockChatMessages(
  session: Session,
  parts: MessagePart[] | null,
  modelParts: MessagePart[],
): Promise<void> {
  if (parts) {
    await sessionManager.appendSessionMessage(session, { role: 'user', parts });
  }
  if (modelParts.length > 0) {
    await sessionManager.appendSessionMessage(session, { role: 'model', parts: modelParts });
  }
}

function userTextOccurrences(session: Session, text: string): number {
  return session.history
    .filter(message => message.role === 'user')
    .filter(message => message.parts.some(part => part.text === text))
    .length;
}

function hasPartText(parts: MessagePart[] | null, text: string): boolean {
  return !!parts?.some(part => part.text === text);
}

test('shouldBroadcastChannelText rejects empty or whitespace-only text', () => {
  assert.equal(shouldBroadcastChannelText(''), false);
  assert.equal(shouldBroadcastChannelText('   '), false);
  assert.equal(shouldBroadcastChannelText('\n\t  '), false);
  assert.equal(shouldBroadcastChannelText(undefined), false);
  assert.equal(shouldBroadcastChannelText(null), false);
});

test('shouldBroadcastChannelText accepts non-empty trimmed text', () => {
  assert.equal(shouldBroadcastChannelText('hello'), true);
  assert.equal(shouldBroadcastChannelText('  hello  '), true);
  assert.equal(shouldBroadcastChannelText('\nhello\n'), true);
});

test('MessageRouter concurrent unbound-channel resolution returns one attached lifetime', async () => {
  await sessionManager.loadSessions();
  const router = new MessageRouter() as any;
  const channelId = `router-concurrent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const conversationId = `conversation-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    platform: 'test',
    channelType: 'test',
    channelId,
    channelUserId: conversationId,
    conversationId,
  };
  const beforeIds = new Set(sessionManager.getAllSessions().keys());

  const results = await Promise.all(
    Array.from({ length: 100 }, () => router.resolveSessionForIncomingMessage(ctx)),
  );
  const ids = new Set(results.map((result: any) => result.sessionId));
  assert.equal(ids.size, 1);
  const [sessionId] = [...ids] as string[];
  assert.equal(sessionManager.getSessionByChannel(channelId, conversationId), sessionId);
  assert.deepEqual(
    [...sessionManager.getAllSessions().keys()].filter(id => !beforeIds.has(id)),
    [sessionId],
  );

  sessionManager.detachChannel(channelId, conversationId);
  await sessionManager.deleteSession(sessionId);
});

test('MessageRouter queued turn start keeps WeWork stream-bound and unbound inputs separate', () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-a' },
        parts: [{ text: 'stream input' }],
      },
      {
        type: 'user',
        source: { platform: 'webui', channelId: 'webui', conversationId: 'browser' },
        parts: [{ text: 'web input' }],
      },
    ],
  };

  const drained = router.drainLeadingQueuedMessageParts(session);
  assert.equal(drained.parts.some((part: any) => part.text === 'stream input'), true);
  assert.equal(drained.parts.some((part: any) => part.text === 'web input'), false);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter in-turn queue consumption drains same-stream WeWork inputs before next LLM call', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-a' },
        parts: [{ text: 'next stream input' }],
      },
      {
        type: 'user',
        source: { platform: 'webui', channelId: 'webui', conversationId: 'browser' },
        parts: [{ text: 'web input' }],
      },
    ],
  };

  const consumed = await router.consumeLeadingQueuedTurnInputs(
    session,
    [{ text: 'pending' }],
    'wework-a:chat-a:stream-a',
  );

  assert.equal(consumed.parts.some((part: any) => part.text === 'next stream input'), true);
  assert.equal(consumed.parts.some((part: any) => part.text === 'web input'), true);
  assert.equal(session.queue.length, 0);
});

test('MessageRouter in-turn queue consumption leaves different WeWork stream cards for their own turn', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-b' },
        parts: [{ text: 'next card input' }],
      },
    ],
  };

  const consumed = await router.consumeLeadingQueuedTurnInputs(
    session,
    [{ text: 'pending' }],
    'wework-a:chat-a:stream-a',
  );

  assert.equal(consumed.parts.some((part: any) => part.text === 'next card input'), false);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter does not inject source prefix twice for drained queued parts', () => {
  const router = new MessageRouter() as any;
  const ctx = {
    channelUserId: 'T83450036A',
    conversationId: 'T83450036A',
    channelId: 'wework',
    channelType: 'wework',
    username: 'T83450036A',
    platform: 'wework',
    senderId: 'T83450036A',
    weworkStreamId: 'stream-a',
    reply: async () => {},
    sendTyping: async () => {},
  };
  const queueItem = router.buildChannelUserQueueItem(ctx, {
    parts: [{ text: '在吗' }],
    channelUserId: 'T83450036A',
    conversationId: 'T83450036A',
  });
  const session = {
    history: [{ role: 'user', parts: [{ text: 'previous' }] }],
    meta: { lastMessageTime: Date.now() },
    queue: [queueItem],
  };

  const drained = router.drainLeadingQueuedMessageParts(session);
  const parts = router.prepareTurnParts(session, 'session-1', drained.parts);

  const sourcePrefixCount = parts.filter((part: any) => typeof part.system === 'string'
    && part.system.startsWith('<foxwarm-message ')
    && part.system.includes('type="channel"')).length;
  assert.equal(sourcePrefixCount, 1);
  const sourcePart = parts.find((part: any) => typeof part.system === 'string' && part.system.includes('type="channel"'));
  assert.match(sourcePart?.system || '', /\n在吗\n<\/foxwarm-message>$/);
});

test('MessageRouter turn metadata avoids redundant time and session hints', () => {
  const router = new MessageRouter() as any;
  const session: any = {
    history: [],
    meta: { lastMessageTime: Date.now() - 11 * 60 * 1000 },
    queue: [],
  };

  const parts = router.prepareTurnParts(session, 'session-xml-1', [{ text: 'hello' }]);
  const sessionPart = parts.find((part: any) => typeof part.system === 'string' && part.system.includes('kind="session"'));
  const timePart = parts.find((part: any) => typeof part.system === 'string' && part.system.includes('kind="time"'));

  assert.equal(sessionPart?.system, '<foxwarm-system kind="session" currentSessionId="session-xml-1" />');
  assert.ok(timePart?.system.includes('localTime="'));
  assert.ok(!timePart?.system.includes(' hint='));
  assert.ok(!timePart?.system.includes(' time='));
  assert.ok(!sessionPart?.system.includes(' hint='));
});

test('MessageRouter queue draining keeps different WeWork stream ids separate', () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-a' },
        parts: [{ text: 'first stream' }],
      },
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-b' },
        parts: [{ text: 'second stream' }],
      },
    ],
  };

  const drained = router.drainLeadingQueuedMessageParts(session);
  assert.equal(drained.parts.some((part: any) => part.text === 'first stream'), true);
  assert.equal(drained.parts.some((part: any) => part.text === 'second stream'), false);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter queue draining stops before retry control items', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      { type: 'user', parts: [{ text: 'first input' }] },
      { type: 'retry' },
      { type: 'user', parts: [{ text: 'after retry' }] },
    ],
  };

  const drained = router.drainLeadingQueuedMessageParts(session);
  assert.deepEqual(drained.parts, [{ text: 'first input' }]);
  assert.deepEqual(session.queue.map((item: any) => item.type), ['retry', 'user']);

  const consumed = await router.consumeLeadingQueuedTurnInputs(session, [{ text: 'pending' }]);
  assert.deepEqual(consumed.parts, [{ text: 'pending' }]);
  assert.equal(consumed.consumedInput, false);
  assert.deepEqual(session.queue.map((item: any) => item.type), ['retry', 'user']);
});

test('MessageRouter emits turn progress as an empty targeted channel broadcast', () => {
  const router = new MessageRouter() as any;
  const events: Array<{ text: string; options: any }> = [];

  router.emitTurnProgress((text: string, options?: any) => events.push({ text, options }), {
    weworkStreamId: 'stream-1',
    weworkStreamChannelId: 'wework-a',
    weworkStreamConversationId: 'chat-a',
  }, { type: 'llm-start' });

  assert.equal(events.length, 1);
  assert.equal(events[0].text, '');
  assert.equal(events[0].options.allowEmptyBroadcast, true);
  assert.deepEqual(events[0].options.targetChannel, { channelId: 'wework-a', conversationId: 'chat-a' });
  assert.deepEqual(events[0].options.channelTurnProgress, { type: 'llm-start' });
});

test('MessageRouter LLM retry notifier appends one display-only message then updates it', async () => {
  const router = new MessageRouter() as any;
  const session: Session = {
    id: 'retry_notice_session',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
  const broadcasts: Array<{ text: string; options: any }> = [];
  const historyUpdates: Message[] = [];
  const originalAppend = sessionManager.appendSessionMessage;
  const originalSave = sessionManager.saveSession;
  const originalNotify = sessionManager.notifyHistoryUpdate;
  let nextSeq = 1;

  (sessionManager as any).appendSessionMessage = async (targetSession: Session, message: Message) => {
    message.__meta = { ...(message.__meta || {}), timestamp: message.__meta?.timestamp || Date.now(), seq: nextSeq++ };
    targetSession.history.push(message);
    historyUpdates.push(message);
  };
  (sessionManager as any).saveSession = async () => {};
  (sessionManager as any).notifyHistoryUpdate = (_sessionId: string, message: Message) => {
    historyUpdates.push(message);
  };

  try {
    const notify = router.createLlmRetryNotifier(
      session,
      (text: string, options?: any) => broadcasts.push({ text, options }),
    );

    await notify({
      attempt: 1,
      nextAttempt: 2,
      maxRetries: 5,
      delayMs: 2000,
      kind: 'request-error',
      reason: `socket hang up ${'detail '.repeat(20)}`,
    });
    await notify({
      attempt: 2,
      nextAttempt: 3,
      maxRetries: 5,
      delayMs: 5000,
      kind: 'http-error',
      status: '500 Internal Server Error',
      reason: 'upstream bad gateway',
    });
    await notify({
      attempt: 5,
      maxRetries: 5,
      final: true,
      kind: 'request-error',
      reason: 'final upstream timeout',
    });

    assert.equal(session.history.length, 1);
    assert.equal(session.history[0].modelVisible, false);
    assert.equal(session.history[0].__meta?.noticeType, 'llm-retry');
    assert.equal(session.history[0].__meta?.updateExisting, true);
    assert.equal(session.history[0].__meta?.retry?.final, true);
    const noticeText = session.history[0].parts[0].text || '';
    assert.match(noticeText, /^⚠️ \[LLM retry\]\nAttempt 1\/5 failed:/);
    assert.match(noticeText, /\nAttempt 2\/5 failed: 500 Internal Server Error: upstream bad gateway\. Retry in 5 seconds/);
    assert.match(noticeText, /\nAttempt 5\/5 failed: final upstream timeout\. No more retries\./);
    assert.equal(broadcasts.length, 3);
    assert.deepEqual(broadcasts[0].options.excludePlatforms, ['webui']);
    assert.match(broadcasts[0].text, /^⚠️ \[LLM retry\]\nAttempt 1\/5 failed:/);
    assert.match(broadcasts[0].text, /\nRetry in 2 seconds\.\.\./);
    assert.match(broadcasts[2].text, /No more retries/);
    assert.equal(historyUpdates.length, 3);
    assert.equal(historyUpdates[0].__meta?.seq, historyUpdates[2].__meta?.seq);
  } finally {
    (sessionManager as any).appendSessionMessage = originalAppend;
    (sessionManager as any).saveSession = originalSave;
    (sessionManager as any).notifyHistoryUpdate = originalNotify;
  }
});

test('MessageRouter LLM final failure keeps retry notice display-only without appending Error model text', async () => {
  const router = new MessageRouter() as any;
  router.continueWithQueuedWork = async () => false;
  const broadcasts: Array<{ text: string; options: any }> = [];
  const session: Session = {
    id: 'retry_final_failure_session',
    history: [],
    persistentMemorySnapshot: 'system prompt',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    broadcast: (text: string, options?: any) => { broadcasts.push({ text, options }); },
  } as Session;
  const originalChat = llm.chat;
  const originalAppend = sessionManager.appendSessionMessage;
  const originalSave = sessionManager.saveSession;
  const originalNotify = sessionManager.notifyHistoryUpdate;
  let nextSeq = 1;

  (sessionManager as any).appendSessionMessage = async (targetSession: Session, message: Message) => {
    message.__meta = { ...(message.__meta || {}), timestamp: message.__meta?.timestamp || Date.now(), seq: nextSeq++ };
    targetSession.history.push(message);
  };
  (sessionManager as any).saveSession = async () => {};
  (sessionManager as any).notifyHistoryUpdate = () => {};
  (llm as any).chat = async (parts: any, activeSession: Session, _iteration: number, options?: { onRetry?: (event: llm.LlmRetryEvent) => Promise<void> | void }) => {
    if (parts) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    await Promise.resolve(options?.onRetry?.({
      attempt: 5,
      maxRetries: 5,
      final: true,
      kind: 'request-error',
      reason: 'upstream exhausted',
    }));
    throw new llm.LlmRequestError('API request failed after 5 attempts');
  };

  try {
    await router.runSessionTurn(session.id, {
      parts: [{ text: 'trigger final failure' }],
      session,
      preclaimed: true,
    });

    assert.equal(session.history.length, 2);
    assert.equal(session.history[0].role, 'user');
    assert.equal(session.history[1].modelVisible, false);
    assert.equal(session.history[1].__meta?.noticeType, 'llm-retry');
    assert.equal(session.history[1].__meta?.retry?.final, true);
    assert.match(session.history[1].parts[0].text || '', /Attempt 5\/5 failed: upstream exhausted\. No more retries\./);
    assert.equal(session.history.some(message => message.role === 'model' && message.modelVisible !== false && /^Error:/.test(message.parts[0]?.text || '')), false);
    assert.equal(broadcasts.some(event => /API request failed|^Error:/m.test(event.text)), false);
    assert.equal(broadcasts.some(event => /No more retries/.test(event.text)), true);
  } finally {
    (llm as any).chat = originalChat;
    (sessionManager as any).appendSessionMessage = originalAppend;
    (sessionManager as any).saveSession = originalSave;
    (sessionManager as any).notifyHistoryUpdate = originalNotify;
  }
});

test('retrySession enqueues an internal retry item that reruns LLM without appending retry marker text', async () => {
  const router = new MessageRouter() as any;
  const sessionId = `retry_control_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [{ role: 'user', parts: [{ text: 'original failed request' }], __meta: { seq: 1, timestamp: Date.now() } }];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };

  const originalChat = llm.chat;
  let chatCallCount = 0;
  const seenParts: any[] = [];

  sessionManager.setSessionTriggerCallback(() => {});
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    chatCallCount += 1;
    seenParts.push(parts);
    const text = parts === null ? 'retried response' : 'queued response';
    activeSession.history.push({ role: 'model', parts: [{ text }], __meta: { seq: chatCallCount + 1, timestamp: Date.now() } });
    return { text, allParts: [{ text }] };
  };

  try {
    await sessionManager.retrySession(sessionId);
    session.queue.push({ type: 'user', parts: [{ text: 'queued after retry' }] });
    assert.deepEqual(session.queue.map(item => item.type), ['retry', 'user']);

    await router.processSessionQueue(sessionId);

    assert.equal(chatCallCount, 2);
    assert.equal(seenParts[0], null);
    assert.equal(seenParts[1].some((part: any) => part.text === 'queued after retry'), true);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(session.history.some(message => message.parts.some(part => /retrying last request|retrying-last-request/.test(String(part.text || part.system || '')))), false);
    assert.equal(session.history.some(message => message.role === 'user' && message.parts.some(part => /retry/i.test(String(part.text || part.system || '')))), false);
    assert.equal(session.history.some(message => message.role === 'model' && message.parts.some(part => part.text === 'retried response')), true);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('stop signal preserves queued work until a later trigger', async () => {
  const router = new MessageRouter() as any;
  const sessionId = `stop_preserve_queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const seenParts: any[] = [];

  (llm as any).chat = async (parts: any) => {
    seenParts.push(parts);
    if (seenParts.length === 1) {
      const toolCall = { id: 'stop-tool', name: 'read', args: { filePath: 'README.md' } };
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    return { text: 'queued response', allParts: [{ text: 'queued response' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(sessionId, { type: 'user', parts: [{ text: 'queued after stop' }] });
    await sessionManager.requestSessionStop(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'stop-tool', name: 'read', response: { output: 'stopped' } } }] };
  };

  try {
    await router.runSessionTurn(sessionId, { parts: [{ text: 'start current turn' }], session });

    assert.equal(seenParts.length, 1);
    assert.deepEqual(session.queue.map(item => item.type), ['user']);
    assert.equal(session.busy, false);

    await router.processSessionQueue(sessionId);
    assert.equal(seenParts.length, 2);
    assert.equal(seenParts[1].some((part: any) => part.text === 'queued after stop'), true);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('dequeue signal drains queued work once after a compact-commit boundary', async () => {
  const router = new MessageRouter() as any;
  const sessionId = `dequeue_continue_queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const seenParts: any[] = [];

  (llm as any).chat = async (parts: any) => {
    seenParts.push(parts);
    if (seenParts.length === 1) {
      const toolCall = { id: 'dequeue-tool', name: 'read', args: { filePath: 'README.md' } };
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    return { text: 'queued response', allParts: [{ text: 'queued response' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(sessionId, { type: 'compact-commit' });
    await sessionManager.enqueueSessionItem(sessionId, { type: 'user', parts: [{ text: 'queued for dequeue' }] });
    await sessionManager.requestSessionDequeue(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'dequeue-tool', name: 'read', response: { output: 'dequeued' } } }] };
  };

  try {
    await router.runSessionTurn(sessionId, { parts: [{ text: 'start current turn' }], session });

    assert.equal(seenParts.length, 2);
    assert.equal(seenParts[1].some((part: any) => part.text === 'queued for dequeue'), true);
    assert.equal(seenParts[1].some((part: any) => part.text === 'start current turn'), false);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter does not replay dispatched parts after an async compact commit during tools', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('async_compact_commit_no_replay');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const seenParts: Array<MessagePart[] | null> = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    seenParts.push(parts);
    if (seenParts.length === 1) {
      const toolCall = { id: 'compact-race-tool', name: 'read', args: { filePath: 'README.md' } };
      await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    await appendMockChatMessages(activeSession, parts, [{ text: 'continued after compact commit' }]);
    return { text: 'continued after compact commit', allParts: [{ text: 'continued after compact commit' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(session.id, { type: 'compact-commit' });
    return { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'compact-race-tool', name: 'read', response: { output: 'ok' } } }] };
  };
  (sessionManager as any).applyCompletedCompactJob = async () => {
    await sessionManager.appendSessionMessage(session, { role: 'user', parts: [{ system: 'compact commit applied' }] });
    return true;
  };

  try {
    await router.runSessionTurn(session.id, { parts: [{ text: 'A' }], session });

    assert.equal(hasPartText(seenParts[0], 'A'), true);
    assert.equal(seenParts[1], null);
    assert.equal(userTextOccurrences(session, 'A'), 1);
    assert.equal(session.contextFrontier?.filter(item => item.kind === 'message').length, session.history.length);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter keeps a queued user item behind compact commit separate from dispatched parts', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('async_compact_commit_queued_input');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const seenParts: Array<MessagePart[] | null> = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    seenParts.push(parts);
    if (seenParts.length === 1) {
      const toolCall = { id: 'compact-barrier-tool', name: 'read', args: { filePath: 'README.md' } };
      await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    await appendMockChatMessages(activeSession, parts, [{ text: 'Q handled' }]);
    return { text: 'Q handled', allParts: [{ text: 'Q handled' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(session.id, { type: 'compact-commit' });
    await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'Q' }] });
    return { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'compact-barrier-tool', name: 'read', response: { output: 'ok' } } }] };
  };
  (sessionManager as any).applyCompletedCompactJob = async () => {
    await sessionManager.appendSessionMessage(session, { role: 'user', parts: [{ system: 'compact commit applied' }] });
    return true;
  };

  try {
    await router.runSessionTurn(session.id, { parts: [{ text: 'A' }], session });

    assert.equal(hasPartText(seenParts[0], 'A'), true);
    assert.equal(hasPartText(seenParts[1], 'Q'), true);
    assert.equal(hasPartText(seenParts[1], 'A'), false);
    assert.equal(userTextOccurrences(session, 'A'), 1);
    assert.equal(userTextOccurrences(session, 'Q'), 1);
    assert.equal(session.contextFrontier?.filter(item => item.kind === 'message').length, session.history.length);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter preserves an already-consumed follow-up once when compact commit arrives in its tool loop', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('async_compact_commit_suffix');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const seenParts: Array<MessagePart[] | null> = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    seenParts.push(parts);
    if (seenParts.length < 3) {
      const toolCall = { id: `suffix-tool-${seenParts.length}`, name: 'read', args: { filePath: 'README.md' } };
      await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    await appendMockChatMessages(activeSession, parts, [{ text: 'suffix preserved' }]);
    return { text: 'suffix preserved', allParts: [{ text: 'suffix preserved' }] };
  };
  let toolRuns = 0;
  (llm as any).executeTools = async () => {
    toolRuns += 1;
    if (toolRuns === 1) {
      await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'Q' }] });
    } else {
      await sessionManager.enqueueSessionItem(session.id, { type: 'compact-commit' });
    }
    return { role: 'tool', parts: [{ functionResponse: { tool_use_id: `suffix-tool-${toolRuns}`, name: 'read', response: { output: 'ok' } } }] };
  };
  (sessionManager as any).applyCompletedCompactJob = async () => {
    await sessionManager.appendSessionMessage(session, { role: 'user', parts: [{ system: 'compact commit applied' }] });
    return true;
  };

  try {
    await router.runSessionTurn(session.id, { parts: [{ text: 'A' }], session });

    assert.equal(hasPartText(seenParts[0], 'A'), true);
    assert.equal(hasPartText(seenParts[1], 'Q'), true);
    assert.equal(seenParts[2], null);
    assert.equal(userTextOccurrences(session, 'A'), 1);
    assert.equal(userTextOccurrences(session, 'Q'), 1);
    assert.equal(session.contextFrontier?.filter(item => item.kind === 'message').length, session.history.length);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter retains unsent parts across a pre-LLM compact boundary', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('pre_llm_compact_keeps_parts');
  const originalChat = llm.chat;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const seenParts: Array<MessagePart[] | null> = [];
  session.queue.push({ type: 'compact-commit' });

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    seenParts.push(parts);
    await appendMockChatMessages(activeSession, parts, [{ text: 'A handled after compact' }]);
    return { text: 'A handled after compact', allParts: [{ text: 'A handled after compact' }] };
  };
  (sessionManager as any).applyCompletedCompactJob = async () => {
    await sessionManager.appendSessionMessage(session, { role: 'user', parts: [{ system: 'compact commit applied' }] });
    return true;
  };

  try {
    await router.runSessionTurn(session.id, { parts: [{ text: 'A' }], session });

    assert.equal(hasPartText(seenParts[0], 'A'), true);
    assert.equal(userTextOccurrences(session, 'A'), 1);
    assert.equal(session.contextFrontier?.filter(item => item.kind === 'message').length, session.history.length);
  } finally {
    (llm as any).chat = originalChat;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter exposes requesting-model runtime state while LLM request is in flight', async () => {
  const router = new MessageRouter() as any;
  router.continueWithQueuedWork = async () => false;
  const sessionId = `runtime_requesting_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = true;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  const originalChat = llm.chat;
  let releaseChat!: () => void;
  const chatGate = new Promise<void>(resolve => { releaseChat = resolve; });
  let chatStarted = false;

  (llm as any).chat = async () => {
    chatStarted = true;
    await chatGate;
    return { text: 'done' };
  };

  try {
    const running = router.runSessionTurn(session.id, {
      parts: [{ text: 'hello' }],
      session,
      preclaimed: true,
    });

    while (!chatStarted) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const inFlight = sessionManager.buildSessionRuntimeState(session);
    assert.equal(inFlight.state, 'requesting-model');
    assert.equal(inFlight.active?.iteration, 0);

    releaseChat();
    await running;
    assert.equal(sessionManager.buildSessionRuntimeState(session).state, 'idle');
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter exposes running-tool runtime state while tool batch is executing', async () => {
  const router = new MessageRouter() as any;
  router.continueWithQueuedWork = async () => false;
  const sessionId = `runtime_tool_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = true;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let chatCount = 0;
  let releaseTools!: () => void;
  const toolGate = new Promise<void>(resolve => { releaseTools = resolve; });
  let toolsStarted = false;

  (llm as any).chat = async () => {
    chatCount += 1;
    if (chatCount === 1) {
      return { text: '', toolCalls: [{ id: 'call-read', name: 'read', args: { filePath: 'README.md' } }] };
    }
    return { text: 'done' };
  };
  (llm as any).executeTools = async () => {
    toolsStarted = true;
    await toolGate;
    return {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call-read', name: 'read', response: { output: 'ok' } } }],
    };
  };

  try {
    const running = router.runSessionTurn(session.id, {
      parts: [{ text: 'use tool' }],
      session,
      preclaimed: true,
    });

    while (!toolsStarted) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const inFlight = sessionManager.buildSessionRuntimeState(session);
    assert.equal(inFlight.state, 'running-tool');
    assert.equal(inFlight.tool?.name, 'read');
    assert.equal(inFlight.tool?.total, 1);

    releaseTools();
    await running;
    assert.equal(sessionManager.buildSessionRuntimeState(session).state, 'idle');
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter strips configured channel selfName mention before command parsing', async () => {
  const router = new MessageRouter() as any;
  const calls: Array<{ command: string; args: string[] }> = [];
  router.setCommandHandler(async (_ctx: any, command: string, args: string[]) => {
    calls.push({ command, args });
    return true;
  });

  const handled = await router.handleCommandIfNeeded({
    channelUserId: 'chat-a',
    conversationId: 'chat-a',
    channelId: 'wework-a',
    channelType: 'wework',
    platform: 'wework',
    senderId: 'user-a',
    username: 'user-a',
    selfName: '企业微信机器人',
    reply: async () => {},
    sendTyping: async () => {},
  }, '@企业微信机器人   /session list');

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ command: '/session', args: ['list'] }]);
});

test('MessageRouter preserves raw multiline command arguments alongside tokenized args', async () => {
  const router = new MessageRouter() as any;
  const calls: Array<{ command: string; args: string[]; rawArgs?: string }> = [];
  router.setCommandHandler(async (_ctx: any, command: string, args: string[], rawArgs?: string) => {
    calls.push({ command, args, rawArgs });
    return true;
  });

  const handled = await router.handleCommandIfNeeded({
    channelUserId: 'chat-a',
    conversationId: 'chat-a',
    channelId: 'webui-a',
    channelType: 'webui',
    platform: 'webui',
    senderId: 'user-a',
    username: 'user-a',
    reply: async () => {},
    sendTyping: async () => {},
  }, '/fork custom first line  \nsecond line\n');

  assert.equal(handled, true);
  assert.deepEqual(calls, [{
    command: '/fork',
    args: ['custom', 'first', 'line', 'second', 'line'],
    rawArgs: 'custom first line  \nsecond line\n',
  }]);
});

test('MessageRouter selfName mention stripping requires whitespace after mention', async () => {
  const router = new MessageRouter() as any;
  let called = false;
  router.setCommandHandler(async () => {
    called = true;
    return true;
  });

  const handled = await router.handleCommandIfNeeded({
    channelUserId: 'chat-a',
    conversationId: 'chat-a',
    channelId: 'wework-a',
    channelType: 'wework',
    platform: 'wework',
    senderId: 'user-a',
    username: 'user-a',
    selfName: '企业微信机器人',
    reply: async () => {},
    sendTyping: async () => {},
  }, '@企业微信机器人/session list');

  assert.equal(handled, false);
  assert.equal(called, false);
});
