import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkStreamResponse,
  truncateUtf8,
  WeWorkStreamAggregator,
  WEWORK_STREAM_CONTENT_BYTE_LIMIT,
} from './weworkStreamAggregator';

test('WeWorkStreamAggregator aggregates multiple channel messages into one stream', () => {
  const aggregator = new WeWorkStreamAggregator({ initialContent: 'working' });
  const first = aggregator.begin('chat-1', { mode: 'webhook', responseUrl: 'https://example.test/response' }, 'stream-1');

  assert.equal(first.content, 'working');
  assert.equal(first.finish, false);

  let updated = aggregator.appendByStreamId('stream-1', 'first model message');
  assert.equal(updated?.content, 'first model message');

  updated = aggregator.appendByStreamId('stream-1', '🛠 *[read]*: `file`');
  assert.equal(updated?.content, 'first model message\n\n🛠 *[read]*: `file`');

  updated = aggregator.appendByStreamId('stream-1', 'final answer', { finish: true });
  assert.equal(updated?.finish, true);
  assert.equal(updated?.content, 'first model message\n\n🛠 *[read]*: `file`\n\nfinal answer');

  assert.deepEqual(buildWeWorkStreamResponse(updated!), {
    msgtype: 'stream',
    stream: {
      id: 'stream-1',
      finish: true,
      content: 'first model message\n\n🛠 *[read]*: `file`\n\nfinal answer',
    },
  });
});

test('WeWorkStreamAggregator binds updates by stream id when a new inbound message starts', () => {
  const aggregator = new WeWorkStreamAggregator({ initialContent: 'working' });
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  const second = aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-2');

  const oldFinal = aggregator.appendByStreamId('stream-1', 'old final', { finish: true });
  const newQueued = aggregator.appendByStreamId('stream-2', 'queued notice');

  assert.equal(oldFinal?.finish, true);
  assert.equal(oldFinal?.content, 'old final');
  assert.equal(newQueued?.finish, false);
  assert.equal(newQueued?.content, 'queued notice');
  assert.equal(second.streamId, 'stream-2');
});

test('WeWorkStreamAggregator cleans up expired stream states', () => {
  const aggregator = new WeWorkStreamAggregator({ ttlMs: 50 });
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  assert.equal(aggregator.cleanupExpired(Date.now() + 100), 1);
  assert.equal(aggregator.getByStreamId('stream-1'), undefined);
  assert.equal(aggregator.getByConversation('chat-1'), undefined);
});

test('WeWorkStreamAggregator clamps content to the WeWork stream byte limit', () => {
  const aggregator = new WeWorkStreamAggregator({ maxContentBytes: WEWORK_STREAM_CONTENT_BYTE_LIMIT + 1000 });
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  const updated = aggregator.appendByStreamId('stream-1', 'a'.repeat(WEWORK_STREAM_CONTENT_BYTE_LIMIT + 100));

  assert.ok(Buffer.byteLength(updated?.content || '', 'utf8') <= WEWORK_STREAM_CONTENT_BYTE_LIMIT);
});

test('truncateUtf8 respects multibyte UTF-8 byte limits', () => {
  const value = '你好'.repeat(100);
  const truncated = truncateUtf8(value, 80);

  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 80);
  assert.ok(truncated.endsWith('…[内容过长，已截断]'));
});
