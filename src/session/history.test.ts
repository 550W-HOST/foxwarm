import test from 'node:test';
import assert from 'node:assert/strict';
import { isSingleBlockCompactionStrandedBetweenHigherLevelBlocks, resolveCompactionSplitIndex } from './history';
import { ContextFrontierItem, Message } from '../types';

function msg(role: Message['role'], parts: Message['parts']): Message {
  return { role, parts };
}

function block(id: number, level: number): ContextFrontierItem {
  return { kind: 'block', id, level, rawStartSeq: id * 10, rawEndSeq: id * 10 + 9 };
}

test('resolveCompactionSplitIndex moves split back to include paired tool call when boundary lands on tool response', () => {
  const history: Message[] = [
    msg('user', [{ text: 'older' }]),
    msg('model', [{ functionCall: { id: 'call1', name: 'search_vector', args: { query: 'x' } } }]),
    msg('tool', [{ functionResponse: { tool_use_id: 'call1', name: 'search_vector', response: { output: 'ok' } } }]),
    msg('model', [{ text: 'recent answer' }]),
  ];

  const splitIndex = resolveCompactionSplitIndex(history, 0.5);
  assert.equal(splitIndex, 1);
});

test('resolveCompactionSplitIndex still pairs legacy search_memory tool history', () => {
  const history: Message[] = [
    msg('user', [{ text: 'older' }]),
    msg('model', [{ functionCall: { id: 'call1', name: 'search_memory', args: { query: 'x' } } }]),
    msg('tool', [{ functionResponse: { tool_use_id: 'call1', name: 'search_memory', response: { output: 'ok' } } }]),
    msg('model', [{ text: 'recent answer' }]),
  ];

  const splitIndex = resolveCompactionSplitIndex(history, 0.5);
  assert.equal(splitIndex, 1);
});

test('resolveCompactionSplitIndex does not make display-only messages a permanent compact barrier', () => {
  const history: Message[] = [
    msg('user', [{ text: 'older before notice' }]),
    { role: 'model', modelVisible: false, parts: [{ text: 'display-only notice' }] },
    msg('user', [{ text: 'ordinary message after notice' }]),
  ];

  assert.equal(resolveCompactionSplitIndex(history, 0), 3);
});

test('isSingleBlockCompactionStrandedBetweenHigherLevelBlocks recognizes a 3,3,2,3,3 island pattern', () => {
  const frontier: ContextFrontierItem[] = [
    block(1, 3),
    block(2, 3),
    block(3, 2),
    block(4, 3),
    block(5, 3),
  ];

  assert.equal(isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(frontier, 2), true);
});

test('isSingleBlockCompactionStrandedBetweenHigherLevelBlocks stays false without higher-level blocks on both sides', () => {
  const noRightHigher: ContextFrontierItem[] = [
    block(1, 3),
    block(2, 2),
    block(3, 2),
  ];
  const edgeCase: ContextFrontierItem[] = [
    block(1, 2),
    block(2, 3),
    block(3, 3),
  ];

  assert.equal(isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(noRightHigher, 1), false);
  assert.equal(isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(edgeCase, 0), false);
});
