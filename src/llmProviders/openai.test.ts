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

test('collectOpenAIChatCompletionsStream aggregates reasoning compatibility deltas with tool calls', async () => {
  const stream = makeStream([
    {
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          reasoning: 'Inspect the repository first.',
          tool_calls: [{
            index: 0,
            id: 'call_reasoning',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"README.md"}' },
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

  assert.equal(response.choices[0].message.reasoning, 'Inspect the repository first.');
  assert.equal(response.choices[0].message.tool_calls[0].id, 'call_reasoning');
  assert.ok(progress.some(snapshot => snapshot.reasoning === 'Inspect the repository first.'));
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
  assert.equal(progress.at(-1)?.toolCalls?.[0]?.arguments, '{"filePath":"x"}');
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

  const progress: any[] = [];
  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });
  const toolCalls = response.choices[0].message.tool_calls;
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].id, 'tooluse_AAA');
  assert.equal(toolCalls[0].function.name, 'exec');
  assert.equal(toolCalls[0].function.arguments, '{"command": "echo ok1"}');
  assert.equal(toolCalls[1].id, 'tooluse_BBB');
  assert.equal(toolCalls[1].function.name, 'exec');
  assert.equal(toolCalls[1].function.arguments, '{"command": "echo ok2"}');
  assert.deepEqual(progress[progress.length - 1]?.toolCalls?.map((call: any) => call.index), [0, 1]);
});

test('collectOpenAIChatCompletionsStream concatenates fragmented tool call ids', async () => {
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'read' } }] }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'abc', function: { arguments: '{"filePath":"x"}' } }] }, finish_reason: 'tool_calls' }],
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal);
  assert.deepEqual(response.choices[0].message.tool_calls, [{
    id: 'call_abc',
    type: 'function',
    function: { name: 'read', arguments: '{"filePath":"x"}' },
  }]);
});

test('collectOpenAIChatCompletionsStream orders ordinary tool calls by provider index', async () => {
  const stream = makeStream([
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_second', type: 'function', function: { name: 'write', arguments: '{}' } }] }, finish_reason: null }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_first', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    },
    '[DONE]',
  ]);

  const progress: any[] = [];
  const response = await collectOpenAIChatCompletionsStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });
  const toolCalls = response.choices[0].message.tool_calls;
  assert.deepEqual(toolCalls.map((call: any) => call.id), ['call_first', 'call_second']);
  const finalProgress = progress[progress.length - 1];
  assert.deepEqual(finalProgress?.toolCalls?.map((call: any) => call.index), [0, 1]);
  assert.deepEqual(finalProgress?.toolCalls?.map((call: any) => call.name), ['read', 'write']);
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
  assert.equal(progress.at(-1)?.toolCalls?.[0]?.arguments, '{"filePath":"x"}');
});

test('collectOpenAIResponsesStream preserves indexed reasoning summary boundaries over condensed completed output', async () => {
  const firstSummary = '**Preparing final test report and preview options**';
  const secondSummary = '**Confirming no live deployment without user approval**';
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_summary', summary: [] },
    },
    {
      type: 'response.reasoning_summary_part.added',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 0,
      delta: firstSummary,
    },
    {
      type: 'response.reasoning_summary_text.done',
      output_index: 0,
      summary_index: 0,
      text: firstSummary,
    },
    {
      type: 'response.reasoning_summary_part.done',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: firstSummary },
    },
    {
      type: 'response.reasoning_summary_part.added',
      output_index: 0,
      summary_index: 1,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 1,
      delta: secondSummary,
    },
    {
      type: 'response.reasoning_summary_text.done',
      output_index: 0,
      summary_index: 1,
      text: secondSummary,
    },
    {
      type: 'response.reasoning_summary_part.done',
      output_index: 0,
      summary_index: 1,
      part: { type: 'summary_text', text: secondSummary },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_summary',
        status: 'completed',
        summary: [
          { type: 'summary_text', text: firstSummary },
          { type: 'summary_text', text: secondSummary },
        ],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', id: 'msg_summary', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.output_text.done',
      output_index: 1,
      content_index: 0,
      text: 'Done',
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        id: 'msg_summary',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Done' }],
      },
    },
    {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'reasoning',
            id: 'rs_summary',
            status: 'completed',
            summary: [{ type: 'summary_text', text: `${firstSummary}${secondSummary}` }],
          },
          {
            type: 'message',
            id: 'msg_summary',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done' }],
          },
        ],
      },
    },
    '[DONE]',
  ]);

  const progress: any[] = [];
  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
  });

  assert.deepEqual(response.output[0].summary, [
    { type: 'summary_text', text: firstSummary },
    { type: 'summary_text', text: secondSummary },
  ]);
  assert.ok(progress.some(snapshot => snapshot.reasoning === `${firstSummary}\n${secondSummary}`));
});

