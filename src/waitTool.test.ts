import test from 'node:test';
import assert from 'node:assert/strict';

import * as sessionManager from './sessionManager';
import { buildWaitTimeoutMessage } from './timers';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupSession(sessionId: string): Promise<void> {
  await sessionManager.deleteSession(sessionId).catch(() => false);
}

test('buildWaitTimeoutMessage uses fixed text and no custom timeout message', () => {
  assert.equal(
    buildWaitTimeoutMessage({ waitTimeoutSeconds: 7 }),
    '[SYSTEM: wait timeout reached after 7s. No newer message or event triggered this session during the wait.]',
  );
});

test('active wait timeout queues a system event and clears wait state', async () => {
  const sessionId = makeSessionId('wait_timeout_active');
  try {
    await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 12 });

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 12 }),
    );

    const session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].waitTimeoutId, wait.id);
    assert.match(String(session.queue[0].parts?.[0]?.system), /wait timeout reached after 12s/);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('new session event clears active wait and makes later timeout stale', async () => {
  const sessionId = makeSessionId('wait_timeout_cancel');
  try {
    await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 30 });

    await sessionManager.queueSessionSystemEvent(sessionId, 'external wakeup', 'background');
    let session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    session = await sessionManager.getSession(sessionId);
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].waitTimeoutId, undefined);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('direct session turn wake clears active wait token', async () => {
  const sessionId = makeSessionId('wait_timeout_direct');
  try {
    const session = await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 45 });

    assert.equal(sessionManager.clearSessionWaitForDirectTurn(session, 'test-direct'), true);
    assert.equal(session.meta.wait, undefined);

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 45 }),
    );

    const reloaded = await sessionManager.getSession(sessionId);
    assert.equal(reloaded.queue.length, 0);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('new wait token replaces older wait timeout token', async () => {
  const sessionId = makeSessionId('wait_timeout_stale');
  try {
    await sessionManager.getSession(sessionId);
    const oldWait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 30 });
    const newWait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 60 });

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      oldWait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    const session = await sessionManager.getSession(sessionId);
    assert.equal(session.queue.length, 0);
    assert.equal(session.meta.wait?.id, newWait.id);
  } finally {
    await cleanupSession(sessionId);
  }
});
