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

test('MessageRouter queue draining keeps WeWork stream-bound and unbound inputs separate', async () => {
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

  session.queue.unshift({
    type: 'user',
    source: { platform: 'wework', channelId: 'wework-a', conversationId: 'chat-a', weworkStreamId: 'stream-a' },
    parts: [{ text: 'next stream input' }],
  });
  const consumed = await router.consumeLeadingQueuedTurnInputs(
    session,
    [{ text: 'pending' }],
    'wework-a:chat-a:stream-a',
  );

  assert.equal(consumed.parts.some((part: any) => part.text === 'next stream input'), true);
  assert.equal(consumed.parts.some((part: any) => part.text === 'web input'), false);
  assert.equal(session.queue.length, 1);
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
