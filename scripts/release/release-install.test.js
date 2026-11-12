'use strict';
// Linux package installer and control script, using fixture packages whose Main is a
// small shell program. Real packages are exercised by scripts/release/smoke-server.sh.
require('../test/test-process-env.cjs').initializeTestEnvironment();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const unix = { skip: process.platform !== 'linux' && 'Linux fixture process checks' };
const linux = { skip: unix.skip || (!hasTmux && 'tmux is not installed') };

// The fixture Main reads its installation root, records its PID and token, and stops on
// SIGTERM unless the installation contains `fake-ignore-term`.
const fakeMain = `#!/bin/bash
root="$2"; shift 2
if [ "$1" = --inspect-upgrade ]; then
  echo "inspected $(basename "$(dirname "$0")")" >> "$root/inspections"
  [ ! -e "$root/fake-block" ]
  exit
fi
data="$(cat "$root/data_dir")"
if [ -e "$root/fake-bind-failure" ]; then
  echo "Main fatal startup failure at host start: IOException / AddressInUseException / AddressAlreadyInUse" >&2
  exit 1
fi
mkdir -p "$data/state"
printf fixture-token > "$data/state/token"
echo $$ > "$root/main.pid"
echo "fixture stdout $$"
echo "fixture stderr $$" >&2
echo "Main HTTP listening: http://0.0.0.0:3001"
[ -e "$root/fake-ignore-term" ] && trap '' TERM || trap 'exit 0' TERM
while :; do sleep 0.1; done
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm release '));
  const installations = new Set();
  t.after(() => {
    for (const dir of installations) {
      if (fs.existsSync(path.join(dir, 'foxwarmctl'))) control(dir, 'stop');
    }
    spawnSync('tmux', ['kill-server'], { env: { ...process.env, TMUX: '', TMUX_TMPDIR: root } });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, TMUX_TMPDIR: root, FOXWARM_TMUX_SESSION: 'release-fixture' };
  delete env.TMUX;
  delete env.FOXWARM_DATA_DIR;
  delete env.FOXWARM_DIR;
  // Native is the current Linux package; self-contained is the retired one older
  // installations still use.
  function makePackage(version, { stopSeconds, variant = 'native' } = {}) {
    const suffix = variant === 'native' ? '-native' : '-self-contained';
    const work = path.join(root, `package-${version}${suffix}`);
    const payload = path.join(work, `foxwarm-${version}-linux-x64`);
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'Foxwarm'), fakeMain, { mode: 0o755 });
    let control = fs.readFileSync(path.join(__dirname, 'foxwarmctl'), 'utf8');
    if (stopSeconds) control = control.replace('STOP_SECONDS=60', `STOP_SECONDS=${stopSeconds}`);
    fs.writeFileSync(path.join(payload, 'foxwarmctl'), control, { mode: 0o755 });
    fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify({
      version, target: `linux-x64${suffix}`, kind: 'server', rid: 'linux-x64', selfContained: true,
      ...(variant === 'native' ? { native: true } : {}), asset: `foxwarm-linux-x64${suffix}.tar.gz`,
    }, null, 2) + '\n');
    const file = path.join(root, `foxwarm-${version}${variant === 'native' ? '' : suffix}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', file, '-C', work, path.basename(payload)]);
    assert.equal(tar.status, 0, String(tar.stderr));
    return file;
  }
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: root, env: { ...env, ...options.env }, encoding: 'utf8', timeout: 30000 });
  }
  function install(args, options) {
    const dirIndex = args.indexOf('--dir');
    installations.add(path.resolve(root, dirIndex === -1 ? 'foxwarm' : args[dirIndex + 1]));
    return run('/bin/bash', [path.join(repo, 'install-foxwarm.sh'), ...args], options);
  }
  function control(dir, ...args) {
    return run(path.join(dir, 'foxwarmctl'), args);
  }
  // Runs tmux on the fixture's private server and returns its output.
  function tmux(...args) {
    return ok(run('tmux', args)).stdout.trim();
  }
  function withoutTmux({ checksum = 'sha256sum' } = {}) {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Only the tools used by the control script and fixture Main, deliberately no tmux.
    for (const name of ['awk', 'bash', 'basename', 'cat', 'cp', 'date', 'dirname', 'env',
      'gzip', 'ln', 'mkdir', 'mktemp', 'mv', 'nohup', 'ps', 'rm', 'sed', 'sleep', 'tail', 'tar', 'uname', 'wc', checksum]) {
      const executable = spawnSync('/bin/bash', ['-c', 'command -v "$1"', 'bash', name], { encoding: 'utf8' }).stdout.trim();
      assert(executable, `${name} must be available for the fixture`);
      fs.symlinkSync(executable, path.join(bin, name));
    }
    env.PATH = bin;
    return bin;
  }
  return { root, makePackage, install, control, run, tmux, withoutTmux };
}

