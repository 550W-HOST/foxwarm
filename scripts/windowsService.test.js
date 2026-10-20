'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
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

test('relative and absolute installation roots select the same data, logs and control identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-windows-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = path.relative(process.cwd(), root);
  for (const env of [{}, { FOXWARM_DATA_DIR: 'explicit-data' }, { FOXWARM_DATA_DIR: path.join(root, 'absolute-data') }]) {
    const selected = resolveDataRoot(relative, env);
    assert(path.isAbsolute(selected));
    assert.equal(selected, resolveDataRoot(root, env));
    assert.deepEqual(servicePaths(selected), servicePaths(resolveDataRoot(root, env)));
    assert.equal(getControlPath(selected), getControlPath(resolveDataRoot(root, env)));
    assert.equal(selected, env.FOXWARM_DATA_DIR ? path.resolve(root, env.FOXWARM_DATA_DIR) : root);
  }
  fs.writeFileSync(path.join(root, 'data_dir'), 'pointer-data');
  assert.equal(resolveDataRoot(relative, {}), path.join(root, 'pointer-data'));
  assert.equal(resolveDataRoot(relative, { FOXWARM_DATA_DIR: 'explicit-data' }), path.join(root, 'explicit-data'));
});

test('servicePaths keeps lifecycle logs under the data root', () => {
  const paths = servicePaths(path.join('C:', 'foxwarm-data'));
  assert.equal(paths.stdoutLog, path.join('C:', 'foxwarm-data', 'state', 'logs', 'foxwarm.stdout.log'));
  assert.equal(paths.stderrLog, path.join('C:', 'foxwarm-data', 'state', 'logs', 'foxwarm.stderr.log'));
});

test('Windows installer uses the guarded start lifecycle before dependency installation', () => {
  const root = path.resolve(__dirname, '..');
  const installer = fs.readFileSync(path.join(root, 'install-foxwarm.ps1'), 'utf8');
  const guardIndex = installer.indexOf('node scripts/windowsService.js check-stopped');
  const buildIndex = installer.indexOf('npm run build-all');
  const startIndex = installer.indexOf('node scripts/windowsService.js start');

  assert.ok(guardIndex >= 0, 'installer must check service state');
  assert.ok(guardIndex < buildIndex, 'service-state check must precede dependency installation');
  assert.ok(buildIndex < startIndex, 'service start must follow a successful build');
  assert.match(installer.slice(guardIndex, buildIndex), /if \(\$LASTEXITCODE -ne 0\)/);
});

test('source installers accept the WebUI build Node range before installing dependencies', () => {
  const root = path.resolve(__dirname, '..');
  const versions = [
    ['18.20.0', false], ['20.18.3', false], ['20.19.0', true], ['20.20.0', true],
    ['21.7.3', false], ['22.11.0', false], ['22.12.0', true], ['24.0.0', true],
  ];
  for (const name of ['install-foxwarm.sh', 'install-foxwarm.ps1']) {
    const installer = fs.readFileSync(path.join(root, name), 'utf8');
    const guard = installer.match(/node -e (?:"([^"]+)"|'([^']+)')/);
    assert.ok(guard, `${name} checks Node before cloning or building`);
    assert.ok(installer.indexOf(guard[0]) < installer.indexOf('git clone'));
    for (const [version, supported] of versions) {
      let exitCode;
      runInNewContext(guard[1] || guard[2], { process: { versions: { node: version }, exit(code) { exitCode = code; } } });
      assert.equal(exitCode, supported ? 0 : 1, `${name}: ${version}`);
    }
  }
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
