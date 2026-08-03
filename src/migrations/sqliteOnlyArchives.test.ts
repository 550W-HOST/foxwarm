import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..', '..');
const migrationModule = path.resolve(__dirname, 'sqliteOnlyArchives.js');
const journalModule = path.resolve(__dirname, '..', 'llmRequestJournal.js');

function messageRecord(sessionId: string, text: string) {
  return { v: 1, kind: 'message', sessionId, agent: 'main', seq: 1, timestamp: 1, role: 'user', message: { role: 'user', parts: [{ text }], __meta: { seq: 1, timestamp: 1 } } };
}

function tornConcatenatedMessageLine(suffix: ReturnType<typeof messageRecord>, prefixText = 'unrecoverable-prefix'): string {
  const prefix = JSON.stringify({ ...suffix, timestamp: 0, role: 'model', message: { role: 'model', parts: [{ text: prefixText }], __meta: { seq: suffix.seq, timestamp: 0 } } });
  return `${prefix.slice(0, -12)}${JSON.stringify(suffix)}\n`;
}

async function run(script: string, dataRoot: string) {
  return execFileAsync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_SYNC_FILE_LOG: '1' } });
}

async function primeCurrentMessageImportState(dataRoot: string, branches: Array<{ sessionId: string; parentSessionId?: string }>): Promise<void> {
  await run(`
    const fs=require('fs-extra');const {DatabaseSync}=require('node:sqlite');const c=require('./lib/config');const s=require('./lib/session/archiveStore');
    s.initArchiveStoreSync();const db=new DatabaseSync(c.ARCHIVE_DB_PATH);const now=Date.now();
    for(const branch of ${JSON.stringify(branches)}){db.prepare('INSERT INTO archive_branches(session_id,parent_session_id,fork_message_seq,fork_block_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(branch.sessionId,branch.parentSessionId||null,0,0,now,now);const stat=fs.statSync(c.getSessionArchiveLogPath(branch.sessionId));db.prepare('INSERT INTO archive_import_state(session_id,messages_file_size,messages_file_mtime_ms,blocks_file_size,blocks_file_mtime_ms,updated_at) VALUES(?,?,?,?,?,?)').run(branch.sessionId,stat.size,Math.floor(stat.mtimeMs),-1,0,now)}db.close();
  `, dataRoot);
}

test('LLM legacy JSONL is strictly imported, verified, archived, and reconstructable', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-llm-migration-'));
  const result = await run(`
    const fs=require('fs-extra');const j=require(${JSON.stringify(journalModule)});const m=require(${JSON.stringify(migrationModule)});
    (async()=>{const r=await j.beginLlmRequestJournal({sessionId:'s',systemPrompt:'p',toolDefinitions:[],messages:[{role:'user',parts:[{text:'legacy'}]}],requestedModelKey:'fixture/model',promptCacheKey:'c'});await j.exportLlmRequestJournalJsonl(j.LLM_REQUEST_JOURNAL_JSONL_PATH);j.resetLlmRequestJournalForTests();for(const x of ['', '-wal','-shm'])await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH+x);await m.runSqliteOnlyArchivesMigration();const rebuilt=await j.reconstructLlmRequest(r.requestId);if(rebuilt.completeness!=='complete')throw new Error(JSON.stringify(rebuilt));console.log(r.requestId)})().catch(e=>{console.error(e.stack);process.exit(1)});`, dataRoot);
  const requestId = result.stdout.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] || '';
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.equal(await fs.pathExists(path.join(dataRoot, 'state', 'llm-request-journal.jsonl')), false);
  assert.equal(await fs.pathExists(path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1', 'llm-request-journal.jsonl')), true);
});

