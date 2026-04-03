import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompactionSplitIndex } from './history';
import { Message } from '../types';

function msg(role: Message['role'], parts: Message['parts']): Message {
  return { role, parts };
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
