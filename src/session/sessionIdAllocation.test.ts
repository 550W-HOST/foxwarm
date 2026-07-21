import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createParent(sessionId: string) {
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  await sessionManager.saveSession(sessionId);
  return session;
}

test('fork allocation never reuses a deleted session id retained by the archive', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('fork_archive_reserved');
  await createParent(parentId);

  let secondForkId: string | undefined;
  try {
    const firstForkId = await sessionManager.forkSession(parentId);
    assert.equal(firstForkId, `${parentId}_fork`);
    assert.equal(await sessionManager.deleteSession(firstForkId), true);
    assert.equal(await sessionManager.getExistingSession(firstForkId), null);

    secondForkId = await sessionManager.forkSession(parentId);
    assert.equal(secondForkId, `${parentId}_fork_2`);
    assert.notEqual(secondForkId, firstForkId);
  } finally {
    if (secondForkId) {
      await sessionManager.deleteSession(secondForkId).catch(() => {});
    }
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});

test('child-session allocation never reuses a deleted session id retained by the archive', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('child_archive_reserved');
  await createParent(parentId);

  let secondChildId: string | undefined;
  try {
    const firstChildId = await sessionManager.createChildSession(parentId, 'worker', false);
    assert.equal(firstChildId, `${parentId}_worker`);
    assert.equal(await sessionManager.deleteSession(firstChildId), true);
    assert.equal(await sessionManager.getExistingSession(firstChildId), null);

    secondChildId = await sessionManager.createChildSession(parentId, 'worker', false);
    assert.equal(secondChildId, `${parentId}_worker_2`);
    assert.notEqual(secondChildId, firstChildId);
  } finally {
    if (secondChildId) {
      await sessionManager.deleteSession(secondChildId).catch(() => {});
    }
    await sessionManager.deleteSession(parentId).catch(() => {});
  }
});
