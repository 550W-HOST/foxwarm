import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('compact memory fact rows are deduplicated and searchable with regex filters', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-memory-facts-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  await fs.outputFile(path.join(tempRoot, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n');

  const originalFetch = global.fetch;
  global.fetch = (async (_input: any, init?: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const text = String(body.input || '').toLowerCase();
    const vector = new Array(1024).fill(0);
    if (text.includes('compact') || text.includes('durable')) vector[0] = 1;
    if (text.includes('router')) vector[1] = 1;
    return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const vector = await import('./vector');
    await vector.init({ enabled: true });

    const rows = vector.createRowsFromMemoryFacts({
      sessionId: 'fact-session',
      agent: 'test-agent',
      sourceStartSeq: 10,
      sourceEndSeq: 12,
      blockId: 7,
      blockLevel: 1,
      facts: [
        {
          kind: 'decision',
          text: 'Compact should extract durable memory facts for future semantic recall.',
          context: 'The router compact flow should preserve long-term user decisions.',
          attributedTo: 'user',
        },
        {
          kind: 'decision',
          text: 'Compact should extract durable memory facts for future semantic recall.',
          context: 'duplicate should be skipped',
          attributedTo: 'user',
        },
      ],
    });

    assert.equal(rows.length, 1, 'duplicate fact text should produce one row');
    assert.equal(rows[0].memory_kind, 'fact');
    assert.equal(rows[0].source_kind, 'memory_fact:decision');
    assert.equal(rows[0].role, 'fact:decision:user');
    assert.match(rows[0].text, /Memory fact \(decision\)/);
    assert.match(rows[0].text, /Context: The router compact flow/);
    assert.equal(rows[0].raw_start_seq, 10);
    assert.equal(rows[0].raw_end_seq, 12);
    assert.equal(rows[0].block_id, 7);
    assert.equal(rows[0].block_level, 1);

    const laterBlockRows = vector.createRowsFromMemoryFacts({
      sessionId: 'fact-session', agent: 'test-agent', sourceStartSeq: 30, sourceEndSeq: 31, blockId: 8, blockLevel: 2,
      facts: [{ kind: 'decision', text: 'A later block keeps the same durable decision with its own source range.' }],
    });
    assert.equal(laterBlockRows[0].block_id, 8);
    assert.equal(laterBlockRows[0].block_level, 2);
    assert.equal(laterBlockRows[0].raw_start_seq, 30);
    assert.equal(laterBlockRows[0].raw_end_seq, 31);
    assert.notEqual(laterBlockRows[0].id, rows[0].id);

    const indexed = await vector.indexMemoryFactsFromCompaction({
      sessionId: 'fact-session',
      agent: 'test-agent',
      sourceStartSeq: 10,
      sourceEndSeq: 12,
      blockId: 7,
      blockLevel: 1,
      facts: [
        {
          kind: 'decision',
          text: 'Compact should extract durable memory facts for future semantic recall.',
          context: 'The router compact flow should preserve long-term user decisions.',
          attributedTo: 'user',
        },
      ],
    });
    assert.equal(indexed, 1);

    const results = await vector.search('durable compact memory', 5, false, {
      sessionIds: ['fact-session'],
      includeRegex: 'router',
    }) as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'fact');
    assert.equal(results[0].fact_kind, 'decision');
    assert.equal(results[0].attributed_to, 'user');
    assert.equal(results[0].raw_start_seq, 10);
    assert.match(results[0].text, /future semantic recall/);

    const excluded = await vector.search('durable compact memory', 5, false, {
      sessionIds: ['fact-session'],
      excludeRegex: 'router',
    }) as any[];
    assert.equal(excluded.length, 0, 'regex filters should apply to fact text/context');

    const formatted = await vector.search('durable compact memory', 5, true, {
      sessionIds: ['fact-session'],
    }) as string;
    assert.match(formatted, /\[kind: memory fact\] \[fact: decision\]/);
    assert.match(formatted, /\[source: raw 10-12\]/);
    assert.match(formatted, /B#7/);

    const archiveStore = await import('./session/archiveStore');
    await archiveStore.ensureSessionBranch('fact-parent');
    await archiveStore.ensureSessionBranch('fact-child', {
      parentSessionId: 'fact-parent',
      forkMessageSeq: 2,
      forkBlockId: 1,
    });
    await vector.indexMemoryFactsFromCompaction({
      sessionId: 'fact-parent', agent: 'test-agent', sourceStartSeq: 1, sourceEndSeq: 2, blockId: 1, blockLevel: 1,
      facts: [{ kind: 'decision', text: 'fork-boundary allowed pre-fork fact' }],
    });
    await vector.indexMemoryFactsFromCompaction({
      sessionId: 'fact-parent', agent: 'test-agent', sourceStartSeq: 1, sourceEndSeq: 3, blockId: 2, blockLevel: 1,
      facts: [{ kind: 'decision', text: 'fork-boundary forbidden crossing block fact' }],
    });
    // Stored legacy rows had no creating block identity. They must be entirely
    // before the message fork boundary instead of being range-clipped on recall.
    await vector.indexMemoryFactsFromCompaction({
      sessionId: 'fact-parent', agent: 'test-agent', sourceStartSeq: 1, sourceEndSeq: 3, blockId: null, blockLevel: null,
      facts: [{ kind: 'decision', text: 'fork-boundary forbidden legacy crossing fact' }],
    } as any);

    const lineage = await archiveStore.getVectorSearchLineage('fact-child');
    const childHits = await vector.search('fork-boundary', 10, false, {
      lineageSessions: lineage.map(entry => ({
        sessionId: entry.sessionId,
        maxMessageSeq: entry.maxMessageSeq,
        maxBlockId: entry.maxBlockId,
      })),
    }) as any[];
    assert.deepEqual(childHits.map(hit => hit.text.includes('allowed pre-fork fact')), [true],
      'semantic recall candidates must keep only facts fully inherited by block identity or legacy range');
    assert.equal(childHits[0].block_id, 1);
    assert.equal(childHits[0].raw_end_seq, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
