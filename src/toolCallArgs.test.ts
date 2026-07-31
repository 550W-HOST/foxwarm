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

test('exact empty raw tool arguments canonicalize to an empty object for serialization', () => {
  const parsed = parseFunctionCallArgs('');
  assert.deepEqual(parsed, { args: {} });

  const whitespace = parseFunctionCallArgs(' ');
  assert.equal(whitespace.rawArgsText, ' ');
  assert.match(whitespace.argsParseError || '', /Invalid tool arguments JSON:/);

  const history = [{
    role: 'model' as const,
    parts: [{
      functionCall: {
        id: 'call_empty_args',
        name: 'no_args_tool',
        ...parsed,
      },
    }],
  }];
  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages[0].tool_calls[0].function.arguments, '{}');
  const responsesItems = convertToOpenAIResponsesFormat(history);
  assert.equal(responsesItems.find(item => item.type === 'function_call')?.arguments, '{}');
});

test('executeTools turns malformed tool arguments into a structured tool error', async () => {
  const sessionId = makeSessionId('tool_args_test');
  try {
    const toolMessage = await executeTools(
      [{
        id: 'call_bad_args',
        name: 'read',
        args: {},
        rawArgsText: '{"filePath":',
        argsParseError: 'Invalid tool arguments JSON: Unexpected end of JSON input',
      }],
      { sessionId, session: { agent: 'main' } },
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
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('executeTools persists previous LLM timing only on the first tool response', async () => {
  const toolMessage = await executeTools(
    [
      { id: 'call_first', name: 'read', args: {}, rawArgsText: '{', argsParseError: 'bad args' },
      { id: 'call_second', name: 'read', args: {}, rawArgsText: '{', argsParseError: 'bad args' },
    ],
    {
      sessionId: 'tool-timing-test/main',
      session: { agent: 'main' },
      previousLlmRequest: { completedAt: new Date('2026-07-27T05:00:00+08:00').getTime(), durationMs: 8200 },
    },
    { agent: 'main', verbose: false },
  );
  const responses = toolMessage.parts.map(part => part.functionResponse);
  assert.deepEqual(responses[0]?.previousLlmRequest, { time: '2026-07-27 05:00:00 +0800', durationMs: 8200 });
  assert.equal(responses[1]?.previousLlmRequest, undefined);
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
    assert.equal((await sessionManager.getSession(sessionId)).meta.wait, undefined);
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
    assert.equal((await sessionManager.getSession(sessionId)).meta.wait, undefined);
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
    assert.equal(typeof (await sessionManager.getSession(sourceSessionId)).meta.wait?.id, 'string');
  } finally {
    await sessionManager.deleteSession(sourceSessionId).catch(() => false);
    await sessionManager.deleteSession(targetSessionId).catch(() => false);
  }
});

test('successful flagged handoff keeps its post-batch wait request despite a sibling error', async () => {
  const sourceSessionId = makeSessionId('flagged_error_source');
  const targetSessionId = makeSessionId('flagged_error_target');
  await sessionManager.getSession(sourceSessionId);
  await sessionManager.getSession(targetSessionId);
  try {
    const source = await sessionManager.getSession(sourceSessionId);
    const toolMessage: any = await executeTools([
      { id: 'flagged-send', name: 'send_to_session', args: { sessionId: targetSessionId, message: 'hello', waitAfterHandoff: true } },
      { id: 'missing-read', name: 'read', args: { filePath: makeMissingFilePath() } },
    ], { sessionId: sourceSessionId, session: source }, source);
    assert.deepEqual(toolMessage.__toolPostAction, { waitForReply: true });
    assert.equal(hasStopCurrentTurn(toolMessage), false);
    assert.equal(source.meta.wait, undefined);
    assert.equal(toolMessage.parts.length, 2);
  } finally {
    await sessionManager.deleteSession(sourceSessionId).catch(() => false);
    await sessionManager.deleteSession(targetSessionId).catch(() => false);
  }
});

test('multiple successful flagged handoffs coalesce and all failed handoffs request no wait', async () => {
  const sourceSessionId = makeSessionId('flagged_many_source');
  const targetA = makeSessionId('flagged_many_a');
  const targetB = makeSessionId('flagged_many_b');
  const source = await sessionManager.getSession(sourceSessionId);
  await sessionManager.getSession(targetA);
  await sessionManager.getSession(targetB);
  try {
    const successful: any = await executeTools([
      { id: 'send-a', name: 'send_to_session', args: { sessionId: targetA, message: 'a', waitAfterHandoff: true } },
      { id: 'send-b', name: 'send_to_session', args: { sessionId: targetB, message: 'b', waitAfterHandoff: true } },
    ], { sessionId: sourceSessionId, session: source }, source);
    assert.deepEqual(successful.__toolPostAction, { waitForReply: true });

    const failed: any = await executeTools([
      { id: 'missing-a', name: 'send_to_session', args: { sessionId: makeSessionId('missing_a'), message: 'a', waitAfterHandoff: true } },
      { id: 'missing-b', name: 'send_to_session', args: { sessionId: makeSessionId('missing_b'), message: 'b', waitAfterHandoff: true } },
    ], { sessionId: sourceSessionId, session: source }, source);
    assert.equal(failed.__toolPostAction, undefined);
  } finally {
    await sessionManager.deleteSession(sourceSessionId).catch(() => false);
    await sessionManager.deleteSession(targetA).catch(() => false);
    await sessionManager.deleteSession(targetB).catch(() => false);
  }
});

test('flagged handoff plus explicit wait remains deterministic when a sibling fails', async () => {
  const sourceSessionId = makeSessionId('flagged_explicit_source');
  const targetSessionId = makeSessionId('flagged_explicit_target');
  const source = await sessionManager.getSession(sourceSessionId);
  await sessionManager.getSession(targetSessionId);
  try {
    const toolMessage: any = await executeTools([
      { id: 'send', name: 'send_to_session', args: { sessionId: targetSessionId, message: 'hello', waitAfterHandoff: true } },
      { id: 'wait', name: 'wait', args: {} },
      { id: 'missing', name: 'read', args: { filePath: makeMissingFilePath() } },
    ], { sessionId: sourceSessionId, session: source }, source);
    assert.deepEqual(toolMessage.__toolPostAction, { waitForReply: true });
    assert.equal(hasStopCurrentTurn(toolMessage), false);
    assert.equal(source.meta.wait, undefined);
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

test('OpenAI serializers keep consecutive canonical user messages distinct', () => {
  const history = [
    { role: 'user' as const, parts: [{ text: 'queued channel user' }] },
    { role: 'user' as const, parts: [{ system: 'queued intersession notice' }] },
  ];

  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages.length, 2);
  assert.deepEqual(chatMessages.map(message => message.role), ['user', 'user']);
  assert.equal(chatMessages[0].content, 'queued channel user');
  assert.match(chatMessages[1].content, /queued intersession notice/);

  const responsesItems = convertToOpenAIResponsesFormat(history);
  assert.equal(responsesItems.length, 2);
  assert.deepEqual(responsesItems.map(item => item.role), ['user', 'user']);
  assert.equal(responsesItems[0].content[0].text, 'queued channel user');
  assert.match(responsesItems[1].content[0].text, /queued intersession notice/);
});

test('OpenAI serializers preserve single foxwarm system wrappers with payload text', () => {
  const history = [{
    role: 'user' as const,
    parts: [
      { system: '<foxwarm-system kind="event" type="background-process-finished">\ncommand: `npm run build`\nExit code: 0\n</foxwarm-system>' },
    ],
  }];

  const chatMessages = convertToOpenAIFormat(history);
  assert.equal(chatMessages[0].content, '<foxwarm-system kind="event" type="background-process-finished">\ncommand: `npm run build`\nExit code: 0\n</foxwarm-system>');
  assert.doesNotMatch(chatMessages[0].content, /\[SYSTEM:/);

  const responsesItems = convertToOpenAIResponsesFormat(history);
  assert.deepEqual(responsesItems, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '<foxwarm-system kind="event" type="background-process-finished">\ncommand: `npm run build`\nExit code: 0\n</foxwarm-system>' },
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
