import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectOpenAIChatCompletionsStream, collectOpenAIResponsesStream } from './openai';

function makeStream(events: Array<any | '[DONE]'>): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const event of events) {
      const payload = event === '[DONE]' ? '[DONE]' : JSON.stringify(event);
      stream.write(`data: ${payload}\n\n`);
    }
    stream.end();
  });
  return stream;
}

test('collectOpenAIChatCompletionsStream aggregates streamed text and usage', async () => {
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
    },
    {
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal);
  assert.equal(response.choices[0].message.role, 'assistant');
  assert.equal(response.choices[0].message.content, 'Hello');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
});

test('collectOpenAIChatCompletionsStream aggregates streamed tool calls', async () => {
  const stream = makeStream([
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_abc',
            type: 'function',
            function: { name: 'read', arguments: '{"file' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'Path":"x"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal);
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.tool_calls.length, 1);
  assert.equal(response.choices[0].message.tool_calls[0].id, 'call_abc');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'read');
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"filePath":"x"}');
});


test('collectOpenAIResponsesStream rebuilds streamed output items from SSE deltas', async () => {
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', summary: [] },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 0,
      delta: 'Think',
    },
    {
      type: 'response.reasoning_summary_text.done',
      output_index: 0,
      summary_index: 0,
      text: 'Thinking done',
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 1,
      content_index: 0,
      delta: 'Hel',
    },
    {
      type: 'response.output_text.done',
      output_index: 1,
      content_index: 0,
      text: 'Hello',
    },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '{"file',
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 2,
      arguments: '{"filePath":"x"}',
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        object: 'response',
        output: [],
        usage: { input_tokens: 11, output_tokens: 7 },
      },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal);
  assert.equal(response.output.length, 3);
  assert.equal(response.output[0].type, 'reasoning');
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: 'Thinking done' }]);
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'Hello');
  assert.equal(response.output[2].type, 'function_call');
  assert.equal(response.output[2].call_id, 'call_1');
  assert.equal(response.output[2].arguments, '{"filePath":"x"}');
});

test('collectOpenAIResponsesStream rebuilds refusals when completed payload omits content', async () => {
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'refusal', refusal: '' },
    },
    {
      type: 'response.refusal.delta',
      output_index: 0,
      content_index: 0,
      delta: 'No',
    },
    {
      type: 'response.refusal.done',
      output_index: 0,
      content_index: 0,
      refusal: 'No thanks',
    },
    {
      type: 'response.completed',
      response: { id: 'resp_2', object: 'response', output: [] },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal);
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].content[0].type, 'refusal');
  assert.equal(response.output[0].content[0].refusal, 'No thanks');
});