test('normal session archive runtime is SQLite-only and exports JSONL on demand', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-sqlite-only-'));
  const output = path.join(dataRoot, 'export');
  await fs.outputFile(path.join(output, 'stale.jsonl'), 'stale');
  await run(`const fs=require('fs-extra');const c=require('./lib/config');const a=require('./lib/session/archive');const s=require('./lib/session/archiveStore');(async()=>{const x={id:'runtime',agent:'main',history:[],contextFrontier:[],nextMessageSeq:1};await a.appendMessagesToArchive(x,[{role:'user',parts:[{text:'sqlite only'}]}]);if(await fs.pathExists(c.getSessionArchiveLogPath('runtime')))throw new Error('runtime JSONL created');const r=await s.exportSessionArchivesJsonl(${JSON.stringify(output)});if(r.records!==1)throw new Error(JSON.stringify(r))})().catch(e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  assert.match(await fs.readFile(path.join(output, 'runtime.jsonl'), 'utf8'), /sqlite only/);
  assert.equal(await fs.pathExists(path.join(output, 'stale.jsonl')), false);
});

test('migration preserves an established root branch when metadata heuristics claim a parent', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-established-lineage-'));
  const result = await run(`
    const fs=require('fs-extra');const c=require('./lib/config');const a=require('./lib/session/archive');const s=require('./lib/session/archiveStore');const m=require(${JSON.stringify(migrationModule)});
    (async()=>{await s.ensureSessionBranch('historical_parent');const x={id:'historical_child',agent:'main',history:[],contextFrontier:[],nextMessageSeq:1};await a.appendMessagesToArchive(x,[{role:'user',parts:[{text:'local established history'}]}]);const exported=c.getSessionArchiveLogPath('historical_child')+'.export';await s.exportSessionArchivesJsonl(exported);await fs.copy(exported+'/historical_child.jsonl',c.getSessionArchiveLogPath('historical_child'));await fs.remove(exported);await fs.outputJson(c.SESSIONS_FILE,{sessions:{historical_parent:{id:'historical_parent'},historical_child:{id:'historical_child',parentSessionId:'historical_parent'}}});await m.runSqliteOnlyArchivesMigration();const branch=await s.getSessionBranch('historical_child');if(!branch||branch.parentSessionId!==undefined)throw new Error('established branch was rewritten: '+JSON.stringify(branch));const rows=await s.readLocalArchiveMessages('historical_child');if(rows[0]?.message?.parts?.[0]?.text!=='local established history')throw new Error('history changed');console.log('preserved')})().catch(e=>{console.error(e.stack);process.exit(1)});`, dataRoot);
  assert.match(result.stdout, /preserved/);
});

test('malformed LLM legacy JSONL fails closed and remains active', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-llm-migration-malformed-'));
  const source = path.join(dataRoot, 'state', 'llm-request-journal.jsonl');
  await fs.outputFile(source, '{"v":1,"kind":"request"');
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), /Malformed legacy LLM request journal JSONL/);
  assert.equal(await fs.pathExists(source), true);
  const version = await fs.readJson(path.join(dataRoot, 'state', 'migrationVersion.json')).catch(() => ({ migrations: {} }));
  assert.equal(version.migrations?.['sqlite-only-large-archives-v1'], undefined);
});

test('structurally invalid session messages and blocks are never imported or moved', async () => {
  for (const fixture of [
    { name: 'message', file: 'invalid.jsonl', record: { ...messageRecord('invalid', 'valid'), message: 'THIS IS NOT A MESSAGE OBJECT' }, expected: 'Invalid legacy session message record' },
    { name: 'block', file: 'invalid.blocks.jsonl', record: { v: 1, kind: 'block', sessionId: 'invalid', agent: 'main', id: 1, level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1, summary: 42, createdAt: 1 }, expected: 'Invalid legacy session block record' },
  ]) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-invalid-${fixture.name}-`));
    const source = path.join(dataRoot, 'state', 'logs', 'sessions', fixture.file);
    await fs.outputFile(source, `${JSON.stringify(fixture.record)}\n`);
    await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { parent: { id: 'parent' }, invalid: { id: 'invalid', parentSessionId: 'parent' } } });
    await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), new RegExp(fixture.expected));
    assert.equal(await fs.pathExists(source), true);
    if (fixture.name === 'message') {
      await fs.outputFile(source, `${JSON.stringify(messageRecord('invalid', 'repaired'))}\n`);
      const retried = await run(`const m=require(${JSON.stringify(migrationModule)});const s=require('./lib/session/archiveStore');m.runSqliteOnlyArchivesMigration().then(async()=>{const b=await s.getSessionBranch('invalid');if(b?.parentSessionId!=='parent')throw new Error('repaired fork lineage was not inferred: '+JSON.stringify(b));console.log('retried')},e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
      assert.match(retried.stdout, /retried/);
    }
  }
});

test('migration narrowly recovers one canonical message appended after a torn matching prefix', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-single-'));
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'recover.jsonl');
  const suffix = messageRecord('recover', 'recovered suffix');
  const raw = tornConcatenatedMessageLine(suffix);
  await fs.outputFile(source, raw);
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { recover: { id: 'recover' } } });
  await primeCurrentMessageImportState(dataRoot, [{ sessionId: 'recover' }]);
  const result = await run(`const m=require(${JSON.stringify(migrationModule)});const s=require('./lib/session/archiveStore');m.runSqliteOnlyArchivesMigration().then(async()=>{const rows=await s.readLocalArchiveMessages('recover');if(rows.length!==1||rows[0].message.parts[0]?.text!=='recovered suffix')throw new Error(JSON.stringify(rows));console.log('recovered')},e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  assert.match(result.stdout, /recovered/);
  const backupRoot = path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1');
  assert.equal(await fs.readFile(path.join(backupRoot, 'logs', 'sessions', 'recover.jsonl'), 'utf8'), raw);
  const manifest = await fs.readJson(path.join(backupRoot, 'manifest.json'));
  assert.deepEqual(manifest.audit, { recoveredLogicalRecordCount: 1, insertedRecoveredLogicalRecordCount: 1, tornPrefixCount: 1 });
  assert.equal(manifest.files.find((file: any) => file.relativeStatePath.endsWith('recover.jsonl')).recoveredRecords[0].seq, 1);
});

test('ordinary legacy bootstrap never inserts a torn-concatenated suffix', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-bootstrap-boundary-'));
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'bootstrap.jsonl');
  await fs.outputFile(source, tornConcatenatedMessageLine(messageRecord('bootstrap', 'migration only')));
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { bootstrap: { id: 'bootstrap' } } });
  const result = await run(`const s=require('./lib/session/archiveStore');(async()=>{await s.initArchiveStore();const rows=await s.readLocalArchiveMessages('bootstrap');if(rows.length!==0)throw new Error('bootstrap inserted provisional recovery');console.log('absent')})().catch(e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  assert.match(result.stdout, /absent/);
  assert.equal(await fs.pathExists(source), true);
});

test('migration-only lineage inference counts a copied recovered parent suffix without bootstrap row insertion', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-fork-cap-'));
  const withSeq = (sessionId: string, text: string, seq: number) => ({
    ...messageRecord(sessionId, text), seq, timestamp: seq,
    message: { role: 'user', parts: [{ text }], __meta: { seq, timestamp: seq } },
  });
  const parentOne = withSeq('parent', 'parent one', 1);
  const parentTwo = withSeq('parent', 'recovered parent two', 2);
  const childThree = withSeq('child', 'child local three', 3);
  const recoveredLine = tornConcatenatedMessageLine(parentTwo);
  await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'parent.jsonl'), `${JSON.stringify(parentOne)}\n${recoveredLine}`);
  await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'child.jsonl'), `${JSON.stringify(parentOne)}\n${recoveredLine}${JSON.stringify(childThree)}\n`);
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { parent: { id: 'parent' }, child: { id: 'child', parentSessionId: 'parent' } } });
  const result = await run(`const m=require(${JSON.stringify(migrationModule)});const s=require('./lib/session/archiveStore');m.runSqliteOnlyArchivesMigration().then(async()=>{const branch=await s.getSessionBranch('child');if(branch?.forkMessageSeq!==2)throw new Error('wrong fork cap: '+JSON.stringify(branch));const rows=await s.readEffectiveArchiveMessages('child');const texts=rows.map(r=>r.message.parts[0]?.text);if(JSON.stringify(texts)!==JSON.stringify(['parent one','recovered parent two','child local three']))throw new Error('wrong effective history: '+JSON.stringify(texts));console.log('cap2')},e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  assert.match(result.stdout, /cap2/);
  const manifest = await fs.readJson(path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1', 'manifest.json'));
  assert.deepEqual(manifest.audit, { recoveredLogicalRecordCount: 1, insertedRecoveredLogicalRecordCount: 1, tornPrefixCount: 2 });
});

test('fresh migration insertion is durably audited as a recovered SQLite row', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-fresh-'));
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'fresh.jsonl');
  await fs.outputFile(source, tornConcatenatedMessageLine(messageRecord('fresh', 'fresh recovered suffix')));
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { fresh: { id: 'fresh' } } });
  await run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  const manifest = await fs.readJson(path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1', 'manifest.json'));
  assert.deepEqual(manifest.audit, { recoveredLogicalRecordCount: 1, insertedRecoveredLogicalRecordCount: 1, tornPrefixCount: 1 });
  const markerResult = await run(`const {DatabaseSync}=require('node:sqlite');const c=require('./lib/config');const db=new DatabaseSync(c.ARCHIVE_DB_PATH,{readOnly:true});console.log(db.prepare("SELECT count(*) n FROM archive_store_metadata WHERE key LIKE 'migration_recovered_torn_message:%'").get().n)`, dataRoot);
  assert.match(markerResult.stdout, /1/);
});

