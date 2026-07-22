import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import * as sessionManager from '../sessionManager';
import { getAgentDir } from '../config';
import { handleAgentCommand } from '../commands/agentCmd';

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

async function assertArchivedIdRejection(operation: Promise<unknown>, sessionId: string): Promise<void> {
  await assert.rejects(operation, (error: any) => {
    assert.equal(error?.code, sessionManager.ARCHIVED_SESSION_ID_ERROR_CODE);
    assert.match(String(error?.message), new RegExp(`Session "${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" cannot be created`));
    assert.doesNotMatch(String(error?.message), /message|summary|content/i);
    return true;
  });
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

test('explicit empty-session creation and low-level creation reject an archived lifetime', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeId('empty_archive_reserved');
  const first = await sessionManager.createEmptySession(sessionId);
  assert.equal(first.created, true);
  await sessionManager.appendSessionMessage(sessionId, {
    role: 'user',
    parts: [{ text: 'old-generation-message' }],
    __meta: { timestamp: Date.now() },
  });
  assert.equal(await sessionManager.deleteSession(sessionId), true);

  await assertArchivedIdRejection(sessionManager.createEmptySession(sessionId), sessionId);
  await assertArchivedIdRejection(sessionManager.getSession(sessionId), sessionId);
  await assertArchivedIdRejection(sessionManager.createSession(sessionId, {}), sessionId);

  const archive = await sessionManager.getArchivedMessages(sessionId);
  assert.deepEqual(archive.records.map(record => record.message.parts?.[0]?.text), ['old-generation-message']);
  assert.equal(await sessionManager.getExistingSession(sessionId), null);
});

test('generated empty-session ids skip archived lifetimes', async () => {
  await sessionManager.loadSessions();
  const originalRandom = Math.random;
  const reservedRandom = 0.123456789;
  const replacementRandom = 0.987654321;

  Math.random = () => reservedRandom;
  const reservedId = sessionManager.generateSessionId();
  try {
    const first = await sessionManager.createEmptySession(reservedId);
    await sessionManager.appendSessionMessage(first.session.id, {
      role: 'user',
      parts: [{ text: 'reserved-generated-id' }],
      __meta: { timestamp: Date.now() },
    });
    await sessionManager.deleteSession(reservedId);

    let calls = 0;
    Math.random = () => calls++ === 0 ? reservedRandom : replacementRandom;
    const created = await sessionManager.createEmptySession();
    assert.notEqual(created.session.id, reservedId);
    await sessionManager.deleteSession(created.session.id);
  } finally {
    Math.random = originalRandom;
  }
});

test('named session creation preserves live duplicate errors and rejects archived ids', async () => {
  await sessionManager.loadSessions();
  const agentName = makeId('named_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionName = 'named';
  const sessionId = `${agentName}/${sessionName}`;
  await fs.ensureDir(getAgentDir(agentName));

  try {
    await sessionManager.createSessionInAgent({ agentName, sessionName });
    await assert.rejects(
      sessionManager.createSessionInAgent({ agentName, sessionName }),
      new RegExp(`Session "${sessionId}" already exists\\.`),
    );
    await sessionManager.appendSessionMessage(sessionId, {
      role: 'user',
      parts: [{ text: 'old-named-generation' }],
      __meta: { timestamp: Date.now() },
    });
    await sessionManager.deleteSession(sessionId);

    await assertArchivedIdRejection(
      sessionManager.createSessionInAgent({ agentName, sessionName }),
      sessionId,
    );
    assert.equal(await sessionManager.getExistingSession(sessionId), null);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(getAgentDir(agentName));
  }
});

test('agent-main recreation rejects the archived internal id before recreating the agent directory', async () => {
  await sessionManager.loadSessions();
  const agentName = makeId('recreated_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const mainSessionId = `${agentName}/main`;

  try {
    await sessionManager.createAgentWithMainSession({ agentName });
    await sessionManager.appendSessionMessage(mainSessionId, {
      role: 'user',
      parts: [{ text: 'old-agent-main-generation' }],
      __meta: { timestamp: Date.now() },
    });
    const replies: string[] = [];
    await handleAgentCommand({
      reply: async (text: string) => { replies.push(text); },
    } as any, ['delete', agentName, '--confirm']);
    assert.match(replies.at(-1) || '', /deleted successfully/);
    assert.equal(await sessionManager.getExistingSession(mainSessionId), null);
    assert.equal(await fs.pathExists(getAgentDir(agentName)), false);

    await assertArchivedIdRejection(
      sessionManager.createAgentWithMainSession({ agentName }),
      mainSessionId,
    );
    assert.equal(await fs.pathExists(getAgentDir(agentName)), false);

    const noMain = await sessionManager.createAgentWithMainSession({ agentName, createMainSession: false });
    assert.equal(noMain.createdMainSession, false);
  } finally {
    await sessionManager.deleteSession(mainSessionId).catch(() => {});
    await fs.remove(getAgentDir(agentName));
  }
});

test('session identity moves reject archived target ids without mutating the source', async () => {
  await sessionManager.loadSessions();
  const sourceId = makeId('move_source');
  const targetName = makeId('move_target');
  await createParent(sourceId);
  await createParent(targetName);
  await sessionManager.appendSessionMessage(targetName, {
    role: 'user',
    parts: [{ text: 'old-move-target-generation' }],
    __meta: { timestamp: Date.now() },
  });
  await sessionManager.deleteSession(targetName);

  try {
    await assertArchivedIdRejection(
      sessionManager.moveSessionToTarget({ sourceSessionId: sourceId, newSessionId: targetName }),
      targetName,
    );
    assert.ok(await sessionManager.getExistingSession(sourceId));
    assert.equal(await sessionManager.getExistingSession(targetName), null);
  } finally {
    await sessionManager.deleteSession(sourceId).catch(() => {});
  }
});

test('restart hydration remains valid and archive bootstrap rebuild still reserves deleted ids', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-session-id-reservation-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const parentId = 'restart_parent';
  const firstForkId = `${parentId}_fork`;

  const run = (source: string) => execFileSync(process.execPath, ['-e', source], {
    env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    run(`
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const parent = await sm.createEmptySession(${JSON.stringify(parentId)});
        await sm.appendSessionMessage(parent.session.id, { role: 'user', parts: [{ text: 'persisted-live-history' }], __meta: { timestamp: Date.now() } });
        const child = await sm.forkSession(parent.session.id);
        if (child !== ${JSON.stringify(firstForkId)}) throw new Error(child);
        await sm.deleteSession(child);
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);

    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-wal'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-shm'));

    run(`
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const parent = await sm.getSession(${JSON.stringify(parentId)});
        if (parent.history[0]?.parts?.[0]?.text !== 'persisted-live-history') throw new Error('live hydration failed');
        const next = await sm.forkSession(parent.id);
        if (next !== ${JSON.stringify(`${firstForkId}_2`)}) throw new Error(next);
        try {
          await sm.getSession(${JSON.stringify(firstForkId)});
          throw new Error('deleted archived id was recreated');
        } catch (error) {
          if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
  } finally {
    fs.removeSync(tempRoot);
  }
});
