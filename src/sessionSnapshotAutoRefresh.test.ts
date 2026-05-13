import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import * as llm from './llm';
import { MessageRouter } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as vector from './vector';
import { getAgentDir, getAgentMemoryDir } from './config';
import { maybeRefreshStaleSessionSnapshot, AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS } from './session/snapshotRefresh';
import type { MessagePart, Session } from './types';

function makeSession(lastMessageTime: number): Pick<Session, 'id' | 'meta'> {
  return {
    id: 'snapshot-auto-refresh-test',
    meta: { lastMessageTime },
  };
}

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

test('stale session snapshot refresh runs after more than one hour idle', async () => {
  const now = 1_700_000_000_000;
  const session = makeSession(now - AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS - 1);
  const refreshedSessionIds: string[] = [];

  const refreshed = await maybeRefreshStaleSessionSnapshot(session, async (sessionId: string) => {
    refreshedSessionIds.push(sessionId);
  }, now);

  assert.equal(refreshed, true);
  assert.deepEqual(refreshedSessionIds, [session.id]);
});

test('stale session snapshot refresh is skipped at or below one hour idle', async () => {
  const now = 1_700_000_000_000;
  const refreshAttempts: string[] = [];

  const atThreshold = await maybeRefreshStaleSessionSnapshot(
    makeSession(now - AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS),
    async (sessionId: string) => { refreshAttempts.push(sessionId); },
    now,
  );
  const belowThreshold = await maybeRefreshStaleSessionSnapshot(
    makeSession(now - AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS + 1),
    async (sessionId: string) => { refreshAttempts.push(sessionId); },
    now,
  );

  assert.equal(atThreshold, false);
  assert.equal(belowThreshold, false);
  assert.deepEqual(refreshAttempts, []);
});

test('stale session snapshot refresh failure does not block caller processing', async () => {
  const now = 1_700_000_000_000;
  const session = makeSession(now - AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS - 1);
  let messageProcessingContinued = false;

  const refreshed = await maybeRefreshStaleSessionSnapshot(session, async () => {
    throw new Error('synthetic refresh failure');
  }, now);

  messageProcessingContinued = true;

  assert.equal(refreshed, false);
  assert.equal(messageProcessingContinued, true);
});

test('message router refreshes stale session prompt snapshot before processing a new turn', async () => {
  await sessionManager.loadSessions();

  const originalChat = llm.chat;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const agentName = makeId('snapshot_refresh_agent');
  const sessionName = makeId('snapshot_refresh_session');
  const channelId = makeId('snapshot_refresh_channel');
  const conversationId = makeId('snapshot_refresh_conversation');
  let sessionId = '';
  let chatSawUpdatedSnapshot = false;

  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  try {
    const memoryDir = getAgentMemoryDir(agentName);
    await fs.ensureDir(memoryDir);
    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), 'OLD SNAPSHOT CONTENT', 'utf8');

    ({ sessionId } = await sessionManager.createSessionInAgent({ agentName, sessionName }));
    const session = await sessionManager.getSession(sessionId);
    assert.match(session.persistentMemorySnapshot, /OLD SNAPSHOT CONTENT/);

    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), 'UPDATED SNAPSHOT CONTENT', 'utf8');
    session.meta.lastMessageTime = Date.now() - AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS - 1;
    await sessionManager.saveSession(session.id);
    sessionManager.attachChannel(channelId, conversationId, sessionId);

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      chatSawUpdatedSnapshot = /UPDATED SNAPSHOT CONTENT/.test(activeSession.persistentMemorySnapshot);
      await appendStubUserMessage(activeSession, parts);
      await appendStubModelMessage(activeSession, 'ok');
      return { text: 'ok' };
    };

    const router = new MessageRouter();
    const replies: string[] = [];
    await router.handleMessage({
      platform: 'webui',
      channelType: 'webui',
      channelId,
      channelUserId: conversationId,
      conversationId,
      senderId: 'webui',
      username: 'webui',
      preferDirectReply: true,
      reply: async (text: string) => { replies.push(text); },
      sendTyping: async () => {},
    }, {
      parts: [{ text: 'hello' }],
      channelUserId: conversationId,
      conversationId,
      username: 'webui',
    });

    assert.equal(chatSawUpdatedSnapshot, true);
    assert.deepEqual(replies, ['ok']);
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    if (sessionId) await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(getAgentDir(agentName)).catch(() => {});
  }
});
