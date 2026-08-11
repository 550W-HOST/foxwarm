import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as sessionManager from '../sessionManager';
import * as mainManagementTools from '../mainManagementTools';
import { createTimersStore, resetTimersForTests, setTimersStoreForTests } from '../timers';
import type { Session } from '../types';
import { tool_wait } from '../toolsSessionAgent';

function createSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

test('detached no-timeout wait persists exact owner state without global lookup', async () => {
  const session = createSession(`detached_wait_${Date.now()}`);
  const originals = {
    getSession: sessionManager.getSession,
    save: sessionManager.saveSession,
  };
  (sessionManager as any).getSession = async () => { throw new Error('global get forbidden'); };
  (sessionManager as any).saveSession = async () => { throw new Error('global save forbidden'); };
  let persists = 0;
  try {
    const result: any = await tool_wait({
      reason: '  waiting for exact owner  ',
      waitAllSessions: [' child-a ', 'child-a', 'child-b'],
      waitExecIds: [' exec-a ', 'exec-a', 'exec-b'],
    }, {
      sessionId: session.id,
      session,
      persistCurrentSession: async () => { persists += 1; },
    } as any);
    assert.equal(persists, 1);
    assert.equal(session.meta.wait?.reason, 'waiting for exact owner');
    assert.deepEqual(session.meta.wait?.waitAll?.sessions, ['child-a', 'child-b']);
    assert.deepEqual(session.meta.wait?.waitExecIds, ['exec-a', 'exec-b']);
    assert.equal(result.__toolPostAction.explicitWaitId, session.meta.wait?.id);
    assert.equal(result.__toolLoopControl.stopCurrentTurn, true);
  } finally {
    (sessionManager as any).getSession = originals.getSession;
    (sessionManager as any).saveSession = originals.save;
  }
});

test('passed wait preserves deferred rejection and persistence-before-schedule failure ordering', async () => {
  const session = createSession(`detached_wait_fail_${Date.now()}`);
  session.meta.wait = {
    id: 'old-wait',
    startedAt: Date.now(),
    waitAll: {
      sessions: ['child-a'],
      satisfiedSessions: [],
      deferredQueue: [{ type: 'background', parts: [{ text: 'deferred' }] }],
    },
  } as any;
  let persists = 0;
  await assert.rejects(() => sessionManager.startSessionWaitForSession(session, {}, async () => { persists += 1; }),
    /previous waitAllSessions has deferred messages/);
  assert.equal(persists, 0);
  assert.equal(session.meta.wait?.id, 'old-wait');

  delete session.meta.wait;
  const originalSchedule = mainManagementTools.scheduleMainWaitTimeout;
  let schedules = 0;
  (mainManagementTools as any).scheduleMainWaitTimeout = async () => { schedules += 1; return { scheduled: true, waitId: 'unexpected' }; };
  try {
    await assert.rejects(() => tool_wait({ timeoutSeconds: 3 }, {
      sessionId: session.id,
      session,
      persistCurrentSession: async () => { throw new Error('persist failed'); },
    } as any), /persist failed/);
    assert.ok(session.meta.wait?.id, 'mutation still precedes its unconditional persistence attempt');
    assert.equal(session.meta.wait?.timeoutSeconds, 3);
    assert.equal(schedules, 0, 'timer scheduling remains after successful wait persistence');

    delete session.meta.wait;
    let successfulPersists = 0;
    (mainManagementTools as any).scheduleMainWaitTimeout = async () => {
      schedules += 1;
      throw new Error('schedule failed');
    };
    await assert.rejects(() => tool_wait({ timeoutSeconds: 4 }, {
      sessionId: session.id,
      session,
      persistCurrentSession: async () => { successfulPersists += 1; },
    } as any), /schedule failed/);
    assert.equal(successfulPersists, 1);
    assert.equal(schedules, 1);
    assert.equal(session.meta.wait?.timeoutSeconds, 4, 'schedule failure leaves the already-persisted wait intact');
  } finally {
    (mainManagementTools as any).scheduleMainWaitTimeout = originalSchedule;
  }
});

test('passed timeout wait persists before local Main scheduling and fires canonical payload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-detached-wait-timer-'));
  const sessionId = `passed_wait_timer_${Date.now()}`;
  setTimersStoreForTests(createTimersStore(path.join(root, 'timers.json')));
  sessionManager.setSessionTriggerCallback(() => {});
  let persists = 0;
  try {
    const owner = await sessionManager.getSession(sessionId);
    const result: any = await tool_wait({ timeoutSeconds: 0.02, reason: ' timeout reason ' }, {
      sessionId,
      session: owner,
      persistCurrentSession: async () => {
        persists += 1;
        await sessionManager.saveSession(sessionId);
      },
    } as any);
    const waitId = result.__toolPostAction.explicitWaitId;
    assert.equal(persists, 1);
    assert.equal(owner.meta.wait?.id, waitId);
    assert.equal(owner.meta.wait?.reason, 'timeout reason');

    const deadline = Date.now() + 1000;
    while (owner.queue.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(owner.queue.length, 1);
    assert.equal(owner.queue[0].waitTimeoutId, waitId);
    assert.match(owner.queue[0].parts[0].system || '', /^<foxwarm-system kind="event" type="wait-timeout" seconds="0\.02" time="[^"]+">\nwait timeout reached after 0\.02s\. No newer message or event triggered this session during the wait\.\n<\/foxwarm-system>$/);
  } finally {
    resetTimersForTests();
    setTimersStoreForTests(null);
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await mainManagementTools.shutdownMainManagementTools().catch(() => {});
    mainManagementTools.resetMainManagementToolsForTests();
    await fs.remove(root);
  }
});