function waitFor(condition, ms = 5000) {
  const end = Date.now() + ms;
  while (!condition()) {
    assert(Date.now() < end, 'Timed out waiting for the fixture.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function mainPid(dir) {
  return Number(fs.readFileSync(path.join(dir, 'main.pid'), 'utf8'));
}

// Panes of the fixture's Main window as "pane-id pid", or [] when the window is missing.
function mainWindow(f) {
  const result = f.run('tmux', ['list-panes', '-t', '=release-fixture:=foxwarm', '-F', '#{pane_id} #{pane_pid}']);
  return result.status === 0 ? result.stdout.trim().split('\n') : [];
}

const panePids = f => mainWindow(f).map(pane => Number(pane.split(' ')[1]));

// PID of the fixture's private tmux server.
const tmuxServerPid = f => Number(f.tmux('display-message', '-p', '#{pid}'));

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

// Same rule as foxwarmctl: a Main that has exited but that tmux has not reaped yet (state Z) is stopped.
function processState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  } catch {
    return null;
  }
}

function alive(pid) {
  const state = processState(pid);
  return state !== null && state !== 'Z';
}

function stoppedMessage(pid, result) {
  return `PID ${pid} is still running (state ${processState(pid)}); foxwarmctl reported: ${String(result.stdout)}${String(result.stderr)}`;
}

test('fresh install selects data, records it, and installs the control script', linux, t => {
  const f = fixture(t);
  const pkg = f.makePackage('0.9.0');
  ok(f.install(['--package', pkg, '--no-start']));
  const dir = path.join(f.root, 'foxwarm');
  assert.equal(fs.readFileSync(path.join(dir, 'data_dir'), 'utf8').trim(), fs.realpathSync(path.join(f.root, 'foxwarm-data')));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.0');
  fs.accessSync(path.join(dir, 'foxwarmctl'), fs.constants.X_OK);
  assert.match(fs.readFileSync(path.join(dir, 'inspections'), 'utf8'), /inspected foxwarm-0.9.0-linux-x64/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runtime')).sort(), ['0.9.0', 'current']);

  // A parameter wins over the environment; relative paths follow the caller's directory.
  ok(f.install(['--package', pkg, '--no-start', '--dir', 'other/app', '--data-dir', 'chosen data'],
    { env: { FOXWARM_DATA_DIR: path.join(f.root, 'ignored') } }));
  assert.equal(fs.readFileSync(path.join(f.root, 'other/app/data_dir'), 'utf8').trim(), fs.realpathSync(path.join(f.root, 'chosen data')));
  assert(!fs.existsSync(path.join(f.root, 'ignored')));
});

test('installer refuses source checkouts and blocked data without selecting a release', linux, t => {
  const f = fixture(t);
  const pkg = f.makePackage('0.9.0');
  fs.mkdirSync(path.join(f.root, 'checkout/.git'), { recursive: true });
  const source = f.install(['--package', pkg, '--dir', 'checkout', '--no-start']);
  assert.equal(source.status, 1);
  assert.match(source.stderr, /source checkout/);

  fs.mkdirSync(path.join(f.root, 'blocked'));
  fs.writeFileSync(path.join(f.root, 'blocked/fake-block'), '');
  const blocked = f.install(['--package', pkg, '--dir', 'blocked', '--no-start']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /nothing was installed/);
  assert(!fs.existsSync(path.join(f.root, 'blocked/runtime/current')));
});

test('update replaces a running release, restarts it and removes the old one', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  ok(f.control(dir, 'start'));
  const first = Number(fs.readFileSync(path.join(dir, 'main.pid'), 'utf8'));
  assert.match(ok(f.control(dir, 'status')).stdout, /Running \(PID \d+\), release 0\.9\.0.*Mode: tmux/);
  assert.equal(fs.readFileSync(path.join(dir, 'foxwarm.pid'), 'utf8'), `${first}\n`);

  assert.match(ok(f.control(dir, 'update', '--package', f.makePackage('0.9.0'))).stdout, /already installed/);
  assert(alive(first));

  const next = f.makePackage('0.9.1');
  fs.writeFileSync(path.join(dir, 'fake-block'), '');
  const blocked = f.control(dir, 'update', '--package', next);
  assert.equal(blocked.status, 1);
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.0');
  assert(alive(first), 'A blocked update must not stop Main.');
  fs.rmSync(path.join(dir, 'fake-block'));

  const updated = ok(f.control(dir, 'update', '--package', next));
  assert(!alive(first), stoppedMessage(first, updated));
  const second = Number(fs.readFileSync(path.join(dir, 'main.pid'), 'utf8'));
  assert.notEqual(second, first);
  assert(alive(second));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runtime')).sort(), ['0.9.1', 'current']);
  const stopped = ok(f.control(dir, 'stop'));
  assert(!alive(second), stoppedMessage(second, stopped));
  assert(!fs.existsSync(path.join(dir, 'foxwarm.pid')));
  assert.equal(f.control(dir, 'status').status, 3);
});

