import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactCandidateBlocks,
  buildCompactPromptText,
  COMPACT_PLAN_TOOL_NAME,
  validateCompactPlanArgs,
} from './compactPlan';
import { Message } from './types';

function makeMessage(seq: number, role: 'user' | 'model' | 'tool', text: string): Message {
  return {
    role,
    parts: role === 'tool'
      ? [{ functionResponse: { tool_use_id: `tool-${seq}`, name: 'read', response: { output: text } } }]
      : [{ text }],
    __meta: { seq, timestamp: seq * 1000 },
  };
}

test('buildCompactCandidateBlocks groups older history into seq-based blocks with previews', () => {
  const messages: Message[] = [
    makeMessage(1, 'user', 'first request'),
    makeMessage(2, 'model', 'first answer'),
    makeMessage(3, 'user', 'second request'),
    makeMessage(4, 'model', 'second answer'),
  ];

  const blocks = buildCompactCandidateBlocks(messages);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startSeq, 1);
  assert.equal(blocks[0].endSeq, 4);
  assert.match(blocks[0].id, /seq_1_4/);
  assert.match(blocks[0].preview, /#1/);
  assert.match(blocks[0].preview, /first request/);
});

test('buildCompactPromptText tells the model to use the compact plan tool and references force-kept recent messages', () => {
  const blocks = buildCompactCandidateBlocks([
    makeMessage(1, 'user', 'alpha'),
    makeMessage(2, 'model', 'beta'),
  ]);

  const prompt = buildCompactPromptText({
    forcedKeptCount: 3,
    forcedKeptStartSeq: 50,
    forcedKeptEndSeq: 60,
    candidateBlocks: blocks,
  });

  assert.match(prompt, new RegExp(COMPACT_PLAN_TOOL_NAME));
  assert.match(prompt, /force-kept/i);
  assert.match(prompt, /#50-#60/);
  assert.match(prompt, new RegExp(blocks[0].id));
});

test('validateCompactPlanArgs accepts complete non-overlapping block assignments', () => {
  const blocks = buildCompactCandidateBlocks([
    makeMessage(1, 'user', 'alpha'),
    makeMessage(2, 'model', 'beta'),
    makeMessage(3, 'user', 'gamma'),
    makeMessage(4, 'model', 'delta'),
  ]);

  const plan = validateCompactPlanArgs({
    summary: 'short working summary',
    keepBlockIds: [blocks[0].id],
    summarizeBlockIds: [],
    dropBlockIds: [],
  }, blocks);

  assert.equal(plan.summary, 'short working summary');
  assert.deepEqual(plan.keepBlockIds, [blocks[0].id]);
});

test('validateCompactPlanArgs rejects missing or duplicated block classifications', () => {
  const blocks = buildCompactCandidateBlocks([
    makeMessage(1, 'user', 'alpha'),
    makeMessage(2, 'model', 'beta'),
  ]);

  assert.throws(() => validateCompactPlanArgs({
    summary: 'summary',
    keepBlockIds: [],
    summarizeBlockIds: [],
    dropBlockIds: [],
  }, blocks), /did not classify every block/i);

  assert.throws(() => validateCompactPlanArgs({
    summary: 'summary',
    keepBlockIds: [blocks[0].id],
    summarizeBlockIds: [blocks[0].id],
    dropBlockIds: [],
  }, blocks), /more than once/i);
});