test('collectOpenAIResponsesStream uses completed reasoning summaries when the stream has none', async () => {
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_completed_only', summary: [] },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_completed_only', status: 'completed', summary: [] },
    },
    {
      type: 'response.completed',
      response: {
        output: [{
          type: 'reasoning',
          id: 'rs_completed_only',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'Completed-only summary' }],
        }],
      },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal);
  assert.deepEqual(response.output[0].summary, [
    { type: 'summary_text', text: 'Completed-only summary' },
  ]);
});

test('collectOpenAIResponsesStream preserves web search calls and streamed URL annotations', async () => {
  const citation = {
    type: 'url_citation',
    start_index: 0,
    end_index: 5,
    url: 'https://example.com/article',
    title: 'Example article',
  };
  const webSearchCall = {
    type: 'web_search_call',
    id: 'ws_123',
    status: 'completed',
    action: { type: 'search', query: 'example query' },
  };
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'web_search_call', id: 'ws_123', status: 'in_progress' },
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
      delta: 'Hello',
    },
    {
      type: 'response.output_text.annotation.added',
      output_index: 1,
      content_index: 0,
      annotation_index: 0,
      annotation: citation,
    },
    {
      type: 'response.completed',
      response: {
        output: [
          webSearchCall,
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }],
          },
        ],
      },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal);
  assert.deepEqual(response.output, [
    webSearchCall,
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }],
    },
  ]);
});

test('collectOpenAIResponsesStream keeps streamed order when completed output condenses hosted items', async () => {
  const citation = {
    type: 'url_citation',
    start_index: 0,
    end_index: 5,
    url: 'https://example.com/article',
    title: 'Example article',
  };
  const stream = makeStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_0' },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'web_search_call', id: 'ws_sparse', status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'web_search_call',
        id: 'ws_sparse',
        status: 'completed',
        action: { type: 'search', query: 'example query' },
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'reasoning', id: 'rs_2' },
    },
    {
      type: 'response.output_item.added',
      output_index: 3,
      item: { type: 'message', id: 'msg_sparse', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      output_index: 3,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 3,
      content_index: 0,
      delta: 'Hello',
    },
    {
      type: 'response.output_text.annotation.added',
      output_index: 3,
      content_index: 0,
      annotation_index: 0,
      annotation: citation,
    },
    {
      type: 'response.output_text.done',
      output_index: 3,
      content_index: 0,
      text: 'Hello',
    },
    {
      type: 'response.output_item.done',
      output_index: 3,
      item: {
        type: 'message',
        id: 'msg_sparse',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        // This compact payload omits the hosted search call and the second
        // reasoning item, matching the provider shape seen in production.
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Planning' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }] },
        ],
      },
    },
    '[DONE]',
  ]);

  const response = await collectOpenAIResponsesStream(stream, new AbortController().signal);
  assert.deepEqual(response.output.map((item: any) => item.type), ['reasoning', 'web_search_call', 'reasoning', 'message']);
  assert.equal(response.output.filter((item: any) => item.type === 'message').length, 1);
  assert.equal(response.output[1].id, 'ws_sparse');
  assert.deepEqual(response.output[1].action, { type: 'search', query: 'example query' });
  assert.equal(response.output[3].id, 'msg_sparse');
  assert.equal(response.output[3].content[0].text, 'Hello');
  assert.deepEqual(response.output[3].content[0].annotations, [citation]);
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

test('convertToOpenAIResponsesFormat replays ordered web search metadata only to its source model', () => {
  const webSearchCall = {
    type: 'web_search_call',
    id: 'ws_123',
    status: 'completed',
    action: { type: 'search', query: 'example query' },
  };
  const annotations = [{
    type: 'url_citation',
    start_index: 0,
    end_index: 5,
    url: 'https://example.com/article',
    title: 'Example article',
  }];
  const history: Message[] = [{
    role: 'model',
    parts: [
      {
        providerMeta: {
          openaiResponses: {
            sourceModelId: 'openai/gpt-5.6',
            outputItem: webSearchCall,
          },
        },
      },
      {
        text: 'Hello',
        providerMeta: {
          openaiResponses: {
            sourceModelId: 'openai/gpt-5.6',
            annotations,
          },
        },
      },
      { functionCall: { id: 'call_1', name: 'read', args: { filePath: 'README.md' } } },
    ],
  }];

  const sameModel = convertToOpenAIResponsesFormat(history, 'openai/gpt-5.6');
  assert.deepEqual(sameModel, [
    webSearchCall,
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Hello', annotations }],
    },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"filePath":"README.md"}' },
  ]);

  const differentModel = convertToOpenAIResponsesFormat(history, 'openai/gpt-5.5');
  assert.deepEqual(differentModel, [
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Hello' }],
    },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"filePath":"README.md"}' },
  ]);
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

