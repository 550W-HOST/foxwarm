import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectOpenAIChatCompletionsStream, collectOpenAIResponsesStream, convertToOpenAIFormat, convertToOpenAIResponsesFormat } from './openai';
import type { Message } from '../types';

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

  const progress: any[] = [];
  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });
  assert.equal(response.choices[0].message.role, 'assistant');
  assert.equal(response.choices[0].message.content, 'Hello');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.ok(progress.some(snapshot => snapshot.text === 'Hello'));
});

test('collectOpenAIChatCompletionsStream captures delta provider_specific_fields', async () => {
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { role: 'assistant', content: '', provider_specific_fields: { reasoning_signature: 'abc123' } }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }],
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal);
  assert.deepEqual(response.choices[0].message.provider_specific_fields, { reasoning_signature: 'abc123' });
});

test('collectOpenAIChatCompletionsStream reports raw SSE body and blocks', async () => {
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    },
    '[DONE]',
  ]);

  let rawBody = '';
  const rawBlocks: string[] = [];
  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal, {
    onRawChunk: chunk => { rawBody += chunk; },
    onRawSseBlock: block => rawBlocks.push(block),
  });

  assert.equal(response.choices[0].message.content, 'Hi');
  assert.match(rawBody, /data: .*"content":"Hi"/);
  assert.match(rawBody, /data: \[DONE\]/);
  assert.equal(rawBlocks.length, 2);
  assert.match(rawBlocks[0], /"content":"Hi"/);
  assert.equal(rawBlocks[1], 'data: [DONE]');
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

  const progress: any[] = [];
  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.tool_calls.length, 1);
  assert.equal(response.choices[0].message.tool_calls[0].id, 'call_abc');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'read');
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"filePath":"x"}');
  assert.ok(progress.some(snapshot => snapshot.toolCalls?.[0]?.name === 'read'));
});

test('collectOpenAIChatCompletionsStream splits parallel tool calls that reuse index 0', async () => {
  // Mirrors a real provider stream where every parallel tool call reuses
  // index 0 and only a fresh id marks the next call.
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tooluse_AAA', type: 'function', function: { name: 'exec' } }] }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '{"command": "echo ok1"}' } }] }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tooluse_BBB', type: 'function', function: { name: 'exec' } }] }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '{"command": "echo ok2"}' } }] }, finish_reason: 'tool_calls' }],
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal);
  const toolCalls = response.choices[0].message.tool_calls;
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].id, 'tooluse_AAA');
  assert.equal(toolCalls[0].function.name, 'exec');
  assert.equal(toolCalls[0].function.arguments, '{"command": "echo ok1"}');
  assert.equal(toolCalls[1].id, 'tooluse_BBB');
  assert.equal(toolCalls[1].function.name, 'exec');
  assert.equal(toolCalls[1].function.arguments, '{"command": "echo ok2"}');
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

  const progress: any[] = [];
  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });
  assert.equal(response.output.length, 3);
  assert.equal(response.output[0].type, 'reasoning');
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: 'Thinking done' }]);
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'Hello');
  assert.equal(response.output[2].type, 'function_call');
  assert.equal(response.output[2].call_id, 'call_1');
  assert.equal(response.output[2].arguments, '{"filePath":"x"}');
  assert.ok(progress.some(snapshot => snapshot.reasoning === 'Thinking done'));
  assert.ok(progress.some(snapshot => snapshot.text === 'Hello'));
  assert.ok(progress.some(snapshot => snapshot.toolCalls?.[0]?.name === 'read'));
});

test('collectOpenAIResponsesStream reports raw SSE body and blocks', async () => {
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
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'Hi',
    },
    {
      type: 'response.completed',
      response: { id: 'resp_raw', object: 'response', output: [] },
    },
    '[DONE]',
  ]);

  let rawBody = '';
  const rawBlocks: string[] = [];
  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal, {
    onRawChunk: chunk => { rawBody += chunk; },
    onRawSseBlock: block => rawBlocks.push(block),
  });

  assert.equal(response.output[0].content[0].text, 'Hi');
  assert.match(rawBody, /data: .*response\.output_text\.delta/);
  assert.match(rawBody, /data: \[DONE\]/);
  assert.equal(rawBlocks.length, 5);
  assert.ok(rawBlocks.some(block => block.includes('response.output_text.delta')));
  assert.equal(rawBlocks[rawBlocks.length - 1], 'data: [DONE]');
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

test('OpenAI tool serializers prepend one persisted LLM timing marker before image and empty output', () => {
  const history: Message[] = [{
    role: 'tool',
    parts: [
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' }, toolUseId: 'first' },
      {
        functionResponse: {
          tool_use_id: 'first',
          name: 'image_tool',
          previousLlmRequest: { time: '2026-07-27 05:00:00 +0800', durationMs: 8200 },
          response: { output: '' },
        },
      },
      {
        functionResponse: {
          tool_use_id: 'second',
          name: 'plain_tool',
          response: { output: 'second output' },
        },
      },
    ],
  }];

  const chat = convertToOpenAIFormat(history);
  const firstChat = chat.find(item => item.tool_call_id === 'first');
  assert.ok(Array.isArray(firstChat.content));
  assert.match(firstChat.content[0].text, /kind="time".*time="2026-07-27 05:00:00 \+0800".*prevLLMReqTime="8.2s"/);
  assert.equal(firstChat.content.filter((part: any) => String(part.text || '').includes('prevLLMReqTime')).length, 1);
  assert.equal(chat.some(item => item.tool_call_id === 'second' && String(item.content).includes('prevLLMReqTime')), false);

  const responses = convertToOpenAIResponsesFormat(history);
  const firstResponse = responses.find(item => item.call_id === 'first');
  assert.ok(Array.isArray(firstResponse.output));
  assert.match(firstResponse.output[0].text, /prevLLMReqTime="8.2s"/);
  assert.equal(firstResponse.output.filter((part: any) => String(part.text || '').includes('prevLLMReqTime')).length, 1);
});

test('convertToOpenAIFormat echoes assistant providerSpecificFields verbatim', () => {
  const history: Message[] = [
    { role: 'user', parts: [{ text: 'hi' }] },
    {
      role: 'model',
      parts: [{ text: 'hello' }],
      providerMeta: { providerSpecificFields: { reasoning_signature: 'sig-xyz' } },
    },
    { role: 'model', parts: [{ text: 'no meta' }] },
  ];

  const chat = convertToOpenAIFormat(history);
  assert.deepEqual(chat[1].provider_specific_fields, { reasoning_signature: 'sig-xyz' });
  assert.equal('provider_specific_fields' in chat[0], false);
  assert.equal('provider_specific_fields' in chat[2], false);
});
