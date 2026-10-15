import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { COMMANDS } from '../commands';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { DATA_ROOT_DIR } from '../config';
import { getSessionHistoryFilePath } from '../session/metadataStore';
import { readDetachedWorkerSession } from '../sessionWorkerSnapshot';
import { SessionWorkerIngressCoordinator } from '../sessionWorkerIngress';
import { SessionWorkerStore } from '../sessionWorkerStore';
import { SessionWorkerSupervisor } from '../sessionWorkerSupervisor';
import { MessagePart, Session } from '../types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createParent(id: string): Promise<Session> {
  const session = await sessionManager.getSession(id);
  Object.assign(session, {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    currentNode: 'master',
  });
  await sessionManager.saveSession(id);
  return session;
}

function systemText(parts?: MessagePart[]): string {
  return parts?.map(part => part.system || '').join('') || '';
}

function mockContext(replies: string[]) {
  return {
    channelUserId: 'test-user',
    conversationId: 'test-conversation',
    channelId: 'test-channel',
    channelType: 'webui',
    platform: 'webui',
    senderId: 'test-user',
    username: 'test-user',
    reply: async (text: string) => { replies.push(text); },
    sendTyping: async () => {},
  } as any;
}

test('/fork supports no args without triggering an idle parent', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_command_no_args');
  const parent = await createParent(parentId);
  const replies: string[] = [];
  const triggered: string[] = [];
  sessionManager.setSessionTriggerCallback(sessionId => { triggered.push(sessionId); });

  try {
    await COMMANDS['/fork'].handler(mockContext(replies), [], parentId, parent, undefined);
    const [childId] = sessionManager.getChildSessionIds(parentId);
    assert.ok(childId);
    const child = await sessionManager.getSession(childId);
    assert.equal(child.parentSessionId, parentId);
    assert.equal(child.childHandoffState, undefined);
    assert.deepEqual(child.history.map(message => message.role), ['user', 'user']);
    assert.match(systemText(child.history[0].parts), /kind="session-boundary"/);
    assert.ok(systemText(child.history[1].parts).includes(`manually forked by the user from session \`${parentId}\``));
    assert.doesNotMatch(systemText(child.history[1].parts), /send_to_session|Waiting for task/);
    assert.equal(parent.queue.length, 0);
    assert.deepEqual(triggered, []);
    const notification = systemText(parent.history.at(-1)?.parts);
    assert.match(notification, /kind="session-event" event="manual-fork-created"/);
    assert.match(notification, new RegExp(`currentSessionId="${parentId}"`));
    assert.match(notification, new RegExp(`childSessionId="${childId}"`));
    assert.ok(notification.includes(`from the current session \`${parentId}\``));
    assert.match(notification, /Initial message: \(none\)/);
    assert.match(replies.at(-1) || '', new RegExp(childId));
  } finally {
    for (const childId of sessionManager.getChildSessionIds(parentId)) {
      await sessionManager.deleteSession(childId).catch(() => {});
    }
    await sessionManager.deleteSession(parentId).catch(() => {});
    sessionManager.setSessionTriggerCallback(() => {});
  }
});

