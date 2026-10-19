'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmuxProbe = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
const skip = process.platform === 'win32' || tmuxProbe.status !== 0
  ? 'Requires Bash and tmux'
  : false;
const scriptsDir = __dirname;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-tmux-'));
  const socket = path.join(root, 'socket');
  const app = path.join(root, "app ' $ directory");
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'starts');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(log);
  for (const name of ['start.sh', 'restart.sh']) {
    fs.copyFileSync(path.join(scriptsDir, name), path.join(app, 'scripts', name));
  }
  const tmuxBin = spawnSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TMUX: '',
    TEST_TMUX_BIN: tmuxBin,
    TEST_TMUX_SOCKET: socket,
    TEST_START_LOG: log,
    FOXWARM_TMUX_SESSION: 'foxwarm',
    FOXWARM_NODE_BIN: path.join(bin, "node ' $ stub"),
    FOXWARM_DATA_DIR: path.join(root, "data ' $ directory"),
  };
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
if [ -n "\${TEST_FAIL_SEND:-}" ] && [ "$1" = send-keys ]; then exit 1; fi
"$TEST_TMUX_BIN" -S "$TEST_TMUX_SOCKET" -f /dev/null "$@" || exit $?
if [ -n "\${TEST_RENAME_ON_INTERRUPT:-}" ] && [ "$1" = send-keys ] && [ "\${@: -1}" = C-c ]; then
    "$TEST_TMUX_BIN" -S "$TEST_TMUX_SOCKET" rename-window -t "$3" bash
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nexit "${TEST_BUILD_STATUS:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(env.FOXWARM_NODE_BIN, `#!/bin/bash
printf '%s\\n' "$TMUX_PANE" "$PWD" "$FOXWARM_DATA_DIR" "$@" > "$TEST_START_LOG/$TMUX_PANE"
sleep 300
`, { mode: 0o755 });

  function tmux(...args) {
    const result = spawnSync(tmuxBin, ['-S', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  t.after(() => {
    spawnSync(tmuxBin, ['-S', socket, 'kill-server']);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // This private server never reads the user's config or uses the default socket.
  tmux('new-session', '-d', '-s', 'fixture');
  tmux('set-option', '-g', 'default-shell', '/bin/bash');
  tmux('set-option', '-g', 'automatic-rename', 'off');
  tmux('set-environment', '-g', 'TEST_START_LOG', log);

  return {
    env, tmux,
    targetPane() {
      const windows = tmux('list-windows', '-t', '=foxwarm', '-F', '#{window_name} #{pane_id}').split('\n');
      const target = windows.find(window => window.startsWith('foxwarm '));
      assert.ok(target, `Exact foxwarm window missing: ${windows}`);
      return target.slice('foxwarm '.length);
    },
    async guard(pane) {
      tmux('send-keys', '-t', pane, 'sleep 300', 'Enter');
      const deadline = Date.now() + 3000;
      while (tmux('display-message', '-p', '-t', pane, '#{pane_current_command}') !== 'sleep') {
        assert.ok(Date.now() < deadline, `Guard process not running in ${pane}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    run(name, extraEnv = {}) {
      return spawnSync('bash', [path.join(app, 'scripts', name)], {
        env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000,
      });
    },
    async started(pane) {
      const file = path.join(log, pane);
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(file) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(fs.existsSync(file), `Startup not received by ${pane}`);
      assert.deepEqual(fs.readFileSync(file, 'utf8').trimEnd().split('\n'), [
        pane, app, env.FOXWARM_DATA_DIR, 'lib/index.js',
      ]);
    },
    assertUntouched(pane) {
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_current_command}'), 'sleep');
      assert.ok(!fs.existsSync(path.join(log, pane)), `Startup sent to unrelated pane ${pane}`);
      assert.ok(!tmux('capture-pane', '-p', '-t', pane).includes('lib/index.js'));
    },
  };
}

for (const script of ['start.sh', 'restart.sh']) {
  test(`${script} creates the exact session beside a prefix-only session`, { skip }, async t => {
    const f = fixture(t);
    const other = f.tmux('new-session', '-d', '-s', 'foxwarm-cli-node', '-n', 'foxwarm', '-P', '-F', '#{pane_id}');
    await f.guard(other);
    const result = f.run(script);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const pane = f.targetPane();
    assert.notEqual(pane, other);
    await f.started(pane);
    f.assertUntouched(other);
  });
}

test('restart creates a dedicated window when only a CLI Node window exists', { skip }, async t => {
  const f = fixture(t);
  const other = f.tmux('new-session', '-d', '-s', 'foxwarm', '-n', 'foxwarm-cli-node', '-P', '-F', '#{pane_id}');
  await f.guard(other);
  const result = f.run('restart.sh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pane = f.targetPane();
  assert.notEqual(pane, other);
  await f.started(pane);
  f.assertUntouched(other);
});

test('restart keeps the exact pane after its window renames beside a CLI Node window', { skip }, async t => {
  const f = fixture(t);
  const inactive = f.tmux('new-session', '-d', '-s', 'foxwarm', '-n', 'foxwarm', '-P', '-F', '#{pane_id}');
  const pane = f.tmux('split-window', '-t', inactive, '-P', '-F', '#{pane_id}');
  const other = f.tmux('new-window', '-d', '-t', '=foxwarm:', '-n', 'foxwarm-cli-node', '-P', '-F', '#{pane_id}');
  await f.guard(inactive);
  await f.guard(other);
  const result = f.run('restart.sh', { TEST_RENAME_ON_INTERRUPT: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.tmux('display-message', '-p', '-t', pane, '#{window_name}'), 'bash');
  await f.started(pane);
  f.assertUntouched(inactive);
  f.assertUntouched(other);
});

test('start still refuses an existing exact session with only a CLI Node window', { skip }, async t => {
  const f = fixture(t);
  const pane = f.tmux('new-session', '-d', '-s', 'foxwarm', '-n', 'foxwarm-cli-node', '-P', '-F', '#{pane_id}');
  await f.guard(pane);
  const result = f.run('start.sh');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /already exists/);
  assert.equal(f.tmux('list-windows', '-t', '=foxwarm', '-F', '#{window_name}'), 'foxwarm-cli-node');
  f.assertUntouched(pane);
});

test('build and tmux input failures propagate without reporting startup success', { skip }, t => {
  const f = fixture(t);
  for (const script of ['start.sh', 'restart.sh']) {
    const build = f.run(script, { TEST_BUILD_STATUS: '1' });
    assert.equal(build.status, 1);
    assert.equal(f.tmux('list-sessions', '-F', '#{session_name}'), 'fixture');
    const send = f.run(script, { TEST_FAIL_SEND: '1' });
    assert.equal(send.status, 1);
    assert.doesNotMatch(send.stdout, /Foxwarm started|Restart command sent/);
    f.tmux('kill-session', '-t', '=foxwarm');
  }
});
