import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

function makeMessageRecord(sessionId: string, seq: number, role: 'user' | 'model' | 'tool', text: string, timestamp: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp,
    role,
    message: {
      role,
      parts: [{ text }],
      __meta: { seq, timestamp },
    },
  };
}

async function runNodeScript(script: string, env: Record<string, string>) {
  return execFileAsync('node', ['-e', script], {
    env: { ...process.env, ...env },
    cwd: path.resolve(__dirname, '..', '..'),
  });
}

test('archive bootstrap persists import state and skips unchanged jsonl streams on restart', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-import-state-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const config = await import('../config');
  const archiveStoreModulePath = path.resolve(__dirname, 'archiveStore.js');

  await fs.outputFile(
    config.getSessionArchiveLogPath('alpha/session'),
    [
      JSON.stringify(makeMessageRecord('alpha/session', 1, 'user', 'first', 1000)),
      JSON.stringify(makeMessageRecord('alpha/session', 2, 'model', 'second', 2000)),
      '{malformed json line}',
      JSON.stringify(makeMessageRecord('alpha/session', 3, 'tool', 'third', 3000)),
    ].join('\n') + '\n',
  );
  await fs.outputJson(config.SESSIONS_FILE, {
    sessions: {
      'alpha/session': {
        id: 'alpha/session',
        agent: 'alpha',
        meta: { lastMessageTime: 3000 },
      },
    },
  }, { spaces: 2 });

  await runNodeScript(
    `
      const archiveStore = require(${JSON.stringify(archiveStoreModulePath)});
      (async () => {
        await archiveStore.initArchiveStore();
      })().catch((err) => {
        console.error(err && err.stack || String(err));
        process.exit(1);
      });
    `,
    { FOXWARM_DATA_DIR: tempRoot },
  );

  const db = new DatabaseSync(config.ARCHIVE_DB_PATH, { readOnly: true });
  const importState = db.prepare(`
    SELECT session_id, messages_file_size, messages_file_mtime_ms
    FROM archive_import_state
    WHERE session_id = ?
  `).get('alpha/session') as any;
  assert.equal(importState?.session_id, 'alpha/session');
  assert(importState.messages_file_size > 0, 'messages import state should record file size');
  assert(importState.messages_file_mtime_ms > 0, 'messages import state should record file mtime');
  const importedCount = db.prepare('SELECT COUNT(*) AS count FROM archive_messages WHERE session_id = ?').get('alpha/session') as any;
  assert.equal(Number(importedCount.count), 3, 'valid legacy lines should be imported once');
  db.close();

  const secondRun = await runNodeScript(
    `
      const fs = require('fs');
      const fsExtra = require('fs-extra');
      const fail = () => { throw new Error('UNEXPECTED_CREATE_READ_STREAM'); };
      fs.createReadStream = fail;
      fsExtra.createReadStream = fail;
      const archiveStore = require(${JSON.stringify(archiveStoreModulePath)});
      (async () => {
        await archiveStore.initArchiveStore();
        console.log('ok');
      })().catch((err) => {
        console.error(err && err.stack || String(err));
        process.exit(1);
      });
    `,
    { FOXWARM_DATA_DIR: tempRoot },
  );

  assert.match(secondRun.stdout, /ok/);
  assert.doesNotMatch(secondRun.stderr, /UNEXPECTED_CREATE_READ_STREAM/);
});
