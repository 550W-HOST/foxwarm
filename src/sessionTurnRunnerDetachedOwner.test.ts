import test from 'node:test';
import assert from 'node:assert/strict';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { initArchiveStore } from './session/archiveStore';
import { readArchiveMessages } from './session/archive';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { Message, Session } from './types';
import { logger } from './common';

function createSession(id: string, text: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: 'detached system prompt',
    systemPromptFiles: [],
    snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [{ type: 'background', parts: [{ text }] }],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function createEffects(session: Session, events: string[]): llm.CurrentSessionTurnEffects {
  const persistSession = async (owner: Session) => {
    assert.strictEqual(owner, session);
    events.push(`persist:${owner.busy ? 'busy' : 'idle'}:${owner.history.length}`);
    await writeAuthoritativeSessionState(owner);
  };
  const notifyHistoryUpdate = (sessionId: string, message: Message) => {
    assert.equal(sessionId, session.id);
    events.push(`history:${message.role}`);
  };
  const appendMessages = (owner: Session, messages: Message[]) => sessionManager.appendSessionMessagesForSession(
    owner,
    messages,
    () => persistSession(owner),
    notifyHistoryUpdate,
  );
  return {
    placement: 'local',
    appendMessage: (owner, message) => appendMessages(owner, [message]),
    appendMessages,
    persistSession,
    updateBusy: (owner, busy) => sessionManager.updateSessionBusyStateForSession(
      owner,
      busy,
      () => persistSession(owner),
      id => { events.push(`runtime-clear:${id}`); },
      id => { events.push(`state:${id}`); },
    ),
    startWait: (owner, options) => sessionManager.startSessionWaitForSession(owner, options, () => persistSession(owner)),
    notifyHistoryUpdate,
    notifySessionEvent: (_id, event) => { events.push(`stream:${event.type}`); },
    setRuntimeState: (_id, state) => { events.push(`runtime:${state.state}`); },
    clearRuntimeState: id => { events.push(`runtime-clear:${id}`); },
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async (_id, waitId) => {
      if (session.meta.wait?.id !== waitId) return false;
      delete session.meta.wait;
      await persistSession(session);
      return true;
    },
  };
}

async function withGlobalOwnerLookupsForbidden(run: () => Promise<void>): Promise<void> {
  const originals = {
    get: sessionManager.getSession,
    existing: sessionManager.getExistingSession,
    save: sessionManager.saveSession,
  };
  (sessionManager as any).getSession = async () => { throw new Error('global current-session get forbidden'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('global current-session existing lookup forbidden'); };
  (sessionManager as any).saveSession = async () => { throw new Error('global current-session save forbidden'); };
  try {
    await run();
  } finally {
    (sessionManager as any).getSession = originals.get;
    (sessionManager as any).getExistingSession = originals.existing;
    (sessionManager as any).saveSession = originals.save;
  }
}

test('detached exact owner completes canonical foreground provider turn', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_provider_${Date.now()}`, 'provider input');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session);
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
    assert.strictEqual(owner, session);
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'provider answer' }] });
    return { text: 'provider answer' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.history.length, 2);
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 0);
    const archived = await readArchiveMessages(session.id);
    assert.deepEqual(archived.map(record => record.message.role), ['user', 'model']);
    const persisted = await readSessionHistorySnapshot(session.id);
    assert.deepEqual((persisted?.history || []).map((message: Message) => message.role), ['user', 'model']);
    assert.equal(persisted?.busy, false);
    assert.deepEqual(events.filter(event => event.startsWith('history:')), ['history:user', 'history:model']);
    const modelNotify = events.indexOf('history:model');
    const modelPersist = events.findIndex((event, index) => index < modelNotify && event === 'persist:busy:2');
    assert.ok(modelPersist >= 0, 'archive/history mutation must persist before its history notification');
    assert.match(events[0], /^persist:busy:0$/);
    assert.equal(events.filter(event => event.startsWith('persist:')).at(-1), 'persist:idle:2');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('one owned processor iterates many source turns with fresh TURN_IDs and one busy claim/release', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_many_sources_${Date.now()}`, 'unused');
  session.queue = Array.from({ length: 128 }, (_, index) => ({
    type: 'user' as const,
    source: {
      platform: 'qqbot', channelId: 'qq', channelUserId: `c2c:user-${index}`,
      conversationId: `c2c:user-${index}`, qqbotMessageId: `message-${index}`,
    },
    parts: [{ text: `turn-${index}` }],
  }));
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    turnIds.push(options.turnId);
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${turnIds.length}` }] });
    return { text: `done-${turnIds.length}` };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(turnIds.length, 128);
    assert.equal(new Set(turnIds).size, 128);
    assert.equal(session.history.length, 256);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2, 'one busy claim and one release own all turns');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('one owned processor sequences compact turn compact without another busy claim', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_compact_turn_compact_${Date.now()}`, 'unused');
  session.queue = [
    { type: 'compact-commit' },
    { type: 'user', parts: [{ text: 'between compacts' }] },
    { type: 'compact-commit' },
  ];
  const events: string[] = [];
  let compactApplies = 0;
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session, {
    applyCompletedCompactJob: async () => { compactApplies += 1; return true; },
  });
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    assert.equal(compactApplies, 1, 'the trailing compact remains an outer action until this turn completes');
    await options.appendMessage({ role: 'model', parts: [{ text: 'between done' }] });
    return { text: 'between done' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(compactApplies, 2);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('retry and a different-source queued turn share ownership but receive fresh TURN_IDs', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_retry_then_queue_${Date.now()}`, 'unused');
  session.history = [{
    role: 'user',
    parts: [{ system: '<foxwarm-system kind="event" type="trigger">interrupted continuation seed</foxwarm-system>' }],
  }];
  session.queue = [{
    type: 'user',
    source: { platform: 'qqbot', channelId: 'qq', channelUserId: 'c2c:later', conversationId: 'c2c:later', qqbotMessageId: 'later-message' },
    parts: [{ text: 'later source turn' }],
  }];
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    turnIds.push(options.turnId);
    await options.appendMessage({ role: 'model', parts: [{ text: `result-${turnIds.length}` }] });
    return { text: `result-${turnIds.length}` };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionRetry(session.id));
    assert.equal(turnIds.length, 2);
    assert.notEqual(turnIds[0], turnIds[1]);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model', 'user', 'model']);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('active managed step without a matching yield executes once and releases the one outer claim', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_managed_release_${Date.now()}`, 'managed pending input');
  session.meta.managedSession = {
    ownerSessionId: 'controller', leaseId: 'lease', revision: 1, pendingInbox: [],
    openedAt: Date.now(), leaseTouchedAt: Date.now(), currentStep: { stepId: 'step', runMode: 'idle' },
  };
  const events: string[] = [];
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, events), session));
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    assert.equal(parts, null);
    providerCalls += 1;
    await options.appendMessage({ role: 'model', parts: [{ text: 'managed step done' }] });
    return { text: 'managed step done' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(providerCalls, 1);
    assert.equal(session.queue.length, 0);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.meta.managedSession?.lastStepResult?.stepId, 'step');
    assert.equal(session.meta.managedSession?.lastStepResult?.yieldReason, 'idle');
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('already-yielded matching managed step leaves queued work durable without reentry', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_managed_yielded_${Date.now()}`, 'managed retained input');
  session.meta.managedSession = {
    ownerSessionId: 'controller', leaseId: 'lease', revision: 1, pendingInbox: [],
    openedAt: Date.now(), leaseTouchedAt: Date.now(), currentStep: { stepId: 'step', runMode: 'idle' },
    lastStepResult: { stepId: 'step', yieldReason: 'idle', yieldedAt: Date.now() },
  };
  const events: string[] = [];
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(createEffects(session, events), session));
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async () => { providerCalls += 1; throw new Error('yielded managed step must not reenter provider'); };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(providerCalls, 0);
    assert.equal(session.queue.length, 1);
    assert.equal(session.busy, false);
    assert.equal(events.filter(event => event.startsWith('state:')).length, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(providerCalls, 0);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('local post-final child-reminder failure keeps one provider final and releases busy', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_post_final_reminder_${Date.now()}`, 'provider input');
  session.parentSessionId = 'parent-session';
  const events: string[] = [];
  const finals: Array<{ text: string; options?: any }> = [];
  let postFinalCompactChecks = 0;
  session.broadcast = (text, options) => { finals.push({ text, options }); };
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session, {
    queueSessionSystemEvent: async () => { throw new Error('local reminder persistence failed'); },
    checkAndCompactIfNeeded: async () => { postFinalCompactChecks += 1; },
  });
  const runner = new SessionTurnRunner(host);
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'provider success' }] });
    return { text: 'provider success' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.deepEqual(finals.map(item => [item.text, item.options?.turnFinal]), [['provider success', true]]);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.history.some(message => JSON.stringify(message.parts).includes('local reminder persistence failed')), false);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(postFinalCompactChecks, 1);
    assert.equal(events.filter(event => event.startsWith('persist:')).at(-1), 'persist:idle:2');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('detached exact owner completes one real local-tool iteration', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_tool_${Date.now()}`, 'set a goal');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  let iteration = 0;
  const turnIds: string[] = [];
  (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
    assert.strictEqual(owner, session);
    turnIds.push(options.turnId);
    if (parts) await options.appendMessage({ role: 'user', parts });
    if (iteration++ === 0) {
      await options.appendMessage({ role: 'model', parts: [{ functionCall: { id: 'goal-call', name: 'set_goal', args: { goal: 'detached goal' } } }] });
      return { text: '', toolCalls: [{ id: 'goal-call', name: 'set_goal', args: { goal: 'detached goal' } }] };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'tool complete' }] });
    return { text: 'tool complete' };
  };

  try {
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(session.goalState?.goal, 'detached goal');
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model', 'tool', 'model']);
    assert.equal(session.history.length, 4);
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 0);
    assert.deepEqual((await readArchiveMessages(session.id)).map(record => record.message.role), ['user', 'model', 'tool', 'model']);
    assert.equal(turnIds.length, 2);
    assert.match(turnIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(turnIds[0], turnIds[1], 'one session turn keeps one TURN_ID across its tool loop');

    session.queue.push({ type: 'background', parts: [{ text: 'second turn' }] });
    await withGlobalOwnerLookupsForbidden(() => runner.processSessionQueue(session.id));
    assert.equal(turnIds.length, 3);
    assert.notEqual(turnIds[0], turnIds[2], 'a later runSessionTurn receives a new TURN_ID');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('exact host preserves append-many, wait, identity mismatch, and persistence failure behavior', async () => {
  await initArchiveStore();
  const session = createSession(`detached_runner_effects_${Date.now()}`, 'unused');
  session.queue = [];
  const events: string[] = [];
  const effects = createEffects(session, events);
  const host = new LocalSessionTurnHost(effects, session);
  const batch: Message[] = [
    { role: 'user', parts: [{ text: 'one' }] },
    { role: 'model', parts: [{ text: 'two' }] },
  ];
  await host.appendSessionMessages(session, batch);
  assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
  assert.deepEqual(events.slice(-3), ['persist:idle:2', 'history:user', 'history:model']);

  const wait = await host.startSessionWait(session, { reason: '  fallback  ', waitExecIds: ['exec-a'] });
  assert.equal(wait.reason, 'fallback');
  assert.equal(session.meta.wait?.id, wait.id);
  assert.deepEqual(wait.waitExecIds, ['exec-a']);
  assert.equal(await effects.clearWaitById(session.id, wait.id), true);
  assert.equal(session.meta.wait, undefined);

  const mismatch = createSession(`${session.id}_other`, 'other');
  await withGlobalOwnerLookupsForbidden(() => assert.rejects(
    () => host.getExistingSession(mismatch.id),
    /bound to session/,
  ));
  const effectCountBeforeClone = events.length;
  assert.throws(
    () => host.appendSessionMessage(mismatch, { role: 'user', parts: [{ text: 'wrong owner' }] }),
    /bound to session/,
  );
  const sameIdClone = { ...session } as Session;
  assert.throws(() => host.saveSession(sameIdClone), /different Session object/);
  assert.throws(() => host.chat(null, sameIdClone, 0), /different Session object/);
  assert.throws(() => host.executeTools([], { sessionId: session.id }, sameIdClone), /different Session object/);
  assert.throws(() => host.clearActiveSessionRuntimeState(mismatch.id), /bound to session/);
  assert.equal(events.length, effectCountBeforeClone);

  const failedEffects = createEffects(session, events);
  const failPersist = async () => { throw new Error('detached persist failed'); };
  failedEffects.persistSession = failPersist;
  failedEffects.appendMessages = (owner, messages) => sessionManager.appendSessionMessagesForSession(
    owner, messages, failPersist, failedEffects.notifyHistoryUpdate,
  );
  failedEffects.appendMessage = (owner, message) => failedEffects.appendMessages(owner, [message]);
  const failedHost = new LocalSessionTurnHost(failedEffects, session);
  await assert.rejects(() => failedHost.saveSession(session), /detached persist failed/);
  const notificationCount = events.filter(event => event.startsWith('history:')).length;
  await assert.rejects(
    () => failedHost.appendSessionMessage(session, { role: 'user', parts: [{ text: 'persist failure' }] }),
    /detached persist failed/,
  );
  assert.equal(events.filter(event => event.startsWith('history:')).length, notificationCount);
});

test('claim persistence failure blocks the turn without later append or unhandled rejection', async () => {
  const session = createSession(`detached_runner_claim_failure_${Date.now()}`, 'must not run');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  const originalAppendMessage = effects.appendMessage;
  const originalAppendMessages = effects.appendMessages;
  let appendCount = 0;
  effects.appendMessage = async () => { appendCount += 1; };
  effects.appendMessages = async () => { appendCount += 1; };
  effects.updateBusy = (owner, busy) => sessionManager.updateSessionBusyStateForSession(
    owner,
    busy,
    async () => { throw new Error('claim persist rejected'); },
    effects.clearRuntimeState,
    () => {},
  );
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(() => runner.processSessionQueue(session.id), /claim persist rejected/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(appendCount, 0);
    assert.equal(session.queue.length, 1);
    assert.equal(session.busy, false);
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'busyStartedAt'), false);
    assert.deepEqual(unhandled, []);

    effects.updateBusy = originalUpdateBusy;
    effects.appendMessage = originalAppendMessage;
    effects.appendMessages = originalAppendMessages;
    const originalChat = llm.chat;
    (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
      if (parts) await options.appendMessage({ role: 'user', parts });
      await options.appendMessage({ role: 'model', parts: [{ text: 'retry succeeded' }] });
      return { text: 'retry succeeded' };
    };
    try {
      await new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id);
    } finally {
      (llm as any).chat = originalChat;
    }
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(session.busy, false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('claim persistence completes before any turn append begins', async () => {
  const session = createSession(`detached_runner_claim_order_${Date.now()}`, 'ordered input');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
  let claimStarted!: () => void;
  const started = new Promise<void>(resolve => { claimStarted = resolve; });
  effects.updateBusy = async (owner, busy) => {
    if (busy) {
      claimStarted();
      await claimGate;
    }
    await originalUpdateBusy(owner, busy);
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'ordered' }] });
    return { text: 'ordered' };
  };
  try {
    const running = runner.processSessionQueue(session.id);
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.history.length, 0);
    assert.equal(events.some(event => event.startsWith('persist:')), false);
    releaseClaim();
    await running;
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
    assert.equal(events[0], 'persist:busy:0');
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('release persistence failure restores ownership and suppresses trailing handoff', async () => {
  const session = createSession(`detached_runner_release_failure_${Date.now()}`, 'first turn');
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let chatCount = 0;
  let releaseStartedAt: number | undefined;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseStartedAt = owner.busyStartedAt;
    owner.queue.push({ type: 'background', parts: [{ text: 'finish-window input' }] });
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'first done' }] });
    return { text: 'first done' };
  };
  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /release persist rejected/,
    );
    assert.equal(session.busy, true);
    assert.equal(typeof releaseStartedAt, 'number');
    assert.equal(session.busyStartedAt, releaseStartedAt);
    assert.equal(session.queue.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.busyStartedAt, releaseStartedAt);
    assert.equal(chatCount, 1);
    assert.equal(session.queue.length, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('stop-owned release failure is attempted once and is not retried by outer cleanup', async () => {
  const session = createSession(`detached_runner_stop_release_failure_${Date.now()}`, 'stop-retained input');
  session.stopping = true;
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseAttempts = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseAttempts += 1;
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('stop release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const originalChat = llm.chat;
  let providerCalls = 0;
  (llm as any).chat = async () => { providerCalls += 1; throw new Error('stopped turn must not enter provider'); };

  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /stop release persist rejected/,
    );
    assert.equal(releaseAttempts, 1);
    assert.equal(providerCalls, 0);
    assert.equal(session.busy, true);
    assert.equal(session.history.filter(message => message.role === 'user').length, 1);
    assert.equal(session.queue.length, 0);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('fenced turn-owned release failure is attempted once and propagates without outer retry', async () => {
  const session = createSession(`detached_runner_fenced_release_failure_${Date.now()}`, 'fenced input');
  session.queue[0] = {
    type: 'user',
    source: { platform: 'test', channelId: 'test', channelUserId: 'direct', conversationId: 'direct' },
    parts: [{ text: 'fenced input' }],
  };
  const events: string[] = [];
  const effects = createEffects(session, events);
  const originalUpdateBusy = effects.updateBusy;
  let releaseAttempts = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    releaseAttempts += 1;
    return sessionManager.updateSessionBusyStateForSession(
      owner,
      false,
      async () => { throw new Error('fenced release persist rejected'); },
      effects.clearRuntimeState,
      () => {},
    );
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session, {
    deliverCommittedFinal: async () => {},
  }));
  const originalChat = llm.chat;
  (llm as any).chat = async () => {
    const error = new Error('fenced semantic failure') as Error & { code: string };
    error.code = 'SESSION_WORKER_AUTO_COMPACTION_FATAL';
    throw error;
  };

  try {
    await assert.rejects(() => runner.processSessionQueue(session.id), /fenced release persist rejected/);
    assert.equal(releaseAttempts, 1);
    assert.equal(session.busy, true);
    assert.equal(session.history.filter(message => message.role === 'user').length, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('processor failure gate suppresses handoff even when a custom release leaves idle state', async () => {
  const session = createSession(`detached_runner_adversarial_release_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let chatCount = 0;
  effects.updateBusy = async (owner, busy) => {
    if (busy) return originalUpdateBusy(owner, true);
    owner.busy = false;
    owner.busyStartedAt = undefined;
    owner.queue.push({ type: 'background', parts: [{ text: 'must stay queued' }] });
    throw new Error('adversarial release rejected');
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'done' }] });
    return { text: 'done' };
  };
  try {
    await assert.rejects(
      () => new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id),
      /adversarial release rejected/,
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.busy, false);
    assert.equal(session.queue.length, 1);
    assert.equal(chatCount, 1);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('successful finish-window input still starts the next processor', async () => {
  const session = createSession(`detached_runner_finish_window_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let injected = false;
  let chatCount = 0;
  effects.updateBusy = async (owner, busy) => {
    if (!busy && !injected) {
      injected = true;
      owner.queue.push({ type: 'background', parts: [{ text: 'second turn' }] });
    }
    return originalUpdateBusy(owner, busy);
  };
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${chatCount}` }] });
    return { text: `done-${chatCount}` };
  };
  try {
    await new SessionTurnRunner(new LocalSessionTurnHost(effects, session)).processSessionQueue(session.id);
    for (let attempt = 0; attempt < 100 && (chatCount < 2 || session.busy); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(chatCount, 2);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
  } finally {
    (llm as any).chat = originalChat;
  }
});

