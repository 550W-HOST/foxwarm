import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlockCandidateItem,
  buildCompactPlanValidationFeedback,
  buildCompactFlowToolDefinitions,
  buildCompactPromptText,
  buildMessageCandidateItem,
  COMPACT_PLAN_TOOL_NAME,
  CompactPlanValidationError,
  validateCompactPlanArgs,
} from './compactPlan';

const messageCandidates = [
  buildMessageCandidateItem(1, 1, 'first request'),
  buildMessageCandidateItem(2, 2, 'first answer'),
  buildMessageCandidateItem(3, 3, 'second request'),
  buildMessageCandidateItem(4, 4, 'second answer'),
];

test('message and block candidates render stable compact keys', () => {
  assert.equal(messageCandidates[0].kind, 'message');
  assert.equal(messageCandidates[0].key, 'M#1');
  const block = buildBlockCandidateItem(8, 2, 10, 30, 'summarized prior discussion');
  assert.equal(block.kind, 'block');
  assert.equal(block.key, 'B#8');
  assert.match(block.preview, /summarized prior discussion/);
});

test('buildCompactPromptText instructs the model to use the compact plan tool for layered-context candidates', () => {
  const prompt = buildCompactPromptText({
    forcedKeptCount: 3,
    forcedKeptStartSeq: 50,
    forcedKeptEndSeq: 60,
    candidateItems: [
      ...messageCandidates.slice(0, 2),
      buildBlockCandidateItem(9, 1, 3, 9, 'earlier summarized context'),
    ],
    guidance: 'Prefer compact summaries for resolved discussion.',
  });

  assert.match(prompt, new RegExp(COMPACT_PLAN_TOOL_NAME));
  assert.match(prompt, /force-kept/i);
  assert.match(prompt, /M#1/);
  assert.match(prompt, /B#9 L1 raw#3-#9/);
  assert.match(prompt, /resolved discussion/);
  assert.match(prompt, /Preserve decisions/i);
  assert.match(prompt, /get_context_archive/);
  assert.match(prompt, /read_memory/);
});

test('buildCompactFlowToolDefinitions exposes only compact-safe helper tools plus plan submission', () => {
  const defs = buildCompactFlowToolDefinitions();
  const names = defs.map(def => def.name);
  assert.deepStrictEqual(names, [
    'read_memory',
    'write_memory',
    'edit_memory',
    'delete_memory',
    'get_archived_messages',
    'get_archived_blocks',
    'get_context_archive',
    COMPACT_PLAN_TOOL_NAME,
  ]);
});

test('validateCompactPlanArgs accepts layered message and block range creation', () => {
  const candidates = [
    ...messageCandidates,
    buildBlockCandidateItem(10, 1, 5, 8, 'prior block'),
    buildBlockCandidateItem(11, 1, 9, 12, 'next prior block'),
  ];

  const plan = validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([
      {
        level: 1,
        sourceKind: 'message',
        sourceStart: 1,
        sourceEnd: 4,
        summary: 'summary for first four messages',
      },
      {
        level: 2,
        sourceKind: 'block',
        sourceStart: 10,
        sourceEnd: 11,
        summary: 'summary for existing level 1 blocks',
      },
    ]),
  }, candidates);

  assert.equal(plan.createBlocks.length, 2);
  assert.equal(plan.createBlocks[0].level, 1);
  assert.equal(plan.createBlocks[1].level, 2);
});

test('validateCompactPlanArgs accepts sparse raw seq ranges when ignored lifecycle messages were filtered out of candidates', () => {
  const sparseMessageCandidates = [
    buildMessageCandidateItem(1, 1, 'first real message'),
    buildMessageCandidateItem(3, 3, 'second real message after ignored lifecycle seq #2'),
    buildMessageCandidateItem(4, 4, 'third real message'),
  ];

  const plan = validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 4,
      summary: 'summary across visible messages while skipping ignored lifecycle seqs',
    }]),
  }, sparseMessageCandidates);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].sourceStart, 1);
  assert.equal(plan.createBlocks[0].sourceEnd, 4);
});

test('validateCompactPlanArgs treats grouped tool call/response candidates as atomic message ranges', () => {
  const groupedCandidates = [
    buildMessageCandidateItem(10, 11, 'tool call with paired response'),
    buildMessageCandidateItem(12, 12, 'follow-up user message'),
  ];

  const okPlan = validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 11,
      summary: 'summarize atomic tool exchange',
    }]),
  }, groupedCandidates);

  assert.equal(okPlan.createBlocks.length, 1);

  assert.throws(() => validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 10,
      summary: 'invalid partial tool exchange',
    }]),
  }, groupedCandidates), /continuous message range/i);
});

test('validateCompactPlanArgs rejects non-continuous or overlapping ranges', () => {
  assert.throws(() => validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 5,
      summary: 'invalid range',
    }]),
  }, messageCandidates), /continuous message range/i);

  assert.throws(() => validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([
      {
        level: 1,
        sourceKind: 'message',
        sourceStart: 1,
        sourceEnd: 2,
        summary: 'first',
      },
      {
        level: 1,
        sourceKind: 'message',
        sourceStart: 2,
        sourceEnd: 3,
        summary: 'overlap',
      },
    ]),
  }, messageCandidates), /overlaps another createBlocks range/i);
});

test('validateCompactPlanArgs still accepts legacy createBlocks arrays internally', () => {
  const plan = validateCompactPlanArgs({
    createBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'legacy compatibility',
    }],
  }, messageCandidates);

  assert.equal(plan.createBlocks.length, 1);
});

test('buildCompactPlanValidationFeedback explains invalid layered compact plans', () => {
  const error = new CompactPlanValidationError({
    createBlockErrors: ['createBlocks[0].summary must be a non-empty string.'],
  });

  const feedback = buildCompactPlanValidationFeedback(error, 2);
  assert.match(feedback, /COMPACT PLAN INVALID/);
  assert.match(feedback, /summary must be a non-empty string/);
  assert.match(feedback, /Attempts remaining after this feedback: 2/);
});
