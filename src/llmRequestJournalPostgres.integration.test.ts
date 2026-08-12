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
import { copySqliteLlmRequestJournalToStore, setLlmJournalCopyFaultInjectorForTests } from './llmRequestJournalMigration';
import { LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH, readLlmRequestJournalCutoverMarker, setLlmRequestJournalCutoverWriteFaultInjectorForTests } from './llmRequestJournalCutover';
import { LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY, LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID } from './llmRequestJournalStore';

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
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'state', 'llm-request-journal.sqlite');
  await fs.remove(sourcePath);
  await fs.remove(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
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
  await source.setMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY, LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID);
  const sourceCounts = await source.getCounts();
  await source.close();
  const migrationSchema = `${schema}_copy`;
  await dropSchema(migrationSchema);
  const configPath = path.join(process.env.FOXWARM_DATA_DIR!, 'copy-config.yaml');
  await fs.writeFile(configPath, `storage:\n  llmRequestJournal:\n    backend: postgres\n    connectionStringEnv: FOXWARM_POSTGRES_JOURNAL_TEST_URL\n    schema: ${migrationSchema}\n    poolMax: 1\n`);
  const result = await runNode(['scripts/foxwarm.js', 'storage', 'journal', 'copy-sqlite-to-postgres', '--sqlite', sourcePath, '--source-quiesced'], { FOXWARM_CONFIG_PATH: configPath });
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.report.requests >= 18);
  assert.equal(parsed.report.requests, parsed.report.reconstructedRequests);
  const markerText = await fs.readFile(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH, 'utf8');
  const markerStat = await fs.stat(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
  const marker = await readLlmRequestJournalCutoverMarker();
  assert.equal(marker?.postgres.schema, migrationSchema);
  assert.equal(markerStat.mode & 0o077, 0);
  assert.doesNotMatch(markerText, /foxwarm_test_password|postgres:\/\//);
  assert.equal((await fs.readdir(path.dirname(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH))).some(name => name.startsWith(`${path.basename(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH)}.`) && name.endsWith('.tmp')), false);
  const retiredSource = new SqliteLlmRequestJournalStore(sourcePath, true);
  await assert.rejects(retiredSource.initialize(), /LLM_JOURNAL_SQLITE_RETIRED/);
  const sqliteConfigPath = path.join(process.env.FOXWARM_DATA_DIR!, 'sqlite-config.yaml');
  await fs.writeFile(sqliteConfigPath, 'storage:\n  llmRequestJournal:\n    backend: sqlite\n');
  await assert.rejects(
    runNode(['-e', `require(${JSON.stringify(path.join(__dirname, 'llmRequestJournal.js'))}).initLlmRequestJournal().then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { FOXWARM_CONFIG_PATH: sqliteConfigPath }),
    /LLM_JOURNAL_SQLITE_RETIRED/,
  );
  const wrongPgConfigPath = path.join(process.env.FOXWARM_DATA_DIR!, 'wrong-pg-config.yaml');
  await fs.writeFile(wrongPgConfigPath, `storage:\n  llmRequestJournal:\n    backend: postgres\n    connectionStringEnv: FOXWARM_POSTGRES_JOURNAL_TEST_URL\n    schema: ${migrationSchema}_wrong\n`);
  await assert.rejects(
    runNode(['-e', `require(${JSON.stringify(path.join(__dirname, 'llmRequestJournal.js'))}).initLlmRequestJournal().then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { FOXWARM_CONFIG_PATH: wrongPgConfigPath }),
    /does not match the completed local cutover marker/,
  );
  const target = await configuredStore(migrationSchema);
  try {
    assert.deepEqual(await target.getCounts(), sourceCounts);
  } finally { await target.close(); }
  await assert.rejects(runNode(['scripts/foxwarm.js', 'storage', 'journal', 'copy-sqlite-to-postgres', '--sqlite', sourcePath, '--source-quiesced'], { FOXWARM_CONFIG_PATH: configPath }), /LLM_JOURNAL_SQLITE_RETIRED/);
  await dropSchema(migrationSchema);
  await assert.rejects(
    runNode(['-e', `require(${JSON.stringify(path.join(__dirname, 'llmRequestJournal.js'))}).initLlmRequestJournal().then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { FOXWARM_CONFIG_PATH: configPath }),
    /authority required by the completed local cutover marker is missing/,
  );
  const authorityPool = new Pool({ connectionString, max: 1 });
  try {
    const absent = await authorityPool.query('SELECT COUNT(*)::int AS count FROM information_schema.schemata WHERE schema_name=$1', [migrationSchema]);
    assert.equal(absent.rows[0].count, 0);
    await authorityPool.query(`CREATE SCHEMA "${migrationSchema}"`);
  } finally { await authorityPool.end(); }
  await assert.rejects(
    runNode(['-e', `require(${JSON.stringify(path.join(__dirname, 'llmRequestJournal.js'))}).initLlmRequestJournal().then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { FOXWARM_CONFIG_PATH: configPath }),
    /authority required by the completed local cutover marker is missing/,
  );
  const emptyPool = new Pool({ connectionString, max: 1 });
  try {
    const tables = await emptyPool.query('SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema=$1', [migrationSchema]);
    assert.equal(tables.rows[0].count, 0);
  } finally { await emptyPool.end(); }
  await dropSchema(migrationSchema);
  await fs.remove(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
});

test('cutover requires the completed active SQLite authority before touching PostgreSQL', { skip: !enabled }, async () => {
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'state', 'llm-request-journal.sqlite');
  await fs.remove(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
  const source = new SqliteLlmRequestJournalStore(sourcePath);
  await source.initialize();
  const originalAuthority = await source.getMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY);
  for (const [suffix, authority] of [['missing', undefined], ['wrong', 'wrong-authority']] as const) {
    if (authority === undefined) {
      source.rawDatabase.prepare('DELETE FROM llm_journal_metadata WHERE key=?').run(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY);
    } else {
      await source.setMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY, authority);
    }
    const targetSchema = `${schema}_source_authority_${suffix}`;
    await dropSchema(targetSchema);
    const target = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:targetSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 });
    await assert.rejects(copySqliteLlmRequestJournalToStore(sourcePath, target, { backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:targetSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 }), /lacks the completed sqlite-only-large-archives-v1 authority marker/);
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const schemas = await pool.query('SELECT COUNT(*)::int AS count FROM information_schema.schemata WHERE schema_name=$1', [targetSchema]);
      assert.equal(schemas.rows[0].count, 0);
    } finally { await pool.end(); }
    assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH), false);
    await target.close();
  }
  await source.setMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY, originalAuthority || LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID);
  await source.close();
});

