import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlockCandidateItem,
  calculateBlockCompactionWindow,
  buildCompactPlanValidationFeedback,
  buildCompactPromptText,
  buildMessageCandidateItem,
  COMPACT_LEVEL_TOKEN_THRESHOLD,
  COMPACT_FLOW_MAX_ROUNDS,
  COMPACT_PLAN_TOOL_DEFINITION,
  COMPACT_PLAN_TOOL_NAME,
  CompactPlanValidationError,
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

test('calculateBlockCompactionWindow strictly keeps newest 60% and applies 3k/5k thresholds', () => {
  for (const [count, expectedCandidates] of [[1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [6, 2]] as const) {
    const window = calculateBlockCompactionWindow({
      totalBlockCount: count,
      totalTokens: 3000,
      minTokens: 3000,
      forceTokens: 5000,
      candidateFraction: 0.4,
      forceCompactFraction: 0.2,
    });
    assert.equal(window.candidateBlockCount, expectedCandidates);
    assert.equal(window.forcedKeepNewestCount, count - expectedCandidates);
    assert.equal(window.requestedMinBlocks, 0);
  }

  assert.deepStrictEqual(calculateBlockCompactionWindow({
    totalBlockCount: 5,
    totalTokens: 2999,
    minTokens: 3000,
    forceTokens: 5000,
    candidateFraction: 0.4,
    forceCompactFraction: 0.2,
  }), {
    forcedKeepNewestCount: 5,
    candidateBlockCount: 0,
    requestedMinBlocks: 0,
  });

  assert.equal(calculateBlockCompactionWindow({
    totalBlockCount: 6,
    totalTokens: 5000,
    minTokens: 3000,
    forceTokens: 5000,
    candidateFraction: 0.4,
    forceCompactFraction: 0.2,
  }).requestedMinBlocks, 2);
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
    messagePolicy: {
      thresholdTokens: 2000,
      totalCandidateTokens: 5000,
      eligibleTokens: 5000,
      requestedMinTokens: 1000,
      feasibleMaxTokens: 5000,
      effectiveMinTokens: 1000,
    },
    blockPolicies: [{
      sourceLevel: 1,
      totalBlockCount: 5,
      totalTokens: 5000,
      forcedKeepNewestCount: 3,
      candidateBlockCount: 2,
      requestedMinBlocks: 1,
      feasibleMaxBlocks: 2,
      effectiveMinBlocks: 1,
    }],
    guidance: 'Prefer compact summaries for resolved discussion.',
  });

  assert.match(prompt, new RegExp(COMPACT_PLAN_TOOL_NAME));
  assert.match(prompt, /force-kept/i);
  assert.match(prompt, /M#1/);
  assert.match(prompt, /B#9 L1 raw#3-#9/);
  assert.match(prompt, /resolved discussion/);
  assert.match(prompt, /Raw messages: ~5000 eligible estimated tokens.*at least ~1000/i);
  assert.match(prompt, /Source L1 blocks: 5 block\(s\).*newest 3 are force-kept.*oldest 2 may be listed/i);
  assert.match(prompt, /must compact at least 1 source L1 block/i);
  assert.match(prompt, /Segment 1: raw message candidates -> L1 block\(s\)/);
  assert.match(prompt, /Segment 2: history-contiguous L1 block candidates -> L2 block\(s\)/);
  assert.match(prompt, /This segment has only one block, so normally leave it uncompressed/i);
  assert.match(prompt, /Treat each Segment header as a hard boundary/i);
  assert.match(prompt, /Goal: Replace older context with compact, continuation-oriented summaries/i);
  assert.match(prompt, /Block range rules \(must be followed to produce a valid plan\):/i);
  assert.match(prompt, /Summary writing guidance:/i);
  assert.match(prompt, /A good summary often looks like one of these shapes/i);
  assert.match(prompt, /Memory facts:/i);
  assert.match(prompt, /Block compression is optional/i);
  assert.doesNotMatch(prompt, /Current session goal\/context/);
  assert.doesNotMatch(prompt, /Session goal reminder/);
  assert.match(prompt, /Preserve decisions/i);
  assert.match(prompt, /Preserve the original task\/goal as stated by the requester/i);
  assert.match(prompt, /do not over-interpret them/i);
  assert.match(prompt, /not yet resolved/i);
  assert.doesNotMatch(prompt, /get_context_archive/);
  assert.doesNotMatch(prompt, /get_archived_messages/);
  assert.doesNotMatch(prompt, /get_archived_blocks/);
  assert.doesNotMatch(prompt, /read_memory|write_memory|edit_memory|delete_memory|apply_patch_memory/);
  assert.match(prompt, new RegExp(`${COMPACT_FLOW_MAX_ROUNDS} total rounds`, 'i'));
  assert.match(prompt, /Do not read or write agent memory during compaction/i);
  assert.match(prompt, /leave it uncompressed by simply omitting it from replaceAsBlocks/i);
  assert.match(prompt, /Prefer a direct array of objects/i);
  assert.match(prompt, /JSON string encoding that same array is also accepted/i);
  assert.match(prompt, /single block may be summarized only when it is a stranded island/i);
  assert.match(prompt, /source-range-bound/i);
  assert.match(prompt, /user\/inter-agent inputs, process, findings, and TODOs inside that range/i);
  assert.match(prompt, /do not borrow facts, later outcomes, or completions from force-kept items or any other outside range/i);
  assert.match(prompt, /force-kept later context completed a task.*source range only contains the unfinished earlier work/is);
  assert.match(prompt, /Active range: "Leading hypothesis is Y/i);
  assert.match(prompt, /Blocked range: "Tried X but failed because Y/i);
  assert.match(prompt, /memoryFacts array of their matching replaceAsBlocks entry/i);
  assert.match(prompt, /do not repeat them manually in summary prose/i);
  assert.doesNotMatch(prompt, /memoryFactsJson/);
});

test('validateCompactPlanArgs rejects block-only plans when eligible raw-message token quota is unmet', () => {
  const candidates = [
    buildMessageCandidateItem(1, 1, 'large raw message', 1000, 1),
    buildMessageCandidateItem(2, 2, 'another raw message', 1000, 1),
    buildBlockCandidateItem(10, 1, 3, 4, 'old block one', 1000, false, 2),
    buildBlockCandidateItem(11, 1, 5, 6, 'old block two', 1000, false, 2),
  ];
  const messagePolicy = {
    thresholdTokens: 2000,
    totalCandidateTokens: 2000,
    eligibleTokens: 2000,
    requestedMinTokens: 400,
    feasibleMaxTokens: 2000,
    effectiveMinTokens: 400,
  };

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 10,
      sourceEnd: 11,
      summary: 'block-only plan',
    }],
  }, candidates, { messagePolicy }), /Raw-message hard quota.*deficit ~400/i);

  const repaired = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 1,
      summary: 'raw message summary',
    }],
  }, candidates, { messagePolicy });
  assert.equal(repaired.createBlocks[0].sourceKind, 'message');
});

