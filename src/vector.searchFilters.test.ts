import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function makeMessageRecord(sessionId: string, seq: number, text: string, timestamp: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp,
    role: 'user' as const,
    message: {
      role: 'user' as const,
      parts: [{ text }],
      __meta: { seq, timestamp },
    },
  };
}

function makeBlockRecord(sessionId: string, id: number, rawStartSeq: number, rawEndSeq: number, summary: string, createdAt: number) {
  return {
    v: 1,
    kind: 'block' as const,
    sessionId,
    agent: 'test-agent',
    id,
    level: 1,
    sourceKind: 'message' as const,
    sourceStart: rawStartSeq,
    sourceEnd: rawEndSeq,
    rawStartSeq,
    rawEndSeq,
    summary,
    createdAt,
  };
}

test('vector search filters, block boost, and recall vector_query source rendering respect lineage', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-search-filters-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const originalFetch = global.fetch;
  global.fetch = (async (_input: any, init?: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const text = String(body.input || '').toLowerCase();
    const vector = new Array(1024).fill(0);
    if (text.includes('alpha')) vector[0] = 1;
    if (text.includes('child')) vector[1] = 1;
    if (text.includes('forbidden')) vector[2] = 1;
    return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const config = await import('./config');
    const archiveStore = await import('./session/archiveStore');
    const vector = await import('./vector');
    const sessionManager = await import('./sessionManager');
    const toolsSessionAgent = await import('./toolsSessionAgent');

    const longNoiseA = 'x'.repeat(2200);
    const longNoiseB = 'y'.repeat(2200);
    const longNoiseC = 'z'.repeat(2200);
    const longNoiseD = 'q'.repeat(2200);
    const longNoiseE = 'c'.repeat(2200);

    const parentMessages = [
      makeMessageRecord('parent', 1, `send_to_session alpha noise ${longNoiseA}`, 1000),
      makeMessageRecord('parent', 2, `create_child_session alpha noise ${longNoiseB}`, 2000),
      makeMessageRecord('parent', 3, `useful alpha detail ${longNoiseC}`, 3000),
      makeMessageRecord('parent', 4, `forbidden future alpha ${longNoiseD}`, 4000),
    ];
    const childMessages = [
      makeMessageRecord('parent', 1, `send_to_session alpha noise ${longNoiseA}`, 1000),
      makeMessageRecord('parent', 2, `create_child_session alpha noise ${longNoiseB}`, 2000),
      makeMessageRecord('parent', 3, `useful alpha detail ${longNoiseC}`, 3000),
      makeMessageRecord('child', 5, `child alpha local ${longNoiseE}`, 5000),
    ];

    const parentBlocks = [
      makeBlockRecord('parent', 1, 1, 3, 'alpha topic summary block', 3500),
    ];
    const childBlocks = [...parentBlocks];

    await fs.outputFile(config.getSessionArchiveLogPath('parent'), `${parentMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionArchiveLogPath('child'), `${childMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionBlockArchiveLogPath('parent'), `${parentBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionBlockArchiveLogPath('child'), `${childBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputJson(config.SESSIONS_FILE, {
      sessions: {
        parent: { id: 'parent', agent: 'test-agent', meta: { lastMessageTime: 4000 } },
        child: { id: 'child', agent: 'test-agent', parentSessionId: 'parent', meta: { lastMessageTime: 5000 } },
      },
    }, { spaces: 2 });

    await archiveStore.initArchiveStore();
    await sessionManager.loadSessions();
    await vector.init();
    await vector.waitForStartupArchiveVectorBackfill();

    const lineage = await archiveStore.getVectorSearchLineage('child');
    const lineageSessions = lineage.map(entry => ({
      sessionId: entry.sessionId,
      maxMessageSeq: entry.maxMessageSeq,
      maxBlockId: entry.maxBlockId,
    }));

    const filtered = await vector.search('alpha', 10, false, {
      lineageSessions,
      excludeRegex: 'send_to_session|create_child_session',
      includeRegex: 'summary|useful|child',
    }) as any[];

    assert(filtered.length > 0, 'expected filtered results');
    assert(filtered.every(result => {
      const text = String(result.text || '').toLowerCase();
      return !/send_to_session|create_child_session/.test(text);
    }), 'excludeRegex should remove noisy tool-routing rows');
    assert(filtered.every(result => {
      const text = String(result.text || '').toLowerCase();
      return /summary|useful|child/.test(text);
    }), 'includeRegex should narrow final results');
    assert(filtered.every(result => !String(result.text || '').includes('forbidden future alpha')),
      'regex filtering must not bypass lineage clipping for parent post-fork future rows');

    const defaultResults = await vector.search('alpha', 10, false, { lineageSessions }) as any[];
    assert(defaultResults.some(result => result.kind === 'block' && String(result.text || '').includes('summary block')),
      'default mixed search should still surface the inherited block result');
    assert.equal(defaultResults[0]?.kind, 'block', 'block boost should make a relevant block visible at the top for broad/topic queries');

    const preferBlockResults = await vector.search('alpha', 10, false, {
      lineageSessions,
      preferBlocks: true,
    }) as any[];
    assert.equal(preferBlockResults[0]?.kind, 'block', 'preferBlocks should keep the block result at the top');

    const recallVector = String(await toolsSessionAgent.tool_recall({
      vector_query: 'alpha',
      sessionId: 'child',
      scope: 'current-session',
      limit: 5,
      contentFilter: 'useful',
      previewLength: 2000,
    }, { sessionId: 'child', session: { id: 'child', agent: 'test-agent' } } as any));
    assert.match(recallVector, /Recall vector search for `alpha`/);
    assert.match(recallVector, /source archive ranges loaded before preview/i);
    assert.match(recallVector, /\[#3/);
    assert.match(recallVector, /useful alpha detail/);
    assert.doesNotMatch(recallVector, /\[chunk /, 'recall(vector_query) should render original archived messages, not vector chunks');
    assert.doesNotMatch(recallVector, /send_to_session alpha noise/);

    await assert.rejects(
      () => vector.search('alpha', 5, false, { lineageSessions, includeRegex: '[' }),
      /Invalid includeRegex:/,
      'invalid includeRegex should produce a clear error',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
