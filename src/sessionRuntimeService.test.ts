import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
} from './rpc';
import * as sessionManager from './sessionManager';
import * as vector from './vector';
import {
  createSessionRuntimeServiceHandler,
  sessionRuntimeServiceDescriptor,
} from './sessionRuntimeService';
import type { Message, SessionStreamEvent } from './types';
import {
  assertSessionWorkerPlacementSupported,
  getSessionRuntimeStatus,
  initializeSessionRuntime,
  shutdownSessionRuntime,
  startEvents,
  subscribe,
} from './sessionRuntime';

function makeSessionId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createLocalClient() {
  const registry = new RpcServiceRegistry();
  registry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler());
  const transport = new LocalRpcTransport(registry);
  return {
    transport,
    client: new RpcClient(sessionRuntimeServiceDescriptor, transport),
  };
}

const flushEvents = () => new Promise<void>(resolve => setImmediate(resolve));

test('session worker placement fails explicitly until child placement exists', () => {
  assert.doesNotThrow(() => assertSessionWorkerPlacementSupported(false));
  assert.throws(
    () => assertSessionWorkerPlacementSupported(true),
    (error: any) => error instanceof RpcError && error.code === 'SESSION_WORKERS_NOT_IMPLEMENTED',
  );
});

test('local SessionRuntime DTO seam clones projections and preserves event order', async () => {
  const originalScheduleIndex = vector.scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async (): Promise<void> => {};
  await sessionManager.loadSessions();
  const sessionId = makeSessionId('session_runtime_contract');
  const { session } = await sessionManager.createEmptySession(sessionId);
  const { transport, client } = createLocalClient();
  const events: Array<{ name: string; payload: any; sequence: number }> = [];
  const unsubscribe = client.subscribe((name, payload: any, meta) => {
    events.push({ name, payload, sequence: meta.sequence });
    if (name === 'history') {
      payload.message.parts[0].text = 'caller-mutated-event';
    }
  });

  try {
    const started = await client.call('startEvents', {});
    assert.equal(started.started, true);

    const first = await client.call('getSession', { sessionId });
    assert.ok(first.session);
    first.session!.aliases.push('caller-only-alias');
    first.session!.runtimeState.queueLength = 999;
    const second = await client.call('getSession', { sessionId });
    assert.deepEqual(second.session!.aliases, []);
    assert.equal(second.session!.runtimeState.queueLength, 0);

    events.length = 0;
    const settings = await client.call('updateSettings', {
      sessionId,
      patch: {
        cwd: '/tmp/runtime-cwd',
        model: 'provider/model',
        childModelDefault: 'provider/child',
        currentNode: 'node-a',
        displayName: 'Runtime DTO',
        compactThresholdTokens: 4321.9,
      },
    });
    assert.deepEqual(settings.changed, ['cwd', 'model', 'childModelDefault', 'currentNode', 'displayName', 'compactThresholdTokens']);
    assert.equal(settings.previous.cwd, null);
    assert.equal(settings.current.cwd, '/tmp/runtime-cwd');
    assert.equal(settings.current.compactThresholdTokens, 4321);
    settings.session.displayName = 'caller-only-name';
    await flushEvents();
    assert.deepEqual(events.map(event => event.name), ['listChanged', 'stateChanged']);
    assert.ok(events[1].sequence > events[0].sequence);
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'Runtime DTO');
    await assert.rejects(
      client.call('updateSettings', {
        sessionId,
        patch: { displayName: 'must-not-apply', unknownSetting: true } as any,
      }),
      (error: any) => error instanceof RpcError && error.code === 'SESSION_RUNTIME_INVALID_SETTING',
    );
    assert.equal((await sessionManager.getExistingSession(sessionId))?.displayName, 'Runtime DTO');

    events.length = 0;
    await client.call('enqueue', {
      sessionId,
      item: { type: 'background', parts: [{ text: 'queued-through-runtime' }] },
    });
    await flushEvents();
    assert.deepEqual(events.map(event => event.name), ['listChanged', 'stateChanged']);

    const historyBefore = await client.call('getHistory', { sessionId });
    assert.ok(historyBefore);
    assert.equal(historyBefore!.queue.length, 1);
    historyBefore!.queue[0].parts![0].text = 'caller-mutated-queue';
    const historyAfter = await client.call('getHistory', { sessionId });
    assert.equal(historyAfter!.queue[0].parts![0].text, 'queued-through-runtime');

    session.busy = true;
    await sessionManager.saveSession(sessionId);
    assert.deepEqual(await client.call('control', { sessionId, action: 'dequeue' }), {
      action: 'dequeue',
      queuedItems: 1,
      stoppedCurrent: true,
      abortedInFlight: false,
    });
    assert.equal(session.meta.runQueuedAfterStop, true);
    session.busy = false;
    session.stopping = false;
    session.meta.runQueuedAfterStop = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);

    let retryCount = 0;
    sessionManager.setSessionRetryCallback(async (retrySessionId) => {
      if (retrySessionId === sessionId) retryCount += 1;
    });
    assert.deepEqual(await client.call('control', { sessionId, action: 'retry' }), { action: 'retry' });
    assert.equal(retryCount, 1);

    session.busy = true;
    await client.call('queueEvent', { sessionId, text: 'runtime-trigger-event', type: 'trigger' });
    assert.equal(session.queue[0].type, 'trigger');
    assert.match(String(session.queue[0].parts?.[0]?.system), /runtime-trigger-event/);
    session.busy = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);

    const message: Message = { role: 'user', parts: [{ text: 'canonical-history' }] };
    events.length = 0;
    await sessionManager.appendSessionMessage(session, message);
    sessionManager.notifySessionEvent(sessionId, {
      type: 'model-stream-update',
      data: { text: 'delta' },
    } as SessionStreamEvent);
    await flushEvents();
    const historyIndex = events.findIndex(event => event.name === 'history');
    const streamIndex = events.findIndex(event => event.name === 'stream');
    assert.ok(historyIndex >= 0 && streamIndex > historyIndex, 'history and stream events preserve publication order');
    assert.ok(events[streamIndex].sequence > events[historyIndex].sequence);
    assert.equal(session.history.at(-1)?.parts[0].text, 'canonical-history');

    session.busy = true;
    const controller = new AbortController();
    sessionManager.registerSessionAbortController(sessionId, controller);
    const stopped = await client.call('control', { sessionId, action: 'stop' });
    assert.deepEqual(stopped, { action: 'stop', abortedInFlight: true });
    assert.equal(controller.signal.aborted, true);

    await assert.rejects(
      client.call('enqueue', { sessionId, item: { type: 'background', parts: [] } as any }),
      (error: any) => error instanceof RpcError && error.code === 'SESSION_RUNTIME_INVALID_QUEUE_ITEM',
    );
    assert.equal((await client.call('getSession', { sessionId: 'missing-session-runtime-id' })).session, null);

    const stoppedEvents = await client.call('stopEvents', {});
    assert.equal(stoppedEvents.stopped, true);
  } finally {
    unsubscribe();
    transport.close();
    session.busy = false;
    session.stopping = false;
    session.queue = [];
    await sessionManager.deleteSession(sessionId).catch(() => {});
    sessionManager.setOnHistoryUpdated(() => {});
    sessionManager.setOnSessionEventUpdated(() => {});
    sessionManager.setOnSessionListUpdated(() => {});
    sessionManager.setOnSessionStateUpdated(() => {});
    sessionManager.setSessionRetryCallback(async () => {});
    (vector as any).scheduleSessionArchiveIndex = originalScheduleIndex;
  }
});

test('SessionRuntime facade starts event publication and drains locally', async () => {
  await initializeSessionRuntime();
  const unsubscribe = subscribe(() => {});
  try {
    await startEvents();
    assert.deepEqual(getSessionRuntimeStatus(), {
      placement: 'local',
      ready: true,
      eventsStarted: true,
      childPlacementImplemented: false,
    });
  } finally {
    unsubscribe();
    await shutdownSessionRuntime();
  }
  assert.deepEqual(getSessionRuntimeStatus(), {
    placement: 'local',
    ready: false,
    eventsStarted: false,
    childPlacementImplemented: false,
  });
});
