import assert from 'node:assert/strict';
import fs from 'fs-extra';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
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

async function startEmbeddingServer(): Promise<{ baseUrl: string; paths: string[]; inputs: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  const inputs: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      paths.push(request.url || '');
      const parsed = JSON.parse(body || '{}');
      const input = String(parsed.input || '');
      inputs.push(input);
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
    paths,
    inputs,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function assertInvalidRuntimeBaseUrlNeverFetches(baseUrl: string): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-invalid-url-'));
  await fs.outputFile(
    path.join(tempRoot, 'state', 'config.yaml'),
    `vector:\n  baseUrl: ${JSON.stringify(baseUrl)}\n`,
  );
  const configModulePath = require.resolve('./config');
  const script = `
let fetchCalls = 0;
global.fetch = async () => { fetchCalls += 1; throw new Error('fetch must not run'); };
try {
  require(${JSON.stringify(configModulePath)});
  console.log(JSON.stringify({ accepted: true, fetchCalls }));
} catch (error) {
  console.log(JSON.stringify({ accepted: false, fetchCalls, message: String(error && error.message || error) }));
}
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
    encoding: 'utf8',
  });
  await fs.remove(tempRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}');
  assert.equal(output.accepted, false);
  assert.equal(output.fetchCalls, 0);
  assert.match(String(output.message), /non-empty absolute http\(s\) URL/);
}

test('invalid credential, query, and fragment API roots fail before any embedding fetch', async () => {
  for (const baseUrl of [
    'https://user@example.test/v1',
    'https://user:pass@example.test/v1',
    'https://example.test/v1?tenant=one',
    'https://example.test/v1#embedding',
  ]) {
    await assertInvalidRuntimeBaseUrlNeverFetches(baseUrl);
  }
});

test('vector facade preserves search behavior and exact API-root embeddings paths in local and child placements', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-service-smoke-'));
  const embedding = await startEmbeddingServer();
  process.env.FOXWARM_DATA_DIR = tempRoot;
  await fs.outputFile(
    path.join(tempRoot, 'state', 'config.yaml'),
    `vector:\n  baseUrl: ${embedding.baseUrl}/openai/v1/\n  lexicalIndex: true\n  hybridSearch: true\n`,
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
    await vector.waitForStartupArchiveVectorBackfill();
    await vector.indexSessionArchive('dual-mode', 1);
    const localHits = await vector.search('local mode alpha', 5, false) as any[];
    assert(localHits.some(hit => String(hit.text).includes('local mode alpha')));
    assert.equal(vector.getVectorServiceStatus().mode, 'local');
    const localDetailed = await vector.searchDetailed('local mode alpha', 5, false, { sessionIds: ['dual-mode'] });
    assert.equal(localDetailed.lexical.coverageComplete, true);
    assert.equal(localDetailed.lexical.used, true);
    await vector.shutdown();
    assert.ok(embedding.paths.length > 0);
    assert.deepEqual([...new Set(embedding.paths)], ['/openai/v1/embeddings']);
    assert.ok(embedding.inputs.includes('[user] local mode alpha'), 'document/index embedding input must remain unchanged');
    assert.ok(embedding.inputs.includes('deterministic block row'), 'block document embedding input must remain unchanged');
    assert.ok(embedding.inputs.includes('Instruct: Retrieve relevant historical conversation context for the query.\nQuery: local mode alpha'));

    // Simulate a crash after the Lance block-row commit but before its SQLite
    // checkpoint. The worker retry must replace, not duplicate, the row.
    archiveStore.setVectorCheckpointSync('dual-mode', { lastIndexedBlockId: 0 });
    await archiveStore.writeArchiveMessages([makeRecord('dual-mode', 2, 'worker mode beta')]);
    await vector.init({ useWorker: true });
    assert.equal(vector.getVectorServiceStatus().mode, 'worker');
    assert.ok(vector.getVectorServiceStatus().pid);
    await vector.waitForStartupArchiveVectorBackfill();
    await vector.indexSessionArchive('dual-mode', 2);
    const workerHits = await vector.search('worker mode beta', 5, false) as any[];
    assert(workerHits.some(hit => String(hit.text).includes('worker mode beta')));
    const workerDetailed = await vector.searchDetailed('worker mode beta', 5, false, { sessionIds: ['dual-mode'] });
    assert.equal(workerDetailed.lexical.coverageComplete, true);
    assert.equal(workerDetailed.lexical.used, true);

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
    await archiveStore.ensureSessionBranch('reset-rpc');
    await archiveStore.writeArchiveMessages([makeRecord('reset-rpc', 1, 'reset rpc lifetime')]);
    await vector.indexSessionArchive('reset-rpc', 1, 0);
    assert.equal((await vector.getArchiveIndexStatus('reset-rpc')).lastIndexedSeq, 1);
    await vector.resetSessionArchiveDerived('reset-rpc');
    const resetStatus = await vector.getArchiveIndexStatus('reset-rpc');
    assert.equal(resetStatus.lastIndexedSeq, 0, 'v4 child-owner reset clears dense checkpoint');
    assert.equal(resetStatus.lexical?.rawLastIndexedSeq, 0, 'v4 child-owner reset clears lexical checkpoint');
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
