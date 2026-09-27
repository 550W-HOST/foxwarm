import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { createSessionWorkerPresentationServiceHandler } from './sessionWorkerPresentationService';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import { LocalRpcTransport, RpcServiceRegistry } from './rpc';
import { sessionWorkerPresentationServiceDescriptor } from './sessionWorkerPresentationService';
import type { Session } from './types';
import { mergeModelStreamDeltaEvents } from './sessionWorkerHost';

test('worker coalescing composes model and tool argument deltas without losing bytes', () => {
  const merged = mergeModelStreamDeltaEvents({
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequenceStart: 1, sequence: 1,
    textDelta: { offset: 0, text: 'hel' },
    toolCallDeltas: [{ index: 0, id: 'c', name: 'exec', argumentsDelta: { offset: 0, text: '{"com' } }],
  }, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequenceStart: 2, sequence: 2,
    textDelta: { offset: 3, text: 'lo' },
    toolCallDeltas: [{ index: 0, argumentsDelta: { offset: 5, text: 'mand":"x"}' } }],
  });
  assert.deepEqual(merged.textDelta, { offset: 0, text: 'hello' });
  assert.equal(merged.sequenceStart, 1);
  assert.equal(merged.sequence, 2);
  assert.deepEqual(merged.toolCallDeltas, [{ index: 0, id: 'c', name: 'exec', argumentsDelta: { offset: 0, text: '{"command":"x"}' } }]);
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Timed out waiting for condition.');
}

function baseSession(id: string): Session {
  return {
    id, agent: 'main', history: [], persistentMemorySnapshot: 'presentation prompt',
    systemPromptFiles: [], snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  } as Session;
}

function makeFixture(root: string, extraEnv: Record<string, string> = {}) {
  const store = new SessionWorkerStore(path.join(root, 'session-runtime.sqlite')); store.open();
  const receivedMessages: any[] = [];
  const receivedBatches: any[] = [];
  const receivedEvents: any[] = [];
  const receivedPresentation: Array<{ kind: 'message' | 'batch' | 'event'; value: any }> = [];
  const readySessions: string[] = [];
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60_000, workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: root, ...extraEnv },
    presentationSink: {
      broadcastMessage: (_sessionId, message) => { receivedMessages.push(message); receivedPresentation.push({ kind: 'message', value: message }); },
      broadcastQueueHistoryAppend: (_sessionId, append) => { receivedBatches.push(append); receivedPresentation.push({ kind: 'batch', value: append }); },
      notifySessionEvent: (_sessionId, event) => { receivedEvents.push(event); receivedPresentation.push({ kind: 'event', value: event }); },
    },
    onWorkerReady: sessionId => { readySessions.push(sessionId); },
  });
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, id => id, () => true);
  return { store, supervisor, ingress, receivedMessages, receivedBatches, receivedEvents, receivedPresentation, readySessions };
}

