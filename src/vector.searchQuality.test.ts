import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSearchCandidatesAdaptively, formatQueryEmbeddingInput, selectSearchSourceGroups, selectSearchSourceGroupsDetailed } from './vector';

function raw(id: string, start: number, end: number, distance: number, timestamp: number, text = id) {
  return {
    id,
    kind: 'raw',
    session_id: 'quality-session',
    start_seq: start,
    end_seq: end,
    raw_start_seq: start,
    raw_end_seq: end,
    text,
    chunk_text: text,
    _distance: distance,
    end_timestamp: timestamp,
  };
}

test('Qwen3 query instruction is stable and preserves bilingual identifiers verbatim', () => {
  assert.equal(
    formatQueryEmbeddingInput('查找 SessionWorkerProjection 与 commit 8577b5b5'),
    'Instruct: Retrieve relevant historical conversation context for the query.\nQuery: 查找 SessionWorkerProjection 与 commit 8577b5b5',
  );
});

test('source grouping collapses chunks and modern block facts while retaining matched fact wording', () => {
  const selected = selectSearchSourceGroups([
    raw('chunk-a', 1, 3, 0.1, 100, '中文 source range identifier AlphaNode'),
    raw('chunk-b', 1, 3, 0.11, 100, 'same source second chunk'),
    {
      id: 'block', kind: 'block', session_id: 'quality-session', block_id: 7, start_seq: 1, end_seq: 3,
      text: 'block summary', _distance: 0.2, end_timestamp: 300,
    },
    {
      id: 'fact', kind: 'fact', session_id: 'quality-session', block_id: 7, start_seq: 1, end_seq: 3,
      text: 'Memory fact (decision)\nUse AlphaNode for bilingual routing.', fact_kind: 'decision', attributed_to: 'user',
      _distance: 0.19, timestamp: 9999,
    },
  ], 10, { preferBlocks: true });

  assert.equal(selected.length, 2);
  assert.equal(selected[0].source_family, 'quality-session:raw:1-3');
  assert.equal(selected[0].source_group_size, 2);
  const blockFamily = selected.find(hit => hit.source_family === 'quality-session:block:7');
  assert.ok(blockFamily);
  assert.equal(blockFamily.source_group_size, 2);
  assert.match(blockFamily.matched_facts[0].text, /AlphaNode/);
  assert.equal(blockFamily.source_timestamp, 300, 'modern facts use creating-block source time when available');
});

test('semantic distance remains primary against extreme recency and block/fact preferences', () => {
  const selected = selectSearchSourceGroups([
    raw('best-old', 1, 1, 0.01, 1, 'best semantic match'),
    {
      id: 'recent-fact', kind: 'fact', session_id: 'quality-session', block_id: 9,
      start_seq: 9, end_seq: 9, text: 'recent fact', fact_kind: 'preference', attributed_to: 'both',
      _distance: 0.2, timestamp: Number.MAX_SAFE_INTEGER,
    },
    {
      id: 'recent-block', kind: 'block', session_id: 'quality-session', block_id: 10,
      start_seq: 10, end_seq: 10, text: 'recent block', _distance: 0.15, end_timestamp: Number.MAX_SAFE_INTEGER,
    },
  ], 3, { preferBlocks: true });

  assert.equal(selected[0].id, 'best-old');
  assert.deepEqual(selected.map(hit => hit._distance), [0.01, 0.15, 0.2]);
});

test('overlapping raw ranges are diversified before deferred ranges backfill the limit', () => {
  const selected = selectSearchSourceGroups([
    raw('a', 1, 10, 0.01, 100),
    raw('b', 2, 10, 0.02, 200),
    raw('c', 20, 25, 0.03, 300),
    raw('d', 30, 35, 0.04, 400),
  ], 3);
  assert.deepEqual(selected.map(hit => hit.id), ['a', 'c', 'd']);

  const backfilled = selectSearchSourceGroups([
    raw('a', 1, 10, 0.01, 100),
    raw('b', 2, 10, 0.02, 200),
  ], 2);
  assert.deepEqual(backfilled.map(hit => hit.id), ['a', 'b']);
});

