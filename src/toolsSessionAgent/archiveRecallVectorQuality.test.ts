import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import * as vector from '../vector';
import type { Session } from '../types';
import { tool_recall } from './archiveRecall';

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

async function withRecallStubs<T>(options: {
  hits: any[];
  blocks?: (args: any) => any;
  messages?: (args: any) => any;
}, run: (ctx: any) => Promise<T>): Promise<T> {
  const session = createSession();
  const originals = {
    search: vector.search,
    blocks: sessionManager.getArchivedBlocks,
    messages: sessionManager.getArchivedMessages,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  (vector as any).search = async () => options.hits;
  (sessionManager as any).getArchivedBlocks = async (_sessionId: string, args: any) => options.blocks?.(args)
    || ({ records: [], totalMatched: 0, returnedCount: 0, requestedRange: args });
  (sessionManager as any).getArchivedMessages = async (_sessionId: string, args: any) => options.messages?.(args)
    || ({ records: [], totalMatched: 0, returnedCount: 0, availableRange: {}, requestedRange: args });
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  try {
    return await run({ sessionId: session.id, session, persistCurrentSession: async () => {} } as any);
  } finally {
    (vector as any).search = originals.search;
    (sessionManager as any).getArchivedBlocks = originals.blocks;
    (sessionManager as any).getArchivedMessages = originals.messages;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
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

  assert.match(output, /showing 2 unique source group\(s\) of 3 matched from 4 ranked vector source group\(s\)/);
  assert.match(output, /Alpha keep first/);
  assert.match(output, /中文 keep second/);
  assert.doesNotMatch(output, /Alpha keep third/);
  assert.doesNotMatch(output, /drop fourth/);
  assert.match(output, /1 additional matched item\(s\) omitted by the requested result limit/);
});
