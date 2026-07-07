import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from './types';
import {
  buildSessionRuntimeState,
  clearActiveSessionRuntimeState,
  formatSessionRuntimeStateSummary,
  setActiveSessionRuntimeState,
} from './sessionRuntimeState';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `runtime_state_${Math.random().toString(36).slice(2)}`,
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    ...overrides,
  } as Session;
}

test('buildSessionRuntimeState derives idle by default', () => {
  const session = makeSession();
  const runtimeState = buildSessionRuntimeState(session);
  assert.equal(runtimeState.state, 'idle');
  assert.equal(runtimeState.busy, false);
  assert.equal(runtimeState.queueLength, 0);
  assert.equal(formatSessionRuntimeStateSummary(runtimeState), 'idle');
});

test('active runtime state wins over persisted wait metadata', () => {
  const startedAt = Date.now() - 5000;
  const session = makeSession({
    busy: true,
    queue: [{ type: 'background', parts: [{ text: 'queued' }] }],
    meta: {
      lastMessageTime: Date.now(),
      wait: {
        id: 'wait-active-wins',
        startedAt,
        waitAll: { sessions: ['child-a'], satisfiedSessions: [], deferredQueue: [] },
      },
    },
  } as Partial<Session>);

  try {
    setActiveSessionRuntimeState(session.id, {
      state: 'running-tool',
      since: startedAt + 1000,
      active: { iteration: 2, phase: 'normal-turn' },
      tool: { id: 'call-1', name: 'exec', index: 0, total: 1, executionNode: 'master', startedAt: startedAt + 1000 },
    });

    const runtimeState = buildSessionRuntimeState(session);
    assert.equal(runtimeState.state, 'running-tool');
    assert.equal(runtimeState.busy, true);
    assert.equal(runtimeState.queueLength, 1);
    assert.equal(runtimeState.tool?.name, 'exec');
    assert.equal(runtimeState.waiting, undefined);
    assert.equal(formatSessionRuntimeStateSummary(runtimeState), 'running-tool:exec 1/1');
  } finally {
    clearActiveSessionRuntimeState(session.id);
  }
});

test('buildSessionRuntimeState derives waitAll pending sessions', () => {
  const session = makeSession({
    meta: {
      lastMessageTime: Date.now(),
      wait: {
        id: 'wait-all-runtime',
        startedAt: 1000,
        reason: 'waiting for children',
        timeoutSeconds: 30,
        waitExecIds: ['exec-advisory'],
        waitAll: {
          sessions: ['child-a', 'child-b'],
          satisfiedSessions: ['child-a'],
          deferredQueue: [],
        },
      },
    },
  } as Partial<Session>);

  const runtimeState = buildSessionRuntimeState(session);
  assert.equal(runtimeState.state, 'waiting');
  assert.equal(runtimeState.since, 1000);
  assert.equal(runtimeState.waiting?.waitingFor, 'sessions');
  assert.deepEqual(runtimeState.waiting?.waitExecIds, ['exec-advisory']);
  assert.deepEqual(runtimeState.waiting?.satisfiedSessions, ['child-a']);
  assert.deepEqual(runtimeState.waiting?.pendingSessions, ['child-b']);
  assert.equal(runtimeState.waiting?.timeoutAt, 31_000);
  assert.equal(formatSessionRuntimeStateSummary(runtimeState), 'waiting:sessions 1/2');
});

test('bare wait derives idle while explicit waits derive waiting states', () => {
  const generic = makeSession({
    meta: { lastMessageTime: Date.now(), wait: { id: 'generic-wait', startedAt: 2000 } },
  } as Partial<Session>);
  const genericRuntime = buildSessionRuntimeState(generic);
  assert.equal(genericRuntime.state, 'idle');
  assert.equal(genericRuntime.waiting, undefined);
  assert.equal(formatSessionRuntimeStateSummary(genericRuntime), 'idle');

  const manualWait = makeSession({
    meta: { lastMessageTime: Date.now(), wait: { id: 'manual-wait', startedAt: 2500, reason: 'waiting for operator' } },
  } as Partial<Session>);
  const manualRuntime = buildSessionRuntimeState(manualWait);
  assert.equal(manualRuntime.state, 'waiting');
  assert.equal(manualRuntime.waiting?.waitingFor, 'manual');
  assert.equal(manualRuntime.waiting?.reason, 'waiting for operator');
  assert.equal(formatSessionRuntimeStateSummary(manualRuntime), 'waiting:manual');

  const execWait = makeSession({
    meta: { lastMessageTime: Date.now(), wait: { id: 'exec-wait', startedAt: 3000, waitExecIds: ['exec-1', 'exec-2'] } },
  } as Partial<Session>);
  const execRuntime = buildSessionRuntimeState(execWait);
  assert.equal(execRuntime.state, 'waiting');
  assert.equal(execRuntime.waiting?.waitingFor, 'exec');
  assert.deepEqual(execRuntime.waiting?.waitExecIds, ['exec-1', 'exec-2']);
  assert.equal(formatSessionRuntimeStateSummary(execRuntime), 'waiting:exec 2');
});

test('busy session without transient active state falls back to requesting-model unknown phase', () => {
  const session = makeSession({ busy: true, busyStartedAt: 1234 });
  const runtimeState = buildSessionRuntimeState(session);
  assert.equal(runtimeState.state, 'requesting-model');
  assert.equal(runtimeState.busy, true);
  assert.equal(runtimeState.since, 1234);
  assert.equal(runtimeState.active?.phase, 'unknown');
});
