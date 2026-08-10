import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter, shouldBroadcastChannelText } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as sessionHistory from './session/history';
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

async function processOwnedTestQueue(router: MessageRouter, session: Session): Promise<void> {
  await sessionManager.saveSession(session.id);
  await router.processSessionQueue(session.id);
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

function countHistoryPartText(messages: Message[], text: string): number {
  return messages.reduce((count, message) => count + message.parts.filter(part => part.text === text).length, 0);
}

function countHistoryPartSystem(messages: Message[], system: string): number {
  return messages.reduce((count, message) => count + message.parts.filter(part => part.system === system).length, 0);
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

test('MessageRouter materializes deferred channel media only after canonical authorization', async () => {
  const originalEnqueue = sessionManager.enqueueSessionItem;
  const router = new MessageRouter() as any;
  const session = { id: 'guest-media-session', busy: false, queue: [], meta: {} } as any;
  const ctx = {
    channelId: 'qq-media-auth', channelType: 'qqbot', platform: 'qqbot',
    channelUserId: 'c2c:user-1', conversationId: 'c2c:user-1', senderId: 'user-1', username: 'user-1',
    reply: async () => {}, sendTyping: async () => {},
  } as any;
  const queued: any[] = [];
  (sessionManager as any).enqueueSessionItem = async (_sessionId: string, item: any) => queued.push(item);
  router.processSessionQueue = async () => {};
  router.handleCommandIfNeeded = async () => false;

  try {
    let materializeCount = 0;
    router.isAuthorized = () => false;
    router.maybeCreateGuestSessionForUnauthorizedMessage = async (): Promise<null> => null;
    let unauthorizedReplyCount = 0;
    ctx.reply = async (): Promise<void> => { unauthorizedReplyCount += 1; };
    const deferred = {
      parts: [{ text: '[QQ file attachment: private.txt]' }],
      channelUserId: ctx.channelUserId, conversationId: ctx.conversationId,
      materializeParts: async () => { materializeCount += 1; return [{ text: 'downloaded file' }]; },
    };
    await router.handleMessage(ctx, deferred);
    assert.equal(unauthorizedReplyCount, 1);
    assert.equal(materializeCount, 0, 'unauthorized media must remain metadata-only');

    router.maybeCreateGuestSessionForUnauthorizedMessage = async () => ({ sessionId: session.id, session });
    await router.handleMessage(ctx, deferred);
    assert.equal(materializeCount, 0, 'first guest media must remain metadata-only');
    assert.equal(queued.length, 1);

    queued.length = 0;
    router.isAuthorized = () => true;
    router.resolveSessionForIncomingMessage = async () => ({ sessionId: session.id, session });
    await router.handleMessage(ctx, {
      ...deferred,
      materializeParts: async (sessionId: string) => {
        materializeCount += 1;
        assert.equal(sessionId, session.id);
        return [{ text: 'downloaded image' }];
      },
    });
    assert.equal(materializeCount, 1);
    assert.equal(queued[0].parts.length, 1);
    assert.match(queued[0].parts[0].system || '', /downloaded image/);
  } finally {
    (sessionManager as any).enqueueSessionItem = originalEnqueue;
  }
});

test('MessageRouter uses QQ Bot conversation identity as the passive reply merge boundary', () => {
  const router = new MessageRouter() as any;
  const runner = router.turnRunner as any;
  const source = {
    platform: 'qqbot',
    channelId: 'qq-primary',
    channelType: 'qqbot',
    channelUserId: 'c2c:user-openid',
    conversationId: 'c2c:user-openid',
    qqbotMessageId: 'incoming-message-id',
  };

  assert.equal(
    runner.getSourceStreamKey(source),
    'qqbot:qq-primary:c2c:user-openid',
  );
  assert.deepEqual(runner.getTurnChannelOptions(undefined, source), {
    qqbotMessageId: 'incoming-message-id',
    qqbotChannelId: 'qq-primary',
    qqbotConversationId: 'c2c:user-openid',
  });
});

test('MessageRouter top-level queue drain persists user and intersession inputs separately before one model request', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('top_level_queue_message_boundaries');
  const originalChat = llm.chat;
  const seenRequests: Message[][] = [];
  session.queue.push(
    { type: 'user', parts: [{ text: 'queued channel user' }] },
    { type: 'intersession', message: { role: 'user', parts: [{ system: 'queued intersession notice' }] } },
  );

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    assert.equal(parts, null);
    seenRequests.push(structuredClone(activeSession.history));
    await appendMockChatMessages(activeSession, parts, [{ text: 'handled both queued inputs' }]);
    return { text: 'handled both queued inputs', allParts: [{ text: 'handled both queued inputs' }] };
  };

  try {
    await processOwnedTestQueue(router, session);

    assert.equal(seenRequests.length, 1);
    assert.equal(countHistoryPartText(seenRequests[0], 'queued channel user'), 1);
    assert.equal(countHistoryPartSystem(seenRequests[0], 'queued intersession notice'), 1);
    const queuedInputMessages = seenRequests[0].filter(message => message.role === 'user'
      && message.parts.some(part => part.text === 'queued channel user' || part.system === 'queued intersession notice'));
    assert.equal(queuedInputMessages.length, 2);
    assert.notEqual(queuedInputMessages[0], queuedInputMessages[1]);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter outer owner sequences compact then turn then trailing compact under one claim', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('top_level_queue_compact_boundary');
  const originalChat = llm.chat;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  let compactApplies = 0;
  session.queue.push(
    { type: 'compact-commit' },
    { type: 'user', parts: [{ text: 'queued before compact commit' }] },
    { type: 'compact-commit' },
  );

  (sessionManager as any).applyCompletedCompactJob = async () => {
    compactApplies += 1;
    assert.equal(userTextOccurrences(session, 'queued before compact commit'), compactApplies === 1 ? 0 : 1);
    await sessionManager.appendSessionMessage(session, { role: 'user', parts: [{ system: `compact commit ${compactApplies} applied` }] });
    return true;
  };
  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    assert.equal(compactApplies, 1);
    assert.equal(parts, null);
    assert.equal(userTextOccurrences(activeSession, 'queued before compact commit'), 1);
    await appendMockChatMessages(activeSession, parts, [{ text: 'handled after compact commit' }]);
    return { text: 'handled after compact commit', allParts: [{ text: 'handled after compact commit' }] };
  };

  try {
    await processOwnedTestQueue(router, session);

    assert.equal(compactApplies, 2);
    assert.equal(userTextOccurrences(session, 'queued before compact commit'), 1);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter keeps the first queued item as the turn source when later compatible input has a source', async () => {
  const router = new MessageRouter() as any;
  const captured: any[] = [];
  const session = await createRouterQueueTestSession('queue_first_item_source');
  session.queue.push(
    { type: 'intersession', message: { role: 'user', parts: [{ system: 'first intersession event' }] } },
    {
      type: 'user',
      source: { platform: 'webui', channelId: 'webui', conversationId: 'browser', channelUserId: 'browser' },
      parts: [{ text: 'later web input' }],
    },
  );
  router.turnRunner.runSessionTurn = async (_sessionId: string, options: any) => captured.push(options);

  try {
    await processOwnedTestQueue(router, session);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].source, undefined);
    assert.equal(captured[0].queuedItems.length, 2);
    assert.equal(session.queue.length, 0);
  } finally {
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
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

  const drained = router.turnRunner.drainLeadingQueuedTurnInputs(session);
  assert.equal(drained.items[0].parts?.some((part: any) => part.text === 'stream input'), true);
  assert.equal(drained.items.some((item: any) => item.parts?.some((part: any) => part.text === 'web input')), false);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter in-turn queue consumption drains same-stream WeWork inputs before next LLM call', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    id: 'queue-consumption-same-stream',
    history: [],
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

  const originalAppend = sessionManager.appendSessionMessage;
  (sessionManager as any).appendSessionMessage = async (target: any, message: Message) => target.history.push(message);
  try {
    const consumed = await router.turnRunner.consumeLeadingQueuedTurnInputs(
      session,
      [{ text: 'pending' }],
      { streamKey: 'wework:wework-a:chat-a', preferDirectReply: false },
    );

    assert.equal(consumed.parts, null);
    assert.deepEqual(session.history.map((message: Message) => message.parts), [
      [{ text: 'pending' }],
      [{ text: 'next stream input' }],
      [{ text: 'web input' }],
    ]);
    assert.equal(session.queue.length, 0);
  } finally {
    (sessionManager as any).appendSessionMessage = originalAppend;
  }
});

