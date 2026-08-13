import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from './types';
import {
  buildSessionRuntimeState,
  clearSessionCatalogStub,
  clearActiveSessionRuntimeState,
  formatSessionRuntimeStateSummary,
  getEffectiveSessionQueueLength,
  markSessionCatalogStub,
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

test('catalog stub queue count is effective until exact authority hydration wins', () => {
  const session = makeSession({ queue: [{ type: 'background', parts: [{ text: 'actual' }] }] } as Partial<Session>);
  markSessionCatalogStub(session, 3);
  assert.equal(getEffectiveSessionQueueLength(session), 3);
  const stubState = buildSessionRuntimeState(session);
  assert.equal(stubState.queueLength, 3);
  assert.equal(stubState.state, 'idle');
  assert.equal(stubState.busy, false);
  clearSessionCatalogStub(session);
  assert.equal(getEffectiveSessionQueueLength(session), 1);
  const hydratedState = buildSessionRuntimeState(session);
  assert.equal(hydratedState.queueLength, 1);
  assert.equal(hydratedState.state, 'idle');
  assert.equal(hydratedState.busy, false);
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

test('active tool presentation normalizes invalid previews without weakening projection types', () => {
  const session = makeSession({ busy: true });
  try {
    setActiveSessionRuntimeState(session.id, {
      state: 'running-tool',
      tool: { name: 'set_goal', argsPreview: true as any, startedAt: 1000 },
    });
    assert.equal(buildSessionRuntimeState(session).tool?.argsPreview, 'true');

    setActiveSessionRuntimeState(session.id, {
      state: 'running-tool',
      tool: { name: 'set_goal', argsPreview: 'x'.repeat(5000), startedAt: 1000 },
    });
    const bounded = buildSessionRuntimeState(session).tool?.argsPreview;
    assert.equal(typeof bounded, 'string');
    assert.equal(bounded?.length, 4096);
    assert.match(bounded || '', /…$/);
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

test('bare and reason-only waits derive idle while explicit waits derive waiting states', () => {
  const generic = makeSession({
    meta: { lastMessageTime: Date.now(), wait: { id: 'generic-wait', startedAt: 2000 } },
  } as Partial<Session>);
  const genericRuntime = buildSessionRuntimeState(generic);
  assert.equal(genericRuntime.state, 'idle');
  assert.equal(genericRuntime.waiting, undefined);
  assert.equal(formatSessionRuntimeStateSummary(genericRuntime), 'idle');

  const reasonOnlyWait = makeSession({
    meta: { lastMessageTime: Date.now(), wait: { id: 'reason-only-wait', startedAt: 2500, reason: 'waiting for operator' } },
  } as Partial<Session>);
  const reasonOnlyRuntime = buildSessionRuntimeState(reasonOnlyWait);
  assert.equal(reasonOnlyRuntime.state, 'idle');
  assert.equal(reasonOnlyRuntime.waiting, undefined);
  assert.equal(formatSessionRuntimeStateSummary(reasonOnlyRuntime), 'idle');

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
