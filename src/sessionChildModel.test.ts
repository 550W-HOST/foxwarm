import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import { resolveModelConfig } from './config';
import { tool_create_child_session, tool_create_session, tool_set_session_child_model } from './toolsSessionAgent';
import { Session } from './types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string, model?: string): Session {
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
    model,
  };
}

async function ensureSession(id: string, model?: string): Promise<Session> {
  const session = await sessionManager.getSession(id);
  Object.assign(session, createBaseSession(id, model));
  await sessionManager.saveSession(id);
  return session;
}

function getTestModels(): { primary: string; secondary: string } {
  const { modelsConfig, currentKey } = resolveModelConfig(undefined);
  const keys = modelsConfig.displayModels || Object.keys(modelsConfig.models || {});
  const primary = currentKey;
  const secondary = keys.find(key => key !== primary) || primary;
  return { primary, secondary };
}

test('create_session tool accepts explicit model override', async () => {
  await sessionManager.loadSessions();
  const { primary, secondary } = getTestModels();
  const parentSessionId = makeId('create_session_model_parent');
  const sessionName = makeId('created_session_model');
  const createdSessionId = sessionName;

  try {
    const parent = await ensureSession(parentSessionId, primary);
    const result = await tool_create_session({
      agentName: 'main',
      sessionName,
      model: secondary,
    }, { sessionId: parentSessionId, session: parent });

    assert.match(String(result), /Model:/);
    const created = await sessionManager.getSession(createdSessionId);
    assert.equal(created.model, secondary);
  } finally {
    await sessionManager.deleteSession(createdSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
  }
});

test('child default model falls back to current session model when unset, then uses override, then clears back to inheritance', async () => {
  await sessionManager.loadSessions();
  const { primary, secondary } = getTestModels();
  const parentSessionId = makeId('child_model_parent');
  const childDefaultId = `${parentSessionId}_child_default`;
  const childOverrideId = `${parentSessionId}_child_override`;
  const childClearedId = `${parentSessionId}_child_cleared`;

  try {
    const parent = await ensureSession(parentSessionId, primary);

    await tool_create_child_session({ suffix: 'child_default', fork: false }, { sessionId: parentSessionId, session: parent });
    const inheritedChild = await sessionManager.getSession(childDefaultId);
    assert.equal(inheritedChild.model, primary);

    const updatedStatus = await tool_set_session_child_model({ model: secondary }, { sessionId: parentSessionId, session: parent });
    assert.match(String(updatedStatus), /child default model updated/i);
    const updatedParent = await sessionManager.getSession(parentSessionId);
    assert.equal(updatedParent.childModelDefault, secondary);

    await tool_create_child_session({ suffix: 'child_override', fork: false }, { sessionId: parentSessionId, session: updatedParent });
    const overriddenChild = await sessionManager.getSession(childOverrideId);
    assert.equal(overriddenChild.model, secondary);

    const createdSessionName = makeId('child_model_spawned');
      const createdSessionId = createdSessionName;
    try {
      await tool_create_session({ agentName: 'main', sessionName: createdSessionName }, { sessionId: parentSessionId, session: updatedParent });
      const createdSession = await sessionManager.getSession(createdSessionId);
      assert.equal(createdSession.model, secondary);
      await sessionManager.deleteSession(createdSessionId).catch(() => {});
    } catch (error) {
      await sessionManager.deleteSession(createdSessionId).catch(() => {});
      throw error;
    }

    const clearedStatus = await tool_set_session_child_model({ clear: true }, { sessionId: parentSessionId, session: updatedParent });
    assert.match(String(clearedStatus), /child default model cleared/i);
    const clearedParent = await sessionManager.getSession(parentSessionId);
    assert.equal(clearedParent.childModelDefault, undefined);

    await tool_create_child_session({ suffix: 'child_cleared', fork: false }, { sessionId: parentSessionId, session: clearedParent });
    const clearedChild = await sessionManager.getSession(childClearedId);
    assert.equal(clearedChild.model, primary);
  } finally {
    for (const id of [childDefaultId, childOverrideId, childClearedId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('create_child_session defaults to non-fork when fork is omitted', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const parentSessionId = makeId('child_default_nonfork_parent');
  const childSessionId = `${parentSessionId}_implicit_default`;

  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.history = [
      {
        role: 'user',
        parts: [{ text: 'parent-only history' }],
      },
    ];
    await sessionManager.saveSession(parentSessionId);

    const result = await tool_create_child_session(
      { suffix: 'implicit_default' },
      { sessionId: parentSessionId, session: parent },
    );

    assert.match(String(result), /new session/i);

    const child = await sessionManager.getSession(childSessionId);
    assert.equal(child.model, primary);
    assert.equal(child.history.length, 1);
    assert.equal(child.history[0]?.role, 'user');
    assert.match(String(child.history[0]?.parts?.[0]?.system || ''), /new, empty context/i);
    assert.doesNotMatch(JSON.stringify(child.history), /parent-only history/);
  } finally {
    await sessionManager.deleteSession(childSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
  }
});

test('forked child sessions append inherited tool responses as tool-role messages', async () => {
  await sessionManager.loadSessions();
  const parentSessionId = makeId('fork_tool_role_parent');
  const childSessionId = `${parentSessionId}_forked`;

  try {
    const parent = await ensureSession(parentSessionId);
    parent.history = [
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'call_create_child', name: 'create_child_session', args: { suffix: 'forked' } } },
          { functionCall: { id: 'call_other', name: 'read', args: { filePath: 'MEMORY.md' } } },
        ],
      },
    ];
    await sessionManager.saveSession(parentSessionId);

    await sessionManager.createChildSession(parentSessionId, 'forked', true);
    const child = await sessionManager.getSession(childSessionId);

    const appendedToolMessage = child.history.find((message, index) => index > 0 && message.role === 'tool');
    assert.ok(appendedToolMessage, 'expected forked child history to include appended tool response message');
    assert.deepEqual(
      appendedToolMessage?.parts.map(part => part.functionResponse?.response?.output),
      [
        `Child session created: ${childSessionId}`,
        'Pending execution in parent session',
      ],
    );
  } finally {
    await sessionManager.deleteSession(childSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
  }
});
