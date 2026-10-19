import './testEnvironment';
import * as promptSnapshot from './session/promptSnapshot';
import * as promptCache from './session/promptCache';
import * as toolExecutor from './toolExecutor';
import type { CurrentSessionTurnEffects } from './session/currentSessionEffects';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as configModule from './config';
import { loadModelsConfigFromObject } from './config';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import * as sessionHistory from './session/history';
import { initArchiveStore } from './session/archiveStore';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { Message, Session } from './types';

// The continuation guard compares the previous provider measurement against the
// model's context limit, so this fixture pins both numbers instead of relying on
// whichever model config the test process happens to load.
const CONTEXT_LIMIT_TOKENS = 2000;
const COMPACT_THRESHOLD_TOKENS = 1700;
const OVER_LIMIT_USAGE = { cachedTokens: 0, inputTokens: 2100, outputTokens: 0 };
const BELOW_LIMIT_USAGE = { cachedTokens: 0, inputTokens: 1900, outputTokens: 0 };
const PLAN_SUMMARY = 'deferred compact plan replaces the older exchange';
const OLD_USER_TEXT = `older user context ${'alpha '.repeat(3000)}`;
const OLD_MODEL_TEXT = `older model answer ${'bravo '.repeat(3000)}`;
const TURN_TOOL_CALL = { id: 'limit-guard-tool', name: 'read', args: { action: 'status' } };

type Harness = {
  session: Session;
  deps: sessionHistory.SessionHistoryDeps;
  effects: CurrentSessionTurnEffects;
  abortControllers: Map<string, AbortController>;
  deliveries: string[];
  /** Broadcasts flagged as turn-final, the terminal deliveries of a turn. */
  finalDeliveries: string[];
  /** Continuation-trigger requests that reached the real compaction engine. */
  compactionRequests: { count: number };
  /** Optional gate the harness awaits inside the compaction-request window. */
  compactionRequestGate: { current: null | (() => Promise<void>) };
  runner: SessionTurnRunner;
};

