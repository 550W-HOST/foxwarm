import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NODE_SOURCE_FILES, NODE_SOURCE_TAR_EXCLUDES } from './httpRoutes';

const execFileAsync = promisify(execFile);
const RUN_SH = path.resolve(__dirname, '../../templates/node/run.sh');

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function makeFixture(options: { isolatedPath?: boolean; tmux?: boolean; userSystemd?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-run-sh-'));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  await fs.ensureDir(bin);
  await fs.ensureDir(calls);

  await writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(path.join(bin, 'tar'), `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then shift; target="$1"; fi
  shift
done
mkdir -p "$target/packages/cli-node/dist"
: > "$target/packages/cli-node/dist/client.bundle.js"
`);
  await writeExecutable(path.join(bin, 'node'), '#!/bin/sh\nexec /bin/sleep 30\n');

  if (options.tmux) {
    await writeExecutable(path.join(bin, 'tmux'), `#!/bin/sh
set -eu
case "$1" in
  has-session) test -f "$MOCK_TMUX_STATE" ;;
  new-session) printf '%s\\n' "$*" >> "$MOCK_CALLS/tmux"; : > "$MOCK_TMUX_STATE" ;;
  display-message) echo 4242 ;;
  *) exit 2 ;;
esac
`);
  }

  if (options.userSystemd) {
    await writeExecutable(path.join(bin, 'id'), `#!/bin/sh
case "\${1-}" in
  -u) echo 1000 ;;
  -un) echo tester ;;
  *) echo tester ;;
esac
`);
    await writeExecutable(path.join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_CALLS/systemctl"
exit 0
`);
    await writeExecutable(path.join(bin, 'loginctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_CALLS/loginctl"
case "$1" in show-user) echo yes ;; esac
exit 0
`);
  }

  if (options.isolatedPath) {
    const commands = ['awk', 'cat', 'chmod', 'cksum', 'cp', 'gzip', 'hostname', 'mkdir', 'nohup', 'rm', 'sed', 'sleep'];
    for (const command of commands) {
      const real = ['/usr/bin', '/bin'].map(dir => path.join(dir, command)).find(candidate => fs.existsSync(candidate));
      assert.ok(real, `missing test utility ${command}`);
      await fs.symlink(real, path.join(bin, command));
    }
  }

  const env = {
    ...process.env,
    PATH: options.isolatedPath ? bin : `${bin}:${process.env.PATH}`,
    MOCK_CALLS: calls,
    MOCK_TMUX_STATE: path.join(root, 'tmux-state'),
    HOME: path.join(root, 'home with spaces'),
    XDG_CONFIG_HOME: path.join(root, 'config with spaces'),
    USER: 'tester',
  };

  return { root, bin, calls, env };
}

async function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync('/bin/sh', [RUN_SH, ...args], { env, timeout: 15_000 });
}

test('run.sh requires an explicit --dir before doing bootstrap work', async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      runScript(['--host=http://master', '--pairing=TOKEN'], fixture.env),
      (error: any) => {
        assert.match(error.stderr, /--dir is required/);
        return true;
      },
    );
  } finally {
    await fs.remove(fixture.root);
  }
});

