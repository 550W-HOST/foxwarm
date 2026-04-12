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

test('timers initialization recovers from backup candidate after primary corruption', async () => {
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

    await fs.writeFile(filePath, '{broken-json');
    resetTimersForTests();
    await initializeTimers();

    const timers = listTimers();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].id, 'timer-a');

    const rewritten = await fs.readJson(filePath);
    assert.equal(rewritten.timers.length, 1);
    assert.equal(rewritten.timers[0].id, 'timer-a');
  });
});
