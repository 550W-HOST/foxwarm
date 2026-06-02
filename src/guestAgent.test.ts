import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import { MessageRouter } from './messageRouter';
import * as llm from './llm';
import * as vector from './vector';
import * as sessionManager from './sessionManager';
import * as sessionChannels from './session/channels';
import { inspectChannelAuthorization } from './channelAuth';
import { readAppConfigFile, writeAppConfigFile, AppConfig, getAgentDir } from './config';
import { MessagePart, Session } from './types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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

function makeCtx(channelId: string, conversationId: string, senderId: string, replies: string[]) {
  return {
    platform: 'weixin',
    channelType: 'weixin',
    channelId,
    channelUserId: conversationId,
    conversationId,
    senderId,
    username: senderId,
    preferDirectReply: true,
    reply: async (text: string) => {
      replies.push(text);
    },
    sendTyping: async () => {},
  } as any;
}

async function cleanupAgent(agentName: string): Promise<void> {
  try {
    await fs.remove(getAgentDir(agentName));
  } catch {}
}

test('guestAgent single mode binds new unauthorized conversation to a new session under the target agent', async () => {
  await sessionManager.loadSessions();
  const originalChat = llm.chat;
  const originalMemory = llm.buildSessionSystemPromptSnapshot;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const originalConfig = readAppConfigFile();
  const router = new MessageRouter();
  const createdAgents: string[] = [];
  const createdSessions: string[] = [];

  (vector as any).scheduleSessionArchiveIndex = async () => 0;
  (llm as any).buildSessionSystemPromptSnapshot = async () => '';

  try {
    const baseAgent = makeId('guestbase');
    createdAgents.push(baseAgent);
    const baseResult = await sessionManager.createAgentWithMainSession({
      agentName: baseAgent,
      createMainSession: true,
      isolatedNode: 'sandbox-docker',
    });
    createdSessions.push(baseResult.mainSessionId);

    const channelId = makeId('guestchan');
    const conversationId = makeId('guestconv');
    writeAppConfigFile({
      ...originalConfig,
      channels: {
        ...(originalConfig.channels || {}),
        [channelId]: {
          type: 'weixin',
          guestAgent: {
            agentId: baseAgent,
            node: 'sandbox-docker',
          },
        },
      },
    } as AppConfig);

    let callCount = 0;
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      await appendStubUserMessage(activeSession, parts);
      callCount += 1;
      await appendStubModelMessage(activeSession, `guest reply ${callCount}`);
      return { text: `guest reply ${callCount}` };
    };

    const replies: string[] = [];
    await router.handleMessage(
      makeCtx(channelId, conversationId, 'stranger-a', replies),
      { parts: [{ text: 'hello' }], channelUserId: conversationId, conversationId, username: 'stranger-a' },
    );

    const sessionId = sessionManager.getSessionByChannel(channelId, conversationId);
    assert.ok(sessionId, 'expected guest session attachment');
    createdSessions.push(sessionId!);

    const session = await sessionManager.getSession(sessionId!);
    assert.equal(session.agent, baseAgent);
    assert.notEqual(session.id, `${baseAgent}/main`);
    assert.equal(session.currentNode, 'sandbox-docker');
    assert.equal(sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId), true);
    assert.equal(callCount, 1);

    await router.handleMessage(
      makeCtx(channelId, conversationId, 'stranger-b', replies),
      { parts: [{ text: 'follow up' }], channelUserId: conversationId, conversationId, username: 'stranger-b' },
    );

    const sameSessionId = sessionManager.getSessionByChannel(channelId, conversationId);
    assert.equal(sameSessionId, sessionId);
    assert.equal(callCount, 2);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).buildSessionSystemPromptSnapshot = originalMemory;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    writeAppConfigFile(originalConfig);
    for (const sessionId of createdSessions) {
      try { await sessionManager.deleteSession(sessionId); } catch {}
    }
    for (const agentName of createdAgents) {
      await cleanupAgent(agentName);
    }
  }
});

