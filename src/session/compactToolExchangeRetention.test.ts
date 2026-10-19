import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Message } from '../types';
import { validateCompactPlanArgs } from './compactPlan';
import { buildLayeredCompactCandidateEntries } from './history';

// Raw candidates need enough estimated tokens to be eligible for compaction at all.
const PAD = 'filler text for the compaction token budget. '.repeat(300);

function modelCall(seq: number, ids: string[], text = 'thinking'): Message {
  return {
    role: 'model',
    parts: [
      { text: `${text} ${PAD}` },
      ...ids.map(id => ({ functionCall: { id, name: 'exec', args: { command: `echo ${id}` } } })),
    ],
    __meta: { seq },
  } as unknown as Message;
}

function toolResponses(seq: number, ids: string[]): Message {
  return {
    role: 'tool',
    parts: ids.map(id => ({ functionResponse: { tool_use_id: id, name: 'exec', response: { output: `${id} ${PAD}` } } })),
    __meta: { seq },
  } as unknown as Message;
}

function textMessage(role: 'user' | 'model', seq: number, text: string): Message {
  return { role, parts: [{ text: `${text} ${PAD}` }], __meta: { seq } } as unknown as Message;
}

function preservedCopy(message: Message, blockId: number): Message {
  return { ...message, __meta: { ...message.__meta, preservedFromBlockId: blockId } } as Message;
}

async function candidatesOf(history: Message[]) {
  return buildLayeredCompactCandidateEntries(history);
}

function messageItems(entries: Awaited<ReturnType<typeof candidatesOf>>['candidateEntries']) {
  return entries.map(entry => entry.item).filter(item => item.kind === 'message');
}

test('three-call exchange in one tool message stays one candidate', async () => {
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a', 'b', 'c']),
    toolResponses(3, ['a', 'b', 'c']),
    textMessage('model', 4, 'done'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const keys = messageItems(candidateEntries).map(item => item.key);

  assert.ok(keys.includes('M#2-#3'), `expected grouped exchange, got ${keys.join(', ')}`);
  assert.ok(!keys.includes('M#3'), 'a response must not be a standalone candidate');
});

test('three-call exchange split across three tool messages stays one candidate', async () => {
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a', 'b', 'c']),
    toolResponses(3, ['a']),
    toolResponses(4, ['b']),
    toolResponses(5, ['c']),
    textMessage('model', 6, 'done'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const keys = messageItems(candidateEntries).map(item => item.key);

  assert.ok(keys.includes('M#2-#5'), `expected grouped exchange, got ${keys.join(', ')}`);
});

test('call-only candidate with no responses is still allowed', async () => {
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a']),
    textMessage('user', 3, 'next'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const keys = messageItems(candidateEntries).map(item => item.key);

  assert.ok(keys.includes('M#2'), `call-only message should remain a candidate, got ${keys.join(', ')}`);
});

test('an ignored lifecycle notice does not strand the exchange that follows it', async () => {
  // The notice is not a removable compact-completion message, so it is ignored as a candidate barrier.
  const notice = {
    role: 'user',
    parts: [{ system: '<foxwarm-system kind="session-boundary" event="new-child" time="2026-10-12 11:08:31 +0800" />' }],
    __meta: { seq: 4 },
  } as unknown as Message;
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a']),
    toolResponses(3, ['a']),
    notice,
    modelCall(5, ['b']),
    toolResponses(6, ['b']),
    textMessage('model', 7, 'done'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const keys = messageItems(candidateEntries).map(item => item.key);

  assert.ok(keys.includes('M#5-#6'), `the exchange after the notice must be a candidate, got ${keys.join(', ')}`);
  assert.ok(!keys.includes('M#6'), 'a response must not be a standalone candidate');
});

test('preserving one response keeps the whole three-call exchange', async () => {
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a', 'b', 'c']),
    toolResponses(3, ['a', 'b', 'c']),
    textMessage('model', 4, 'done'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 4,
      summary: 'summary',
    }],
    preserveMessages: [3],
  }, candidateEntries.map(entry => entry.item));

  assert.deepEqual(plan.preserveMessages, [2, 3]);
});

test('preserving the model call keeps every paired response', async () => {
  const history = [
    textMessage('user', 1, 'start'),
    modelCall(2, ['a', 'b', 'c']),
    toolResponses(3, ['a']),
    toolResponses(4, ['b', 'c']),
    textMessage('model', 5, 'done'),
  ];
  const { candidateEntries } = await candidatesOf(history);
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 5,
      summary: 'summary',
    }],
    preserveMessages: [2],
  }, candidateEntries.map(entry => entry.item));

  assert.deepEqual(plan.preserveMessages, [2, 3, 4]);
});

test('removing part of a preserved tool exchange is rejected and names the missing members', async () => {
  const history = [
    preservedCopy(modelCall(2, ['a', 'b', 'c']), 9),
    preservedCopy(toolResponses(3, ['a']), 9),
    preservedCopy(toolResponses(4, ['b', 'c']), 9),
    textMessage('model', 5, 'done'),
  ];
  const { candidateEntries, preservedMessageCandidates } = await candidatesOf(history);
  const args = {
    removePreservedMessages: [4],
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 5,
      sourceEnd: 5,
      summary: 'summary',
    }],
  };

  assert.throws(() => validateCompactPlanArgs(args, candidateEntries.map(entry => entry.item), {
    removablePreservedMessages: preservedMessageCandidates,
  }), /msg#2, msg#3/);
});

test('removing a complete preserved tool exchange is accepted', async () => {
  const history = [
    preservedCopy(modelCall(2, ['a', 'b', 'c']), 9),
    preservedCopy(toolResponses(3, ['a']), 9),
    preservedCopy(toolResponses(4, ['b', 'c']), 9),
    textMessage('model', 5, 'done'),
  ];
  const { candidateEntries, preservedMessageCandidates } = await candidatesOf(history);
  const plan = validateCompactPlanArgs({
    removePreservedMessages: [2, 3, 4],
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 5,
      sourceEnd: 5,
      summary: 'summary',
    }],
  }, candidateEntries.map(entry => entry.item), { removablePreservedMessages: preservedMessageCandidates });

  assert.deepEqual(plan.removePreservedMessages, [2, 3, 4]);
});

test('a preserved response joins a preserved exchange only through its tool_use_id', async () => {
  // msg#3 directly follows a preserved text message but answers no call in it, so it is its own exchange.
  const history = [
    preservedCopy(textMessage('model', 2, 'plain note'), 9),
    preservedCopy(toolResponses(3, ['unrelated']), 9),
    textMessage('model', 4, 'done'),
  ];
  const { candidateEntries, preservedMessageCandidates } = await candidatesOf(history);
  const plan = validateCompactPlanArgs({
    removePreservedMessages: [3],
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 4,
      sourceEnd: 4,
      summary: 'summary',
    }],
  }, candidateEntries.map(entry => entry.item), { removablePreservedMessages: preservedMessageCandidates });

  assert.deepEqual(plan.removePreservedMessages, [3]);
});