test('adaptive candidate fetch expands beyond a saturated duplicate window to find a distinct source', async () => {
  const rows = [
    ...Array.from({ length: 161 }, (_, index) => raw(`duplicate-${index}`, 1, 1, index / 1000, index)),
    raw('distinct-source', 2, 2, 0.2, 999),
  ];
  const requestedLimits: number[] = [];
  const selected = await fetchSearchCandidatesAdaptively({
    initialRowLimit: 160,
    hardRowLimit: 320,
    requiredSourceCount: 2,
    fetchRows: async rowLimit => {
      requestedLimits.push(rowLimit);
      return rows.slice(0, rowLimit);
    },
    selectSources: async candidates => selectSearchSourceGroupsDetailed(candidates, 2),
  });

  assert.deepEqual(requestedLimits, [160, 320]);
  assert.deepEqual(selected.map(hit => hit.id), ['duplicate-0', 'distinct-source']);
});

test('adaptive candidate fetch terminates at its hard cap when duplicates still saturate it', async () => {
  const rows = Array.from({ length: 400 }, (_, index) => raw(`duplicate-${index}`, 1, 1, index / 1000, index));
  const requestedLimits: number[] = [];
  const selected = await fetchSearchCandidatesAdaptively({
    initialRowLimit: 80,
    hardRowLimit: 160,
    requiredSourceCount: 2,
    fetchRows: async rowLimit => {
      requestedLimits.push(rowLimit);
      return rows.slice(0, rowLimit);
    },
    selectSources: async candidates => selectSearchSourceGroupsDetailed(candidates, 2),
  });

  assert.deepEqual(requestedLimits, [80, 160]);
  assert.equal(selected.length, 1);
});

test('adaptive candidate fetch keeps the normal one-query path when the first window is sufficient', async () => {
  const rows = [raw('first', 1, 1, 0.01, 1), raw('second', 2, 2, 0.02, 2)];
  const requestedLimits: number[] = [];
  const selected = await fetchSearchCandidatesAdaptively({
    initialRowLimit: 40,
    hardRowLimit: 160,
    requiredSourceCount: 2,
    fetchRows: async rowLimit => {
      requestedLimits.push(rowLimit);
      return rows.slice(0, rowLimit);
    },
    selectSources: async candidates => selectSearchSourceGroupsDetailed(candidates, 2),
  });

  assert.deepEqual(requestedLimits, [40]);
  assert.deepEqual(selected.map(hit => hit.id), ['first', 'second']);
});

test('adaptive fetch expands when overlap backfill alone fills the saturated initial result', async () => {
  const overlapping = Array.from({ length: 160 }, (_, index) => raw(
    `overlap-${index}`,
    index + 1,
    index + 1000,
    index / 1000,
    index,
  ));
  const rows = [...overlapping, raw('distinct-range', 2000, 2005, 0.2, 999)];
  const requestedLimits: number[] = [];
  const selected = await fetchSearchCandidatesAdaptively({
    initialRowLimit: 160,
    hardRowLimit: 320,
    requiredSourceCount: 2,
    fetchRows: async rowLimit => {
      requestedLimits.push(rowLimit);
      return rows.slice(0, rowLimit);
    },
    selectSources: async candidates => selectSearchSourceGroupsDetailed(candidates, 2),
  });

  assert.deepEqual(requestedLimits, [160, 320]);
  assert.deepEqual(selected.map(hit => hit.id), ['overlap-0', 'distinct-range']);
});

test('overlap-only candidates at the hard cap return deferred backfill rows', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => raw(
    `overlap-${index}`,
    index + 1,
    index + 100,
    index / 1000,
    index,
  ));
  const selected = await fetchSearchCandidatesAdaptively({
    initialRowLimit: 4,
    hardRowLimit: 8,
    requiredSourceCount: 3,
    fetchRows: async rowLimit => rows.slice(0, rowLimit),
    selectSources: async candidates => selectSearchSourceGroupsDetailed(candidates, 3),
  });

  assert.deepEqual(selected.map(hit => hit.id), ['overlap-0', 'overlap-1', 'overlap-2']);
});
