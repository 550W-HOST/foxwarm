import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  buildTimerTriggeredMessage,
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

test('buildTimerTriggeredMessage adds current local time with numeric offset', () => {
  const firedAt = new Date(1_700_000_000_000);
  const offsetMinutes = -firedAt.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')}${String(absoluteMinutes % 60).padStart(2, '0')}`;

  const message = buildTimerTriggeredMessage({
    id: 'timer-1',
    sessionId: 'session-a',
    message: 'run nightly sync',
    createdAt: 1,
    cron: '0 * * * *',
  }, firedAt);

  assert.match(message, /^Scheduled timer fired \(id: timer-1\)\nCurrent time: /);
  assert.match(message, new RegExp(`${offset.replace('+', '\\+')}$`, 'm'));
  assert.match(message, /\nrun nightly sync$/);
  assert.doesNotMatch(message, /Asia\/Shanghai/);
});