test('stop kills Main that ignores SIGTERM after the deadline', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0', { stopSeconds: 1 }), '--no-start']));
  fs.writeFileSync(path.join(dir, 'fake-ignore-term'), '');
  ok(f.control(dir, 'start'));
  const pid = Number(fs.readFileSync(path.join(dir, 'main.pid'), 'utf8'));
  const stopped = ok(f.control(dir, 'stop'));
  assert.match(stopped.stdout, /did not stop within 1 seconds; killing/);
  assert(!alive(pid));
});

test('rerunning the installer updates an existing installation and keeps its data', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  const mismatch = f.install(['--package', f.makePackage('0.9.1'), '--data-dir', 'elsewhere', '--no-start']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /already uses the data directory/);
  ok(f.install(['--package', path.join(f.root, 'foxwarm-0.9.1.tar.gz'), '--no-start']));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
  assert.equal(fs.readFileSync(path.join(dir, 'data_dir'), 'utf8').trim(), fs.realpathSync(path.join(f.root, 'foxwarm-data')));
});

test("stop and update touch only Main's pane, never the user windows in its session", linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  ok(f.control(dir, 'start'));
  const first = mainPid(dir);
  const [mainPane] = mainWindow(f)[0].split(' ');
  // The user attaches, opens a window of their own and splits Main's window.
  const own = Number(f.tmux('new-window', '-d', '-P', '-F', '#{pane_pid}', '-t', '=release-fixture:', '-n', 'mine', '-c', f.root, 'sleep 600'));
  const split = Number(f.tmux('split-window', '-d', '-P', '-F', '#{pane_pid}', '-t', '=release-fixture:=foxwarm', '-c', f.root, 'sleep 600'));

  const updated = ok(f.control(dir, 'update', '--package', f.makePackage('0.9.1')));
  assert(!alive(first), stoppedMessage(first, updated));
  const second = mainPid(dir);
  assert(alive(second) && alive(own) && alive(split));
  assert.equal(mainWindow(f)[0], `${mainPane} ${second}`, 'Main restarts in its own pane.');
  assert.match(ok(f.control(dir, 'status')).stdout, /Running \(PID \d+\), release 0\.9\.1/);

  const stopped = ok(f.control(dir, 'stop'));
  assert(!alive(second), stoppedMessage(second, stopped));
  assert(alive(own) && alive(split));
  assert.deepEqual(panePids(f), [split], 'Only Main pane is removed.');
  // The remaining split pane is not Main, so it is reported and never replaced.
  const status = f.control(dir, 'status');
  assert.equal(status.status, 3);
  assert.match(status.stdout, /Another program .* FOXWARM_TMUX_SESSION/);
});

