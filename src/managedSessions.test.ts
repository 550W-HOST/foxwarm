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

    assert.equal(step.runMode, 'idle');
    assert.equal(step.inboxOrder, 'before');
    assert.equal(step.yieldReason, 'idle');
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
  const ownerSessionId = `managed-router-owner-${Date.now()}`;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    await appendStubUserMessage(activeSession, parts);
    await appendStubModelMessage(activeSession, 'should not run');
    return { text: 'should not run' };
  };

  try {
    await sessionManager.createEmptySession(ownerSessionId);
    const session = await sessionManager.getSession(sessionId);
    const lease = await managedSessions.openManagedSession({
      sessionId,
      ownerSessionId,
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
    await sessionManager.deleteSession(ownerSessionId).catch(() => false);
  }
});

test('managed session step can place manager input before pending inbox items', async () => {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = `managed_parent_order_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const childId = `managed_child_order_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    await appendStubUserMessage(activeSession, parts);
    const text = flattenText(parts);
    await appendStubModelMessage(activeSession, `order saw: ${text}`);
    return { text: `order saw: ${text}` };
  };
  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);

    const lease = await managedSessions.openManagedSession({ sessionId: childId, ownerSessionId: parentId });
    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'queued later' }], 'background');

    const step = await managedSessions.managedSessionStep({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: 2,
      inboxOrder: 'after',
      parts: [{ text: 'manager first' }],
    });

    assert.equal(step.inboxOrder, 'after');
    assert.equal(step.yieldReason, 'idle');
    assert.deepEqual(
      step.newMessages[0].parts.map(part => part.text).filter(Boolean),
      ['manager first', 'queued later'],
    );
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('managed session step can yield after the first tool batch', async () => {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = `managed_parent_tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const childId = `managed_child_tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let chatCallCount = 0;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    await appendStubUserMessage(activeSession, parts);
    chatCallCount += 1;
    if (chatCallCount === 1) {
      const toolCall = {
        id: 'managed_tool_call_1',
        name: 'search_tools',
        args: { query: 'read file', sources: ['builtin'], limit: 1, includeSchema: false },
      };
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ functionCall: toolCall }],
      });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }

    await appendStubModelMessage(activeSession, 'second response should not happen during tool yield');
    return { text: 'second response should not happen during tool yield' };
  };
  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);

    const lease = await managedSessions.openManagedSession({ sessionId: childId, ownerSessionId: parentId });
    const step = await managedSessions.managedSessionStep({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: 1,
      runMode: 'tool',
      parts: [{ text: 'run until tool' }],
    });

    assert.equal(step.runMode, 'tool');
    assert.equal(step.yieldReason, 'tool');
    assert.equal(chatCallCount, 1);
    assert.deepEqual(step.newMessages.map(message => message.role), ['user', 'model', 'tool']);
    assert.equal(step.newMessages[2].parts[0].functionResponse?.name, 'search_tools');
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('managed session respects isolated/direct-link permission boundaries', async () => {
  await sessionManager.loadSessions();
  const isolatedAgent = `managed_iso_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ownerId = `managed_iso_owner_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const targetId = `managed_iso_target_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    await sessionManager.setAgentMetadata(isolatedAgent, { isolated: true, isolatedNode: 'sandbox-docker' } as any);
    const owner = await sessionManager.getSession(ownerId);
    owner.agent = isolatedAgent;
    await sessionManager.saveSession(ownerId);
    await sessionManager.createEmptySession(targetId);

    await assert.rejects(
      managedSessions.openManagedSession({ sessionId: targetId, ownerSessionId: ownerId }),
      /isolated/i,
    );
  } finally {
    await sessionManager.setAgentMetadata(isolatedAgent, { isolated: false } as any).catch(() => {});
    await sessionManager.deleteSession(targetId).catch(() => false);
    await sessionManager.deleteSession(ownerId).catch(() => false);
  }
});

test('managed session notifies owner on inbox arrival and stale leases are reclaimed', async () => {
  await sessionManager.loadSessions();
  const parentId = `managed_recovery_parent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const childId = `managed_recovery_child_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);

    await managedSessions.openManagedSession({ sessionId: childId, ownerSessionId: parentId });
    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'wake owner' }], 'background');

    const ownerAfterWake = await sessionManager.getSession(parentId);
    assert.match(ownerAfterWake.queue[0]?.parts?.[0]?.system || '', /Managed session/);

    await sessionManager.deleteSession(parentId).catch(() => false);

    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'stale should recover' }], 'background');

    const recoveredChild = await sessionManager.getSession(childId);
    const managedState = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(managedState, undefined);
    assert.equal(recoveredChild.queue.length, 2);
    assert.deepEqual(
      recoveredChild.queue.map(item => item.parts?.[0]?.text).filter(Boolean),
      ['wake owner', 'stale should recover'],
    );
  } finally {
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('resumeBusySessions re-notifies manager when pending managed inbox survived restart', async () => {
  await sessionManager.loadSessions();
  const parentId = `managed_restart_parent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const childId = `managed_restart_child_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);
    await managedSessions.openManagedSession({ sessionId: childId, ownerSessionId: parentId });
    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'persisted inbox' }], 'background');

    const owner = await sessionManager.getSession(parentId);
    owner.queue = [];
    await sessionManager.saveSession(parentId);

    const child = await sessionManager.getSession(childId);
    child.meta.managedSession.lastOwnerWakeupAt = undefined;
    await sessionManager.saveSession(childId);

    await sessionManager.resumeBusySessions();

    const ownerAfterResume = await sessionManager.getSession(parentId);
    assert.match(ownerAfterResume.queue[0]?.parts?.[0]?.system || '', /Managed session/);
  } finally {
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});