test('MessageRouter in-turn queue consumption merges a newer WeWork card in the same conversation', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    id: 'queue-consumption-new-card',
    history: [],
    queue: [
      {
        type: 'user',
        source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-b' },
        parts: [{ text: 'next card input' }],
      },
    ],
  };

  const originalAppend = sessionManager.appendSessionMessage;
  (sessionManager as any).appendSessionMessage = async (target: any, message: Message) => target.history.push(message);
  try {
    const consumed = await router.turnRunner.consumeLeadingQueuedTurnInputs(
      session,
      [{ text: 'pending' }],
      { streamKey: 'wework:wework-a:chat-a', preferDirectReply: false },
    );

    assert.equal(consumed.parts, null);
    assert.deepEqual(session.history.map((message: Message) => message.parts), [
      [{ text: 'pending' }],
      [{ text: 'next card input' }],
    ]);
    assert.equal(session.queue.length, 0);
  } finally {
    (sessionManager as any).appendSessionMessage = originalAppend;
  }
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
    clientMessageId: 'webui-client-message-1',
  });
  const session = {
    history: [{ role: 'user', parts: [{ text: 'previous' }] }],
    meta: { lastMessageTime: Date.now() },
    queue: [queueItem],
  };

  const drained = router.turnRunner.drainLeadingQueuedTurnInputs(session);
  const parts = router.turnRunner.prepareTurnParts(session, 'session-1', drained.items[0].parts);

  const sourcePrefixCount = parts.filter((part: any) => typeof part.system === 'string'
    && part.system.startsWith('<foxwarm-message ')
    && part.system.includes('type="channel"')).length;
  assert.equal(sourcePrefixCount, 1);
  const sourcePart = parts.find((part: any) => typeof part.system === 'string' && part.system.includes('type="channel"'));
  assert.match(sourcePart?.system || '', /\n在吗\n<\/foxwarm-message>$/);
  assert.match(sourcePart?.system || '', /time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}"/);
  assert.equal(queueItem.clientMessageId, 'webui-client-message-1');
});