test('a foreign program in the Main window is never signalled', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  // Another installation or a source checkout holds the default window, in another directory.
  f.tmux('new-session', '-d', '-s', 'release-fixture', '-n', 'foxwarm', '-c', f.root, 'sleep 600');
  const [foreign] = panePids(f);

  const started = f.control(dir, 'start');
  assert.equal(started.status, 1);
  assert.match(started.stderr, /Another program .* FOXWARM_TMUX_SESSION/);
  const status = f.control(dir, 'status');
  assert.equal(status.status, 3);
  assert.match(status.stdout, /Not running\. Another program/);
  assert.match(ok(f.control(dir, 'stop')).stdout, /not running/);
  ok(f.control(dir, 'update', '--package', f.makePackage('0.9.1')));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
  assert.equal(f.control(dir, 'restart').status, 1);
  assert(alive(foreign));
  assert.deepEqual(panePids(f), [foreign]);
  assert(!fs.existsSync(path.join(dir, 'main.pid')), 'Main must not be started elsewhere.');
});

test('an exited Main pane is restarted in place or removed', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  ok(f.control(dir, 'start'));
  const [pane] = mainWindow(f)[0].split(' ');
  const killed = mainPid(dir);
  process.kill(killed, 'SIGKILL');
  // tmux records how a pane ended only when SIGCHLD makes it reap the process. tmux 3.4 and
  // 3.5 built with utempter (as packaged by Ubuntu) can lose that signal: the terminal closes
  // first, and the process exits while tmux runs the utempter helper with default SIGCHLD
  // handling, leaving a dead pane over an unreaped zombie. tmux 3.6 then signals itself; do
  // the same for this private server once the pane is dead and the process has exited. The
  // unreaped case itself is covered by the next test.
  waitFor(() => !alive(killed) && f.tmux('display-message', '-p', '-t', pane, '#{pane_dead}') === '1');
  process.kill(tmuxServerPid(f), 'SIGCHLD');
  waitFor(() => f.tmux('display-message', '-p', '-t', pane, '#{pane_dead_signal}') === '9');
  const exited = f.control(dir, 'status');
  assert.equal(exited.status, 3);
  assert.match(exited.stdout, /Exited with signal 9/);

  ok(f.control(dir, 'start'));
  const restarted = mainPid(dir);
  assert.deepEqual(mainWindow(f), [`${pane} ${restarted}`]);

  process.kill(restarted, 'SIGKILL');
  waitFor(() => f.tmux('display-message', '-p', '-t', pane, '#{pane_dead}') === '1');
  ok(f.control(dir, 'stop'));
  assert.equal(f.run('tmux', ['has-session', '-t', '=release-fixture']).status, 1);
  assert.equal(f.control(dir, 'status').status, 3);
});

test('a crashed Main that tmux has not reaped is reported exited, then restarted or removed', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  // A tmux server keeps the signal mask of the client that starts it (Node children get an
  // empty one). With SIGCHLD blocked it never reaps, so a crash stays a dead pane over a
  // zombie with no exit record, the state a lost SIGCHLD leaves on a real server.
  ok(f.run('/usr/bin/python3', ['-c', `
import os, signal, sys
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
os.execvp(sys.argv[1], sys.argv[1:])
`, 'tmux', 'new-session', '-d', '-s', 'user', '-c', f.root, 'sleep 600']));
  const blocked = fs.readFileSync(`/proc/${tmuxServerPid(f)}/status`, 'utf8').match(/^SigBlk:\s*([0-9a-f]+)$/m);
  assert(blocked && (BigInt(`0x${blocked[1]}`) >> BigInt(os.constants.signals.SIGCHLD - 1)) & 1n,
    'The fixture tmux server must block SIGCHLD.');

  ok(f.control(dir, 'start'));
  const [pane] = mainWindow(f)[0].split(' ');
  const crashed = mainPid(dir);
  process.kill(crashed, 'SIGKILL');
  const unreaped = pid => processState(pid) === 'Z'
    && f.tmux('display-message', '-p', '-t', pane, '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}') === '1||';
  waitFor(() => unreaped(crashed));
  const exited = f.control(dir, 'status');
  assert.equal(exited.status, 3);
  assert.match(exited.stdout, /^\[foxwarm\] Exited\. Inspect it with/);

  ok(f.control(dir, 'restart'));
  const restarted = mainPid(dir);
  assert(alive(restarted));
  assert.deepEqual(mainWindow(f), [`${pane} ${restarted}`], 'Main restarts in its own pane.');
  assert.equal(processState(crashed), 'Z', 'The crashed Main is still unreaped.');

  process.kill(restarted, 'SIGKILL');
  waitFor(() => unreaped(restarted));
  ok(f.control(dir, 'stop'));
  assert.deepEqual(mainWindow(f), []);
  const stopped = f.control(dir, 'status');
  assert.equal(stopped.status, 3);
  assert.match(stopped.stdout, /Not running/);
});

