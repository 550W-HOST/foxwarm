import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';

function runPlacementScript(root: string, body: string): any {
  const result = spawnSync(process.execPath, ['-e', body], {
    cwd: __dirname,
    env: { ...process.env, FOXWARM_DATA_DIR: root },
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const resultLine = result.stdout.trim().split('\n').find(line => line.startsWith('RESULT:'));
  return JSON.parse(resultLine?.slice('RESULT:'.length) || '{}');
}

test('lexical open failure leaves local dense owner ready with bounded dark status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-open-failure-'));
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n');
  await fs.ensureDir(path.join(root, 'state', 'db', 'archive-search.sqlite'));
  const vectorPath = require.resolve('./vector');
  const output = runPlacementScript(root, `
+(async () => {
+  const vector = require(${JSON.stringify(vectorPath)});
+  await vector.init({ useWorker: false });
+  const status = await vector.getArchiveIndexStatus('open-failure/session');
+  console.log('RESULT:' + JSON.stringify({ mode: vector.getVectorServiceStatus().mode, status }));
+  await vector.shutdown();
+})().catch(error => { console.error(error); process.exit(1); });
+`.replace(/^\+/gm, ''));
  assert.equal(output.mode, 'local');
  assert.equal(output.status.lexical.configured, true);
  assert.equal(output.status.lexical.ready, false);
  assert.match(output.status.lexical.lastErrorCode, /ERR_SQLITE_ERROR|EISDIR|LEXICAL_OPEN_FAILED/);
  await fs.remove(root);
});

test('child Vector owner opens and backfills lexical DB while borrowed facade only observes status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lexical-child-owner-'));
  await fs.outputFile(path.join(root, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n  lexicalIndex: true\n');
  const vectorPath = require.resolve('./vector');
  const storePath = require.resolve('./session/archiveStore');
  const output = runPlacementScript(root, `
+(async () => {
+  const store = require(${JSON.stringify(storePath)});
+  await store.ensureSessionBranch('child-owner/session');
+  await store.writeArchiveMessages([{ v: 1, kind: 'message', sessionId: 'child-owner/session', agent: 'main', seq: 1,
+    timestamp: 1, role: 'user', message: { role: 'user', parts: [{ text: 'ChildOwnerToken_1' }], __meta: { seq: 1, timestamp: 1 } } }]);
+  const vector = require(${JSON.stringify(vectorPath)});
+  await vector.init({ useWorker: true });
+  await vector.waitForStartupArchiveVectorBackfill();
+  const status = await vector.getArchiveIndexStatus('child-owner/session');
+  console.log('RESULT:' + JSON.stringify({ mode: vector.getVectorServiceStatus().mode, status }));
+  await vector.shutdown();
+})().catch(error => { console.error(error); process.exit(1); });
+`.replace(/^\+/gm, ''));
  assert.equal(output.mode, 'worker');
  assert.equal(output.status.lexical.ready, true);
  assert.equal(output.status.lexical.rawLastIndexedSeq, 1);
  assert.equal(await fs.pathExists(path.join(root, 'state', 'db', 'archive-search.sqlite')), true);
  await fs.remove(root);
});