test('raw-message quota uses estimated tokens across segments and excludes preserveMessages coverage', () => {
  const candidates = [
    buildMessageCandidateItem(1, 1, 'first', 300, 1),
    buildMessageCandidateItem(2, 2, 'second', 400, 2),
  ];
  const messagePolicy = {
    thresholdTokens: 2000,
    totalCandidateTokens: 700,
    eligibleTokens: 700,
    requestedMinTokens: 350,
    feasibleMaxTokens: 700,
    effectiveMinTokens: 350,
  };

  const acrossSegments = validateCompactPlanArgs({
    replaceAsBlocks: [
      { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 1, summary: 'one' },
      { level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2, summary: 'two' },
    ],
  }, candidates, { messagePolicy });
  assert.equal(acrossSegments.createBlocks.length, 2);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 2,
      sourceEnd: 2,
      summary: 'summary but preserve the original verbatim',
    }],
    preserveMessages: [2],
  }, candidates, { messagePolicy }), /replaces only ~0 after excluding preserveMessages/i);
});

test('block quotas accumulate legal multi-block segments and ignore stranded single lifts', () => {
  const candidates = [
    buildBlockCandidateItem(10, 1, 1, 2, 'a', 100, false, 1),
    buildBlockCandidateItem(11, 1, 3, 4, 'b', 100, false, 1),
    buildBlockCandidateItem(20, 1, 5, 6, 'c', 100, false, 2),
    buildBlockCandidateItem(21, 1, 7, 8, 'd', 100, false, 2),
    buildBlockCandidateItem(30, 2, 9, 10, 'stranded', 100, true, 3),
  ];
  const blockPolicies = [{
    sourceLevel: 1,
    totalBlockCount: 10,
    totalTokens: 6000,
    forcedKeepNewestCount: 6,
    candidateBlockCount: 4,
    requestedMinBlocks: 2,
    feasibleMaxBlocks: 4,
    effectiveMinBlocks: 3,
  }, {
    sourceLevel: 2,
    totalBlockCount: 5,
    totalTokens: 6000,
    forcedKeepNewestCount: 4,
    candidateBlockCount: 1,
    requestedMinBlocks: 1,
    feasibleMaxBlocks: 0,
    effectiveMinBlocks: 0,
    skippedReason: 'no legal contiguous multi-block candidate segment is available',
  }];

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 10,
      sourceEnd: 11,
      summary: 'only two source blocks',
    }, {
      level: 3,
      sourceKind: 'block',
      sourceStart: 30,
      sourceEnd: 30,
      summary: 'single lift does not count',
    }],
  }, candidates, { blockPolicies }), /requires.*3 candidate block\(s\).*compacts only 2/i);

  const valid = validateCompactPlanArgs({
    replaceAsBlocks: [
      { level: 2, sourceKind: 'block', sourceStart: 10, sourceEnd: 11, summary: 'first segment' },
      { level: 2, sourceKind: 'block', sourceStart: 20, sourceEnd: 21, summary: 'second segment' },
    ],
  }, candidates, { blockPolicies });
  assert.equal(valid.createBlocks.length, 2);
});

