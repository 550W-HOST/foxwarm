import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import * as vector from '../vector';
import * as archiveLexicalRecall from './archiveLexicalRecall';
import type { Session } from '../types';
import { containsLoneSurrogate } from '../utils/unicode';
import { selectVectorRawMessageWindow, tool_recall } from './archiveRecall';

function createSession(): Session {
  return {
    id: 'vector-quality-owner',
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function messageRecord(seq: number, text: string) {
  return {
    sessionId: 'source-session',
    agent: 'main',
    seq,
    timestamp: 1000 + seq,
    role: 'user',
    message: { role: 'user', parts: [{ text }], __meta: { seq, timestamp: 1000 + seq } },
  } as any;
}

function roleRecord(seq: number, role: 'user' | 'model' | 'tool', parts: any[]) {
  return {
    sessionId: 'source-session', agent: 'main', seq, timestamp: 1000 + seq, role,
    message: { role, parts, __meta: { seq, timestamp: 1000 + seq } },
  } as any;
}

test('raw vector windows localize query/chunk matches near the end and support bilingual identifiers', () => {
  const records = Array.from({ length: 12 }, (_, index) => messageRecord(index + 1, `ordinary context ${index + 1}`));
  records[9] = messageRecord(10, '最终答案使用 AlphaNode_42 处理中文路由。');
  const selected = selectVectorRawMessageWindow(records, 'Where is AlphaNode_42 的中文路由答案?', '[model] 最终答案使用 AlphaNode_42 处理中文路由。');
  assert.ok(selected.records.some(record => record.seq === 10));
  assert.ok(selected.selectedStartSeq >= 4, 'a late match should not render from the beginning of the full range');
  assert.ok(selected.records.length <= 7);
  assert.equal(selected.omittedMessageCount, 12 - selected.records.length);
});

test('raw vector windows keep valid adjacent tool exchanges complete and avoid tool-only noise ties', () => {
  const records = [
    messageRecord(1, 'setup'),
    roleRecord(2, 'model', [{ functionCall: { id: 'call-1', name: 'lookup', args: { key: 'AlphaNode_42' } } }]),
    roleRecord(3, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'call-1', response: { output: 'tool result' } } }]),
    ...Array.from({ length: 6 }, (_, index) => messageRecord(index + 4, `ordinary bridge ${index + 4}`)),
    messageRecord(10, 'The substantive AlphaNode_42 answer is here.'),
    messageRecord(11, 'tail 11'),
    messageRecord(12, 'tail 12'),
  ];
  const substantive = selectVectorRawMessageWindow(records, 'AlphaNode_42', undefined);
  assert.ok(substantive.records.some(record => record.seq === 10), 'substantive model/user content wins an otherwise equal lexical tie');
  assert.ok(!substantive.records.some(record => record.seq === 2), 'tool-only lexical noise should not anchor the bounded window');

  const toolLocated = selectVectorRawMessageWindow(records, 'tool result', '[tool] tool result');
  assert.ok(toolLocated.records.some(record => record.seq === 2));
  assert.ok(toolLocated.records.some(record => record.seq === 3));
});

test('malformed calls and orphan tool rows remain local barriers', () => {
  const orphan = roleRecord(2, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'missing-call', response: { output: 'ORPHAN_TOKEN' } } }]);
  const malformedCall = roleRecord(4, 'model', [{ functionCall: { id: 'call-missing', name: 'lookup', args: { key: 'MALFORMED_TOKEN' } } }]);
  const records = [messageRecord(1, 'before'), orphan, messageRecord(3, 'middle'), malformedCall, messageRecord(5, 'after')];
  assert.deepEqual(selectVectorRawMessageWindow(records, 'ORPHAN_TOKEN', '[tool] ORPHAN_TOKEN').records.map(record => record.seq), [2]);
  assert.deepEqual(selectVectorRawMessageWindow(records, 'MALFORMED_TOKEN', '[model] MALFORMED_TOKEN').records.map(record => record.seq), [4]);
});

