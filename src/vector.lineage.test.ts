import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function makeMessageRecord(sessionId: string, seq: number, role: 'user' | 'model' | 'tool', text: string, timestamp: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp,
    role,
    message: {
      role,
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

test('mixed vector search works after bootstrapping legacy archive data into sqlite store', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-lineage-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const makeEmbedding = (text: string): number[] => {
    const vector = new Array(1024).fill(0);
    const normalized = text.toLowerCase();
    if (normalized.includes('alpha')) vector[0] = 1;
    if (normalized.includes('beta')) vector[1] = 1;
    if (normalized.includes('gamma')) vector[2] = 1;
    if (normalized.includes('summary')) vector[3] = 1;
    return vector;
  };

  const originalFetch = global.fetch;
  global.fetch = (async (_input: any, init?: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const embedding = makeEmbedding(String(body.input || ''));
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const config = await import('./config');
    const archiveStore = await import('./session/archiveStore');
    const vector = await import('./vector');

    const parentMessages = [
      makeMessageRecord('parent', 1, 'user', 'alpha parent raw', 1000),
      makeMessageRecord('parent', 2, 'model', 'beta parent raw', 2000),
      makeMessageRecord('parent', 3, 'user', 'alpha forbidden future', 3000),
    ];
    const childMessages = [
      makeMessageRecord('parent', 1, 'user', 'alpha parent raw', 1000),
      makeMessageRecord('parent', 2, 'model', 'beta parent raw', 2000),
      makeMessageRecord('child', 4, 'user', 'gamma child local', 4000),
    ];

    const parentBlocks = [
      makeBlockRecord('parent', 1, 1, 2, 'alpha summary block', 2500),
    ];
    const childBlocks = [...parentBlocks];

    await fs.outputFile(config.getSessionArchiveLogPath('parent'), `${parentMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionArchiveLogPath('child'), `${childMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionBlockArchiveLogPath('parent'), `${parentBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputFile(config.getSessionBlockArchiveLogPath('child'), `${childBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
    await fs.outputJson(config.SESSIONS_FILE, {
      sessions: {
        parent: { id: 'parent', agent: 'test-agent', meta: { lastMessageTime: 3000 } },
        child: { id: 'child', agent: 'test-agent', parentSessionId: 'parent', meta: { lastMessageTime: 4000 } },
      },
    }, { spaces: 2 });

    await archiveStore.initArchiveStore();
    await vector.init();
    await vector.indexSessionArchive('parent', 3, 1);
    await vector.indexSessionArchive('child', 4, 1);

    const lineage = await archiveStore.getVectorSearchLineage('child');
    const lineageSessions = lineage.map(entry => ({
      sessionId: entry.sessionId,
      maxMessageSeq: entry.maxMessageSeq,
      maxBlockId: entry.maxBlockId,
    }));

    const alphaResults = await vector.search('alpha', 10, false, { lineageSessions }) as any[];
    assert(alphaResults.some(result => result.kind === 'raw' && result.text.includes('alpha parent raw')),
      'expected inherited raw row from imported parent archive to be searchable');
    assert(alphaResults.some(result => result.kind === 'block' && result.text.includes('alpha summary block')),
      'expected inherited block row from imported parent archive to be searchable');
    assert(alphaResults.every(result => !String(result.text || '').includes('alpha forbidden future')),
      'child current-session lineage search must not leak parent post-fork rows after bootstrap import');

    const status = vector.getArchiveIndexStatus('child');
    assert.equal(status.lastIndexedBlockId, 1, 'child should inherit imported parent block checkpoint');
    assert.equal(status.lastIndexedSeq, 4, 'child checkpoint should advance on imported local child messages');
  } finally {
    global.fetch = originalFetch;
  }
});
