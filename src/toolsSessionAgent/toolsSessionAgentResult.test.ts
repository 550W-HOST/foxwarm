import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { tool_set_goal, tool_wait } from '../toolsSessionAgent';
import type { Session } from '../types';

function makeSessionId(prefix: string): string {
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
  } as Session;
}

async function ensureSession(id: string): Promise<Session> {
  const existing = await sessionManager.getSession(id);
  Object.assign(existing, createBaseSession(id));
  await sessionManager.saveSession(id);
  return existing;
}

test('wait returns concise output without echoing reason text', async () => {
  const result = await tool_wait({ reason: 'because the handoff is complete' });
  assert.equal(result.output, 'ok');
  assert.deepEqual(result.__toolLoopControl, { stopCurrentTurn: true });
});

test('set_goal returns concise output without echoing goal content or remindEvery', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_goal');
  const session = await ensureSession(sessionId);
  try {
    const updated = await tool_set_goal({ goal: 'Ship feature safely', remindEvery: 7 }, { sessionId, session });
    assert.equal(updated, 'ok');
    assert.doesNotMatch(String(updated), /ship feature|remindEvery|7/);

    const cleared = await tool_set_goal({ clear: true }, { sessionId, session });
    assert.equal(cleared, 'ok');
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});

test('set_goal accepts omitted remindEvery and configurable remindOnTurnEnd', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_goal_optional');
  const session = await ensureSession(sessionId);
  try {
    const updated = await tool_set_goal({ goal: 'Ship feature safely', remindOnTurnEnd: false }, { sessionId, session });
    assert.equal(updated, 'ok');
    assert.equal(session.goalState?.remindEvery, 10);
    assert.equal(session.goalState?.remindOnTurnEnd, false);

    const second = await tool_set_goal({ goal: 'Ship feature later' }, { sessionId, session });
    assert.equal(second, 'ok');
    assert.equal(session.goalState?.remindEvery, 10);
    assert.equal(session.goalState?.remindOnTurnEnd, false);
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});
