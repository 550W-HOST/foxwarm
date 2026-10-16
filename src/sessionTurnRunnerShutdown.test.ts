import assert from 'node:assert/strict';
import test from 'node:test';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { ChatResult, Message, Session } from './types';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('request aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

function fixture() {
  const session = {
    id: 'shutdown-owner', agent: 'main', history: [], queue: [{ type: 'user', parts: [{ text: 'input' }] }],
    busy: false, persistentMemorySnapshot: 'test prompt', snapshotUpdatedAt: Date.now(), systemPromptFiles: [],
    stats: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, lastUsage: null },
    meta: { lastMessageTime: Date.now() },
  } as Session;
  const snapshots: Array<{ busy: boolean; queue: unknown[]; history: Message[] }> = [];
  const broadcasts: string[] = [];
  session.broadcast = text => { broadcasts.push(text); };
  let activeAbort: AbortController | undefined;
  const persist = async () => {
    snapshots.push(structuredClone({ busy: session.busy, queue: session.queue, history: session.history }));
  };
  const append = async (_owner: Session, messages: Message[]) => {
    session.history.push(...messages);
    await persist();
  };
  const effects: llm.CurrentSessionTurnEffects = {
    placement: 'local',
    appendMessage: (owner, message) => append(owner, [message]),
    appendMessages: append,
    appendQueuedMessages: append,
    persistSession: persist,
    updateBusy: (_owner, busy) => sessionManager.updateSessionBusyStateForSession(session, busy, persist, () => {}),
    startWait: (_owner, options) => sessionManager.startSessionWaitForSession(session, options, persist),
    notifyHistoryUpdate: () => {}, notifySessionEvent: () => {}, setRuntimeState: () => {}, clearRuntimeState: () => {},
    registerAbortController: (_id, controller) => { activeAbort = controller; },
    clearAbortController: () => { activeAbort = undefined; }, clearWaitById: async () => false,
  };
  const state = {
    chatCalls: 0, toolCalls: 0,
    chat: async (_signal: AbortSignal): Promise<ChatResult> => ({ text: 'answer' }),
    tools: async (_signal: AbortSignal): Promise<Message> => ({ role: 'tool', parts: [{ functionResponse: {
      name: 'read', tool_use_id: 'call', response: { output: 'done' },
    } }] }),
  };
  class Host extends LocalSessionTurnHost {
    override get chat(): typeof llm.chat {
      return async () => {
        state.chatCalls++;
        const controller = new AbortController();
        activeAbort = controller;
        try {
          const result = await state.chat(controller.signal);
          await append(session, [{ role: 'model', parts: result.toolCalls?.map(functionCall => ({ functionCall })) || [{ text: result.text }] }]);
          return result;
        } finally { activeAbort = undefined; }
      };
    }
    override get executeTools(): typeof llm.executeTools {
      return async () => {
        state.toolCalls++;
        const controller = new AbortController();
        activeAbort = controller;
        try { return await state.tools(controller.signal); }
        finally { activeAbort = undefined; }
      };
    }
  }
  const host = new Host(effects, session, {
    refreshSessionSnapshot: async () => ({ sessionId: session.id, agentName: 'main' }), hasCompletedCompactJob: () => false,
    checkAndCompactIfNeeded: async () => {}, finishChannelProgress: async () => {},
  });
  const runner = new SessionTurnRunner(host);
  const abort = () => {
    if (!activeAbort) return false;
    activeAbort.abort();
    activeAbort = undefined;
    return true;
  };
  return { session, host, runner, state, snapshots, broadcasts, abort };
}

const toolResult: ChatResult = { text: '', toolCalls: [{ id: 'call', name: 'read', args: { filePath: 'test.txt' } }] };

test('shutdown leaves a returned tool call interrupted and rejects new queue/retry owners', async () => {
  const f = fixture();
  const entered = deferred();
  const result = deferred<ChatResult>();
  f.state.chat = async () => { entered.resolve(); return result.promise; };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  const shutdown = f.runner.shutdown(f.abort);
  assert.strictEqual(f.runner.shutdown(f.abort), shutdown);
  f.session.queue.push({ type: 'user', parts: [{ text: 'later input' }] });
  await f.host.saveSession(f.session);
  await f.runner.processSessionQueue(f.session.id);
  await assert.rejects(f.runner.processSessionRetry(f.session.id), { code: 'SESSION_TURN_SHUTTING_DOWN' });
  result.resolve(toolResult);
  await Promise.all([running, shutdown]);
  assert.equal(f.state.chatCalls, 1);
  assert.equal(f.state.toolCalls, 0, 'shutdown must not dispatch the returned new tool');
  assert.equal(f.snapshots.at(-1)!.busy, true);
  assert.equal(f.snapshots.at(-1)!.queue.length, 1);
  assert.equal(f.session.history.length, 2);
  assert.ok(!JSON.stringify(f.session.history).includes('Error:'));
});

test('a final provider answer that settles after admission closes remains terminal and preserves later input', async () => {
  const f = fixture();
  const entered = deferred();
  const result = deferred<ChatResult>();
  f.state.chat = async () => { entered.resolve(); return result.promise; };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  const shutdown = f.runner.shutdown(f.abort);
  f.session.queue.push({ type: 'user', parts: [{ text: 'next turn' }] });
  result.resolve({ text: 'final answer' });
  await Promise.all([running, shutdown]);
  assert.equal(f.session.busy, false);
  assert.equal(f.session.queue.length, 1);
  assert.equal(f.state.chatCalls, 1, 'neither the outer loop nor trailing handoff may start later work');
  assert.deepEqual(f.broadcasts, ['final answer']);
});