test('buildCompactPromptText renders block candidates by legal history-contiguous segments', () => {
  const prompt = buildCompactPromptText({
    forcedKeptCount: 0,
    candidateItems: [
      buildBlockCandidateItem(10, 1, 1, 5, 'first L1 block'),
      buildBlockCandidateItem(11, 1, 6, 10, 'second L1 block'),
      buildBlockCandidateItem(13, 1, 11, 15, 'gap after missing B#12'),
      buildBlockCandidateItem(14, 2, 16, 20, 'different source level'),
      buildBlockCandidateItem(15, 1, 21, 25, 'back to L1 but new segment'),
      buildBlockCandidateItem(16, 1, 26, 30, 'next L1 block'),
      buildBlockCandidateItem(17, 2, 31, 35, 'stranded single L2 block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, true),
    ],
  });

  assert.match(prompt, /Segment 1: history-contiguous L1 block candidates -> L2 block\(s\).*B#10\.\.B#13/s);
  assert.match(prompt, /Block ids inside a segment may skip numbers/i);
  assert.match(prompt, /Segment 2: history-contiguous L2 block candidates -> L3 block\(s\).*B#14/s);
  assert.match(prompt, /Segment 3: history-contiguous L1 block candidates -> L2 block\(s\).*B#15\.\.B#16/s);
  assert.match(prompt, /Segment 4: history-contiguous L2 block candidates -> L3 block\(s\).*B#17/s);
  assert.match(prompt, /This segment has only one block, so normally leave it uncompressed/i);
  assert.match(prompt, /stranded single-block segment.*sourceStart=sourceEnd=17/i);
  assert.match(prompt, /must stay inside one listed segment/i);
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

test('selectCompactCandidateTargetLevels removes levels at or below 2k tokens and block-only levels with fewer than two blocks', () => {
  const candidates = [
    buildMessageCandidateItem(1, 1, 'small message a', COMPACT_LEVEL_TOKEN_THRESHOLD),
    buildMessageCandidateItem(2, 2, 'small message b', 0),
    buildBlockCandidateItem(10, 1, 3, 4, 'large but single block level', COMPACT_LEVEL_TOKEN_THRESHOLD + 500),
    buildBlockCandidateItem(20, 2, 5, 6, 'first eligible block', 1200),
    buildBlockCandidateItem(21, 2, 7, 8, 'second eligible block', 1001),
  ];

  const allowedLevels = selectCompactCandidateTargetLevels(candidates);
  assert.deepStrictEqual([...allowedLevels].sort((a, b) => a - b), [3]);
});

test('selectCompactCandidateTargetLevels allows a stranded single block in a 3,3,2,3,3 pattern', () => {
  const candidates = [
    buildBlockCandidateItem(1, 3, 1, 10, 'left higher block a', 200),
    buildBlockCandidateItem(2, 3, 11, 20, 'left higher block b', 200),
    buildBlockCandidateItem(3, 2, 21, 30, 'middle stranded block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, true),
    buildBlockCandidateItem(4, 3, 31, 40, 'right higher block a', 200),
    buildBlockCandidateItem(5, 3, 41, 50, 'right higher block b', 200),
  ];

  const allowedLevels = selectCompactCandidateTargetLevels(candidates);
  assert.deepStrictEqual([...allowedLevels].sort((a, b) => a - b), [3]);
});

test('selectCompactCandidateTargetLevels does not let an unsupported single block escape just because it is alone in its target level', () => {
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
  assert.deepStrictEqual(COMPACT_PLAN_TOOL_DEFINITION.parameters.required, ['replaceAsBlocks']);
  assert.equal(COMPACT_PLAN_TOOL_DEFINITION.parameters.properties.createBlocksJson, undefined);
  assert.equal(COMPACT_PLAN_TOOL_DEFINITION.parameters.properties.createBlocks, undefined);
  const replacementSchema = COMPACT_PLAN_TOOL_DEFINITION.parameters.properties.replaceAsBlocks;
  assert.equal(replacementSchema.oneOf.length, 2);
  assert.equal(replacementSchema.oneOf[0].type, 'array');
  assert.equal(replacementSchema.oneOf[1].type, 'string');
  const blockSchema = replacementSchema.oneOf[0].items;
  assert.deepStrictEqual(blockSchema.required, ['level', 'sourceKind', 'sourceStart', 'sourceEnd', 'summary']);
  assert.deepStrictEqual(blockSchema.properties.sourceKind.enum, ['message', 'block']);
  const factSchema = blockSchema.properties.memoryFacts.items;
  assert.deepStrictEqual(factSchema.required, ['kind', 'text']);
  assert.deepStrictEqual(factSchema.properties.kind.enum, ['decision', 'preference', 'fact', 'convention', 'environment']);
  assert.deepStrictEqual(factSchema.properties.attributedTo.enum, ['user', 'assistant', 'both']);
  assert.equal(factSchema.properties.attributed_to, undefined);
  assert.ok(COMPACT_PLAN_TOOL_DEFINITION.parameters.properties.preserveMessages);
  assert.ok(COMPACT_PLAN_TOOL_DEFINITION.parameters.properties.removePreservedMessages);
});

test('buildCompactPlanValidationFeedback does not suggest memory or archive helpers during compaction', () => {
  const feedback = buildCompactPlanValidationFeedback(new CompactPlanValidationError({
    createBlockErrors: ['bad compact range'],
  }));

  assert.doesNotMatch(feedback, /read_memory|write_memory|edit_memory|delete_memory|apply_patch_memory/);
  assert.match(feedback, /replaceAsBlocks entry's memoryFacts/);
  assert.doesNotMatch(feedback, /memoryFactsJson/);
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
    replaceAsBlocks: [
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
    ],
  }, candidates);

  assert.equal(plan.createBlocks.length, 2);
  assert.equal(plan.createBlocks[0].level, 1);
  assert.equal(plan.createBlocks[1].level, 2);
});

test('validateCompactPlanArgs associates durable memory facts with their exact blocks and deduplicates siblings', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [
      {
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'summary for first two messages',
        memoryFacts: [
          { kind: 'decision', text: 'The project should index compacted durable facts for future semantic recall.', context: 'User requested a block-associated compact memory pipeline.', attributedTo: 'user' },
          { kind: 'unsupported', text: 'ignored unsupported kind' },
        ],
      },
      {
        level: 1, sourceKind: 'message', sourceStart: 3, sourceEnd: 4, summary: 'summary for next two messages',
        memoryFacts: [{ kind: 'decision', text: 'The project should index compacted durable facts for future semantic recall.' }],
      },
    ],
  }, messageCandidates);

  assert.deepStrictEqual(plan.createBlocks[0].memoryFacts, [{
    kind: 'decision', text: 'The project should index compacted durable facts for future semantic recall.',
    context: 'User requested a block-associated compact memory pipeline.', attributedTo: 'user',
  }]);
  assert.equal(plan.createBlocks[1].memoryFacts, undefined, 'duplicate sibling facts should not multiply plan limits or rows');
});

test('validateCompactPlanArgs accepts JSON-string replacement blocks with nested memory facts', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'JSON-string fallback summary',
      memoryFacts: [{
        kind: 'environment',
        text: 'The compact planner accepts a JSON-string fallback for replacement blocks.',
        context: 'Compatibility contract for submit_compact_plan.',
        attributedTo: 'both',
      }],
    }]),
  }, messageCandidates);

  assert.deepStrictEqual(plan.createBlocks[0].memoryFacts, [{
    kind: 'environment',
    text: 'The compact planner accepts a JSON-string fallback for replacement blocks.',
    context: 'Compatibility contract for submit_compact_plan.',
    attributedTo: 'both',
  }]);
});

