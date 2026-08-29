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
import { setAgentDirectoryFaultInjectorForTests } from './agentOps';
import { getSessionHistoryFilePath } from './metadataStore';
import * as vector from '../vector';

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

test('session identity moves reject journal-unsafe target ids before mutation', async () => {
  await sessionManager.loadSessions();
  const sourceId = makeId('unsafe_move_source');
  await createParent(sourceId);
  try {
    await assert.rejects(
      sessionManager.moveSessionToTarget({ sourceSessionId: sourceId, newSessionId: '..' }),
      /Invalid newSessionId in pending session identity move journal/,
    );
    assert.ok(await sessionManager.getExistingSession(sourceId));
    assert.equal(await fs.pathExists(path.join(process.env.FOXWARM_DATA_DIR || '', 'state', 'session-id-move-pending.json')), false);
  } finally {
    if (sessionManager.getAllSessions().has(sourceId)) await sessionManager.deleteSession(sourceId).catch(() => {});
  }
});

test('cross-agent identity moves preserve a multi-level tree in mixed order and persisted history', async () => {
  await sessionManager.loadSessions();
  const rootId = makeId('tree_move_root');
  const childId = makeId('tree_move_child');
  const grandchildId = makeId('tree_move_grandchild');
  const targetAgent = makeId('tree_move_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetRootId = `${targetAgent}/root`;
  const targetChildId = `${targetAgent}/child`;
  const targetGrandchildId = `${targetAgent}/grandchild`;

  await createParent(rootId);
  await createParent(childId);
  await createParent(grandchildId);
  await sessionManager.setSessionParent(childId, rootId);
  await sessionManager.setSessionParent(grandchildId, childId);
  await sessionManager.createAgentWithMainSession({ agentName: targetAgent, createMainSession: false });

  try {
    const grandchildMove = await sessionManager.moveSessionToTarget({
      sourceSessionId: grandchildId,
      newSessionId: 'grandchild',
      newAgentName: targetAgent,
    });
    assert.equal(grandchildMove.previousParentSessionId, childId);
    assert.equal(grandchildMove.parentSessionId, childId);

    const rootMove = await sessionManager.moveSessionToTarget({
      sourceSessionId: rootId,
      newSessionId: 'root',
      newAgentName: targetAgent,
    });
    assert.deepEqual(rootMove.updatedChildren, [childId]);
    assert.equal((await sessionManager.getExistingSession(childId))?.parentSessionId, targetRootId);

    const childMove = await sessionManager.moveSessionToTarget({
      sourceSessionId: childId,
      newSessionId: 'child',
      newAgentName: targetAgent,
    });
    assert.deepEqual(childMove.updatedChildren, [targetGrandchildId]);
    assert.equal(childMove.previousParentSessionId, targetRootId);
    assert.equal(childMove.parentSessionId, targetRootId);

    assert.equal((await sessionManager.getExistingSession(targetRootId))?.parentSessionId, undefined);
    assert.equal((await sessionManager.getExistingSession(targetChildId))?.parentSessionId, targetRootId);
    assert.equal((await sessionManager.getExistingSession(targetGrandchildId))?.parentSessionId, targetChildId);

    const persistedChild = await fs.readJson(getSessionHistoryFilePath(targetChildId));
    const persistedGrandchild = await fs.readJson(getSessionHistoryFilePath(targetGrandchildId));
    assert.equal(persistedChild.parentSessionId, targetRootId);
    assert.equal(persistedGrandchild.parentSessionId, targetChildId);
  } finally {
    for (const sessionId of [targetGrandchildId, targetChildId, targetRootId, grandchildId, childId, rootId]) {
      if (sessionManager.getAllSessions().has(sessionId)) await sessionManager.deleteSession(sessionId).catch(() => {});
    }
    await fs.remove(getAgentDir(targetAgent));
  }
});

test('concurrent cross-agent moves serialize without losing parent topology', async () => {
  await sessionManager.loadSessions();
  const rootId = makeId('concurrent_tree_root');
  const childId = makeId('concurrent_tree_child');
  const grandchildId = makeId('concurrent_tree_grandchild');
  const targetAgent = makeId('concurrent_tree_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetRootId = `${targetAgent}/root`;
  const targetChildId = `${targetAgent}/child`;
  const targetGrandchildId = `${targetAgent}/grandchild`;

  await createParent(rootId);
  await createParent(childId);
  await createParent(grandchildId);
  await sessionManager.setSessionParent(childId, rootId);
  await sessionManager.setSessionParent(grandchildId, childId);
  await sessionManager.createAgentWithMainSession({ agentName: targetAgent, createMainSession: false });

  try {
    await Promise.all([
      sessionManager.moveSessionToTarget({ sourceSessionId: rootId, newSessionId: 'root', newAgentName: targetAgent }),
      sessionManager.moveSessionToTarget({ sourceSessionId: childId, newSessionId: 'child', newAgentName: targetAgent }),
      sessionManager.moveSessionToTarget({ sourceSessionId: grandchildId, newSessionId: 'grandchild', newAgentName: targetAgent }),
    ]);
    assert.equal((await sessionManager.getExistingSession(targetChildId))?.parentSessionId, targetRootId);
    assert.equal((await sessionManager.getExistingSession(targetGrandchildId))?.parentSessionId, targetChildId);
  } finally {
    for (const sessionId of [targetGrandchildId, targetChildId, targetRootId, grandchildId, childId, rootId]) {
      if (sessionManager.getAllSessions().has(sessionId)) await sessionManager.deleteSession(sessionId).catch(() => {});
    }
    await fs.remove(getAgentDir(targetAgent));
  }
});

test('identity move optionally reparents after commit while omission preserves the incoming parent', async () => {
  await sessionManager.loadSessions();
  const oldParentId = makeId('move_parent_old');
  const sourceId = makeId('move_parent_source');
  const targetAgent = makeId('move_parent_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetParentId = `${targetAgent}/root`;
  const movedId = `${targetAgent}/moved`;

  await createParent(oldParentId);
  await createParent(sourceId);
  await sessionManager.setSessionParent(sourceId, oldParentId);
  await sessionManager.createAgentWithMainSession({ agentName: targetAgent, createMainSession: false });
  await sessionManager.createSessionInAgent({ agentName: targetAgent, sessionName: 'root' });

  try {
    await assert.rejects(
      () => sessionManager.moveSessionToTarget({
        sourceSessionId: sourceId,
        newSessionId: 'moved',
        newAgentName: targetAgent,
        parentSessionId: '   ',
      }),
      /non-empty existing session ID.*unparent/i,
    );
    assert.ok(await sessionManager.getExistingSession(sourceId));

    const moved = await sessionManager.moveSessionToTarget({
      sourceSessionId: sourceId,
      newSessionId: 'moved',
      newAgentName: targetAgent,
      parentSessionId: targetParentId,
    });
    assert.equal(moved.previousParentSessionId, oldParentId);
    assert.equal(moved.requestedParentSessionId, targetParentId);
    assert.equal(moved.parentSessionId, targetParentId);
    assert.equal(moved.parentUpdateError, undefined);
    assert.equal((await fs.readJson(getSessionHistoryFilePath(movedId))).parentSessionId, targetParentId);
  } finally {
    for (const sessionId of [movedId, targetParentId, sourceId, oldParentId]) {
      if (sessionManager.getAllSessions().has(sessionId)) await sessionManager.deleteSession(sessionId).catch(() => {});
    }
    await fs.remove(getAgentDir(targetAgent));
  }
});

test('identity move parent validation rejects cycles hidden behind historical aliases', async () => {
  await sessionManager.loadSessions();
  const sourceId = makeId('move_alias_cycle_source');
  const sourceAlias = makeId('move_alias_cycle_old');
  const requestedParentId = makeId('move_alias_cycle_parent');
  const targetAgent = makeId('move_alias_cycle_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const movedId = `${targetAgent}/moved`;

  const source = await createParent(sourceId);
  source.aliases = [sourceAlias];
  await sessionManager.saveSession(sourceId);
  const requestedParent = await createParent(requestedParentId);
  requestedParent.parentSessionId = sourceAlias;
  await sessionManager.saveSession(requestedParentId);
  await sessionManager.createAgentWithMainSession({ agentName: targetAgent, createMainSession: false });

  try {
    await assert.rejects(
      () => sessionManager.moveSessionToTarget({
        sourceSessionId: sourceId,
        newSessionId: 'moved',
        newAgentName: targetAgent,
        parentSessionId: requestedParentId,
      }),
      /parent cycle/,
    );
    assert.ok(await sessionManager.getExistingSession(sourceId));
    assert.equal(await sessionManager.getExistingSession(movedId), null);
  } finally {
    for (const sessionId of [movedId, requestedParentId, sourceId]) {
      if (sessionManager.getAllSessions().has(sessionId)) await sessionManager.deleteSession(sessionId).catch(() => {});
    }
    await fs.remove(getAgentDir(targetAgent));
  }
});

test('restart hydration remains valid and the SQLite archive still reserves deleted ids', () => {
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
  const moveAgentSource = makeId('failed_move_agent_source');
  const moveTargetAgent = makeId('failed_move_target_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const moveAgentTarget = `${moveTargetAgent}/main`;
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
      if (failArchiveAppend && phase === 'before-sqlite-write' && sessionId === forkId) {
        failArchiveAppend = false;
        throw new Error('injected fork archive SQLite failure');
      }
    });
    await assert.rejects(sessionManager.forkSession(parentId), /injected fork archive SQLite failure/);
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

    await createParent(moveAgentSource);
    let failAgentMove = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
      if (failAgentMove && phase === 'history' && sessionId === moveAgentTarget) {
        failAgentMove = false;
        throw new Error('injected target-agent move failure');
      }
    });
    await assert.rejects(sessionManager.moveSessionToTarget({
      sourceSessionId: moveAgentSource,
      createAgent: true,
      newAgentName: moveTargetAgent,
    }), /injected target-agent move failure/);
    assert.equal(await fs.pathExists(getAgentDir(moveTargetAgent)), false);
    assert.ok(await sessionManager.getExistingSession(moveAgentSource));
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    assert.equal((await sessionManager.moveSessionToTarget({
      sourceSessionId: moveAgentSource,
      createAgent: true,
      newAgentName: moveTargetAgent,
    })).targetSessionId, moveAgentTarget);
  } finally {
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    setArchiveWriteFaultInjectorForTests(null);
    for (const id of [emptyId, failedAgentMainId, parentId, forkId, saveFailureForkId, moveSource, moveTarget, moveAgentSource, moveAgentTarget]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
    await fs.remove(getAgentDir(failedAgent));
    await fs.remove(getAgentDir(moveTargetAgent));
  }
});

test('normal fork initializes committed derived baseline before append and resets it on failed creation', async () => {
  await sessionManager.loadSessions();
  const parentId = makeId('derived_fork_parent');
  const forkId = `${parentId}_fork`;
  await createParent(parentId);
  const originalCopy = vector.copySessionArchiveIndexCheckpoint;
  const originalReset = vector.resetSessionArchiveDerived;
  const events: string[] = [];
  try {
    (vector as any).copySessionArchiveIndexCheckpoint = async (sourceSessionId: string, targetSessionId: string) => {
      assert.equal(sourceSessionId, parentId);
      assert.equal(targetSessionId, forkId);
      events.push('baseline');
    };
    (vector as any).resetSessionArchiveDerived = async (sessionId: string) => {
      assert.equal(sessionId, forkId);
      events.push('reset');
    };
    let fail = true;
    setArchiveWriteFaultInjectorForTests((phase, sessionId) => {
      if (fail && phase === 'before-sqlite-write' && sessionId === forkId) {
        fail = false;
        assert.deepEqual(events, ['baseline'], 'derived baseline is awaited before fork suffix append');
        throw new Error('injected derived fork append failure');
      }
    });
    await assert.rejects(sessionManager.forkSession(parentId), /injected derived fork append failure/);
    assert.deepEqual(events, ['baseline', 'reset'], 'failed fork creation clears its derived baseline before ID reuse');
    setArchiveWriteFaultInjectorForTests(null);
    assert.equal(await sessionManager.forkSession(parentId), forkId);
    assert.deepEqual(events, ['baseline', 'reset', 'baseline']);
  } finally {
    (vector as any).copySessionArchiveIndexCheckpoint = originalCopy;
    (vector as any).resetSessionArchiveDerived = originalReset;
    setArchiveWriteFaultInjectorForTests(null);
    for (const id of [parentId, forkId]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('create-agent initialization failure cleans journal and partial directory before retry', async () => {
  await sessionManager.loadSessions();
  const sourceId = makeId('init_failure_source');
  const targetAgent = makeId('init_failure_target').replace(/[^a-zA-Z0-9_-]/g, '_');
  await createParent(sourceId);
  try {
    setAgentDirectoryFaultInjectorForTests((phase, agentName) => {
      if (phase === 'after-memory-directory' && agentName === targetAgent) {
        throw new Error('injected target-agent initialization failure');
      }
    });
    await assert.rejects(sessionManager.moveSessionToTarget({
      sourceSessionId: sourceId,
      createAgent: true,
      newAgentName: targetAgent,
    }), /injected target-agent initialization failure/);
    assert.equal(await fs.pathExists(getAgentDir(targetAgent)), false);
    assert.equal(await fs.pathExists(path.join(process.env.FOXWARM_DATA_DIR || '', 'state', 'session-id-move-pending.json')), false);
    assert.ok(await sessionManager.getExistingSession(sourceId));
    setAgentDirectoryFaultInjectorForTests(null);
    assert.equal((await sessionManager.moveSessionToTarget({
      sourceSessionId: sourceId,
      createAgent: true,
      newAgentName: targetAgent,
    })).targetSessionId, `${targetAgent}/main`);
  } finally {
    setAgentDirectoryFaultInjectorForTests(null);
    for (const id of [sourceId, `${targetAgent}/main`]) {
      if (sessionManager.getAllSessions().has(id)) await sessionManager.deleteSession(id).catch(() => {});
    }
    await fs.remove(getAgentDir(targetAgent));
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
        return candidate;
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

test('external attach race never deletes a factory-owned pre-existing session', async () => {
  await sessionManager.loadSessions();
  const channelId = makeId('existing_factory_channel');
  const conversationId = makeId('existing_factory_conversation');
  const victimId = makeId('existing_factory_victim');
  const winnerId = makeId('existing_factory_winner');
  const victim = await sessionManager.createEmptySession(victimId);
  await sessionManager.createEmptySession(winnerId);
  await sessionManager.appendSessionMessage(victim.session, {
    role: 'user',
    parts: [{ text: 'victim archive must survive' }],
    __meta: { timestamp: Date.now() },
  });
  try {
    const resolved = await sessionManager.getOrCreateSessionForChannel(channelId, conversationId, {
      createSession: async () => {
        sessionManager.attachChannel(channelId, conversationId, winnerId);
        return { session: victim.session, created: false };
      },
    });
    assert.equal(resolved.sessionId, winnerId);
    assert.ok(await sessionManager.getExistingSession(victimId));
    const archive = await sessionManager.getArchivedMessages(victimId);
    assert.equal(archive.records[0]?.message.parts[0]?.text, 'victim archive must survive');
  } finally {
    sessionManager.detachChannel(channelId, conversationId);
    for (const id of [victimId, winnerId]) {
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

test('moved historical ids remain reserved while the ledger repairs and missing SQLite fails closed', () => {
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
    backfillLiveAliasesThenDelete();

    fs.removeSync(reservationLedgerPath);
    verify();

    fs.appendFileSync(reservationLedgerPath, '{"v":1,"sessionId":');
    verify();

    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-wal'));
    fs.removeSync(path.join(tempRoot, 'state', 'archive-store.sqlite-shm'));
    run(`
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        try { await sm.loadSessions(); throw new Error('missing authoritative database unexpectedly rebuilt'); }
        catch (error) {
          if (!String(error).includes('authoritative archive database is missing')) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('production startup validates and repairs reservation state before ordinary reads', () => {
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const oldSessionId = 'startup_reservation_old';
  const newSessionId = 'startup_reservation_new';

  const run = (tempRoot: string, source: string) => execFileSync(process.execPath, ['-e', source], {
    env: { ...process.env, FOXWARM_DATA_DIR: tempRoot, FOXWARM_SYNC_FILE_LOG: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prepareMovedReservation = (tempRoot: string) => run(tempRoot, `
    const sm = require(${JSON.stringify(sessionManagerPath)});
    (async () => {
      await sm.loadSessions();
      const created = await sm.createEmptySession(${JSON.stringify(oldSessionId)});
      await sm.appendSessionMessage(created.session, {
        role: 'user', parts: [{ text: 'startup reservation history' }], __meta: { timestamp: 1 },
      });
      await sm.moveSessionToTarget({ sourceSessionId: ${JSON.stringify(oldSessionId)}, newSessionId: ${JSON.stringify(newSessionId)} });
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `);

  const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-startup-reservation-conflict-'));
  try {
    prepareMovedReservation(conflictRoot);
    const ledgerPath = path.join(conflictRoot, 'state', 'session-id-reservations.jsonl');
    const records = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const oldReservation = records.find(record => record.sessionId === oldSessionId);
    assert.ok(oldReservation, 'setup must persist the historical alias');
    oldReservation.canonicalSessionId = 'startup_conflicting_target';
    fs.writeFileSync(ledgerPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    run(conflictRoot, `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        try {
          await sm.loadSessions();
          throw new Error('conflicting reservation state unexpectedly reached startup readiness');
        } catch (error) {
          if (!String(error).includes('between ledger and SQLite')) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
  } finally {
    fs.removeSync(conflictRoot);
  }

  const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-startup-reservation-repair-'));
  try {
    prepareMovedReservation(repairRoot);
    const ledgerPath = path.join(repairRoot, 'state', 'session-id-reservations.jsonl');
    fs.removeSync(ledgerPath);
    run(repairRoot, `
      const fs = require('fs-extra');
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        if (!await fs.pathExists(${JSON.stringify(ledgerPath)})) throw new Error('startup did not repair the missing ledger');
        const records = (await fs.readFile(${JSON.stringify(ledgerPath)}, 'utf8')).trim().split(/\\r?\\n/).filter(Boolean).map(line => JSON.parse(line));
        const reservation = records.find(record => record.sessionId === ${JSON.stringify(oldSessionId)});
        if (reservation?.canonicalSessionId !== ${JSON.stringify(newSessionId)}) throw new Error('startup repaired the wrong alias mapping');
        const archive = await sm.getArchivedMessages(${JSON.stringify(oldSessionId)});
        if (archive.records[0]?.message?.parts?.[0]?.text !== 'startup reservation history') throw new Error('ordinary read did not see the repaired alias');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
  } finally {
    fs.removeSync(repairRoot);
  }
});

test('pre-ledger mismatched path and payload reserve both ids without inventing an alias', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-preledger-moved-deleted-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const configPath = path.resolve(__dirname, '../config.js');
  const migrationPath = path.resolve(__dirname, '../migrations/sqliteOnlyArchives.js');
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const migration = require(${JSON.stringify(migrationPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const record = JSON.stringify({ v: 1, kind: 'message', sessionId: 'legacy_moved_old', agent: 'main', seq: 1,
        timestamp: 1, role: 'user', message: { role: 'user', parts: [{ text: 'pre-ledger moved history' }], __meta: { seq: 1, timestamp: 1 } } }) + '\\n';
      (async () => {
        await fs.outputFile(config.getSessionArchiveLogPath('legacy_moved_new'), record);
        await migration.runSqliteOnlyArchivesMigration();
        for (const id of ['legacy_moved_old', 'legacy_moved_new']) {
          try { await sm.createEmptySession(id); throw new Error('pre-ledger id reused: ' + id); }
          catch (error) { if (error?.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error; }
        }
        const oldArchive = await sm.getArchivedMessages('legacy_moved_old');
        if (oldArchive.records[0]?.message?.parts?.[0]?.text !== 'pre-ledger moved history') throw new Error('payload archive missing');
        const newArchive = await sm.getArchivedMessages('legacy_moved_new');
        if (newArchive.records.length !== 0) throw new Error('uncertain history was merged into path identity');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('inherited-only legacy child log does not redirect or merge its parent archive', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-inherited-only-log-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const configPath = path.resolve(__dirname, '../config.js');
  const archiveStorePath = path.resolve(__dirname, 'archiveStore.js');
  const migrationPath = path.resolve(__dirname, '../migrations/sqliteOnlyArchives.js');
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const archiveStore = require(${JSON.stringify(archiveStorePath)});
      const migration = require(${JSON.stringify(migrationPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const record = (text) => JSON.stringify({
        v: 1, kind: 'message', sessionId: 'legacy_parent', agent: 'main', seq: 1,
        timestamp: 1, role: 'user', message: { role: 'user', parts: [{ text }], __meta: { seq: 1, timestamp: 1 } },
      }) + '\\n';
      (async () => {
        await fs.outputFile(config.getSessionArchiveLogPath('legacy_parent'), record('parent canonical history'));
        await fs.outputFile(config.getSessionArchiveLogPath('legacy_child'), record('parent canonical history'));
        await migration.runSqliteOnlyArchivesMigration();
        if (await archiveStore.resolveArchivedSessionId('legacy_parent') !== 'legacy_parent') throw new Error('parent redirected');
        if (await archiveStore.resolveArchivedSessionId('legacy_child') !== 'legacy_child') throw new Error('child redirected');
        if (!await archiveStore.hasArchivedSessionId('legacy_parent') || !await archiveStore.hasArchivedSessionId('legacy_child')) throw new Error('identities not reserved');
        const child = await sm.getArchivedMessages('legacy_child');
        if (child.records.length !== 0) throw new Error('copied parent rows merged into child reads');
        const parent = await sm.getArchivedMessages('legacy_parent');
        if (parent.records.length !== 1 || parent.records[0].message.parts[0]?.text !== 'parent canonical history') throw new Error('parent archive was overwritten by copied child rows');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('valid conflicting and cyclic alias ledgers fail closed', () => {
  const archiveStorePath = path.resolve(__dirname, 'archiveStore.js');
  const fixtures = [
    {
      name: 'conflict',
      records: [
        { v: 1, sessionId: 'alias_a', canonicalSessionId: 'target_b', timestamp: 1 },
        { v: 1, sessionId: 'alias_a', canonicalSessionId: 'target_c', timestamp: 2 },
      ],
      expected: 'conflicting mappings',
    },
    {
      name: 'cycle',
      records: [
        { v: 1, sessionId: 'alias_a', canonicalSessionId: 'alias_b', timestamp: 1 },
        { v: 1, sessionId: 'alias_b', canonicalSessionId: 'alias_a', timestamp: 2 },
      ],
      expected: 'alias cycle',
    },
  ];
  for (const fixture of fixtures) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `foxwarm-ledger-${fixture.name}-`));
    try {
      fs.outputFileSync(
        path.join(tempRoot, 'state', 'session-id-reservations.jsonl'),
        `${fixture.records.map(record => JSON.stringify(record)).join('\n')}\n`,
      );
      execFileSync(process.execPath, ['-e', `
        const archiveStore = require(${JSON.stringify(archiveStorePath)});
        (async () => {
          try {
            await archiveStore.initArchiveStore();
            throw new Error('invalid ledger unexpectedly loaded');
          } catch (error) {
            if (!String(error).includes(${JSON.stringify(fixture.expected)})) throw error;
          }
          process.exit(0);
        })().catch(error => { console.error(error); process.exit(1); });
      `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      fs.removeSync(tempRoot);
    }
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

test('pending move recovery rejects traversal IDs before touching filesystem state', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-containment-'));
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  const markerPath = path.join(tempRoot, 'outside-marker');
  try {
    fs.outputFileSync(markerPath, 'keep');
    fs.outputJsonSync(path.join(tempRoot, 'state', 'session-id-move-pending.json'), {
      v: 1,
      phase: 'rolling-back',
      oldSessionId: '../../outside-marker',
      newSessionId: 'safe_target',
      oldAliases: [],
      ownsTargetAgentDirectory: false,
      createdAt: Date.now(),
    });
    execFileSync(process.execPath, ['-e', `
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        try {
          await agentOps.recoverPendingSessionIdentityMove(async () => {});
          throw new Error('unsafe journal unexpectedly recovered');
        } catch (error) {
          if (!String(error).includes('Invalid oldSessionId')) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
    assert.equal(fs.pathExistsSync(path.join(tempRoot, 'state', 'session-id-move-pending.json')), true);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('pre-migration pending move rollback restores active legacy archive paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-legacy-archive-'));
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  const configPath = path.resolve(__dirname, '../config.js');
  try {
    execFileSync(process.execPath, ['-e', `
      const fs=require('fs-extra');const c=require(${JSON.stringify(configPath)});const a=require(${JSON.stringify(agentOpsPath)});
      (async()=>{await fs.outputJson(c.SESSION_ID_MOVE_JOURNAL_PATH,{v:1,phase:'rolling-back',oldSessionId:'legacy_move_old',newSessionId:'legacy_move_new',oldAliases:[],ownsTargetAgentDirectory:false,createdAt:Date.now()});await fs.outputFile(c.getSessionArchiveLogPath('legacy_move_new'),'legacy-message');await fs.outputFile(c.getSessionBlockArchiveLogPath('legacy_move_new'),'legacy-block');await a.recoverPendingSessionIdentityMove(async()=>{});if(!await fs.pathExists(c.getSessionArchiveLogPath('legacy_move_old'))||!await fs.pathExists(c.getSessionBlockArchiveLogPath('legacy_move_old')))throw new Error('legacy paths not restored');if(await fs.pathExists(c.getSessionArchiveLogPath('legacy_move_new'))||await fs.pathExists(c.getSessionBlockArchiveLogPath('legacy_move_new')))throw new Error('legacy target paths survived')})().catch(e=>{console.error(e.stack);process.exit(1)});`], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot, FOXWARM_SYNC_FILE_LOG: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('loadSessions propagates authoritative pending-move recovery failure', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-fatal-load-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const vectorPath = path.resolve(__dirname, '../vector.js');
  try {
    fs.outputJsonSync(path.join(tempRoot, 'state', 'session-id-move-pending.json'), {
      v: 1,
      phase: 'rolling-back',
      oldSessionId: 'fatal_old',
      newSessionId: 'fatal_new',
      oldAliases: [],
      ownsTargetAgentDirectory: false,
      createdAt: Date.now(),
    });
    execFileSync(process.execPath, ['-e', `
      const vector = require(${JSON.stringify(vectorPath)});
      vector.renameSessionArchiveIndex = async () => { throw new Error('injected recovery failure'); };
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        try {
          await sm.loadSessions();
          throw new Error('loadSessions swallowed pending recovery failure');
        } catch (error) {
          if (!String(error).includes('injected recovery failure')) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(fs.pathExistsSync(path.join(tempRoot, 'state', 'session-id-move-pending.json')), true);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('pending move ownership cannot target an unrelated agent directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-ownership-binding-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const unrelatedDir = path.join(tempRoot, 'agents', 'unrelated');
  const markerPath = path.join(unrelatedDir, 'KEEP');
  try {
    fs.outputFileSync(markerPath, 'keep');
    fs.outputJsonSync(path.join(tempRoot, 'state', 'session-id-move-pending.json'), {
      v: 1,
      phase: 'rolling-back',
      oldSessionId: 'binding_old',
      newSessionId: 'target_agent/main',
      oldAgent: 'main',
      oldAliases: [],
      ownsTargetAgentDirectory: true,
      targetAgentName: 'unrelated',
      createdAt: Date.now(),
    });
    execFileSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        try {
          await sm.loadSessions();
          throw new Error('inconsistent ownership unexpectedly loaded');
        } catch (error) {
          if (!String(error).includes('inconsistent target-agent directory ownership')) throw error;
        }
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
    assert.equal(fs.pathExistsSync(path.join(tempRoot, 'state', 'session-id-move-pending.json')), true);
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('failed reverse persistence keeps move journal until startup completes rollback', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-pending-move-reverse-failure-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const path = require('path');
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        await sm.createEmptySession('rollback_source');
        const childId = await sm.createChildSession('rollback_source', 'worker', false);
        let childWrites = 0;
        sm.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
          if (phase !== 'history') return;
          if (sessionId === childId && ++childWrites === 2) throw new Error('injected reverse child save failure');
          if (sessionId === 'rollback_target') throw new Error('injected target save failure');
        });
        try {
          await sm.moveSessionToTarget({ sourceSessionId: 'rollback_source', newSessionId: 'rollback_target' });
          throw new Error('move unexpectedly succeeded');
        } catch (error) {
          if (error?.name !== 'SessionMoveRollbackError' || !String(error).includes('rollback remains pending')) throw error;
        }
        if (!await fs.pathExists(path.join(${JSON.stringify(tempRoot)}, 'state', 'session-id-move-pending.json'))) throw new Error('journal was cleared after failed rollback');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const path = require('path');
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const child = await sm.getExistingSession('rollback_source_worker');
        if (child?.parentSessionId !== 'rollback_source') throw new Error('child parent was not recovered: ' + child?.parentSessionId);
        if (await fs.pathExists(path.join(${JSON.stringify(tempRoot)}, 'state', 'session-id-move-pending.json'))) throw new Error('journal remained after startup recovery');
        const retry = await sm.moveSessionToTarget({ sourceSessionId: 'rollback_source', newSessionId: 'rollback_target' });
        if (retry.targetSessionId !== 'rollback_target') throw new Error('exact target retry failed');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('create-agent move keeps owned directory for recorded rollback and startup removes it', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-owned-agent-rollback-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  const configPath = path.resolve(__dirname, '../config.js');
  try {
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.createEmptySession('owned_rollback_source');
        await sm.appendSessionMessage(source.session, { role: 'user', parts: [{ text: 'owned rollback history' }], __meta: { timestamp: Date.now() } });
        await sm.createChildSession('owned_rollback_source', 'worker', false);
        let rollbackStarted = false;
        let sourceSaveFailed = false;
        agentOps.setIdentityMoveFaultInjectorForTests((phase) => {
          if (phase === 'after-target-persistence') {
            rollbackStarted = true;
            throw new Error('injected post-target failure');
          }
        });
        sm.setSessionPersistenceFaultInjectorForTests((phase, sessionId) => {
          if (!rollbackStarted) return;
          if (phase === 'history' && sessionId === 'owned_rollback_source') {
            sourceSaveFailed = true;
            throw new Error('injected rollback source save failure');
          }
          if (phase === 'metadata' && sourceSaveFailed) throw new Error('injected rollback metadata failure');
        });
        try {
          await sm.moveSessionToTarget({ sourceSessionId: 'owned_rollback_source', createAgent: true, newAgentName: 'owned_rollback_agent' });
          throw new Error('move unexpectedly succeeded');
        } catch (error) {
          if (error?.name !== 'SessionMoveRollbackError') throw error;
        }
        const journal = await fs.readJson(config.SESSION_ID_MOVE_JOURNAL_PATH);
        if (journal.phase !== 'rolling-back' || journal.ownsTargetAgentDirectory !== true || journal.targetAgentName !== 'owned_rollback_agent') throw new Error('journal intent/ownership missing');
        if (!await fs.pathExists(config.getAgentDir('owned_rollback_agent'))) throw new Error('owned directory deleted before recovery');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.getExistingSession('owned_rollback_source');
        if (!source || source.history[0]?.parts?.[0]?.text !== 'owned rollback history') throw new Error('source history not restored');
        const child = await sm.getExistingSession('owned_rollback_source_worker');
        if (child?.parentSessionId !== 'owned_rollback_source') throw new Error('child relation not restored');
        if (await fs.pathExists(config.getAgentDir('owned_rollback_agent'))) throw new Error('owned directory survived completed rollback');
        if (await fs.pathExists(config.SESSION_ID_MOVE_JOURNAL_PATH)) throw new Error('journal not cleared');
        const retry = await sm.moveSessionToTarget({ sourceSessionId: 'owned_rollback_source', createAgent: true, newAgentName: 'owned_rollback_agent' });
        if (retry.targetSessionId !== 'owned_rollback_agent/main') throw new Error('exact retry failed');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('create-agent copy crash is journaled before target directory mutation', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-owned-agent-copy-crash-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  const configPath = path.resolve(__dirname, '../config.js');
  try {
    const crashed = spawnSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.createAgentWithMainSession({
          agentName: 'copy_crash_source',
          initialMemoryFiles: { 'MEMORY.md': 'copy crash marker' },
        });
        const session = await sm.getSession(source.mainSessionId);
        await sm.appendSessionMessage(session, { role: 'user', parts: [{ text: 'copy crash history' }], __meta: { timestamp: Date.now() } });
        agentOps.setAgentDirectoryFaultInjectorForTests((phase, agentName) => {
          if (phase === 'after-memory-copy' && agentName === 'copy_crash_target') process.exit(45);
        });
        await sm.moveSessionToTarget({
          sourceSessionId: source.mainSessionId,
          createAgent: true,
          newAgentName: 'copy_crash_target',
          createAgentInheritMemory: true,
        });
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8' });
    assert.equal(crashed.status, 45, crashed.stderr);
    const journalPath = path.join(tempRoot, 'state', 'session-id-move-pending.json');
    const journal = fs.readJsonSync(journalPath);
    assert.equal(journal.phase, 'rolling-back');
    assert.equal(journal.targetAgentName, 'copy_crash_target');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'agents', 'copy_crash_target', 'memory', 'MEMORY.md'), 'utf8'), 'copy crash marker');

    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.getExistingSession('copy_crash_source/main');
        if (!source || source.history[0]?.parts?.[0]?.text !== 'copy crash history') throw new Error('source was not preserved');
        if (await fs.pathExists(config.getAgentDir('copy_crash_target'))) throw new Error('partial target directory survived recovery');
        if (await fs.pathExists(config.SESSION_ID_MOVE_JOURNAL_PATH)) throw new Error('journal not cleared');
        const retry = await sm.moveSessionToTarget({
          sourceSessionId: 'copy_crash_source/main',
          createAgent: true,
          newAgentName: 'copy_crash_target',
          createAgentInheritMemory: true,
        });
        if (retry.targetSessionId !== 'copy_crash_target/main') throw new Error('exact retry failed');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.removeSync(tempRoot);
  }
});

test('create-agent finishing recovery keeps its owned target directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-owned-agent-finish-'));
  const sessionManagerPath = path.resolve(__dirname, '../sessionManager.js');
  const agentOpsPath = path.resolve(__dirname, 'agentOps.js');
  const configPath = path.resolve(__dirname, '../config.js');
  try {
    const crashed = spawnSync(process.execPath, ['-e', `
      const sm = require(${JSON.stringify(sessionManagerPath)});
      const agentOps = require(${JSON.stringify(agentOpsPath)});
      (async () => {
        await sm.loadSessions();
        const source = await sm.createEmptySession('owned_finish_source');
        await sm.appendSessionMessage(source.session, { role: 'user', parts: [{ text: 'owned finish history' }], __meta: { timestamp: Date.now() } });
        agentOps.setIdentityMoveFaultInjectorForTests((phase) => {
          if (phase === 'after-target-persistence') process.exit(44);
        });
        await sm.moveSessionToTarget({ sourceSessionId: 'owned_finish_source', createAgent: true, newAgentName: 'owned_finish_agent' });
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8' });
    assert.equal(crashed.status, 44, crashed.stderr);
    execFileSync(process.execPath, ['-e', `
      const fs = require('fs-extra');
      const config = require(${JSON.stringify(configPath)});
      const sm = require(${JSON.stringify(sessionManagerPath)});
      (async () => {
        await sm.loadSessions();
        const target = await sm.getExistingSession('owned_finish_agent/main');
        if (!target || target.history[0]?.parts?.[0]?.text !== 'owned finish history') throw new Error('forward recovery did not finish');
        if (!await fs.pathExists(config.getAgentDir('owned_finish_agent'))) throw new Error('owned target directory was removed');
        if (await fs.pathExists(config.SESSION_ID_MOVE_JOURNAL_PATH)) throw new Error('journal not cleared');
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env: { ...process.env, FOXWARM_DATA_DIR: tempRoot }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
