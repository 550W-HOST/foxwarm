const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const llm = require('../lib/llm');
const sessionManager = require('../lib/sessionManager');
const managedSessions = require('../lib/managedSessions');
const { MessageRouter } = require('../lib/messageRouter');
const { getAgentDir } = require('../lib/config');

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCtx(channelId, conversationId, replies, username = 'managed-live-user') {
  return {
    channelId,
    platform: 'webui',
    reply: async (text) => {
      replies.push(text);
    },
    sendTyping: async () => {},
    username,
    channelUserId: conversationId,
    conversationId,
    preferDirectReply: true,
  };
}

async function appendUser(session, parts) {
  if (!parts || parts.length === 0) return;
  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts,
  });
}

async function appendModel(session, text) {
  await sessionManager.appendSessionMessage(session, {
    role: 'model',
    parts: [{ text }],
  });
}

function flattenText(parts) {
  return (parts || [])
    .map(part => part.text || part.system || '')
    .filter(Boolean)
    .join(' | ');
}

async function main() {
  await sessionManager.loadSessions();
  const router = new MessageRouter();
  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));

  const originalChat = llm.chat;
  llm.chat = async (parts, activeSession) => {
    await appendUser(activeSession, parts);
    const text = `LIVE_CHILD_REPLY: ${flattenText(parts)}`;
    await appendModel(activeSession, text);
    return { text, toolCalls: [] };
  };

  const parentId = makeId('managed_live_parent');
  const childId = makeId('managed_live_child');
  const channelId = 'webui';
  const conversationId = makeId('managed_live_conv');
  const replies = [];

  try {
    await sessionManager.createEmptySession(parentId);
    await sessionManager.createEmptySession(childId);
    sessionManager.attachChannel(channelId, conversationId, childId);

    const lease = await managedSessions.openManagedSession({
      sessionId: childId,
      ownerSessionId: parentId,
    });

    await router.handleMessage(
      makeCtx(channelId, conversationId, replies),
      {
        parts: [{ text: 'outside child request' }],
        channelUserId: conversationId,
        conversationId,
        username: 'managed-live-user',
      },
    );

    const childAfterInbox = await sessionManager.getSession(childId);
    const managedAfterInbox = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(childAfterInbox.history.length, 0);
    assert.equal(managedAfterInbox?.pendingInbox.length, 1);
    assert.equal(managedAfterInbox?.revision, 2);
    assert.match(replies[0] || '', /managed control/i);

    const step = await managedSessions.managedSessionStep({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: managedAfterInbox.revision,
      parts: [{ text: 'manager says process it now' }],
    });

    assert.equal(step.consumedPendingInboxCount, 1);
    assert.equal(step.pendingInboxCount, 0);
    assert.equal(step.newMessages.length, 2);
    assert.equal(step.newMessages[0].role, 'user');
    assert.deepEqual(
      step.newMessages[0].parts.map(part => part.text).filter(Boolean),
      ['outside child request', 'manager says process it now'],
    );
    assert.equal(step.newMessages[1].role, 'model');
    assert.match(step.newMessages[1].parts[0].text || '', /outside child request \| manager says process it now/);

    const release = await managedSessions.releaseManagedSession({
      sessionId: childId,
      ownerSessionId: parentId,
      leaseId: lease.leaseId,
      expectedRevision: step.revision,
    });
    assert.equal(release.releasedPendingInboxCount, 0);

    const repliesAfterRelease = [];
    await router.handleMessage(
      makeCtx(channelId, conversationId, repliesAfterRelease, 'managed-live-user-2'),
      {
        parts: [{ text: 'after release request' }],
        channelUserId: conversationId,
        conversationId,
        username: 'managed-live-user-2',
      },
    );

    const childAfterRelease = await sessionManager.getSession(childId);
    const managedAfterRelease = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(managedAfterRelease, undefined);
    assert.ok(childAfterRelease.history.length >= 4);
    assert.match(repliesAfterRelease.join('\n'), /LIVE_CHILD_REPLY: .*after release request/);

    console.log(JSON.stringify({
      env: {
        container: 'foxwarm-toolscript-managed-session-test',
        url: 'http://localhost:3004',
      },
      smoke1: {
        leaseId: lease.leaseId,
        revisionAfterInbox: managedAfterInbox.revision,
        pendingInboxCount: managedAfterInbox.pendingInbox.length,
        childHistoryLengthBeforeStep: childAfterInbox.history.length,
        userReply: replies[0],
      },
      smoke2: {
        consumedPendingInboxCount: step.consumedPendingInboxCount,
        pendingInboxCount: step.pendingInboxCount,
        newMessages: step.newMessages,
        revisionAfterStep: step.revision,
      },
      smoke3: {
        releasedPendingInboxCount: release.releasedPendingInboxCount,
        childHistoryLengthAfterReleaseMessage: childAfterRelease.history.length,
        directReplyAfterRelease: repliesAfterRelease,
      },
    }, null, 2));
  } finally {
    llm.chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    sessionManager.detachChannel(channelId, conversationId);
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), 'managed_session_live_smoke_script.py')).catch(() => false);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