test('compact prompt lists preserved raw messages separately with removePreservedMessages guidance', () => {
  const prompt = buildCompactPromptText({
    forcedKeptCount: 0,
    candidateItems: [buildMessageCandidateItem(1, 1, 'ordinary compact candidate')],
    preservedMessages: [{
      seq: 42,
      key: 'M#42',
      preservedFromBlockId: 7,
      preview: 'Exact original task instruction to keep active.',
    }],
  });

  assert.match(prompt, /Previously preserved raw messages already covered by summary blocks/);
  assert.match(prompt, /M#42 preserved from B#7/);
  assert.match(prompt, /removePreservedMessages: number\[\]/);
  assert.match(prompt, /active history only/i);
});

test('validateCompactPlanArgs accepts preserveMessages covered by a created message block', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 3,
      summary: 'summary around a preserved original instruction',
    }],
    preserveMessages: [2],
  }, messageCandidates);

  assert.deepStrictEqual(plan.preserveMessages, [2]);
});

test('validateCompactPlanArgs rejects preserveMessages not covered by created message blocks', () => {
  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'summary for first two messages',
    }],
    preserveMessages: [3],
  }, messageCandidates), /not covered by any created message-source block/i);
});

test('validateCompactPlanArgs rejects preserving part of an atomic tool exchange candidate', () => {
  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 11,
      summary: 'summary for atomic tool exchange',
    }],
    preserveMessages: [11],
  }, [buildMessageCandidateItem(10, 11, 'tool call and response')]), /inside atomic candidate M#10-#11/i);
});

