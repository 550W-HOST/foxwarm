import test from 'node:test';
import assert from 'node:assert/strict';
import { setSessionParent } from './relations';
import type { Session } from '../types';

function makeSession(id: string, parentSessionId?: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    promptCacheKey: '00000000-0000-4000-8000-000000000000',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

test('setSessionParent rejects descendant parent cycles', async () => {
  const parent = makeSession('relations_parent');
  const child = makeSession('relations_child', parent.id);
  const grandchild = makeSession('relations_grandchild', child.id);
  const sessions = new Map<string, Session>([
    [parent.id, parent],
    [child.id, child],
    [grandchild.id, grandchild],
  ]);

  await assert.rejects(
    setSessionParent({
      getExistingSession: async (sessionId: string) => sessions.get(sessionId) || null,
      saveSession: async () => {},
      saveSessionsMetadata: async () => {},
      notifySessionListUpdated: () => {},
    }, parent.id, grandchild.id),
    /parent cycle/,
  );

  assert.equal(parent.parentSessionId, undefined);
});
