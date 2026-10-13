import { PassThrough } from 'node:stream';

/** Builds a Messages SSE response from a non-streaming-shaped fixture message. */
export type AnthropicTestMessage = {
  content?: Array<Record<string, any>>;
  usage?: Record<string, unknown>;
  stop_reason?: string;
  stop_details?: unknown;
};

export function makeAnthropicMessageStream(message: AnthropicTestMessage): PassThrough {
  const events: Array<Record<string, unknown>> = [];
  const usage = message.usage;
  events.push({
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...(usage ? { usage: { ...usage, output_tokens: 0 } } : {}),
    },
  });
  (message.content ?? []).forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      if (block.thinking) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      }
      if (block.signature !== undefined) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
      }
    } else if (block.type === 'redacted_thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data } });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason ?? 'end_turn',
      stop_sequence: null,
      stop_details: message.stop_details ?? null,
    },
    ...(usage ? { usage: { ...usage, output_tokens: usage.output_tokens ?? 0 } } : {}),
  });
  events.push({ type: 'message_stop' });
  const stream = new PassThrough();
  stream.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  return stream;
}