test('validateCompactPlanArgs accepts removePreservedMessages only for listed preserved messages', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [],
    removePreservedMessages: [42],
  }, [], {
    removablePreservedMessages: [{ seq: 42, key: 'M#42', preservedFromBlockId: 7, preview: 'old exact wording' }],
  });

  assert.deepStrictEqual(plan.createBlocks, []);
  assert.deepStrictEqual(plan.removePreservedMessages, [42]);

  const stringPlan = validateCompactPlanArgs({
    replaceAsBlocks: '[]',
    removePreservedMessages: [42],
  }, [], {
    removablePreservedMessages: [{ seq: 42, key: 'M#42', preservedFromBlockId: 7, preview: 'old exact wording' }],
  });
  assert.deepStrictEqual(stringPlan.createBlocks, []);
  assert.deepStrictEqual(stringPlan.removePreservedMessages, [42]);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [],
    removePreservedMessages: [43],
  }, [], {
    removablePreservedMessages: [{ seq: 42, key: 'M#42', preservedFromBlockId: 7, preview: 'old exact wording' }],
  }), /not listed as a previously preserved raw message/i);
});

test('validateCompactPlanArgs rejects preserve/remove overlap', () => {
  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'summary',
    }],
    preserveMessages: [2],
    removePreservedMessages: [2],
  }, messageCandidates, {
    removablePreservedMessages: [{ seq: 2, key: 'M#2', preservedFromBlockId: 7, preview: 'old exact wording' }],
  }), /cannot appear in both preserveMessages and removePreservedMessages/i);
});

