import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkStreamResponse,
  stripWeWorkThinkTags,
  truncateUtf8,
  WeWorkStreamAggregator,
  WEWORK_STREAM_CONTENT_BYTE_LIMIT,
} from './weworkStreamAggregator';

test('WeWorkStreamAggregator aggregates model text and tool progress into one stream', () => {
  const aggregator = new WeWorkStreamAggregator();
  const first = aggregator.begin('chat-1', { mode: 'webhook', responseUrl: 'https://example.test/response' }, 'stream-1');

  assert.equal(first.content, '<think></think>');
  assert.equal(first.finish, false);

  let updated = aggregator.appendByStreamId('stream-1', 'model 文本消息 1');
  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [
      { id: 'call-1', name: 'exec' },
      { id: 'call-2', name: 'read' },
    ],
  });
  assert.equal(updated?.content, '<think>\nmodel 文本消息 1\n\n> ⌛️ exec | ⌛️ read\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [
      { id: 'call-1', name: 'exec', status: 'success' },
      { id: 'call-2', name: 'read', status: 'success' },
    ],
  });
  updated = aggregator.applyProgressByStreamId('stream-1', { type: 'llm-start' });
  assert.equal(updated?.content, '<think>\nmodel 文本消息 1\n\n> ☑️ exec | ☑️ read | 🤔 thinking\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-3', name: 'exec' }],
  });
  assert.equal(updated?.content, '<think>\nmodel 文本消息 1\n\n> ☑️ exec | ☑️ read | ⌛️ exec\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [{ id: 'call-3', name: 'exec', status: 'success' }],
  });
  updated = aggregator.appendByStreamId('stream-1', 'model 文本消息 2', { finish: true });
  assert.equal(updated?.finish, true);
  assert.equal(updated?.content, '<think>\nmodel 文本消息 1\n\n> ☑️ exec ×2 | ☑️ read\n</think>\nmodel 文本消息 2');

  assert.deepEqual(buildWeWorkStreamResponse(updated!), {
    msgtype: 'stream',
    stream: {
      id: 'stream-1',
      finish: true,
      content: '<think>\nmodel 文本消息 1\n\n> ☑️ exec ×2 | ☑️ read\n</think>\nmodel 文本消息 2',
    },
  });
});

test('WeWorkStreamAggregator groups non-adjacent tool calls by name and status', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  let updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [
      { id: 'call-1', name: 'exec' },
      { id: 'call-2', name: 'read' },
      { id: 'call-3', name: 'exec' },
      { id: 'call-4', name: 'write' },
      { id: 'call-5', name: 'exec' },
    ],
  });
  assert.equal(updated?.content, '<think>\n> ⌛️ exec ×3 | ⌛️ read | ⌛️ write\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-5', name: 'exec' }],
  });
  assert.equal(updated?.content, '<think>\n> ⌛️ exec ×3 | ⌛️ read | ⌛️ write\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [
      { id: 'call-1', name: 'exec', status: 'success' },
      { id: 'call-2', name: 'read', status: 'error' },
      { id: 'call-3', name: 'exec', status: 'success' },
    ],
  });
  assert.equal(updated?.content, '<think>\n> ☑️ exec ×2 | ❌ read | ⌛️ write | ⌛️ exec\n</think>');
});

test('WeWorkStreamAggregator keeps tool aggregation within each text-delimited block', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-1', name: 'exec' }],
  });
  aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [{ id: 'call-1', name: 'exec', status: 'success' }],
  });

  let updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    text: 'model text between tool batches',
    calls: [{ id: 'call-2', name: 'exec' }],
  });
  assert.equal(updated?.content, '<think>\n> ☑️ exec\n\nmodel text between tool batches\n\n> ⌛️ exec\n</think>');

  updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-finish',
    results: [{ id: 'call-2', name: 'exec', status: 'success' }],
  });
  assert.equal(updated?.content, '<think>\n> ☑️ exec\n\nmodel text between tool batches\n\n> ☑️ exec\n</think>');
});

