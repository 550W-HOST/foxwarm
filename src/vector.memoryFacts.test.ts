import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('compact memory fact rows are deduplicated and searchable with regex filters', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-memory-facts-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

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
    await vector.init();

    const rows = vector.createRowsFromMemoryFacts({
      sessionId: 'fact-session',
      agent: 'test-agent',
      sourceStartSeq: 10,
      sourceEndSeq: 12,
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

    const indexed = await vector.indexMemoryFactsFromCompaction({
      sessionId: 'fact-session',
      agent: 'test-agent',
      sourceStartSeq: 10,
      sourceEndSeq: 12,
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
  } finally {
    global.fetch = originalFetch;
  }
});
