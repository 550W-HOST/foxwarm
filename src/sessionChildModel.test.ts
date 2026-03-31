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