test('OpenAI serializers send repeated image bytes once and preserve later model-visible placeholders', () => {
  const data = Buffer.from('provider-dedup-image').toString('base64');
  const history: Message[] = [
    {
      role: 'user',
      parts: [{ text: '<foxwarm-image name="first.png" node="master" path="/tmp/first.png" />', inlineData: { mimeType: 'image/png', data } }],
    },
    {
      role: 'user',
      parts: [
        { text: '<foxwarm-image name="later.png" node="master" path="/tmp/later.png" />' },
        { inlineData: { mimeType: 'image/png', data } },
      ],
    },
  ];
  const snapshot = structuredClone(history);

  const chat = convertToOpenAIFormat(history);
  const chatJson = JSON.stringify(chat);
  assert.equal(chatJson.match(/data:image\/png;base64,/g)?.length, 1);
  assert.match(chatJson, /foxwarm-image[^>]+deduplicated=\\"true\\"/);

  const responses = convertToOpenAIResponsesFormat(history);
  const responsesJson = JSON.stringify(responses);
  assert.equal(responsesJson.match(/data:image\/png;base64,/g)?.length, 1);
  assert.match(responsesJson, /foxwarm-image[^>]+deduplicated=\\"true\\"/);
  assert.deepEqual(history, snapshot);
});

test('OpenAI tool serializers keep deduplicated tool image guidance and omit repeated bytes', () => {
  const data = Buffer.from('provider-tool-dedup-image').toString('base64');
  const history: Message[] = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data }, imageMeta: { imageId: 'source', mimeType: 'image/png' } }] },
    {
      role: 'tool',
      parts: [
        {
          toolUseId: 'call_image',
          inlineData: { mimeType: 'image/png', data },
          imageMeta: { imageId: 'tool-copy', mimeType: 'image/png', width: 2, height: 3 },
        },
        { functionResponse: { tool_use_id: 'call_image', name: 'capture', response: { output: 'done' } } },
      ],
    },
  ];

  const chat = convertToOpenAIFormat(history);
  const chatTool = chat.find(item => item.tool_call_id === 'call_image');
  assert.equal(JSON.stringify(chatTool).includes('data:image/png;base64,'), false);
  assert.match(JSON.stringify(chatTool), /deduplicated=true; identical image bytes were present earlier/);
  assert.match(JSON.stringify(chatTool), /id=tool-copy/);

  const responses = convertToOpenAIResponsesFormat(history);
  const responseTool = responses.find(item => item.call_id === 'call_image');
  assert.equal(JSON.stringify(responseTool).includes('data:image/png;base64,'), false);
  assert.match(JSON.stringify(responseTool), /deduplicated=true; identical image bytes were present earlier/);
  assert.match(JSON.stringify(responseTool), /id=tool-copy/);
});

test('OpenAI tool serializers keep fallback guidance for deduplicated legacy images without tool ids', () => {
  const data = Buffer.from('legacy-tool-image-without-id').toString('base64');
  const history: Message[] = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
    {
      role: 'tool',
      parts: [
        { inlineData: { mimeType: 'image/png', data }, imageMeta: { imageId: 'legacy-copy', mimeType: 'image/png' } },
        { functionResponse: { tool_use_id: 'call_legacy', name: 'legacy', response: { output: 'done' } } },
      ],
    },
  ];

  for (const output of [convertToOpenAIFormat(history), convertToOpenAIResponsesFormat(history)]) {
    const serialized = JSON.stringify(output);
    assert.equal(serialized.match(/data:image\/png;base64,/g)?.length, 1);
    assert.match(serialized, /id=legacy-copy/);
    assert.match(serialized, /deduplicated=true; identical image bytes were present earlier/);
  }
});

