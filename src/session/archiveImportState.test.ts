import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function makeMessageRecord(sessionId: string, seq: number, role: 'user' | 'model' | 'tool', text: string, timestamp: number) {
  return { v: 1, kind: 'message', sessionId, agent: 'test-agent', seq, timestamp, role, message: { role, parts: [{ text }], __meta: { seq, timestamp } } };
}

async function runMigration(modulePath: string, dataRoot: string) {
  return execFileAsync('node', ['-e', `const m=require(${JSON.stringify(modulePath)});m.runSqliteOnlyArchivesMigration().then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.message);process.exit(1)})`], {
    env: { ...process.env, FOXWARM_DATA_DIR: dataRoot }, cwd: path.resolve(__dirname, '..', '..'),
  });
}

test('strict SQLite-only migration fails closed on malformed JSONL and retries after repair', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-migration-retry-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  const config = await import('../config');
  const migrationsPath = path.resolve(__dirname, '..', 'migrations', 'sqliteOnlyArchives.js');
  const archivePath = config.getSessionArchiveLogPath('alpha/session');
  const valid = [
    JSON.stringify(makeMessageRecord('alpha/session', 1, 'user', 'first', 1000)),
    JSON.stringify(makeMessageRecord('alpha/session', 2, 'model', 'second', 2000)),
  ];
  await fs.outputFile(archivePath, `${valid.join('\n')}\n{malformed`);
  await fs.outputJson(config.SESSIONS_FILE, { sessions: { 'alpha/session': { id: 'alpha/session', agent: 'alpha' } } });

  await assert.rejects(runMigration(migrationsPath, tempRoot), /Malformed legacy session archive line/);
  assert.equal(await fs.pathExists(archivePath), true, 'unverifiable source must remain active');
  const version = await fs.readJson(path.join(tempRoot, 'state', 'migrationVersion.json')).catch(() => ({ migrations: {} }));
  assert.equal(version.migrations?.['sqlite-only-large-archives-v1'], undefined);

  await fs.outputFile(archivePath, `${valid.join('\n')}\n`);
  const completed = await runMigration(migrationsPath, tempRoot);
  assert.match(completed.stdout, /"failedFiles":0/);
  assert.equal(await fs.pathExists(archivePath), false);
  const backup = path.join(tempRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1', 'logs', 'sessions', 'alpha', 'session.jsonl');
  assert.equal(await fs.pathExists(backup), true);
  const manifest = await fs.readJson(path.join(tempRoot, 'state', 'migration-backup', 'sqlite-only-large-archives-v1', 'manifest.json'));
  assert.equal(manifest.files[0].sha256.length, 64);
  assert.equal(manifest.files[0].recordCount, 2);

  const second = await runMigration(migrationsPath, tempRoot);
  assert.match(second.stdout, /"skippedByVersion":true/);
});
