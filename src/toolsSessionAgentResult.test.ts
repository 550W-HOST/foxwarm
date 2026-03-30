import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import { tool_end_turn, tool_set_todo } from './toolsSessionAgent';
import type { Session } from './types';

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

test('end_turn returns concise output without echoing reason text', async () => {
  const result = await tool_end_turn({ reason: 'because the handoff is complete' });
  assert.equal(result.output, 'ok');
  assert.deepEqual(result.__toolLoopControl, { stopCurrentTurn: true });
});

test('set_todo returns concise output without echoing todo content or remindEvery', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_todo');
  const session = await ensureSession(sessionId);
  try {
    const updated = await tool_set_todo({ todo: '- [ ] ship feature', remindEvery: 7 }, { sessionId, session });
    assert.equal(updated, 'ok');
    assert.doesNotMatch(String(updated), /ship feature|remindEvery|7/);

    const cleared = await tool_set_todo({ clear: true }, { sessionId, session });
    assert.equal(cleared, 'ok');
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});