test('OpenAI tool serializers associate canonical response-then-image dedup guidance order-independently', () => {
  const data = Buffer.from('canonical-response-then-image').toString('base64');
  const history: Message[] = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
    {
      role: 'tool',
      parts: [
        { functionResponse: { tool_use_id: 'call_after', name: 'capture', response: { output: 'done' } } },
        {
          toolUseId: 'call_after',
          inlineData: { mimeType: 'image/png', data },
          imageMeta: { imageId: 'after-image', mimeType: 'image/png', width: 3, height: 4 },
        },
      ],
    },
  ];

  const chatTool = convertToOpenAIFormat(history).find(item => item.tool_call_id === 'call_after');
  assert.equal(JSON.stringify(chatTool).includes('data:image/png;base64,'), false);
  assert.match(JSON.stringify(chatTool), /id=after-image/);
  assert.match(JSON.stringify(chatTool), /deduplicated=true; identical image bytes were present earlier/);

  const responsesTool = convertToOpenAIResponsesFormat(history).find(item => item.call_id === 'call_after');
  assert.equal(JSON.stringify(responsesTool).includes('data:image/png;base64,'), false);
  assert.match(JSON.stringify(responsesTool), /id=after-image/);
  assert.match(JSON.stringify(responsesTool), /deduplicated=true; identical image bytes were present earlier/);
});

test('OpenAI tool serializers preserve deduplicated orphan tool IDs with bounded guidance', () => {
  const data = Buffer.from('orphan-deduplicated-image').toString('base64');
  const unique = Buffer.from('orphan-unique-image').toString('base64');
  const history: Message[] = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
    {
      role: 'tool',
      parts: [
        { toolUseId: 'call_duplicate', inlineData: { mimeType: 'image/png', data }, imageMeta: { imageId: 'duplicate-orphan', mimeType: 'image/png' } },
        { toolUseId: 'call_unique', inlineData: { mimeType: 'image/png', data: unique }, imageMeta: { imageId: 'unique-orphan', mimeType: 'image/png' } },
      ],
    },
  ];

  const chat = convertToOpenAIFormat(history);
  const duplicateChat = chat.find(item => item.tool_call_id === 'call_duplicate');
  const uniqueChat = chat.find(item => item.tool_call_id === 'call_unique');
  assert.match(JSON.stringify(duplicateChat), /id=duplicate-orphan/);
  assert.match(JSON.stringify(duplicateChat), /deduplicated=true/);
  assert.equal(JSON.stringify(duplicateChat).includes('base64,'), false);
  assert.equal(JSON.stringify(uniqueChat).includes(`base64,${unique}`), true);

  const responses = convertToOpenAIResponsesFormat(history);
  const duplicateResponses = responses.find(item => item.call_id === 'call_duplicate');
  const uniqueResponses = responses.find(item => item.call_id === 'call_unique');
  assert.match(JSON.stringify(duplicateResponses), /id=duplicate-orphan/);
  assert.match(JSON.stringify(duplicateResponses), /deduplicated=true/);
  assert.equal(JSON.stringify(duplicateResponses).includes('base64,'), false);
  assert.equal(JSON.stringify(uniqueResponses).includes(`base64,${unique}`), true);
});

test('OpenAI repeated tool IDs associate deduplicated guidance with exactly one nearest response occurrence', () => {
  const data = Buffer.from('repeated-id-association').toString('base64');
  const response = (output: string): Message['parts'][number] => ({
    functionResponse: { tool_use_id: 'call_same', name: 'capture', response: { output } },
  });
  const imagePart = (): Message['parts'][number] => ({
    toolUseId: 'call_same',
    inlineData: { mimeType: 'image/png', data },
    imageMeta: { imageId: 'same-image', mimeType: 'image/png' },
  });
  const cases = [
    { name: 'response-image-response', parts: [response('first'), imagePart(), response('second')], guidanceTextIndex: 0 },
    { name: 'image-response-response', parts: [imagePart(), response('first'), response('second')], guidanceTextIndex: 0 },
    { name: 'response-response-image', parts: [response('first'), response('second'), imagePart()], guidanceTextIndex: 1 },
  ];

  for (const item of cases) {
    const history: Message[] = [
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
      { role: 'tool', parts: item.parts },
    ];
    const chatTool = convertToOpenAIFormat(history).find(entry => entry.tool_call_id === 'call_same');
    const chatTexts = (Array.isArray(chatTool.content) ? chatTool.content : [{ text: chatTool.content }])
      .filter((entry: any) => entry.type === 'text' || typeof entry.text === 'string')
      .map((entry: any) => entry.text);
    assert.equal(chatTexts.filter((text: string) => text.includes('id=same-image')).length, 1, `${item.name} Chat guidance count`);
    assert.match(chatTexts[item.guidanceTextIndex], /id=same-image/);
    assert.equal(JSON.stringify(chatTool).includes('base64,'), false);

    const responsesTool = convertToOpenAIResponsesFormat(history).find(entry => entry.call_id === 'call_same');
    const responseTexts = (Array.isArray(responsesTool.output) ? responsesTool.output : [{ text: responsesTool.output }])
      .filter((entry: any) => entry.type === 'input_text' || typeof entry.text === 'string')
      .map((entry: any) => entry.text);
    assert.equal(responseTexts.filter((text: string) => text.includes('id=same-image')).length, 1, `${item.name} Responses guidance count`);
    assert.match(responseTexts[item.guidanceTextIndex], /id=same-image/);
    assert.equal(JSON.stringify(responsesTool).includes('base64,'), false);
  }
});

