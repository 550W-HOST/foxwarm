import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectOpenAIChatCompletionsStream } from './openai';

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
