import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import * as sessionManager from './sessionManager';
import { tool_create_session } from './toolsSessionAgent';
import { SESSIONS_FILE, getAgentDir, getAgentMemoryDir } from './config';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('systemPromptFiles overrides default snapshot composition and persists on create_session', async () => {
  await sessionManager.loadSessions();

  const agentName = makeId('agent_system_prompt_files');
  const parentSessionId = makeId('parent_system_prompt_files');
  const defaultSessionName = makeId('default_session');
  const customSessionName = makeId('custom_session');
  const defaultSessionId = `${agentName}/${defaultSessionName}`;
  const customSessionId = `${agentName}/${customSessionName}`;
  const agentDir = getAgentDir(agentName);
  const memoryDir = getAgentMemoryDir(agentName);
  const fileA = 'MEMORY.md';
  const fileB = 'SOUL.md';
  const fileC = 'EXTRA.md';

  await fs.ensureDir(memoryDir);
  await fs.writeFile(path.join(memoryDir, fileA), '# Memory A\nAlpha\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, fileB), '# Memory B\nBeta\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, fileC), '# Extra\nGamma\n', 'utf8');

  const parent = await sessionManager.getSession(parentSessionId);
  parent.agent = 'main';
  parent.history = [];
  parent.persistentMemorySnapshot = '';
  parent.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  parent.busy = false;
  parent.queue = [];
  parent.meta = { lastMessageTime: Date.now() };
  parent.currentNode = 'master';
  await sessionManager.saveSession(parentSessionId);

  try {
    await tool_create_session({ agentName, sessionName: defaultSessionName }, { sessionId: parentSessionId, session: parent });
    await tool_create_session({
      agentName,
      sessionName: customSessionName,
      systemPromptFiles: `${fileA}\n${fileB}`,
    }, { sessionId: parentSessionId, session: parent });

    const defaultSession = await sessionManager.getSession(defaultSessionId);
    const customSession = await sessionManager.getSession(customSessionId);

    assert.equal(defaultSession.systemPromptFiles, undefined);
    assert.equal(customSession.systemPromptFiles, `${fileA}\n${fileB}`);

    assert.match(defaultSession.persistentMemorySnapshot, /Alpha/);
    assert.match(defaultSession.persistentMemorySnapshot, /Beta/);
    assert.match(defaultSession.persistentMemorySnapshot, /Gamma/);

    assert.match(customSession.persistentMemorySnapshot, /Alpha/);
    assert.match(customSession.persistentMemorySnapshot, /Beta/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /Gamma/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /--- DIRECTORIES ---/);

    const sessionsIndex = await fs.readJson(SESSIONS_FILE);
    assert.equal(sessionsIndex.sessions?.[customSessionId]?.systemPromptFiles, `${fileA}\n${fileB}`);

    const customHistoryFile = path.join(path.dirname(SESSIONS_FILE), 'sessions', `${customSessionId}.json`);
    const customHistoryPayload = await fs.readJson(customHistoryFile);
    assert.equal(customHistoryPayload.systemPromptFiles, `${fileA}\n${fileB}`);

    await fs.writeFile(path.join(memoryDir, fileA), '# Memory A\nAlpha updated\n', 'utf8');
    await sessionManager.refreshSessionSnapshot(customSessionId);
    const refreshedCustomSession = await sessionManager.getSession(customSessionId);
    assert.match(refreshedCustomSession.persistentMemorySnapshot, /Alpha updated/);
    assert.doesNotMatch(refreshedCustomSession.persistentMemorySnapshot, /Gamma/);
  } finally {
    for (const sessionId of [defaultSessionId, customSessionId, parentSessionId]) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }

    await fs.remove(agentDir).catch(() => {});
  }
});