import assert from 'node:assert/strict';
import fs from 'fs-extra';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function makeRecord(sessionId: string, seq: number, text: string) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'main',
    seq,
    timestamp: Date.now() + seq,
    role: 'user' as const,
    message: {
      role: 'user' as const,
      parts: [{ text }],
      __meta: { seq, timestamp: Date.now() + seq },
    },
  };
}

async function startEmbeddingServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const input = String(parsed.input || '');
      const vector = new Array(1024).fill(0);
      vector[input.toLowerCase().includes('worker') ? 1 : 0] = 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ embedding: vector }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Embedding test server did not bind a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('vector facade preserves search behavior in local and child placements', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-service-smoke-'));
  const embedding = await startEmbeddingServer();
  process.env.FOXWARM_DATA_DIR = tempRoot;
  await fs.outputFile(
    path.join(tempRoot, 'state', 'config.yaml'),
    `llm:\n  ollamaBaseUrl: ${embedding.baseUrl}\n`,
  );

  let vector: typeof import('./vector') | undefined;
  try {
    const migrations = await import('./migrations');
    const archiveStore = await import('./session/archiveStore');
    vector = await import('./vector');
    await migrations.runStartupMigrations();
    await archiveStore.writeArchiveMessages([makeRecord('dual-mode', 1, 'local mode alpha')]);
    await archiveStore.writeArchiveBlocks([{
      v: 1,
      kind: 'block',
      sessionId: 'dual-mode',
      agent: 'main',
      id: 1,
      level: 1,
      sourceKind: 'message',
      sourceStart: 1,
      sourceEnd: 1,
      rawStartSeq: 1,
      rawEndSeq: 1,
      summary: 'deterministic block row',
      createdAt: Date.now(),
    }]);

    await vector.init({ useWorker: false });
    await vector.indexSessionArchive('dual-mode', 1);
    const localHits = await vector.search('local mode alpha', 5, false) as any[];
    assert(localHits.some(hit => String(hit.text).includes('local mode alpha')));
    assert.equal(vector.getVectorServiceStatus().mode, 'local');
    await vector.shutdown();

    // Simulate a crash after the Lance block-row commit but before its SQLite
    // checkpoint. The worker retry must replace, not duplicate, the row.
    archiveStore.setVectorCheckpointSync('dual-mode', { lastIndexedBlockId: 0 });
    await archiveStore.writeArchiveMessages([makeRecord('dual-mode', 2, 'worker mode beta')]);
    await vector.init({ useWorker: true });
    assert.equal(vector.getVectorServiceStatus().mode, 'worker');
    assert.ok(vector.getVectorServiceStatus().pid);
    await vector.indexSessionArchive('dual-mode', 2);
    const workerHits = await vector.search('worker mode beta', 5, false) as any[];
    assert(workerHits.some(hit => String(hit.text).includes('worker mode beta')));

    const firstWorkerPid = vector.getVectorServiceStatus().pid;
    assert.ok(firstWorkerPid);
    process.kill(firstWorkerPid!, 'SIGKILL');
    const unavailableDeadline = Date.now() + 2_000;
    while (Date.now() < unavailableDeadline && vector.getVectorServiceStatus().ready) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(vector.getVectorServiceStatus().ready, false);
    await assert.rejects(
      vector.search('worker mode beta', 5, false),
      (error: any) => error?.code === 'VECTOR_UNAVAILABLE' && error?.retryable === true,
    );
    const restartDeadline = Date.now() + 10_000;
    while (Date.now() < restartDeadline) {
      const status = vector.getVectorServiceStatus();
      if (status.ready && status.pid && status.pid !== firstWorkerPid) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const restartedStatus = vector.getVectorServiceStatus();
    assert.equal(restartedStatus.ready, true);
    assert.notEqual(restartedStatus.pid, firstWorkerPid);
    const recoveredHits = await vector.search('worker mode beta', 5, false) as any[];
    assert(recoveredHits.some(hit => String(hit.text).includes('worker mode beta')));
    await vector.shutdown();

    const config = await import('./config');
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(config.DB_DIR);
    const table = await db.openTable('messages_v7');
    const iterator = await (table.query() as any)
      .where("session_id = 'dual-mode' AND memory_kind = 'block'")
      .limit(100)
      .execute();
    const blockRows: any[] = [];
    for await (const batch of iterator) blockRows.push(...batch.toArray());
    assert.equal(blockRows.length, 1, 'checkpoint retry must not duplicate deterministic block rows');
    table.close?.();
    db.close?.();
  } finally {
    await vector?.shutdown();
    await embedding.close();
    await fs.remove(tempRoot);
  }
});
