'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmuxProbe = spawnSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' });
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
  for (const name of ['start.sh', 'restart.sh', 'stop.sh', 'source-process.sh', 'main.js', 'core-executable.js']) {
    fs.copyFileSync(path.join(scriptsDir, name), path.join(app, 'scripts', name));
  }
  const tmuxBin = spawnSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TMUX: undefined,
    TEST_TMUX_BIN: tmuxBin,
    TEST_TMUX_SOCKET: socket,
    TEST_START_LOG: log,
    FOXWARM_TMUX_SESSION: 'foxwarm',
    FOXWARM_NODE_BIN: path.join(bin, "node ' $ stub"),
    FOXWARM_DATA_DIR: path.join(root, "data ' $ directory"),
  };
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
unset TMUX
if [ -n "\${TEST_FAIL_SEND:-}" ] && [ "$1" = send-keys ]; then exit 1; fi
# Stopping must never depend on a terminal interrupt.
if [ "$1" = send-keys ] && [ "\${@: -1}" = C-c ]; then exit 1; fi
"$TEST_TMUX_BIN" -S "$TEST_TMUX_SOCKET" -f /dev/null "$@" || exit $?
if [ -n "\${TEST_RENAME_ON_STOP:-}" ] && [ "$1" = display-message ]; then
    "$TEST_TMUX_BIN" -S "$TEST_TMUX_SOCKET" rename-window -t "$4" bash
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nexit "${TEST_BUILD_STATUS:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(env.FOXWARM_NODE_BIN, `#!/bin/bash
[ "$1" = scripts/build-source.js ] && exit 0
printf '%s\\n' "$TMUX_PANE" "$PWD" "$FOXWARM_DATA_DIR" "$@" > "$TEST_START_LOG/$TMUX_PANE"
exec '${process.execPath}' "$@"
`, { mode: 0o755 });

  const runtime = path.join(app, 'runtime', 'fixture');
  fs.mkdirSync(runtime, { recursive: true });
  fs.symlinkSync('fixture', path.join(app, 'runtime', 'current'));
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/bash
exec -a dotnet '${process.execPath}' "$@"
`, { mode: 0o755 });
  // Exercise the real JS launcher and PID writer with a small managed-process stand-in.
  fs.writeFileSync(path.join(runtime, 'Foxwarm.dll'), `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const root = process.argv[3];
const pipe = new net.Socket({ fd: 3, readable: true, writable: true });
pipe.on('data', () => process.exit(0));
pipe.on('end', () => process.exit(0));
process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(root, 'term-received'), String(process.pid));
  if (!fs.existsSync(path.join(root, 'ignore-term'))) setTimeout(() => process.exit(0), 100);
});
fs.writeFileSync(path.join(root, 'main-ready'), String(process.pid));
setInterval(() => {}, 1000);
`);

  function tmux(...args) {
    const result = spawnSync(tmuxBin, ['-S', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  t.after(() => {
    spawnSync(tmuxBin, ['-S', socket, 'kill-server'], { env });
    fs.rmSync(root, { recursive: true, force: true });
  });
  // This private server never reads the user's config or uses the default socket.
  tmux('new-session', '-d', '-s', 'fixture');
  tmux('set-option', '-g', 'default-shell', '/bin/bash');
  tmux('set-option', '-g', 'automatic-rename', 'off');
  tmux('set-environment', '-g', 'TEST_START_LOG', log);

  return {
    env, tmux, app, root,
    pid() { return Number(fs.readFileSync(path.join(app, 'foxwarm.pid'), 'utf8')); },
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
    run(name, extraEnv = {}, args = []) {
      return spawnSync('bash', [path.join(app, 'scripts', name), ...args], {
        env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000,
      });
    },
    async started(pane, args = []) {
      const file = path.join(log, pane);
      const deadline = Date.now() + 3000;
      while ((!fs.existsSync(file) || !fs.existsSync(path.join(app, 'main-ready')) || !fs.existsSync(path.join(app, 'foxwarm.pid'))
        || fs.readFileSync(path.join(app, 'main-ready'), 'utf8') !== fs.readFileSync(path.join(app, 'foxwarm.pid'), 'utf8').trim()) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(fs.existsSync(file), `Startup not received by ${pane}`);
      assert.equal(fs.readFileSync(path.join(app, 'main-ready'), 'utf8'), fs.readFileSync(path.join(app, 'foxwarm.pid'), 'utf8').trim());
      assert.deepEqual(fs.readFileSync(file, 'utf8').trimEnd().split('\n'), [
        pane, app, env.FOXWARM_DATA_DIR, 'scripts/main.js', ...args,
      ]);
    },
    assertUntouched(pane) {
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_current_command}'), 'sleep');
      assert.ok(!fs.existsSync(path.join(log, pane)), `Startup sent to unrelated pane ${pane}`);
      assert.ok(!tmux('capture-pane', '-p', '-t', pane).includes('scripts/main.js'));
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
  const result = f.run('restart.sh', { TEST_RENAME_ON_STOP: '1' });
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

function alive(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}

function launcher(pid) {
  return Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
}

for (const script of ['restart.sh', 'stop.sh']) {
  test(`${script} signals Main through its PID in copy mode and waits for the launcher`, { skip }, async t => {
    const f = fixture(t);
    assert.equal(f.run('start.sh').status, 0);
    const pane = f.targetPane();
    await f.started(pane);
    const pid = f.pid();
    const parent = launcher(pid);
    assert.ok(parent > 1);
    assert.equal(fs.readFileSync(path.join(f.app, 'foxwarm.pid'), 'utf8'), `${pid}\n`);
    f.tmux('copy-mode', '-t', pane);
    const result = f.run(script);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(f.app, 'term-received'), 'utf8'), String(pid));
    assert.ok(!alive(pid), 'Main survived stop');
    assert.ok(!alive(parent), 'Launcher survived stop');
    assert.doesNotMatch(result.stderr, /SIGKILL/);
    if (script === 'restart.sh') {
      await f.started(pane);
      assert.notEqual(f.pid(), pid);
    } else {
      assert.ok(!fs.existsSync(path.join(f.app, 'foxwarm.pid')));
      assert.equal(f.tmux('display-message', '-p', '-t', pane, '#{pane_in_mode}'), '1');
      assert.equal(f.tmux('display-message', '-p', '-t', pane, '#{pane_current_command}'), 'bash');
    }
  });

  test(`${script} kills Main after the SIGTERM deadline and leaves no launcher`, { skip }, async t => {
    const f = fixture(t);
    const helper = path.join(f.app, 'scripts', 'source-process.sh');
    const source = fs.readFileSync(helper, 'utf8');
    assert.match(source, /deadline=\$\(\(SECONDS \+ 60\)\)/);
    fs.writeFileSync(helper, source.replace('deadline=$((SECONDS + 60))', 'deadline=$((SECONDS + 1))'));
    fs.writeFileSync(path.join(f.app, 'ignore-term'), '');
    assert.equal(f.run('start.sh').status, 0);
    const pane = f.targetPane();
    await f.started(pane);
    const pid = f.pid();
    const parent = launcher(pid);
    const result = f.run(script);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /sending SIGKILL/);
    assert.equal(fs.readFileSync(path.join(f.app, 'term-received'), 'utf8'), String(pid));
    assert.ok(!alive(pid), 'Main survived SIGKILL');
    assert.ok(!alive(parent), 'Launcher survived Main SIGKILL');
    if (script === 'restart.sh') await f.started(pane);
    else assert.ok(!fs.existsSync(path.join(f.app, 'foxwarm.pid')));
  });

  test(`${script} adopts a PID-less older Main from the exact pane`, { skip }, async t => {
    const f = fixture(t);
    assert.equal(f.run('start.sh').status, 0);
    const pane = f.targetPane();
    await f.started(pane);
    const pid = f.pid();
    const parent = launcher(pid);
    fs.unlinkSync(path.join(f.app, 'foxwarm.pid'));
    const result = f.run(script);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(f.app, 'term-received'), 'utf8'), String(pid));
    assert.ok(!alive(pid));
    assert.ok(!alive(parent));
    if (script === 'restart.sh') await f.started(pane);
  });

  test(`${script} ignores an unrelated live PID without signalling it`, { skip }, async t => {
    const f = fixture(t);
    const other = f.tmux('new-session', '-d', '-s', 'foxwarm-cli-node', '-n', 'foxwarm', '-P', '-F', '#{pane_id}');
    await f.guard(other);
    const shell = f.tmux('display-message', '-p', '-t', other, '#{pane_pid}');
    const pid = Number(spawnSync('ps', ['-o', 'tpgid=', '-p', shell], { encoding: 'utf8' }).stdout.trim());
    fs.writeFileSync(path.join(f.app, 'foxwarm.pid'), `${pid}\n`);
    const result = f.run(script);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(alive(pid), 'Unrelated process was signalled');
    f.assertUntouched(other);
    if (script === 'restart.sh') await f.started(f.targetPane());
    else assert.ok(!fs.existsSync(path.join(f.app, 'foxwarm.pid')));
  });
}

test('stop ignores another installation whose root shares this root prefix', { skip }, async t => {
  const f = fixture(t);
  const foreign = f.app + '-other';
  fs.mkdirSync(foreign);
  // The same executable and a root prefix alone must not identify this installation.
  const child = spawn(path.join(f.root, 'bin/dotnet'), [path.join(f.app, 'runtime/fixture/Foxwarm.dll'), '--installation-root', foreign], {
    env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(foreign, 'main-ready'))) {
    assert.ok(Date.now() < deadline, 'Foreign Main did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  fs.writeFileSync(path.join(f.app, 'foxwarm.pid'), `${child.pid}\n`);
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(alive(child.pid));
  assert.ok(!fs.existsSync(path.join(foreign, 'term-received')));
});

test('PID stop accepts a source launch with trailing arguments', { skip }, async t => {
  const f = fixture(t);
  const args = ['--urls', 'http://127.0.0.1:0'];
  assert.equal(f.run('start.sh', {}, args).status, 0);
  const pane = f.targetPane();
  await f.started(pane, args);
  const pid = f.pid();
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.app, 'term-received'), 'utf8'), String(pid));
  assert.ok(!alive(pid));
});
