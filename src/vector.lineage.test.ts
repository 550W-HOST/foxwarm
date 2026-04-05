import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('vector search mixes raw and block rows while child current-session scope respects lineage cutoffs', async () => {
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
    const archive = await import('./session/archive');
    const layeredContext = await import('./session/layeredContext');
    const archiveStore = await import('./session/archiveStore');
    const vector = await import('./vector');

    const parent: any = {
      id: 'parent',
      agent: 'test-agent',
      history: [],
      nextMessageSeq: 1,
      nextBlockId: 1,
      contextFrontier: [],
    };

    await archive.appendMessagesToArchive(parent, [
      { role: 'user', parts: [{ text: 'alpha parent raw' }], __meta: { timestamp: 1000 } },
      { role: 'model', parts: [{ text: 'beta parent raw' }], __meta: { timestamp: 2000 } },
    ]);
    await layeredContext.appendBlocksToArchive(parent, [{
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 2,
      rawStartSeq: 1,
      rawEndSeq: 2,
      summary: 'alpha summary block',
    }]);

    await archiveStore.ensureSessionBranch('child', {
      parentSessionId: 'parent',
      forkMessageSeq: parent.nextMessageSeq - 1,
      forkBlockId: parent.nextBlockId - 1,
    });

    await archive.appendMessagesToArchive(parent, [
      { role: 'user', parts: [{ text: 'alpha forbidden future' }], __meta: { timestamp: 3000 } },
    ]);

    const child: any = {
      id: 'child',
      agent: 'test-agent',
      history: [],
      nextMessageSeq: parent.nextMessageSeq,
      nextBlockId: parent.nextBlockId,
      contextFrontier: [],
    };

    await archive.appendMessagesToArchive(child, [
      { role: 'user', parts: [{ text: 'gamma child local' }], __meta: { timestamp: 4000 } },
    ]);

    await vector.init();
    await vector.indexSessionArchive('parent', parent.nextMessageSeq - 1, parent.nextBlockId - 1);
    await vector.indexSessionArchive('child', child.nextMessageSeq - 1, child.nextBlockId - 1);

    const lineage = await archiveStore.getVectorSearchLineage('child');
    const lineageSessions = lineage.map(entry => ({
      sessionId: entry.sessionId,
      maxMessageSeq: entry.maxMessageSeq,
      maxBlockId: entry.maxBlockId,
    }));

    const alphaResults = await vector.search('alpha', 10, false, { lineageSessions }) as any[];
    assert(alphaResults.some(result => result.kind === 'raw' && result.text.includes('alpha parent raw')),
      'expected inherited raw row from parent to be searchable');
    assert(alphaResults.some(result => result.kind === 'block' && result.text.includes('alpha summary block')),
      'expected inherited block row from parent to be searchable');
    assert(alphaResults.every(result => !String(result.text || '').includes('alpha forbidden future')),
      'child current-session lineage search must not leak parent post-fork rows');

    const status = vector.getArchiveIndexStatus('child');
    assert.equal(status.lastIndexedBlockId, 1, 'child should inherit parent block checkpoint without re-indexing duplicate block rows');
    assert.equal(status.lastIndexedSeq, child.nextMessageSeq - 1, 'child checkpoint should advance on local messages');
  } finally {
    global.fetch = originalFetch;
  }
});
