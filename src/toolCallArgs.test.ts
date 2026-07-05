import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import { executeTools, fixToolCalls } from './llm';
import { convertToOpenAIFormat, convertToOpenAIResponsesFormat } from './llmProviders/openai';
import { parseFunctionCallArgs } from './toolCallArgs';
import * as sessionManager from './sessionManager';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeMissingFilePath(): string {
  return path.join(process.cwd(), `.missing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
}

function hasStopCurrentTurn(toolMessage: any): boolean {
  return toolMessage?.__toolLoopControl?.stopCurrentTurn === true;
}

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
      },
    },
  });
});

test('executeTools suppresses wait when a later tool in the batch returns an error', async () => {
  const sessionId = makeSessionId('tool_wait_after_error_late');
  const toolMessage = await executeTools(
    [
      { id: 'call_wait_first', name: 'wait', args: {} },
      { id: 'call_read_missing', name: 'read', args: { filePath: makeMissingFilePath() } },
    ],
    { sessionId, session: { agent: 'main' } },
    { agent: 'main', verbose: false },
  );

  try {
    assert.equal(hasStopCurrentTurn(toolMessage), false);
    assert.equal(toolMessage.parts.length, 2);
    assert.equal(toolMessage.parts[1].functionResponse?.name, 'read');
    assert.notEqual(toolMessage.parts[1].functionResponse?.response?.error, undefined);
    assert.notEqual(toolMessage.parts[1].functionResponse?.response?.error, null);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('executeTools suppresses wait when an earlier tool in the batch returns an error', async () => {
  const sessionId = makeSessionId('tool_wait_after_error_early');
  const toolMessage = await executeTools(
    [
      { id: 'call_read_missing', name: 'read', args: { filePath: makeMissingFilePath() } },
      { id: 'call_wait_last', name: 'wait', args: {} },
    ],
    { sessionId, session: { agent: 'main' } },
    { agent: 'main', verbose: false },
  );

  try {
    assert.equal(hasStopCurrentTurn(toolMessage), false);
    assert.equal(toolMessage.parts.length, 2);
    assert.equal(toolMessage.parts[0].functionResponse?.name, 'read');
    assert.notEqual(toolMessage.parts[0].functionResponse?.response?.error, undefined);
    assert.notEqual(toolMessage.parts[0].functionResponse?.response?.error, null);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('executeTools keeps wait behavior for successful send_to_session handoff batches', async () => {
  const sourceSessionId = makeSessionId('tool_wait_handoff_source');
  const targetSessionId = makeSessionId('tool_wait_handoff_target');

  await sessionManager.getSession(sourceSessionId);
  await sessionManager.getSession(targetSessionId);

  const toolMessage = await executeTools(
    [
      { id: 'call_send', name: 'send_to_session', args: { sessionId: targetSessionId, message: 'handoff ok' } },
      { id: 'call_wait', name: 'wait', args: {} },
    ],
    { sessionId: sourceSessionId, session: { agent: 'main' } },
    { agent: 'main', verbose: false },
  );

  try {
    assert.equal(hasStopCurrentTurn(toolMessage), true);
    assert.equal(toolMessage.parts.length, 2);
    assert.deepEqual(toolMessage.parts.map(part => part.functionResponse?.name), ['send_to_session', 'wait']);
    assert.equal(toolMessage.parts[0].functionResponse?.response?.error, undefined);
    assert.equal(toolMessage.parts[1].functionResponse?.response?.error, undefined);
  } finally {
    await sessionManager.deleteSession(sourceSessionId).catch(() => false);
    await sessionManager.deleteSession(targetSessionId).catch(() => false);
  }
});

test('executeTools suppresses wait when malformed tool arguments produce a structured error', async () => {
  const sessionId = makeSessionId('tool_wait_bad_args');
  const toolMessage = await executeTools(
    [
      {
        id: 'call_bad_args',
        name: 'read',
        args: {},
        rawArgsText: '{"filePath":',
        argsParseError: 'Invalid tool arguments JSON: Unexpected end of JSON input',
      },
      { id: 'call_wait', name: 'wait', args: {} },
    ],
    { sessionId, session: { agent: 'main' } },
    { agent: 'main', verbose: false },
  );

  try {
    assert.equal(hasStopCurrentTurn(toolMessage), false);
    assert.equal(toolMessage.parts.length, 2);
    assert.equal(toolMessage.parts[0].functionResponse?.name, 'read');
    assert.deepEqual(toolMessage.parts[0].functionResponse?.response?.error, {
      type: 'invalid_tool_arguments',
      message: 'Invalid tool arguments JSON: Unexpected end of JSON input',
    });
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
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

test('OpenAI serializers keep foxwarm system tag separate from payload text', () => {
  const history = [{
    role: 'user' as const,
    parts: [
      { system: 'Scheduled timer fired (id: timer-1)' },
      { text: 'run nightly sync', systemPayload: true },
    ],
  }];

  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages[0].content, '<foxwarm-system hint="Scheduled timer fired (id: timer-1)" />\nrun nightly sync');
  assert.doesNotMatch(chatMessages[0].content, /\[SYSTEM:/);

  const responsesItems = convertToOpenAIResponsesFormat(history);
  assert.deepEqual(responsesItems, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '<foxwarm-system hint="Scheduled timer fired (id: timer-1)" />' },
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

test('fixToolCalls no longer inserts interruption marker between tool output and later user turn', () => {
  const history = [
    {
      role: 'model' as const,
      parts: [{ functionCall: { id: 'call_1', name: 'read', args: { filePath: 'a.txt' } } }],
    },
    {
      role: 'tool' as const,
      parts: [{ functionResponse: { tool_use_id: 'call_1', name: 'read', response: { output: 'ok' } } }],
    },
    {
      role: 'user' as const,
      parts: [
        { system: 'current session ID = demo/test' },
        { text: 'follow-up' },
      ],
    },
  ];

  const fixed = fixToolCalls(history as any);
  assert.equal(fixed.length, 3);
  assert.equal(fixed[2].role, 'user');
  assert.notEqual(fixed[1].role, 'model');
});
