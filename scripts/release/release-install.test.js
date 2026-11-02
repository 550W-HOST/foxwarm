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
const linux = { skip: (process.platform !== 'linux' && 'Linux packages') || (!hasTmux && 'tmux is not installed') };

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
mkdir -p "$data/state"
printf fixture-token > "$data/state/token"
echo $$ > "$root/main.pid"
[ -e "$root/fake-ignore-term" ] && trap '' TERM || trap 'exit 0' TERM
while :; do sleep 0.1; done
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm release '));
  t.after(() => {
    spawnSync('tmux', ['kill-server'], { env: { ...process.env, TMUX: '', TMUX_TMPDIR: root } });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, TMUX_TMPDIR: root, FOXWARM_TMUX_SESSION: 'release-fixture' };
  delete env.TMUX;
  delete env.FOXWARM_DATA_DIR;
  delete env.FOXWARM_DIR;
  function makePackage(version, { stopSeconds } = {}) {
    const work = path.join(root, `package-${version}`);
    const payload = path.join(work, `foxwarm-${version}-linux-x64`);
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'Foxwarm'), fakeMain, { mode: 0o755 });
    let control = fs.readFileSync(path.join(__dirname, 'foxwarmctl'), 'utf8');
    if (stopSeconds) control = control.replace('STOP_SECONDS=60', `STOP_SECONDS=${stopSeconds}`);
    fs.writeFileSync(path.join(payload, 'foxwarmctl'), control, { mode: 0o755 });
    fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify({
      version, target: 'linux-x64-self-contained', kind: 'server', rid: 'linux-x64', selfContained: true,
      asset: 'foxwarm-linux-x64-self-contained.tar.gz',
    }, null, 2) + '\n');
    const file = path.join(root, `foxwarm-${version}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', file, '-C', work, path.basename(payload)]);
    assert.equal(tar.status, 0, String(tar.stderr));
    return file;
  }
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: root, env: { ...env, ...options.env }, encoding: 'utf8', timeout: 30000 });
  }
  function install(args, options) {
    return run('/bin/bash', [path.join(repo, 'install-foxwarm.sh'), ...args], options);
  }
  function control(dir, ...args) {
    return run(path.join(dir, 'foxwarmctl'), args);
  }
  return { root, makePackage, install, control, run };
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('fresh install selects data, records it, and installs the control script', linux, t => {
  const f = fixture(t);
  const pkg = f.makePackage('0.9.0');
  ok(f.install(['--package', pkg, '--no-start']));
  const dir = path.join(f.root, 'foxwarm');
  assert.equal(fs.readFileSync(path.join(dir, 'data_dir'), 'utf8').trim(), fs.realpathSync(path.join(f.root, 'foxwarm-data')));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.0');
  assert.equal(fs.statSync(path.join(dir, 'foxwarmctl')).mode & 0o111, 0o111);
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
  assert.match(ok(f.control(dir, 'status')).stdout, /Running \(PID \d+\), release 0\.9\.0/);

  assert.match(ok(f.control(dir, 'update', '--package', f.makePackage('0.9.0'))).stdout, /already installed/);
  assert(alive(first));

  const next = f.makePackage('0.9.1');
  fs.writeFileSync(path.join(dir, 'fake-block'), '');
  const blocked = f.control(dir, 'update', '--package', next);
  assert.equal(blocked.status, 1);
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.0');
  assert(alive(first), 'A blocked update must not stop Main.');
  fs.rmSync(path.join(dir, 'fake-block'));

  ok(f.control(dir, 'update', '--package', next));
  assert(!alive(first));
  const second = Number(fs.readFileSync(path.join(dir, 'main.pid'), 'utf8'));
  assert.notEqual(second, first);
  assert(alive(second));
  assert.equal(fs.readlinkSync(path.join(dir, 'runtime/current')), '0.9.1');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runtime')).sort(), ['0.9.1', 'current']);
  ok(f.control(dir, 'stop'));
  assert(!alive(second));
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