test('run.sh prepares every local artifact beneath --dir and supports spaces', async () => {
  const fixture = await makeFixture();
  const installDir = path.join(fixture.root, "install root's");
  try {
    const result = await runScript([
      `--dir=${installDir}`,
      '--host=http://master/base',
      '--pairing=token with spaces',
      '--node-id=node with spaces',
      '--prepare-only',
    ], fixture.env);

    assert.match(result.stdout, /Preparation complete/);
    assert.equal(await fs.pathExists(path.join(installDir, 'data/state')), true);
    assert.equal(await fs.pathExists(path.join(installDir, 'foxwarm-node/packages/cli-node/dist/client.bundle.js')), true);
    assert.equal(await fs.pathExists(path.join(installDir, '.env')), true);
    assert.equal(await fs.pathExists(path.join(installDir, 'run-node-client.sh')), true);
    assert.equal(await fs.pathExists(path.join(installDir, 'systemd')), true);

    const launcher = await fs.readFile(path.join(installDir, 'run-node-client.sh'), 'utf8');
    assert.match(launcher, /--token 'token with spaces'/);
    assert.match(launcher, /--id 'node with spaces'/);
    assert.match(launcher, /install root.*data\/state\/node_credentials\.json/);
    await execFileAsync('/bin/sh', ['-n', path.join(installDir, 'run-node-client.sh')]);
    const envFile = await fs.readFile(path.join(installDir, '.env'), 'utf8');
    assert.match(envFile, /NODE_INSTALL_DIR='.*install root/);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('run.sh -d prefers tmux and records session, pid, log, and stop guidance', async () => {
  const fixture = await makeFixture({ tmux: true });
  const installDir = path.join(fixture.root, 'tmux install');
  try {
    const result = await runScript([
      '--dir', installDir,
      '--host', 'http://master',
      '--pairing', 'TOKEN',
      '--node-id', 'tmux-node',
      '-d',
    ], fixture.env);

    assert.match(result.stdout, /Background supervisor: tmux session/);
    assert.match(result.stdout, /tmux kill-session/);
    assert.equal((await fs.readFile(path.join(installDir, 'data/node.pid'), 'utf8')).trim(), '4242');
    assert.match(await fs.readFile(path.join(installDir, 'data/node.mode'), 'utf8'), /^tmux:/);
    assert.equal(await fs.pathExists(path.join(installDir, 'data/logs/node.log')), true);
    const tmuxCall = await fs.readFile(path.join(fixture.calls, 'tmux'), 'utf8');
    assert.match(tmuxCall, /new-session -d/);
    assert.match(tmuxCall, /run-node-client\.sh/);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('run.sh -d falls back to nohup when tmux is unavailable', async () => {
  const fixture = await makeFixture({ isolatedPath: true });
  const installDir = path.join(fixture.root, 'nohup install');
  let pid: number | undefined;
  try {
    const result = await runScript([
      `--dir=${installDir}`,
      '--host=http://master',
      '--pairing=TOKEN',
      '--node-id=nohup-node',
      '--detach',
    ], fixture.env);

    assert.match(result.stdout, /Background supervisor: nohup/);
    assert.match(result.stdout, /Stop: kill/);
    pid = Number((await fs.readFile(path.join(installDir, 'data/node.pid'), 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal((await fs.readFile(path.join(installDir, 'data/node.mode'), 'utf8')).trim(), 'nohup');
    process.kill(pid, 0);
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await fs.remove(fixture.root);
  }
});

test('run.sh starts the real prebuilt node bundle from a clean source archive without host node_modules', async () => {
  const fixture = await makeFixture({ isolatedPath: true });
  const installDir = path.join(fixture.root, 'clean distribution');
  const archivePath = path.join(fixture.root, 'source.tar.gz');
  const repoRoot = path.resolve(__dirname, '../..');
  let nodePid: number | undefined;
  let server: http.Server | undefined;
  try {
    await execFileAsync('tar', [
      '-czf', archivePath,
      ...NODE_SOURCE_TAR_EXCLUDES.map(relPath => `--exclude=${relPath}`),
      ...NODE_SOURCE_FILES,
    ], { cwd: repoRoot });
    const archiveListing = (await execFileAsync('tar', ['-tzf', archivePath])).stdout;
    assert.match(archiveListing, /packages\/shared\/dist\/codeHelperIpc\.js/);
    assert.doesNotMatch(archiveListing, /node_modules/);

    for (const command of ['curl', 'tar', 'node']) {
      await fs.remove(path.join(fixture.bin, command));
    }
    const realCurl = ['/usr/bin/curl', '/bin/curl'].find(candidate => fs.existsSync(candidate));
    const realTar = ['/usr/bin/tar', '/bin/tar'].find(candidate => fs.existsSync(candidate));
    assert.ok(realCurl, 'curl is required for the clean distribution test');
    assert.ok(realTar, 'tar is required for the clean distribution test');
    await fs.symlink(realCurl, path.join(fixture.bin, 'curl'));
    await fs.symlink(realTar, path.join(fixture.bin, 'tar'));
    await fs.symlink(process.execPath, path.join(fixture.bin, 'node'));
    await writeExecutable(path.join(fixture.bin, 'npm'), '#!/bin/sh\nexit 0\n');

    server = http.createServer((req, res) => {
      if (req.url === '/node/source.tar.gz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/gzip');
        fs.createReadStream(archivePath).pipe(res);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const result = await runScript([
      `--dir=${installDir}`,
      `--host=http://127.0.0.1:${port}`,
      '--pairing=TOKEN',
      '--node-id=clean-bundle-node',
      '--detach',
    ], { ...fixture.env, NODE_PATH: '' });

    assert.match(result.stdout, /Using bundled node client from source archive; skipping npm install/);
    assert.match(result.stdout, /Background supervisor: nohup/);
    nodePid = Number((await fs.readFile(path.join(installDir, 'data/node.pid'), 'utf8')).trim());
    assert.ok(Number.isInteger(nodePid) && nodePid > 0);
    process.kill(nodePid, 0);
    const log = await fs.readFile(path.join(installDir, 'data/logs/node.log'), 'utf8');
    assert.doesNotMatch(log, /Cannot find module 'fs-extra'/);
    assert.match(log, /Connecting to foxwarm master/);
  } finally {
    if (nodePid) {
      try { process.kill(nodePid, 'SIGTERM'); } catch {}
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fs.remove(fixture.root);
  }
});

test('run.sh --install selects a user service for non-root and starts foreground under systemd', async () => {
  const fixture = await makeFixture({ userSystemd: true });
  const installDir = path.join(fixture.root, "service $ % install's");
  try {
    const result = await runScript([
      `--dir=${installDir}`,
      '--host=http://master',
      '--pairing=TOKEN',
      '--node-id=service-node',
      '--install',
    ], fixture.env);

    assert.match(result.stdout, /started as a user systemd service/);
    assert.match(result.stdout, /does\s+not create a second tmux\/nohup daemon layer/);
    const unitName = 'foxwarm-node-service-node.service';
    const generated = path.join(installDir, 'systemd', unitName);
    const installed = path.join(fixture.env.XDG_CONFIG_HOME!, 'systemd/user', unitName);
    assert.equal(await fs.pathExists(generated), true);
    assert.equal(await fs.pathExists(installed), true);
    const unit = await fs.readFile(generated, 'utf8');
    assert.match(unit, /^Type=simple$/m);
    assert.match(unit, /^WorkingDirectory=\/tmp\/.*\\x20.*$/m);
    assert.match(unit, /^ExecStart=\/bin\/sh ".*service \$\$ %% install's\/run-node-client\.sh"$/m);
    assert.match(unit, /^StandardOutput=append:\/tmp\/.*\\x20.*$/m);
    assert.match(unit, /\\x24/);
    assert.match(unit, /\\x27/);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(unit, /--detach|tmux|nohup/);
    const systemdAnalyze = ['/usr/bin/systemd-analyze', '/bin/systemd-analyze'].find(candidate => fs.existsSync(candidate));
    if (systemdAnalyze) {
      await execFileAsync(systemdAnalyze, ['verify', generated]);
    }

    const calls = await fs.readFile(path.join(fixture.calls, 'systemctl'), 'utf8');
    assert.match(calls, /^--user show-environment$/m);
    assert.match(calls, /^--user daemon-reload$/m);
    assert.match(calls, /^--user enable foxwarm-node-service-node\.service$/m);
    assert.match(calls, /^--user restart foxwarm-node-service-node\.service$/m);
  } finally {
    await fs.remove(fixture.root);
  }
});