test('CLI validates SQLite authority before creating the configured PostgreSQL schema', { skip: !enabled }, async () => {
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'state', 'llm-request-journal.sqlite');
  const source = new SqliteLlmRequestJournalStore(sourcePath);
  await source.initialize();
  const originalAuthority = await source.getMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY);
  source.rawDatabase.prepare('DELETE FROM llm_journal_metadata WHERE key=?').run(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY);
  await source.close();
  const targetSchema = `${schema}_cli_source_authority`;
  await dropSchema(targetSchema);
  const configPath = path.join(process.env.FOXWARM_DATA_DIR!, 'cli-authority-config.yaml');
  await fs.writeFile(configPath, `storage:\n  llmRequestJournal:\n    backend: postgres\n    connectionStringEnv: FOXWARM_POSTGRES_JOURNAL_TEST_URL\n    schema: ${targetSchema}\n`);
  await assert.rejects(runNode(['scripts/foxwarm.js', 'storage', 'journal', 'copy-sqlite-to-postgres', '--sqlite', sourcePath, '--source-quiesced'], { FOXWARM_CONFIG_PATH: configPath }), /lacks the completed sqlite-only-large-archives-v1 authority marker/);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const schemas = await pool.query('SELECT COUNT(*)::int AS count FROM information_schema.schemata WHERE schema_name=$1', [targetSchema]);
    assert.equal(schemas.rows[0].count, 0);
  } finally { await pool.end(); }
  const restore = new SqliteLlmRequestJournalStore(sourcePath);
  await restore.initialize();
  await restore.setMetadata(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY, originalAuthority || LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID);
  await restore.close();
});

