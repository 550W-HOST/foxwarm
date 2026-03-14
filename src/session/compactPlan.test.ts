import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactPlanValidationFeedback,
  buildCompactCandidateBlocks,
  buildCompactPromptText,
  COMPACT_PLAN_TOOL_NAME,
  CompactPlanValidationError,
  validateCompactPlanArgs,
} from './compactPlan';
import { Message } from '../types';

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

test('compact block preview skips thinking and prefixes continuation lines with > ', () => {
  const messages: Message[] = [
    {
      role: 'model',
      parts: [{
        text: 'visible line 1\nvisible line 2',
        thinking: 'hidden reasoning should not appear',
      }],
      __meta: { seq: 11, timestamp: 11000 },
    },
  ];

  const blocks = buildCompactCandidateBlocks(messages);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].preview, /#11 visible line 1\n> visible line 2/);
  assert.doesNotMatch(blocks[0].preview, /hidden reasoning should not appear/);
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
    guidance: 'Prefer keeping unresolved implementation details.',
  });

  assert.match(prompt, new RegExp(COMPACT_PLAN_TOOL_NAME));
  assert.match(prompt, /force-kept/i);
  assert.match(prompt, /#50-#60/);
  assert.match(prompt, /unresolved implementation details/);
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
    dropBlockIds: [],
  }, blocks), /missing block ids/i);

  assert.throws(() => validateCompactPlanArgs({
    summary: 'summary',
    keepBlockIds: [blocks[0].id],
    dropBlockIds: [blocks[0].id],
  }, blocks), /duplicate block ids/i);
});

test('buildCompactPlanValidationFeedback explains invalid compact plans with structured details', () => {
  const error = new CompactPlanValidationError({
    summaryErrors: ['must be a non-empty string'],
    arrayErrors: ['keepBlockIds must be an array of block ids.'],
    unknownBlockIds: ['block_x'],
    duplicateBlockIds: ['block_01'],
    missingBlockIds: ['block_02'],
  });

  const feedback = buildCompactPlanValidationFeedback(error, 2);
  assert.match(feedback, /COMPACT PLAN INVALID/);
  assert.match(feedback, /summary: must be a non-empty string/);
  assert.match(feedback, /keepBlockIds must be an array of block ids/);
  assert.match(feedback, /unknown block ids: block_x/);
  assert.match(feedback, /duplicate block ids: block_01/);
  assert.match(feedback, /missing block ids: block_02/);
  assert.match(feedback, /Attempts remaining after this feedback: 2/);
});
