import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkStreamResponse,
  truncateUtf8,
  WeWorkStreamAggregator,
  WEWORK_STREAM_CONTENT_BYTE_LIMIT,
} from './weworkStreamAggregator';

test('WeWorkStreamAggregator aggregates model text and tool progress into one stream', () => {
  const aggregator = new WeWorkStreamAggregator();
  const first = aggregator.begin('chat-1', { mode: 'webhook', responseUrl: 'https://example.test/response' }, 'stream-1');

  assert.equal(first.content, '> 🤔 thinking');
  assert.equal(first.finish, false);

  let updated = aggregator.appendByStreamId('stream-1', 'model 文本消息 1');
  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [
      { id: 'call-1', name: 'exec' },
      { id: 'call-2', name: 'read' },
    ],
  });
  assert.equal(updated?.content, 'model 文本消息 1\n\n> ⌛️ exec | ⌛️ read');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [
      { id: 'call-1', name: 'exec', status: 'success' },
      { id: 'call-2', name: 'read', status: 'success' },
    ],
  });
  updated = aggregator.applyProgressByStreamId('stream-1', { type: 'llm-start' });
  assert.equal(updated?.content, 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | 🤔 thinking');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-3', name: 'exec' }],
  });
  assert.equal(updated?.content, 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | ⌛️ exec');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [{ id: 'call-3', name: 'exec', status: 'success' }],
  });
  updated = aggregator.appendByStreamId('stream-1', 'model 文本消息 2', { finish: true });
  assert.equal(updated?.finish, true);
  assert.equal(updated?.content, 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | ☑️ exec\n\nmodel 文本消息 2');

  assert.deepEqual(buildWeWorkStreamResponse(updated!), {
    msgtype: 'stream',
    stream: {
      id: 'stream-1',
      finish: true,
      content: 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | ☑️ exec\n\nmodel 文本消息 2',
    },
  });
});

test('WeWorkStreamAggregator can apply model text and running tools atomically', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  const updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    text: 'model text before tools',
    calls: [{ id: 'call-1', name: 'exec' }],
  });

  assert.equal(updated?.content, 'model text before tools\n\n> ⌛️ exec');
});

test('WeWorkStreamAggregator supersedes an old card without transient tool status', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  aggregator.appendByStreamId('stream-1', 'substantive model text');
  aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-1', name: 'read' }],
  });
  const oldFinal = aggregator.supersedeActive('chat-1');
  const second = aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-2');

  const newQueued = aggregator.appendByStreamId('stream-2', 'queued notice');

  assert.equal(oldFinal?.finish, true);
  assert.equal(oldFinal?.content, 'substantive model text');
  assert.equal(aggregator.getByStreamId('stream-1')?.content.includes('thinking'), false);
  assert.equal(aggregator.getByStreamId('stream-1')?.content.includes('read'), false);
  assert.equal(newQueued?.finish, false);
  assert.equal(newQueued?.content, 'queued notice');
  assert.equal(second.streamId, 'stream-2');
});

test('WeWorkStreamAggregator gives an empty superseded card legal final content', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  const oldFinal = aggregator.supersedeActive('chat-1');

  assert.equal(oldFinal?.finish, true);
  assert.equal(oldFinal?.content, '处理完成。');
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
