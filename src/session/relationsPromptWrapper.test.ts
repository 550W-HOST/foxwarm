import test from 'node:test';
import { parseFoxwarmWrappedContent } from '../utils/promptWrappers';
import { getChildHandoffBoundaryForQueueItem } from './childHandoffState';
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

test('Task delivery uses bounded task metadata without reply routes or a peer-report boundary', async () => {
  const source = makeSession('creator');
  const target = { ...makeSession('owner'), parentSessionId: source.id };
  let enqueued: QueueItem;
  let queueOptions: unknown;
  await sendToSession({
    getExistingSession: async id => id === source.id ? source : id === target.id ? target : null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_id, item, options) => { enqueued = item; queueOptions = options; },
  }, target.id, 'Task ownership transferred.', source.id, {
    trigger: false, taskNotification: { taskId: 'task_' + 'x'.repeat(160), event: 'transferred', recipient: 'new' },
  });
  const wrapped = parseFoxwarmWrappedContent(enqueued.parts[0].system);
  assert.equal(wrapped.attrs.type, 'task');
  assert.equal(wrapped.attrs.taskId.length, 128);
  assert.equal(wrapped.attrs.event, 'transferred');
  assert.equal(wrapped.attrs.sourceSessionId, source.id);
  const assignmentHint = wrapped.attrs.hint;
  assert.equal(typeof assignmentHint, 'string');
  assert.equal(wrapped.attrs.replyTargetSessionId, undefined);
  assert.equal(wrapped.attrs.replyVia, undefined);
  assert.equal(wrapped.content, 'Task ownership transferred.\n');
  assert.equal(enqueued.type, 'intersession', 'the existing delivery transport is unchanged');
  assert.equal(getChildHandoffBoundaryForQueueItem(enqueued), undefined, 'a system notice is not a parent directive needing a reply');
  assert.deepEqual(queueOptions, { trigger: false }, 'only existing queue options cross the enqueue boundary');

  await sendToSession({
    getExistingSession: async id => id === source.id ? source : id === target.id ? target : null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_id, item) => { enqueued = item; },
  }, target.id, 'Task ownership transferred.', source.id, {
    trigger: false, taskNotification: { taskId: 'task_previous', event: 'transferred', recipient: 'previous' },
  });
  assert.notEqual(parseFoxwarmWrappedContent(enqueued.parts[0].system).attrs.hint, assignmentHint);
});

test('User Task delivery keeps an explicit user source without fabricating a Session', async () => {
  const target = makeSession('user-task-owner');
  let enqueued: QueueItem;
  await sendToSession({
    getExistingSession: async id => id === target.id ? target : null,
    getAgentMetadata: () => ({}),
    enqueueSessionItem: async (_id, item) => { enqueued = item; },
  }, target.id, 'User comment.', undefined, {
    taskNotification: { taskId: 'task_user', event: 'note', sourceKind: 'user' },
  });
  const wrapped = parseFoxwarmWrappedContent(enqueued.parts[0].system);
  assert.equal(wrapped.attrs.type, 'task');
  assert.equal(wrapped.attrs.sourceKind, 'user');
  assert.equal(wrapped.attrs.sourceSessionId, undefined);
  assert.equal(wrapped.attrs.hint, 'Task notification from the user through Tasks.');
});
