import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import schedule from 'node-schedule';
import {
  buildTimerTriggeredMessage,
  createTimer,
  createTimersStore,
  createWaitTimeoutTimer,
  deleteTimer,
  fireTimerForTests,
  initializeTimers,
  isCronTimer,
  listTimers,
  resetTimersForTests,
  setTriggeredSessionNameFactoryForTests,
  setTimersStoreForTests,
  updateTimer,
} from './timers';
import * as sessionManager from './sessionManager';
import { getAgentDir, loadModelsConfigFromObject, resolveModelConfig } from './config';
import {
  create_timer as tool_create_timer,
  delete_timer as tool_delete_timer,
  list_timers as tool_list_timers,
  update_timer as tool_update_timer,
} from './tools';

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
  assert.match(message, new RegExp(`time="[^"]*${offset.replace('+', '\\+')}"`));
  assert.match(message, /\nrun nightly sync\n<\/foxwarm-message>$/);
  assert.doesNotMatch(message, /Asia\/Shanghai/);
});

test('one-time scheduling treats only a null job whose deadline crossed as due', async () => {
  await withTempDir(async (dirPath) => {
    const timersPath = path.join(dirPath, 'timers.json');
    setTimersStoreForTests(createTimersStore(timersPath));
    const originalScheduleJob = schedule.scheduleJob;
    const sessionIds = ['crossed', 'future', 'valid'].map(suffix => `timer_boundary_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const prepareWait = async (sessionId: string, waitId: string, timeoutSeconds: number) => {
      const session = await sessionManager.getSession(sessionId);
      session.meta.wait = { id: waitId, startedAt: Date.now(), timeoutSeconds };
      await sessionManager.saveSession(sessionId);
      return session;
    };
    const waitForQueue = async (session: any) => {
      const deadline = Date.now() + 2000;
      while (session.queue.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(session.queue.length, 1);
    };

    try {
      const crossed = await prepareWait(sessionIds[0], 'wait-crossed', 0.2);
      let crossedAtEntry = false;
      (schedule as any).scheduleJob = (date: Date): any => {
        crossedAtEntry = date.getTime() > Date.now();
        while (Date.now() <= date.getTime()) {}
        return null;
      };
      await createWaitTimeoutTimer({ sessionId: crossed.id, waitId: 'wait-crossed', timeoutSeconds: 0.2 });
      await waitForQueue(crossed);
      assert.equal(crossedAtEntry, true, 'the library hook is entered while the deadline is still future');
      assert.equal(crossed.meta.wait, undefined);
      assert.equal(crossed.queue[0].waitTimeoutId, 'wait-crossed');
      assert.match(crossed.queue[0].parts[0].system || '', /wait timeout reached after 0\.2s/);

      const future = await prepareWait(sessionIds[1], 'wait-future', 1);
      (schedule as any).scheduleJob = (): any => null;
      await assert.rejects(() => createWaitTimeoutTimer({ sessionId: future.id, waitId: 'wait-future', timeoutSeconds: 1 }), /Invalid timer date/);
      assert.equal(future.queue.length, 0);

      const valid = await prepareWait(sessionIds[2], 'wait-valid', 1);
      let validCallback: (() => void) | undefined;
      (schedule as any).scheduleJob = (_date: Date, callback: () => void): any => {
        validCallback = callback;
        return { cancel: () => true };
      };
      await createWaitTimeoutTimer({ sessionId: valid.id, waitId: 'wait-valid', timeoutSeconds: 1 });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(valid.queue.length, 0, 'a valid scheduled job gets no immediate duplicate delivery');
      assert.ok(validCallback);
      validCallback();
      await waitForQueue(valid);
      assert.equal(valid.queue[0].waitTimeoutId, 'wait-valid');
    } finally {
      (schedule as any).scheduleJob = originalScheduleJob;
      for (const sessionId of sessionIds) await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  });
});

test('new-session timer allocation skips an archived generated id', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    await fs.ensureDir(getAgentDir('main'));
    const ownerId = `timer_owner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const archivedName = `timer_archived_${Date.now()}`;
    const replacementName = `${archivedName}_2`;

    try {
      const owner = await sessionManager.createEmptySession(ownerId);
      owner.session.effort = 'none';
      await sessionManager.saveSession(ownerId);
      const archived = await sessionManager.createEmptySession(archivedName);
      await sessionManager.appendSessionMessage(archived.session, {
        role: 'user',
        parts: [{ text: 'old timer generation' }],
        __meta: { timestamp: Date.now() },
      });
      await sessionManager.deleteSession(archivedName);

      let generated = 0;
      setTriggeredSessionNameFactoryForTests(() => generated++ === 0 ? archivedName : replacementName);
      const timer = await createTimer({
        sessionId: ownerId,
        afterSeconds: 60,
        message: 'timer allocation payload',
        newSession: true,
        sessionPrefix: 'timer',
      });
      assert.equal(timer.effort, 'none');
      await fireTimerForTests(timer.id);

      assert.equal(await sessionManager.getExistingSession(archivedName), null);
      const replacement = await sessionManager.getExistingSession(replacementName);
      assert.ok(replacement);
      assert.equal(replacement.effort, 'none');
      assert.equal(replacement.queue.length, 1);
    } finally {
      setTriggeredSessionNameFactoryForTests();
      for (const timer of listTimers(ownerId)) {
        await deleteTimer(timer.id, ownerId).catch(() => false);
      }
      for (const id of [ownerId, archivedName, replacementName]) {
        if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => false);
      }
    }
  });
});