test('validateCompactPlanArgs ignores string-encoded block memory facts without invalidating the compact plan', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'summary for first two messages',
      memoryFacts: JSON.stringify([{ kind: 'decision', text: 'unsupported string-encoded fact array' }]),
    }],
    memoryFactsJson: JSON.stringify([{ kind: 'decision', text: 'obsolete top-level facts are ignored' }]),
  }, messageCandidates);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].memoryFacts, undefined);
});

test('validateCompactPlanArgs accepts history-contiguous block ranges with non-consecutive ids', () => {
  const candidates = [
    buildBlockCandidateItem(10, 1, 5, 8, 'prior L1 block'),
    buildBlockCandidateItem(13, 1, 9, 12, 'next adjacent L1 block despite id gap'),
    buildBlockCandidateItem(20, 2, 13, 16, 'different source level stops range'),
  ];

  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 10,
      sourceEnd: 13,
      summary: 'summary for adjacent L1 blocks with non-consecutive ids',
    }],
  }, candidates);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].sourceStart, 10);
  assert.equal(plan.createBlocks[0].sourceEnd, 13);
  assert.deepStrictEqual(plan.createBlocks[0].candidateRange, [0, 1]);
});

test('validateCompactPlanArgs accepts history-contiguous block ranges whose endpoint ids decrease', () => {
  const candidates = [
    buildBlockCandidateItem(20, 1, 5, 8, 'newer-created block covering earlier context'),
    buildBlockCandidateItem(13, 1, 9, 12, 'older-created adjacent block covering later context'),
  ];

  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 20,
      sourceEnd: 13,
      summary: 'summary for adjacent L1 blocks in history order despite decreasing ids',
    }],
  }, candidates);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].sourceStart, 20);
  assert.equal(plan.createBlocks[0].sourceEnd, 13);
  assert.deepStrictEqual(plan.createBlocks[0].candidateRange, [0, 1]);
});

test('validateCompactPlanArgs rejects ranges across an ignored lifecycle hard barrier', () => {
  const sparseMessageCandidates = [
    buildMessageCandidateItem(1, 1, 'first real message', 10, 1),
    buildMessageCandidateItem(3, 3, 'second real message after ignored lifecycle seq #2', 10, 2),
    buildMessageCandidateItem(4, 4, 'third real message', 10, 2),
  ];

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 4,
      summary: 'invalid summary across the protected lifecycle boundary',
    }],
  }, sparseMessageCandidates), /continuous message range/i);
});

test('validateCompactPlanArgs can span message candidates across a display-only gap', () => {
  const candidates = [
    buildMessageCandidateItem(1, 1, 'visible before display-only notice'),
    buildMessageCandidateItem(3, 3, 'visible after display-only notice'),
    buildMessageCandidateItem(4, 4, 'another visible message after the notice'),
  ];

  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 4,
      summary: 'summary across model-visible messages while dropping display-only seq #2',
    }],
  }, candidates);

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
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 11,
      summary: 'summarize atomic tool exchange',
    }],
  }, groupedCandidates);

  assert.equal(okPlan.createBlocks.length, 1);
  assert.deepStrictEqual(okPlan.createBlocks[0].candidateRange, [0, 0]);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 10,
      sourceEnd: 10,
      summary: 'invalid partial tool exchange',
    }],
  }, groupedCandidates), /continuous message range/i);
});

