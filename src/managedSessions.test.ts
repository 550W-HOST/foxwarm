import test from 'node:test';
import assert from 'node:assert/strict';

import * as llm from './llm';
import { MessageRouter } from './messageRouter';
import * as managedSessions from './managedSessions';
import * as sessionManager from './sessionManager';
import { MessagePart, Session } from './types';

async function appendStubUserMessage(session: Session, parts: MessagePart[] | null): Promise<void> {
  if (!parts?.length) return;
  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts,
  });
}

async function appendStubModelMessage(session: Session, text: string): Promise<void> {
  await sessionManager.appendSessionMessage(session, {
    role: 'model',
    parts: [{ text }],
  });
}

function flattenText(parts: MessagePart[] | null): string {
  return (parts || [])
    .map(part => part.text || part.system || '')
    .filter(Boolean)
    .join(' | ');
}

test('managed session diverts external queue items into a pending inbox and step processes them atomically', async () => {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = `managed_parent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const childId = `managed_child_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    await appendStubUserMessage(activeSession, parts);
    const text = flattenText(parts);
    await appendStubModelMessage(activeSession, `child saw: ${text}`);
    return { text: `child saw: ${text}` };
  };
  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);

    const lease = await managedSessions.openManagedSession({
      sessionId: childId,
      ownerSessionId: parentId,
    });
    assert.equal(lease.revision, 1);

    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'outside event' }], 'background');
    const pendingState = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(pendingState?.pendingInbox.length, 1);
    assert.equal(pendingState?.revision, 2);

    const childBefore = await sessionManager.getSession(childId);
    assert.equal(childBefore.history.length, 0);

    const step = await managedSessions.managedSessionStep({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: 2,
      parts: [{ text: 'manager directive' }],
    });

    assert.equal(step.consumedPendingInboxCount, 1);
    assert.equal(step.pendingInboxCount, 0);
    assert.equal(step.newMessages.length, 2);
    assert.equal(step.newMessages[0].role, 'user');
    assert.deepEqual(
      step.newMessages[0].parts.map(part => part.text).filter(Boolean),
      ['outside event', 'manager directive'],
    );
    assert.equal(step.newMessages[1].role, 'model');
    assert.match(step.newMessages[1].parts[0].text || '', /outside event \| manager directive/);

    const released = await managedSessions.releaseManagedSession({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: step.revision,
    });
    assert.equal(released.releasedPendingInboxCount, 0);
    const afterRelease = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(afterRelease, undefined);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('message router queues direct user messages into managed inbox instead of auto-running the session', async () => {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const channelId = `managed-router-${Date.now()}`;
  const conversationId = `conv-${Math.random().toString(36).slice(2, 7)}`;
  const sessionId = sessionManager.attachChannel(channelId, conversationId);

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    await appendStubUserMessage(activeSession, parts);
    await appendStubModelMessage(activeSession, 'should not run');
    return { text: 'should not run' };
  };

  try {
    const session = await sessionManager.getSession(sessionId);
    const lease = await managedSessions.openManagedSession({
      sessionId,
      ownerSessionId: 'manager-owner',
    });

    const replies: string[] = [];
    const ctx = {
      channelId,
      platform: 'webui',
      reply: async (text: string) => {
        replies.push(text);
      },
      sendTyping: async () => {},
      username: 'managed-user',
      channelUserId: conversationId,
      conversationId,
      preferDirectReply: true,
    } as any;

    await router.handleMessage(ctx, {
      parts: [{ text: 'hello managed child' }],
      channelUserId: conversationId,
      conversationId,
      username: 'managed-user',
    } as any);

    assert.match(replies[0] || '', /managed control/i);
    const updated = await sessionManager.getSession(session.id);
    assert.equal(updated.history.length, 0);
    const pendingState = await managedSessions.getManagedSessionStateForTests(session.id);
    assert.equal(pendingState?.pendingInbox.length, 1);
    assert.equal(pendingState?.pendingInbox[0].type, 'user');
    assert.equal(lease.leaseId, pendingState?.leaseId);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.detachChannel(channelId, conversationId);
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