test('corrupt source and interrupted copy never publish complete authority or a cutover marker', { skip: !enabled }, async () => {
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'state', 'llm-request-journal.sqlite');
  await fs.remove(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
  const source = new SqliteLlmRequestJournalStore(sourcePath);
  await source.initialize();
  const request = (await source.scanRecords('request', undefined, 1)).records[0];
  assert.equal(request?.kind, 'request');
  if (request?.kind !== 'request') throw new Error('fixture request missing');
  const object = await source.getObject(request.promptObjectId);
  assert.ok(object);
  await source.replaceObjectPayloadForTests!(request.requestId, JSON.stringify('corrupt'));
  const corruptSchema = `${schema}_corrupt`;
  await dropSchema(corruptSchema);
  const corruptTarget = await configuredStore(corruptSchema);
  await assert.rejects(copySqliteLlmRequestJournalToStore(sourcePath, corruptTarget, { backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:corruptSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 }), /object hash mismatch/);
  assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH), false);
  await corruptTarget.close();
  await source.replaceObjectPayloadForTests!(request.requestId, object!.payload);
  await source.close();
  await dropSchema(corruptSchema);

  const interruptedSchema = `${schema}_interrupted`;
  await dropSchema(interruptedSchema);
  const interruptedTarget = await configuredStore(interruptedSchema);
  setLlmJournalCopyFaultInjectorForTests((phase) => { if (phase === 'after-object') throw new Error('injected committed-batch failure'); });
  await assert.rejects(copySqliteLlmRequestJournalToStore(sourcePath, interruptedTarget, { backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:interruptedSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 }), /injected committed-batch failure/);
  setLlmJournalCopyFaultInjectorForTests(undefined);
  assert.equal(await interruptedTarget.getMetadata('authority_state'), 'copying');
  assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH), false);
  await interruptedTarget.close();
  const retry = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:interruptedSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(retry.initialize(), /authority state is copying.*fresh empty schema/);
  await retry.close();
  const sourceStillUsable = new SqliteLlmRequestJournalStore(sourcePath, true);
  await sourceStillUsable.initialize();
  assert.ok((await sourceStillUsable.getCounts()).requests > 0);
  await sourceStillUsable.close();
  await dropSchema(interruptedSchema);

  const publicationSchema = `${schema}_publication`;
  await dropSchema(publicationSchema);
  const publicationTarget = await configuredStore(publicationSchema);
  const publicationFailure = new Proxy(publicationTarget as any, {
    get(object, property) {
      if (property === 'completeMigrationCopy') return async () => { throw new Error('injected complete publication failure'); };
      const value = object[property];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  await assert.rejects(copySqliteLlmRequestJournalToStore(sourcePath, publicationFailure, { backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:publicationSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 }), /injected complete publication failure/);
  assert.equal(await publicationTarget.getMetadata('authority_state'), 'copying');
  assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH), false);
  await publicationTarget.close();
  await dropSchema(publicationSchema);
});