test('an installation reached through a symlink recognizes its Main', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  const link = path.join(f.root, 'link');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  fs.symlinkSync(dir, link);
  ok(f.control(link, 'start'));
  const pid = mainPid(dir);
  assert.match(ok(f.control(dir, 'status')).stdout, /Running/);
  assert.match(ok(f.control(link, 'status')).stdout, /Running/);
  assert.match(f.control(dir, 'start').stderr, /already running/);
  ok(f.control(dir, 'stop'));
  assert(!alive(pid));
  assert.deepEqual(mainWindow(f), []);
});

test('a Main started by the 0.9.0 control script is recognized and updated', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  // The 0.9.0 start command: the pane process in ROOT, remain-on-exit set on the window.
  f.tmux('new-session', '-d', '-s', 'release-fixture', '-n', 'foxwarm', '-c', dir,
    `exec env PATH="$PATH" '${dir}/runtime/0.9.0/Foxwarm' --installation-root '${dir}'`, ';',
    'set-option', '-w', '-t', '=release-fixture:=foxwarm', 'remain-on-exit', 'on');
  waitFor(() => fs.existsSync(path.join(dir, 'main.pid')));
  const first = mainPid(dir);
  assert.match(ok(f.control(dir, 'status')).stdout, new RegExp(`Running \\(PID ${first}\\)`));

  const updated = ok(f.control(dir, 'update', '--package', f.makePackage('0.9.1')));
  assert(!alive(first), stoppedMessage(first, updated));
  assert(alive(mainPid(dir)));
  assert.match(ok(f.control(dir, 'status')).stdout, /release 0\.9\.1/);
});

test('without tmux, background Main survives launcher hangup and supports restart, update and stop', unix, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  const next = f.makePackage('0.9.1');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  f.withoutTmux();
  // End a separate launcher's session with SIGHUP, including its process group.
  // Main has nohup's ignored HUP disposition and no descriptors tied to the launcher.
  const launched = f.run('/usr/bin/python3', ['-c', `
import os, signal, subprocess, sys
os.setsid()
subprocess.run([sys.argv[1], 'start'], check=True)
os.killpg(os.getpgrp(), signal.SIGHUP)
`, path.join(dir, 'foxwarmctl')]);
  assert.equal(launched.signal, 'SIGHUP', launched.stderr);
  const first = mainPid(dir);
  assert(alive(first));
  assert.equal(fs.readFileSync(path.join(dir, 'foxwarm.pid'), 'utf8'), `${first}\n`);
  assert.match(ok(f.control(dir, 'status')).stdout, new RegExp(`Running \\(PID ${first}\\).*Mode: background`));
  assert.match(f.control(dir, 'start').stderr, /already running/);
  const logs = path.join(f.root, 'foxwarm-data/state/logs');
  assert.match(ok(f.control(dir, 'attach')).stdout, /without tmux.*foxwarm.stdout.log.*foxwarm.stderr.log/);
  assert.match(fs.readFileSync(path.join(logs, 'foxwarm.stdout.log'), 'utf8'), new RegExp(`stdout ${first}`));
  assert.match(fs.readFileSync(path.join(logs, 'foxwarm.stderr.log'), 'utf8'), new RegExp(`stderr ${first}`));

  ok(f.control(dir, 'restart'));
  const second = mainPid(dir);
  assert.notEqual(first, second);
  assert(!alive(first) && alive(second));
  const stdout = fs.readFileSync(path.join(logs, 'foxwarm.stdout.log'), 'utf8');
  assert.match(stdout, new RegExp(`stdout ${first}`));
  assert.match(stdout, new RegExp(`stdout ${second}`), 'Restart appends rather than replacing logs.');

  fs.writeFileSync(path.join(dir, 'fake-block'), '');
  assert.equal(f.control(dir, 'update', '--package', next).status, 1);
  assert(alive(second));
  fs.rmSync(path.join(dir, 'fake-block'));
  ok(f.control(dir, 'update', '--package', next));
  const third = mainPid(dir);
  assert(!alive(second) && alive(third));
  assert.notEqual(second, third);
  assert.equal(fs.readFileSync(path.join(dir, 'foxwarm.pid'), 'utf8'), `${third}\n`);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runtime')).sort(), ['0.9.1', 'current']);
  ok(f.control(dir, 'stop'));
  assert(!alive(third));
  assert(!fs.existsSync(path.join(dir, 'foxwarm.pid')));
  assert.equal(f.control(dir, 'status').status, 3);
});