async function waitFor(condition: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function makeSession(sessionId: string): Session {
  return {
    id: sessionId,
    agent: 'main',
    model: 'fixture/context-limit',
    history: [],
    persistentMemorySnapshot: 'context limit turn fixture system prompt',
    systemPromptFiles: [],
    snapshotUpdatedAt: Date.now(),
    compactThresholdTokens: COMPACT_THRESHOLD_TOKENS,
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [{ type: 'background', parts: [{ text: 'starting turn input' }] }],
    meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 1,
    nextBlockId: 1,
    historyVersion: 0,
    promptCacheKey: promptCache.generatePromptCacheKey(),
  } as Session;
}

async function createHarness(sessionId: string): Promise<Harness> {
  await initArchiveStore();
  const session = makeSession(sessionId);
  const abortControllers = new Map<string, AbortController>();
  const deliveries: string[] = [];
  const finalDeliveries: string[] = [];
  session.broadcast = (text, options) => {
    if (!text) return;
    deliveries.push(text);
    if (options?.turnFinal) finalDeliveries.push(text);
  };

  const persistSession = async (owner: Session) => { await writeAuthoritativeSessionState(owner); };
  const notifyHistoryUpdate = (_sessionId: string, _message: Message) => {};
  const appendMessages = async (owner: Session, messages: Message[]) => { await sessionManager.appendSessionMessagesForSession(
    owner, messages, () => persistSession(owner), notifyHistoryUpdate,
  ); };
  const effects: CurrentSessionTurnEffects = {
    placement: 'local',
    appendMessage: (owner, message) => appendMessages(owner, [message]),
    appendMessages,
    appendQueuedMessages: (owner, messages) => sessionManager.appendQueuedSessionMessagesForSession(
      owner, messages, () => persistSession(owner),
    ),
    persistSession,
    updateBusy: (owner, busy) => sessionManager.updateSessionBusyStateForSession(owner, busy, () => persistSession(owner)),
    startWait: (owner, options) => sessionManager.startSessionWaitForSession(owner, options, () => persistSession(owner)),
    notifyHistoryUpdate,
    notifySessionEvent: () => {},
    setRuntimeState: () => {},
    clearRuntimeState: () => {},
    registerAbortController: (id, controller) => { abortControllers.set(id, controller); },
    clearAbortController: (id, controller) => { if (abortControllers.get(id) === controller) abortControllers.delete(id); },
    clearWaitById: async () => false,
  };

  const deps: sessionHistory.SessionHistoryDeps = {
    getSessionById: id => id === session.id ? session : undefined,
    getExistingSession: async id => id === session.id ? session : null,
    saveSession: async id => { if (id === session.id) await persistSession(session); },
    enqueueSessionItem: async (id, item) => { if (id === session.id) session.queue.push(item); },
    notifyHistoryUpdate,
  };
  const compactionRequests = { count: 0 };
  const compactionRequestGate: Harness['compactionRequestGate'] = { current: null };
  const host = new LocalSessionTurnHost(effects, session, {
    hasCompletedCompactJob: sessionHistory.hasCompletedCompactJob,
    applyCompletedCompactJob: id => sessionHistory.applyCompletedCompactJob(deps, id),
    processSessionCompactionRequest: async (id, request, mode, owner) => {
      compactionRequests.count += 1;
      if (compactionRequestGate.current) await compactionRequestGate.current();
      return sessionHistory.processSessionCompactionRequest(deps, id, request, mode, owner);
    },
  });
  return { session, deps, effects, abortControllers, deliveries, finalDeliveries, compactionRequests, compactionRequestGate, runner: new SessionTurnRunner(host) };
}

/** Two large older exchanges plus two recent rows, the canonical compactable shape. */
async function appendOlderHistory(harness: Harness): Promise<void> {
  await harness.effects.appendMessages(harness.session, [
    { role: 'user', parts: [{ text: OLD_USER_TEXT }] },
    { role: 'model', parts: [{ text: OLD_MODEL_TEXT }] },
    { role: 'user', parts: [{ text: 'recent user message kept outside the compact range' }] },
    { role: 'model', parts: [{ text: 'recent model answer kept outside the compact range' }] },
  ]);
}

function submittedPlanToolCall(id: string, sourceStart = 1, sourceEnd = 2) {
  return {
    id,
    name: 'submit_compact_plan',
    args: { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart, sourceEnd, summary: PLAN_SUMMARY }] },
  };
}

async function appendPlanSubmission(options: any, toolCall: any) {
  await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
  return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
}

function stubProviderSurface() {
  const originalChat = llm.chat;
  const originalExecuteTools = toolExecutor.executeTools;
  const originalSnapshot = promptSnapshot.buildSessionSystemPromptSnapshotForSession;
  const originalResolve = configModule.resolveModelConfig;
  const models = loadModelsConfigFromObject({
    default: 'fixture/context-limit',
    providers: { fixture: { providerType: 'openai-completions', baseUrl: 'https://example.test/v1', apiKey: 'test-key', models: ['context-limit'] } },
  });
  (configModule as any).resolveModelConfig = () => ({
    modelsConfig: models,
    defaultKey: models.default,
    currentKey: models.default,
    modelEntry: models.models[models.default],
    contextLimit: CONTEXT_LIMIT_TOKENS,
  });
  (promptSnapshot as any).buildSessionSystemPromptSnapshotForSession = async (activeSession: Session) => activeSession.persistentMemorySnapshot;
  (toolExecutor as any).executeTools = async (functionCalls: Array<{ id?: string; name: string }>) => ({
    message: {
      role: 'tool', parts: functionCalls.map(call => ({ functionResponse: { tool_use_id: call.id, name: call.name, response: { output: 'ok' } } }))
    }
  });
  return () => {
    (llm as any).chat = originalChat;
    (toolExecutor as any).executeTools = originalExecuteTools;
    (promptSnapshot as any).buildSessionSystemPromptSnapshotForSession = originalSnapshot;
    (configModule as any).resolveModelConfig = originalResolve;
  };
}

function hasCompactCompletionMarker(session: Session): boolean {
  return session.history.some(message => JSON.stringify(message.parts).includes('compact-completed'));
}

function historyContains(session: Session, text: string): boolean {
  return JSON.stringify(session.history).includes(text);
}

