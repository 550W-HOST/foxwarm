import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { tool_session } from '../toolsSessionAgent';
import { getAgentDir } from '../config';
import { definitions } from '../tools/definitions';
import { buildSessionListOutput } from '../sessionStatus';
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
    currentNode: 'master',
  } as Session;
}

async function ensureSession(id: string): Promise<Session> {
  const session = await sessionManager.getSession(id);
  Object.assign(session, createBaseSession(id));
  await sessionManager.saveSession(id);
  return session;
}

test('session status action reports current identity, usage, cwd, node, compact threshold, and recent children', async () => {
  await sessionManager.loadSessions();
  const parentSessionId = makeSessionId('session_status_parent');
  const sessionId = makeSessionId('session_status_current');
  const childSessionId = `${sessionId}_child`;
  const parentAlias = `${parentSessionId}_alias`;

  try {
    const parent = await ensureSession(parentSessionId);
    parent.aliases = [parentAlias];
    sessionManager.updateAliasCache([parentAlias], parentSessionId);
    parent.history = [
      { role: 'user', parts: [{ text: 'target status history' }] },
      {
        role: 'tool',
        parts: [{
          functionResponse: {
            tool_use_id: 'status-image',
            name: 'browse_get',
            response: {
              inlineData: {
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqVZsAAAAASUVORK5CYII=',
              },
            },
          },
        }],
      },
    ];
    parent.persistentMemorySnapshot = 'target persistent memory context';
    parent.stats.lastUsage = { cachedTokens: 3, inputTokens: 4, outputTokens: 5 };
    await sessionManager.saveSession(parentSessionId);
    const session = await ensureSession(sessionId);
    session.parentSessionId = parentSessionId;
    session.displayName = 'Status Test';
    session.cwd = '/tmp/status-cwd';
    session.compactThresholdTokens = 7654;
    session.stats.lastUsage = { cachedTokens: 11, inputTokens: 22, outputTokens: 33, reasoningTokens: 7 };
    session.history = [{ role: 'user', parts: [{ text: 'hello status' }] }];
    await sessionManager.saveSession(sessionId);

    const child = await ensureSession(childSessionId);
    child.parentSessionId = sessionId;
    child.meta.lastMessageTime = Date.now() + 1000;
    await sessionManager.saveSession(childSessionId);

    const status = String(await tool_session({}, { sessionId, session }));
    assert.match(status, /Session Status/);
    assert.ok(status.includes(`session id: \`${sessionId}\``));
    assert.match(status, /agent id\/name: `main`/);
    assert.ok(status.includes(`agent dir: \`${getAgentDir('main')}\``));
    assert.ok(status.includes(`parent session id: \`${parentSessionId}\``));
    assert.match(status, /token estimate:/);
    assert.match(status, /last usage: cached=11, input=22, output=33 \(reasoning=7\), total=66/);
    assert.match(status, /auto-compact threshold: ~7,654 tokens \(override: 7,654 tokens\)/);
    assert.match(status, /current node: `master` \(connected, type=`master`/);
    assert.match(status, /current cwd: `\/tmp\/status-cwd`/);
    assert.match(status, /runtime state: idle/);
    assert.match(status, /Recent child sessions/);
    assert.ok(status.includes(`\`${childSessionId}\``));

    const explicitStatus = String(await tool_session({ action: 'status' }, { sessionId, session }));
    assert.equal(explicitStatus, status);

    const targetStatus = String(await tool_session({ action: 'status', sessionId: parentSessionId }, { sessionId, session }));
    assert.ok(targetStatus.includes(`session id: \`${parentSessionId}\``));
    assert.ok(!targetStatus.includes(`session id: \`${sessionId}\``));
    assert.match(targetStatus, /token estimate: ~[1-9][0-9,]* /);
    assert.match(targetStatus, /last usage: cached=3, input=4, output=5, total=12/);
    assert.match(targetStatus, /Images: 1/);
    const ownTargetStatus = String(await tool_session({ action: 'status' }, { sessionId: parentSessionId, session: parent }));
    assert.equal(
      /token estimate: ~([\d,]+)/.exec(ownTargetStatus)?.[1],
      /token estimate: ~([\d,]+)/.exec(targetStatus)?.[1],
    );
    const aliasStatus = String(await tool_session({ action: 'status', sessionId: parentAlias }, { sessionId, session }));
    assert.ok(aliasStatus.includes(`session id: \`${parentSessionId}\``));
    const missingId = makeSessionId('session_status_missing');
    await assert.rejects(
      tool_session({ action: 'status', sessionId: missingId }, { sessionId, session }),
      (error: any) => error?.message === `Session \`${missingId}\` not found.`,
    );
    assert.equal(sessionManager.getAllSessions().has(missingId), false);
  } finally {
    for (const id of [childSessionId, sessionId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('session list action preserves old list pagination behavior', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_list_current');
  const otherId = makeSessionId('session_list_other');

  try {
    const session = await ensureSession(sessionId);
    await ensureSession(otherId);

    const listed = String(await tool_session({ action: 'list', start: 0, count: 1 }, { sessionId, session }));
    assert.ok(listed.includes(`Current session: \`${sessionId}\``));
    assert.match(listed, /Found \d+ session\(s\)\. Showing 1-1\./);
    assert.equal((listed.match(/ - \d+ messages - node:/g) || []).length, 1);
  } finally {
    await sessionManager.deleteSession(otherId).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('session list scopes by caller Agent before pagination and preserves explicit global listing', async () => {
  await sessionManager.loadSessions();
  const agent = makeSessionId('list_scope_agent');
  const otherAgent = makeSessionId('list_scope_other_agent');
  const ids = Array.from({ length: 5 }, (_, index) => makeSessionId(`scope_${index}`));
  const [currentId, foreignNewest, secondOwn, foreignNext, thirdOwn] = ids;
  try {
    for (const [index, id] of ids.entries()) {
      const session = await ensureSession(id);
      session.agent = index === 1 || index === 3 ? otherAgent : agent;
      session.meta.lastMessageTime = Date.now() + 10_000_000 - index * 1000;
      await sessionManager.saveSession(id);
    }
    const current = await sessionManager.getSession(currentId);
    const ctx = { sessionId: currentId, session: current };
    const first = String(await tool_session({ action: 'list', count: 1 }, ctx));
    assert.match(first, /Found 3 session\(s\)\. Showing 1-1\./);
    assert.ok(first.includes(`\`${currentId}\``));
    assert.ok(!first.includes(`\`${foreignNewest}\``));

    const second = String(await tool_session({ action: 'list', start: 1, count: 1, scope: 'current-agent' }, ctx));
    assert.match(second, /Found 3 session\(s\)\. Showing 2-2\./);
    assert.ok(second.includes(`\`${secondOwn}\``));
    assert.ok(!second.includes(`\`${foreignNext}\``));
    const last = String(await tool_session({ action: 'list', start: 2, count: 1 }, ctx));
    assert.ok(last.includes(`\`${thirdOwn}\``));
    assert.equal(String(await tool_session({ action: 'list', start: 3 }, ctx)), 'No sessions found in the requested range. Total sessions: 3.');

    const global = String(await tool_session({ action: 'list', count: 5, scope: 'all' }, ctx));
    assert.ok(global.includes(`\`${foreignNewest}\``));
    assert.ok(global.includes(`\`${foreignNext}\``));
    assert.ok(global.includes('Found '));
    assert.ok(String(await buildSessionListOutput({ scope: 'all', count: 5 })).includes(`\`${foreignNewest}\``));
    await assert.rejects(() => tool_session({ action: 'list', scope: 'foreign' }, ctx), /session\.scope must be/);
    await assert.rejects(() => buildSessionListOutput({}), /without current session context/);
    await assert.rejects(() => buildSessionListOutput({}, 'missing-current-session'), /not found/);

    const schema = definitions.find(def => def.name === 'session')?.parameters;
    assert.deepEqual((schema?.properties as any)?.scope?.enum, ['current-agent', 'all']);
    assert.deepEqual((schema?.properties as any)?.action?.enum, ['status', 'list', 'update-display-name', 'update-parent']);
    assert.deepEqual((schema?.properties as any)?.parentSessionId?.type, ['string', 'null']);
    assert.ok(!schema?.required?.includes('scope'));
  } finally {
    for (const id of ids) await sessionManager.deleteSession(id).catch(() => {});
  }
});

test('session update-display-name action reports set, change, clear, and no-op transitions', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_display_name_current');

  try {
    const session = await ensureSession(sessionId);
    const set = String(await tool_session({ action: 'update-display-name', name: '  Renamed Session  ' }, { sessionId, session }));
    assert.ok(set.includes('display name changed from unset to "Renamed Session"'));
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'Renamed Session');

    const unchanged = String(await tool_session({ action: 'update-display-name', name: 'Renamed Session' }, { sessionId, session }));
    assert.ok(unchanged.includes('display name unchanged (from "Renamed Session" to "Renamed Session")'));

    const changed = String(await tool_session({ action: 'update-display-name', name: 'New Name' }, { sessionId, session }));
    assert.ok(changed.includes('display name changed from "Renamed Session" to "New Name"'));
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'New Name');

    const cleared = String(await tool_session({ action: 'update-display-name', name: '' }, { sessionId, session }));
    assert.ok(cleared.includes('display name changed from "New Name" to unset'));
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, undefined);

    const clearNoOp = String(await tool_session({ action: 'update-display-name', name: '   ' }, { sessionId, session }));
    assert.ok(clearNoOp.includes('display name unchanged (from unset to unset)'));

    await assert.rejects(
      tool_session({ action: 'rename', name: 'Legacy Alias' }, { sessionId, session }),
      /session\.action must be "status", "list", "update-display-name", or "update-parent"/,
    );
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('session update-parent requires an explicit parent and returns the committed relation', async () => {
  await sessionManager.loadSessions();
  const parentId = makeSessionId('session_parent_update_parent');
  const childId = makeSessionId('session_parent_update_child');
  const otherParentId = makeSessionId('session_parent_update_other');

  try {
    await ensureSession(parentId);
    const child = await ensureSession(childId);
    await ensureSession(otherParentId);
    const ctx = { sessionId: childId, session: child };

    await assert.rejects(() => tool_session({ action: 'update-parent' }, ctx), /parentSessionId is required/);
    await assert.rejects(() => tool_session({ action: 'update-parent', parentSessionId: '' }, ctx), /non-empty session ID or null/);
    await assert.rejects(() => tool_session({ action: 'update-parent', parentSessionId: makeSessionId('session_parent_update_missing') }, ctx), /not found/);
    await assert.rejects(() => tool_session({ action: 'update-parent', parentSessionId: childId }, ctx), /own parent/);

    const attached = await tool_session({ action: 'update-parent', parentSessionId: parentId }, ctx) as any;
    assert.deepEqual(attached, { sessionId: childId, previousParentSessionId: null, parentSessionId: parentId });
    assert.equal((await sessionManager.getExistingSession(childId))?.parentSessionId, parentId);
    await assert.rejects(
      () => tool_session({ action: 'update-parent', sessionId: parentId, parentSessionId: childId }, ctx),
      /parent cycle/,
    );
    assert.equal((await sessionManager.getExistingSession(parentId))?.parentSessionId, undefined);

    const moved = await tool_session({ action: 'update-parent', parentSessionId: otherParentId }, ctx) as any;
    assert.deepEqual(moved, { sessionId: childId, previousParentSessionId: parentId, parentSessionId: otherParentId });
    const detached = await tool_session({ action: 'update-parent', parentSessionId: null }, ctx) as any;
    assert.deepEqual(detached, { sessionId: childId, previousParentSessionId: otherParentId, parentSessionId: null });
    assert.equal((await sessionManager.getExistingSession(childId))?.parentSessionId, undefined);

    child.busy = true;
    const busyMove = await tool_session({ action: 'update-parent', parentSessionId: otherParentId }, ctx) as any;
    assert.deepEqual(busyMove, { sessionId: childId, previousParentSessionId: null, parentSessionId: otherParentId });
    child.busy = false;
  } finally {
    for (const id of [childId, otherParentId, parentId]) await sessionManager.deleteSession(id).catch(() => {});
  }
});
