import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToSession } from './relations';
import type { QueueItem, Session } from '../types';

function makeSession(id: string): Session {
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
  };
}

test('sendToSession wraps inter-agent content in foxwarm-message with escaped attrs and raw body', async () => {
  const source = makeSession('source"<&');
  const target = makeSession('target');
  let enqueued: QueueItem | null = null;

  await sendToSession({
    getExistingSession: async (sessionId: string) => sessionId === source.id ? source : sessionId === target.id ? target : null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_sessionId: string, item: QueueItem) => { enqueued = item; },
  }, target.id, 'raw <tag> & </foxwarm-message> stays raw', source.id);

  assert.ok(enqueued);
  assert.equal(enqueued.type, 'intersession');
  assert.deepEqual(enqueued.parts, [{
    system: '<foxwarm-message type="inter-agent" sourceSessionId="source&quot;&lt;&amp;" replyTargetSessionId="source&quot;&lt;&amp;" replyVia="send_to_session" hint="inter-agent message from another session, not direct end-user input">\nraw <tag> & </foxwarm-message> stays raw\n</foxwarm-message>',
  }]);
});