test('OpenAI occurrence association isolates distinct tool IDs in mixed repeated shapes', () => {
  const dataA = Buffer.from('mixed-tool-a').toString('base64');
  const dataB = Buffer.from('mixed-tool-b').toString('base64');
  const history: Message[] = [
    { role: 'user', parts: [
      { inlineData: { mimeType: 'image/png', data: dataA } },
      { inlineData: { mimeType: 'image/png', data: dataB } },
    ] },
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'call_a', name: 'a', response: { output: 'a-first' } } },
      { toolUseId: 'call_a', inlineData: { mimeType: 'image/png', data: dataA }, imageMeta: { imageId: 'image-a', mimeType: 'image/png' } },
      { toolUseId: 'call_b', inlineData: { mimeType: 'image/png', data: dataB }, imageMeta: { imageId: 'image-b', mimeType: 'image/png' } },
      { functionResponse: { tool_use_id: 'call_b', name: 'b', response: { output: 'b-only' } } },
      { functionResponse: { tool_use_id: 'call_a', name: 'a', response: { output: 'a-second' } } },
    ] },
  ];

  for (const output of [convertToOpenAIFormat(history), convertToOpenAIResponsesFormat(history)]) {
    const serialized = JSON.stringify(output);
    assert.equal(serialized.match(/id=image-a/g)?.length, 1);
    assert.equal(serialized.match(/id=image-b/g)?.length, 1);
    assert.equal(serialized.match(/deduplicated=true/g)?.length, 2);
  }
});

test('Responses dropped assistant image does not prevent a later user image from being serialized', () => {
  const data = Buffer.from('responses-dropped-assistant-image').toString('base64');
  const responses = convertToOpenAIResponsesFormat([
    { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
  ]);
  assert.equal(JSON.stringify(responses).match(/data:image\/png;base64,/g)?.length, 1);
  assert.equal(JSON.stringify(responses).includes('deduplicated=true'), false);
});

test('convertToOpenAIFormat echoes assistant providerSpecificFields only to the source concrete model', () => {
  const history: Message[] = [
    { role: 'user', parts: [{ text: 'hi' }] },
    {
      role: 'model',
      parts: [{ text: 'hello' }],
      providerMeta: {
        providerSpecificFields: { reasoning_signature: 'sig-xyz' },
        sourceModelId: 'provider/model-a',
      },
    },
    { role: 'model', parts: [{ text: 'no meta' }] },
  ];

  const chat = convertToOpenAIFormat(history, 'provider/model-a');
  assert.deepEqual(chat[1].provider_specific_fields, { reasoning_signature: 'sig-xyz' });
  assert.equal('provider_specific_fields' in chat[0], false);
  assert.equal('provider_specific_fields' in chat[2], false);

  const otherModelChat = convertToOpenAIFormat(history, 'provider/model-b');
  assert.equal('provider_specific_fields' in otherModelChat[1], false);
});

test('convertToOpenAIFormat selects exactly one configured assistant history reasoning key', () => {
  const history: Message[] = [{
    role: 'model',
    parts: [
      { thinking: 'historical reasoning' },
      { text: 'visible answer' },
      { functionCall: { id: 'call_1', name: 'read', args: { filePath: 'x' } } },
    ],
    providerMeta: {
      providerSpecificFields: { reasoning_signature: 'sig-xyz' },
      sourceModelId: 'provider/model-a',
    },
  }];

  const standard = convertToOpenAIFormat(history, 'provider/model-a');
  assert.equal(standard[0].reasoning_content, 'historical reasoning');
  assert.equal('reasoning' in standard[0], false);

  const compatible = convertToOpenAIFormat(history, 'provider/model-a', 'reasoning');
  assert.equal(compatible[0].reasoning, 'historical reasoning');
  assert.equal('reasoning_content' in compatible[0], false);
  assert.equal(compatible[0].content, 'visible answer');
  assert.equal(compatible[0].tool_calls[0].id, 'call_1');
  assert.deepEqual(compatible[0].provider_specific_fields, { reasoning_signature: 'sig-xyz' });
});