test('MessageRouter persists each queued WebUI client message identity on its user row', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('client_message_identity');

  try {
    await router.turnRunner.appendQueuedTurnInputs(session, session.id, [
      { type: 'user', parts: [{ text: 'same' }], clientMessageId: 'same-a' },
      { type: 'user', parts: [{ text: 'same' }], clientMessageId: 'same-b' },
    ]);

    assert.deepEqual(
      session.history.map(message => message.__meta?.clientMessageId),
      ['same-a', 'same-b'],
    );
    assert.deepEqual(session.history.map(message => message.__meta?.seq), [1, 2]);
  } finally {
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter turn metadata no longer injects an idle-gap time marker', () => {
  const router = new MessageRouter() as any;
  const session: any = {
    history: [],
    meta: { lastMessageTime: Date.now() - 11 * 60 * 1000 },
    queue: [],
  };

  const parts = router.turnRunner.prepareTurnParts(session, 'session-xml-1', [{ text: 'hello' }]);
  const sessionPart = parts.find((part: any) => typeof part.system === 'string' && part.system.includes('kind="session"'));

  assert.equal(sessionPart?.system, '<foxwarm-system kind="session" currentSessionId="session-xml-1" />');
  assert.equal(parts.some((part: any) => typeof part.system === 'string' && part.system.includes('kind="time"')), false);
  assert.ok(!sessionPart?.system.includes(' hint='));
});

test('MessageRouter queue draining merges different WeWork stream ids in one conversation', () => {
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

  const drained = router.turnRunner.drainLeadingQueuedTurnInputs(session);
  assert.equal(drained.items[0].parts?.some((part: any) => part.text === 'first stream'), true);
  assert.equal(drained.items.some((item: any) => item.parts?.some((part: any) => part.text === 'second stream')), true);
  assert.equal(session.queue.length, 0);
});

