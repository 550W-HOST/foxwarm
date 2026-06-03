import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkStreamResponse,
  truncateUtf8,
  WeWorkStreamAggregator,
} from './weworkStreamAggregator';

test('WeWorkStreamAggregator aggregates multiple channel messages into one stream', () => {
  const aggregator = new WeWorkStreamAggregator({ initialContent: 'working' });
  const first = aggregator.begin('chat-1', { mode: 'webhook', responseUrl: 'https://example.test/response' }, 'stream-1');

  assert.equal(first.content, 'working');
  assert.equal(first.finish, false);

  let updated = aggregator.append('chat-1', 'first model message');
  assert.equal(updated?.content, 'first model message');

  updated = aggregator.append('chat-1', '🛠 *[read]*: `file`');
  assert.equal(updated?.content, 'first model message\n\n🛠 *[read]*: `file`');

  updated = aggregator.append('chat-1', 'final answer', { finish: true });
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

test('WeWorkStreamAggregator splits cards when a new inbound message begins', () => {
  const aggregator = new WeWorkStreamAggregator({ initialContent: 'working' });
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  aggregator.append('chat-1', 'old answer');

  const second = aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-2');

  assert.equal(aggregator.getByStreamId('stream-1')?.finish, true);
  assert.equal(aggregator.getByStreamId('stream-1')?.content, 'old answer');
  assert.equal(second.streamId, 'stream-2');
  assert.equal(second.content, 'working');
  assert.equal(second.finish, false);
});

test('truncateUtf8 respects multibyte UTF-8 byte limits', () => {
  const value = '你好'.repeat(100);
  const truncated = truncateUtf8(value, 80);

  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 80);
  assert.ok(truncated.endsWith('…[内容过长，已截断]'));
});
