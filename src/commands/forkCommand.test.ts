import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands';
import * as sessionManager from '../sessionManager';
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
    assert.equal(parent.queue.length, 0);
    assert.deepEqual(triggered, []);
    assert.match(systemText(parent.history.at(-1)?.parts), /event="manual-fork-created"/);
    assert.match(systemText(parent.history.at(-1)?.parts), /Initial message: \(none\)/);
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
    assert.match(systemText(child.queue[0].parts), new RegExp(initialMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(systemText(child.queue[0].parts).includes(initialMessage));
    assert.ok(systemText(parent.history.at(-1)?.parts).includes(initialMessage));
    assert.match(replies.at(-1) || '', /Initial message sent/);
  } finally {
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
    assert.match(systemText(parent.queue[0].message?.parts), /manual-fork-created/);
  } finally {
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});