test('MessageRouter keeps different QQ and WeWork conversations as hard merge boundaries', () => {
  const router = new MessageRouter() as any;
  for (const sources of [
    [
      { platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-a', qqbotMessageId: 'qq-1' },
      { platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-b', qqbotMessageId: 'qq-2' },
    ],
    [
      { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-1' },
      { platform: 'wework', channelId: 'wework-b', conversationId: 'chat-a', weworkStreamId: 'stream-2' },
    ],
  ]) {
    const session: any = { queue: sources.map((source, index) => ({ type: 'user', source, parts: [{ text: `input-${index}` }] })) };
    const drained = router.turnRunner.drainLeadingQueuedTurnInputs(session);
    assert.equal(drained.items.length, 1);
    assert.equal(session.queue.length, 1);
  }
});

test('MessageRouter leaves a different QQ conversation for provider call three after an active tool loop', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('qq_conversation_boundary_call_three');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let chatCalls = 0;
  const turnIds: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session, _iteration: number, options: any) => {
    chatCalls += 1;
    turnIds.push(options?.turnId);
    if (parts) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    if (chatCalls === 1) {
      const toolCall = { id: 'call-1', name: 'read', args: { filePath: 'README.md' } };
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    const text = chatCalls === 2 ? 'first conversation final' : 'second conversation final';
    await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text }] });
    return { text, allParts: [{ text }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(session.id, {
      type: 'user',
      source: { platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-b', channelUserId: 'c2c:user-b', qqbotMessageId: 'qq-2' },
      parts: [{ text: 'different conversation input' }],
    });
    return { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }] };
  };

  try {
    session.queue.push({
      type: 'user', parts: [{ text: 'first conversation input' }],
      source: { platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-a', channelUserId: 'c2c:user-a', qqbotMessageId: 'qq-1' },
    });
    await processOwnedTestQueue(router, session);
    assert.equal(chatCalls, 3);
    assert.equal(turnIds.length, 3);
    assert.match(turnIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(turnIds[0], turnIds[1], 'one session turn keeps one TURN_ID across its tool loop');
    assert.notEqual(turnIds[0], turnIds[2], 'a later runSessionTurn receives a new TURN_ID');
    assert.equal(userTextOccurrences(session, 'different conversation input'), 1);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter keeps a different QQ conversation separate at the pre-final safe point', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('qq_conversation_boundary_pre_final');
  const originalChat = llm.chat;
  const broadcasts: Array<{ text: string; options?: any }> = [];
  let chatCalls = 0;
  session.broadcast = (text: string, options?: any) => broadcasts.push({ text, options });

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    chatCalls += 1;
    if (parts) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    if (chatCalls === 1) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'first conversation final' }] });
      await sessionManager.enqueueSessionItem(session.id, {
        type: 'user',
        source: {
          platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-b',
          channelUserId: 'c2c:user-b', qqbotMessageId: 'qq-2',
        },
        parts: [{ text: 'different conversation input' }],
      });
      return { text: 'first conversation final', allParts: [{ text: 'first conversation final' }] };
    }

    assert.equal(userTextOccurrences(activeSession, 'different conversation input'), 1);
    await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'second conversation final' }] });
    return { text: 'second conversation final', allParts: [{ text: 'second conversation final' }] };
  };

  try {
    session.queue.push({
      type: 'user', parts: [{ text: 'first conversation input' }],
      source: {
        platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-a',
        channelUserId: 'c2c:user-a', qqbotMessageId: 'qq-1',
      },
    });
    await processOwnedTestQueue(router, session);

    assert.equal(chatCalls, 2);
    assert.deepEqual(broadcasts.map(entry => entry.text), [
      'first conversation final',
      'second conversation final',
    ]);
    assert.equal(broadcasts.every(entry => entry.options?.turnFinal === true), true);
    assert.equal(broadcasts.some(entry => entry.options?.parse_mode === 'Markdown'), false);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter applies pending auto-compaction before a late compatible follow-up provider call', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('late_followup_compaction_gate');
  const originalChat = llm.chat;
  const originalProcessSessionCompactionRequest = sessionManager.processSessionCompactionRequest;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const source = { platform: 'qqbot', channelId: 'qq-a', conversationId: 'c2c:user-a', channelUserId: 'c2c:user-a', qqbotMessageId: 'qq-1' };
  let chatCalls = 0;
  let compactRequests = 0;
  let compactApplies = 0;
  session.compactThresholdTokens = 10;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    chatCalls += 1;
    if (parts) await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    if (chatCalls === 1) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'intermediate answer' }] });
      await sessionManager.enqueueSessionItem(session.id, {
        type: 'user', source: { ...source, qqbotMessageId: 'qq-2' }, parts: [{ text: 'late compacted follow-up' }],
      });
      return { text: 'intermediate answer', allParts: [{ text: 'intermediate answer' }], usage: { cachedTokens: 0, inputTokens: 100, outputTokens: 10 } };
    }
    assert.equal(parts, null);
    assert.equal(compactApplies, 1, 'pending compact must apply before provider call two');
    assert.equal(userTextOccurrences(activeSession, 'late compacted follow-up'), 1);
    await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'final after compact' }] });
    return { text: 'final after compact', allParts: [{ text: 'final after compact' }] };
  };
  (sessionManager as any).processSessionCompactionRequest = async (_sessionId: string, _item: any, mode: string) => {
    assert.equal(mode, 'auto');
    compactRequests += 1;
    session.queue.push({ type: 'compact-commit' });
  };
  (sessionManager as any).applyCompletedCompactJob = async () => { compactApplies += 1; return true; };

  try {
    session.queue.push({ type: 'user', parts: [{ text: 'first compacted input' }], source });
    await processOwnedTestQueue(router, session);
    assert.equal(chatCalls, 2);
    assert.equal(compactRequests, 1);
    assert.equal(compactApplies, 1);
    assert.equal(userTextOccurrences(session, 'first compacted input'), 1);
    assert.equal(userTextOccurrences(session, 'late compacted follow-up'), 1);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (sessionManager as any).processSessionCompactionRequest = originalProcessSessionCompactionRequest;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('MessageRouter snapshots and serializes direct-reply routing intent', () => {
  const router = new MessageRouter() as any;
  const baseCtx = {
    channelUserId: 'conversation-a',
    conversationId: 'conversation-a',
    channelId: 'channel-a',
    channelType: 'test',
    username: 'user-a',
    platform: 'test',
    reply: async () => {},
    sendTyping: async () => {},
  };
  const direct = router.buildChannelUserQueueItem({ ...baseCtx, preferDirectReply: true }, {
    parts: [{ text: 'direct' }], channelUserId: 'conversation-a', conversationId: 'conversation-a',
  });
  const broadcast = router.buildChannelUserQueueItem({ ...baseCtx, preferDirectReply: false }, {
    parts: [{ text: 'broadcast' }], channelUserId: 'conversation-a', conversationId: 'conversation-a',
  });

  assert.equal(JSON.parse(JSON.stringify(direct)).source.preferDirectReply, true);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(broadcast)).source, 'preferDirectReply'), false);
});

test('MessageRouter keeps different direct-reply intents in separate queued turns', () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      { type: 'user', source: { platform: 'test', channelUserId: 'conversation', preferDirectReply: true }, parts: [{ text: 'direct' }] },
      { type: 'user', source: { platform: 'test', channelUserId: 'conversation' }, parts: [{ text: 'broadcast' }] },
    ],
  };

  const drained = router.turnRunner.drainLeadingQueuedTurnInputs(session);
  assert.equal(drained.items.length, 1);
  assert.equal(drained.items[0].source?.preferDirectReply, true);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter source boundaries do not collide with sentinel-like legal stream ids', () => {
  const router = new MessageRouter() as any;
  const sentinelLike = 'stream-a\u0000prefer-direct-reply';
  const falseSentinelSource = { platform: 'wework', channelUserId: 'conversation', weworkStreamId: sentinelLike };
  const trueNormalSource = { platform: 'wework', channelUserId: 'conversation', weworkStreamId: 'stream-a', preferDirectReply: true };
  for (const sources of [[falseSentinelSource, trueNormalSource], [trueNormalSource, falseSentinelSource]]) {
    const session: any = { queue: sources.map((source, index) => ({ type: 'user', source, parts: [{ text: `item-${index}` }] })) };
    assert.equal(router.turnRunner.drainLeadingQueuedTurnInputs(session).items.length, 1);
    assert.equal(session.queue.length, 1);
  }

  for (const source of [falseSentinelSource, { ...falseSentinelSource, preferDirectReply: true }]) {
    const session: any = { queue: [
      { type: 'user', source, parts: [{ text: 'same-a' }] },
      { type: 'user', source: { ...source }, parts: [{ text: 'same-b' }] },
    ] };
    assert.equal(router.turnRunner.drainLeadingQueuedTurnInputs(session).items.length, 2);
    assert.equal(session.queue.length, 0);
  }
});

