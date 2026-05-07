import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlockCandidateItem,
  buildCompactPlanValidationFeedback,
  buildCompactPromptText,
  buildMessageCandidateItem,
  COMPACT_LEVEL_TOKEN_THRESHOLD,
  COMPACT_FLOW_MAX_ROUNDS,
  COMPACT_PLAN_TOOL_DEFINITION,
  COMPACT_PLAN_TOOL_NAME,
  CompactPlanValidationError,
  filterCompactCandidateItemsByLevel,
  selectCompactCandidateTargetLevels,
  trimPreview,
  validateCompactPlanArgs,
} from './compactPlan';
import { containsLoneSurrogate } from '../utils/unicode';

const messageCandidates = [
  buildMessageCandidateItem(1, 1, 'first request'),
  buildMessageCandidateItem(2, 2, 'first answer'),
  buildMessageCandidateItem(3, 3, 'second request'),
  buildMessageCandidateItem(4, 4, 'second answer'),
];

test('message and block candidates render stable compact keys', () => {
  assert.equal(COMPACT_FLOW_MAX_ROUNDS, 15);
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
  assert.doesNotMatch(prompt, /Current session goal\/context/);
  assert.doesNotMatch(prompt, /Session goal reminder/);
  assert.match(prompt, /Preserve decisions/i);
  assert.doesNotMatch(prompt, /get_context_archive/);
  assert.doesNotMatch(prompt, /get_archived_messages/);
  assert.doesNotMatch(prompt, /get_archived_blocks/);
  assert.match(prompt, /read_memory/);
  assert.match(prompt, new RegExp(`${COMPACT_FLOW_MAX_ROUNDS} total rounds`, 'i'));
  assert.match(prompt, /apply_patch_memory/);
  assert.match(prompt, /leave it uncompressed by simply omitting it from createBlocksJson/i);
  assert.match(prompt, /single block may be summarized only when it is a stranded island/i);
  assert.match(prompt, /source-range-bound/i);
  assert.match(prompt, /user\/inter-agent inputs, process, findings, and TODOs inside that range/i);
  assert.match(prompt, /do not borrow facts, later outcomes, or completions from force-kept items or any other outside range/i);
  assert.match(prompt, /force-kept later context completed a task.*source range only contains the unfinished earlier work/is);
});

test('trimPreview and compact prompt rendering do not split surrogate pairs at emoji boundaries', () => {
  const clipped = trimPreview('# Foxwarm 🦊 extra', 12);
  assert.equal(containsLoneSurrogate(clipped), false);
  assert.doesNotMatch(JSON.stringify(clipped), /\\ud83e(?!\\udd8a)/i);

  const boundaryPreview = `${'x'.repeat(78)}🦊 trailing text`;
  const prompt = buildCompactPromptText({
    forcedKeptCount: 0,
    candidateItems: [
      buildMessageCandidateItem(1, 1, 'edge start'),
      buildMessageCandidateItem(2, 2, 'edge start 2'),
      buildMessageCandidateItem(3, 3, boundaryPreview),
      buildMessageCandidateItem(4, 4, 'edge end 1'),
      buildMessageCandidateItem(5, 5, 'edge end 2'),
    ],
  });

  assert.equal(containsLoneSurrogate(prompt), false);
  assert.doesNotMatch(JSON.stringify(prompt), /\\ud83e(?!\\udd8a)/i);
});

test('filterCompactCandidateItemsByLevel removes levels at or below 2k tokens and block-only levels with fewer than two blocks', () => {
  const candidates = [
    buildMessageCandidateItem(1, 1, 'small message a', COMPACT_LEVEL_TOKEN_THRESHOLD),
    buildMessageCandidateItem(2, 2, 'small message b', 0),
    buildBlockCandidateItem(10, 1, 3, 4, 'large but single block level', COMPACT_LEVEL_TOKEN_THRESHOLD + 500),
    buildBlockCandidateItem(20, 2, 5, 6, 'first eligible block', 1200),
    buildBlockCandidateItem(21, 2, 7, 8, 'second eligible block', 1001),
  ];

  const allowedLevels = selectCompactCandidateTargetLevels(candidates);
  assert.deepStrictEqual([...allowedLevels].sort((a, b) => a - b), [3]);

  const filtered = filterCompactCandidateItemsByLevel(candidates);
  assert.deepStrictEqual(filtered.map(item => item.key), ['B#20', 'B#21']);
});

