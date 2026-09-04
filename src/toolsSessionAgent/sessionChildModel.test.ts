import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import * as sessionManager from '../sessionManager';
import { getAgentDir, loadModelsConfigFromObject, resolveModelConfig } from '../config';
import { tool_create_child_session as rawToolCreateChildSession, tool_create_session, tool_set_session_child_model } from '../toolsSessionAgent';
import { Session } from '../types';
import { buildSessionModelEffortPresentation } from '../session/modelEffortPresentation';
import { INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX } from '../toolCallControls';

const TEST_CONFIRMATION = `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\nThis test child creation was checked for necessity, accuracy, self-containment, scope, and communication rules.\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`;
const tool_create_child_session: typeof rawToolCreateChildSession = (args, ctx) => rawToolCreateChildSession({ ...args, confirmation: TEST_CONFIRMATION }, ctx);

const PROMPT_CACHE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

test('create_session tool accepts intentional model and effort overrides', async () => {
  await sessionManager.loadSessions();
  const { primary, secondary } = getTestModels();
  const parentSessionId = makeId('create_session_model_parent');
  const sessionName = makeId('created_session_model');
  const createdSessionId = sessionName;

  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.effort = 'none';
    await sessionManager.saveSession(parent.id);
    const result = await tool_create_session({
      agentName: 'main',
      sessionName,
      forceModel: { modelId: secondary, effort: 'max' },
    }, { sessionId: parentSessionId, session: parent });

    assert.match(String(result), /Model:/);
    assert.match(String(result), /Effort: raw=max, effective=max/);
    const created = await sessionManager.getSession(createdSessionId);
    assert.equal(created.model, secondary);
    assert.equal(created.effort, 'max');
  } finally {
    await sessionManager.deleteSession(createdSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
  }
});

test('creation forceModel supports empty, model-only, and effort-only overrides and rejects the old contract before effects', async () => {
  await sessionManager.loadSessions();
  const { primary, secondary } = getTestModels();
  const parentSessionId = makeId('force_model_parent');
  const childIds = ['empty', 'model', 'effort', 'old', 'invalid', 'unknown'].map(suffix => `${parentSessionId}_${suffix}`);
  const unknownSessionName = makeId('force_model_unknown_session');
  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.effort = 'low';
    await sessionManager.saveSession(parent.id);

    await tool_create_child_session({ suffix: 'empty', forceModel: {} }, { sessionId: parent.id, session: parent });
    assert.equal((await sessionManager.getSession(childIds[0])).model, primary);
    assert.equal((await sessionManager.getSession(childIds[0])).effort, 'low');

    await tool_create_child_session({ suffix: 'model', forceModel: { modelId: secondary } }, { sessionId: parent.id, session: parent });
    assert.equal((await sessionManager.getSession(childIds[1])).model, secondary);

    await tool_create_child_session({ suffix: 'effort', forceModel: { effort: 'max' } }, { sessionId: parent.id, session: parent });
    assert.equal((await sessionManager.getSession(childIds[2])).model, primary);
    assert.equal((await sessionManager.getSession(childIds[2])).effort, 'max');

    await assert.rejects(
      () => tool_create_child_session({ suffix: 'old', model: secondary }, { sessionId: parent.id, session: parent }),
      /no longer accepts top-level model or effort/,
    );
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'invalid', forceModel: { unknown: true } }, { sessionId: parent.id, session: parent }),
      /accepts only modelId and effort/,
    );
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'unknown', bogus: true }, { sessionId: parent.id, session: parent }),
      /unknown key: bogus/,
    );
    await assert.rejects(
      () => tool_create_session({ agentName: 'main', sessionName: unknownSessionName, bogus: true }, { sessionId: parent.id, session: parent }),
      /unknown key: bogus/,
    );
    assert.equal(sessionManager.getAllSessions().has(childIds[3]), false);
    assert.equal(sessionManager.getAllSessions().has(childIds[4]), false);
    assert.equal(sessionManager.getAllSessions().has(childIds[5]), false);
    assert.equal(sessionManager.getAllSessions().has(unknownSessionName), false);
  } finally {
    for (const id of [...childIds, unknownSessionName, parentSessionId]) await sessionManager.deleteSession(id).catch(() => {});
  }
});

