'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-install-'));
  const bin = path.join(root, 'bin'), app = path.join(root, 'program with spaces'), data = path.join(root, 'data with spaces');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, '.git'), { recursive: true });
  const log = path.join(root, 'commands');
  // Keep the selected test Node when the isolated PATH excludes setup-node's bin.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FOXWARM_DIR: app,
    FOXWARM_DATA_DIR: data, FOXWARM_BRANCH: 'candidate', FOXWARM_TMUX_SESSION: 'installer-fixture', INSTALL_LOG: log };
  function stub(name, content) { fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + content + '\n', { mode: 0o755 }); }
  stub('git', 'printf "git %s\\n" "$*" >> "$INSTALL_LOG"');
  stub('tmux', 'exit 1');
  stub('npm', 'printf "npm %s\\n" "$*" >> "$INSTALL_LOG"; printf synthetic-install-token > "$FOXWARM_DATA_DIR/state/token"');
  stub('dotnet', 'case "$1" in --version) echo "${INSTALL_SDK:-10.0.100}";; --list-runtimes) echo "Microsoft.AspNetCore.App ${INSTALL_RUNTIME:-10.0.1} [fixture]";; *) exit 1;; esac');
  // Consume the piped source before returning the selected compiler result.
  stub('gcc', 'cat > /dev/null\nexit "${INSTALL_GCC_EXIT:-0}"');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function run(overrides = {}) {
    return spawnSync('/bin/bash', [path.join(__dirname, '../install-foxwarm.sh')], {
      cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
  }
  return { root, app, data, bin, log, run };
}
const unix = { skip: process.platform !== 'linux' && 'Linux source-installer qualification' };

test('source installer diagnoses the selected managed SDK/runtime before checkout or dependency changes', unix, t => {
  const f = fixture(t);
  for (const [env, diagnostic] of [
    [{ INSTALL_SDK: '8.0.100' }, /net10.0-capable/],
    [{ INSTALL_RUNTIME: '9.0.1' }, /ASP.NET Core 10 runtime is required/],
  ]) {
    const result = f.run(env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, diagnostic);
    assert(!fs.existsSync(f.log), 'Prerequisite failure must precede checkout/build.');
  }
  fs.rmSync(path.join(f.bin, 'dotnet'));
  // Only the earlier prerequisite stubs are visible; system dotnet must be absent too.
  const missing = f.run({ PATH: f.bin });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\.NET 10 SDK/);
  assert(!fs.existsSync(f.log), 'Missing SDK must precede checkout/build.');
});

test('source installer retains branch, spaced paths, data pointer and OOBE with a compatible later SDK', unix, t => {
  const f = fixture(t);
  const result = f.run({ INSTALL_SDK: '11.0.100' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.app, 'data_dir'), 'utf8'), f.data + '\n');
  const commands = fs.readFileSync(f.log, 'utf8');
  assert.match(commands, /fetch origin candidate/);
  assert.match(commands, /pull --ff-only origin candidate/);
  assert.match(commands, /npm start/);
  assert.match(result.stdout, /#token=synthetic-install-token/);
});

test('source installer diagnoses missing PTY development files before npm startup', unix, t => {
  const f = fixture(t);
  const result = f.run({ INSTALL_GCC_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pty.h and libutil development files/);
  assert(!fs.readFileSync(f.log, 'utf8').includes('npm '));
});