test('closing admission during an awaited lookup leaves queued input unclaimed', async () => {
  const f = fixture();
  const lookup = deferred<Session>();
  f.host.getExistingSession = async () => lookup.promise;
  const running = f.runner.processSessionQueue(f.session.id);
  const shutdown = f.runner.shutdown(f.abort);
  lookup.resolve(f.session);
  await Promise.all([running, shutdown]);
  assert.equal(f.state.chatCalls, 0);
  assert.equal(f.session.busy, false);
  assert.equal(f.session.queue.length, 1);
  assert.equal(f.snapshots.length, 0, 'shutdown must not create a busy claim after the lookup');
});

test('a selected input batch commits before shutdown yields its recovery checkpoint', async () => {
  const f = fixture();
  const selected = deferred();
  const commit = deferred();
  const append = f.host.appendQueuedSessionMessages.bind(f.host);
  f.host.appendQueuedSessionMessages = async (owner, messages) => {
    selected.resolve();
    await commit.promise;
    await append(owner, messages);
  };
  const running = f.runner.processSessionQueue(f.session.id);
  await selected.promise;
  assert.equal(f.session.queue.length, 0, 'the batch has been selected but not yet appended');
  const shutdown = f.runner.shutdown(f.abort);
  commit.resolve();
  await Promise.all([running, shutdown]);
  assert.equal(f.state.chatCalls, 0);
  assert.equal(f.snapshots.at(-1)!.busy, true);
  assert.ok(f.snapshots.at(-1)!.history[0].parts.some(part => part.text === 'input'));
});

test('finish-window triggering input stays durable without a new trailing processor', async () => {
  const f = fixture();
  const entered = deferred();
  const result = deferred<ChatResult>();
  f.state.chat = async () => { entered.resolve(); return result.promise; };
  const updateBusy = f.host.updateSessionBusyState.bind(f.host);
  f.host.updateSessionBusyState = async (owner, busy) => {
    await updateBusy(owner, busy);
    if (!busy) {
      owner.queue.push({ type: 'user', parts: [{ text: 'finish-window input' }] });
      await f.host.saveSession(owner);
    }
  };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  const shutdown = f.runner.shutdown(f.abort);
  result.resolve({ text: 'done' });
  await Promise.all([running, shutdown]);
  assert.equal(f.state.chatCalls, 1);
  assert.equal(f.snapshots.at(-1)!.busy, false);
  assert.equal(f.snapshots.at(-1)!.queue.length, 1);
});

test('user Stop during shutdown retains passive-finalization semantics', async () => {
  const f = fixture();
  const entered = deferred();
  f.state.chat = async signal => { entered.resolve(); return aborted(signal); };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  const shutdown = f.runner.shutdown(f.abort);
  f.session.queue.push({ type: 'user', parts: [{ text: 'passive Stop input' }] });
  f.session.stopping = true;
  f.abort();
  await Promise.all([running, shutdown]);
  assert.equal(f.session.busy, false);
  assert.equal(f.session.queue.length, 0);
  assert.equal(f.session.history.at(-1)!.parts[0].text, 'passive Stop input');
  assert.equal(f.state.chatCalls, 1);
});

test('shutdown cancellation of a pending provider keeps busy without a terminal error row', async () => {
  const f = fixture();
  const entered = deferred();
  f.state.chat = async signal => { entered.resolve(); return aborted(signal); };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  await f.runner.shutdown(f.abort, { graceMs: 0, cancelMs: 100 });
  await running;
  assert.equal(f.session.busy, true);
  assert.deepEqual(f.session.history.map(row => row.role), ['user']);
  assert.deepEqual(f.broadcasts, []);
});

for (const terminal of ['finish', 'wait'] as const) {
  test(`a successful ${terminal} handoff that settles during shutdown remains idle`, async () => {
    const f = fixture();
    const entered = deferred();
    const tools = deferred<Message>();
    f.state.chat = async () => toolResult;
    f.state.tools = async () => { entered.resolve(); return tools.promise; };
    const running = f.runner.processSessionQueue(f.session.id);
    await entered.promise;
    const shutdown = f.runner.shutdown(f.abort);
    tools.resolve({ role: 'tool', parts: [], ...(terminal === 'finish'
      ? { __toolLoopControl: { stopCurrentTurn: true } }
      : { __toolPostAction: { waitForReply: true } }) } as Message);
    await Promise.all([running, shutdown]);
    assert.equal(f.session.busy, false);
    assert.equal(!!f.session.meta.wait, terminal === 'wait');
    assert.equal(f.state.chatCalls, 1);
  });
}

test('a tool that ignores cancellation makes drain fail, never a false successful shutdown', async () => {
  const f = fixture();
  const entered = deferred();
  const tools = deferred<Message>();
  f.state.chat = async () => toolResult;
  f.state.tools = async () => { entered.resolve(); return tools.promise; };
  const running = f.runner.processSessionQueue(f.session.id);
  await entered.promise;
  await assert.rejects(f.runner.shutdown(f.abort, { graceMs: 0, cancelMs: 5 }), { code: 'SESSION_TURN_DRAIN_TIMEOUT' });
  assert.equal(f.session.busy, true);
  // Test cleanup releases the actual operation; the closed admission still
  // prevents its next provider request or a new processor.
  tools.resolve({ role: 'tool', parts: [] });
  await running;
  assert.equal(f.session.busy, true);
  assert.equal(f.state.chatCalls, 1);
});
