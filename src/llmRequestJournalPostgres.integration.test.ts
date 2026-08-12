import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { Pool } from 'pg';
import {
  appendLlmAttemptResult,
  appendLlmAttemptStart,
  beginLlmRequestJournal,
  replaceLlmJournalCreatedAtForTests,
  replaceLlmJournalMessageCountForTests,
  replaceLlmJournalPromptPayloadForTests,
  exportLlmRequestJournalJsonl,
  listLlmRequestJournal,
  reconstructLlmRequest,
  shutdownLlmRequestJournal,
} from './llmRequestJournal';
import { PostgresLlmRequestJournalStore } from './llmRequestJournalPostgresStore';
import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import { getLlmRequestJournalStore } from './llmRequestJournalStoreFactory';

const connectionString = process.env.FOXWARM_POSTGRES_JOURNAL_TEST_URL;
const schema = process.env.FOXWARM_POSTGRES_JOURNAL_TEST_SCHEMA || '';
const enabled = !!connectionString && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema);

async function runNode(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += String(value); });
  child.stderr.on('data', value => { stderr += String(value); });
  await new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))));
  return { stdout, stderr };
}

async function dropSchema(name: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try { await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); }
  finally { await pool.end(); }
}

async function configuredStore(name: string): Promise<PostgresLlmRequestJournalStore> {
  const store = new PostgresLlmRequestJournalStore({ backend: 'postgres', connectionString: connectionString!, connectionStringEnv: 'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema: name, ssl: false, poolMax: 1, connectTimeoutMs: 5000, idleTimeoutMs: 1000 });
  await store.initialize();
  return store;
}

test('PostgreSQL Journal preserves public request/attempt/reconstruction/export and concurrent writers', { skip: !enabled }, async () => {
  await dropSchema(schema);
  const sessionId = `pg_contract_${Date.now()}`;
  const first = await beginLlmRequestJournal({ sessionId, systemPrompt: 'pg-system', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'one' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache' });
  const second = await beginLlmRequestJournal({ sessionId, systemPrompt: 'pg-system', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'one' }] }, { role: 'model', parts: [{ text: 'two' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache' });
  await appendLlmAttemptStart({ requestId: second.requestId, attempt: 1, concreteModelId: 'fixture/model', providerType: 'openai', semanticPayload: { exact: 'payload' } });
  await appendLlmAttemptResult({ requestId: second.requestId, attempt: 1, outcome: 'success', result: { text: 'done' } });
  const reconstructed = await reconstructLlmRequest(second.requestId);
  assert.equal(reconstructed.completeness, 'complete');
  if (reconstructed.completeness === 'complete') {
    assert.equal(reconstructed.messages.length, 2);
    assert.equal(reconstructed.attempts[0].result?.outcome, 'success');
  }
  const page = await listLlmRequestJournal({ sessionId, limit: 1 });
  assert.deepEqual(page.map(item => item.requestId), [second.requestId]);
  await replaceLlmJournalCreatedAtForTests([first.requestId, second.requestId], 1_786_500_000_000);
  const firstPage = await listLlmRequestJournal({ sessionId, limit: 1 });
  const secondPage = await listLlmRequestJournal({ sessionId, limit: 1, before: { createdAt: firstPage[0].createdAt, requestId: firstPage[0].requestId } });
  assert.equal(new Set([...firstPage, ...secondPage].map(item => item.requestId)).size, 2);

  const oldCount = await replaceLlmJournalMessageCountForTests(second.requestId, 99);
  assert.equal((await reconstructLlmRequest(second.requestId)).completeness, 'corrupt');
  await replaceLlmJournalMessageCountForTests(second.requestId, oldCount);
  const oldPrompt = await replaceLlmJournalPromptPayloadForTests(second.requestId, JSON.stringify('tampered'));
  assert.equal((await reconstructLlmRequest(second.requestId)).completeness, 'corrupt');
  await replaceLlmJournalPromptPayloadForTests(second.requestId, oldPrompt);
  assert.equal((await reconstructLlmRequest(second.requestId)).completeness, 'complete');

  const childCode = `const j=require(${JSON.stringify(path.join(__dirname, 'llmRequestJournal.js'))}); Promise.all(Array.from({length:8},(_,i)=>j.beginLlmRequestJournal({sessionId:${JSON.stringify(sessionId)},systemPrompt:'child',toolDefinitions:[],messages:[{role:'user',parts:[{text:'child-'+i}]}],requestedModelKey:'fixture/model',promptCacheKey:'child'}))).then(()=>j.shutdownLlmRequestJournal()).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`;
  await Promise.all([runNode(['-e', childCode]), runNode(['-e', childCode])]);
  const all = await listLlmRequestJournal({ sessionId, limit: 100 });
  assert.equal(all.length, 18);
  assert.equal(new Set(all.map(item => item.requestId)).size, 18);

  const output = path.join(process.env.FOXWARM_DATA_DIR!, 'journal-export.jsonl');
  const report = await exportLlmRequestJournalJsonl(output);
  assert.ok(report.records >= 22);
  const text = await fs.readFile(output, 'utf8');
  assert.match(text, new RegExp(first.requestId));
  await shutdownLlmRequestJournal();
});

test('SQLite to PostgreSQL CLI copy requires empty target and verifies every record', { skip: !enabled }, async () => {
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'migration-source.sqlite');
  await fs.remove(sourcePath);
  const source = new SqliteLlmRequestJournalStore(sourcePath);
  await source.initialize();
  const active = await getLlmRequestJournalStore();
  for (const kind of ['object', 'request', 'attempt-start', 'attempt-result'] as const) {
    let cursor;
    do {
      const page = await active.scanRecords(kind, cursor, 100);
      if (page.records.length) await source.appendRecords(page.records);
      cursor = page.records.length === 100 ? page.next : undefined;
    } while (cursor);
  }
  await source.close();
  const migrationSchema = `${schema}_copy`;
  await dropSchema(migrationSchema);
  const configPath = path.join(process.env.FOXWARM_DATA_DIR!, 'copy-config.yaml');
  await fs.writeFile(configPath, `storage:\n  llmRequestJournal:\n    backend: postgres\n    connectionStringEnv: FOXWARM_POSTGRES_JOURNAL_TEST_URL\n    schema: ${migrationSchema}\n    poolMax: 1\n`);
  const result = await runNode(['scripts/foxwarm.js', 'storage', 'journal', 'copy-sqlite-to-postgres', '--sqlite', sourcePath, '--source-quiesced'], { FOXWARM_CONFIG_PATH: configPath });
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.report.requests >= 18);
  assert.equal(parsed.report.requests, parsed.report.reconstructedRequests);
  const target = await configuredStore(migrationSchema);
  try {
    assert.deepEqual(await target.getCounts(), await (async () => { const check = new SqliteLlmRequestJournalStore(sourcePath, true); await check.initialize(); try { return await check.getCounts(); } finally { await check.close(); } })());
  } finally { await target.close(); }
  await assert.rejects(runNode(['scripts/foxwarm.js', 'storage', 'journal', 'copy-sqlite-to-postgres', '--sqlite', sourcePath, '--source-quiesced'], { FOXWARM_CONFIG_PATH: configPath }), /target is not empty/);
  await dropSchema(migrationSchema);
});

test('newer PostgreSQL Journal schema and unavailable database fail closed without leaking credentials', { skip: !enabled }, async () => {
  const futureSchema = `${schema}_future`;
  await dropSchema(futureSchema);
  const store = await configuredStore(futureSchema);
  await store.setMetadata('schema_version', '999');
  await store.close();
  const future = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:futureSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(future.initialize(), /Unsupported PostgreSQL.*999/);
  await future.close();
  const unavailable = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:'postgres://secret-user:secret-password@127.0.0.1:1/none', connectionStringEnv:'PG', schema:'unavailable', ssl:false, poolMax:1, connectTimeoutMs:250, idleTimeoutMs:250 });
  let error = '';
  try { await unavailable.initialize(); } catch (caught) { error = String(caught); }
  assert.ok(error);
  assert.doesNotMatch(error, /secret-user|secret-password/);
  await unavailable.close();
  await dropSchema(futureSchema);
});
