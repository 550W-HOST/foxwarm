import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as lancedb from '@lancedb/lancedb';

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

function makeBlockRecord(sessionId: string, id: number, rawStartSeq: number, rawEndSeq: number, summary: string) {
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
    memoryFacts: [{ kind: 'decision' as const, text: 'disabled-period dedicated fact text', attributedTo: 'user' as const }],
    createdAt: 1700000001000,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs: number = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

test('startup backfill runs in background and advances raw checkpoints batch-by-batch', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-progress-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_VECTOR_RAW_REBUILD_BATCH_SEGMENTS = '2';
  await fs.outputFile(path.join(tempRoot, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n');

  let embeddingRequestCount = 0;
  const originalFetch = global.fetch;
  global.fetch = (async (_input: any, init?: any) => {
    embeddingRequestCount += 1;
    const body = JSON.parse(String(init?.body || '{}'));
    const text = String(body.input || '').toLowerCase();
    const vector = new Array(1024).fill(0);
    if (text.includes('progress')) vector[0] = 1;
    if (text.includes('batch')) vector[1] = 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const config = await import('./config');
    const migrations = await import('./migrations');
    const archiveStore = await import('./session/archiveStore');
    const vector = await import('./vector');

    const sessionId = 'progress/session';
    const lines = Array.from({ length: 18 }, (_, index) => (
      makeMessageRecord(
        sessionId,
        index + 1,
        `progress batch message ${index + 1} ` + 'token '.repeat(220),
        1700000000000 + index,
      )
    ));
    const block = makeBlockRecord(
      sessionId,
      1,
      1,
      18,
      'disabled-period block summary\n\n### Memory facts\n- **decision:** disabled-period dedicated fact text _(attributed to: user)_',
    );

    await fs.outputFile(config.getSessionArchiveLogPath(sessionId), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
    await fs.outputFile(config.getSessionBlockArchiveLogPath(sessionId), `${JSON.stringify(block)}\n`);
    await fs.outputJson(config.SESSIONS_FILE, {
      sessions: {
        [sessionId]: { id: sessionId, agent: 'test-agent', meta: { lastMessageTime: 1700000000018 } },
      },
    }, { spaces: 2 });

    await migrations.runStartupMigrations();
    await archiveStore.initArchiveStore();

    const expectedRowCount = vector.buildArchiveSegments(lines).flatMap(vector.createRowsFromSegment).length;
    const initStartedAt = Date.now();
    await vector.init({ enabled: false });
    assert.deepEqual(vector.getVectorServiceStatus(), { mode: 'disabled', ready: false });
    assert.equal((await archiveStore.getVectorCheckpoint(sessionId)).rawLastIndexedSeq, 0);
    assert.equal((await archiveStore.getVectorCheckpoint(sessionId)).lastIndexedBlockId, 0);
    await vector.shutdown();

    await vector.init({ enabled: true });
    const initDurationMs = Date.now() - initStartedAt;

    assert.ok(initDurationMs < 500, `init should not block on background backfill (took ${initDurationMs}ms)`);
    assert.equal((await vector.getArchiveIndexStatus(sessionId)).lastIndexedSeq, 0, 'checkpoint should start at zero before the first batch commits');

    await waitUntil(async () => {
      const status = await vector.getArchiveIndexStatus(sessionId);
      return status.lastIndexedSeq > 0 && status.lastIndexedSeq < lines.length;
    }, 10000);

    const intermediateStatus = await vector.getArchiveIndexStatus(sessionId);
    assert.ok(intermediateStatus.lastIndexedSeq > 0, 'expected partial raw checkpoint advancement during long rebuild');
    assert.ok(intermediateStatus.lastIndexedSeq < lines.length, 'intermediate checkpoint should be visible before rebuild completion');
    assert.ok(intermediateStatus.tailStartSeq > 0, 'tail checkpoint should also advance during partial rebuild');

    await vector.waitForStartupArchiveVectorBackfill();

    const finalStatus = await vector.getArchiveIndexStatus(sessionId);
    assert.equal(finalStatus.lastIndexedSeq, lines.length, 'final raw checkpoint should reach the latest archive seq');
    assert.equal(finalStatus.lastIndexedBlockId, block.id, 'full block summaries should backfill after re-enable');
    assert.ok(finalStatus.tailStartSeq > 0, 'final tail checkpoint should be persisted');
    assert.ok(embeddingRequestCount >= expectedRowCount, 'expected embeddings to be requested for rebuilt raw rows');

    const db = await lancedb.connect(config.DB_DIR);
    const table = await db.openTable('messages_v7');
    const iterator = await (table.query() as any)
      .where(`session_id = '${sessionId}' AND memory_kind = 'raw'`)
      .limit(1000)
      .execute();
    const rawRows: any[] = [];
    for await (const batch of iterator) {
      rawRows.push(...batch.toArray());
    }

    const uniqueIds = new Set(rawRows.map(row => row.id));
    assert.equal(rawRows.length, expectedRowCount, 'final raw row count should match the fully rebuilt segment set');
    assert.equal(uniqueIds.size, rawRows.length, 'final raw rows should not contain duplicate ids after batched checkpointed rebuild');

    const blockIterator = await (table.query() as any)
      .where(`session_id = '${sessionId}' AND memory_kind = 'block'`)
      .limit(100)
      .execute();
    const blockRows: any[] = [];
    for await (const batch of blockIterator) blockRows.push(...batch.toArray());
    assert.equal(blockRows.length, 1);
    assert.match(String(blockRows[0].text), /disabled-period block summary/);
    assert.match(String(blockRows[0].text), /disabled-period dedicated fact text/,
      'formatted fact text remains semantically available through the backfilled block row');

    const factIterator = await (table.query() as any)
      .where(`session_id = '${sessionId}' AND memory_kind = 'fact'`)
      .limit(100)
      .execute();
    const factRows: any[] = [];
    for await (const batch of factIterator) factRows.push(...batch.toArray());
    assert.equal(factRows.length, 0,
      'startup backfill does not reconstruct dedicated fact rows for compactions created while Vector was disabled');

    const searchResults = await vector.search('progress batch', 10, false, { sessionIds: [sessionId] }) as any[];
    assert.ok(searchResults.some(result => String(result.text || '').includes('progress batch message')),
      'session should remain searchable after background rebuild completes');
  } finally {
    global.fetch = originalFetch;
    delete process.env.FOXWARM_VECTOR_RAW_REBUILD_BATCH_SEGMENTS;
  }
});
