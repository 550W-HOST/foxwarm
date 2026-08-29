import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../common';
import * as sessionManager from '../sessionManager';
import * as vector from '../vector';
import type { Session } from '../types';
import { tool_recall } from './archiveRecall';

function createSession(): Session {
  return {
    id: 'vector-fallback-owner',
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

async function exerciseFallback(
  hit: any,
  options: { throwFromLogger?: boolean } = {},
): Promise<{ output: string; warnings: any[][] }> {
  const session = createSession();
  const warnings: any[][] = [];
  const originals = {
    searchDetailed: vector.searchDetailed,
    blocks: sessionManager.getArchivedBlocks,
    messages: sessionManager.getArchivedMessages,
    isolated: sessionManager.isSessionEffectivelyIsolated,
    warn: logger.warn,
  };
  (vector as any).searchDetailed = async () => ({
    hits: [hit],
    lexical: { configured: false, ready: false, used: false, coverageComplete: false, backfilling: false },
  });
  (sessionManager as any).getArchivedBlocks = async () => ({ records: [] as any[], totalMatched: 0, returnedCount: 0, requestedRange: {} });
  (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[], totalMatched: 0, returnedCount: 0, availableRange: {}, requestedRange: {} });
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  logger.warn = ((...args: any[]) => {
    warnings.push(args);
    if (options.throwFromLogger) throw new Error('injected logger failure');
  }) as typeof logger.warn;
  try {
    const output = String(await tool_recall({
      vector_query: 'DO_NOT_LOG_QUERY',
      previewLength: 2000,
    }, {
      sessionId: session.id,
      session,
      persistCurrentSession: async () => {},
    } as any));
    return { output, warnings };
  } finally {
    (vector as any).searchDetailed = originals.searchDetailed;
    (sessionManager as any).getArchivedBlocks = originals.blocks;
    (sessionManager as any).getArchivedMessages = originals.messages;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
    logger.warn = originals.warn;
  }
}

function assertSafeWarning(
  result: { output: string; warnings: any[][] },
  expectedReason: string,
): Record<string, unknown> {
  assert.match(result.output, /PRIVATE_FALLBACK_CONTENT/);
  assert.equal(result.warnings.length, 1, 'one vector hit should emit at most one compatibility warning');
  const metadata = result.warnings[0][0] as Record<string, unknown>;
  assert.equal(metadata.classification, 'vector-recall-compatibility-fallback');
  assert.equal(metadata.reason, expectedReason);
  const serialized = JSON.stringify(result.warnings);
  assert.doesNotMatch(serialized, /PRIVATE_FALLBACK_CONTENT/);
  assert.doesNotMatch(serialized, /DO_NOT_LOG_QUERY/);
  assert.doesNotMatch(serialized, /chunk_text|embedding/i);
  return metadata;
}

test('vector recall warns once without content leakage when a block source is missing', async () => {
  const result = await exerciseFallback({
    id: 'block-hit',
    session_id: 'source-session',
    agent: 'source-agent',
    kind: 'block',
    source_kind: 'message',
    block_id: 9,
    raw_start_seq: 11,
    raw_end_seq: 12,
    text: 'PRIVATE_FALLBACK_CONTENT',
  });
  const metadata = assertSafeWarning(result, 'archive-block-source-missing');
  assert.equal(metadata.sourceSessionId, 'source-session');
  assert.equal(metadata.agent, 'source-agent');
  assert.equal(metadata.memoryKind, 'block');
  assert.equal(metadata.sourceKind, 'message');
  assert.equal(metadata.blockId, 9);
  assert.equal(metadata.rawStartSeq, 11);
  assert.equal(metadata.rawEndSeq, 12);
});

test('vector recall warns once without content leakage when a raw source range is missing', async () => {
  const result = await exerciseFallback({
    id: 'raw-hit',
    session_id: 'source-session',
    agent: 'source-agent',
    kind: 'raw',
    start_seq: 21,
    end_seq: 23,
    chunk_text: 'PRIVATE_FALLBACK_CONTENT',
  });
  const metadata = assertSafeWarning(result, 'archive-message-source-missing');
  assert.equal(metadata.memoryKind, 'raw');
  assert.equal(metadata.rawStartSeq, 21);
  assert.equal(metadata.rawEndSeq, 23);
});

test('vector recall classifies a legacy source-less hit while preserving its fallback preview', async () => {
  const result = await exerciseFallback({
    id: 'legacy-hit',
    session_id: 'source-session',
    agent: 'source-agent',
    kind: 'raw',
    text: 'PRIVATE_FALLBACK_CONTENT',
  });
  const metadata = assertSafeWarning(result, 'legacy-source-identity-unavailable');
  assert.equal(metadata.sourceSessionId, 'source-session');
  assert.equal(metadata.rawStartSeq, undefined);
  assert.equal(metadata.blockId, undefined);
});

test('vector recall fallback succeeds unchanged when logger.warn throws', async () => {
  const result = await exerciseFallback({
    id: 'logger-failure-hit',
    session_id: 'source-session',
    kind: 'raw',
    start_seq: 31,
    end_seq: 32,
    text: 'PRIVATE_FALLBACK_CONTENT',
  }, { throwFromLogger: true });
  assert.match(result.output, /PRIVATE_FALLBACK_CONTENT/);
  assert.equal(result.warnings.length, 1, 'the warning should be attempted once without a retry');
});