test('guestAgent inherited mode creates a derived agent main session with inherit + isolation', async () => {
  await sessionManager.loadSessions();
  const originalChat = llm.chat;
  const originalMemory = llm.buildSessionSystemPromptSnapshot;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const originalConfig = readAppConfigFile();
  const router = new MessageRouter();
  const createdAgents: string[] = [];
  const createdSessions: string[] = [];

  (vector as any).scheduleSessionArchiveIndex = async () => 0;
  (llm as any).buildSessionSystemPromptSnapshot = async () => '';

  try {
    const baseAgent = makeId('guestinherit');
    createdAgents.push(baseAgent);
    const baseResult = await sessionManager.createAgentWithMainSession({
      agentName: baseAgent,
      createMainSession: true,
    });
    createdSessions.push(baseResult.mainSessionId);

    const channelId = makeId('guestchan');
    const conversationId = makeId('guestconv');
    writeAppConfigFile({
      ...originalConfig,
      channels: {
        ...(originalConfig.channels || {}),
        [channelId]: {
          type: 'weixin',
          guestAgent: {
            agentId: baseAgent,
            mode: 'inherited',
            node: 'sandbox-docker',
          },
        },
      },
    } as AppConfig);

    let derivedCallCount = 0;
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      await appendStubUserMessage(activeSession, parts);
      derivedCallCount += 1;
      await appendStubModelMessage(activeSession, 'derived reply');
      return { text: 'derived reply' };
    };

    const replies: string[] = [];
    await router.handleMessage(
      makeCtx(channelId, conversationId, 'stranger-c', replies),
      { parts: [{ text: 'hello inherited' }], channelUserId: conversationId, conversationId, username: 'stranger-c' },
    );

    const sessionId = sessionManager.getSessionByChannel(channelId, conversationId);
    assert.ok(sessionId, 'expected derived guest session attachment');
    createdSessions.push(sessionId!);

    const session = await sessionManager.getSession(sessionId!);
    assert.match(session.agent || '', new RegExp(`^${baseAgent}_`));
    assert.equal(session.id, `${session.agent}/main`);
    assert.equal(sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId), true);
    assert.equal(sessionManager.getAgentMetadata(session.agent || '').inherit, baseAgent);
    assert.equal(sessionManager.isAgentIsolated(session.agent || ''), true);
    assert.equal(sessionManager.getAgentIsolationNode(session.agent || ''), 'sandbox-docker');
    createdAgents.push(session.agent || '');
    assert.equal(derivedCallCount, 1);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).buildSessionSystemPromptSnapshot = originalMemory;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    writeAppConfigFile(originalConfig);
    for (const sessionId of createdSessions) {
      try { await sessionManager.deleteSession(sessionId); } catch {}
    }
    for (const agentName of createdAgents) {
      await cleanupAgent(agentName);
    }
  }
});

test('legacy dangerouslyAllowAllGroupMembers attachments still authorize all users via the new allow-all-users semantics', async () => {
  await sessionManager.loadSessions();
  const channelId = makeId('legacychan');
  const conversationId = makeId('legacyconv');

  try {
    await sessionChannels.importLegacyChannelAttachments({
      [`${channelId}:${conversationId}`]: {
        sessionId: 'legacy-session',
        dangerouslyAllowAllGroupMembers: true,
      } as any,
    });

    assert.equal(sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId), true);
    const inspection = inspectChannelAuthorization({
      platform: 'weixin',
      channelId,
      channelType: 'weixin',
      channelUserId: conversationId,
      conversationId,
      senderId: 'someone-new',
    });
    assert.equal(inspection.authorized, true);
    assert.equal(inspection.dangerouslyAllowAllUsers, true);
  } finally {
    sessionManager.detachChannel(channelId, conversationId);
  }
});