test('marked PostgreSQL schema with a missing required table fails closed', { skip: !enabled }, async () => {
  const missingSchema = `${schema}_missing`;
  await dropSchema(missingSchema);
  const initialized = await configuredStore(missingSchema);
  await initialized.close();
  const pool = new Pool({ connectionString, max: 1 });
  try { await pool.query(`DROP TABLE "${missingSchema}".llm_journal_attempt_results`); } finally { await pool.end(); }
  const reopened = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:missingSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(reopened.initialize(), /required table llm_journal_attempt_results is missing/);
  await reopened.close();
  await dropSchema(missingSchema);

  const columnSchema = `${schema}_column`;
  await dropSchema(columnSchema);
  const columnInitialized = await configuredStore(columnSchema);
  await columnInitialized.close();
  const columnPool = new Pool({ connectionString, max: 1 });
  try { await columnPool.query(`ALTER TABLE "${columnSchema}".llm_journal_requests DROP COLUMN message_count`); } finally { await columnPool.end(); }
  const columnReopened = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:columnSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(columnReopened.initialize(), /required column llm_journal_requests.message_count is missing or incompatible/);
  await columnReopened.close();
  await dropSchema(columnSchema);

  const constraintSchema = `${schema}_constraint`;
  await dropSchema(constraintSchema);
  const constraintInitialized = await configuredStore(constraintSchema);
  await constraintInitialized.close();
  const constraintPool = new Pool({ connectionString, max: 1 });
  try { await constraintPool.query(`ALTER TABLE "${constraintSchema}".llm_journal_objects DROP CONSTRAINT llm_journal_objects_pkey`); } finally { await constraintPool.end(); }
  const constraintReopened = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:constraintSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(constraintReopened.initialize(), /required identity constraint llm_journal_objects\(object_id\) is missing or incompatible/);
  await constraintReopened.close();
  await dropSchema(constraintSchema);

  const wrongConstraintSchema = `${schema}_wrong_constraint`;
  await dropSchema(wrongConstraintSchema);
  const wrongConstraintInitialized = await configuredStore(wrongConstraintSchema);
  await wrongConstraintInitialized.close();
  const wrongConstraintPool = new Pool({ connectionString, max: 1 });
  try {
    await wrongConstraintPool.query(`ALTER TABLE "${wrongConstraintSchema}".llm_journal_requests DROP CONSTRAINT llm_journal_requests_pkey`);
    await wrongConstraintPool.query(`ALTER TABLE "${wrongConstraintSchema}".llm_journal_requests ADD CONSTRAINT replacement_request_identity UNIQUE(request_id,created_at)`);
  } finally { await wrongConstraintPool.end(); }
  const wrongConstraintReopened = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:wrongConstraintSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(wrongConstraintReopened.initialize(), /required identity constraint llm_journal_requests\(request_id\) is missing or incompatible/);
  await wrongConstraintReopened.close();
  await dropSchema(wrongConstraintSchema);

  const deferrableSchema = `${schema}_deferrable_constraint`;
  await dropSchema(deferrableSchema);
  const deferrableInitialized = await configuredStore(deferrableSchema);
  await deferrableInitialized.close();
  const deferrablePool = new Pool({ connectionString, max: 1 });
  try {
    await deferrablePool.query(`ALTER TABLE "${deferrableSchema}".llm_journal_objects DROP CONSTRAINT llm_journal_objects_pkey`);
    await deferrablePool.query(`ALTER TABLE "${deferrableSchema}".llm_journal_objects ADD CONSTRAINT replacement_object_identity UNIQUE(object_id) DEFERRABLE INITIALLY IMMEDIATE`);
  } finally { await deferrablePool.end(); }
  const deferrableReopened = new PostgresLlmRequestJournalStore({ backend:'postgres', connectionString:connectionString!, connectionStringEnv:'PG', schema:deferrableSchema, ssl:false, poolMax:1, connectTimeoutMs:1000, idleTimeoutMs:1000 });
  await assert.rejects(deferrableReopened.initialize(), /required identity constraint llm_journal_objects\(object_id\) is missing or incompatible/);
  await deferrableReopened.close();
  await dropSchema(deferrableSchema);
});

test('cutover marker publication failure does not retire SQLite or report success', { skip: !enabled }, async () => {
  const markerSchema = `${schema}_marker_fail`;
  const sourcePath = path.join(process.env.FOXWARM_DATA_DIR!, 'state', 'llm-request-journal.sqlite');
  await fs.remove(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH);
  await dropSchema(markerSchema);
  const target = await configuredStore(markerSchema);
  setLlmRequestJournalCutoverWriteFaultInjectorForTests(() => { throw new Error('injected marker publication failure'); });
  await assert.rejects(copySqliteLlmRequestJournalToStore(sourcePath, target, { backend:'postgres', connectionString:connectionString!, connectionStringEnv:'FOXWARM_POSTGRES_JOURNAL_TEST_URL', schema:markerSchema, ssl:false, poolMax:1, connectTimeoutMs:5000, idleTimeoutMs:1000 }), /cutover was not finalized.*fresh PostgreSQL schema/);
  setLlmRequestJournalCutoverWriteFaultInjectorForTests(undefined);
  assert.equal(await target.getMetadata('authority_state'), 'complete');
  assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_CUTOVER_MARKER_PATH), false);
  const source = new SqliteLlmRequestJournalStore(sourcePath, true);
  await source.initialize();
  assert.ok((await source.getCounts()).requests > 0);
  await source.close();
  await target.close();
  await dropSchema(markerSchema);
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
