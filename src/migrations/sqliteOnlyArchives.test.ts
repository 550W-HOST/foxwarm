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

async function run(script: string, dataRoot: string) {
  return execFileAsync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_SYNC_FILE_LOG: '1' } });
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