test('retry fails if a marker-backed recovered row diverges after an earlier migration failure', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-retry-divergence-'));
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'retry.jsonl');
  await fs.outputFile(source, tornConcatenatedMessageLine(messageRecord('retry', 'marker-backed suffix')));
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { retry: { id: 'retry' } } });
  await primeCurrentMessageImportState(dataRoot, [{ sessionId: 'retry' }]);
  const malformedLlm = path.join(dataRoot, 'state', 'llm-request-journal.jsonl');
  await fs.outputFile(malformedLlm, '{"v":1,"kind":"request"');
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), /Malformed legacy LLM request journal JSONL/);
  await run(`const {DatabaseSync}=require('node:sqlite');const c=require('./lib/config');const db=new DatabaseSync(c.ARCHIVE_DB_PATH);db.prepare('UPDATE archive_messages SET message_json=? WHERE session_id=? AND seq=?').run(JSON.stringify({role:'user',parts:[{text:'diverged'}],__meta:{seq:1,timestamp:1}}),'retry',1);db.close()`, dataRoot);
  await fs.remove(malformedLlm);
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), /Recovered torn-message row no longer matches its durable marker/);
  assert.equal(await fs.pathExists(source), true);
});

test('generic malformed concatenation remains fail-closed when suffix identity does not match the torn prefix', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-torn-prefix-mismatch-'));
  const prefixRecord = messageRecord('mismatch', 'prefix');
  const prefix = JSON.stringify(prefixRecord).slice(0, -12);
  const mismatchedSuffix = { ...messageRecord('mismatch', 'wrong seq'), seq: 2, message: { role: 'user', parts: [{ text: 'wrong seq' }], __meta: { seq: 2, timestamp: 1 } } };
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'mismatch.jsonl');
  await fs.outputFile(source, `${prefix}${JSON.stringify(mismatchedSuffix)}\n`);
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { mismatch: { id: 'mismatch' } } });
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), /Malformed legacy session archive line/);
  assert.equal(await fs.pathExists(source), true);
});

