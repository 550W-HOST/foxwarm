import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createExecRuntime, type ExecRuntime } from './execManager';

function createRuntime(root: string, name: string): ExecRuntime {
  const runtimeRoot = path.join(root, name);
  return createExecRuntime({
    getDefaultCwd: () => runtimeRoot,
    getExecTempDir: () => path.join(runtimeRoot, 'temp'),
    registryPath: path.join(runtimeRoot, 'running.json'),
  });
}

test('exec runtime factory isolates manager, registry, temp root, and foreground lifecycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-runtimes-'));
  const first = createRuntime(root, 'first');
  const second = createRuntime(root, 'second');
  try {
    assert.equal('dispose' in first, false);
    assert.equal('stop' in first, false);
    await Promise.all([fs.ensureDir(path.join(root, 'first')), fs.ensureDir(path.join(root, 'second'))]);
    await Promise.all([first.initialize(), first.initialize(), second.initialize()]);
    const [firstEntry, secondEntry] = await Promise.all([
      first.startPersistentExec({ command: 'printf first-runtime', agentName: 'main', sessionId: 'session-first' }),
      second.startPersistentExec({ command: 'printf second-runtime', agentName: 'main', sessionId: 'session-second' }),
    ]);

    assert.deepEqual(first.listRunningExecs().map(entry => entry.id), [firstEntry.id]);
    assert.deepEqual(second.listRunningExecs().map(entry => entry.id), [secondEntry.id]);
    assert.match(firstEntry.logPath, new RegExp(`${path.sep}first${path.sep}temp${path.sep}`));
    assert.match(secondEntry.logPath, new RegExp(`${path.sep}second${path.sep}temp${path.sep}`));

    const [firstStatus, secondStatus] = await Promise.all([
      first.waitForExecCompletion(firstEntry.id, 5000),
      second.waitForExecCompletion(secondEntry.id, 5000),
    ]);
    assert.equal(firstStatus?.exitCode, 0);
    assert.equal(secondStatus?.exitCode, 0);
    assert.match(await first.buildForegroundExecResult(firstEntry, firstStatus!), /first-runtime/);
    assert.match(await second.buildForegroundExecResult(secondEntry, secondStatus!), /second-runtime/);

    const firstRegistry = await fs.readJson(path.join(root, 'first', 'running.json'));
    const secondRegistry = await fs.readJson(path.join(root, 'second', 'running.json'));
    assert.deepEqual(firstRegistry.execs.map((entry: any) => entry.id), [firstEntry.id]);
    assert.deepEqual(secondRegistry.execs.map((entry: any) => entry.id), [secondEntry.id]);

    await Promise.all([
      first.finalizeForegroundExec(firstEntry.id),
      second.finalizeForegroundExec(secondEntry.id),
    ]);
    assert.deepEqual(first.listRunningExecs(), []);
    assert.deepEqual(second.listRunningExecs(), []);
    assert.deepEqual((await fs.readJson(path.join(root, 'first', 'running.json'))).execs, []);
    assert.deepEqual((await fs.readJson(path.join(root, 'second', 'running.json'))).execs, []);
  } finally {
    await fs.remove(root);
  }
});

test('exec runtime recovery uses a late dispatcher exactly once without a stop lifecycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-recovery-'));
  const registryPath = path.join(root, 'running.json');
  const logPath = path.join(root, 'finished.log');
  const statusPath = path.join(root, 'finished.status.json');
  const cwdPath = path.join(root, 'finished.cwd.txt');
  const id = 'exec_recovery_fixture';
  await fs.writeFile(logPath, 'recovered-runtime');
  await fs.writeJson(statusPath, { exitCode: 0, finishedAt: new Date().toISOString() });
  await fs.writeFile(cwdPath, root);
  await fs.writeJson(registryPath, { execs: [{
    id,
    pid: 99999999,
    sessionId: 'recovery-session',
    agentName: 'main',
    nodeId: 'master',
    command: 'printf recovered-runtime',
    initialCwd: root,
    logPath,
    statusPath,
    cwdPath,
    startedAt: Date.now() - 1000,
    notifyOnCompletion: true,
  }] });

  const runtime = createExecRuntime({
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'temp'),
    registryPath,
  });
  const notifications: Array<{ id: string; message: string }> = [];
  try {
    await Promise.all([
      runtime.initialize({
        completionDispatcher: async (entry, _status, message) => {
          notifications.push({ id: entry.id, message });
        },
      }),
      runtime.initialize(),
    ]);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].id, id);
    assert.match(notifications[0].message, /recovered-runtime/);
    assert.deepEqual(runtime.listRunningExecs(), []);
    assert.deepEqual((await fs.readJson(registryPath)).execs, []);
    await runtime.initialize();
    assert.equal(notifications.length, 1);
  } finally {
    await fs.remove(root);
  }
});
