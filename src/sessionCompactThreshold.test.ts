import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import { tool_set_session_compact_threshold } from './toolsSessionAgent';
import { Session } from './types';

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
  };
}

test('compact threshold defaults to model-derived threshold unless overridden', () => {
  const inherited = sessionManager.getEffectiveCompactThresholdTokens({ model: undefined } as any);
  assert(inherited > 0);
  assert.equal(sessionManager.getDefaultCompactThresholdTokens({ model: undefined } as any), inherited);
  assert.equal(
    sessionManager.getEffectiveCompactThresholdTokens({ model: undefined, compactThresholdTokens: 4321 } as any),
    4321,
  );
});

test('set_session_compact_threshold tool updates, inspects, and clears session override', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_threshold_test');

  try {
    const session = await sessionManager.getSession(sessionId);
    Object.assign(session, createBaseSession(sessionId));
    await sessionManager.saveSession(sessionId);

    const inheritedStatus = await tool_set_session_compact_threshold({}, { sessionId, session });
    assert.match(String(inheritedStatus), /inherit global default/);

    const updatedStatus = await tool_set_session_compact_threshold({ thresholdTokens: 8000 }, { sessionId, session });
    assert.match(String(updatedStatus), /8000 tokens/);
    const updated = await sessionManager.getSession(sessionId);
    assert.equal(updated.compactThresholdTokens, 8000);
    assert.equal(sessionManager.getEffectiveCompactThresholdTokens(updated), 8000);

    const clearedStatus = await tool_set_session_compact_threshold({ clear: true }, { sessionId, session: updated });
    assert.match(String(clearedStatus), /compact threshold cleared/i);
    const cleared = await sessionManager.getSession(sessionId);
    assert.equal(cleared.compactThresholdTokens, undefined);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