test('stale background PID files never report or signal an unrelated live process', unix, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  const next = f.makePackage('0.9.1');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  // A second installation has the first root as a prefix: suffix matching must be exact.
  const other = `${dir}-other`;
  ok(f.install(['--package', path.join(f.root, 'foxwarm-0.9.0.tar.gz'), '--dir', other, '--no-start']));
  f.withoutTmux();
  ok(f.control(other, 'start'));
  const unrelated = mainPid(other);
  const pidFile = path.join(dir, 'foxwarm.pid');
  fs.writeFileSync(pidFile, `${unrelated}\n`);
  assert.equal(f.control(dir, 'status').status, 3);
  ok(f.control(dir, 'stop'));
  assert(alive(unrelated));
  ok(f.control(dir, 'update', '--package', next));
  assert(alive(unrelated));
  assert(!fs.existsSync(path.join(dir, 'main.pid')), 'An update with a stale PID does not start Main.');
  ok(f.control(dir, 'restart'));
  assert(alive(unrelated));
  assert.notEqual(mainPid(dir), unrelated);
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), mainPid(dir));
  ok(f.control(dir, 'stop'));
  assert(alive(unrelated));
});

test('background crash and forced shutdown treat zombies as stopped', unix, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0', { stopSeconds: 1 }), '--no-start']));
  f.withoutTmux();
  ok(f.control(dir, 'start'));
  const crashed = mainPid(dir);
  process.kill(crashed, 'SIGKILL');
  waitFor(() => !alive(crashed));
  assert.equal(f.control(dir, 'status').status, 3);
  assert.match(f.control(dir, 'attach').stderr, /foxwarm.stdout.log/);
  fs.writeFileSync(path.join(dir, 'fake-ignore-term'), '');
  ok(f.control(dir, 'start'));
  const restarted = mainPid(dir);
  assert.notEqual(restarted, crashed);
  const stopped = ok(f.control(dir, 'stop'));
  assert.match(stopped.stdout, /did not stop within 1 seconds; killing/);
  assert(!alive(restarted));
});

test('background logs follow Main data-directory precedence and installation-relative paths', unix, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  f.withoutTmux();
  fs.writeFileSync(path.join(dir, 'data_dir'), '  selected data  \n');
  ok(f.control(dir, 'start'));
  assert(fs.existsSync(path.join(dir, 'selected data/state/logs/foxwarm.stdout.log')));
  ok(f.control(dir, 'stop'));
  const selected = { env: { FOXWARM_DATA_DIR: '  ~/override  ', HOME: f.root } };
  ok(f.run(path.join(dir, 'foxwarmctl'), ['start'], selected));
  assert(fs.existsSync(path.join(f.root, 'override/state/logs/foxwarm.stdout.log')));
  assert.match(ok(f.run(path.join(dir, 'foxwarmctl'), ['status'], selected)).stdout, /override\/state\/logs/);
  ok(f.control(dir, 'stop'));
});