test('/fork preserves the complete message after a custom suffix', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_command_message');
  const parent = await createParent(parentId);
  const suffix = 'custom_suffix';
  const childId = `${parentId}_${suffix}`;
  const initialMessage = 'first line with  spaces\nsecond line\n';
  const rawArgs = `${suffix}   ${initialMessage}`;
  const replies: string[] = [];
  sessionManager.setSessionTriggerCallback(() => {});

  try {
    await COMMANDS['/fork'].handler(mockContext(replies), rawArgs.trim().split(/\s+/), parentId, parent, rawArgs);
    const child = await sessionManager.getSession(childId);
    assert.equal(child.queue.length, 1);
    assert.equal(child.queue[0].type, 'user');
    assert.equal(child.queue[0].sourceSessionId, undefined);
    assert.equal(child.queue[0].sourceSessionRelation, undefined);
    assert.deepEqual(child.queue[0].parts, [{ text: initialMessage }]);
    const notification = systemText(parent.history.at(-1)?.parts);
    assert.match(notification, /kind="session-event" event="manual-fork-created"/);
    assert.match(notification, new RegExp(`currentSessionId="${parentId}"`));
    assert.match(notification, new RegExp(`childSessionId="${childId}"`));
    assert.ok(notification.includes(initialMessage));
    assert.match(replies.at(-1) || '', /Initial message sent/);
  } finally {
    await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('/session fork uses the user origin while retaining its channel switch', async () => {
  const parentId = makeId('session_command_fork');
  const parent = await createParent(parentId);
  const suffix = 'switch';
  const replies: string[] = [];
  const ctx = mockContext(replies);
  await sessionManager.attachChannelDurably(ctx.channelId, ctx.conversationId, parentId);
  let childId: string | undefined;
  try {
    await COMMANDS['/session'].handler(ctx, ['fork', suffix], parentId, parent);
    [childId] = sessionManager.getChildSessionIds(parentId);
    assert.ok(childId);
    const child = await sessionManager.getSession(childId);
    assert.equal(child.parentSessionId, parentId);
    assert.equal(sessionManager.getSessionByChannel(ctx.channelId, ctx.conversationId), childId);
    assert.deepEqual(child.history.map(message => message.role), ['user', 'user']);
    assert.match(systemText(child.history.at(-1)?.parts), /manually forked by the user/);
    assert.equal(child.queue.length, 0);
    assert.equal(parent.history.length, 0, 'the attaching fork surface does not acquire a parent event');
  } finally {
    if (childId) await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('/fork uses a detached Worker source and delivers multiline input through durable user ingress', async () => {
  await sessionRuntime.shutdownSessionRuntime();
  const parentId = makeId('fork_worker_parent');
  const parent = await createParent(parentId);
  await sessionManager.appendSessionMessage(parent, { role: 'model', parts: [{ text: 'real inherited answer' }] });
  const inheritedHistory = structuredClone(parent.history);
  parent.history = []; // Main catalog stub, not the authoritative Worker history.
  const childId = `${parentId}_worker`;
  const idleChildId = `${parentId}_idle`;
  const store = new SessionWorkerStore(path.join(DATA_ROOT_DIR, 'fork-command-runtime.sqlite'));
  store.open();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, '..', 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: DATA_ROOT_DIR, FOXWARM_TEST_CHILD_REMINDER_NO_ACTION: '1' },
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor,
    id => sessionManager.resolveLoadedSessionId(id), id => !!sessionManager.getSessionCatalog(id));
  const routed: string[] = [];
  const initialMessage = 'first line with  spaces\nsecond line\n';
  const replies: string[] = [];
  const ctx = mockContext(replies);
  await sessionManager.attachChannelDurably(ctx.channelId, ctx.conversationId, parentId);
  try {
    await supervisor.reconcileStartupOwnerships();
    await sessionRuntime.initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress, supervisor } });
    sessionManager.setSessionWorkerForkSourceProvider(async id => {
      routed.push(id);
      return readDetachedWorkerSession(id, sessionManager.getSessionCatalog(id)!);
    });
    sessionManager.setSessionWorkerEnqueueSink((id, item) => ingress.submitEnsuringWorker(id, item).then(() => {}));

    await COMMANDS['/fork'].handler(ctx, ['worker'], parentId, parent, `worker ${initialMessage}`);
    assert.match(replies.at(-1) || '', /Initial message sent/);
    assert.deepEqual(routed, [parentId]);
    assert.equal(parent.history.length, 0, 'Main never hydrates the Worker source');
    assert.equal(sessionManager.getSessionByChannel(ctx.channelId, ctx.conversationId), parentId);
    const authority = await fs.readJson(getSessionHistoryFilePath(childId));
    assert.deepEqual(authority.history.slice(0, inheritedHistory.length), inheritedHistory);
    assert.deepEqual(authority.childHandoffState, { boundary: 'direct-user', resolved: true });
    assert.equal(authority.history.filter((message: any) => message.role === 'model').length, 2,
      'only the inherited answer and the real fixture provider response are present');
    assert.deepEqual(authority.history[inheritedHistory.length + 2].parts, [{ text: initialMessage }]);
    assert.doesNotMatch(JSON.stringify(authority.history), /missing-handoff/);
    const intents = store.listMailboxIntentsAfter(childId, 0);
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0].payload, { type: 'user', parts: [{ text: initialMessage }] });
    const parentAuthority = await fs.readJson(getSessionHistoryFilePath(parentId));
    assert.deepEqual(parentAuthority.history.map((message: any) => message.role), ['model', 'user']);
    assert.match(systemText(parentAuthority.history.at(-1).parts), /manual-fork-created/);

    await COMMANDS['/fork'].handler(ctx, ['idle'], parentId, parent, 'idle');
    assert.match(replies.at(-1) || '', new RegExp(idleChildId));
    assert.equal(store.findOwnership(idleChildId), undefined, 'a fork without input never starts a child Worker');
    assert.equal(store.countMailboxIntents(), 1, 'no child input or parent wake is admitted');
    const idleChild = await fs.readJson(getSessionHistoryFilePath(idleChildId));
    assert.equal(idleChild.queue.length, 0);
    assert.equal(idleChild.childHandoffState, undefined);
    assert.equal(idleChild.history.filter((message: any) => message.role === 'model').length, 1);
    assert.deepEqual((await fs.readJson(getSessionHistoryFilePath(parentId))).history.map((message: any) => message.role), ['model', 'user', 'user']);
  } finally {
    sessionManager.setSessionWorkerForkSourceProvider(undefined);
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    await sessionRuntime.shutdownSessionRuntime().catch(() => {});
    await supervisor.shutdown(5_000).catch(() => {});
    store.close();
    await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(idleChildId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('/fork reports user ingress failure without a success reply or parent notice', async () => {
  const parentId = makeId('fork_command_ingress_failure');
  const parent = await createParent(parentId);
  const childId = `${parentId}_failed`;
  const replies: string[] = [];
  sessionManager.setSessionWorkerEnqueueSink(async () => { throw new Error('user ingress failed'); });
  try {
    await COMMANDS['/fork'].handler(mockContext(replies), ['failed', 'work'], parentId, parent, 'failed work');
    assert.deepEqual(replies, ['❌ Fork failed: user ingress failed']);
    assert.equal(parent.history.length, 0);
    assert.ok(sessionManager.getSessionCatalog(childId), 'the created child is retained after delivery failure');
    assert.equal((await sessionManager.getSession(childId)).queue.length, 0);
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('/fork accepts a custom suffix without an initial message', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_command_suffix_only');
  const parent = await createParent(parentId);
  const suffix = 'named_fork';
  const childId = `${parentId}_${suffix}`;
  const replies: string[] = [];

  try {
    await COMMANDS['/fork'].handler(mockContext(replies), [suffix], parentId, parent, suffix);
    assert.ok(await sessionManager.getExistingSession(childId));
    assert.equal((await sessionManager.getSession(childId)).queue.length, 0);
    assert.match(systemText(parent.history.at(-1)?.parts), /Initial message: \(none\)/);
  } finally {
    await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('/fork rejects invalid and duplicate custom suffixes without parent notification', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_command_invalid');
  const parent = await createParent(parentId);
  const duplicateSuffix = 'duplicate';
  const duplicateId = `${parentId}_${duplicateSuffix}`;
  const replies: string[] = [];

  try {
    await COMMANDS['/fork'].handler(mockContext(replies), ['bad/suffix'], parentId, parent, 'bad/suffix');
    assert.equal(parent.history.length, 0);
    assert.match(replies.at(-1) || '', /Invalid child session suffix/);

    await sessionManager.createChildSession(parentId, duplicateSuffix, true);
    await COMMANDS['/fork'].handler(mockContext(replies), [duplicateSuffix], parentId, parent, duplicateSuffix);
    assert.equal(parent.history.length, 0);
    assert.match(replies.at(-1) || '', /already exists/);
  } finally {
    await sessionManager.deleteSession(duplicateId).catch(() => {});
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('manual fork notification uses the existing queue when parent is busy', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_command_busy');
  const parent = await createParent(parentId);
  await sessionManager.appendSessionMessage(parent, { role: 'user', parts: [{ text: 'existing' }] });
  await sessionManager.updateSessionBusyState(parent, true);

  try {
    const result = await sessionManager.notifyManualForkCreated(parentId, `${parentId}_child`, 'work');
    assert.equal(result, 'queued');
    assert.equal(parent.history.length, 1);
    assert.equal(parent.queue.length, 1);
    const notification = systemText(parent.queue[0].message?.parts);
    assert.match(notification, /kind="session-event" event="manual-fork-created"/);
    assert.match(notification, new RegExp(`currentSessionId="${parentId}"`));
    assert.match(notification, new RegExp(`childSessionId="${parentId}_child"`));
  } finally {
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});