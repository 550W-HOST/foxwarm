import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createTimersStore,
  initializeTimers,
  listTimers,
  resetTimersForTests,
  setTimersStoreForTests,
} from './timers';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-timers-store-'));
  try {
    await run(dirPath);
  } finally {
    resetTimersForTests();
    setTimersStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

async function listBackupMatches(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name === `${base}.bak` || name.startsWith(`${base}.`) && name.endsWith('.bak')).map((name) => path.join(dir, name));
}

test('timers persistence uses lightweight no-backup writes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'timers.json');
    const store = createTimersStore(filePath);
    setTimersStoreForTests(store);
    resetTimersForTests();

    await store.write({
      timers: [{
        id: 'timer-a',
        sessionId: 'session-a',
        message: 'alpha',
        createdAt: 1,
        at: Date.now() + 60_000,
      }],
    });
    await store.write({
      timers: [{
        id: 'timer-a',
        sessionId: 'session-a',
        message: 'alpha',
        createdAt: 1,
        at: Date.now() + 60_000,
      }, {
        id: 'timer-b',
        sessionId: 'session-b',
        message: 'beta',
        createdAt: 2,
        at: Date.now() + 120_000,
      }],
    });
    resetTimersForTests();
    await initializeTimers();

    const timers = listTimers();
    assert.equal(timers.length, 2);
    assert.deepEqual(timers.map(timer => timer.id), ['timer-a', 'timer-b']);

    const rewritten = await fs.readJson(filePath);
    assert.equal(rewritten.timers.length, 2);
    assert.deepEqual(rewritten.timers.map((timer: any) => timer.id), ['timer-a', 'timer-b']);
    assert.deepEqual(createTimersStore(filePath).listCandidatePaths(), [filePath]);
    assert.deepEqual(await listBackupMatches(filePath), []);
  });
});