test('downloaded updates verify checksums with shasum when sha256sum is unavailable', unix, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  const next = f.makePackage('0.9.1');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  const asset = 'foxwarm-linux-x64-native.tar.gz';
  const sum = require('node:crypto').createHash('sha256').update(fs.readFileSync(next)).digest('hex');
  fs.writeFileSync(path.join(f.root, 'SHA256SUMS'), `${sum}  ${asset}\n`);
  const bin = f.withoutTmux({ checksum: 'shasum' });
  // Replace network transport only; the control script runs the real checksum tools.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
case "$6" in
  */SHA256SUMS) cp '${f.root}/SHA256SUMS' "$5" ;;
  *) cp '${next}' "$5" ;;
esac
`, { mode: 0o755 });
  ok(f.control(dir, 'update'));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
  fs.writeFileSync(path.join(f.root, 'SHA256SUMS'), `${'0'.repeat(64)}  ${asset}\n`);
  const invalid = f.control(dir, 'update', '--force');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Checksum verification failed/);
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
});

test('start reports a port conflict and leaves nothing running when Main cannot bind', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  fs.writeFileSync(path.join(dir, 'fake-bind-failure'), '');
  fs.mkdirSync(path.join(f.root, 'foxwarm-data/state'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'foxwarm-data/state/config.yaml'), 'bot:\n  httpPort: 3456\n');
  const tmux = f.control(dir, 'start');
  assert.equal(tmux.status, 1);
  assert.match(tmux.stderr, /port 3456 is already in use/);
  assert.doesNotMatch(tmux.stdout, /Started/);

  f.withoutTmux();
  const background = f.control(dir, 'start');
  assert.equal(background.status, 1);
  assert.match(background.stderr, /port 3456 is already in use/);
  assert.doesNotMatch(background.stdout, /Started/);
});

test('restart checks that Main can be launched before stopping the running one', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.0'), '--no-start']));
  ok(f.control(dir, 'start'));
  const running = mainPid(dir);
  const release = path.join(dir, 'runtime/current/release.json');
  fs.writeFileSync(release, fs.readFileSync(release, 'utf8').replace('"selfContained": true', '"selfContained": false'));
  f.withoutTmux();
  const restarted = f.control(dir, 'restart');
  assert.equal(restarted.status, 1);
  assert.match(restarted.stderr, /dotnet on PATH/);
  assert(alive(running), 'The running Main must not be stopped when it could not be started again.');
  fs.writeFileSync(release, fs.readFileSync(release, 'utf8').replace('"selfContained": false', '"selfContained": true'));
  ok(f.control(dir, 'stop'));
});

test('rerunning the installer on a stopped installation prints the sign-in link', linux, t => {
  const f = fixture(t);
  const pkg = f.makePackage('0.9.0');
  ok(f.install(['--package', pkg]));
  ok(f.control(path.join(f.root, 'foxwarm'), 'stop'));
  const rerun = ok(f.install(['--package', pkg]));
  assert.match(rerun.stdout, /already installed/);
  assert.match(rerun.stdout, /WebUI: http:\/\/localhost:3001\/#token=fixture-token/);
});

// Serves release downloads from a directory of named assets and records each request.
function releaseServer(f, assets) {
  const bin = path.join(f.root, 'release-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
url="\${@: -1}"; out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
echo "$url" >> '${f.root}/downloads'
cp '${assets}'/"\${url##*/}" "$out"
`, { mode: 0o755 });
  const sums = fs.readdirSync(assets).filter(name => name.endsWith('.tar.gz')).map(name =>
    `${require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(assets, name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(assets, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { env: { PATH: `${bin}:${process.env.PATH}` }, downloads: () => fs.readFileSync(path.join(f.root, 'downloads'), 'utf8').trim().split('\n') };
}

function publishedAssets(f, version) {
  const assets = path.join(f.root, `release-${version}`);
  fs.mkdirSync(assets);
  fs.copyFileSync(f.makePackage(version), path.join(assets, 'foxwarm-linux-x64-native.tar.gz'));
  return assets;
}

const installedAsset = dir => JSON.parse(fs.readFileSync(path.join(dir, 'runtime/current/release.json'), 'utf8')).asset;

test('a fresh Linux install downloads the native package', linux, t => {
  const f = fixture(t);
  const server = releaseServer(f, publishedAssets(f, '0.9.4'));
  const result = ok(f.install(['--no-start'], server));
  assert.match(result.stdout, /native package/);
  assert.deepEqual(server.downloads().map(url => url.split('/').slice(-2).join('/')),
    ['download/foxwarm-linux-x64-native.tar.gz', 'download/SHA256SUMS']);
  assert.equal(installedAsset(path.join(f.root, 'foxwarm')), 'foxwarm-linux-x64-native.tar.gz');
  const legacyOption = ok(f.install(['--no-start', '--dir', 'other', '--self-contained'], server));
  assert.match(legacyOption.stdout, /replaced by the native package/);
  assert.equal(installedAsset(path.join(f.root, 'other')), 'foxwarm-linux-x64-native.tar.gz');
});

test('rerunning the installer moves a self-contained installation to the native package and keeps its data', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.3', { variant: 'self-contained' }), '--no-start']));
  ok(f.control(dir, 'start'));
  const first = mainPid(dir);
  fs.writeFileSync(path.join(f.root, 'foxwarm-data/state/config.yaml'), 'retained: true\n');
  const server = releaseServer(f, publishedAssets(f, '0.9.4'));
  const result = ok(f.install([], server));
  assert.match(result.stdout, /Switching .* from foxwarm-linux-x64-self-contained\.tar\.gz to foxwarm-linux-x64-native\.tar\.gz/);
  assert.deepEqual(server.downloads().map(url => url.split('/').pop()), ['foxwarm-linux-x64-native.tar.gz', 'SHA256SUMS']);
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.4');
  assert.equal(installedAsset(dir), 'foxwarm-linux-x64-native.tar.gz');
  assert(!alive(first));
  assert(alive(mainPid(dir)));
  assert.equal(fs.readFileSync(path.join(f.root, 'foxwarm-data/state/config.yaml'), 'utf8'), 'retained: true\n');
  assert.equal(fs.readFileSync(path.join(dir, 'data_dir'), 'utf8').trim(), fs.realpathSync(path.join(f.root, 'foxwarm-data')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runtime')).filter(name => !name.startsWith('.')).sort(), ['0.9.4', 'current']);
  // Later updates stay on the native package.
  ok(f.control(dir, 'stop'));
  const later = releaseServer(f, publishedAssets(f, '0.9.5'));
  fs.rmSync(path.join(f.root, 'downloads'));
  ok(f.run(path.join(dir, 'foxwarmctl'), ['update'], later));
  assert.deepEqual(later.downloads().map(url => url.split('/').pop()), ['foxwarm-linux-x64-native.tar.gz', 'SHA256SUMS']);
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.5');
});

test('choosing a package for an existing installation switches it even within one version', linux, t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'foxwarm');
  ok(f.install(['--package', f.makePackage('0.9.4', { variant: 'self-contained' }), '--no-start']));
  ok(f.install(['--package', f.makePackage('0.9.4'), '--native', '--no-start']));
  assert.equal(installedAsset(dir), 'foxwarm-linux-x64-native.tar.gz');
  assert.match(fs.readlinkSync(path.join(dir, 'runtime/current')), /^0\.9\.4-\d+$/);
  // Without a choice, an installation keeps its package type.
  assert.match(ok(f.install(['--package', f.makePackage('0.9.4'), '--no-start'])).stdout, /already installed/);
  // A package file of the other type is that choice.
  const back = ok(f.install(['--package', f.makePackage('0.9.4', { variant: 'self-contained' }), '--no-start']));
  assert.match(back.stdout, /Switching .* to foxwarm-linux-x64-self-contained\.tar\.gz/);
  assert.equal(installedAsset(dir), 'foxwarm-linux-x64-self-contained.tar.gz');
});
