import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { tool_move_session, tool_send_to_session, tool_set_goal, tool_wait } from '../toolsSessionAgent';
import type { Session } from '../types';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

async function ensureSession(id: string): Promise<Session> {
  const existing = await sessionManager.getSession(id);
  Object.assign(existing, createBaseSession(id));
  await sessionManager.saveSession(id);
  return existing;
}

test('wait returns concise output without echoing reason text', async () => {
  const result = await tool_wait({ reason: 'because the handoff is complete' });
  assert.equal(result.output, 'ok');
  assert.deepEqual(result.__toolLoopControl, { stopCurrentTurn: true });
});

test('send_to_session rejects self-sends', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_send_self');
  const session = await ensureSession(sessionId);
  try {
    await assert.rejects(
      () => tool_send_to_session({ sessionId, message: 'loopback' }, { sessionId, session }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /send_to_session target resolves to this same session/i);
        assert.match(message, new RegExp(`current_session_id=\`${sessionId}\``));
        assert.match(message, new RegExp(`requested_session_id=\`${sessionId}\``));
        assert.match(message, new RegExp(`resolved_session_id=\`${sessionId}\``));
        assert.match(message, /generate ordinary assistant text instead/i);
        return true;
      },
    );
    assert.equal(session.queue.length, 0);
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});

test('send_to_session resolves <parent> and <main> aliases before routing', async () => {
  await sessionManager.loadSessions();
  const agentName = makeSessionId('alias_agent');
  const mainSessionId = `${agentName}/main`;
  const childSessionId = `${agentName}/worker`;

  try {
    const main = await ensureSession(mainSessionId);
    main.agent = agentName;
    await sessionManager.saveSession(mainSessionId);

    const child = await ensureSession(childSessionId);
    child.agent = agentName;
    child.parentSessionId = mainSessionId;
    await sessionManager.saveSession(childSessionId);

    const toParent = await tool_send_to_session(
      { sessionId: '<parent>', message: 'child report' },
      { sessionId: childSessionId, session: child },
    );
    assert.match(String(toParent), new RegExp(`Message sent to session \`${mainSessionId}\``));
    assert.match(String(toParent), /requested `<parent>`/);
    const refreshedMain = await sessionManager.getSession(mainSessionId);
    assert.equal(refreshedMain.queue.length, 1);
    assert.equal(refreshedMain.queue[0]?.sourceSessionId, childSessionId);

    const toMain = await tool_send_to_session(
      { sessionId: '<main>', message: 'also main' },
      { sessionId: childSessionId, session: child },
    );
    assert.match(String(toMain), new RegExp(`Message sent to session \`${mainSessionId}\``));
    assert.match(String(toMain), /requested `<main>`/);
  } finally {
    await sessionManager.deleteSession(childSessionId).catch(() => {});
    await sessionManager.deleteSession(mainSessionId).catch(() => {});
  }
});

test('send_to_session <parent> errors clearly when current session has no parent', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('alias_no_parent');
  const session = await ensureSession(sessionId);
  try {
    await assert.rejects(
      () => tool_send_to_session({ sessionId: '<parent>', message: 'hello' }, { sessionId, session }),
      /Cannot resolve `<parent>`.*has no parent session/,
    );
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('move_session intentionally reparents and reports identity and relation results', async () => {
  await sessionManager.loadSessions();
  const oldParentId = makeSessionId('tool_move_old_parent');
  const newParentId = makeSessionId('tool_move_new_parent');
  const sourceId = makeSessionId('tool_move_source');
  const targetId = makeSessionId('tool_move_target');
  const oldParent = await ensureSession(oldParentId);
  const newParent = await ensureSession(newParentId);
  await ensureSession(sourceId);
  await sessionManager.setSessionParent(sourceId, oldParentId);

  try {
    const output = await tool_move_session({
      sessionId: sourceId,
      newSessionId: targetId,
      parentSessionId: newParentId,
    }, { sessionId: oldParentId, session: oldParent });

    assert.match(String(output), new RegExp(`Session "${sourceId}" moved to "${targetId}"`));
    assert.match(String(output), new RegExp(`Previous parent: ${oldParentId}`));
    assert.match(String(output), new RegExp(`Resulting parent: ${newParentId}`));
    assert.equal((await sessionManager.getExistingSession(targetId))?.parentSessionId, newParent.id);
  } finally {
    for (const sessionId of [targetId, sourceId, newParentId, oldParentId]) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('set_goal returns concise output without echoing goal content or remindEvery', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_goal');
  const session = await ensureSession(sessionId);
  try {
    const updated = await tool_set_goal({ goal: 'Ship feature safely', remindEvery: 7 }, { sessionId, session });
    assert.equal(updated, 'ok');
    assert.doesNotMatch(String(updated), /ship feature|remindEvery|7/);

    const cleared = await tool_set_goal({ clear: true }, { sessionId, session });
    assert.equal(cleared, 'ok');
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});

test('set_goal accepts omitted remindEvery', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('tool_result_goal_optional');
  const session = await ensureSession(sessionId);
  try {
    const updated = await tool_set_goal({ goal: 'Ship feature safely' }, { sessionId, session });
    assert.equal(updated, 'ok');
    assert.equal(session.goalState?.remindEvery, 20);

    const second = await tool_set_goal({ goal: 'Ship feature later' }, { sessionId, session });
    assert.equal(second, 'ok');
    assert.equal(session.goalState?.remindEvery, 20);
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failures in test
    }
  }
});