test('failed spawned finish-window claim is logged once and remains explicitly retryable', async () => {
  const session = createSession(`detached_runner_spawn_failure_${Date.now()}`, 'first turn');
  const effects = createEffects(session, []);
  const originalUpdateBusy = effects.updateBusy;
  let injected = false;
  let claimAttempt = 0;
  let chatCount = 0;
  effects.updateBusy = (owner, busy) => {
    if (busy) {
      claimAttempt += 1;
      if (claimAttempt === 2) {
        return sessionManager.updateSessionBusyStateForSession(
          owner,
          true,
          async () => { throw new Error('spawned claim persist rejected'); },
          effects.clearRuntimeState,
          () => {},
        );
      }
    } else if (!injected) {
      injected = true;
      owner.queue.push({ type: 'background', parts: [{ text: 'spawned second turn' }] });
    }
    return originalUpdateBusy(owner, busy);
  };
  const originalChat = llm.chat;
  const originalLoggerError = logger.error;
  const logged: Array<{ details: any; message: string }> = [];
  (logger as any).error = (details: any, message: string) => { logged.push({ details, message }); };
  (llm as any).chat = async (parts: any, _owner: Session, _iteration: number, options: any) => {
    chatCount += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: `done-${chatCount}` }] });
    return { text: `done-${chatCount}` };
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  try {
    await runner.processSessionQueue(session.id);
    for (let attempt = 0; attempt < 100 && logged.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(chatCount, 1);
    assert.equal(claimAttempt, 2);
    assert.equal(session.busy, false);
    assert.equal(session.busyStartedAt, undefined);
    assert.equal(session.queue.length, 1);
    assert.deepEqual(unhandled, []);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].details.sessionId, session.id);
    assert.match(String(logged[0].details.err?.message), /spawned claim persist rejected/);
    assert.equal(logged[0].message, 'Trailing queued work failed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claimAttempt, 2, 'failed spawned processor must not start a third processor');

    await runner.processSessionQueue(session.id);
    assert.equal(claimAttempt, 3);
    assert.equal(chatCount, 2);
    assert.equal(session.queue.length, 0);
    assert.equal(session.busy, false);
    assert.equal(logged.length, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    (llm as any).chat = originalChat;
    (logger as any).error = originalLoggerError;
  }
});