test('agent main-session creation inherits raw current and future-child effort settings from its exact source', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const parentSessionId = makeId('create_agent_effort_parent');
  const agentName = makeId('effort_agent');
  const mainSessionId = `${agentName}/main`;
  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.effort = 'none';
    parent.childModelDefault = primary;
    parent.childEffortDefault = 'max';
    await sessionManager.saveSession(parent.id);
    await sessionManager.createAgentWithMainSession({
      agentName,
      sourceSessionId: parent.id,
      sourceSessionOverride: parent,
    });
    const created = await sessionManager.getSession(mainSessionId);
    assert.equal(created.model, primary);
    assert.equal(created.effort, 'none');
    assert.equal(created.childModelDefault, primary);
    assert.equal(created.childEffortDefault, 'max');
  } finally {
    await sessionManager.deleteSession(mainSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
    await fs.remove(getAgentDir(agentName)).catch(() => {});
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

test('forked and non-fork children resolve one current model/effort pair without copying future-child defaults', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const parentSessionId = makeId('child_effort_parent');
  const inheritedId = `${parentSessionId}_inherited`;
  const explicitId = `${parentSessionId}_explicit`;
  const forkedId = `${parentSessionId}_forked`;
  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.effort = 'low';
    parent.childEffortDefault = 'max';
    await sessionManager.saveSession(parent.id);

    await sessionManager.createChildSession(parent.id, 'inherited', false, { sourceOverride: parent });
    const inherited = await sessionManager.getSession(inheritedId);
    assert.equal(inherited.effort, 'max');
    assert.equal(inherited.model, primary);
    assert.equal(inherited.childModelDefault, undefined);
    assert.equal(inherited.childEffortDefault, undefined);

    await sessionManager.createChildSession(parent.id, 'explicit', false, { effort: 'none', sourceOverride: parent });
    assert.equal((await sessionManager.getSession(explicitId)).effort, 'none');

    await sessionManager.createChildSession(parent.id, 'forked', true, { sourceOverride: parent });
    const forked = await sessionManager.getSession(forkedId);
    assert.equal(forked.effort, 'max');
    assert.equal(forked.model, primary);
    assert.equal(forked.childModelDefault, undefined);
    assert.equal(forked.childEffortDefault, undefined);

    delete parent.childEffortDefault;
    assert.equal(sessionManager.resolveSpawnedSessionEffort(parent), 'low');
    delete parent.effort;
    assert.equal(sessionManager.resolveSpawnedSessionEffort(parent), undefined);
  } finally {
    for (const id of [inheritedId, explicitId, forkedId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('unset effort remains unset for local new/fork children and a virtual route does not materialize a leaf default', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const parentSessionId = makeId('child_unset_effort_parent');
  const newChildId = `${parentSessionId}_new`;
  const forkChildId = `${parentSessionId}_fork`;
  try {
    const parent = await ensureSession(parentSessionId, primary);
    delete parent.effort;
    delete parent.childEffortDefault;
    await sessionManager.saveSession(parent.id);
    await sessionManager.createChildSession(parent.id, 'new', false, { sourceOverride: parent });
    await sessionManager.createChildSession(parent.id, 'fork', true, { sourceOverride: parent });
    for (const id of [newChildId, forkChildId]) {
      const child = await sessionManager.getSession(id);
      assert.equal(child.effort, undefined);
      assert.equal(child.childEffortDefault, undefined);
    }

    const virtualConfig = loadModelsConfigFromObject({
      default: 'route',
      providers: {
        leaf: {
          providerType: 'anthropic',
          effort: { allowed: ['medium', 'max'], default: 'max' },
          models: ['one'],
        },
        fallback: {
          providerType: 'openai-completions',
          effort: { allowed: ['low', 'high'], default: 'high' },
          models: ['two'],
        },
        route: { providerType: 'failover', targets: ['leaf/one', 'fallback/two'] },
      },
    });
    assert.deepEqual(
      sessionManager.resolveSpawnedSessionModelEffort({ model: 'route' }, undefined, undefined, virtualConfig),
      { model: 'route', effort: undefined },
    );
  } finally {
    for (const id of [newChildId, forkChildId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('child current settings use distinct parent child defaults while the child future defaults follow its current pair', async () => {
  await sessionManager.loadSessions();
  const { primary, secondary } = getTestModels();
  const parentSessionId = makeId('child_distinct_defaults_parent');
  const newChildId = `${parentSessionId}_new`;
  const forkChildId = `${parentSessionId}_fork`;
  try {
    const parent = await ensureSession(parentSessionId, primary);
    parent.effort = 'low';
    parent.childModelDefault = secondary;
    parent.childEffortDefault = 'max';
    await sessionManager.saveSession(parent.id);

    await sessionManager.createChildSession(parent.id, 'new', false, { sourceOverride: parent });
    await sessionManager.createChildSession(parent.id, 'fork', true, { sourceOverride: parent });
    for (const id of [newChildId, forkChildId]) {
      const child = await sessionManager.getSession(id);
      assert.equal(child.model, secondary);
      assert.equal(child.effort, 'max');
      assert.equal(child.childModelDefault, undefined);
      assert.equal(child.childEffortDefault, undefined);
      const presentation = buildSessionModelEffortPresentation(child);
      assert.equal(presentation.effectiveChildModelKey, secondary);
      const childAllowed = presentation.childEffort.allowed;
      assert.equal(
        presentation.childEffort.effective,
        childAllowed.includes('max') ? 'max' : presentation.childEffort.defaultEffort || 'default',
      );
    }
  } finally {
    for (const id of [newChildId, forkChildId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('create_child_session replaces main leaf for agent-qualified parents', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const agentName = makeId('child_main_agent');
  const agentMainId = `${agentName}/main`;
  const agentChildId = `${agentName}/task1`;

  try {
    const agentMain = await ensureSession(agentMainId, primary);
    agentMain.agent = agentName;
    await sessionManager.saveSession(agentMainId);

    await tool_create_child_session({ suffix: 'task1', fork: false }, { sessionId: agentMainId, session: agentMain });
    const agentChild = await sessionManager.getSession(agentChildId);
    assert.equal(agentChild.parentSessionId, agentMainId);
    assert.equal(agentChild.agent, agentName);
  } finally {
    for (const id of [agentChildId, agentMainId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('child session id builder handles bare main and non-main parents', () => {
  assert.equal(sessionManager.buildChildSessionId('main', 'task1'), 'task1');
  assert.equal(sessionManager.buildChildSessionId('agent/main', 'task1'), 'agent/task1');
  assert.equal(sessionManager.buildChildSessionId('agent/worker', 'task1'), 'agent/worker_task1');
  assert.equal(sessionManager.buildChildSessionId('worker', 'task1'), 'worker_task1');
});

test('create_child_session from bare main uses suffix as child id', async () => {
  await sessionManager.loadSessions();
  const { primary } = getTestModels();
  const suffix = makeId('bare_main_child');
  const childSessionId = suffix;
  const existingMain = await sessionManager.getExistingSession('main');
  const parent = existingMain || await ensureSession('main', primary);

  try {
    await tool_create_child_session({ suffix, fork: false }, { sessionId: 'main', session: parent });
    const child = await sessionManager.getSession(childSessionId);
    assert.equal(child.parentSessionId, 'main');
  } finally {
    await sessionManager.deleteSession(childSessionId).catch(() => {});
    if (!existingMain) {
      await sessionManager.deleteSession('main').catch(() => {});
    }
  }
});

test('forked create_child_session also replaces main leaf and preserves collision handling', async () => {
  await sessionManager.loadSessions();
  const agentName = makeId('fork_main_agent');
  const parentSessionId = `${agentName}/main`;
  const firstChildId = `${agentName}/research`;
  const collisionChildId = `${firstChildId}_2`;

  try {
    const parent = await ensureSession(parentSessionId);
    parent.agent = agentName;
    await sessionManager.saveSession(parentSessionId);

    await sessionManager.createChildSession(parentSessionId, 'research', true);
    await sessionManager.createChildSession(parentSessionId, 'research', true);

    const firstChild = await sessionManager.getSession(firstChildId);
    const collisionChild = await sessionManager.getSession(collisionChildId);
    assert.equal(firstChild.parentSessionId, parentSessionId);
    assert.equal(collisionChild.parentSessionId, parentSessionId);
  } finally {
    for (const id of [collisionChildId, firstChildId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
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
          { functionCall: { id: 'call_create_child', name: 'create_child_session', args: { suffix: 'forked', confirmation: TEST_CONFIRMATION } } },
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

test('prompt cache keys follow prefix lineage for new and forked children', async () => {
  await sessionManager.loadSessions();
  const parentSessionId = makeId('prompt_cache_parent');
  const newChildId = `${parentSessionId}_new_child`;
  const forkedChildId = `${parentSessionId}_forked_child`;

  try {
    const parent = await ensureSession(parentSessionId);
    parent.promptCacheKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    parent.history = [{ role: 'user', parts: [{ text: 'parent history' }] }];
    await sessionManager.saveSession(parentSessionId);

    await sessionManager.createChildSession(parentSessionId, 'new_child', false);
    await sessionManager.createChildSession(parentSessionId, 'forked_child', true);

    const newChild = await sessionManager.getSession(newChildId);
    const forkedChild = await sessionManager.getSession(forkedChildId);
    assert.match(newChild.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.notEqual(newChild.promptCacheKey, parent.promptCacheKey);
    assert.equal(forkedChild.promptCacheKey, parent.promptCacheKey);
  } finally {
    for (const id of [newChildId, forkedChildId, parentSessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});

test('createSessionInAgent starts a fresh prompt cache key even when parentSessionId is provided', async () => {
  await sessionManager.loadSessions();
  const parentSessionId = makeId('prompt_cache_create_session_parent');
  const sessionName = makeId('prompt_cache_created_child');
  const createdSessionId = sessionName;

  try {
    const parent = await ensureSession(parentSessionId);
    parent.promptCacheKey = '12345678-1234-1234-1234-123456789abc';
    await sessionManager.saveSession(parentSessionId);

    await sessionManager.createSessionInAgent({
      agentName: 'main',
      sessionName,
      parentSessionId,
    });

    const created = await sessionManager.getSession(createdSessionId);
    assert.match(created.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.notEqual(created.promptCacheKey, parent.promptCacheKey);
  } finally {
    await sessionManager.deleteSession(createdSessionId).catch(() => {});
    await sessionManager.deleteSession(parentSessionId).catch(() => {});
  }
});

test('clearing a session rotates the prompt cache key for the new empty prefix', async () => {
  await sessionManager.loadSessions();
  const sessionId = makeId('prompt_cache_clear');

  try {
    const session = await ensureSession(sessionId);
    session.promptCacheKey = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    session.history = [{ role: 'user', parts: [{ text: 'old prefix' }] }];
    await sessionManager.saveSession(sessionId);

    await sessionManager.clearSession(sessionId);

    const cleared = await sessionManager.getSession(sessionId);
    assert.deepEqual(cleared.history, []);
    assert.match(cleared.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.notEqual(cleared.promptCacheKey, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('independent new sessions get different prompt cache keys and persist legacy migration', async () => {
  await sessionManager.loadSessions();
  const firstSessionId = makeId('prompt_cache_independent_a');
  const secondSessionId = makeId('prompt_cache_independent_b');
  const legacySessionId = makeId('prompt_cache_legacy');

  try {
    const first = await sessionManager.createEmptySession(firstSessionId);
    const second = await sessionManager.createEmptySession(secondSessionId);
    assert.match(first.session.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.match(second.session.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.notEqual(first.session.promptCacheKey, second.session.promptCacheKey);

    await sessionManager.createSession(legacySessionId, {
      id: legacySessionId,
      agent: 'main',
      history: [],
      persistentMemorySnapshot: '',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      currentNode: 'master',
    } as Session);
    const migratedLegacy = await sessionManager.getSession(legacySessionId);
    assert.match(migratedLegacy.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);

    const reloadedLegacy = await sessionManager.getSession(legacySessionId);
    assert.equal(reloadedLegacy.promptCacheKey, migratedLegacy.promptCacheKey);
  } finally {
    for (const id of [firstSessionId, secondSessionId, legacySessionId]) {
      await sessionManager.deleteSession(id).catch(() => {});
    }
  }
});
