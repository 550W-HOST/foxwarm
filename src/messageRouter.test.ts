import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter, shouldBroadcastChannelText } from './messageRouter';

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