test('base effects fallback persists both busy transitions with one notification each', async () => {
  const session = createSession(`detached_runner_base_busy_${Date.now()}`, 'unused');
  session.queue = [];
  const persistedBusy: boolean[] = [];
  const notified: string[] = [];
  const originalNotify = sessionManager.notifySessionStateUpdated;
  (sessionManager as any).notifySessionStateUpdated = (sessionId: string) => { notified.push(sessionId); };
  const effects: llm.CurrentSessionEffects = {
    placement: 'local',
    appendMessage: async () => {},
    persistSession: async owner => { persistedBusy.push(owner.busy); },
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
  };
  try {
    const host = new LocalSessionTurnHost(effects, session);
    await host.updateSessionBusyState(session, true);
    await host.updateSessionBusyState(session, false);
    assert.deepEqual(persistedBusy, [true, false]);
    assert.deepEqual(notified, [session.id, session.id]);
  } finally {
    (sessionManager as any).notifySessionStateUpdated = originalNotify;
  }
});

test('full turn effects own both busy persistence and notification exactly once', async () => {
  const session = createSession(`detached_runner_full_busy_${Date.now()}`, 'unused');
  session.queue = [];
  const events: string[] = [];
  const host = new LocalSessionTurnHost(createEffects(session, events), session);
  await host.updateSessionBusyState(session, true);
  await host.updateSessionBusyState(session, false);
  assert.deepEqual(events.filter(event => event.startsWith('persist:')), ['persist:busy:0', 'persist:idle:0']);
  assert.deepEqual(events.filter(event => event.startsWith('state:')), [`state:${session.id}`, `state:${session.id}`]);
});