test('MessageRouter does not merge a different direct-reply intent into an active turn', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    queue: [
      { type: 'user', source: { platform: 'test', channelUserId: 'conversation' }, parts: [{ text: 'broadcast follow-up' }] },
    ],
  };
  const directKey = router.turnRunner.getSourceMergeBoundary({
    platform: 'test', channelUserId: 'conversation', preferDirectReply: true,
  });
  const consumed = await router.turnRunner.consumeLeadingQueuedTurnInputs(session, [{ text: 'current direct turn' }], directKey);
  assert.equal(consumed.consumedInput, false);
  assert.equal(session.queue.length, 1);
});

test('MessageRouter active turns do not decode sentinel-like stream suffixes as direct intent', async () => {
  const router = new MessageRouter() as any;
  const session: any = {
    history: [],
    queue: [
      { type: 'user', source: { platform: 'test', channelUserId: 'conversation' }, parts: [{ text: 'unbound broadcast follow-up' }] },
    ],
  };
  const boundary = router.turnRunner.getSourceMergeBoundary({
    platform: 'wework', channelUserId: 'conversation', weworkStreamId: 'stream-a\u0000prefer-direct-reply',
  });
  const originalAppend = sessionManager.appendSessionMessage;
  (sessionManager as any).appendSessionMessage = async (target: any, message: Message) => target.history.push(message);
  try {
    const consumed = await router.turnRunner.consumeLeadingQueuedTurnInputs(session, null, boundary);
    assert.equal(consumed.consumedInput, true);
    assert.equal(session.queue.length, 0);
  } finally {
    (sessionManager as any).appendSessionMessage = originalAppend;
  }
});

test('SessionTurnRunner terminal provider delivery uses snapshotted direct intent instead of a mutated live context flag', async () => {
  const router = new MessageRouter() as any;
  const directReplies: string[] = [];
  const broadcasts: string[] = [];
  const session: any = { broadcast: (text: string) => broadcasts.push(text) };
  const ctx: any = {
    channelUserId: 'conversation-a', conversationId: 'conversation-a', channelId: 'channel-a',
    channelType: 'test', username: 'user-a', platform: 'test', preferDirectReply: true,
    reply: async (text: string) => { directReplies.push(text); }, sendTyping: async () => {},
  };
  const directSource = router.turnRunner.snapshotSource(ctx);
  ctx.preferDirectReply = false;
  assert.equal(await router.turnRunner.deliverProviderResultText(session, ctx, directSource, 'direct once', false, session.broadcast, {}), true);
  assert.deepEqual(directReplies, ['direct once']);
  assert.deepEqual(broadcasts, []);

  ctx.preferDirectReply = true;
  await router.turnRunner.deliverProviderResultText(session, ctx, { platform: 'test', channelUserId: 'conversation-a' }, 'broadcast absent', false, session.broadcast, {});
  await router.turnRunner.deliverProviderResultText(session, ctx, { platform: 'test', channelUserId: 'conversation-a', preferDirectReply: false }, 'broadcast false', false, session.broadcast, {});
  assert.deepEqual(directReplies, ['direct once']);
  assert.deepEqual(broadcasts, ['broadcast absent', 'broadcast false']);

  await router.turnRunner.deliverProviderResultText(session, { ...ctx, reply: undefined }, directSource, 'fallback without callback', false, session.broadcast, {});
  assert.deepEqual(broadcasts, ['broadcast absent', 'broadcast false', 'fallback without callback']);
});

