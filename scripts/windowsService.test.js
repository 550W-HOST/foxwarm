'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { getControlPath, requestControl, resolveDataRoot, servicePaths } = require('./windowsService');

test('resolveDataRoot follows environment, pointer, then checkout precedence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-windows-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveDataRoot(root, {}), root);
  fs.writeFileSync(path.join(root, 'data_dir'), 'relative-data');
  assert.equal(resolveDataRoot(root, {}), path.join(root, 'relative-data'));
  assert.equal(resolveDataRoot(root, { FOXWARM_DATA_DIR: 'env-data' }), path.join(root, 'env-data'));
});

test('getControlPath is stable and Windows-safe', () => {
  const first = getControlPath('C:\\foxwarm data', 'win32');
  const second = getControlPath('c:\\FOXWARM DATA', 'win32');
  assert.equal(first, second);
  assert.match(first, /^\\\\\.\\pipe\\foxwarm-[a-f0-9]{20}$/);
});

test('servicePaths keeps lifecycle logs under the data root', () => {
  const paths = servicePaths(path.join('C:', 'foxwarm-data'));
  assert.equal(paths.stdoutLog, path.join('C:', 'foxwarm-data', 'state', 'logs', 'foxwarm.stdout.log'));
  assert.equal(paths.stderrLog, path.join('C:', 'foxwarm-data', 'state', 'logs', 'foxwarm.stderr.log'));
});

test('requestControl keeps the pipe open for the server response', async t => {
  const controlPath = getControlPath(`roundtrip-${process.pid}-${Date.now()}`);
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.once('data', command => socket.end(JSON.stringify({ ok: command.trim() === 'status' })));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlPath, resolve);
  });
  t.after(() => server.close());

  assert.deepEqual(await requestControl(controlPath, 'status'), { ok: true });
});