test('subscribed workers forward appended messages and coalesced stream deltas as pure presentation', async () => {
  const sessionId = `mc-pres-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-pres-'));
  // Deltas fire on the second chat (the subscribed turn).
  const fixture = makeFixture(root, { FOXWARM_TEST_STREAM_DELTAS: '1', FOXWARM_TEST_STREAM_DELTAS_AT: '2' });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    assert.deepEqual(fixture.readySessions, [], 'no worker yet');
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'presentation question' }] });
    assert.deepEqual(fixture.readySessions, [sessionId], 'onWorkerReady fires on activation');

    // No subscription yet: zero presentation forwards.
    assert.equal(fixture.receivedMessages.length, 0);
    assert.equal(fixture.receivedEvents.length, 0);

    await fixture.supervisor.setPresentationSubscription(sessionId, true);
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'second question' }] });
    await waitFor(() => fixture.receivedBatches.length >= 1
      && fixture.receivedMessages.length >= 1
      && fixture.receivedEvents.some(e => e.type === 'model-stream-update'));

    // The queue-origin user row remains one canonical batch, followed by the
    // ordinary provider-model presentation on the same ordered tail.
    assert.equal(fixture.receivedBatches[0].messages.length, 1);
    assert.equal(fixture.receivedBatches[0].messages[0].role, 'user');
    assert.ok(JSON.stringify(fixture.receivedBatches[0].messages[0]).includes('second question'));
    assert.equal(fixture.receivedMessages[0].role, 'model');
    assert.ok(JSON.stringify(fixture.receivedMessages[0]).includes('deterministic child answer'));

    // Three rapid deltas coalesce into one cumulative frame; the turn-end flush
    // delivers the latest; the structural reset forwards immediately.
    const updates = fixture.receivedEvents.filter(e => e.type === 'model-stream-update');
    assert.equal(updates.length, 1, 'rapid deltas coalesce into the latest cumulative frame');
    assert.equal(updates[0].text, 'partial-3');
    assert.ok(fixture.receivedEvents.some(e => e.type === 'model-stream-reset'), 'reset forwards immediately');
    const updateIndex = fixture.receivedPresentation.findIndex(item => item.kind === 'event' && item.value.type === 'model-stream-update');
    const resetIndex = fixture.receivedPresentation.findIndex(item => item.kind === 'event' && item.value.type === 'model-stream-reset');
    const batchIndex = fixture.receivedPresentation.findIndex(item => item.kind === 'batch');
    const modelIndex = fixture.receivedPresentation.findIndex(item => item.kind === 'message' && item.value.role === 'model');
    assert.ok(batchIndex >= 0 && batchIndex < updateIndex, 'the canonical user batch precedes provider streaming');
    assert.ok(updateIndex >= 0 && updateIndex < resetIndex, 'a coalesced update cannot arrive after its structural reset');
    assert.ok(resetIndex < modelIndex, 'the structural reset precedes the ordinary canonical model row');
  } finally {
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('final coalesced tool frame is forwarded before its canonical model message and never reappears', async () => {
  const sessionId = `mc-pres-order-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-pres-order-'));
  const fixture = makeFixture(root, {
    FOXWARM_TEST_STREAM_COMMITTED_TOOL: '1',
    FOXWARM_TEST_STREAM_COMMITTED_TOOL_AT: '2',
  });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'unsubscribed warmup' }] });
    await fixture.supervisor.setPresentationSubscription(sessionId, true);
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'run the streamed tool' }] });
    await waitFor(() => fixture.receivedMessages.some(message =>
      message.role === 'model' && message.parts?.some((part: any) => part.functionCall?.id === 'worker-stream-exec')));
    // Wait beyond the former 500ms timer window: no stale delayed frame may
    // recreate the synthetic WebUI reasoning/tool row after canonical commit.
    await new Promise(resolve => setTimeout(resolve, 650));

    const updateIndices = fixture.receivedPresentation
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind === 'event'
        && item.value.type === 'model-stream-update'
        && item.value.streamId === 'committed-tool-stream')
      .map(({ index }) => index);
    const modelIndex = fixture.receivedPresentation.findIndex(item => item.kind === 'message'
      && item.value.role === 'model'
      && item.value.parts?.some((part: any) => part.functionCall?.id === 'worker-stream-exec'));
    assert.deepEqual(updateIndices.length, 1, 'the cumulative tool frame is forwarded exactly once');
    assert.ok(updateIndices[0] < modelIndex, 'the final cumulative frame precedes the canonical model row');
    assert.equal(fixture.receivedPresentation.slice(modelIndex + 1).some(item => item.kind === 'event'
      && item.value.type === 'model-stream-update'
      && item.value.streamId === 'committed-tool-stream'), false, 'no stale frame follows the canonical model row');
    const committed = fixture.receivedPresentation[modelIndex].value;
    assert.deepEqual(committed.parts.find((part: any) => part.functionCall)?.functionCall?.args,
      { command: 'printf worker-stream-order' }, 'canonical message retains the real tool arguments');
  } finally {
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('unsubscribed workers forward nothing', async () => {
  const sessionId = `mc-pres-off-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-pres-off-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_STREAM_DELTAS: '1' });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    await fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'quiet question' }] });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fixture.receivedMessages.length, 0, 'no subscription, zero worker→Main presentation calls');
    assert.equal(fixture.receivedEvents.length, 0);
  } finally {
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('worker accumulates an exact-owner draft before the first presentation subscriber', async () => {
  const sessionId = `mc-pres-bootstrap-${Date.now()}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-pres-bootstrap-'));
  const fixture = makeFixture(root, { FOXWARM_TEST_STREAM_BOOTSTRAP: '1' });
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  try {
    await fixture.supervisor.reconcileStartupOwnerships();
    const turn = fixture.ingress.submitEnsuringWorker(sessionId, { type: 'user', parts: [{ text: 'quiet stream' }] });
    await waitFor(() => fs.pathExists(path.join(root, 'state', `stream-bootstrap-${sessionId}`)));
    assert.equal(fixture.receivedEvents.length, 0, 'no subscriber means no Worker-to-Main live events');
    const draft = await fixture.supervisor.loadModelStreamDraft(sessionId);
    assert.equal(draft?.text, 'quiet accumulated draft');
    assert.equal(draft?.sequence, 4);
    assert.equal(draft?.llmRequestId, 'bootstrap-request');
    assert.equal(draft?.toolCalls[0]?.arguments, '{"filePath":"quiet"}');
    await fixture.supervisor.setPresentationSubscription(sessionId, true);
    await turn;
  } finally {
    await fixture.supervisor.shutdown(3_000).catch(() => {});
    fixture.store.close();
    await fs.remove(root);
  }
});

test('presentation handler fences non-exact sources and never touches semantic state', async () => {
  const calls: string[] = [];
  const handler = createSessionWorkerPresentationServiceHandler({
    expected: { sessionId: 's1', generation: 2, incarnationId: 'inc-a' },
    broadcastMessage: () => { calls.push('message'); },
    broadcastQueueHistoryAppend: () => { calls.push('append'); },
    notifySessionEvent: () => { calls.push('event'); },
  });
  await assert.rejects(
    () => Promise.resolve(handler.message({ sessionId: 's1', generation: 1, incarnationId: 'inc-a', message: { role: 'model', parts: [] } } as any, {} as any)),
    (error: any) => error?.code === 'SESSION_WORKER_PRESENTATION_SOURCE_MISMATCH',
  );
  await assert.rejects(
    () => Promise.resolve(handler.message({ sessionId: 's1', generation: 2, incarnationId: 'inc-a', message: { parts: [] } } as any, {} as any)),
    (error: any) => error?.code === 'SESSION_WORKER_PRESENTATION_INVALID',
  );
  await handler.message({ sessionId: 's1', generation: 2, incarnationId: 'inc-a', message: { role: 'model', parts: [{ text: 'x' }] } } as any, {} as any);
  assert.deepEqual(calls, ['message']);
});

test('presentation channel registers on the worker reverse registry', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(sessionWorkerPresentationServiceDescriptor, createSessionWorkerPresentationServiceHandler({
    expected: { sessionId: 's', generation: 1, incarnationId: 'i' },
    broadcastMessage: () => {}, broadcastQueueHistoryAppend: () => {}, notifySessionEvent: () => {},
  }));
  const transport = new LocalRpcTransport(registry);
  assert.ok(transport, 'descriptor registers');
  transport.close();
});
