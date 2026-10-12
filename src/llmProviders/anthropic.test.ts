import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectAnthropicMessagesStream, type AnthropicStreamProgressOptions } from './anthropic';
import type { OpenAIStreamProgressSnapshot } from './openai';

const messageStart: Record<string, any> = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 },
  },
};

function sseText(events: Array<Record<string, unknown>>, eol = '\n'): string {
  return events
    .map(event => `event: ${String(event.type)}${eol}data: ${JSON.stringify(event)}${eol}${eol}`)
    .join('');
}

function streamOfChunks(chunks: Array<string | Buffer>): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream;
}

function splitBuffer(text: string, size: number): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function collect(events: Array<Record<string, unknown>>, options?: AnthropicStreamProgressOptions, eol = '\n') {
  const controller = new AbortController();
  return collectAnthropicMessagesStream(streamOfChunks([sseText(events, eol)]), controller.signal, options);
}

const messageDelta = (stopReason: string, usage?: Record<string, unknown>, stopDetails?: unknown): Record<string, any> => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason, stop_sequence: null, ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}) },
  ...(usage ? { usage } : {}),
});

test('anthropic SSE rebuilds ordered indexed blocks, including empty thinking signatures and tool input', async () => {
  const events = [
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-EMPTY' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'SIG-A' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'Hi 🦊' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_start', index: 5, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: '{"filePath":"REA' } },
    { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: 'DME.md"}' } },
    { type: 'content_block_stop', index: 5 },
    messageDelta('tool_use', { output_tokens: 42, output_tokens_details: { thinking_tokens: 30 } }),
    { type: 'message_stop' },
  ];
  const result = await collect(events);

  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: '', signature: 'SIG-EMPTY' },
    { type: 'text', text: 'Hello ' },
    { type: 'thinking', thinking: 'plan', signature: 'SIG-A' },
    { type: 'redacted_thinking', data: 'OPAQUE' },
    { type: 'text', text: 'Hi 🦊' },
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: { filePath: 'README.md' } },
  ]);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.role, 'assistant');
});

test('byte-split, CRLF and multi-byte SSE input decode to the same message', async () => {
  const events = [
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '狐狸 🦊 done' } },
    { type: 'content_block_stop', index: 0 },
    messageDelta('end_turn', { output_tokens: 7 }),
    { type: 'message_stop' },
  ];
  const text = sseText(events, '\r\n');
  const controller = new AbortController();
  const result = await collectAnthropicMessagesStream(
    streamOfChunks(splitBuffer(text, 3)),
    controller.signal,
  );
  assert.deepEqual(result.content, [{ type: 'text', text: '狐狸 🦊 done' }]);
  assert.equal(result.usage.output_tokens, 7);
});

test('progress snapshots never carry signatures and reasoning phases bracket thinking blocks', async () => {
  const snapshots: OpenAIStreamProgressSnapshot[] = [];
  const phases: boolean[] = [];
  let meaningful = 0;
  await collect([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-SECRET' } },
    { type: 'content_block_stop', index: 0 },
    messageDelta('end_turn'),
    { type: 'message_stop' },
  ], {
    onProgress: snapshot => snapshots.push(snapshot),
    onReasoningPhase: active => phases.push(active),
    onMeaningfulProgress: () => { meaningful += 1; },
  });

  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every(snapshot => !JSON.stringify(snapshot).includes('SIG-SECRET')));
  assert.equal(snapshots.at(-1)?.reasoning, 'visible reasoning');
  assert.deepEqual(phases, [true, false]);
  assert.equal(meaningful, 1, 'ping and signature deltas must not count as visible progress');
});

test('ping-only and empty-text streams do not count as progress and unknown events are ignored', async () => {
  let meaningful = 0;
  const result = await collect([
    messageStart,
    { type: 'ping' },
    { type: 'mystery_event', payload: 1 },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    messageDelta('end_turn'),
    { type: 'message_stop' },
  ], { onMeaningfulProgress: () => { meaningful += 1; } });
  assert.equal(meaningful, 0);
  assert.deepEqual(result.content, [{ type: 'text', text: '' }]);
});

test('cumulative message_delta usage replaces earlier totals instead of adding them', async () => {
  const result = await collect([
    messageStart,
    messageDelta('end_turn', { output_tokens: 10 }),
    messageDelta('end_turn', { output_tokens: 42, output_tokens_details: { thinking_tokens: 30 } }),
    { type: 'message_stop' },
  ]);
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.cache_read_input_tokens, 3);
  assert.equal(result.usage.output_tokens, 42);
  assert.equal(result.usage.output_tokens_details.thinking_tokens, 30);
});

test('unsupported block types are kept raw for the canonical parser to reject', async () => {
  const result = await collect([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
    { type: 'content_block_stop', index: 0 },
    messageDelta('end_turn'),
    { type: 'message_stop' },
  ]);
  assert.deepEqual(result.content, [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }]);
});

test('incomplete or non-object tool JSON stays raw text and is never parsed into an object', async () => {
  const result = await collect([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_partial', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"filePath":' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_array', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '[1]' } },
    { type: 'content_block_stop', index: 1 },
    messageDelta('tool_use'),
    { type: 'message_stop' },
  ]);
  assert.equal(result.content[0].input, '{"filePath":');
  assert.equal(result.content[1].input, '[1]');
});

test('stream error events reject instead of producing a message', async () => {
  await assert.rejects(
    collect([messageStart, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]),
    /overloaded_error.*busy/,
  );
});

test('streams that end before message_stop, with an open block, or without stop_reason are rejected', async () => {
  await assert.rejects(
    collect([messageStart, messageDelta('end_turn')]),
    /ended before message_stop/,
  );
  await assert.rejects(
    collect([
      messageStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
      messageDelta('end_turn'),
      { type: 'message_stop' },
    ]),
    /still open/,
  );
  await assert.rejects(
    collect([messageStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }]),
    /without a message_delta stop_reason/,
  );
});

test('abort rejects the collector with an AbortError and destroys the stream', async () => {
  const controller = new AbortController();
  const stream = new PassThrough();
  const pending = collectAnthropicMessagesStream(stream, controller.signal);
  process.nextTick(() => {
    stream.write(sseText([messageStart]));
    controller.abort();
  });
  await assert.rejects(pending, error => (error as Error).name === 'AbortError');
  assert.equal(stream.destroyed, true);
});