test('duplicate tool call/response identities invalidate adjacent exchanges', () => {
  const duplicateCalls = [
    roleRecord(1, 'model', [
      { functionCall: { id: 'dup-call', name: 'lookup', args: { key: 'DUPCALL' } } },
      { functionCall: { id: 'dup-call', name: 'lookup', args: { key: 'DUPCALL' } } },
    ]),
    roleRecord(2, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'dup-call', response: { output: 'result' } } }]),
  ];
  assert.deepEqual(selectVectorRawMessageWindow(duplicateCalls, 'DUPCALL', undefined).records.map(record => record.seq), [1]);

  const duplicateWithinRow = [
    roleRecord(1, 'model', [
      { functionCall: { id: 'call-a', name: 'lookup', args: { key: 'DUPRESP' } } },
      { functionCall: { id: 'call-b', name: 'lookup', args: { key: 'DUPRESP' } } },
    ]),
    roleRecord(2, 'tool', [
      { functionResponse: { name: 'lookup', tool_use_id: 'call-a', response: { output: 'a1' } } },
      { functionResponse: { name: 'lookup', tool_use_id: 'call-a', response: { output: 'a2' } } },
    ]),
    roleRecord(3, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'call-b', response: { output: 'b' } } }]),
  ];
  assert.deepEqual(selectVectorRawMessageWindow(duplicateWithinRow, 'DUPRESP', undefined).records.map(record => record.seq), [1]);

  const duplicateAcrossRows = [
    roleRecord(1, 'model', [{ functionCall: { id: 'call-a', name: 'lookup', args: { key: 'value' } } }]),
    roleRecord(2, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'call-a', response: { output: 'DUPACROSS' } } }]),
    roleRecord(3, 'tool', [{ functionResponse: { name: 'lookup', tool_use_id: 'call-a', response: { output: 'DUPACROSS' } } }]),
  ];
  assert.deepEqual(selectVectorRawMessageWindow(duplicateAcrossRows, 'DUPACROSS', undefined).records.map(record => record.seq), [2]);
});

test('raw vector fallback is deterministic and bounded when no locator is meaningful', () => {
  const records = Array.from({ length: 30 }, (_, index) => messageRecord(index + 1, `unrelated archived message ${index + 1}`));
  const selected = selectVectorRawMessageWindow(records, 'missing query phrase', undefined);
  assert.equal(selected.selectedEndSeq, 30);
  assert.ok(selected.records.length <= 7);
  assert.equal(selected.omittedMessageCount, 30 - selected.records.length);
});

async function withRecallStubs<T>(options: {
  hits: any[];
  blocks?: (args: any) => any;
  messages?: (args: any) => any;
  status?: (sessionId: string) => any;
  session?: Session;
  lexical?: (sessionId: string, query: string, limit: number) => any;
  dense?: () => any;
  detailedLexical?: any;
}, run: (ctx: any) => Promise<T>): Promise<T> {
  const session = options.session || createSession();
  const originals = {
    searchDetailed: vector.searchDetailed,
    status: vector.getArchiveIndexStatus,
    blocks: sessionManager.getArchivedBlocks,
    messages: sessionManager.getArchivedMessages,
    isolated: sessionManager.isSessionEffectivelyIsolated,
    lexical: archiveLexicalRecall.searchArchiveLexicalSideChannel,
  };
  (vector as any).searchDetailed = async () => ({
    hits: options.dense ? await options.dense() : options.hits,
    lexical: options.detailedLexical || { configured: false, ready: false, used: false, coverageComplete: false, backfilling: false },
  });
  (vector as any).getArchiveIndexStatus = async (sessionId: string) => options.status?.(sessionId) || ({
    lastIndexedSeq: 0, tailStartSeq: 0, lastIndexedBlockId: 0,
    latestLocalMessageSeq: 0, latestLocalBlockId: 0, pendingMessageCount: 0, pendingBlockCount: 0,
  });
  (sessionManager as any).getArchivedBlocks = async (_sessionId: string, args: any) => options.blocks?.(args)
    || ({ records: [], totalMatched: 0, returnedCount: 0, requestedRange: args });
  (sessionManager as any).getArchivedMessages = async (_sessionId: string, args: any) => options.messages?.(args)
    || ({ records: [], totalMatched: 0, returnedCount: 0, availableRange: {}, requestedRange: args });
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (archiveLexicalRecall as any).searchArchiveLexicalSideChannel = async (sessionId: string, query: string, limit: number) => options.lexical?.(sessionId, query, limit) || [];
  try {
    return await run({ sessionId: session.id, session, persistCurrentSession: async () => {} } as any);
  } finally {
    (vector as any).searchDetailed = originals.searchDetailed;
    (vector as any).getArchiveIndexStatus = originals.status;
    (sessionManager as any).getArchivedBlocks = originals.blocks;
    (sessionManager as any).getArchivedMessages = originals.messages;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
    (archiveLexicalRecall as any).searchArchiveLexicalSideChannel = originals.lexical;
  }
}