test('MessageRouter emits turn progress as an empty targeted channel broadcast', () => {
  const router = new MessageRouter() as any;
  const events: Array<{ text: string; options: any }> = [];

  router.turnRunner.emitTurnProgress((text: string, options?: any) => events.push({ text, options }), {
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
    const notify = router.turnRunner.createLlmRetryNotifier(
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
  const broadcasts: Array<{ text: string; options: any }> = [];
  const session = await createRouterQueueTestSession('retry_final_failure_session');
  session.broadcast = (text: string, options?: any) => { broadcasts.push({ text, options }); };
  const originalChat = llm.chat;
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
    session.queue.push({ type: 'user', parts: [{ text: 'trigger final failure' }] });
    await processOwnedTestQueue(router, session);

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
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('retrySession enters the router directly and runs one ordinary turn without queue control state', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('retry_control_session');
  const sessionId = session.id;
  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts: [{ text: 'original failed request' }],
  });

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let chatCallCount = 0;
  const seenParts: Array<MessagePart[] | null> = [];
  const seenRequests: Message[][] = [];

  sessionManager.setSessionRetryCallback(async (targetSessionId) => {
    assert.equal(targetSessionId, sessionId);
    await router.processSessionRetry(targetSessionId);
  });
  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    chatCallCount += 1;
    seenParts.push(parts);
    seenRequests.push(structuredClone(activeSession.history));
    if (chatCallCount === 1) {
      const toolCall = { id: 'retry-tool', name: 'read', args: { filePath: 'README.md' } };
      await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    await appendMockChatMessages(activeSession, parts, [{ text: 'retried response' }]);
    return { text: 'retried response', allParts: [{ text: 'retried response' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(sessionId, {
      type: 'user',
      parts: [{ text: 'queued during retry tool' }],
    });
    return {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'retry-tool', name: 'read', response: { output: 'ok' } } }],
    };
  };

  try {
    session.queue.push(
      { type: 'user', parts: [{ text: 'queued after retry' }] },
      {
        type: 'intersession',
        message: { role: 'user', parts: [{ system: 'queued intersession after retry' }] },
      },
    );
    assert.deepEqual(session.queue.map(item => item.type), ['user', 'intersession']);

    await sessionManager.retrySession(sessionId);

    assert.equal(chatCallCount, 2);
    assert.equal(seenParts[0], null);
    assert.equal(seenParts[1], null);
    assert.equal(countHistoryPartText(seenRequests[0], 'queued after retry'), 1);
    assert.equal(countHistoryPartSystem(seenRequests[0], 'queued intersession after retry'), 1);
    const firstRetryInputs = seenRequests[0].filter(message => message.role === 'user'
      && message.parts.some(part => part.text === 'queued after retry' || part.system === 'queued intersession after retry'));
    assert.equal(firstRetryInputs.length, 2);
    assert.equal(countHistoryPartText(seenRequests[0], 'queued during retry tool'), 0);
    assert.equal(countHistoryPartText(seenRequests[1], 'queued during retry tool'), 1);
    assert.equal(userTextOccurrences(session, 'queued after retry'), 1);
    assert.equal(userTextOccurrences(session, 'queued during retry tool'), 1);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(session.history.some(message => message.parts.some(part => /retrying last request|retrying-last-request/.test(String(part.text || part.system || '')))), false);
    assert.equal(session.history.some(message => message.role === 'model' && message.parts.some(part => part.text === 'retried response')), true);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.setSessionRetryCallback(() => {});
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('router drops an unrecognized persisted queue record without executing it', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('unknown_queue_record');
  const originalChat = llm.chat;
  let chatCalls = 0;
  session.queue = [
    { type: 'obsolete-control' } as any,
  ];
  await sessionManager.saveSession(session.id);

  (llm as any).chat = async () => {
    chatCalls += 1;
    return { text: 'unexpected', allParts: [{ text: 'unexpected' }] };
  };

  try {
    await router.processSessionQueue(session.id);

    assert.equal(chatCalls, 0);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('busy async compaction starts snapshot planning directly without a compact queue item', async () => {
  const session = await createRouterQueueTestSession('busy_async_compact_direct');
  const originalIsAsyncCompactEnabled = sessionHistory.isAsyncCompactEnabled;
  const originalProcessSessionCompactionRequest = sessionHistory.processSessionCompactionRequest;
  const modes: string[] = [];
  session.busy = true;
  session.queue.push({ type: 'user', parts: [{ text: 'ordinary queued content' }] });
  await sessionManager.saveSession(session.id);
  (sessionHistory as any).isAsyncCompactEnabled = () => true;
  (sessionHistory as any).processSessionCompactionRequest = async (_deps: any, _sessionId: string, _item: any, mode: string) => {
    modes.push(mode);
  };

  try {
    const result = await sessionManager.requestSessionCompaction(session.id, { keepPercent: 0.5 });

    assert.equal(result.startedImmediately, true);
    assert.equal(result.runsInBackground, true);
    assert.equal(result.backgroundUnavailable, undefined);
    assert.deepEqual(modes, ['background']);
    assert.deepEqual(session.queue.map(item => item.type), ['user']);
  } finally {
    (sessionHistory as any).isAsyncCompactEnabled = originalIsAsyncCompactEnabled;
    (sessionHistory as any).processSessionCompactionRequest = originalProcessSessionCompactionRequest;
    session.busy = false;
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('busy asyncCompact false request reports unavailable without queueing hidden planning work', async () => {
  const session = await createRouterQueueTestSession('busy_sync_compact_rejected');
  const originalIsAsyncCompactEnabled = sessionHistory.isAsyncCompactEnabled;
  const originalProcessSessionCompactionRequest = sessionHistory.processSessionCompactionRequest;
  let planningCalls = 0;
  session.busy = true;
  await sessionManager.saveSession(session.id);
  (sessionHistory as any).isAsyncCompactEnabled = () => false;
  (sessionHistory as any).processSessionCompactionRequest = async () => {
    planningCalls += 1;
  };

  try {
    const result = await sessionManager.requestSessionCompaction(session.id, { keepPercent: 0.5 });

    assert.equal(result.startedImmediately, false);
    assert.equal(result.backgroundUnavailable, true);
    assert.equal(planningCalls, 0);
    assert.equal(session.queue.length, 0);
  } finally {
    (sessionHistory as any).isAsyncCompactEnabled = originalIsAsyncCompactEnabled;
    (sessionHistory as any).processSessionCompactionRequest = originalProcessSessionCompactionRequest;
    session.busy = false;
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('stop signal commits queued work to history without running it', async () => {
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
    await sessionManager.enqueueSessionItem(sessionId, {
      type: 'user',
      clientMessageId: 'queued-after-stop-client-id',
      parts: [{ text: 'queued after stop' }],
    });
    await sessionManager.requestSessionStop(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'stop-tool', name: 'read', response: { output: 'stopped' } } }] };
  };

  try {
    session.queue.push({ type: 'user', parts: [{ text: 'start current turn' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts.length, 1);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(userTextOccurrences(session, 'queued after stop'), 1);
    const queuedHistoryMessage = session.history.find(message => message.parts.some(part => part.text === 'queued after stop'));
    assert.equal(queuedHistoryMessage?.__meta?.clientMessageId, 'queued-after-stop-client-id');

    await processOwnedTestQueue(router, session);
    assert.equal(seenParts.length, 1);

    const deletion = await sessionManager.deleteMessages(sessionId, -1);
    assert.equal(deletion.deleted, 1);
    assert.equal(userTextOccurrences(session, 'queued after stop'), 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('stop commits content and applies a ready compact commit', async () => {
  const router = new MessageRouter() as any;
  const sessionId = `stop_commit_mixed_queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  let chatCallCount = 0;
  let compactCommitCalls = 0;

  (llm as any).chat = async () => {
    chatCallCount += 1;
    const toolCall = { id: 'stop-mixed-tool', name: 'read', args: { filePath: 'README.md' } };
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(sessionId, {
      type: 'user',
      clientMessageId: 'mixed-user-client-id',
      parts: [{ text: 'queued user first' }],
    });
    await sessionManager.enqueueSessionItem(sessionId, {
      type: 'intersession',
      message: { role: 'user', parts: [{ text: 'queued structured second' }] },
    });
    await sessionManager.enqueueSessionItem(sessionId, {
      type: 'background',
      parts: [{ system: 'queued background third' }],
    });
    await sessionManager.enqueueSessionItem(sessionId, { type: 'compact-commit' });
    await sessionManager.requestSessionStop(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'stop-mixed-tool', name: 'read', response: { output: 'stopped' } } }] };
  };
  (sessionManager as any).applyCompletedCompactJob = async () => {
    compactCommitCalls += 1;
    return true;
  };

  try {
    session.queue.push({ type: 'user', parts: [{ text: 'start mixed turn' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(chatCallCount, 1);
    assert.equal(session.queue.length, 0);
    assert.equal(compactCommitCalls, 1);
    const queuedHistory = session.history.filter(message => message.parts.some(part => (
      part.text === 'queued user first'
      || part.text === 'queued structured second'
      || part.system === 'queued background third'
    )));
    assert.deepEqual(queuedHistory.map(message => message.parts[0]?.text || message.parts[0]?.system), [
      'queued user first',
      'queued structured second',
      'queued background third',
    ]);
    assert.equal(queuedHistory[0]?.__meta?.clientMessageId, 'mixed-user-client-id');
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('stop commits content that arrives while stop history is being finalized', async () => {
  const router = new MessageRouter() as any;
  const sessionId = `stop_commit_finalizing_arrival_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalAppendSessionMessages = sessionManager.appendSessionMessages;
  let chatCallCount = 0;
  let injectedDuringFinalization = false;

  (llm as any).chat = async () => {
    chatCallCount += 1;
    const toolCall = { id: 'stop-finalizing-tool', name: 'read', args: { filePath: 'README.md' } };
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(sessionId, { type: 'user', parts: [{ text: 'queued before finalization' }] });
    await sessionManager.requestSessionStop(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'stop-finalizing-tool', name: 'read', response: { output: 'stopped' } } }] };
  };
  (sessionManager as any).appendSessionMessages = async (...args: Parameters<typeof sessionManager.appendSessionMessages>) => {
    await originalAppendSessionMessages(...args);
    const messages = args[1];
    if (!injectedDuringFinalization && messages.some(message => message.parts.some(part => part.text === 'queued before finalization'))) {
      injectedDuringFinalization = true;
      assert.equal(session.stopping, true);
      await sessionManager.enqueueSessionItem(sessionId, {
        type: 'intersession',
        message: { role: 'user', parts: [{ text: 'arrived during finalization' }] },
      });
    }
  };

  try {
    session.queue.push({ type: 'user', parts: [{ text: 'start finalizing turn' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(chatCallCount, 1);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(session.stopping, false);
    assert.deepEqual(session.history
      .filter(message => message.parts.some(part => (
        part.text === 'queued before finalization' || part.text === 'arrived during finalization'
      )))
      .map(message => message.parts.find(part => part.text)?.text), [
        'queued before finalization',
        'arrived during finalization',
      ]);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).appendSessionMessages = originalAppendSessionMessages;
    sessionManager.clearActiveSessionRuntimeState(session.id);
    await sessionManager.deleteSession(session.id).catch(() => {});
  }
});

test('input after the stop boundary is handed to a fresh processor instead of losing its trigger', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('stop_post_boundary_handoff');
  const sessionId = session.id;
  session.queue = [{ type: 'user', parts: [{ text: 'start stop-boundary turn' }] }];
  await sessionManager.saveSession(sessionId);

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalFinalizeStoppedSession = router.turnRunner.finalizeStoppedSession.bind(router.turnRunner);
  const processedAfterBoundary = new Promise<void>((resolve) => {
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      const call = session.history.some(message => message.parts.some(part => part.text === 'after stop boundary')) ? 2 : 1;
      if (call === 1) {
        const toolCall = { id: 'stop-boundary-tool', name: 'read', args: { filePath: 'README.md' } };
        await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
        return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
      }
      await appendMockChatMessages(activeSession, parts, [{ text: 'processed after boundary' }]);
      resolve();
      return { text: 'processed after boundary', allParts: [{ text: 'processed after boundary' }] };
    };
  });
  (llm as any).executeTools = async () => {
    await sessionManager.requestSessionStop(sessionId);
    return { parts: [{ functionResponse: { tool_use_id: 'stop-boundary-tool', name: 'read', response: { output: 'stopped' } } }] };
  };
  router.turnRunner.finalizeStoppedSession = async (...args: any[]) => {
    const committed = await originalFinalizeStoppedSession(...args);
    session.queue.push({ type: 'user', parts: [{ text: 'after stop boundary' }] });
    return committed;
  };

  try {
    await processOwnedTestQueue(router, session);
    await processedAfterBoundary;
    while (session.busy) {
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(userTextOccurrences(session, 'after stop boundary'), 1);
    assert.equal(session.history.some(message => message.parts.some(part => part.text === 'processed after boundary')), true);
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
    session.queue.push({ type: 'user', parts: [{ text: 'start current turn' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts.length, 2);
    assert.equal(seenParts[1], null);
    assert.equal(userTextOccurrences(session, 'queued for dequeue'), 1);
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
    session.queue.push({ type: 'user', parts: [{ text: 'A' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts[0], null, 'owned queued input is already canonical before the provider call');
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
    session.queue.push({ type: 'user', parts: [{ text: 'A' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts[0], null, 'owned queued input is already canonical before the provider call');
    assert.equal(seenParts[1], null);
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

test('MessageRouter in-tool queue consumption preserves each queued input as separate history before the next model request', async () => {
  const router = new MessageRouter() as any;
  const session = await createRouterQueueTestSession('in_tool_queue_message_boundaries');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const seenRequests: Message[][] = [];
  let chatCount = 0;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    chatCount += 1;
    seenRequests.push(structuredClone(activeSession.history));
    if (chatCount === 1) {
      const toolCall = { id: 'queue-boundary-tool', name: 'read', args: { filePath: 'README.md' } };
      await appendMockChatMessages(activeSession, parts, [{ functionCall: toolCall }]);
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    assert.equal(parts, null);
    await appendMockChatMessages(activeSession, parts, [{ text: 'handled queued follow-ups' }]);
    return { text: 'handled queued follow-ups', allParts: [{ text: 'handled queued follow-ups' }] };
  };
  (llm as any).executeTools = async () => {
    await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'queued user follow-up' }] });
    await sessionManager.enqueueSessionItem(session.id, {
      type: 'intersession',
      message: { role: 'user', parts: [{ system: 'queued intersession follow-up' }] },
    });
    return { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'queue-boundary-tool', name: 'read', response: { output: 'ok' } } }] };
  };

  try {
    session.queue.push({ type: 'user', parts: [{ text: 'initial request' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenRequests.length, 2);
    assert.equal(countHistoryPartText(seenRequests[1], 'queued user follow-up'), 1);
    assert.equal(countHistoryPartSystem(seenRequests[1], 'queued intersession follow-up'), 1);
    const queuedInputMessages = seenRequests[1].filter(message => message.role === 'user'
      && message.parts.some(part => part.text === 'queued user follow-up' || part.system === 'queued intersession follow-up'));
    assert.equal(queuedInputMessages.length, 2);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
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
    session.queue.push({ type: 'user', parts: [{ text: 'A' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts[0], null, 'owned queued input is already canonical before the provider call');
    assert.equal(seenParts[1], null);
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

test('MessageRouter preserves owned queued input across a leading compact action', async () => {
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
    session.queue.push({ type: 'user', parts: [{ text: 'A' }] });
    await processOwnedTestQueue(router, session);

    assert.equal(seenParts[0], null, 'owned queued input is already canonical before the provider call');
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
  const sessionId = `runtime_requesting_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [{ type: 'user', parts: [{ text: 'hello' }] }];
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
    const running = processOwnedTestQueue(router, session);

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
  const sessionId = `runtime_tool_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sessionId) as Session;
  session.history = [];
  session.persistentMemorySnapshot = 'system prompt';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [{ type: 'user', parts: [{ text: 'use tool' }] }];
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
    const running = processOwnedTestQueue(router, session);

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