test('new-session timer fire revalidates snapshotted effort against current concrete and virtual capabilities', async () => {
  await withTempDir(async (dirPath) => {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    await fs.ensureDir(getAgentDir('main'));
    const ownerId = `timer_effort_drift_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const generatedIds = [
      `${ownerId}_cleared`,
      `${ownerId}_preserved`,
      `${ownerId}_virtual`,
    ];
    const { currentKey } = resolveModelConfig();
    const slash = currentKey.indexOf('/');
    assert.ok(slash > 0);
    const providerKey = currentKey.slice(0, slash);
    const modelId = currentKey.slice(slash + 1);
    const concreteConfig = (allowed: string[], defaultEffort: string) => loadModelsConfigFromObject({
      default: currentKey,
      providers: {
        [providerKey]: {
          providerType: 'openai-responses',
          effort: { allowed, default: defaultEffort },
          models: [modelId],
        },
      },
    });
    const beforeDrift = concreteConfig(['low', 'high'], 'high');
    const afterDrift = concreteConfig(['high'], 'high');
    const virtualConfig = loadModelsConfigFromObject({
      default: 'timer-route',
      providers: {
        [providerKey]: {
          providerType: 'openai-responses',
          effort: { allowed: ['high'], default: 'high' },
          models: [modelId],
        },
        'timer-other': {
          providerType: 'anthropic',
          effort: { allowed: ['medium', 'high'], default: 'high' },
          models: ['secondary'],
        },
        'timer-route': {
          providerType: 'failover',
          targets: [currentKey, 'timer-other/secondary'],
        },
      },
    });

    try {
      const owner = await sessionManager.createEmptySession(ownerId);
      owner.session.model = currentKey;
      owner.session.effort = 'low';
      await sessionManager.saveSession(ownerId);
      const cleared = await createTimer({
        sessionId: ownerId, afterSeconds: 60, message: 'cleared effort delivery', newSession: true,
      }, beforeDrift);
      assert.equal(cleared.model, currentKey);
      assert.equal(cleared.effort, 'low');

      owner.session.effort = 'high';
      await sessionManager.saveSession(ownerId);
      const preserved = await createTimer({
        sessionId: ownerId, afterSeconds: 60, message: 'preserved effort delivery', newSession: true,
      }, beforeDrift);
      assert.equal(preserved.effort, 'high');

      owner.session.model = 'timer-route';
      owner.session.effort = 'medium';
      await sessionManager.saveSession(ownerId);
      const virtual = await createTimer({
        sessionId: ownerId, afterSeconds: 60, message: 'virtual effort delivery', newSession: true,
      }, virtualConfig);
      assert.equal(virtual.effort, 'medium');

      let generated = 0;
      setTriggeredSessionNameFactoryForTests(() => generatedIds[generated++]);
      await fireTimerForTests(cleared.id, afterDrift);
      await fireTimerForTests(preserved.id, afterDrift);
      await fireTimerForTests(virtual.id, virtualConfig);

      const clearedSession = await sessionManager.getExistingSession(generatedIds[0]);
      const preservedSession = await sessionManager.getExistingSession(generatedIds[1]);
      const virtualSession = await sessionManager.getExistingSession(generatedIds[2]);
      assert.equal(clearedSession?.model, currentKey);
      assert.equal(clearedSession?.effort, undefined);
      assert.equal(clearedSession?.queue.length, 1);
      assert.equal(preservedSession?.effort, 'high');
      assert.equal(preservedSession?.queue.length, 1);
      assert.equal(virtualSession?.model, 'timer-route');
      assert.equal(virtualSession?.effort, 'medium');
      assert.equal(virtualSession?.queue.length, 1);
      assert.equal(listTimers(ownerId).length, 0);
    } finally {
      setTriggeredSessionNameFactoryForTests();
      for (const timer of listTimers(ownerId)) await deleteTimer(timer.id, ownerId).catch(() => false);
      for (const id of [ownerId, ...generatedIds]) {
        if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => false);
      }
    }
  });
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