test('modern fact source reloads its creating block and exposes matched fact wording', async () => {
  let messageReads = 0;
  const output = String(await withRecallStubs({
    hits: [{
      id: 'fact-hit', kind: 'fact', session_id: 'source-session', block_id: 7,
      raw_start_seq: 1, raw_end_seq: 2, source_family: 'source-session:block:7',
      matched_facts: [{ fact_kind: 'decision', attributed_to: 'user', text: 'Memory fact (decision)\nUse AlphaNode for 中文 routing.' }],
    }],
    blocks: () => ({
      records: [{
        v: 1, kind: 'block', sessionId: 'source-session', agent: 'main', id: 7, level: 1,
        sourceKind: 'message', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2,
        rawStartTimestamp: 1001, rawEndTimestamp: 1002, summary: 'authoritative creating block', createdAt: 1003,
      }],
    }),
    messages: () => { messageReads += 1; return { records: [] }; },
  }, ctx => tool_recall({ vector_query: 'AlphaNode', limit: 1, previewLength: 3000 }, ctx)));

  assert.match(output, /authoritative creating block/);
  assert.match(output, /matched memory fact: decision, attributed:user/);
  assert.match(output, /Use AlphaNode for 中文 routing/);
  assert.equal(messageReads, 0, 'modern block-backed facts must not fall through to raw source messages');
});