test('duplicated fork copies recover deterministically and divergent recovered payloads fail closed', async () => {
  const createFixture = async (divergent: boolean) => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-torn-prefix-copy-${divergent ? 'bad' : 'ok'}-`));
    const rootRecord = messageRecord('root', 'shared recovered suffix');
    const childRecord = divergent ? messageRecord('root', 'divergent suffix') : rootRecord;
    await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'root.jsonl'), tornConcatenatedMessageLine(rootRecord));
    await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'child.jsonl'), tornConcatenatedMessageLine(childRecord, 'copied-prefix'));
    await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { root: { id: 'root' }, child: { id: 'child', parentSessionId: 'root' } } });
    return dataRoot;
  };

  const matchingRoot = await createFixture(false);
  await primeCurrentMessageImportState(matchingRoot, [{ sessionId: 'root' }, { sessionId: 'child', parentSessionId: 'root' }]);
  await run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.stack);process.exit(1)})`, matchingRoot);
  const matchingBackup = path.join(matchingRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1');
  const matchingManifest = await fs.readJson(path.join(matchingBackup, 'manifest.json'));
  assert.deepEqual(matchingManifest.audit, { recoveredLogicalRecordCount: 1, insertedRecoveredLogicalRecordCount: 1, tornPrefixCount: 2 });
  assert.equal((await fs.readFile(path.join(matchingBackup, 'logs', 'sessions', 'root.jsonl'), 'utf8')).includes('shared recovered suffix'), true);
  assert.equal((await fs.readFile(path.join(matchingBackup, 'logs', 'sessions', 'child.jsonl'), 'utf8')).includes('shared recovered suffix'), true);

  const divergentRoot = await createFixture(true);
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, divergentRoot), /Divergent recovered legacy session message root#1/);
  assert.equal(await fs.pathExists(path.join(divergentRoot, 'state', 'logs', 'sessions', 'root.jsonl')), true);
  assert.equal(await fs.pathExists(path.join(divergentRoot, 'state', 'logs', 'sessions', 'child.jsonl')), true);
});

