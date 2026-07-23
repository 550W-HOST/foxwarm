import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'fs-extra';
import { PersistentExecManager } from './persistentExec';

test('PersistentExecManager serializes concurrent registry mutations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-'));
  const registryPath = path.join(root, 'running-exec.json');
  const manager = new PersistentExecManager({
    registryPath,
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
  });

  try {
    await Promise.all([manager.initialize(), manager.initialize(), manager.initialize()]);
    const [first, second] = await Promise.all([
      manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' }),
      manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' }),
    ]);

    let persisted = await fs.readJson(registryPath);
    assert.deepEqual(new Set(persisted.execs.map((entry: any) => entry.id)), new Set([first.id, second.id]));

    await Promise.all([
      manager.markExecForBackgroundNotification(first.id),
      manager.markExecForBackgroundNotification(second.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.equal(persisted.execs.length, 2);
    assert(persisted.execs.every((entry: any) => entry.notifyOnCompletion === true));

    await Promise.all([
      manager.finalizeForegroundExec(first.id),
      manager.finalizeForegroundExec(second.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.deepEqual(persisted.execs, []);
    assert.deepEqual(manager.listRunningExecs(), []);

    const third = await manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' });
    await Promise.all([
      manager.markExecForBackgroundNotification(third.id),
      manager.finalizeForegroundExec(third.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.deepEqual(persisted.execs, []);
    assert.deepEqual(manager.listRunningExecs(), []);
  } finally {
    await fs.remove(root);
  }
});