test('WeWorkStreamAggregator can apply model text and running tools atomically', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  const updated = aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    text: 'model text before tools',
    calls: [{ id: 'call-1', name: 'exec' }],
  });

  assert.equal(updated?.content, '<think>\nmodel text before tools\n\n> ⌛️ exec\n</think>');
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
  assert.equal(newQueued?.content, '<think>\nqueued notice\n</think>');
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

test('WeWorkStreamAggregator closes the fold only in the final frame in open style', () => {
  const aggregator = new WeWorkStreamAggregator({ thinkFrame: 'open' });
  const first = aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  assert.equal(first.content, '<think>');
  assert.equal(first.finish, false);

  const streaming = aggregator.appendByStreamId('stream-1', 'step one');
  assert.equal(streaming?.content, '<think>\nstep one');
  assert.equal(streaming?.finish, false);

  const finished = aggregator.appendByStreamId('stream-1', 'the answer', { finish: true });
  assert.equal(finished?.finish, true);
  assert.equal(finished?.content, '<think>\nstep one\n</think>\nthe answer');
});

test('WeWorkStreamAggregator keeps a suspended card open and closes it on the later answer', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  aggregator.applyProgressByStreamId('stream-1', { type: 'llm-start' });
  const parked = aggregator.appendByStreamId('stream-1', 'waiting for a child session');

  // A turn that ends by waiting must not finish the card.
  assert.equal(parked?.finish, false);
  assert.equal(aggregator.getByConversation('chat-1')?.finish, false);
  assert.equal(aggregator.hasActive('chat-1'), true);

  // The resumed turn appends to the same fold and the answer body closes it.
  aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    calls: [{ id: 'call-1', name: 'session' }],
  });
  const resumed = aggregator.appendByStreamId('stream-1', 'the answer', { finish: true });
  assert.equal(resumed?.finish, true);
  assert.equal(
    resumed?.content,
    '<think>\nwaiting for a child session\n\n> ⌛️ session\n</think>\nthe answer',
  );
  assert.equal(aggregator.hasActive('chat-1'), false);
});

test('WeWorkStreamAggregator keeps the closed pair when a final frame is truncated', () => {
  const aggregator = new WeWorkStreamAggregator({ maxContentBytes: 2000 });
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');
  aggregator.applyProgressByStreamId('stream-1', {
    type: 'tool-calls-start',
    text: 'process '.repeat(500),
    calls: [{ id: 'call-1', name: 'exec' }],
  });
  const finished = aggregator.appendByStreamId('stream-1', 'answer '.repeat(500), { finish: true });
  const content = finished?.content || '';

  assert.ok(Buffer.byteLength(content, 'utf8') <= 2000);
  const closeIndex = content.indexOf('</think>');
  assert.ok(closeIndex > 0, 'the closing think tag must survive truncation');
  assert.ok(content.startsWith('<think>\n'));
  assert.ok(content.slice(closeIndex + '</think>'.length).includes('answer'), 'the answer body must stay outside the fold');
});

test('WeWorkStreamAggregator keeps an ordinary answer out of an empty fold', () => {
  const aggregator = new WeWorkStreamAggregator();
  aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  const finished = aggregator.appendByStreamId('stream-1', 'direct answer', { finish: true });

  assert.equal(finished?.content, 'direct answer');
});

test('WeWorkStreamAggregator refresh touches keep an unfinished card inside its TTL', () => {
  const aggregator = new WeWorkStreamAggregator({ ttlMs: 1000 });
  const started = aggregator.begin('chat-1', { mode: 'webhook' }, 'stream-1');

  assert.equal(aggregator.touchByStreamId('stream-1', started.updatedAt + 800)?.streamId, started.streamId);
  assert.equal(aggregator.cleanupExpired(started.updatedAt + 1700), 0, 'the refresh restarts the TTL window');
  assert.equal(aggregator.cleanupExpired(started.updatedAt + 2100), 1);
});

test('stripWeWorkThinkTags removes fold tags from proactive content', () => {
  assert.equal(stripWeWorkThinkTags('<think>\nstep\n</think>\nthe answer'), '\nstep\n\nthe answer');
  assert.equal(stripWeWorkThinkTags('plain answer'), 'plain answer');
});
