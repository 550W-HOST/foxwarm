import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { Session } from '../types';
import { parseFoxwarmTagLine } from '../utils/promptWrappers';

const RESUME_SYSTEM = '<foxwarm-system hint="The Foxwarm process restarted while this session was busy. Foxwarm is resuming session processing." time="2026-07-27 05:00:00 +0800" type="session-resumed" kind="event" />';

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

test('restart and managed wakeup dedup inspect current wrapper attributes', () => {
  assert.equal(sessionManager.hasTrailingQueuedResumeEvent([]), false);
  assert.equal(sessionManager.hasTrailingQueuedResumeEvent([
    { type: 'background', parts: [{ system: RESUME_SYSTEM }] },
  ]), true);
  assert.equal(sessionManager.hasTrailingQueuedResumeEvent([
    { type: 'background', parts: [{ system: 'session resumed after process restart' }] },
  ]), false);

  const managedWrapper = '<foxwarm-system time="2026-07-27 05:00:00 +0800" pendingCount="2" managedSessionId="child-1" event="pending-inbox" kind="managed-session">\nbody may vary\n</foxwarm-system>';
  assert.equal(sessionManager.hasTrailingQueuedManagedInboxWakeup([
    { type: 'background', parts: [{ system: managedWrapper }] },
  ], 'child-1', 2), true);
  assert.equal(sessionManager.hasTrailingQueuedManagedInboxWakeup([
    { type: 'background', parts: [{ system: managedWrapper }] },
  ], 'child-1', 3), false);
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
    Object.assign(session, createBaseSession(sessionId), { busy: true });
    await sessionManager.saveSession(sessionId);

    await sessionManager.resumeBusySessions();
    let updated = await sessionManager.getSession(sessionId);
    assert.equal(updated.busy, false);
    assert.equal(updated.queue.length, 1);
    assert.equal(updated.queue[0].type, 'background');
    assert.equal(updated.queue[0].parts?.length, 1);
    const generatedResumeWrapper = updated.queue[0].parts?.[0].system || '';
    assert.match(generatedResumeWrapper, /\/>$/);
    const generatedTag = parseFoxwarmTagLine(generatedResumeWrapper);
    assert.equal(generatedTag?.tagName, 'foxwarm-system');
    assert.equal(generatedTag?.closing, false);
    assert.deepEqual(generatedTag?.attrs, {
      kind: 'event',
      type: 'session-resumed',
      hint: 'The Foxwarm process restarted while this session was busy. Foxwarm is resuming session processing.',
      time: generatedTag?.attrs.time,
    });
    assert.match(generatedTag?.attrs.time || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    assert.equal(triggerCount, 1);

    updated.busy = true;
    await sessionManager.saveSession(sessionId);

    await sessionManager.resumeBusySessions();
    updated = await sessionManager.getSession(sessionId);
    assert.equal(updated.busy, false);
    assert.equal(updated.queue.length, 1);
    assert.equal(updated.queue[0].parts?.[0].system, generatedResumeWrapper);
    assert.equal(triggerCount, 2);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