test('validateCompactPlanArgs rejects a single-block source but still allows a single-message source', () => {
  const blockCandidates = [
    buildBlockCandidateItem(10, 1, 5, 8, 'prior block'),
    buildBlockCandidateItem(11, 1, 9, 12, 'next prior block'),
  ];

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 2,
      sourceKind: 'block',
      sourceStart: 10,
      sourceEnd: 10,
      summary: 'invalid single block summary',
    }],
  }, blockCandidates), /single block source|higher-level blocks/i);

  const singleMessagePlan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 1,
      summary: 'single large message summary',
    }],
  }, [buildMessageCandidateItem(1, 1, 'large single message')]);

  assert.equal(singleMessagePlan.createBlocks.length, 1);
  assert.equal(singleMessagePlan.createBlocks[0].sourceStart, 1);
  assert.equal(singleMessagePlan.createBlocks[0].sourceEnd, 1);
});

test('validateCompactPlanArgs allows a stranded single block source when the candidate explicitly permits it', () => {
  const plan = validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 3,
      sourceKind: 'block',
      sourceStart: 30,
      sourceEnd: 30,
      summary: 'lift the stranded middle block upward',
    }],
  }, [
    buildBlockCandidateItem(30, 2, 21, 30, 'middle stranded block', COMPACT_LEVEL_TOKEN_THRESHOLD + 1, true),
  ]);

  assert.equal(plan.createBlocks.length, 1);
  assert.equal(plan.createBlocks[0].sourceStart, 30);
  assert.equal(plan.createBlocks[0].sourceEnd, 30);
  assert.deepStrictEqual(plan.createBlocks[0].candidateRange, [0, 0]);
});

test('validateCompactPlanArgs rejects non-continuous or overlapping ranges', () => {
  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 5,
      summary: 'invalid range',
    }],
  }, messageCandidates), /continuous message range/i);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [
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
    ],
  }, messageCandidates), /overlaps another replaceAsBlocks range/i);
});

test('validateCompactPlanArgs rejects missing and obsolete top-level block arguments', () => {
  assert.throws(() => validateCompactPlanArgs({}, messageCandidates), /replaceAsBlocks is required/i);

  assert.throws(() => validateCompactPlanArgs({
    createBlocksJson: JSON.stringify([{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'obsolete compatibility',
    }]),
  }, messageCandidates), /createBlocksJson is obsolete/i);

  assert.throws(() => validateCompactPlanArgs({
    createBlocks: [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      summary: 'legacy compatibility',
    }],
  }, messageCandidates), /createBlocks is obsolete/i);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [],
    createBlocksJson: '[]',
    removePreservedMessages: [42],
  }, [], {
    removablePreservedMessages: [{ seq: 42, key: 'M#42', preservedFromBlockId: 7, preview: 'old exact wording' }],
  }), /createBlocksJson is obsolete/i);
});

test('validateCompactPlanArgs rejects malformed replacement-block encodings and non-array types', () => {
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: '' }, messageCandidates), /JSON string must be non-empty/i);
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: '[{' }, messageCandidates), /must be valid JSON/i);
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: '{"level":1}' }, messageCandidates), /must decode to an array/i);
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: { level: 1 } }, messageCandidates), /direct array or a JSON string/i);
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: [] }, messageCandidates), /must contain at least one block/i);
  assert.throws(() => validateCompactPlanArgs({ replaceAsBlocks: '[]' }, messageCandidates), /must contain at least one block/i);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: [{
      level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'valid block',
    }],
    preserveMessages: '[2]',
  }, messageCandidates), /preserveMessages must be an array/i);

  assert.throws(() => validateCompactPlanArgs({
    replaceAsBlocks: '[]',
    removePreservedMessages: '[42]',
  }, [], {
    removablePreservedMessages: [{ seq: 42, key: 'M#42', preservedFromBlockId: 7, preview: 'old exact wording' }],
  }), /removePreservedMessages must be an array/i);
});

test('buildCompactPlanValidationFeedback explains invalid layered compact plans', () => {
  const error = new CompactPlanValidationError({
    createBlockErrors: ['replaceAsBlocks[0].summary must be a non-empty string.'],
  });

  const feedback = buildCompactPlanValidationFeedback(error);
  assert.match(feedback, /COMPACT PLAN INVALID/);
  assert.match(feedback, /summary must be a non-empty string/);
  assert.match(feedback, /Use only ranges shown in one Segment header/);
  assert.match(feedback, /Fix only the layered-context plan/);
});