test('a provider measurement over the context limit waits for the running compaction and continues after its commit', async () => {
  const harness = await createHarness(`limit_wait_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  let releasePlanning = () => {};
  const planningReleased = new Promise<void>(resolve => { releasePlanning = resolve; });
  let planningEntered = () => {};
  const planningStarted = new Promise<void>(resolve => { planningEntered = resolve; });
  const continuations: string[] = [];
  (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      planningEntered();
      await planningReleased;
      return appendPlanSubmission(options, submittedPlanToolCall('limit-wait-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    continuations.push(JSON.stringify(owner.history));
    await options.appendMessage({ role: 'model', parts: [{ text: 'final answer after the deferred compaction' }] });
    return { text: 'final answer after the deferred compaction', allParts: [{ text: 'final answer after the deferred compaction' }] };
  };

  try {
    const running = harness.runner.processSessionQueue(harness.session.id);
    await planningStarted;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(normalCalls, 1, 'no continuation request may start while the required compaction is still planning');
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), 'planning');
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), false);

    releasePlanning();
    await running;

    assert.equal(normalCalls, 2);
    assert.equal(planCalls, 1);
    assert.equal(harness.compactionRequests.count, 1, 'the continuation asked for compaction exactly once');
    assert.equal(continuations.length, 1);
    assert.ok(continuations[0].includes(PLAN_SUMMARY), 'continuation request must see the committed compact plan');
    assert.equal(continuations[0].includes('alpha'), false, 'continuation request must not resend the compacted older exchange');
    assert.equal(hasCompactCompletionMarker(harness.session), true);
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), false);
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), undefined);
    assert.equal(sessionHistory.hasPendingCompactWork(harness.session.id), false);
    assert.equal(harness.session.busy, false);
    assert.equal(harness.session.queue.length, 0);
  } finally {
    releasePlanning();
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('a safe-point commit ahead of an over-limit continuation does not start a second compact job', async () => {
  const harness = await createHarness(`limit_ready_first_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  const continuations: string[] = [];
  (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      return appendPlanSubmission(options, submittedPlanToolCall('ready-first-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      // The previous turn's compact work becomes commit-ready while this turn's
      // first provider request is in flight; the safe point applies it.
      const queued = await sessionHistory.processSessionCompactionRequest(
        harness.deps, harness.session.id, { keepPercent: 0.5 }, 'background',
      );
      assert.deepEqual(queued, { applied: false, background: true });
      await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'background compaction must become ready');
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    continuations.push(JSON.stringify(owner.history));
    await options.appendMessage({ role: 'model', parts: [{ text: 'final answer after the safe-point commit' }] });
    return { text: 'final answer after the safe-point commit', allParts: [{ text: 'final answer after the safe-point commit' }] };
  };

  try {
    await harness.runner.processSessionQueue(harness.session.id);

    assert.equal(normalCalls, 2, 'the continuation request proceeds once the applied result is recognized');
    assert.equal(planCalls, 1, 'the pre-commit measurement must not restart compaction');
    assert.equal(harness.compactionRequests.count, 0, 'the applied result must satisfy the continuation trigger');
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), undefined);
    assert.equal(sessionHistory.hasPendingCompactWork(harness.session.id), false, 'no replacement job may stay pending');
    assert.equal(continuations[0].includes(PLAN_SUMMARY), true);
    assert.equal(continuations[0].includes('alpha'), false);
    assert.equal(harness.session.busy, false);
  } finally {
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('a below-limit measurement paired with a safe-point commit also skips a duplicate compact job', async () => {
  const harness = await createHarness(`below_limit_ready_first_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      return appendPlanSubmission(options, submittedPlanToolCall('below-limit-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await sessionHistory.processSessionCompactionRequest(harness.deps, harness.session.id, { keepPercent: 0.5 }, 'background');
      await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'background compaction must become ready');
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: BELOW_LIMIT_USAGE };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'final below-limit answer' }] });
    return { text: 'final below-limit answer', allParts: [{ text: 'final below-limit answer' }] };
  };

  try {
    await harness.runner.processSessionQueue(harness.session.id);

    assert.equal(normalCalls, 2);
    assert.equal(planCalls, 1, 'an already-applied result must not trigger another background job above the threshold');
    assert.equal(harness.compactionRequests.count, 0, 'the applied result must satisfy the continuation trigger');
    assert.equal(sessionHistory.hasPendingCompactWork(harness.session.id), false, 'no replacement job may stay pending');
    assert.equal(hasCompactCompletionMarker(harness.session), true);
    assert.equal(harness.session.busy, false);
  } finally {
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('failed compact planning ends the turn without another provider request and keeps the paired tool result', async () => {
  const harness = await createHarness(`limit_plan_failure_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      throw new Error('compact plan provider failure');
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    throw new Error('no provider request may follow a failed required compaction');
  };

  try {
    await harness.runner.processSessionQueue(harness.session.id);

    assert.equal(normalCalls, 1, 'a failed required compaction must end the turn before the next request');
    assert.equal(planCalls, 1, 'a terminal planning failure must not open another planning round');
    assert.equal(harness.compactionRequests.count, 1);
    assert.equal(historyContains(harness.session, TURN_TOOL_CALL.id!), true, 'the paired tool call stays in history');
    assert.equal(historyContains(harness.session, '"ok"'), true, 'the paired tool response stays in history');
    assert.equal(hasCompactCompletionMarker(harness.session), false);
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), false);
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), undefined);
    assert.equal(harness.deliveries.some(text => text.includes('compact plan provider failure')), true,
      'the failed turn reports the underlying planning failure once');
    assert.equal(harness.session.busy, false);
  } finally {
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('shutdown cancels the real planner wait without finalizing unfinished work as user Stop', async () => {
  const harness = await createHarness(`limit_shutdown_wait_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let releasePlanning = () => {};
  const planningReleased = new Promise<void>(resolve => { releasePlanning = resolve; });
  let planningEntered = () => {};
  const planningStarted = new Promise<void>(resolve => { planningEntered = resolve; });
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planningEntered();
      await planningReleased;
      return appendPlanSubmission(options, submittedPlanToolCall('shutdown-wait-plan'));
    }
    normalCalls += 1;
    assert.equal(normalCalls, 1, 'shutdown cannot send another normal request');
    await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
    return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
  };

  try {
    const running = harness.runner.processSessionQueue(harness.session.id);
    await planningStarted;
    await waitFor(() => harness.abortControllers.has(harness.session.id), 'the real compact wait registers its controller');
    harness.session.queue.push({ type: 'user', parts: [{ text: 'follow-up while planner is waiting' }] });
    await harness.effects.persistSession(harness.session);
    await harness.runner.shutdown((id, reason) => {
      const controller = harness.abortControllers.get(id);
      if (!controller) return false;
      harness.abortControllers.delete(id);
      controller.abort(reason);
      return true;
    }, { graceMs: 0, cancelMs: 1000 });
    await running;

    assert.equal(normalCalls, 1);
    assert.equal(harness.session.busy, true);
    assert.equal(harness.session.queue.length, 1);
    assert.equal(historyContains(harness.session, 'follow-up while planner is waiting'), false,
      'shutdown must not passively consume later input as if the user had stopped');
    assert.equal(harness.deliveries.some(text => text.includes('Execution stopped by user')), false);
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), 'planning');
    assert.equal(harness.abortControllers.size, 0);

    releasePlanning();
    await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'planning can settle independently of the exited turn');
    assert.equal(harness.session.busy, true, 'planner readiness does not depend on owner commit or clear its busy checkpoint');
  } finally {
    releasePlanning();
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('Stop releases the continuation wait without cancelling the running compaction', async () => {
  const harness = await createHarness(`limit_stop_release_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let releasePlanning = () => {};
  const planningReleased = new Promise<void>(resolve => { releasePlanning = resolve; });
  let planningEntered = () => {};
  const planningStarted = new Promise<void>(resolve => { planningEntered = resolve; });
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planningEntered();
      await planningReleased;
      return appendPlanSubmission(options, submittedPlanToolCall('stop-release-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    throw new Error('an interrupted continuation must not send another provider request');
  };

  try {
    const running = harness.runner.processSessionQueue(harness.session.id);
    await planningStarted;
    await waitFor(() => harness.abortControllers.has(harness.session.id), 'the compaction wait registers its interruption controller');
    harness.session.queue.push({ type: 'user', parts: [{ text: 'queued while the compaction wait is held' }] });
    harness.abortControllers.get(harness.session.id)!.abort();
    await running;

    assert.equal(normalCalls, 1);
    assert.equal(harness.deliveries.some(text => text.includes('Execution stopped by user')), true);
    assert.equal(sessionHistory.getCompactOperationOwner(harness.session.id), 'background');
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), 'planning', 'Stop ends the wait, not the compaction');
    assert.equal(historyContains(harness.session, 'queued while the compaction wait is held'), true,
      'input received during the wait is passively committed instead of lost');
    assert.equal(harness.session.busy, false);

    releasePlanning();
    await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'the released compaction still finishes');
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), true);
  } finally {
    releasePlanning();
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('Run queued releases the real compact wait and processes queued input without cancelling planning', async () => {
  const harness = await createHarness(`limit_run_queued_release_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let releasePlanning = () => {};
  const planningReleased = new Promise<void>(resolve => { releasePlanning = resolve; });
  let planningEntered = () => {};
  const planningStarted = new Promise<void>(resolve => { planningEntered = resolve; });
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planningEntered();
      await planningReleased;
      return appendPlanSubmission(options, submittedPlanToolCall('run-queued-release-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'answer after Run queued' }] });
    return { text: 'answer after Run queued', allParts: [{ text: 'answer after Run queued' }] };
  };

  try {
    const running = harness.runner.processSessionQueue(harness.session.id);
    await planningStarted;
    await waitFor(() => harness.abortControllers.has(harness.session.id), 'the real compact wait registers its controller');
    harness.session.queue.push({ type: 'user', parts: [{ text: 'active input for Run queued' }] });
    harness.session.stopping = true;
    harness.session.meta.runQueuedAfterStop = true;
    harness.abortControllers.get(harness.session.id)!.abort();
    await running;

    assert.equal(normalCalls, 2, 'Run queued still starts the queued turn');
    assert.equal(harness.session.busy, false);
    assert.equal(harness.session.queue.length, 0);
    assert.equal(historyContains(harness.session, 'active input for Run queued'), true);
    assert.equal(harness.session.history.at(-1)!.parts[0].text, 'answer after Run queued');
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), 'planning');

    releasePlanning();
    await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'the planner still settles after Run queued');
  } finally {
    releasePlanning();
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('an ordinary Stop that arrives before the wait registration ends the turn while the planner keeps running', async () => {
  const harness = await createHarness(`limit_stop_window_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planShouldFail = false;
  let releasePlanning = () => {};
  const planningReleased = new Promise<void>(resolve => { releasePlanning = resolve; });
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      await planningReleased;
      if (planShouldFail) throw new Error('stop-window plan provider failure');
      return appendPlanSubmission(options, submittedPlanToolCall('stop-window-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    throw new Error('a stopped turn must not send another provider request');
  };

  // The supported Stop path sets the stopping flag and aborts the controllers
  // registered at that moment. This hook lands it inside the compaction-request
  // window, before the continuation wait registers its own controller.
  let requestEntered = false;
  let releaseRequest = () => {};
  harness.compactionRequestGate.current = async () => {
    requestEntered = true;
    await new Promise<void>(resolve => { releaseRequest = resolve; });
    harness.session.stopping = true;
    for (const controller of harness.abortControllers.values()) controller.abort();
  };

  try {
    const running = harness.runner.processSessionQueue(harness.session.id);
    await waitFor(() => requestEntered, 'the compaction request window opens');
    releaseRequest();
    await waitFor(() => harness.session.busy === false, 'the stopped turn ends without waiting for the planner');
    await running;

    assert.equal(normalCalls, 1, 'the stopped turn must not send another provider request');
    assert.equal(harness.compactionRequests.count, 1);
    assert.equal(sessionHistory.getCompactOperationPhase(harness.session.id), 'planning', 'the compaction keeps running');
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), false);
    assert.equal(harness.finalDeliveries.some(text => text.includes('Execution stopped by user')), true);
    assert.equal(harness.session.busy, false);
    assert.equal(harness.abortControllers.size, 0);

    planShouldFail = true;
    releasePlanning();
    await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'the released planner becomes terminal');
    assert.equal(harness.finalDeliveries.some(text => text.includes('stop-window plan provider failure')), false,
      'a planning failure after the Stop must not replace its terminal state');
    assert.equal(harness.finalDeliveries.length, 1, 'the stop annotation stays the only terminal delivery');
  } finally {
    releasePlanning();
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('an over-limit continuation propagates a failed safe-point apply instead of opening a new compact round', async () => {
  const harness = await createHarness(`limit_failed_apply_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      throw new Error('safe-point planning failure');
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      // A compact job from an earlier safe point fails while this request is in flight.
      await sessionHistory.processSessionCompactionRequest(harness.deps, harness.session.id, { keepPercent: 0.5 }, 'background');
      await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'the failed job becomes terminal');
      await options.appendMessage({ role: 'model', parts: [{ functionCall: TURN_TOOL_CALL }] });
      return { text: '', toolCalls: [TURN_TOOL_CALL], allParts: [{ functionCall: TURN_TOOL_CALL }], usage: OVER_LIMIT_USAGE };
    }
    throw new Error('no provider request may follow an uncommitted required compaction');
  };

  try {
    await harness.runner.processSessionQueue(harness.session.id);

    assert.equal(normalCalls, 1, 'the turn must end before the next request');
    assert.equal(planCalls, 1, 'a terminal failure must not open another planning round');
    assert.equal(harness.compactionRequests.count, 0, 'the continuation must not request a replacement job');
    assert.equal(harness.deliveries.some(text => text.includes('safe-point planning failure')), true,
      'the failed safe-point apply is the reported failure');
    assert.equal(harness.finalDeliveries.length, 1, 'the failed turn makes one terminal delivery');
    assert.equal(harness.deliveries.some(text => text.includes('no provider request may follow')), false);
    assert.equal(sessionHistory.hasCompletedCompactJob(harness.session.id), false);
    assert.equal(sessionHistory.hasPendingCompactWork(harness.session.id), false);
    assert.equal(harness.session.busy, false);
  } finally {
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});

test('a below-limit continuation keeps the existing swallowed safe-point failure and recovery round', async () => {
  const harness = await createHarness(`below_limit_failed_apply_${Date.now()}`);
  const restoreProvider = stubProviderSurface();
  await appendOlderHistory(harness);
  let normalCalls = 0;
  let planCalls = 0;
  (llm as any).chat = async (_parts: any, _owner: Session, _iteration: number, options: any) => {
    if (options?.purpose === 'compact-plan') {
      planCalls += 1;
      if (planCalls === 1) throw new Error('below-limit planning failure');
      return appendPlanSubmission(options, submittedPlanToolCall('below-limit-recovery-plan'));
    }
    normalCalls += 1;
    if (normalCalls === 1) {
      harness.session.queue.push({ type: 'user', parts: [{ text: 'queued follow-up before the below-limit continuation' }] });
      await sessionHistory.processSessionCompactionRequest(harness.deps, harness.session.id, { keepPercent: 0.5 }, 'background');
      await waitFor(() => sessionHistory.hasCompletedCompactJob(harness.session.id), 'the failed job becomes terminal');
      await options.appendMessage({ role: 'model', parts: [{ text: 'below-limit answer' }] });
      return { text: 'below-limit answer', allParts: [{ text: 'below-limit answer' }], usage: BELOW_LIMIT_USAGE };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'final below-limit answer' }] });
    return { text: 'final below-limit answer', allParts: [{ text: 'final below-limit answer' }] };
  };

  try {
    await harness.runner.processSessionQueue(harness.session.id);

    assert.equal(normalCalls, 2, 'a below-limit continuation still proceeds');
    assert.equal(harness.compactionRequests.count, 1, 'the below-limit trigger still asks once');
    assert.equal(planCalls, 2, 'the below-limit safe point keeps its existing recovery round');
    assert.equal(harness.deliveries.some(text => text.includes('below-limit planning failure')), true,
      'the swallowed failure is still surfaced');
    assert.equal(harness.session.busy, false);
  } finally {
    restoreProvider();
    sessionHistory.discardPendingCompactWork(harness.session.id);
  }
});
