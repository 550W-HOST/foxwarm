import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectOpenAIChatCompletionsStream, collectOpenAIResponsesStream } from './openai';

function makeChatStream(events: Array<any | '[DONE]'>): PassThrough {
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

function writeSseEvent(stream: PassThrough, event: any) {
  stream.write(`event: ${event.type}\n`);
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

test('collectOpenAIChatCompletionsStream aggregates streamed text and usage', async () => {
  const stream = makeChatStream([
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
  const stream = makeChatStream([
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

test('collectOpenAIResponsesStream reconstructs output from output_item.done when completed output is empty', async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const promise = collectOpenAIResponsesStream(stream, controller.signal);

  writeSseEvent(stream, {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      phase: 'final_answer',
      content: [
        {
          type: 'output_text',
          text: 'OK',
          annotations: [],
        },
      ],
    },
  });
  writeSseEvent(stream, {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [],
    },
  });
  stream.end();

  const response = await promise;
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].content[0].text, 'OK');
});

test('collectOpenAIResponsesStream reconstructs assistant text from output_text events when completed output is empty', async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const promise = collectOpenAIResponsesStream(stream, controller.signal);

  writeSseEvent(stream, {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: 'msg_2',
    delta: 'O',
  });
  writeSseEvent(stream, {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: 'msg_2',
    delta: 'K',
  });
  writeSseEvent(stream, {
    type: 'response.content_part.done',
    output_index: 0,
    content_index: 0,
    item_id: 'msg_2',
    part: {
      type: 'output_text',
      text: 'OK',
      annotations: [],
    },
  });
  writeSseEvent(stream, {
    type: 'response.completed',
    response: {
      id: 'resp_2',
      object: 'response',
      status: 'completed',
      output: [],
    },
  });
  stream.end();

  const response = await promise;
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].role, 'assistant');
  assert.equal(response.output[0].content[0].text, 'OK');
});
