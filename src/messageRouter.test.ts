import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter, shouldBroadcastChannelText } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import type { Message, Session } from './types';

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
    && part.system.startsWith('The following message is a direct user message via channel;')).length;
  assert.equal(sourcePrefixCount, 1);
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
