import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelConfig } from '../config';
import * as sessionManager from '../sessionManager';
import type { Session } from '../types';
import {
  tool_set_session_child_model,
  tool_set_session_compact_threshold,
  tool_update_session_snapshot,
} from './settings';

const sessionManagerModule = require('../sessionManager') as typeof import('../sessionManager');
const sessionRuntimeModule = require('../sessionRuntime') as typeof import('../sessionRuntime');

function createDetachedSession(id: string): Session {
  const { currentKey } = resolveModelConfig(undefined);
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: 'stale snapshot',
    systemPromptFiles: [],
    model: currentKey,
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

test('own-session settings and snapshot use the detached owner and one persist hook', async () => {
  const session = createDetachedSession(`detached_settings_${Date.now()}`);
  let persistCount = 0;
  const ctx: any = {
    sessionId: session.id,
    session,
    persistCurrentSession: async () => { persistCount += 1; },
  };
  const originals = {
    runtimeGet: sessionRuntimeModule.getSession,
    runtimeUpdate: sessionRuntimeModule.updateSettings,
    managerGet: sessionManagerModule.getSession,
    managerExisting: sessionManagerModule.getExistingSession,
    managerSave: sessionManagerModule.saveSession,
    managerRefresh: sessionManagerModule.refreshSessionSnapshot,
  };
  const forbidden = async () => { throw new Error('global settings/session path must not be used'); };
  sessionRuntimeModule.getSession = forbidden;
  sessionRuntimeModule.updateSettings = forbidden;
  sessionManagerModule.getSession = forbidden;
  sessionManagerModule.getExistingSession = forbidden;
  sessionManagerModule.saveSession = forbidden;
  sessionManagerModule.refreshSessionSnapshot = forbidden;

  try {
    const initialEffective = sessionManager.getEffectiveCompactThresholdTokens(session);
    assert.equal(await tool_set_session_compact_threshold({}, ctx),
      `Session \`${session.id}\` compact threshold status:\noverride: inherit global default\neffective: ${initialEffective} tokens`);
    assert.equal(persistCount, 0);

    assert.equal(await tool_set_session_compact_threshold({ thresholdTokens: 12345.9 }, ctx),
      `Session \`${session.id}\` compact threshold updated.\noverride: 12345 tokens\neffective: 12345 tokens`);
    assert.equal(session.compactThresholdTokens, 12345);
    assert.equal(persistCount, 1);
    await tool_set_session_compact_threshold({ thresholdTokens: 12345.9 }, ctx);
    assert.equal(persistCount, 1);
    assert.equal(await tool_set_session_compact_threshold({}, ctx),
      `Session \`${session.id}\` compact threshold status:\noverride: 12345 tokens\neffective: 12345 tokens`);
    assert.equal(persistCount, 1);
    assert.equal(await tool_set_session_compact_threshold({ clear: true }, ctx),
      `Session \`${session.id}\` compact threshold cleared.\nNow inheriting default auto-compact threshold: ${initialEffective} tokens.`);
    assert.equal(session.compactThresholdTokens, undefined);
    assert.equal(persistCount, 2);
    await tool_set_session_compact_threshold({ clear: true }, ctx);
    assert.equal(persistCount, 2);
    assert.match(await tool_set_session_compact_threshold({ thresholdTokens: 0.9 }, ctx), /override: 0 tokens/);
    assert.equal(session.compactThresholdTokens, 0);
    assert.equal(persistCount, 3);
    await tool_set_session_compact_threshold({ thresholdTokens: 0.9 }, ctx);
    assert.equal(persistCount, 3);
    await tool_set_session_compact_threshold({ clear: true }, ctx);
    assert.equal(persistCount, 4);

    const { currentKey } = resolveModelConfig(session.model);
    assert.equal(await tool_set_session_child_model({}, ctx),
      `Session \`${session.id}\` child default model status:\noverride: inherit current session model\ncurrent session model: \`${currentKey}\`\neffective spawned-session model: \`${currentKey}\``);
    assert.equal(persistCount, 4);
    assert.equal(await tool_set_session_child_model({ model: currentKey }, ctx),
      `Session \`${session.id}\` child default model updated.\noverride: \`${currentKey}\`\neffective spawned-session model: \`${currentKey}\``);
    assert.equal(session.childModelDefault, currentKey);
    assert.equal(persistCount, 5);
    await tool_set_session_child_model({ model: currentKey }, ctx);
    assert.equal(persistCount, 5);
    assert.equal(await tool_set_session_child_model({}, ctx),
      `Session \`${session.id}\` child default model status:\noverride: \`${currentKey}\`\ncurrent session model: \`${currentKey}\`\neffective spawned-session model: \`${currentKey}\``);
    assert.equal(persistCount, 5);
    assert.equal(await tool_set_session_child_model({ clear: true }, ctx),
      `Session \`${session.id}\` child default model cleared.\nNow inheriting the current session model path (effective spawn model: \`${currentKey}\`).`);
    assert.equal(session.childModelDefault, undefined);
    assert.equal(persistCount, 6);
    await tool_set_session_child_model({ clear: true }, ctx);
    assert.equal(persistCount, 6);
    session.childModelDefault = '   ';
    await tool_set_session_child_model({ clear: true }, ctx);
    assert.equal(session.childModelDefault, undefined);
    assert.equal(persistCount, 6);

    assert.equal(await tool_update_session_snapshot({}, ctx),
      `Session \`${session.id}\` snapshot updated.\nAgent: \`main\``);
    assert.notEqual(session.persistentMemorySnapshot, 'stale snapshot');
    assert.equal(persistCount, 7);
  } finally {
    sessionRuntimeModule.getSession = originals.runtimeGet;
    sessionRuntimeModule.updateSettings = originals.runtimeUpdate;
    sessionManagerModule.getSession = originals.managerGet;
    sessionManagerModule.getExistingSession = originals.managerExisting;
    sessionManagerModule.saveSession = originals.managerSave;
    sessionManagerModule.refreshSessionSnapshot = originals.managerRefresh;
  }
});

test('detached settings skip a failing persist hook for no-ops and call it once for changes', async () => {
  const session = createDetachedSession(`detached_settings_noop_${Date.now()}`);
  const { currentKey } = resolveModelConfig(session.model);
  session.compactThresholdTokens = 40000;
  session.childModelDefault = currentKey;
  let attempts = 0;
  const ctx: any = {
    sessionId: session.id,
    session,
    persistCurrentSession: async () => {
      attempts += 1;
      throw new Error('persist failed');
    },
  };

  assert.match(await tool_set_session_compact_threshold({ thresholdTokens: 40000.8 }, ctx), /updated/);
  assert.match(await tool_set_session_child_model({ model: currentKey }, ctx), /updated/);
  assert.equal(attempts, 0);
  await assert.rejects(() => tool_set_session_child_model({ model: 'missing-provider/missing-model' }, ctx), /not configured|unknown/i);
  assert.equal(session.childModelDefault, currentKey);
  assert.equal(attempts, 0);

  await assert.rejects(() => tool_set_session_compact_threshold({ thresholdTokens: 40001 }, ctx), /persist failed/);
  assert.equal(attempts, 1);
  await assert.rejects(() => tool_set_session_child_model({ clear: true }, ctx), /persist failed/);
  assert.equal(attempts, 2);
});

test('other, no-hook, and mismatched settings targets retain legacy service routing', async () => {
  await sessionManager.loadSessions();
  const owner = createDetachedSession(`detached_owner_${Date.now()}`);
  const targetId = `${owner.id}_target`;
  const target = await sessionManager.getSession(targetId);
  Object.assign(target, createDetachedSession(targetId));
  await sessionManager.saveSession(targetId);
  let persistCount = 0;
  const { currentKey } = resolveModelConfig(target.model);

  try {
    assert.match(await tool_set_session_compact_threshold({}, { sessionId: targetId } as any), /compact threshold status/);

    await tool_set_session_child_model({ sessionId: targetId, model: currentKey }, {
      sessionId: owner.id,
      session: owner,
      persistCurrentSession: async () => { persistCount += 1; },
    } as any);
    assert.equal((await sessionManager.getSession(targetId)).childModelDefault, currentKey);

    const beforeThreshold = owner.compactThresholdTokens;
    await tool_set_session_compact_threshold({ sessionId: targetId, thresholdTokens: 22222 }, {
      sessionId: targetId,
      session: owner,
      persistCurrentSession: async () => { persistCount += 1; },
    } as any);
    assert.equal(owner.compactThresholdTokens, beforeThreshold);
    assert.equal((await sessionManager.getSession(targetId)).compactThresholdTokens, 22222);

    const beforeSnapshot = owner.persistentMemorySnapshot;
    assert.equal(await tool_update_session_snapshot({ sessionId: targetId }, {
      sessionId: targetId,
      session: owner,
      persistCurrentSession: async () => { persistCount += 1; },
    } as any), `Session \`${targetId}\` snapshot updated.\nAgent: \`main\``);
    assert.equal(owner.persistentMemorySnapshot, beforeSnapshot);
    assert.notEqual((await sessionManager.getSession(targetId)).persistentMemorySnapshot, 'stale snapshot');
    assert.equal(persistCount, 0);
  } finally {
    await sessionManager.deleteSession(targetId).catch(() => {});
  }
});