test('default unbound busy claim honors destructive fencing while bound custom effects stay independent', async () => {
  const session = createSession(`detached_runner_destructive_claim_${Date.now()}`, 'unused');
  session.queue = [];
  sessionManager.getAllSessions().set(session.id, session);
  const claim = await sessionManager.claimSessionsForDestructiveLifecycle([session.id]);
  const originalSave = sessionManager.saveSession;
  let defaultPersistCount = 0;
  (sessionManager as any).saveSession = async () => { defaultPersistCount += 1; };
  try {
    const defaultHost = new LocalSessionTurnHost();
    assert.throws(
      () => defaultHost.updateSessionBusyState(session, true),
      /prepared for deletion/,
    );
    assert.equal(session.busy, false);
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'busyStartedAt'), false);
    assert.equal(defaultPersistCount, 0);

    const events: string[] = [];
    const boundHost = new LocalSessionTurnHost(createEffects(session, events), session);
    await boundHost.updateSessionBusyState(session, true);
    assert.equal(session.busy, true);
    assert.equal(events.filter(event => event.startsWith('persist:')).length, 1);
    await boundHost.updateSessionBusyState(session, false);
  } finally {
    (sessionManager as any).saveSession = originalSave;
    sessionManager.releaseSessionsForDestructiveLifecycle(claim.claimId);
    sessionManager.getAllSessions().delete(session.id);
  }
});
