import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import * as sessionManager from '../sessionManager';
import { getAgentDir } from '../config';
import { handleAgentCommand } from '../commands/agentCmd';
import { hasArchivedSessionId } from './archiveStore';
import { setArchiveWriteFaultInjectorForTests } from './archive';
import * as sessionChannels from './channels';

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

test('concurrent explicit creators commit one session lifetime', async () => {
  await sessionManager.loadSessions();
  const emptySessionId = makeId('concurrent_empty');
  const emptyResults = await Promise.all(
    Array.from({ length: 100 }, () => sessionManager.createEmptySession(emptySessionId)),
  );
  assert.equal(emptyResults.filter(result => result.created).length, 1);
  assert.ok(emptyResults.every(result => result.session.id === emptySessionId));

  const agentName = makeId('concurrent_named_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionName = 'shared';
  const namedSessionId = `${agentName}/${sessionName}`;
  await fs.ensureDir(getAgentDir(agentName));
  try {
    const namedResults = await Promise.allSettled(
      Array.from({ length: 100 }, () => sessionManager.createSessionInAgent({ agentName, sessionName })),
    );
    assert.equal(namedResults.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = namedResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(rejected.length, 99);
    assert.ok(rejected.every(result => /already exists/.test(String(result.reason?.message))));
    assert.ok(await sessionManager.getExistingSession(namedSessionId));
  } finally {
    await sessionManager.deleteSession(namedSessionId).catch(() => {});
    await sessionManager.deleteSession(emptySessionId).catch(() => {});
    await fs.remove(getAgentDir(agentName));
  }
});

test('creator started by a save callback cannot escape the identity lock', async () => {
  await sessionManager.loadSessions();
  const agentName = makeId('escaped_callback_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const sessionName = 'shared';
  const sessionId = `${agentName}/${sessionName}`;
  await fs.ensureDir(getAgentDir(agentName));
  let escapedCreator: Promise<{ sessionId: string }> | undefined;
  sessionManager.setOnSessionListUpdated(() => {
    if (!escapedCreator) {
      escapedCreator = Promise.resolve().then(() => sessionManager.createSessionInAgent({ agentName, sessionName }));
    }
  });

  try {
    const first = await sessionManager.createSessionInAgent({ agentName, sessionName });
    assert.equal(first.sessionId, sessionId);
    assert.ok(escapedCreator);
    await assert.rejects(escapedCreator!, /already exists/);
    assert.equal([...sessionManager.getAllSessions().keys()].filter(id => id === sessionId).length, 1);
  } finally {
    sessionManager.setOnSessionListUpdated(() => {});
    if (sessionManager.getAllSessions().has(sessionId)) await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(getAgentDir(agentName));
  }
});

test('known persistence failures roll back creation and allow the same requested id to retry', async () => {
  await sessionManager.loadSessions();
  const emptyId = makeId('failed_empty');
  const parentId = makeId('failed_fork_parent');
  const forkId = `${parentId}_fork`;
  const saveFailureForkId = `${parentId}_savefail`;
  const moveSource = makeId('failed_move_source');
  const moveTarget = makeId('failed_move_target');
  const failedAgent = makeId('failed_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const failedAgentMainId = `${failedAgent}/main`;

  try {
    let failEmpty = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
      if (failEmpty && phase === 'history' && sessionId === emptyId) {
        failEmpty = false;
        throw new Error('injected empty persistence failure');
      }
    });
    await assert.rejects(sessionManager.createEmptySession(emptyId), /injected empty persistence failure/);
    assert.equal(sessionManager.getAllSessions().has(emptyId), false);
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    assert.equal((await sessionManager.createEmptySession(emptyId)).created, true);

    let failAgent = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
      if (failAgent && phase === 'history' && sessionId === failedAgentMainId) {
        failAgent = false;
        throw new Error('injected agent persistence failure');
      }
    });
    await assert.rejects(sessionManager.createAgentWithMainSession({ agentName: failedAgent }), /injected agent persistence failure/);
    assert.equal(await fs.pathExists(getAgentDir(failedAgent)), false);
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    assert.equal((await sessionManager.createAgentWithMainSession({ agentName: failedAgent })).mainSessionId, failedAgentMainId);

    await createParent(parentId);
    let failArchiveAppend = true;
    setArchiveWriteFaultInjectorForTests((phase, sessionId) => {
      if (failArchiveAppend && phase === 'after-jsonl-append' && sessionId === forkId) {
        failArchiveAppend = false;
        throw new Error('injected fork archive append failure');
      }
    });
    await assert.rejects(sessionManager.forkSession(parentId), /injected fork archive append failure/);
    assert.equal(await hasArchivedSessionId(forkId), false);
    setArchiveWriteFaultInjectorForTests(null);
    assert.equal(await sessionManager.forkSession(parentId), forkId);

    let failFork = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
      if (failFork && phase === 'history' && sessionId === saveFailureForkId) {
        failFork = false;
        throw new Error('injected fork persistence failure');
      }
    });
    await assert.rejects(sessionManager.forkSession(parentId, 'savefail'), /injected fork persistence failure/);
    assert.equal(await hasArchivedSessionId(saveFailureForkId), false);
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    assert.equal(await sessionManager.forkSession(parentId, 'savefail'), saveFailureForkId);

    await createParent(moveSource);
    let failMove = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
      if (failMove && phase === 'history' && sessionId === moveTarget) {
        failMove = false;
        throw new Error('injected move persistence failure');
      }
    });
    await assert.rejects(
      sessionManager.moveSessionToTarget({ sourceSessionId: moveSource, newSessionId: moveTarget }),
      /injected move persistence failure/,
    );
    assert.ok(sessionManager.getAllSessions().has(moveSource));
    assert.equal(sessionManager.getAllSessions().has(moveTarget), false);
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    const retriedMove = await sessionManager.moveSessionToTarget({ sourceSessionId: moveSource, newSessionId: moveTarget });
    assert.equal(retriedMove.targetSessionId, moveTarget);
  } finally {
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    setArchiveWriteFaultInjectorForTests(null);
    for (const id of [emptyId, failedAgentMainId, parentId, forkId, saveFailureForkId, moveSource, moveTarget]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
    await fs.remove(getAgentDir(failedAgent));
  }
});

