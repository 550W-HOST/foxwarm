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
  assert.equal(enqueued.parts?.length, 1);
  const wrapped = enqueued.parts?.[0].system || '';
  assert.match(wrapped, /^<foxwarm-message type="inter-agent" sourceSessionId="source&quot;&lt;&amp;" replyTargetSessionId="source&quot;&lt;&amp;" replyVia="send_to_session" time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}" hint="inter-agent message from another session, not direct end-user input">/);
  assert.match(wrapped, /\nraw <tag> & <\/foxwarm-message> stays raw\n<\/foxwarm-message>$/);
});

test('sendToSession timestamps a system-delivered wrapper when there is no source session', async () => {
  const target = makeSession('target');
  let enqueued: QueueItem | null = null;
  await sendToSession({
    getExistingSession: async (sessionId: string) => sessionId === target.id ? target : null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_sessionId: string, item: QueueItem) => { enqueued = item; },
  }, target.id, 'system input');
  assert.match(enqueued?.parts?.[0].system || '', /^<foxwarm-message type="system-delivered" time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}" hint=/);
});

test('sendToSession captures the canonical source relation for the exact target queue item', async () => {
  const parent = makeSession('parent');
  const child = { ...makeSession('child'), parentSessionId: parent.id };
  const unrelated = makeSession('unrelated');
  const sessions = new Map([parent, child, unrelated].map(session => [session.id, session]));
  const relations: Array<QueueItem['sourceSessionRelation']> = [];
  const deps = {
    getExistingSession: async (sessionId: string) => sessions.get(sessionId) || null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_sessionId: string, item: QueueItem) => { relations.push(item.sourceSessionRelation); },
  };

  await sendToSession(deps, child.id, 'parent to child', parent.id);
  await sendToSession(deps, parent.id, 'child to parent', child.id);
  await sendToSession(deps, unrelated.id, 'other', child.id);

  assert.deepEqual(relations, ['parent', 'direct-child', 'other']);
});
