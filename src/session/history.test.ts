import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatedBlockHistoryWithPreservedMessages, getUsageTotalTokens, isSingleBlockCompactionStrandedBetweenHigherLevelBlocks, removePreservedMessages, resolveCompactionSplitIndex } from './history';
import { Message } from '../types';

function msg(role: Message['role'], parts: Message['parts'], meta?: Message['__meta']): Message {
  return { role, parts, ...(meta ? { __meta: meta } : {}) };
}

function blockMessage(id: number, level: number): Message {
  return msg('model', [{ text: `block ${id}` }], { contextBlock: {
    id, level, rawStartSeq: id * 10, rawEndSeq: id * 10 + 9,
    sourceKind: level === 1 ? 'message' : 'block', sourceStart: id, sourceEnd: id,
  } });
}

test('getUsageTotalTokens does not add reasoning tokens on top of complete output usage', () => {
  assert.equal(getUsageTotalTokens({ cachedTokens: 5, inputTokens: 12, outputTokens: 13, reasoningTokens: 8 }), 30);
});

test('resolveCompactionSplitIndex moves split back to include paired tool call when boundary lands on tool response', () => {
  const history: Message[] = [
    msg('user', [{ text: 'older' }]),
    msg('model', [{ functionCall: { id: 'call1', name: 'search_vector', args: { query: 'x' } } }]),
    msg('tool', [{ functionResponse: { tool_use_id: 'call1', name: 'search_vector', response: { output: 'ok' } } }]),
    msg('model', [{ text: 'recent answer' }]),
  ];
  assert.equal(resolveCompactionSplitIndex(history, 0.5), 1);
});

test('resolveCompactionSplitIndex does not make display-only messages a permanent compact barrier', () => {
  const history: Message[] = [msg('user', [{ text: 'older' }]), { role: 'model', modelVisible: false, parts: [{ text: 'notice' }] }, msg('user', [{ text: 'after' }])];
  assert.equal(resolveCompactionSplitIndex(history, 0), 3);
});

test('isSingleBlockCompactionStrandedBetweenHigherLevelBlocks recognizes a 3,3,2,3,3 island pattern', () => {
  const history = [blockMessage(1, 3), blockMessage(2, 3), blockMessage(3, 2), blockMessage(4, 3), blockMessage(5, 3)];
  assert.equal(isSingleBlockCompactionStrandedBetweenHigherLevelBlocks(history, 2), true);
});

test('created block history preserves exact selected raw messages with provenance', () => {
  const source = [msg('user', [{ text: 'one' }], { seq: 12 }), msg('user', [{ text: 'two' }], { seq: 15 })];
  const created: any = { id: 8, level: 1, rawStartSeq: 10, rawEndSeq: 20, sourceKind: 'message', sourceStart: 10, sourceEnd: 20, summary: 'summary', createdAt: 1 };
  const result = buildCreatedBlockHistoryWithPreservedMessages(created, source, [15, 12]);
  assert.equal(result[0].__meta?.contextBlock?.id, 8);
  assert.deepEqual(result.slice(1).map(message => [message.__meta?.seq, message.__meta?.preservedFromBlockId]), [[12, 8], [15, 8]]);
  assert.equal(result[1].parts[0].text, 'one');
});

test('removePreservedMessages removes only marked preserved raw messages', () => {
  const history = [msg('user', [{ text: 'ordinary' }], { seq: 10 }), msg('user', [{ text: 'preserved' }], { seq: 11, preservedFromBlockId: 3 }), blockMessage(3, 1)];
  assert.deepEqual(removePreservedMessages(history, new Set([10, 11])).map(message => message.__meta?.seq || message.__meta?.contextBlock?.id), [10, 3]);
});