test('interrupted source movement is restored and retried from the durable manifest', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-migration-crash-'));
  const source = path.join(dataRoot, 'state', 'logs', 'sessions', 'crash.jsonl');
  const backupRoot = path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1');
  const backup = path.join(backupRoot, 'logs', 'sessions', 'crash.jsonl');
  const content = `${JSON.stringify(messageRecord('crash', 'recover'))}\n`;
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  await fs.outputFile(backup, content);
  await fs.outputJson(path.join(backupRoot, 'manifest.json'), {
    v: 1, migrationId: 'sqlite-only-large-archives-v1', createdAt: 1,
    files: [{ filePath: source, relativeStatePath: 'logs/sessions/crash.jsonl', kind: 'messages', sha256: digest, recordCount: 1, backupPath: backup, moved: true }],
  });
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { crash: { id: 'crash' } } });
  await run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  assert.equal(await fs.pathExists(source), false);
  assert.equal(await fs.pathExists(backup), true);
  const manifest = await fs.readJson(path.join(backupRoot, 'manifest.json'));
  assert.equal(manifest.completedAt > 0, true);
  assert.equal('filePath' in manifest.files[0], false);
  assert.equal('backupPath' in manifest.files[0], false);
});

test('migration manifest paths are resolved only inside the current data and backup roots', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-manifest-containment-'));
  const outside = path.join(dataRoot, 'outside-marker');
  await fs.outputFile(outside, 'keep');
  const backupRoot = path.join(dataRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1');
  await fs.outputJson(path.join(backupRoot, 'manifest.json'), {
    v: 1, migrationId: 'sqlite-only-large-archives-v1', createdAt: 1,
    files: [{ relativeStatePath: '../outside-marker', kind: 'messages', sha256: crypto.createHash('sha256').update('keep').digest('hex'), recordCount: 1, moved: true }],
  });
  await assert.rejects(run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().catch(e=>{console.error(e.message);process.exit(1)})`, dataRoot), /Unsafe migration relative path/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});

test('conflicting legacy primary keys fail closed without moving the source', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-migration-conflict-'));
  const first = messageRecord('conflict', 'first');
  const second = { ...messageRecord('conflict', 'second'), timestamp: 2, message: { role: 'user', parts: [{ text: 'second' }], __meta: { seq: 1, timestamp: 2 } } };
  await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'conflict.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { conflict: { id: 'conflict' } } });
  const result = await run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().then(()=>{throw new Error('unexpected success')}).catch(e=>{if(!String(e.message).includes('Conflicting legacy session message'))throw e;console.log('blocked')})`, dataRoot);
  assert.match(result.stdout, /blocked/);
  assert.equal(await fs.pathExists(path.join(dataRoot, 'state', 'logs', 'sessions', 'conflict.jsonl')), true);
});

test('migration lock serializes concurrent migration processes', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-migration-concurrent-'));
  await fs.outputFile(path.join(dataRoot, 'state', 'logs', 'sessions', 'same.jsonl'), `${JSON.stringify(messageRecord('same', 'one'))}\n`);
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions.json'), { sessions: { same: { id: 'same' } } });
  const script = `const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.stack);process.exit(1)})`;
  const [first, second] = await Promise.all([run(script, dataRoot), run(script, dataRoot)]);
  const outputs = `${first.stdout}\n${second.stdout}`;
  assert.match(outputs, /"skippedByVersion":false/);
  assert.match(outputs, /"skippedByVersion":true/);
});

test('migration waits behind a live lock owner even when its recorded age exceeds the former deadline', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-migration-live-lock-'));
  const lockPath = path.join(dataRoot, 'state', 'sqlite-only-large-archives-v1.lock');
  await fs.outputJson(lockPath, { pid: process.pid, createdAt: Date.now() - 60_000 });
  const pending = run(`const m=require(${JSON.stringify(migrationModule)});m.runSqliteOnlyArchivesMigration().then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.stack);process.exit(1)})`, dataRoot);
  await new Promise(resolve => setTimeout(resolve, 100));
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await fs.remove(lockPath);
  const result = await pending;
  assert.match(result.stdout, /"skippedByVersion":false/);
});
