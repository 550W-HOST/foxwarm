import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  buildTimerTriggeredMessage,
  createTimer,
  createTimersStore,
  deleteTimer,
  initializeTimers,
  isCronTimer,
  listTimers,
  resetTimersForTests,
  setTimersStoreForTests,
  updateTimer,
} from './timers';
import * as sessionManager from './sessionManager';
import {
  tool_create_timer,
  tool_delete_timer,
  tool_list_timers,
  tool_update_timer,
} from './toolsSessionAgent';

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

test('buildTimerTriggeredMessage wraps timer content in foxwarm-message metadata tag', () => {
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

  assert.match(message, /^<foxwarm-message /);
  assert.match(message, /type="timer"/);
  assert.match(message, /timerId="timer-1"/);
  assert.match(message, /mode="cron"/);
  assert.match(message, /hint="Scheduled timer fired"/);
  assert.match(message, new RegExp(`localTime="[^"]*${offset.replace('+', '\\+')}"`));
  assert.match(message, /\nrun nightly sync\n<\/foxwarm-message>$/);
  assert.doesNotMatch(message, /Asia\/Shanghai/);
});

test('updateTimer updates message and reschedules between one-shot and cron timers', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    const sessionId = `timer_update_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await sessionManager.getSession(sessionId);

      const created = await createTimer({
        sessionId,
        afterSeconds: 60,
        message: 'original message',
      });
      assert.equal(created.mode, 'once');

      const updatedMessage = await updateTimer({
        timerId: created.id,
        sessionId,
        message: 'updated message',
      });
      assert.equal(updatedMessage.id, created.id);
      assert.equal(updatedMessage.mode, 'once');
      assert.equal(updatedMessage.message, 'updated message');
      assert.equal(updatedMessage.at, created.at);

      const updatedCron = await updateTimer({
        timerId: created.id,
        sessionId,
        cron: '*/5 * * * *',
      });
      assert.equal(updatedCron.mode, 'cron');
      assert.equal(updatedCron.cron, '*/5 * * * *');
      assert.equal(updatedCron.at, undefined);
      assert.equal(typeof updatedCron.nextRunAt, 'number');
      assert.ok(isCronTimer(updatedCron));

      const updatedOnce = await updateTimer({
        timerId: created.id,
        sessionId,
        afterSeconds: 120,
      });
      assert.equal(updatedOnce.mode, 'once');
      assert.equal(updatedOnce.cron, undefined);
      assert.equal(typeof updatedOnce.at, 'number');
      assert.equal(typeof updatedOnce.nextRunAt, 'number');
      assert.ok(updatedOnce.nextRunAt! > Date.now());
    } finally {
      for (const timer of listTimers(sessionId)) {
        await deleteTimer(timer.id, sessionId).catch(() => false);
      }
      await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  });
});

test('updateTimer validates ownership, missing ids, and mutually exclusive schedules', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    const sessionId = `timer_update_errors_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await sessionManager.getSession(sessionId);
      const created = await createTimer({
        sessionId,
        afterSeconds: 60,
        message: 'error path message',
      });

      await assert.rejects(
        () => updateTimer({ timerId: 'missing-timer', sessionId, message: 'nope' }),
        /not found/,
      );
      await assert.rejects(
        () => updateTimer({ timerId: created.id, sessionId: 'other-session', message: 'nope' }),
        /does not belong to session/,
      );
      await assert.rejects(
        () => updateTimer({ timerId: created.id, sessionId, afterSeconds: 30, cron: '* * * * *' }),
        /At most one of `at`, `afterSeconds`, or `cron`/,
      );
      await assert.rejects(
        () => updateTimer({ timerId: created.id, sessionId }),
        /At least one timer field/,
      );
      await assert.rejects(
        () => updateTimer({ timerId: created.id, sessionId, newSession: false, sessionPrefix: 'daily' }),
        /sessionPrefix may only be supplied when newSession=true/,
      );
    } finally {
      for (const timer of listTimers(sessionId)) {
        await deleteTimer(timer.id, sessionId).catch(() => false);
      }
      await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  });
});

test('timer tools create, update, list, and delete through the session-agent facade', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    const sessionId = `timer_tools_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const session = await sessionManager.getSession(sessionId);
      const ctx = { sessionId, session };

      const created = String(await tool_create_timer({
        afterSeconds: 60,
        message: 'tool facade original',
      }, ctx));
      const timerId = created.match(/Timer `([^`]+)` created/)?.[1];
      assert.ok(timerId, created);

      const listed = String(await tool_list_timers({}, ctx));
      assert.match(listed, new RegExp(timerId));
      assert.match(listed, /tool facade original/);

      const updated = String(await tool_update_timer({
        timerId,
        cron: '*/10 * * * *',
        message: 'tool facade updated',
      }, ctx));
      assert.ok(updated.includes(`Timer \`${timerId}\` updated`), updated);
      assert.match(updated, /Mode: cron: \*\/10 \* \* \* \*/);
      assert.match(updated, /tool facade updated/);

      const listedAfterUpdate = String(await tool_list_timers({}, ctx));
      assert.match(listedAfterUpdate, /cron: \*\/10 \* \* \* \*/);
      assert.match(listedAfterUpdate, /tool facade updated/);

      const deleted = String(await tool_delete_timer({ timerId }, ctx));
      assert.ok(deleted.includes(`Timer \`${timerId}\` deleted`), deleted);

      const listedAfterDelete = String(await tool_list_timers({}, ctx));
      assert.match(listedAfterDelete, /No timers found/);
    } finally {
      for (const timer of listTimers(sessionId)) {
        await deleteTimer(timer.id, sessionId).catch(() => false);
      }
      await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  });
});

test('cron parser/runtime supports L and rejects W expressions', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    const sessionId = `timer_cron_l_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await sessionManager.getSession(sessionId);
      const lastDay = await createTimer({
        sessionId,
        cron: '0 0 L * *',
        message: 'last day of month',
      });
      assert.equal(lastDay.mode, 'cron');
      assert.equal(lastDay.cron, '0 0 L * *');
      assert.equal(typeof lastDay.nextRunAt, 'number');

      const lastMonday = await createTimer({
        sessionId,
        cron: '0 0 0 * * 1L',
        message: 'last monday of month',
      });
      assert.equal(lastMonday.mode, 'cron');
      assert.equal(lastMonday.cron, '0 0 0 * * 1L');
      assert.equal(typeof lastMonday.nextRunAt, 'number');

      await assert.rejects(
        () => createTimer({
          sessionId,
          cron: '0 0 15W * *',
          message: 'nearest weekday is unsupported',
        }),
        /Invalid cron expression/,
      );
    } finally {
      for (const timer of listTimers(sessionId)) {
        await deleteTimer(timer.id, sessionId).catch(() => false);
      }
      await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  });
});
