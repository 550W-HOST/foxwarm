import test from 'node:test';
import assert from 'node:assert/strict';

import { executeTools, fixToolCalls } from './llm';
import { convertToOpenAIFormat, convertToOpenAIResponsesFormat } from './llmProviders/openai';
import { parseFunctionCallArgs } from './toolCallArgs';

test('parseFunctionCallArgs preserves malformed raw JSON and reports structured error', () => {
  const rawArgsText = '{"filePath":';
  const parsed = parseFunctionCallArgs(rawArgsText);

  assert.deepEqual(parsed.args, {});
  assert.equal(parsed.rawArgsText, rawArgsText);
  assert.match(parsed.argsParseError || '', /Invalid tool arguments JSON:/);
});

test('executeTools turns malformed tool arguments into a structured tool error', async () => {
  const toolMessage = await executeTools(
    [{
      id: 'call_bad_args',
      name: 'read',
      args: {},
      rawArgsText: '{"filePath":',
      argsParseError: 'Invalid tool arguments JSON: Unexpected end of JSON input',
    }],
    { sessionId: 'tool-args-test/main', session: { agent: 'main' } },
    { agent: 'main', verbose: false },
  );

  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.parts.length, 1);
  assert.deepEqual(toolMessage.parts[0].functionResponse, {
    tool_use_id: 'call_bad_args',
    name: 'read',
    response: {
      error: {
        type: 'invalid_tool_arguments',
        message: 'Invalid tool arguments JSON: Unexpected end of JSON input',
        rawArgsText: '{"filePath":',
      },
    },
  });
});

test('OpenAI serializers preserve raw tool argument text exactly', () => {
  const rawArgsText = '{  "b":2,\n  "a":1 }';
  const history = [{
    role: 'model' as const,
    parts: [{
      functionCall: {
        id: 'call_raw_args',
        name: 'read',
        args: { a: 1, b: 2 },
        rawArgsText,
      },
    }],
  }];

  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages[0].tool_calls[0].function.arguments, rawArgsText);

  const responsesItems = convertToOpenAIResponsesFormat(history);
  const functionCallItem = responsesItems.find(item => item.type === 'function_call');
  assert.ok(functionCallItem);
  assert.equal(functionCallItem.arguments, rawArgsText);
});

test('OpenAI serializers keep system header bracket separate from payload text', () => {
  const history = [{
    role: 'user' as const,
    parts: [
      { system: 'Scheduled timer fired (id: timer-1)' },
      { text: 'run nightly sync', systemPayload: true },
    ],
  }];

  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages[0].content, '[SYSTEM: Scheduled timer fired (id: timer-1)]\nrun nightly sync');
  assert.doesNotMatch(chatMessages[0].content, /run nightly sync\]$/);

  const responsesItems = convertToOpenAIResponsesFormat(history);
  assert.deepEqual(responsesItems, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '[SYSTEM: Scheduled timer fired (id: timer-1)]' },
      { type: 'input_text', text: 'run nightly sync' },
    ],
  }]);
});

test('fixToolCalls treats structured system event payloads as skippable interruptions', () => {
  const history = [
    {
      role: 'model' as const,
      parts: [{ functionCall: { id: 'call_1', name: 'read', args: { filePath: 'a.txt' } } }],
    },
    {
      role: 'user' as const,
      parts: [
        { system: 'Background Process Finished' },
        { text: 'command: `npm run build`\nExit code: 0', systemPayload: true },
      ],
    },
    {
      role: 'tool' as const,
      parts: [{ functionResponse: { tool_use_id: 'call_1', name: 'read', response: { output: 'ok' } } }],
    },
  ];

  const fixed = fixToolCalls(history as any);
  assert.equal(fixed.length, 3);
  assert.equal(fixed[2].role, 'tool');
  assert.equal(fixed[2].parts[0].functionResponse?.tool_use_id, 'call_1');
});
