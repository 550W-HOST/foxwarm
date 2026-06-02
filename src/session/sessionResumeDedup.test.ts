import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { Session } from '../types';

const RESUME_MESSAGE = 'session resumed after process restart';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    currentNode: 'master',
  };
}

test('hasTrailingQueuedSystemEvent matches only exact trailing system event item', () => {
  assert.equal(sessionManager.hasTrailingQueuedSystemEvent([], RESUME_MESSAGE, 'background'), false);
  assert.equal(sessionManager.hasTrailingQueuedSystemEvent([
    { type: 'background', parts: [{ system: RESUME_MESSAGE }] },
  ], RESUME_MESSAGE, 'background'), true);
  assert.equal(sessionManager.hasTrailingQueuedSystemEvent([
    { type: 'background', parts: [{ text: RESUME_MESSAGE }] },
  ], RESUME_MESSAGE, 'background'), false);
  assert.equal(sessionManager.hasTrailingQueuedSystemEvent([
    { type: 'background', parts: [{ system: RESUME_MESSAGE }, { system: 'extra' }] },
  ], RESUME_MESSAGE, 'background'), false);
  assert.equal(sessionManager.hasTrailingQueuedSystemEvent([
    { type: 'background', parts: [{ system: 'other message' }] },
  ], RESUME_MESSAGE, 'background'), false);
});

test('resumeBusySessions does not append duplicate trailing restart-resume events', async () => {
  const sessionId = makeId('resume_dedupe');
  let triggerCount = 0;
  sessionManager.setSessionTriggerCallback((triggeredId) => {
    if (triggeredId === sessionId) {
      triggerCount += 1;
    }
  });

  try {
    const session = await sessionManager.getSession(sessionId);
    Object.assign(session, createBaseSession(sessionId), {
      busy: true,
      queue: [{ type: 'background', parts: [{ system: RESUME_MESSAGE }] }],
    });
    await sessionManager.saveSession(sessionId);

    await sessionManager.resumeBusySessions();
    let updated = await sessionManager.getSession(sessionId);
    assert.equal(updated.busy, false);
    assert.equal(updated.queue.length, 1);
    assert.deepEqual(updated.queue[0], { type: 'background', parts: [{ system: RESUME_MESSAGE }] });
    assert.equal(triggerCount, 1);

    updated.busy = true;
    await sessionManager.saveSession(sessionId);

    await sessionManager.resumeBusySessions();
    updated = await sessionManager.getSession(sessionId);
    assert.equal(updated.busy, false);
    assert.equal(updated.queue.length, 1);
    assert.deepEqual(updated.queue[0], { type: 'background', parts: [{ system: RESUME_MESSAGE }] });
    assert.equal(triggerCount, 2);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
