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

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.pathExists(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('exec runtime factory isolates manager, registry, temp root, and lifecycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-runtimes-'));
  const first = createRuntime(root, 'first');
  const second = createRuntime(root, 'second');
  let firstRecovered: ExecRuntime | undefined;
  let secondRecovered: ExecRuntime | undefined;
  try {
    await Promise.all([fs.ensureDir(path.join(root, 'first')), fs.ensureDir(path.join(root, 'second'))]);
    await Promise.all([first.initialize(), first.initialize(), second.initialize()]);
    const [firstEntry, secondEntry] = await Promise.all([
      first.startPersistentExec({ command: 'sleep 0.1; printf first-runtime', agentName: 'main', sessionId: 'session-first' }),
      second.startPersistentExec({ command: 'sleep 0.1; printf second-runtime', agentName: 'main', sessionId: 'session-second' }),
    ]);

    assert.deepEqual(first.listRunningExecs().map(entry => entry.id), [firstEntry.id]);
    assert.deepEqual(second.listRunningExecs().map(entry => entry.id), [secondEntry.id]);
    assert.match(firstEntry.logPath, new RegExp(`${path.sep}first${path.sep}temp${path.sep}`));
    assert.match(secondEntry.logPath, new RegExp(`${path.sep}second${path.sep}temp${path.sep}`));
    await Promise.all([
      first.markExecForBackgroundNotification(firstEntry.id),
      second.markExecForBackgroundNotification(secondEntry.id),
    ]);

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

    await Promise.all([first.dispose(), second.dispose()]);
    const firstNotifications: string[] = [];
    const secondNotifications: string[] = [];
    firstRecovered = createRuntime(root, 'first');
    secondRecovered = createRuntime(root, 'second');
    await Promise.all([
      firstRecovered.initialize({ completionDispatcher: async entry => { firstNotifications.push(entry.id); } }),
      secondRecovered.initialize({ completionDispatcher: async entry => { secondNotifications.push(entry.id); } }),
    ]);
    assert.deepEqual(firstNotifications, [firstEntry.id]);
    assert.deepEqual(secondNotifications, [secondEntry.id]);
    assert.deepEqual(firstRecovered.listRunningExecs(), []);
    assert.deepEqual(secondRecovered.listRunningExecs(), []);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    if (firstRecovered) await firstRecovered.dispose();
    if (secondRecovered) await secondRecovered.dispose();
    await fs.remove(root);
  }
});

test('exec runtime recovery uses its late dispatcher once and dispose permits a new owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-recovery-'));
  const registryPath = path.join(root, 'running.json');
  const options = {
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'temp'),
    registryPath,
  };
  const first = createExecRuntime(options);
  let second: ExecRuntime | undefined;
  try {
    await first.initialize();
    const entry = await first.startPersistentExec({
      command: 'sleep 0.2; printf recovered-runtime',
      agentName: 'main',
      sessionId: 'recovery-session',
    });
    await first.markExecForBackgroundNotification(entry.id);
    await first.dispose();
    await waitForFile(entry.statusPath);

    const notifications: Array<{ id: string; message: string }> = [];
    second = createExecRuntime(options);
    await second.initialize({
      completionDispatcher: async (completed, _status, message) => {
        notifications.push({ id: completed.id, message });
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].id, entry.id);
    assert.match(notifications[0].message, /recovered-runtime/);
    assert.deepEqual(second.listRunningExecs(), []);

    await second.initialize();
    assert.equal(notifications.length, 1);
    const registry = await fs.readJson(registryPath);
    assert.deepEqual(registry.execs, []);
  } finally {
    await first.dispose();
    if (second) await second.dispose();
    await fs.remove(root);
  }
});
