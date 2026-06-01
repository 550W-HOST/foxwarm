import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndCompactIfNeeded } from './history';
import type { Session } from '../types';

function makeLargeSession(): Session {
  const history = Array.from({ length: 40 }, (_, idx) => ({
    role: idx % 2 === 0 ? 'user' as const : 'model' as const,
    parts: [{ text: `message ${idx} ` + 'x'.repeat(5000) }],
    __meta: { seq: idx + 1, timestamp: Date.now() + idx },
  }));

  return {
    id: 'compact_guard_test',
    agent: 'main',
    history,
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

test('failed/no-usage requests do not trigger auto compact from estimates', async () => {
  const session = makeLargeSession();
  let enqueueCount = 0;
  await checkAndCompactIfNeeded({
    getSessionById: (sessionId) => sessionId === session.id ? session : undefined,
    getExistingSession: async () => session,
    saveSession: async () => {},
    enqueueSessionItem: async () => { enqueueCount += 1; },
    notifyHistoryUpdate: () => {},
  }, session.id, undefined);

  assert.equal(enqueueCount, 0);
  assert.equal(session.queue.length, 0);
});