test('filterCompactCandidateItemsByLevel allows a stranded single block in a 3,3,2,3,3 pattern', () => {
  const candidates = [
    buildBlockCandidateItem(1, 3, 1, 10, 'left higher block a', 200),
    buildBlockCandidateItem(2, 3, 11, 20, 'left higher block b', 200),
    buildBlockCandidateItem(3, 2, 21, 30, 'middle stranded block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, true),
    buildBlockCandidateItem(4, 3, 31, 40, 'right higher block a', 200),
    buildBlockCandidateItem(5, 3, 41, 50, 'right higher block b', 200),
  ];

  const allowedLevels = selectCompactCandidateTargetLevels(candidates);
  assert.deepStrictEqual([...allowedLevels].sort((a, b) => a - b), [3]);

  const filtered = filterCompactCandidateItemsByLevel(candidates);
  assert.deepStrictEqual(filtered.map(item => item.key), ['B#3']);
});

test('filterCompactCandidateItemsByLevel does not let an unsupported single block escape just because it is alone in its target level', () => {
  const candidates = [
    buildBlockCandidateItem(1, 3, 1, 10, 'left higher block a', 200),
    buildBlockCandidateItem(2, 3, 11, 20, 'left higher block b', 200),
    buildBlockCandidateItem(3, 2, 21, 30, 'middle but not allowed block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, false),
    buildBlockCandidateItem(4, 3, 31, 40, 'right higher block a', 200),
    buildBlockCandidateItem(5, 3, 41, 50, 'right higher block b', 200),
  ];

  const allowedLevels = selectCompactCandidateTargetLevels(candidates);
  assert.deepStrictEqual([...allowedLevels].sort((a, b) => a - b), []);
});

test('submit compact plan opts into the normal model-facing tool schema', () => {
  assert.equal(COMPACT_PLAN_TOOL_DEFINITION.defaultInject, true);
});

test('buildCompactPlanValidationFeedback no longer suggests archive inspection helpers during compaction', () => {
  const feedback = buildCompactPlanValidationFeedback(new CompactPlanValidationError({
    createBlockErrors: ['bad compact range'],
  }));

  assert.match(feedback, /apply_patch_memory/);
  assert.doesNotMatch(feedback, /get_context_archive/);
  assert.doesNotMatch(feedback, /get_archived_messages/);
  assert.doesNotMatch(feedback, /get_archived_blocks/);
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

test('validateCompactPlanArgs rejects a single-block source but still allows a single-message source', () => {
  const blockCandidates = [
    buildBlockCandidateItem(10, 1, 5, 8, 'prior block'),
    buildBlockCandidateItem(11, 1, 9, 12, 'next prior block'),
  ];

  assert.throws(() => validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 2,
      sourceKind: 'block',
      sourceStart: 10,
      sourceEnd: 10,
      summary: 'invalid single block summary',
    }]),
  }, blockCandidates), /single block source|higher-level blocks/i);

  const singleMessagePlan = validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 1,
      summary: 'single large message summary',
    }]),
  }, [buildMessageCandidateItem(1, 1, 'large single message')]);

  assert.equal(singleMessagePlan.createBlocks.length, 1);
  assert.equal(singleMessagePlan.createBlocks[0].sourceStart, 1);
  assert.equal(singleMessagePlan.createBlocks[0].sourceEnd, 1);
});

test('validateCompactPlanArgs allows a stranded single block source when the candidate explicitly permits it', () => {
  const plan = validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 3,
      sourceKind: 'block',
      sourceStart: 30,
      sourceEnd: 30,
      summary: 'lift the stranded middle block upward',
    }]),
  }, [
    buildBlockCandidateItem(30, 2, 21, 30, 'middle stranded block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, true),
  ]);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].sourceStart, 30);
  assert.equal(plan.createBlocks[0].sourceEnd, 30);
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

  const feedback = buildCompactPlanValidationFeedback(error);
  assert.match(feedback, /COMPACT PLAN INVALID/);
  assert.match(feedback, /summary must be a non-empty string/);
  assert.match(feedback, /Fix only the layered-context plan/);
});
