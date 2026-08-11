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

    await fs.outputFile(config.getSessionArchiveLogPath(sessionId), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
    await fs.outputJson(config.SESSIONS_FILE, {
      sessions: {
        [sessionId]: { id: sessionId, agent: 'test-agent', meta: { lastMessageTime: 1700000000018 } },
      },
    }, { spaces: 2 });

    await migrations.runStartupMigrations();
    await archiveStore.initArchiveStore();

    const expectedRowCount = vector.buildArchiveSegments(lines).flatMap(vector.createRowsFromSegment).length;
    const initStartedAt = Date.now();
    await vector.init();
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

    const searchResults = await vector.search('progress batch', 10, false, { sessionIds: [sessionId] }) as any[];
    assert.ok(searchResults.some(result => String(result.text || '').includes('progress batch message')),
      'session should remain searchable after background rebuild completes');
  } finally {
    global.fetch = originalFetch;
    delete process.env.FOXWARM_VECTOR_RAW_REBUILD_BATCH_SEGMENTS;
  }
});
