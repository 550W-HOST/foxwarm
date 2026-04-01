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

async function ensureParentSession(sessionId: string) {
  const parent = await sessionManager.getSession(sessionId);
  parent.agent = 'main';
  parent.history = [];
  parent.persistentMemorySnapshot = '';
  parent.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  parent.busy = false;
  parent.queue = [];
  parent.meta = { lastMessageTime: Date.now() };
  parent.currentNode = 'master';
  await sessionManager.saveSession(sessionId);
  return parent;
}

test('systemPromptFiles uses string[] and only overrides memory-file sources while retaining other system injections', async () => {
  await sessionManager.loadSessions();

  const agentName = makeId('agent_system_prompt_files');
  const parentSessionId = makeId('parent_system_prompt_files');
  const defaultSessionName = makeId('default_session');
  const customSessionName = makeId('custom_session');
  const defaultSessionId = `${agentName}/${defaultSessionName}`;
  const customSessionId = `${agentName}/${customSessionName}`;
  const agentDir = getAgentDir(agentName);
  const memoryDir = getAgentMemoryDir(agentName);
  const skillName = 'catalog-test-skill';
  const externalFile = path.join('/tmp', `${makeId('system_prompt_external')}.md`);
  const relativePromptDir = path.join(agentDir, 'skill-prompts');
  const relativePromptFile = path.join(relativePromptDir, 'custom-prompt.md');
  const relativePromptRef = path.join('skill-prompts', 'custom-prompt.md');

  await fs.ensureDir(memoryDir);
  await fs.ensureDir(relativePromptDir);
  await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# Memory A\nAlpha\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, 'SOUL.md'), '# Memory B\nBeta\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, 'EXTRA.md'), '# Extra\nGamma\n', 'utf8');
  await fs.writeFile(externalFile, '# External\nOutside\n', 'utf8');
  await fs.writeFile(relativePromptFile, '# Relative Prompt\nRelative agent-dir file\n', 'utf8');

  const skillDir = path.join(agentDir, 'skills', skillName);
  await fs.ensureDir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Catalog test description\n---\n# ${skillName}\n\nFULL SKILL INSTRUCTIONS UNIQUE\n`, 'utf8');

  const parent = await ensureParentSession(parentSessionId);

  try {
    await tool_create_session({ agentName, sessionName: defaultSessionName }, { sessionId: parentSessionId, session: parent });
    await tool_create_session({
      agentName,
      sessionName: customSessionName,
      systemPromptFiles: [relativePromptRef, externalFile],
    }, { sessionId: parentSessionId, session: parent });

    const defaultSession = await sessionManager.getSession(defaultSessionId);
    const customSession = await sessionManager.getSession(customSessionId);

    assert.equal(defaultSession.systemPromptFiles, undefined);
    assert.deepEqual(customSession.systemPromptFiles, [relativePromptRef, externalFile]);

    assert.match(defaultSession.persistentMemorySnapshot, /Alpha/);
    assert.match(defaultSession.persistentMemorySnapshot, /Beta/);
    assert.match(defaultSession.persistentMemorySnapshot, /Gamma/);

    assert.match(customSession.persistentMemorySnapshot, /Relative agent-dir file/);
    assert.match(customSession.persistentMemorySnapshot, /Outside/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /Alpha/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /Beta/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /Gamma/);
    assert.match(customSession.persistentMemorySnapshot, /<available_skills>/);
    assert.match(customSession.persistentMemorySnapshot, new RegExp(`<name>${skillName}</name>`));
    assert.match(customSession.persistentMemorySnapshot, /Catalog test description/);
    assert.doesNotMatch(customSession.persistentMemorySnapshot, /FULL SKILL INSTRUCTIONS UNIQUE/);
    assert.match(customSession.persistentMemorySnapshot, /--- DIRECTORIES ---/);

    const sessionsIndex = await fs.readJson(SESSIONS_FILE);
    assert.deepEqual(sessionsIndex.sessions?.[customSessionId]?.systemPromptFiles, [relativePromptRef, externalFile]);

    const customHistoryFile = path.join(path.dirname(SESSIONS_FILE), 'sessions', `${customSessionId}.json`);
    const customHistoryPayload = await fs.readJson(customHistoryFile);
    assert.deepEqual(customHistoryPayload.systemPromptFiles, [relativePromptRef, externalFile]);

    await fs.writeFile(relativePromptFile, '# Relative Prompt\nRelative agent-dir file updated\n', 'utf8');
    await sessionManager.refreshSessionSnapshot(customSessionId);
    const refreshedCustomSession = await sessionManager.getSession(customSessionId);
    assert.match(refreshedCustomSession.persistentMemorySnapshot, /Relative agent-dir file updated/);
    assert.match(refreshedCustomSession.persistentMemorySnapshot, /<available_skills>/);
  } finally {
    for (const sessionId of [defaultSessionId, customSessionId, parentSessionId]) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }

    await fs.remove(externalFile).catch(() => {});
    await fs.remove(agentDir).catch(() => {});
  }
});

test('isolated agent sessions reject out-of-agent custom systemPromptFiles but allow in-agent files', async () => {
  await sessionManager.loadSessions();

  const agentName = makeId('isolated_system_prompt_agent');
  const parentSessionId = makeId('isolated_system_prompt_parent');
  const blockedSessionName = makeId('blocked_session');
  const allowedSessionName = makeId('allowed_session');
  const allowedSessionId = `${agentName}/${allowedSessionName}`;
  const agentDir = getAgentDir(agentName);
  const memoryDir = getAgentMemoryDir(agentName);
  const outsideFile = path.join('/tmp', `${makeId('isolated_outside')}.md`);
  const insideRelativeDir = path.join(agentDir, 'skill-prompts');
  const insideRelativeFile = path.join(insideRelativeDir, 'inside.md');
  const insideRelativeRef = path.join('skill-prompts', 'inside.md');

  await fs.ensureDir(memoryDir);
  await fs.ensureDir(insideRelativeDir);
  await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# Isolated\nInside allowed\n', 'utf8');
  await fs.writeFile(insideRelativeFile, '# In Agent Dir\nInside relative allowed\n', 'utf8');
  await fs.writeFile(outsideFile, '# Outside\nForbidden\n', 'utf8');
  await sessionManager.setAgentIsolation(agentName, 'sandbox-node');

  const parent = await ensureParentSession(parentSessionId);

  try {
    await assert.rejects(
      tool_create_session({
        agentName,
        sessionName: blockedSessionName,
        systemPromptFiles: [outsideFile],
      }, { sessionId: parentSessionId, session: parent }),
      /can only access agents\//,
    );

    await tool_create_session({
      agentName,
      sessionName: allowedSessionName,
      systemPromptFiles: [insideRelativeRef],
    }, { sessionId: parentSessionId, session: parent });

    const allowedSession = await sessionManager.getSession(allowedSessionId);
    assert.deepEqual(allowedSession.systemPromptFiles, [insideRelativeRef]);
    assert.match(allowedSession.persistentMemorySnapshot, /Inside relative allowed/);
    assert.doesNotMatch(allowedSession.persistentMemorySnapshot, /Forbidden/);
  } finally {
    await sessionManager.deleteSession(allowedSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
    await sessionManager.setAgentIsolation(agentName, undefined).catch(() => {});
    await fs.remove(outsideFile).catch(() => {});
    await fs.remove(agentDir).catch(() => {});
  }
});