test('legacy null-block fact retains bounded raw source fallback', async () => {
  const output = String(await withRecallStubs({
    hits: [{
      id: 'legacy-fact', kind: 'fact', session_id: 'source-session',
      raw_start_seq: 4, raw_end_seq: 4, source_family: 'source-session:fact:legacy-fact',
      text: 'legacy fact location',
    }],
    messages: args => ({ records: [messageRecord(args.startSeq, 'legacy raw authority AlphaNode')], requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'AlphaNode', limit: 1, previewLength: 2000 }, ctx)));
  assert.match(output, /legacy raw authority AlphaNode/);
  assert.doesNotMatch(output, /legacy fact location/);
});

test('vector recall filters source groups before enforcing the final unique-source limit', async () => {
  const texts: Record<number, string> = {
    1: 'Alpha keep first',
    2: '中文 keep second',
    3: 'Alpha keep third',
    4: 'Alpha keep drop fourth',
  };
  const hits = [1, 2, 3, 4].map(seq => ({
    id: `raw-${seq}`, kind: 'raw', session_id: 'source-session', start_seq: seq, end_seq: seq,
    raw_start_seq: seq, raw_end_seq: seq, source_family: `source-session:raw:${seq}-${seq}`,
  }));
  const output = String(await withRecallStubs({
    hits,
    messages: args => ({ records: [messageRecord(args.startSeq, texts[args.startSeq])], requestedRange: args }),
  }, ctx => tool_recall({
    vector_query: 'keep', limit: 2, contentFilter: 'keep', includeRegex: 'Alpha|中文', excludeRegex: 'drop', previewLength: 4000,
  }, ctx)));

    assert.match(output, /showing 2 unique source group\(s\) of 3 matched from 4 ranked source group\(s\)/);
  assert.match(output, /Alpha keep first/);
  assert.match(output, /中文 keep second/);
  assert.doesNotMatch(output, /Alpha keep third/);
  assert.doesNotMatch(output, /drop fourth/);
  assert.match(output, /1 additional matched item\(s\) omitted by the requested result limit/);
});

test('exact-session lexical side-channel rescues dense misses and retains filters, limits, and budgets', async () => {
  let lexicalCalls = 0;
  const output = String(await withRecallStubs({
    hits: [],
    lexical: (sessionId, query) => {
      lexicalCalls += 1;
      assert.equal(sessionId, 'vector-quality-owner');
      assert.equal(query, 'AlphaNode_42');
      return [
        { id: 'lex-1', kind: 'raw', session_id: 'source-session', start_seq: 1, end_seq: 1, raw_start_seq: 1, raw_end_seq: 1, source_family: 'source-session:raw:1-1', lexical_score: 500, lexical_locators: ['AlphaNode_42'] },
        { id: 'lex-2', kind: 'raw', session_id: 'source-session', start_seq: 2, end_seq: 2, raw_start_seq: 2, raw_end_seq: 2, source_family: 'source-session:raw:2-2', lexical_score: 450, lexical_locators: ['AlphaNode_42'] },
      ];
    },
    messages: args => ({ records: [messageRecord(args.startSeq, args.startSeq === 1 ? 'AlphaNode_42 keep authority' : 'AlphaNode_42 drop noise')], requestedRange: args }),
  }, ctx => tool_recall({
    vector_query: 'AlphaNode_42', scope: 'current-session', contentFilter: 'keep', limit: 1, previewLength: 1000,
  }, ctx)));
  assert.equal(lexicalCalls, 1);
  assert.match(output, /AlphaNode_42 keep authority/);
  assert.doesNotMatch(output, /drop noise/);
  assert.ok(output.length <= 1000);
});

test('broad semantic scope skips Archive lexical scan and lexical failure preserves dense results', async () => {
  let broadCalls = 0;
  await withRecallStubs({
    hits: [],
    lexical: () => { broadCalls += 1; return []; },
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-agent', limit: 1 }, ctx));
  assert.equal(broadCalls, 0);

  const output = String(await withRecallStubs({
    hits: [{
      id: 'dense', kind: 'raw', session_id: 'source-session', start_seq: 3, end_seq: 3,
      raw_start_seq: 3, raw_end_seq: 3, source_family: 'source-session:raw:3-3', chunk_text: 'dense authority',
    }],
    lexical: () => { throw new Error('Archive lexical unavailable'); },
    messages: args => ({ records: [messageRecord(args.startSeq, 'dense authority survives')], requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-session', limit: 1 }, ctx)));
  assert.match(output, /dense authority survives/);

  let disabledLexicalCalls = 0;
  await assert.rejects(() => withRecallStubs({
    hits: [],
    dense: () => { throw Object.assign(new Error('Vector is disabled'), { code: 'VECTOR_DISABLED' }); },
    lexical: () => { disabledLexicalCalls += 1; return []; },
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-session', limit: 1 }, ctx)), /Vector is disabled/);
  assert.equal(disabledLexicalCalls, 0, 'disabled Vector must not become lexical-only recall');
});

test('persistent hybrid coverage suppresses or selects the bounded Phase2A bootstrap fallback by scope', async () => {
  const hit = {
    id: 'hybrid', kind: 'raw', session_id: 'source-session', start_seq: 1, end_seq: 1,
    raw_start_seq: 1, raw_end_seq: 1, source_family: 'source-session:raw:1-1', lexical_lane: 'identifier',
  };
  let fallbackCalls = 0;
  const complete = String(await withRecallStubs({
    hits: [hit],
    detailedLexical: { configured: true, ready: true, used: true, coverageComplete: true, backfilling: false },
    lexical: () => { fallbackCalls += 1; return []; },
    messages: args => ({ records: [messageRecord(1, 'persistent hybrid authority')], requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-session', limit: 1 }, ctx)));
  assert.equal(fallbackCalls, 0);
  assert.match(complete, /Recall hybrid search/);
  assert.match(complete, /persistent hybrid authority/);

  const unstableRescue = String(await withRecallStubs({
    hits: [],
    detailedLexical: { configured: true, ready: true, used: false, coverageComplete: false, backfilling: false },
    lexical: () => {
      fallbackCalls += 1;
      return [{
        id: 'bootstrap-rescue', kind: 'raw', session_id: 'source-session', agent: 'main',
        source_family: 'source-session:raw:2-2', lexical_score: 100, lexical_locators: ['AlphaNode_42'],
        start_seq: 2, end_seq: 2, raw_start_seq: 2, raw_end_seq: 2,
      }];
    },
    messages: args => ({ records: [messageRecord(2, 'Phase2A rescues authority appended during FTS')], requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-session', limit: 1 }, ctx)));
  assert.match(unstableRescue, /Phase2A rescues authority appended during FTS/);

  for (const detailedLexical of [
    { configured: true, ready: true, used: false, coverageComplete: false, backfilling: true },
    { configured: true, ready: false, used: false, coverageComplete: false, backfilling: false, errorCode: 'ARCHIVE_SEARCH_REBUILD_REQUIRED' },
  ]) {
    await withRecallStubs({
      hits: [], detailedLexical,
      lexical: () => { fallbackCalls += 1; return []; },
    }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-session', limit: 1 }, ctx));
  }
  assert.equal(fallbackCalls, 3, 'unstable, incomplete, and unavailable exact scopes use bounded bootstrap fallback');

  await withRecallStubs({
    hits: [],
    detailedLexical: { configured: true, ready: true, used: false, coverageComplete: false, backfilling: true },
    lexical: () => { fallbackCalls += 1; return []; },
  }, ctx => tool_recall({ vector_query: 'AlphaNode_42', scope: 'current-agent', limit: 1 }, ctx));
  assert.equal(fallbackCalls, 3, 'current-agent partial coverage never scans Archive through Phase2A');
});

test('vector recall labels full and selected raw windows while preview budget remains bounded', async () => {
  const records = Array.from({ length: 15 }, (_, index) => messageRecord(index + 1,
    index === 13 ? 'Late AnswerIdentifier_77 is the authoritative answer.' : `early filler ${index + 1}`));
  const output = String(await withRecallStubs({
    hits: [{
      id: 'long-raw', kind: 'raw', session_id: 'source-session', start_seq: 1, end_seq: 15,
      raw_start_seq: 1, raw_end_seq: 15, source_family: 'source-session:raw:1-15',
      chunk_text: '[user] Late AnswerIdentifier_77 is the authoritative answer.',
    }],
    messages: args => ({ records, requestedRange: args }),
  }, ctx => tool_recall({
    vector_query: 'AnswerIdentifier_77', limit: 1, contentFilter: 'authoritative', previewLength: 900,
  }, ctx)));

  assert.match(output, /full hit msg#1-15; selected msg#9-15; omitted 8 message\(s\)/);
  assert.match(output, /Late AnswerIdentifier_77 is the authoritative answer/);
  assert.doesNotMatch(output, /early filler 1\b/);
  assert.ok(output.length <= 1300, 'shared preview budget should remain the final output bound apart from headings/notices');
});

test('positive filters localize raw windows and report distant omitted requirements', async () => {
  const records = Array.from({ length: 25 }, (_, index) => messageRecord(index + 1,
    index === 1 ? 'literal-filter-anchor' : index === 24 ? 'RegexNeedle_99' : index === 19 ? 'vector-query-anchor' : `filler ${index + 1}`));
  const hit = {
    id: 'filtered-raw', kind: 'raw', session_id: 'source-session', start_seq: 1, end_seq: 25,
    raw_start_seq: 1, raw_end_seq: 25, source_family: 'source-session:raw:1-25', chunk_text: '[user] vector-query-anchor',
  };

  const literalOutput = String(await withRecallStubs({
    hits: [hit], messages: args => ({ records, requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'vector-query-anchor', contentFilter: 'literal-filter-anchor', limit: 1, previewLength: 3000 }, ctx)));
  assert.match(literalOutput, /literal-filter-anchor/);
  assert.match(literalOutput, /selected msg#1-/);

  const regexOutput = String(await withRecallStubs({
    hits: [hit], messages: args => ({ records, requestedRange: args }),
  }, ctx => tool_recall({ vector_query: 'vector-query-anchor', includeRegex: 'RegexNeedle_\\d+', limit: 1, previewLength: 3000 }, ctx)));
  assert.match(regexOutput, /RegexNeedle_99/);

  const distantOutput = String(await withRecallStubs({
    hits: [hit], messages: args => ({ records, requestedRange: args }),
  }, ctx => tool_recall({
    vector_query: 'vector-query-anchor', contentFilter: 'literal-filter-anchor', includeRegex: 'RegexNeedle_\\d+',
    limit: 1, previewLength: 5000,
  }, ctx)));
  assert.match(distantOutput, /source filter match omitted from selected window/);
  assert.match(distantOutput, /includeRegex matched `msg#25`/);
  assert.match(distantOutput, /recall\(\{ target: "msg#25" \}\)/);

  const longRecords = [...records];
  longRecords[1] = messageRecord(2, `literal-filter-anchor ${'😀'.repeat(5000)}`);
  const minBudgetOutput = String(await withRecallStubs({
    hits: [hit], messages: args => ({ records: longRecords, requestedRange: args }),
  }, ctx => tool_recall({
    vector_query: `vector-query-anchor-${'🧭'.repeat(3000)}`,
    contentFilter: 'literal-filter-anchor', includeRegex: 'RegexNeedle_\\d+', limit: 1, previewLength: 1000,
  }, ctx)));
  assert.ok(minBudgetOutput.length <= 1000);
  assert.match(minBudgetOutput, /includeRegex matched `msg#25`/);
  assert.match(minBudgetOutput, /recall\(\{ target: "msg#25" \}\)/);
  assert.equal(containsLoneSurrogate(minBudgetOutput), false);
});

test('exact-session vector recall reports bounded lag without making status failures fatal', async () => {
  let statusCalls = 0;
  const pendingOutput = String(await withRecallStubs({
    hits: [],
    status: () => {
      statusCalls += 1;
      return {
        lastIndexedSeq: 4, tailStartSeq: 2, lastIndexedBlockId: 1,
        latestLocalMessageSeq: 6, latestLocalBlockId: 2, pendingMessageCount: 2, pendingBlockCount: 1,
        maxLatencyDeadline: Date.parse('2026-08-28T12:00:00.000Z'),
      };
    },
  }, ctx => tool_recall({ vector_query: 'lag', scope: 'current-session', limit: 1, previewLength: 1000 }, ctx)));
  assert.equal(statusCalls, 1);
  assert.match(pendingOutput, /\[vector lag\] 2 archived message\(s\) and 1 block\(s\)/);
  assert.match(pendingOutput, /2026-08-28T12:00:00.000Z/);
  assert.ok(pendingOutput.length <= 1000, 'lag notice must participate in the shared total preview budget');

  const longQueryOutput = String(await withRecallStubs({
    hits: [],
    status: () => ({
      lastIndexedSeq: 4, tailStartSeq: 2, lastIndexedBlockId: 1,
      latestLocalMessageSeq: 6, latestLocalBlockId: 1, pendingMessageCount: 2, pendingBlockCount: 0,
    }),
  }, ctx => tool_recall({ vector_query: `lag-${'😀'.repeat(5000)}`, scope: 'current-session', limit: 1, previewLength: 1000 }, ctx)));
  assert.ok(longQueryOutput.length <= 1000);
  assert.match(longQueryOutput, /\[vector lag\]/);
  assert.match(longQueryOutput, /No archived source messages or blocks found for this vector_query\./);
  assert.equal(containsLoneSurrogate(longQueryOutput), false);

  const successful = String(await withRecallStubs({
    hits: [],
    status: () => { throw new Error('diagnostic unavailable'); },
  }, ctx => tool_recall({ vector_query: 'lag', scope: 'current-session', limit: 1 }, ctx)));
  assert.match(successful, /No archived source messages or blocks found/);

  let broadStatusCalls = 0;
  await withRecallStubs({
    hits: [],
    status: () => { broadStatusCalls += 1; return {}; },
  }, ctx => tool_recall({ vector_query: 'lag', scope: 'current-agent', limit: 1 }, ctx));
  assert.equal(broadStatusCalls, 0, 'broad semantic scopes must not fan out archive status calls');
});

test('historical alias lag status uses the resolved canonical Session ID', async () => {
  const session = createSession();
  session.aliases = ['historical-owner'];
  let requestedStatusSessionId = '';
  const output = String(await withRecallStubs({
    session,
    hits: [],
    status: sessionId => {
      requestedStatusSessionId = sessionId;
      return {
        lastIndexedSeq: 5, tailStartSeq: 3, lastIndexedBlockId: 2,
        latestLocalMessageSeq: 5, latestLocalBlockId: 2, pendingMessageCount: 0, pendingBlockCount: 0,
        maxLatencyDeadline: Date.parse('2026-08-28T13:00:00.000Z'),
      };
    },
  }, ctx => tool_recall({ vector_query: 'alias', sessionId: 'historical-owner', limit: 1 }, ctx)));
  assert.equal(requestedStatusSessionId, session.id);
  assert.doesNotMatch(output, /\[vector lag\]/);
});
