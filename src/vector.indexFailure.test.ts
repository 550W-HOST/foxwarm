import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as lancedb from '@lancedb/lancedb';

function messageRecord(sessionId: string, seq: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp: 1700000000000 + seq,
    role: 'user' as const,
    message: {
      role: 'user' as const,
      parts: [{ text: `${sessionId} message ${seq}` }],
      __meta: { seq, timestamp: 1700000000000 + seq },
    },
  };
}

async function flushUnhandledRejections(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function readRawRows(dbPath: string, sessionId: string): Promise<any[]> {
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable('messages_v7');
  try {
    const iterator = await (table.query() as any)
      .where(`session_id = '${sessionId}' AND memory_kind = 'raw'`)
      .limit(100)
      .execute();
    const rows: any[] = [];
    for await (const batch of iterator) rows.push(...batch.toArray());
    return rows;
  } finally {
    table.close?.();
    db.close?.();
  }
}

test('caught forced and scheduled vector failures do not leak rejected promises and remain retryable', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-index-failure-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  await fs.outputFile(path.join(tempRoot, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n');

  const originalFetch = global.fetch;
  let failNextEmbedding = false;
  let embeddingRequests = 0;
  global.fetch = (async () => {
    embeddingRequests += 1;
    if (failNextEmbedding) {
      failNextEmbedding = false;
      throw new Error('injected embedding network failure');
    }
    return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    const config = await import('./config');
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorRuntime');
    await store.initArchiveStore();

    const forcedSessionId = 'failure/forced';
    await store.ensureSessionBranch(forcedSessionId);
    await store.writeArchiveMessages([1, 2, 3].map(seq => messageRecord(forcedSessionId, seq)));
    store.setVectorCheckpointSync(forcedSessionId, {
      rawLastIndexedSeq: 3,
      rawTailStartSeq: 1,
      lastIndexedBlockId: 0,
    });

    const scheduledSessionId = 'failure/scheduled';
    await store.ensureSessionBranch(scheduledSessionId);
    await store.writeArchiveMessages([messageRecord(scheduledSessionId, 1)]);
    store.setVectorCheckpointSync(scheduledSessionId, {
      rawLastIndexedSeq: 1,
      rawTailStartSeq: 1,
      lastIndexedBlockId: 0,
    });

    await runtime.init();
    await runtime.waitForStartupArchiveVectorBackfill();

    store.setVectorCheckpointSync(forcedSessionId, {
      rawLastIndexedSeq: 2,
      rawTailStartSeq: 1,
      lastIndexedBlockId: 0,
    });
    failNextEmbedding = true;
    await assert.rejects(
      runtime.indexSessionArchive(forcedSessionId, 3, 0),
      /injected embedding network failure/,
    );
    await flushUnhandledRejections();
    assert.deepEqual(unhandled, [], 'caught forced indexing failure must not emit unhandledRejection');
    assert.deepEqual(runtime.getArchiveIndexStatus(forcedSessionId), {
      lastIndexedSeq: 2,
      tailStartSeq: 1,
      lastIndexedBlockId: 0,
    });

    await runtime.indexSessionArchive(forcedSessionId, 3, 0);
    assert.deepEqual(runtime.getArchiveIndexStatus(forcedSessionId), {
      lastIndexedSeq: 3,
      tailStartSeq: 1,
      lastIndexedBlockId: 0,
    });
    const forcedRows = await readRawRows(config.DB_DIR, forcedSessionId);
    assert.equal(forcedRows.length, 1);
    assert.equal(Number(forcedRows[0].start_seq), 1);
    assert.equal(Number(forcedRows[0].end_seq), 3);

    store.setVectorCheckpointSync(scheduledSessionId, {
      rawLastIndexedSeq: 0,
      rawTailStartSeq: 0,
      lastIndexedBlockId: 0,
    });
    failNextEmbedding = true;
    const scheduledFirst = runtime.scheduleSessionArchiveIndex(scheduledSessionId, 1, 9000, 0);
    const scheduledCoalesced = runtime.scheduleSessionArchiveIndex(scheduledSessionId, 1, undefined, 0);
    const scheduledResults = await Promise.allSettled([scheduledFirst, scheduledCoalesced]);
    assert.deepEqual(scheduledResults.map(result => result.status), ['rejected', 'rejected']);
    assert.match(String((scheduledResults[0] as PromiseRejectedResult).reason), /injected embedding network failure/);
    assert.match(String((scheduledResults[1] as PromiseRejectedResult).reason), /injected embedding network failure/);
    await flushUnhandledRejections();
    assert.deepEqual(unhandled, [], 'observed scheduled/coalesced failures must not emit unhandledRejection');
    assert.deepEqual(runtime.getArchiveIndexStatus(scheduledSessionId), {
      lastIndexedSeq: 0,
      tailStartSeq: 0,
      lastIndexedBlockId: 0,
    });

    const requestsBeforeRetry = embeddingRequests;
    await runtime.scheduleSessionArchiveIndex(scheduledSessionId, 1, 9000, 0);
    assert.equal(embeddingRequests, requestsBeforeRetry + 1, 'retry should run one new queue entry after failed state cleanup');
    assert.deepEqual(runtime.getArchiveIndexStatus(scheduledSessionId), {
      lastIndexedSeq: 1,
      tailStartSeq: 1,
      lastIndexedBlockId: 0,
    });
    const scheduledRows = await readRawRows(config.DB_DIR, scheduledSessionId);
    assert.equal(scheduledRows.length, 1);
    assert.equal(Number(scheduledRows[0].start_seq), 1);
    assert.equal(Number(scheduledRows[0].end_seq), 1);
    await flushUnhandledRejections();
    assert.deepEqual(unhandled, []);

    await runtime.shutdown();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    global.fetch = originalFetch;
    await fs.remove(tempRoot);
  }
});
