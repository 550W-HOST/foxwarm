import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { tool_session } from '../toolsSessionAgent';
import { getAgentDir } from '../config';
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

  try {
    await ensureSession(parentSessionId);
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
      /session\.action must be "status", "list", or "update-display-name"/,
    );
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