test('concurrent identity moves commit one target and preserve the losing source', async () => {
  await sessionManager.loadSessions();
  const sourceA = makeId('concurrent_move_a');
  const sourceB = makeId('concurrent_move_b');
  const target = makeId('concurrent_move_target');
  await createParent(sourceA);
  await createParent(sourceB);

  try {
    const results = await Promise.allSettled([
      sessionManager.moveSessionToTarget({ sourceSessionId: sourceA, newSessionId: target }),
      sessionManager.moveSessionToTarget({ sourceSessionId: sourceB, newSessionId: target }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.ok(await sessionManager.getExistingSession(target));
    assert.equal([sourceA, sourceB].filter(id => sessionManager.getAllSessions().has(id)).length, 1);
  } finally {
    for (const id of [sourceA, sourceB, target]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('concurrent unbound-channel resolution converges on one attached session without orphans', async () => {
  await sessionManager.loadSessions();
  const channelId = makeId('concurrent_channel');
  const conversationId = makeId('conversation');
  const beforeIds = new Set(sessionManager.getAllSessions().keys());

  const results = await Promise.all(
    Array.from({ length: 100 }, () => sessionManager.getOrCreateSessionForChannel(channelId, conversationId)),
  );
  const sessionIds = new Set(results.map(result => result.sessionId));
  assert.equal(sessionIds.size, 1);
  const [sessionId] = [...sessionIds];
  assert.equal(sessionManager.getSessionByChannel(channelId, conversationId), sessionId);

  const createdIds = [...sessionManager.getAllSessions().keys()].filter(id => !beforeIds.has(id));
  assert.deepEqual(createdIds, [sessionId]);

  sessionManager.detachChannel(channelId, conversationId);
  await sessionManager.deleteSession(sessionId);
});

test('external attachment during channel creation discards the unused candidate', async () => {
  await sessionManager.loadSessions();
  const channelId = makeId('external_attach_channel');
  const conversationId = makeId('external_attach_conversation');
  const externalId = makeId('external_attach_winner');
  const candidateId = makeId('external_attach_candidate');
  const external = await sessionManager.createEmptySession(externalId);
  try {
    const resolved = await sessionManager.getOrCreateSessionForChannel(channelId, conversationId, {
      createSession: async () => {
        const candidate = await sessionManager.createEmptySession(candidateId);
        sessionManager.attachChannel(channelId, conversationId, external.session.id);
        return candidate.session;
      },
    });
    assert.equal(resolved.sessionId, externalId);
    assert.equal(sessionManager.getAllSessions().has(candidateId), false);
    assert.equal(await fs.pathExists(path.join(process.env.FOXWARM_DATA_DIR || '', 'state', 'sessions', `${candidateId}.json`)), false);
  } finally {
    sessionManager.detachChannel(channelId, conversationId);
    for (const id of [externalId, candidateId]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('channel creation rejects a failed durable attachment and rolls back its session', async () => {
  await sessionManager.loadSessions();
  const channelId = makeId('failed_attach_channel');
  const conversationId = makeId('failed_attach_conversation');
  const beforeIds = new Set(sessionManager.getAllSessions().keys());
  const store = sessionChannels.createChannelsStore(path.join(os.tmpdir(), `${channelId}.json`));
  (store as any).write = async () => { throw new Error('injected durable attachment failure'); };
  sessionChannels.setChannelsStoreForTests(store);
  sessionChannels.resetChannelsForTests();
  try {
    await assert.rejects(
      sessionManager.getOrCreateSessionForChannel(channelId, conversationId),
      /injected durable attachment failure/,
    );
    assert.equal(sessionManager.getSessionByChannel(channelId, conversationId), undefined);
    assert.deepEqual([...sessionManager.getAllSessions().keys()].filter(id => !beforeIds.has(id)), []);
  } finally {
    sessionChannels.resetChannelsForTests();
    sessionChannels.setChannelsStoreForTests(null);
    await sessionChannels.loadChannels();
  }
});

test('archive reservations preserve exact session ids including trailing whitespace', async () => {
  await sessionManager.loadSessions();
  const sessionId = `${makeId('trailing_space')} `;
  const created = await sessionManager.createEmptySession(sessionId);
  await sessionManager.appendSessionMessage(created.session, {
    role: 'user',
    parts: [{ text: 'exact trailing-space identity' }],
    __meta: { timestamp: Date.now() },
  });
  await sessionManager.deleteSession(sessionId);

  await assertArchivedIdRejection(sessionManager.createEmptySession(sessionId), sessionId);
  const withoutSpace = sessionId.slice(0, -1);
  const distinct = await sessionManager.createEmptySession(withoutSpace);
  assert.equal(distinct.created, true);
  await sessionManager.deleteSession(withoutSpace);
});

test('moved historical ids remain reserved and moved archives rebuild under the canonical id', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-moved-session-id-reservation-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const archiveStorePath = path.resolve(__dirname, 'archiveStore.js');
  const oldSessionId = 'moved_old';
  const intermediateSessionId = 'moved_intermediate';
  const newSessionId = 'moved_new';

  const run = (source: string) => execFileSync(process.execPath, ['-e', source], {
    env: { ...process.env, FOXWARM_DATA_DIR: tempRoot },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const verify = () => run(`
    const sm = require(${JSON.stringify(sessionManagerPath)});
    (async () => {
      await sm.loadSessions();
      for (const id of [${JSON.stringify(oldSessionId)}, ${JSON.stringify(intermediateSessionId)}, ${JSON.stringify(newSessionId)}]) {
        try {
          await sm.createEmptySession(id);
          throw new Error('historical id was reused: ' + id);
        } catch (error) {
          if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error;
        }
      }
      for (const id of [${JSON.stringify(oldSessionId)}, ${JSON.stringify(intermediateSessionId)}, ${JSON.stringify(newSessionId)}]) {
        const archive = await sm.getArchivedMessages(id);
        if (archive.records[0]?.message?.parts?.[0]?.text !== 'history before move') {
          throw new Error('moved archive did not resolve alias: ' + id);
        }
      }
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `);

  const backfillLiveAliasesThenDelete = () => run(`
    const sm = require(${JSON.stringify(sessionManagerPath)});
    const archiveStore = require(${JSON.stringify(archiveStorePath)});
    (async () => {
      await sm.loadSessions();
      await archiveStore.initArchiveStore();
      for (const id of [${JSON.stringify(oldSessionId)}, ${JSON.stringify(intermediateSessionId)}]) {
        if (!await archiveStore.hasArchivedSessionId(id)) throw new Error('live metadata alias was not backfilled: ' + id);
      }
      const current = await sm.getExistingSession(${JSON.stringify(newSessionId)});
      if (!current) throw new Error('current moved session did not hydrate');
      if (!await sm.getExistingSession(${JSON.stringify(oldSessionId)})) throw new Error('live alias did not resolve');
      const archive = await sm.getArchivedMessages(${JSON.stringify(newSessionId)});
      if (archive.records[0]?.message?.parts?.[0]?.text !== 'history before move') {
        throw new Error('live alias backfill did not canonicalize moved archive');
      }
      await sm.deleteSession(${JSON.stringify(newSessionId)});
      for (const id of [${JSON.stringify(oldSessionId)}, ${JSON.stringify(intermediateSessionId)}, ${JSON.stringify(newSessionId)}]) {
        try {
          await sm.createEmptySession(id);
          throw new Error('same-process historical id was reused: ' + id);
        } catch (error) {
          if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error;
        }
      }
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `);

  try {
    run(`
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const original = await sm.createEmptySession(${JSON.stringify(oldSessionId)});
        await sm.appendSessionMessage(original.session, { role: 'user', parts: [{ text: 'history before move' }], __meta: { timestamp: Date.now() } });
        const firstMove = await sm.moveSessionToTarget({ sourceSessionId: original.session.id, newSessionId: ${JSON.stringify(intermediateSessionId)} });
        const secondMove = await sm.moveSessionToTarget({ sourceSessionId: firstMove.targetSessionId, newSessionId: ${JSON.stringify(newSessionId)} });
        if (secondMove.targetSessionId !== ${JSON.stringify(newSessionId)}) throw new Error(secondMove.targetSessionId);
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);

    const reservationLedgerPath = path.join(tempRoot, 'state', 'session-id-reservations.jsonl');
    fs.removeSync(reservationLedgerPath);
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-wal'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-shm'));
    backfillLiveAliasesThenDelete();

    fs.removeSync(reservationLedgerPath);
    verify();

    fs.appendFileSync(reservationLedgerPath, '{"v":1,"sessionId":');
    verify();

    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-wal'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-shm'));
    verify();
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('pre-ledger moved and deleted archive recovers its alias from retained jsonl evidence', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-preledger-moved-deleted-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
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
        const original = await sm.createEmptySession('legacy_moved_old');
        await sm.appendSessionMessage(original.session, { role: 'user', parts: [{ text: 'pre-ledger moved history' }], __meta: { timestamp: Date.now() } });
        await sm.moveSessionToTarget({ sourceSessionId: 'legacy_moved_old', newSessionId: 'legacy_moved_new' });
        await sm.deleteSession('legacy_moved_new');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
    fs.removeSync(path.join(tempRoot, 'state', 'session-id-reservations.jsonl'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-wal'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-shm'));
    run(`
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        for (const id of ['legacy_moved_old', 'legacy_moved_new']) {
          try {
            await sm.createEmptySession(id);
            throw new Error('pre-ledger id reused: ' + id);
          } catch (error) {
            if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error;
          }
          const archive = await sm.getArchivedMessages(id);
          if (archive.records[0]?.message?.parts?.[0]?.text !== 'pre-ledger moved history') throw new Error('archive alias missing: ' + id);
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('startup rolls back a move journal left before target persistence', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-recovery-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  try {
    const crashed = spawnSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.createEmptySession('pending_move_old');
        await sm.appendSessionMessage(source.session, { role: 'user', parts: [{ text: 'pending move history' }], __meta: { timestamp: Date.now() } });
        agentOps.setIdentityMoveFaultInjectorForTests((phase) => {
          if (phase === 'before-target-persistence') process.exit(42);
        });
        await sm.moveSessionToTarget({ sourceSessionId: 'pending_move_old', newSessionId: 'pending_move_new' });
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8' });
    assert.equal(crashed.status, 42, crashed.stderr);
    execFileSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        if (!await sm.getExistingSession('pending_move_old')) throw new Error('old session was not recovered');
        if (await sm.getExistingSession('pending_move_new')) throw new Error('uncommitted target survived recovery');
        const moved = await sm.moveSessionToTarget({ sourceSessionId: 'pending_move_old', newSessionId: 'pending_move_new' });
        if (moved.targetSessionId !== 'pending_move_new') throw new Error(moved.targetSessionId);
        const archive = await sm.getArchivedMessages('pending_move_new');
        if (archive.records[0]?.message?.parts?.[0]?.text !== 'pending move history') throw new Error('history was not recovered');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(fs.pathExistsSync(path.join(tempRoot, 'state', 'session-id-move-pending.json')), false);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('startup finishes a move journal left after target persistence', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-finish-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  try {
    const crashed = spawnSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.createEmptySession('finish_move_old');
        await sm.appendSessionMessage(source.session, { role: 'user', parts: [{ text: 'finish move history' }], __meta: { timestamp: Date.now() } });
        agentOps.setIdentityMoveFaultInjectorForTests((phase) => {
          if (phase === 'after-target-persistence') process.exit(43);
        });
        await sm.moveSessionToTarget({ sourceSessionId: 'finish_move_old', newSessionId: 'finish_move_new' });
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8' });
    assert.equal(crashed.status, 43, crashed.stderr);
    execFileSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        if (!await sm.getExistingSession('finish_move_new')) throw new Error('target session was not finished');
        await sm.deleteSession('finish_move_new');
        for (const id of ['finish_move_old', 'finish_move_new']) {
          try {
            await sm.createEmptySession(id);
            throw new Error('finished move id reused: ' + id);
          } catch (error) {
            if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error;
          }
          const archive = await sm.getArchivedMessages(id);
          if (archive.records[0]?.message?.parts?.[0]?.text !== 'finish move history') throw new Error('finished alias archive missing: ' + id);
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(fs.pathExistsSync(path.join(tempRoot, 'state', 'session-id-move-pending.json')), false);
  } finally {
    fs.removeSync(tempRoot);
  }
});
