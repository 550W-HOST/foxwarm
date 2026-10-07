import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import type { ChatResult, Message, MessagePart, Session } from '../types';
import type { SessionHistoryDeps } from './history';
import { SessionAuthorityPostCommitError } from './stateFile';

process.env.FOXWARM_SYNC_FILE_LOG = '1';

const SAVE_GENERATED_SESSION_LOGS = process.env.FOXWARM_SAVE_GENERATED_COMPACT_RETRY_TEST_LOGS === '1';

type LoadedDeps = {
  tempRoot: string;
  sessionHistory: typeof import('./history');
  archive: typeof import('./archive');
  layeredContext: typeof import('./layeredContext');
  compactPlan: typeof import('./compactPlan');
  llm: typeof import('../llm');
};

let depsPromise: Promise<LoadedDeps> | null = null;

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function flattenPrompt(parts: MessagePart[] | null | undefined): string {
  return (parts || [])
    .map(part => part.system || part.text || '')
    .join('\n');
}

async function loadDeps(): Promise<LoadedDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-compact-plan-retry-'));
      process.env.FOXWARM_DATA_DIR = tempRoot;

      const [sessionHistory, archive, layeredContext, compactPlan, llm] = await Promise.all([
        import('./history'),
        import('./archive'),
        import('./layeredContext'),
        import('./compactPlan'),
        import('../llm'),
      ]);

      return { tempRoot, sessionHistory, archive, layeredContext, compactPlan, llm };
    })();
  }

  return depsPromise;
}

async function makeCompactableSession(archive: LoadedDeps['archive'], sessionId: string): Promise<Session> {
  const session: Session = {
    id: sessionId,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 1,
    nextBlockId: 1,
        historyVersion: 0,
    promptCacheKey: '11111111-2222-3333-4444-555555555555',
  } as Session;

  const messages: Message[] = [
    { role: 'user', parts: [{ text: `older user message ${'alpha '.repeat(3000)}` }], __meta: { timestamp: 1000 } },
    { role: 'model', parts: [{ text: `older model response ${'bravo '.repeat(3000)}` }], __meta: { timestamp: 2000 } },
    { role: 'user', parts: [{ text: 'recent user message kept outside compact range' }], __meta: { timestamp: 3000 } },
    { role: 'model', parts: [{ text: 'recent model response kept outside compact range' }], __meta: { timestamp: 4000 } },
  ];

  await archive.appendMessagesToArchive(session, messages);
  session.history = messages;

  return session;
}

function makeDepsForSession(session: Session, saveCounter: { count: number }): SessionHistoryDeps {
  return {
    getSessionById: (sessionId: string) => sessionId === session.id ? session : undefined,
    getExistingSession: async (sessionId: string) => sessionId === session.id ? session : null,
    saveSession: async (_sessionId: string) => { saveCounter.count += 1; },
    enqueueSessionItem: async (_sessionId: string, _item: any) => {},
    notifyHistoryUpdate: (_sessionId: string, _message: Message) => {},
  };
}

function trackCompactionRuntime(deps: ReturnType<typeof makeDepsForSession>, initial = 'running-tool:create_child_session') {
  let current = initial;
  const events: string[] = [];
  deps.beginCompactionRuntimeState = (_sessionId: string) => {
    current = 'requesting-model:compaction';
    events.push(current);
    return () => {
      if (current !== 'requesting-model:compaction') return;
      current = 'idle';
      events.push(current);
    };
  };
  return { get current() { return current; }, events };
}

test('awaited compaction replaces a completed tool phase while its provider is held, then releases it', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_runtime_held'));
  const deps = makeDepsForSession(session, { count: 0 });
  const runtime = trackCompactionRuntime(deps);
  const originalChat = llm.chat;
  let providerEntered!: () => void; let releaseProvider!: () => void;
  const entered = new Promise<void>(resolve => { providerEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseProvider = resolve; });
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      providerEntered();
      await release;
      const toolCall = { id: 'held-runtime', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'held provider runtime summary',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await');
    await entered;
    assert.equal(runtime.current, 'requesting-model:compaction');
    releaseProvider();
    await running;
    assert.equal(runtime.current, 'idle');
    assert.deepEqual(runtime.events, ['requesting-model:compaction', 'idle']);
  } finally { (llm as any).chat = originalChat; }
});

test('awaited no-op compaction releases its transient runtime phase without calling the planner', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_runtime_noop'));
  const before = structuredClone(session.history);
  const deps = makeDepsForSession(session, { count: 0 });
  const runtime = trackCompactionRuntime(deps);
  const originalChat = llm.chat;
  let calls = 0;
  try {
    (llm as any).chat = async () => { calls += 1; throw new Error('no-op must not call the planner'); };
    session.history = [];
    await sessionHistory.processSessionCompactionRequest(deps, session.id, {}, 'await');
    session.history = structuredClone(before);
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 1 }, 'await');
    assert.deepEqual(session.history, before);
    assert.equal(calls, 0);
    assert.equal(runtime.current, 'idle');
    assert.deepEqual(runtime.events, ['requesting-model:compaction', 'idle', 'requesting-model:compaction', 'idle']);
  } finally { (llm as any).chat = originalChat; }
});

test('compact planning retries plain-text/no-tool response and succeeds on a later submit_compact_plan call', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const { writeAuthoritativeSessionState } = await import('./stateFile');
  const { getSessionHistoryFilePath, readSessionHistorySnapshot } = await import('./metadataStore');
  const { estimateSessionTokens } = await import('../tokenCount');
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_plain_text_success'));
  session.stats = { totalCachedTokens: 9000, totalInputTokens: 8000, totalOutputTokens: 7000,
    lastUsage: { cachedTokens: 6000, inputTokens: 5000, outputTokens: 4000 } };
  const parentStats = structuredClone(session.stats);
  const saveCounter = { count: 0 };
  const prompts: string[] = [];
  const purposes: Array<string | undefined> = [];
  const originalChat = llm.chat;
  const originalBuild = llm.buildSessionSystemPromptSnapshotForSession;
  session.effort = 'none';
  session.childEffortDefault = 'max';
  session.systemPromptFiles = ['custom-memory.md'];
  const before = structuredClone(session.history);

  try {
    (llm as any).buildSessionSystemPromptSnapshotForSession = async (activeSession: Session) => activeSession.persistentMemorySnapshot;
    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void; purpose?: string; compactPlanBackground?: boolean; snapshotAuthority?: string },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
      assert.equal(activeSession.effort, 'none');
      assert.equal(activeSession.childEffortDefault, 'max');
      assert.equal(activeSession.nextMessageSeq, session.nextMessageSeq);
      assert.equal(activeSession.historyVersion, session.historyVersion);
      assert.equal(activeSession.promptCacheKey, session.promptCacheKey);
      assert.deepEqual(activeSession.history.slice(0, 2), before.slice(0, 2));
      assert.deepEqual(session.history, before);
      assert.doesNotMatch(JSON.stringify(activeSession.history), /recent (user message|model response) kept outside compact range/);
      assert.doesNotMatch(flattenPrompt(parts), /recent (user message|model response) kept outside compact range/);
      if (prompts.length === 0) assert.equal(activeSession.history.length, 2);
      else {
        assert.equal(activeSession.history.length, 4);
        assert.equal(flattenPrompt(activeSession.history[2].parts), prompts[0]);
      }
      assert.deepEqual(activeSession.systemPromptFiles, ['custom-memory.md']);
      assert.equal(options?.snapshotAuthority, 'detached');
      assert.equal(options?.compactPlanBackground, undefined);
      prompts.push(flattenPrompt(parts));
      purposes.push(options?.purpose);
      if (parts) await Promise.resolve(options?.appendMessage?.({ role: 'user', parts }));

      if (prompts.length === 1) {
        const text = 'I can summarize this in plain text, but I forgot the tool call.';
        const usage = { cachedTokens: 5, inputTokens: 10, outputTokens: 7, reasoningTokens: 3 };
        await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ thinking: 'planner reasoning' }, { text }], __meta: { usage } }));
        activeSession.stats.totalInputTokens += usage.inputTokens;
        return { text, usage, toolCalls: [], allParts: [{ text }] };
      }

      const toolCall = {
        id: 'compact-plan-after-plain-text',
        name: 'submit_compact_plan',
        args: {
          replaceAsBlocks: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary after retrying a missing compact tool call',
          }]),
        },
      };
      const usage = { cachedTokens: 2, inputTokens: 20, outputTokens: 8 };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }],
        providerMeta: { sourceModelId: 'fixture/planner', providerSpecificFields: { opaque: 'retained' } }, __meta: { usage } }));
      activeSession.stats.totalInputTokens += usage.inputTokens;
      return { text: '', usage, toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    const deps = makeDepsForSession(session, saveCounter);
    deps.saveSession = async () => { saveCounter.count += 1; await writeAuthoritativeSessionState(session); };
    await sessionHistory.processSessionCompactionRequest(
      deps,
      session.id,
      { keepPercent: 0.5 },
      'await',
    );

    assert.equal(prompts.length, 2);
    assert.deepEqual(purposes, ['compact-plan', 'compact-plan']);
    assert.match(prompts[0], /COMPACTION STARTED/);
    assert.match(prompts[0], /Recent messages \(2 rendered item\(s\), #3-#4\)/);
    assert.deepEqual(session.history.filter(message => [3, 4].includes(message.__meta?.seq || 0)), before.slice(2));
    assert.match(prompts[1], /COMPACT TOOL CALL INVALID/);
    assert.match(prompts[1], /plain text\/no tool call cannot complete compaction/i);
    assert.match(prompts[1], /submit_compact_plan/);
    assert(session.history.some(message => message.parts.some(part => /summary after retrying a missing compact tool call/.test(part.text || ''))));
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))));
    assert.equal(session.history[0]?.__meta?.contextBlock?.level, 1);
    const completion = session.history.at(-1)!;
    const planner = completion.compaction?.planner;
    assert(planner);
    assert.equal(completion.__meta?.compaction, undefined);
    assert.equal(planner.steps, 2);
    assert.deepEqual(planner.toolCalls.map(call => call.id), ['compact-plan-after-plain-text']);
    assert.deepEqual(planner.usage, { cachedTokens: 7, inputTokens: 30, outputTokens: 15, reasoningTokens: 3 });
    assert.deepEqual(session.stats, parentStats, 'detached planner usage never changes parent totals');
    assert.deepEqual(planner.messages.map(message => message.role), ['user', 'model', 'user', 'model']);
    assert.equal(flattenPrompt(planner.messages[0].parts), prompts[0]);
    assert.equal(flattenPrompt(planner.messages[2].parts), prompts[1]);
    assert.equal(planner.messages[1].parts[0].thinking, 'planner reasoning');
    assert.deepEqual(planner.messages[3].providerMeta?.providerSpecificFields, { opaque: 'retained' });
    assert(planner.messages.every(message => message.__meta?.seq === undefined), 'inherited history rows are not copied into planner messages');
    assert.doesNotMatch(JSON.stringify(planner.messages), /recent user message/);
    const persisted = await readSessionHistorySnapshot(session.id);
    assert.deepEqual(persisted?.history.at(-1).compaction, completion.compaction);
    const archived = await archive.readArchiveMessagesBySeqRange(session.id, completion.__meta!.seq, completion.__meta!.seq);
    assert.deepEqual(archived[0].message.compaction, completion.compaction);
    const withoutDebug = { ...session, history: session.history.map(({ compaction: _compaction, ...message }) => message) };
    assert.equal(estimateSessionTokens(session), estimateSessionTokens(withoutDebug));
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).buildSessionSystemPromptSnapshotForSession = originalBuild;
    await fs.remove(getSessionHistoryFilePath(session.id));
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('provider-free display-only cleanup does not fabricate planner diagnostics', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_display_only_debug'));
  session.history.slice(0, 2).forEach(message => { message.modelVisible = false; });
  const originalChat = llm.chat;
  try {
    (llm as any).chat = async () => { throw new Error('display-only cleanup must not call the planner'); };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'await');
    assert.equal(session.history.length, 3);
    const completion = session.history.at(-1)!;
    assert(completion.parts.some(part => part.system?.includes('event="compact-completed"')));
    assert.equal(completion.compaction, undefined);
    const archived = await archive.readArchiveMessagesBySeqRange(session.id, completion.__meta!.seq, completion.__meta!.seq);
    assert.equal(archived[0].message.compaction, undefined);
  } finally { (llm as any).chat = originalChat; }
});

test('awaited compact cancellation aborts its provider signal without changing history', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_awaited'));
  const before = structuredClone(session.history);
  const saveCounter = { count: 0 };
  const deps = makeDepsForSession(session, saveCounter);
  const runtime = trackCompactionRuntime(deps);
  const originalChat = llm.chat;
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      assert(options?.abortSignal instanceof AbortSignal);
      providerStarted();
      await new Promise<void>((_resolve, reject) => options.abortSignal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }, { once: true }));
      throw new Error('unreachable');
    };
    const running = sessionHistory.processSessionCompactionRequest(
      deps, session.id, { keepPercent: 0.5 }, 'await', 'standalone',
    );
    await started;
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), false);
    const cancelled = await sessionHistory.cancelSessionCompaction(deps, session.id);
    await running;
    assert.deepEqual(cancelled, { outcome: 'cancelled', phase: 'planning' });
    assert.deepEqual(session.history, before);
    assert.equal(sessionHistory.getCompactOperationOwner(session.id), undefined);
    assert.equal(runtime.current, 'idle');
  } finally { (llm as any).chat = originalChat; }
});

test('ready background compact cancellation durably removes only compact commits and is idempotent', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_ready'));
  const before = structuredClone(session.history);
  const saves = { count: 0 };
  const originalChat = llm.chat;
  const ordinary = { type: 'background', parts: [{ text: 'ordinary queued work' }] } as any;
  session.queue.push(ordinary);
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      assert.equal(options.compactPlanBackground, true);
      const toolCall = { id: 'cancel-ready', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'ready but cancelled',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, saves);
    let foregroundRuntimePublications = 0;
    deps.beginCompactionRuntimeState = () => { foregroundRuntimePublications += 1; return () => {}; };
    deps.enqueueSessionItem = async (_id: string, item: any) => { session.queue.push(item); };
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'background', 'background');
    for (let index = 0; index < 100 && !session.queue.some(item => item.type === 'compact-commit'); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(session.queue.some(item => item.type === 'compact-commit'));
    const cancelled = await sessionHistory.cancelSessionCompaction(deps, session.id);
    assert.deepEqual(cancelled, { outcome: 'cancelled', phase: 'ready' });
    assert.deepEqual(session.queue, [ordinary]);
    assert.deepEqual(session.history, before);
    assert.equal((await sessionHistory.cancelSessionCompaction(deps, session.id)).outcome, 'none');
    assert(saves.count > 0);
    assert.equal(foregroundRuntimePublications, 0);
  } finally { (llm as any).chat = originalChat; }
});

test('background request without an enqueue dependency uses awaited compact-plan scope', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_background_sync_fallback'));
  const originalChat = llm.chat;
  let calls = 0;
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      calls += 1;
      assert.equal(options.compactPlanBackground, undefined);
      const toolCall = { id: 'sync-fallback', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'synchronous fallback summary',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, { count: 0 });
    delete deps.enqueueSessionItem;
    await sessionHistory.processSessionCompactionRequest(
      deps, session.id, { keepPercent: 0.5 }, 'background', 'background',
    );
    assert.equal(calls, 1);
    assert.equal(session.history[0]?.__meta?.contextBlock?.level, 1);
  } finally { (llm as any).chat = originalChat; }
});

test('background enqueue/cancel race waits for producer cleanup and preserves ordinary queue order', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_enqueue_race'));
  const originalChat = llm.chat;
  const first = { type: 'background', parts: [{ text: 'first' }] } as any;
  const second = { type: 'background', parts: [{ text: 'second' }] } as any;
  session.queue.push(first, second);
  let enqueueEntered!: () => void; let releaseEnqueue!: () => void;
  const entered = new Promise<void>(resolve => { enqueueEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseEnqueue = resolve; });
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'enqueue-race', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'ready enqueue race',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, { count: 0 });
    deps.enqueueSessionItem = async (_id: string, item: any) => {
      session.queue.push(item); enqueueEntered(); await release;
    };
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'background', 'background');
    await entered;
    let resolved = false;
    const cancellation = sessionHistory.cancelSessionCompaction(deps, session.id).then(result => { resolved = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resolved, false, 'cancellation must await the in-flight enqueue producer');
    releaseEnqueue();
    assert.deepEqual(await cancellation, { outcome: 'cancelled', phase: 'enqueueing' });
    assert.deepEqual(session.queue, [first, second]);
  } finally { (llm as any).chat = originalChat; }
});

test('a consumed job waiting for its enqueue callback cannot erase a newer ready job', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_late_enqueue_new_job'));
  const ordinary = { type: 'user', parts: [{ text: 'ordinary input survives both jobs' }] } as any;
  session.queue.push(ordinary);
  const deps = makeDepsForSession(session, { count: 0 });
  const originalChat = llm.chat;
  let enqueueEntered!: () => void; let releaseEnqueue!: () => void;
  const entered = new Promise<void>(resolve => { enqueueEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseEnqueue = resolve; });
  let enqueueCount = 0;
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'before-late-enqueue', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'first consumed compact job',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    deps.enqueueSessionItem = async (_id: string, item: any) => {
      enqueueCount += 1;
      if (enqueueCount === 1) { enqueueEntered(); await release; }
      session.queue.push(item);
      await deps.saveSession(session.id);
    };
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'background');
    await entered;
    assert.equal(sessionHistory.getCompactOperationPhase(session.id), 'enqueueing');
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), true);
    assert.deepEqual(session.queue, [ordinary], 'completed state precedes wake-signal insertion');
    assert.equal(await sessionHistory.applyCompletedCompactJob(deps, session.id), true);
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), false);
    assert.deepEqual(session.queue, [ordinary]);

    // The newly compacted, short history yields a real no-op job without a provider call.
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0 }, 'background');
    for (let index = 0; index < 100 && sessionHistory.getCompactOperationPhase(session.id) !== 'ready'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), true);
    assert.equal(sessionHistory.getCompactOperationPhase(session.id), 'ready');
    assert.equal(enqueueCount, 2);
    releaseEnqueue();
    for (let index = 0; index < 100 && session.queue.length < 3; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.queue.length, 3);
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), true, 'late old producer leaves the new result owned');
    assert.deepEqual(await sessionHistory.cancelSessionCompaction(deps, session.id), { outcome: 'cancelled', phase: 'ready' });
    assert.deepEqual(session.queue, [ordinary]);
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), false);
  } finally { releaseEnqueue(); (llm as any).chat = originalChat; }
});

test('pre-existing compact commit still reaches ready cancellation completion without stranding the producer', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_existing_commit'));
  const originalChat = llm.chat;
  const ordinary = { type: 'background', parts: [{ text: 'ordinary before existing compact' }] } as any;
  session.queue.push(ordinary, { type: 'compact-commit' } as any);
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'existing-commit', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'new result behind existing commit',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, { count: 0 });
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'background', 'background');
    for (let index = 0; index < 100 && sessionHistory.getCompactOperationPhase(session.id) !== 'ready'; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sessionHistory.getCompactOperationPhase(session.id), 'ready');
    assert.deepEqual(await sessionHistory.cancelSessionCompaction(deps, session.id), { outcome: 'cancelled', phase: 'ready' });
    assert.deepEqual(session.queue, [ordinary]);
  } finally { (llm as any).chat = originalChat; }
});

test('compact cancellation reports completed when the authoritative commit race is already in progress', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_commit_race'));
  const originalChat = llm.chat;
  let saveEntered!: () => void;
  let releaseSave!: () => void;
  const entered = new Promise<void>(resolve => { saveEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseSave = resolve; });
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'commit-race', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'committing result',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, { count: 0 });
    deps.saveSession = async () => { saveEntered(); await release; };
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await', 'standalone');
    await entered;
    const cancellation = sessionHistory.cancelSessionCompaction(deps, session.id);
    releaseSave();
    assert.deepEqual(await cancellation, { outcome: 'completed', phase: 'committing' });
    await running;
    assert(session.history.some(message => !!message.__meta?.contextBlock));
  } finally { (llm as any).chat = originalChat; }
});

test('post-authority save failure marks concurrent cancellation completed and never rolls back', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_postcommit_error'));
  const originalChat = llm.chat;
  let saveEntered!: () => void; let releaseSave!: () => void;
  const entered = new Promise<void>(resolve => { saveEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseSave = resolve; });
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'postcommit-error', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'authority committed before projection error',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    const deps = makeDepsForSession(session, { count: 0 });
    deps.saveSession = async () => {
      saveEntered(); await release;
      throw new SessionAuthorityPostCommitError('authority committed; projection failed');
    };
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await', 'standalone');
    await entered;
    const cancellation = sessionHistory.cancelSessionCompaction(deps, session.id);
    releaseSave();
    await assert.rejects(running, (error: any) => error?.code === 'SESSION_AUTHORITY_POSTCOMMIT_FAILED');
    assert.deepEqual(await cancellation, { outcome: 'completed', phase: 'committing' });
    assert(session.history.some(message => !!message.__meta?.contextBlock));
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))));
  } finally { (llm as any).chat = originalChat; }
});

test('cancellation during final system-prompt snapshot build rolls back before authority replacement', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_snapshot_boundary'));
  const before = structuredClone(session.history);
  const originalChat = llm.chat;
  const originalBuild = llm.buildSessionSystemPromptSnapshotForSession;
  let boundaryEntered!: () => void; let releaseBoundary!: () => void;
  const entered = new Promise<void>(resolve => { boundaryEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseBoundary = resolve; });
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'snapshot-boundary', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must roll back',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    (llm as any).buildSessionSystemPromptSnapshotForSession = async () => { boundaryEntered(); await release; return 'new snapshot'; };
    const deps = makeDepsForSession(session, { count: 0 });
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await', 'standalone');
    await entered;
    const cancellation = sessionHistory.cancelSessionCompaction(deps, session.id);
    releaseBoundary();
    assert.deepEqual(await cancellation, { outcome: 'cancelled', phase: 'committing' });
    await running;
    assert.deepEqual(session.history, before);
    assert.equal((await layeredContext.readArchiveBlocksByIdRange(session.id)).length, 0);
  } finally { (llm as any).chat = originalChat; (llm as any).buildSessionSystemPromptSnapshotForSession = originalBuild; }
});

test('cancellation during completion-message Archive append rolls back blocks and completion rows', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_cancel_completion_archive'));
  const before = structuredClone(session.history);
  const originalChat = llm.chat;
  const originalAppend = archive.appendMessagesToArchive;
  let boundaryEntered!: () => void; let releaseBoundary!: () => void;
  const entered = new Promise<void>(resolve => { boundaryEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseBoundary = resolve; });
  try {
    (llm as any).chat = async (_parts: any, _active: Session, _iteration: number, options: any) => {
      const toolCall = { id: 'completion-archive-boundary', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must roll back archive rows',
      }] } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    (archive as any).appendMessagesToArchive = async (...args: any[]) => {
      boundaryEntered(); await release; return originalAppend(...args as Parameters<typeof originalAppend>);
    };
    const deps = makeDepsForSession(session, { count: 0 });
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await', 'standalone');
    await entered;
    const cancellation = sessionHistory.cancelSessionCompaction(deps, session.id);
    releaseBoundary();
    assert.deepEqual(await cancellation, { outcome: 'cancelled', phase: 'committing' });
    await running;
    assert.deepEqual(session.history, before);
    assert.equal((await layeredContext.readArchiveBlocksByIdRange(session.id)).length, 0);
    assert.equal((await archive.readArchiveMessagesBySeqRange(session.id, 5, 10)).length, 0);
  } finally { (llm as any).chat = originalChat; (archive as any).appendMessagesToArchive = originalAppend; }
});

test('compact planning rejects a block-only plan when raw messages and L1 blocks are both eligible, then repairs it', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_raw_quota'));
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const prompts: string[] = [];

  try {
    // Replace active history with five large L1 blocks followed by two raw messages.
    await archive.appendMessagesToArchive(session, [{
      role: 'user', parts: [{ text: 'archive-only fifth raw source' }], __meta: { timestamp: 5000 },
    }]);
    const blocks = await layeredContext.appendBlocksToArchive(session, Array.from({ length: 5 }, (_, index) => ({
      level: 1,
      sourceKind: 'message' as const,
      sourceStart: index + 1,
      sourceEnd: index + 1,
      rawStartSeq: index + 1,
      rawEndSeq: index + 1,
      summary: `L1 backlog ${index + 1} ${'block-summary '.repeat(1800)}`,
    })));
    session.history = [...blocks.map(layeredContext.renderBlockMessage), ...session.history.slice(0, 2)];
    const before = structuredClone(session.history);

    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
      assert.deepEqual(activeSession.history.slice(0, before.length), before);
      assert.deepEqual(session.history, before);
      if (prompts.length === 0) assert.equal(activeSession.history.length, before.length);
      prompts.push(flattenPrompt(parts));
      const createBlocks = prompts.length === 1
        ? [{
            level: 2,
            sourceKind: 'block',
            sourceStart: blocks[0].id,
            sourceEnd: blocks[1].id,
            summary: 'block-only attempt should fail the raw quota',
          }]
        : [{
            level: 2,
            sourceKind: 'block',
            sourceStart: blocks[0].id,
            sourceEnd: blocks[1].id,
            summary: 'merge the eligible oldest L1 blocks',
          }, {
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 1,
            summary: 'also compact enough eligible raw-message tokens',
          }];
      const toolCall = {
        id: `compact-raw-quota-${prompts.length}`,
        name: 'submit_compact_plan',
        args: { replaceAsBlocks: createBlocks },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(
      makeDepsForSession(session, saveCounter),
      session.id,
      { keepPercent: 0 },
      'await',
    );

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Recent messages \(none\)/);
    assert.match(prompts[0], /Raw messages: .*message-source replaceAsBlocks entries must actually replace at least/i);
    assert.match(prompts[0], /Source L1 blocks: 5 block\(s\).*newest 3 are force-kept.*oldest 2 may be listed/is);
    assert.match(prompts[1], /RAW-MESSAGE HARD QUOTA REQUIRES/i);
    assert.equal(session.history.filter(message => !!message.__meta?.contextBlock).length, 5);
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('block compaction cannot consume a filtered short raw-message barrier', async () => {
  const { sessionHistory, archive, layeredContext } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_block_raw_barrier'));
  const blocks = await layeredContext.appendBlocksToArchive(session, Array.from({ length: 5 }, (_, index) => ({
    level: 1, sourceKind: 'message' as const, sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1,
    summary: `large block ${index + 1} ${'block '.repeat(1800)}`,
  })));
  const shortRaw = structuredClone(session.history[0]);
  shortRaw.parts = [{ text: 'short raw must survive byte-exact' }];
  delete shortRaw.__meta!.seq;
  shortRaw.__meta!.timestamp = 5000;
  await archive.appendMessagesToArchive(session, [shortRaw]);
  session.history = [
    layeredContext.renderBlockMessage(blocks[0]),
    shortRaw,
    ...blocks.slice(1).map(layeredContext.renderBlockMessage),
  ];
  const before = structuredClone(shortRaw);
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.history);
  const firstTwo = built.candidateEntries.filter(entry => entry.item.kind === 'block').slice(0, 2);
  assert.notEqual(firstTwo[0]?.item.segmentId, firstTwo[1]?.item.segmentId);
  assert.deepEqual(session.history[1], before);
});

test('layered candidates consume active call and edited tool responses atomically without archive input', async () => {
  const { sessionHistory } = await loadDeps();
  const call: Message = {
    role: 'model',
    parts: [{ functionCall: { id: 'active-call', name: 'read', args: { path: '/active' } } }],
    __meta: { seq: 1, timestamp: 1000 },
  };
  const response: Message = {
    role: 'tool',
    parts: [{ functionResponse: {
      tool_use_id: 'active-call', name: 'read',
      response: { output: `offline-active-response ${'edited '.repeat(4000)}\n--- [foxwarm: historical tool response pruned] ---` },
    } }],
    __meta: { seq: 2, timestamp: 2000 },
  };

  const built = await sessionHistory.buildLayeredCompactCandidateEntries([call, response]);
  const messages = built.candidateEntries.filter(entry => entry.item.kind === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].item.kind, 'message');
  assert.deepEqual([messages[0].item.startSeq, messages[0].item.endSeq], [1, 2]);
  assert.equal(messages[0].historyStartIndex, 0);
  assert.equal(messages[0].historyEndIndex, 1);
  assert.equal(messages[0].rawStartTimestamp, 1000);
  assert.equal(messages[0].rawEndTimestamp, 2000);
  assert(built.messagePolicy.effectiveMinTokens > 0);
});

test('missing or different immutable raw rows do not affect layered active-history candidates', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const archiveSession = { id: makeSessionId('compact_archive_difference'), agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  const archived: Message[] = [
    { role: 'user', parts: [{ text: 'immutable wording differs' }], __meta: { timestamp: 10 } },
    { role: 'model', parts: [{ text: 'immutable response differs' }], __meta: { timestamp: 20 } },
  ];
  await archive.appendMessagesToArchive(archiveSession, archived);
  const active: Message[] = [
    { role: 'user', parts: [{ text: `active wording ${'alpha '.repeat(3000)}` }], __meta: { seq: 1, timestamp: 1000 } },
    { role: 'model', parts: [{ text: `active response ${'bravo '.repeat(3000)}` }], __meta: { seq: 2, timestamp: 2000 } },
  ];

  const built = await sessionHistory.buildLayeredCompactCandidateEntries(active);
  const messages = built.candidateEntries.filter(entry => entry.item.kind === 'message');
  assert.deepEqual(messages.map(entry => entry.item.kind === 'message' ? [entry.item.startSeq, entry.item.endSeq] : []), [[1, 1], [2, 2]]);
  assert.match(messages[0].item.preview, /active wording/);
  assert.match(messages[1].item.preview, /active response/);
});

test('preserved raw removal eligibility depends on active structure rather than Archive identity', async () => {
  const { sessionHistory, archive, compactPlan } = await loadDeps();
  for (const scenario of ['missing', 'conflicting', 'duplicate'] as const) {
    const session = await makeCompactableSession(archive, makeSessionId(`compact_preserved_${scenario}`));
    const preserved = structuredClone(session.history[0]);
    preserved.__meta!.preservedFromBlockId = 9;
    if (scenario === 'missing') preserved.__meta!.seq = 999;
    if (scenario === 'conflicting') preserved.parts = [{ text: 'offline-edited preserved wording must survive unchanged' }];
    session.history = scenario === 'duplicate'
      ? [preserved, structuredClone(preserved), ...session.history.slice(1)]
      : [preserved, ...session.history.slice(1)];
    const before = structuredClone(session.history);
    const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.history);
    const expectedCount = scenario === 'duplicate' ? 0 : 1;
    assert.equal(built.preservedMessageCandidates.length, expectedCount, scenario);
    const validate = () => compactPlan.validateCompactPlanArgs(
      { replaceAsBlocks: [], removePreservedMessages: [preserved.__meta!.seq] },
      built.candidateEntries.map(entry => entry.item),
      { removablePreservedMessages: built.preservedMessageCandidates },
    );
    if (scenario === 'duplicate') assert.throws(validate, /removePreservedMessages/i, scenario);
    else assert.doesNotThrow(validate, scenario);
    assert.deepEqual(session.history, before, `${scenario} preserved rows remain byte-semantic exact`);
  }
});

test('duplicate, missing, and reversed active raw sequence structure remains a compact barrier', async () => {
  const { sessionHistory } = await loadDeps();
  const make = (seq: number | undefined, label: string): Message => ({
    role: 'user', parts: [{ text: `${label} ${'large '.repeat(2500)}` }],
    __meta: { ...(seq === undefined ? {} : { seq }), timestamp: seq || 99 },
  });
  const duplicate = make(4, 'duplicate');
  const history = [make(1, 'first'), make(undefined, 'missing'), make(2, 'after missing'), make(5, 'reversed first'), make(3, 'reversed second'), duplicate, structuredClone(duplicate)];
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(history);
  const messages = built.candidateEntries.filter(entry => entry.item.kind === 'message');
  assert.deepEqual(messages.map(entry => entry.item.kind === 'message' ? entry.item.startSeq : 0), [1, 2]);
  assert.notEqual(messages[0].item.segmentId, messages[1].item.segmentId, 'missing seq splits otherwise contiguous raw candidates');
  assert.equal(messages.some(entry => entry.item.kind === 'message' && entry.item.startSeq === 5), false, 'forward gap is a barrier');
  assert.equal(messages.some(entry => entry.item.kind === 'message' && entry.item.startSeq === 3), false, 'reversed row is not admitted after seq 5');
  assert.equal(messages.some(entry => entry.item.kind === 'message' && entry.item.startSeq === 4), false, 'duplicate seq rows are not admitted');
});

test('a malformed consecutive tool row is a local barrier after a valid atomic call/response prefix', async () => {
  const { sessionHistory } = await loadDeps();
  const response = (id: string, seq: number | undefined, label: string): Message => ({
    role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response: { output: label } } }],
    __meta: { ...(seq === undefined ? {} : { seq }), timestamp: seq || 99 },
  });
  for (const scenario of [
    { name: 'missing seq after valid response', callSeq: 1, validSeq: 2, malformedSeq: undefined, followingSeq: 3 },
    { name: 'duplicate seq after valid-position response', callSeq: 1, validSeq: 2, malformedSeq: 2, followingSeq: 3 },
    { name: 'nonmonotonic seq after valid response', callSeq: 10, validSeq: 11, malformedSeq: 9, followingSeq: 12 },
  ]) {
    const id = `broken-${scenario.name}`;
    const call: Message = {
      role: 'model', parts: [{ functionCall: { id, name: 'exec', args: {} } }],
      __meta: { seq: scenario.callSeq, timestamp: 1 },
    };
    const following: Message = {
      role: 'user', parts: [{ text: `following independent valid raw ${'large '.repeat(3000)}` }],
      __meta: { seq: scenario.followingSeq, timestamp: 3 },
    };
    const built = await sessionHistory.buildLayeredCompactCandidateEntries([
      call,
      response(id, scenario.validSeq, 'valid response'),
      response(id, scenario.malformedSeq, 'malformed response'),
      following,
    ]);
    const messages = built.candidateEntries.filter(entry => entry.item.kind === 'message');
    assert.deepEqual(messages.map(entry => entry.item.kind === 'message'
      ? [entry.item.startSeq, entry.item.endSeq]
      : []), [[scenario.callSeq, scenario.validSeq], [scenario.followingSeq, scenario.followingSeq]], scenario.name);
    assert.deepEqual(messages.map(entry => [entry.historyStartIndex, entry.historyEndIndex]), [[0, 1], [3, 3]], `${scenario.name}: malformed row stays outside candidates`);
    assert.notEqual(messages[0].item.segmentId, messages[1].item.segmentId, `${scenario.name}: malformed row starts a new segment`);
  }
});

test('raw continuity resets across a valid intervening block', async () => {
  const { sessionHistory, archive, layeredContext } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_raw_block_raw'));
  const [block] = await layeredContext.appendBlocksToArchive(session, [{
    level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2, rawStartSeq: 2, rawEndSeq: 2,
    summary: `valid intervening block ${'block '.repeat(1800)}`,
  }]);
  session.history = [session.history[0], layeredContext.renderBlockMessage(block), session.history[2]];
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.history);
  assert.deepEqual(built.candidateEntries.filter(entry => entry.item.kind === 'message').map(entry => (entry.item as any).startSeq), [1, 3]);
});

test('a call-only raw island between blocks remains an ordinary message candidate', async () => {
  const { sessionHistory, archive, layeredContext } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_call_only_island'));
  const blocks = await layeredContext.appendBlocksToArchive(session, [1, 3].map(seq => ({
    level: 1, sourceKind: 'message' as const, sourceStart: seq, sourceEnd: seq, rawStartSeq: seq, rawEndSeq: seq,
    summary: `existing L1 block for ${seq} ${'block '.repeat(1800)}`,
  })));
  const call: Message = {
    role: 'model',
    parts: [{ functionCall: { id: 'call-with-response-inside-block', name: 'exec', args: { payload: 'call '.repeat(3000) } } }],
    __meta: { seq: 2, timestamp: 2000 },
  };
  session.history = [layeredContext.renderBlockMessage(blocks[0]), call, layeredContext.renderBlockMessage(blocks[1])];

  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.history);
  const messages = built.candidateEntries.filter(entry => entry.item.kind === 'message');
  assert.deepEqual(messages.map(entry => entry.item.kind === 'message' ? [entry.item.startSeq, entry.item.endSeq] : []), [[2, 2]]);
  assert.deepEqual([messages[0].historyStartIndex, messages[0].historyEndIndex], [1, 1]);
});

test('awaited compaction lifts an active response island to L1 and then compacts the contiguous L1 chain to L2', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session: Session = {
    id: makeSessionId('compact_pruned_island_lift'), agent: 'main', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 1, nextBlockId: 1, historyVersion: 0,
    promptCacheKey: '12345678-1234-1234-1234-123456789abc',
  } as Session;
  const archivedRaw: Message[] = Array.from({ length: 8 }, (_, index) => ({
    role: index === 1 ? 'tool' : 'user',
    parts: index === 1
      ? [{ functionResponse: { tool_use_id: 'archived-call', name: 'exec', response: { output: 'immutable raw response differs from active' } } }]
      : [{ text: `immutable raw ${index + 1}` }],
    __meta: { timestamp: (index + 1) * 1000 },
  }));
  await archive.appendMessagesToArchive(session, archivedRaw);
  const sourceSeqs = [1, 3, 4, 5, 6, 7, 8];
  const blocks = await layeredContext.appendBlocksToArchive(session, sourceSeqs.map(seq => ({
    level: 1, sourceKind: 'message' as const, sourceStart: seq, sourceEnd: seq, rawStartSeq: seq, rawEndSeq: seq,
    rawStartTimestamp: seq * 1000, rawEndTimestamp: seq * 1000,
    summary: `existing L1 block for ${seq} ${'block '.repeat(1800)}`,
  })));
  const activeResponse: Message = {
    role: 'tool',
    parts: [{ functionResponse: {
      tool_use_id: 'hidden-call-in-block-1', name: 'exec',
      response: { output: `active edited pruned response ${'response '.repeat(3000)}\n--- [foxwarm: historical tool response pruned] ---` },
    } }],
    __meta: { seq: 2, timestamp: 2000 },
  };
  session.history = [
    layeredContext.renderBlockMessage(blocks[0]),
    activeResponse,
    ...blocks.slice(1).map(layeredContext.renderBlockMessage),
  ];

  const originalChat = llm.chat;
  let pass = 0;
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      pass += 1;
      const prompt = flattenPrompt(parts);
      const createBlocks = pass === 1
        ? [{ level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2, summary: 'pass one active response summary' }]
        : [{ level: 2, sourceKind: 'block', sourceStart: blocks[0].id, sourceEnd: blocks[1].id, summary: 'pass two contiguous L1 summary' }];
      if (pass === 1) assert.match(prompt, /active edited pruned response/);
      else {
        assert.match(prompt, new RegExp(`B#${blocks[0].id}`));
        assert.match(prompt, /pass one active response summary/);
        assert.match(prompt, new RegExp(`B#${blocks[1].id}`));
      }
      const toolCall = { id: `island-pass-${pass}`, name: 'submit_compact_plan', args: { replaceAsBlocks: createBlocks } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0 }, 'await');
    const afterFirstBlocks = await layeredContext.readLocalArchiveBlocks(session.id);
    const lifted = afterFirstBlocks.find(block => block.id === 8)!;
    assert.deepEqual({
      level: lifted.level, sourceKind: lifted.sourceKind, sourceStart: lifted.sourceStart, sourceEnd: lifted.sourceEnd,
      rawStartSeq: lifted.rawStartSeq, rawEndSeq: lifted.rawEndSeq,
      rawStartTimestamp: lifted.rawStartTimestamp, rawEndTimestamp: lifted.rawEndTimestamp,
      summary: lifted.summary,
    }, {
      level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2,
      rawStartSeq: 2, rawEndSeq: 2, rawStartTimestamp: 2000, rawEndTimestamp: 2000,
      summary: 'pass one active response summary',
    });
    assert.deepEqual(session.history.filter(message => message.__meta?.contextBlock).map(message => message.__meta!.contextBlock!.id), [1, 8, 2, 3, 4, 5, 6, 7]);

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0 }, 'await');
    const afterSecondBlocks = await layeredContext.readLocalArchiveBlocks(session.id);
    const liftedChain = afterSecondBlocks.find(block => block.id === 9)!;
    assert.deepEqual({
      level: liftedChain.level, sourceKind: liftedChain.sourceKind, sourceStart: liftedChain.sourceStart, sourceEnd: liftedChain.sourceEnd,
      sourceBlockIds: liftedChain.sourceBlockIds, rawStartSeq: liftedChain.rawStartSeq, rawEndSeq: liftedChain.rawEndSeq,
      rawStartTimestamp: liftedChain.rawStartTimestamp, rawEndTimestamp: liftedChain.rawEndTimestamp,
      summary: liftedChain.summary,
    }, {
      level: 2, sourceKind: 'block', sourceStart: 1, sourceEnd: 2, sourceBlockIds: [1, 8, 2],
      rawStartSeq: 1, rawEndSeq: 3, rawStartTimestamp: 1000, rawEndTimestamp: 3000,
      summary: 'pass two contiguous L1 summary',
    });
    assert.deepEqual(session.history.filter(message => message.__meta?.contextBlock).map(message => message.__meta!.contextBlock!.id), [9, 3, 4, 5, 6, 7]);
    assert.equal(pass, 2);
  } finally { (llm as any).chat = originalChat; }
});

test('reordered block raw lineage is an end-to-end compact barrier', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_reordered_blocks'));
  const blocks = await layeredContext.appendBlocksToArchive(session, Array.from({ length: 5 }, (_, index) => ({
    level: 1, sourceKind: 'message' as const, sourceStart: index + 1, sourceEnd: index + 1,
    rawStartSeq: index + 1, rawEndSeq: index + 1, summary: `block ${index + 1} ${'large '.repeat(1800)}`,
  })));
  session.history = [blocks[1], blocks[0], ...blocks.slice(2)].map(layeredContext.renderBlockMessage);
  const before = structuredClone(session.history);
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.history);
  const firstTwo = built.candidateEntries.filter(entry => entry.item.kind === 'block').slice(0, 2);
  assert.notEqual(firstTwo[0]?.item.segmentId, firstTwo[1]?.item.segmentId);
  const originalChat = llm.chat;
  (llm as any).chat = async (_parts: any, _activeSession: Session, _iteration: number, options: any) => {
    const toolCall = { id: 'bad-reordered-range', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
      level: 2, sourceKind: 'block', sourceStart: blocks[1].id, sourceEnd: blocks[0].id, summary: 'must be rejected',
    }] } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
  };
  try {
    await assert.rejects(() => sessionHistory.processSessionCompactionRequest(
      makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0 }, 'await',
    ), /no valid plan was produced/);
    assert.deepEqual(session.history, before);
  } finally { (llm as any).chat = originalChat; }
});

test('layered compact plans from active wording and timestamps even when raw Archive rows are absent', async () => {
  const { sessionHistory, layeredContext, llm } = await loadDeps();
  const session: Session = {
    id: makeSessionId('compact_active_only_source'),
    agent: 'main',
    history: [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'active-only-call', name: 'exec', args: { command: 'active' } } }],
        __meta: { seq: 1, timestamp: 1111 },
      },
      {
        role: 'tool',
        parts: [{ functionResponse: {
          tool_use_id: 'active-only-call', name: 'exec',
          response: { output: `offline-edited-active-response ${'active '.repeat(4000)}` },
        } }],
        __meta: { seq: 2, timestamp: 2222 },
      },
    ],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 3,
    nextBlockId: 1,
    historyVersion: 0,
    promptCacheKey: '12345678-1234-1234-1234-123456789abc',
  } as Session;
  const originalChat = llm.chat;
  let prompt = '';
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      prompt = flattenPrompt(parts);
      const toolCall = { id: 'active-only-plan', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'summary based on active edited response',
      }] } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0 }, 'await');
    assert.match(prompt, /offline-edited-active-response/);
    const [block] = await layeredContext.readLocalArchiveBlocks(session.id);
    assert.equal(block.sourceStart, 1);
    assert.equal(block.sourceEnd, 2);
    assert.equal(block.rawStartTimestamp, 1111);
    assert.equal(block.rawEndTimestamp, 2222);
    assert.match(block.summary, /summary based on active edited response/);
    assert.equal(session.history[0].__meta?.contextBlock?.id, block.id);
  } finally { (llm as any).chat = originalChat; }
});

test('prior compact-completion notices are transparent to planning and replaced by one current marker', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const sessionId = makeSessionId('compact_lifecycle_barrier');
  const session: Session = {
    id: sessionId,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 1,
    nextBlockId: 1,
        historyVersion: 0,
    promptCacheKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  } as Session;
  const lifecycleText = '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent" currentSessionId="child" />';
  const messages: Message[] = [
    { role: 'user', parts: [{ text: `visible before boundary ${'alpha '.repeat(3000)}` }], __meta: { timestamp: 1000 } },
    { role: 'user', parts: [{ system: lifecycleText }], __meta: { timestamp: 2000 } },
    { role: 'user', parts: [{ text: `visible after boundary ${'bravo '.repeat(3000)}` }], __meta: { timestamp: 3000 } },
  ];
  await archive.appendMessagesToArchive(session, messages);
  session.history = messages;
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  let firstPrompt = '';

  try {
    (llm as any).chat = async (
      parts: MessagePart[] | null,
      _activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      firstPrompt = flattenPrompt(parts);
      const toolCall = {
        id: 'compact-across-prior-completion',
        name: 'submit_compact_plan',
        args: {
          replaceAsBlocks: [{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 3,
            summary: 'summary across a prior compact completion marker',
          }],
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(
      makeDepsForSession(session, saveCounter),
      session.id,
      { keepPercent: 0 },
      'await',
    );

    assert.match(firstPrompt, /Segment 1: raw message candidates.*M#1.*M#3/s);
    assert.doesNotMatch(firstPrompt, /Segment 2: raw message candidates/);
    assert.equal(session.history[0]?.__meta?.contextBlock?.level, 1);
    assert.equal(session.history.some(message => message.__meta?.seq === 2), false);
    assert.equal(session.history.filter(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))).length, 1);
    const archived = await archive.readArchiveMessagesBySeqRange(session.id, 2, 2);
    assert.equal(archived[0]?.message.parts[0]?.system, lifecycleText);
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('successful compaction removes prior completion notices from the force-kept tail but preserves other boundaries and archives', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const sessionId = makeSessionId('compact_completion_tail_cleanup');
  const session: Session = {
    id: sessionId,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    nextMessageSeq: 1,
    nextBlockId: 1,
        historyVersion: 0,
    promptCacheKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    goalState: { goal: 'keep current goal', remindEvery: 10, anchorSeq: 0, updatedAt: Date.now() },
  } as Session;
  const oldCompletion = '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent" currentSessionId="child" />';
  const inheritedBoundary = '<foxwarm-system kind="session-boundary" event="history-inherited" parentSessionId="parent" currentSessionId="child" />';
  const messages: Message[] = [
    { role: 'user', parts: [{ text: `older first ${'alpha '.repeat(3000)}` }], __meta: { timestamp: 1000 } },
    { role: 'model', parts: [{ text: `older second ${'bravo '.repeat(3000)}` }], __meta: { timestamp: 2000 } },
    { role: 'user', parts: [{ system: oldCompletion }, { system: '<foxwarm-system kind="goal-reminder" />' }], __meta: { timestamp: 3000 } },
    { role: 'user', parts: [{ system: inheritedBoundary }], __meta: { timestamp: 4000 } },
    { role: 'user', parts: [{ text: 'recent real user content' }], __meta: { timestamp: 5000 } },
  ];
  await archive.appendMessagesToArchive(session, messages);
  session.history = messages;
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;

  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _activeSession: Session, _iteration: number, options?: { appendMessage?: (message: Message) => Promise<void> | void }): Promise<ChatResult> => {
      const toolCall = {
        id: 'compact-tail-cleanup',
        name: 'submit_compact_plan',
        args: {
          replaceAsBlocks: [{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary replacing the older raw pair',
          }],
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, saveCounter), session.id, { keepPercent: 0.6 }, 'await');

    const compactCompletions = session.history.filter(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"')));
    assert.equal(compactCompletions.length, 1, 'only the current compact completion remains active');
    assert.equal(compactCompletions[0].parts.length, 1, 'new completion emits only the lifecycle marker, not a Goal reminder');
    assert.equal(session.history.some(message => message.__meta?.seq === 3), false, 'old completion is removed even from the force-kept tail');
    assert.equal(session.history.some(message => message.parts.some(part => part.system === inheritedBoundary)), true, 'unrelated session boundary remains active');
    assert.equal(session.history.some(message => message.parts.some(part => part.text === 'recent real user content')), true, 'real content remains active');
    const archived = await archive.readArchiveMessagesBySeqRange(session.id, 3, 3);
    assert.equal(archived[0]?.message.parts[0]?.system, oldCompletion, 'old completion remains in durable archive');
    assert.equal(archived[0]?.message.parts[1]?.system, '<foxwarm-system kind="goal-reminder" />', 'historical paired Goal marker remains readable');
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('compact planning stops after bounded plain-text/no-tool retries without rewriting session history', async () => {
  const { sessionHistory, archive, compactPlan, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_plain_text_exhausted'));
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const originalHistory = structuredClone(session.history);
  const originalNextBlockId = session.nextBlockId;
  const originalPromptCacheKey = session.promptCacheKey;
  let callCount = 0;

  try {
    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
      callCount += 1;
      const text = `still answering with plain text only on round ${callCount}: ${flattenPrompt(parts).slice(0, 20)}`;
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ text }] }));
      return { text, toolCalls: [], allParts: [{ text }] };
    };

    await assert.rejects(
      () => sessionHistory.processSessionCompactionRequest(
        makeDepsForSession(session, saveCounter),
        session.id,
        { keepPercent: 0.5 },
        'await',
      ),
      /Compaction skipped after 15 compact planning round\(s\) because no valid plan was produced via submit_compact_plan/,
    );

    assert.equal(callCount, compactPlan.COMPACT_FLOW_MAX_ROUNDS);
    assert.deepEqual(session.history, originalHistory);
    assert.equal(session.nextBlockId, originalNextBlockId);
    assert.equal(session.promptCacheKey, originalPromptCacheKey);
    assert.equal(session.historyVersion, 0);
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('compact planning LLM final failure aborts without rewriting session history or queuing a compact result', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_llm_final_failure'));
  const priorCompletion: Message = {
    role: 'user',
    parts: [{ system: '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent" currentSessionId="child" />' }],
    __meta: { timestamp: 5000 },
  };
  await archive.appendMessagesToArchive(session, [priorCompletion]);
  session.history.push(priorCompletion);
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const originalHistory = structuredClone(session.history);
  const originalNextBlockId = session.nextBlockId;
  const originalPromptCacheKey = session.promptCacheKey;
  let callCount = 0;

  try {
    (llm as any).chat = async (): Promise<ChatResult> => {
      callCount += 1;
      throw new llm.LlmRequestError('API request failed after 5 attempts');
    };

    await assert.rejects(
      () => sessionHistory.processSessionCompactionRequest(
        makeDepsForSession(session, saveCounter),
        session.id,
        { keepPercent: 0.5 },
        'await',
      ),
      (error: unknown) => error instanceof llm.LlmRequestError && /API request failed after 5 attempts/.test(error.message),
    );

    assert.equal(callCount, 1);
    assert.deepEqual(session.history, originalHistory);
    assert.equal(session.nextBlockId, originalNextBlockId);
    assert.equal(session.promptCacheKey, originalPromptCacheKey);
    assert.equal(session.historyVersion, 0);
    assert.equal(sessionHistory.hasPendingCompactWork(session.id), false);
    assert(session.history.some(item => item.__meta?.seq === priorCompletion.__meta!.seq), 'failed planning leaves prior completion untouched');

    const ordinary = { type: 'user', parts: [{ text: 'ordinary input survives a failed background job' }] } as any;
    session.queue.push(ordinary);
    const deps = makeDepsForSession(session, saveCounter);
    await sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'background');
    for (let index = 0; index < 100 && !sessionHistory.hasCompletedCompactJob(session.id); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), true, 'terminal planning failures are consumable completed work');
    await assert.rejects(() => sessionHistory.applyCompletedCompactJob(deps, session.id), /API request failed after 5 attempts/);
    assert.equal(sessionHistory.hasPendingCompactWork(session.id), false);
    assert.equal(sessionHistory.hasCompletedCompactJob(session.id), false);
    assert.deepEqual(session.queue, [ordinary]);
    assert.deepEqual(session.history, originalHistory);
    assert.equal(callCount, 2);

  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('compact commit persists block facts and survives best-effort fact indexing failure', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const vector = await import('../vector');
  const session = await makeCompactableSession(archive, makeSessionId('compact_block_facts_index_failure'));
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const originalIndexFacts = vector.indexMemoryFactsFromCompaction;

  try {
    (llm as any).chat = async (
      _parts: MessagePart[] | null,
      _activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      const toolCall = {
        id: 'compact-plan-with-block-facts',
        name: 'submit_compact_plan',
        args: {
          replaceAsBlocks: [{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary whose durable facts are framework-rendered',
            memoryFacts: [{ kind: 'decision', text: 'Keep compact facts attached to their creating block.', attributedTo: 'user' }],
          }],
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    (vector as any).indexMemoryFactsFromCompaction = async () => { throw new Error('embedding unavailable'); };

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, saveCounter), session.id, { keepPercent: 0.5 }, 'await');

    const [block] = await layeredContext.readArchiveBlocksByIdRange(session.id, 1, 1);
    assert.deepEqual(block.memoryFacts, [{ kind: 'decision', text: 'Keep compact facts attached to their creating block.', attributedTo: 'user' }]);
    assert.equal(block.rawStartTimestamp, 1000);
    assert.equal(block.rawEndTimestamp, 2000);
    assert.match(block.summary, /### Memory facts/);
    assert.match(String(session.history[0].parts[0].text), /### Memory facts/);
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))));
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).indexMemoryFactsFromCompaction = originalIndexFacts;
  }
});

test('compact authority persistence failure restores active state and removes uncommitted archive rows', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_authority_rollback'));
  const originalChat = llm.chat;
  const originalHistory = structuredClone(session.history);
  const originalNextBlockId = session.nextBlockId;
  const originalHistoryVersion = session.historyVersion;
  const deps = makeDepsForSession(session, { count: 0 });
  const runtime = trackCompactionRuntime(deps);
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      const toolCall = { id: 'authority-failure', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must be rolled back',
      }] } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await assert.rejects(() => sessionHistory.processSessionCompactionRequest({
      ...deps,
      saveSession: async () => { throw new Error('injected compact authority persistence failure'); },
    }, session.id, { keepPercent: 0.5 }, 'await'), /injected compact authority persistence failure/);
    assert.deepEqual(session.history, originalHistory);
    assert.equal(session.nextBlockId, originalNextBlockId);
    assert.equal(session.historyVersion, originalHistoryVersion);
    assert.equal((await layeredContext.readLocalArchiveBlocks(session.id)).length, 0);
    assert.equal((await archive.readArchiveMessages(session.id)).length, originalHistory.length);
    assert.equal(runtime.current, 'idle');
  } finally { (llm as any).chat = originalChat; }
});

test('a legacy low block counter advances past immutable Archive without changing compact input', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_block_append_conflict'));
  const seedSession = { ...session, history: [], nextBlockId: 1 } as Session;
  await layeredContext.appendBlocksToArchive(seedSession, [{
    level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2,
    rawStartTimestamp: 1000, rawEndTimestamp: 2000, summary: 'preexisting immutable block identity',
  }]);
  session.nextBlockId = 1;
  const originalHistory = structuredClone(session.history);
  const originalNextBlockId = session.nextBlockId;
  const originalHistoryVersion = session.historyVersion;
  const originalChat = llm.chat;
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      const toolCall = { id: 'conflicting-block-plan', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'new block content uses a fresh identity',
      }] } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'await');
    assert.equal(session.nextBlockId, originalNextBlockId + 2);
    assert.equal(session.historyVersion, originalHistoryVersion! + 1);
    assert.equal(session.history[0].__meta?.contextBlock?.id, 2);
    assert.deepEqual(session.history.slice(1, 3), originalHistory.slice(2));
    const blocks = await layeredContext.readLocalArchiveBlocks(session.id);
    assert.deepEqual(blocks.map(block => block.id), [1, 2]);
    assert.equal(blocks[0].summary, 'preexisting immutable block identity');
    assert.equal(blocks[1].summary, 'new block content uses a fresh identity');
  } finally { (llm as any).chat = originalChat; }
});

test('background compact validates exact snapshot content and rejects same-metadata offline edits', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_exact_snapshot_edit'));
  const ordinary = { type: 'user', parts: [{ text: 'queued input after incompatible snapshot' }] } as any;
  session.queue.push(ordinary);
  const originalChat = llm.chat;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      await gate;
      const toolCall = { id: 'exact-edit', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must not commit over edited history',
      }] } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'background');
    session.history[0] = { ...structuredClone(session.history[0]), parts: [{ text: 'offline edited wording with the same seq and metadata' }] };
    release();
    for (let index = 0; index < 200; index += 1) {
      try {
        const applied = await sessionHistory.applyCompletedCompactJob(makeDepsForSession(session, { count: 0 }), session.id);
        if (!sessionHistory.hasPendingCompactWork(session.id)) {
          assert.equal(applied, false);
          assert.deepEqual(session.queue, [ordinary]);
          assert.equal(session.history[0].parts[0].text, 'offline edited wording with the same seq and metadata');
          return;
        }
      } catch { /* still running */ }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('background compact did not become ready');
  } finally { (llm as any).chat = originalChat; }
});

test('background compact retains only an appended compatible active-history suffix', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_appended_suffix'));
  session.history[2].role = 'model';
  session.history[2].parts = [{ functionCall: { id: 'recent-tool', name: 'exec', args: { command: 'force-kept tool call marker' } } }];
  session.history[3].role = 'tool';
  session.history[3].parts = [{ functionResponse: { tool_use_id: 'recent-tool', name: 'exec', response: { output: 'force-kept tool response marker' } } }];
  const before = structuredClone(session.history);
  const originalChat = llm.chat;
  let providerEntered!: () => void;
  const entered = new Promise<void>(resolve => { providerEntered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      providerEntered();
      assert.equal(options.compactPlanBackground, true);
      assert.deepEqual(activeSession.history, before.slice(0, 2));
      assert.deepEqual(session.history, before);
      assert.doesNotMatch(JSON.stringify(activeSession.history), /force-kept tool (call|response) marker/);
      assert.doesNotMatch(flattenPrompt(parts), /force-kept tool (call|response) marker/);
      assert.match(flattenPrompt(parts), /Recent messages \(2 rendered item\(s\), #3-#4\)/);
      await gate;
      assert.deepEqual(activeSession.history, before.slice(0, 2));
      const toolCall = { id: 'suffix', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'compacted before appended suffix',
      }] } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.25 }, 'background');
    await entered;
    const suffix: Message = { role: 'user', parts: [{ text: 'compatible appended suffix survives' }], __meta: { seq: 5, timestamp: 5000 } };
    await archive.appendMessagesToArchive(session, [suffix]);
    session.history.push(suffix);
    assert.deepEqual(session.history, [...before, suffix]);
    release();
    for (let index = 0; index < 200; index += 1) {
      const applied = await sessionHistory.applyCompletedCompactJob(makeDepsForSession(session, { count: 0 }), session.id);
      if (!sessionHistory.hasPendingCompactWork(session.id)) {
        assert.equal(applied, true);
        assert.deepEqual(session.history.filter(message => [3, 4, 5].includes(message.__meta?.seq || 0)), [...before.slice(2), suffix]);
        assert.equal(session.history.some(message => message.parts.some(part => part.text === 'compatible appended suffix survives')), true);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('background compact did not become ready');
  } finally { (llm as any).chat = originalChat; }
});

test('historical tool-response pruning keeps Unicode-safe line-aware head/tail, metadata, recall location, and call args', async () => {
  const { buildToolResponsePrunePlan } = require('./history') as typeof import('./history');
  const { archive } = await loadDeps();
  const headLine = `${'h'.repeat(450)}😀\n`;
  const middle = 'M'.repeat(900);
  const tailLine = `\n${'t'.repeat(450)}🦊`;
  const output = `${headLine}${middle}${tailLine}`;
  const history: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'call-prune', name: 'read', args: { unchanged: middle }, rawArgsText: JSON.stringify({ unchanged: middle }) } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'call-prune', name: 'read', response: {
      output, status: 'ok', path: '/tmp/result.txt', sha256: 'a'.repeat(64), nested: { discard: middle }, arbitraryLarge: middle,
    } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'recent' }], __meta: { seq: 3, timestamp: 3 } },
  ];
  const sessionId = makeSessionId('prune_shape');
  const authority = { id: sessionId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  await archive.appendMessagesToArchive(authority, history);
  const plan = await buildToolResponsePrunePlan(sessionId, { history, persistentMemorySnapshot: '' }, 1 / 3);
  assert.equal(plan.replacedFunctionCalls, 0);
  assert.equal(plan.replacedFunctionResponses, 1);
  assert.deepEqual(plan.rewrittenHistory[0].parts[0].functionCall, history[0].parts[0].functionCall);
  const response = plan.rewrittenHistory[1].parts[0].functionResponse!.response;
  const pruned = String(response.output);
  assert.match(pruned, /^output: "h+/);
  assert.match(pruned, /😀\\nM+/);
  assert.match(pruned, /--- \[foxwarm:/);
  assert.match(pruned, /recall\(\{ target: "msg#2" \}\)/);
  assert.match(pruned, /tool="read"/);
  assert.match(pruned, /tool_use_id="call-prune"/);
  assert.equal(response.status, 'ok');
  assert.equal(response.path, '/tmp/result.txt');
  assert.equal(response.sha256, 'a'.repeat(64));
  assert.equal(response.nested, undefined);
  assert.equal(response.arbitraryLarge, undefined);
  assert.doesNotMatch(pruned, /\uFFFD/);
  assert.deepEqual(plan.rewrittenHistory[2], history[2]);
});

test('structured historical response payloads retain the full model-visible response inside pruned text', async () => {
  const { buildToolResponsePrunePlan } = require('./history') as typeof import('./history');
  const { archive } = await loadDeps();
  const history: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'structured-call', name: 'call_tool', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'structured-call', name: 'call_tool', response: {
      output: { status: 'ok', path: '/tmp/structured.txt', body: 'Z'.repeat(2500) },
    } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'recent' }], __meta: { seq: 3, timestamp: 3 } },
  ];
  const sessionId = makeSessionId('prune_structured');
  const authority = { id: sessionId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  await archive.appendMessagesToArchive(authority, history);
  const plan = await buildToolResponsePrunePlan(sessionId, { history, persistentMemorySnapshot: '' }, 1 / 3);
  const pruned = String(plan.rewrittenHistory[1].parts[0].functionResponse?.response.output);
  assert.match(pruned, /status: ok/);
  assert.match(pruned, /path: \/tmp\/structured\.txt/);
  assert.match(pruned, /historical tool response pruned/);
});


test('historical pruning requires exact effective archive provenance and accepts inherited exact identity', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const archiveStore = await import('./archiveStore');
  const huge = 'PROVENANCE-FULL '.repeat(2200);
  const makeHistory = (): Message[] => [
    { role: 'model', parts: [{ functionCall: { id: 'prov-call', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'prov-call', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
  ];

  const missingId = makeSessionId('prune_missing_archive');
  const missingPlan = await sessionHistory.buildToolResponsePrunePlan(missingId, { history: makeHistory(), persistentMemorySnapshot: '' }, 1 / 3);
  assert.equal(missingPlan.replacedFunctionResponses, 0);

  const conflictingId = makeSessionId('prune_conflicting_archive');
  const conflictingArchive = { id: conflictingId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  const archiveHistory = makeHistory();
  await archive.appendMessagesToArchive(conflictingArchive, archiveHistory);
  const edited = makeHistory();
  edited[1].parts[0].functionResponse!.response.output = `${huge} offline edit`;
  const conflictingPlan = await sessionHistory.buildToolResponsePrunePlan(conflictingId, { history: edited, persistentMemorySnapshot: '' }, 1 / 3);
  assert.equal(conflictingPlan.replacedFunctionResponses, 0);

  const parentId = makeSessionId('prune_parent');
  const childId = makeSessionId('prune_child');
  const parent = { id: parentId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  const inheritedHistory = makeHistory();
  await archive.appendMessagesToArchive(parent, inheritedHistory);
  await archiveStore.ensureSessionBranch(childId, { parentSessionId: parentId, forkMessageSeq: 3, forkBlockId: 0 });
  const inheritedPlan = await sessionHistory.buildToolResponsePrunePlan(childId, { history: inheritedHistory, persistentMemorySnapshot: '' }, 1 / 3);
  assert.equal(inheritedPlan.replacedFunctionResponses, 1);
  assert.deepEqual(inheritedPlan.validatedArchiveSeqs, [2]);
});

test('retired contextFrontierItem does not block pruning, but recent tail and real content conflicts remain protected', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const id = makeSessionId('prune_legacy_frontier_item');
  const oldOutput = 'OLD-LEGACY-FRONTIER '.repeat(2200);
  const recentOutput = 'RECENT-LEGACY-FRONTIER '.repeat(2200);
  const clean: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'old-frontier', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'old-frontier', name: 'read', response: { output: oldOutput } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'middle' }], __meta: { seq: 3, timestamp: 3 } },
    { role: 'model', parts: [{ functionCall: { id: 'recent-frontier', name: 'read', args: {} } }], __meta: { seq: 4, timestamp: 4 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'recent-frontier', name: 'read', response: { output: recentOutput } } }], __meta: { seq: 5, timestamp: 5 } },
    { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 6, timestamp: 6 } },
  ];
  await archive.appendMessagesToArchive({ id, agent: 'main', history: [], nextMessageSeq: 1 } as Session, clean);
  const legacy = structuredClone(clean) as any[];
  legacy[1].__meta.contextFrontierItem = { kind: 'message', seq: 2 };
  legacy[4].__meta.contextFrontierItem = { kind: 'message', seq: 5 };
  const plan = await sessionHistory.buildToolResponsePrunePlan(id, { history: legacy, persistentMemorySnapshot: '' }, 0.5);
  assert.equal(plan.replacedFunctionResponses, 1);
  assert.match(String(plan.rewrittenHistory[1].parts[0].functionResponse?.response.output), /historical tool response pruned/);
  assert.equal(plan.rewrittenHistory[4].parts[0].functionResponse?.response.output, recentOutput);

  const conflicted = structuredClone(legacy);
  conflicted[1].parts[0].functionResponse.response.output += ' real content edit';
  const conflictPlan = await sessionHistory.buildToolResponsePrunePlan(id, { history: conflicted, persistentMemorySnapshot: '' }, 0.5);
  assert.equal(conflictPlan.replacedFunctionResponses, 0);
  assert.deepEqual(conflictPlan.rewrittenHistory, conflicted);
});

test('retired contextFrontierItem does not create a layered-compaction active-structure barrier', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const id = makeSessionId('compact_legacy_frontier_item');
  const clean: Message = {
    role: 'user', parts: [{ text: `large legacy raw ${'candidate '.repeat(2600)}` }], __meta: { seq: 1, timestamp: 1 },
  };
  await archive.appendMessagesToArchive({ id, agent: 'main', history: [], nextMessageSeq: 1 } as Session, [clean]);
  const legacy = structuredClone(clean) as any;
  legacy.__meta.contextFrontierItem = { kind: 'message', seq: 1 };
  const built = await sessionHistory.buildLayeredCompactCandidateEntries([legacy]);
  assert.equal(built.candidateEntries.some(entry => entry.item.kind === 'message'
    && entry.item.startSeq === 1 && entry.item.endSeq === 1), true);
});

test('duplicate effective archive seq identity is nonprunable', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const archiveStore = await import('./archiveStore');
  const huge = 'DUPLICATE '.repeat(2500);
  const parentId = makeSessionId('prune_dup_parent'); const childId = makeSessionId('prune_dup_child');
  const parent = { id: parentId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  const message: Message = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'dup', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } };
  await archive.appendMessagesToArchive(parent, [structuredClone(message)]);
  await archiveStore.ensureSessionBranch(childId, { parentSessionId: parentId, forkMessageSeq: 2, forkBlockId: 0 });
  const child = { id: childId, agent: 'main', history: [], nextMessageSeq: 1 } as Session;
  await archive.appendMessagesToArchive(child, [structuredClone(message)]);
  const history: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'dup', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    message,
    { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
  ];
  const plan = await sessionHistory.buildToolResponsePrunePlan(childId, { history, persistentMemorySnapshot: '' }, 1 / 3);
  assert.equal(plan.replacedFunctionResponses, 0);
});

test('duplicate active seq identity stays byte-exact and cannot influence the pruning estimate', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const id = makeSessionId('prune_duplicate_active');
  const huge = 'ACTIVE-DUPLICATE '.repeat(2500);
  const archived: Message = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'active-dup', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } };
  await archive.appendMessagesToArchive({ id, agent: 'main', history: [], nextMessageSeq: 1 } as Session, [structuredClone(archived)]);
  const history: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'active-dup', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    structuredClone(archived),
    structuredClone(archived),
    { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
  ];
  const before = structuredClone(history);
  const plan = await sessionHistory.buildToolResponsePrunePlan(id, { history, persistentMemorySnapshot: '' }, 0.25);
  assert.equal(plan.replacedFunctionResponses, 0);
  assert.equal(plan.estimatedTokensSaved, 0);
  assert.deepEqual(plan.rewrittenHistory, before);
  assert.deepEqual(plan.validatedArchiveSeqs, []);
});

test('whole response formatting covers structured roots and mixed output/content/error envelopes', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const cases = [
    { count: 1, totalMatched: 1, tools: [{ name: 'search_tools', description: 'D'.repeat(2500) }] },
    { output: 'O'.repeat(2200), error: 'small error sibling' },
    { output: 'O'.repeat(2200), content: 'small content sibling' },
    { output: 'small', content: 'C'.repeat(2200) },
    { output: ['array', { nested: 'A'.repeat(2200) }] },
    { output: 'I'.repeat(2200) },
  ];
  for (const [index, response] of cases.entries()) {
    const id = makeSessionId(`prune_envelope_${index}`);
    const history: Message[] = [
      { role: 'model', parts: [{ functionCall: { id: `mixed-${index}`, name: 'call_tool', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
      { role: 'tool', parts: [
        { functionResponse: { tool_use_id: `mixed-${index}`, name: 'call_tool', response } },
        ...(index === cases.length - 1 ? [{ toolUseId: `mixed-${index}`, inlineDataRef: { imageId: 'image-ref', mimeType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64) } }] : []),
      ], __meta: { seq: 2, timestamp: 2 } },
      { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
    ];
    await archive.appendMessagesToArchive({ id, agent: 'main', history: [], nextMessageSeq: 1 } as Session, history);
    const plan = await sessionHistory.buildToolResponsePrunePlan(id, { history, persistentMemorySnapshot: '' }, 1 / 3);
    assert.equal(plan.replacedFunctionResponses, 1, `case ${index}`);
    const rewritten = plan.rewrittenHistory[1].parts[0].functionResponse!.response;
    assert.match(String(index === 3 ? rewritten.content : rewritten.output), /historical tool response pruned/);
    if (index === 1) assert.equal(rewritten.error, 'small error sibling');
    if (index === 2) assert.equal(rewritten.content, 'small content sibling');
    if (index === 3) assert.equal(rewritten.output, 'small');
  }
});

test('mixed payload envelopes preserve small siblings under their original keys regardless of field order', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const cases: Array<{ response: Record<string, unknown>; carrier: 'output' | 'content' | 'error'; preserved: Record<string, unknown> }> = [
    { response: { output: 'O'.repeat(2200), error: 'middle error', content: 'C'.repeat(2200) }, carrier: 'output', preserved: { error: 'middle error' } },
    { response: { output: 'small output', content: 'C'.repeat(2200) }, carrier: 'content', preserved: { output: 'small output' } },
    { response: { content: 'small content', error: 'E'.repeat(2200) }, carrier: 'error', preserved: { content: 'small content' } },
    { response: { error: 'small error', content: 'C'.repeat(2200) }, carrier: 'content', preserved: { error: 'small error' } },
  ];
  for (const [index, testCase] of cases.entries()) {
    const id = makeSessionId(`prune_middle_sibling_${index}`);
    const history: Message[] = [
      { role: 'model', parts: [{ functionCall: { id: `middle-${index}`, name: 'call_tool', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: `middle-${index}`, name: 'call_tool', response: testCase.response } }], __meta: { seq: 2, timestamp: 2 } },
      { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
    ];
    await archive.appendMessagesToArchive({ id, agent: 'main', history: [], nextMessageSeq: 1 } as Session, history);
    const plan = await sessionHistory.buildToolResponsePrunePlan(id, { history, persistentMemorySnapshot: '' }, 1 / 3);
    const rewritten = plan.rewrittenHistory[1].parts[0].functionResponse!.response;
    assert.match(String(rewritten[testCase.carrier]), /historical tool response pruned/);
    for (const [key, value] of Object.entries(testCase.preserved)) assert.deepEqual(rewritten[key], value);
  }
});

test('manual historical tool-response pruning is a true no-op for small responses', async () => {
  const { compactToolMessages } = await loadDeps().then(value => value.sessionHistory);
  const session: Session = {
    id: makeSessionId('tool_prune_noop'), agent: 'main', history: [
      { role: 'model', parts: [{ functionCall: { id: 'small-call', name: 'read', args: { large: 'x'.repeat(2000) } } }], __meta: { seq: 1 } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'small-call', name: 'read', response: { output: 'small' } } }], __meta: { seq: 2 } },
    ], persistentMemorySnapshot: '', stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: Date.now() }, historyVersion: 7,
  } as Session;
  const saveCounter = { count: 0 };
  const before = structuredClone(session.history);
  const result = await compactToolMessages(makeDepsForSession(session, saveCounter), session.id, 0);
  assert.equal(result.replacedFunctionCalls, 0);
  assert.equal(result.replacedFunctionResponses, 0);
  assert.equal(saveCounter.count, 0);
  assert.equal(session.historyVersion, 7);
  assert.deepEqual(session.history, before);
});

test('automatic pruning commits below 50% and skips layered provider planning', async () => {
  const { sessionHistory, llm } = await loadDeps();
  const session: Session = {
    id: makeSessionId('auto_tool_prune_commit'), agent: 'main', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, busy: false, queue: [],
    meta: { lastMessageTime: Date.now() }, historyVersion: 2, promptCacheKey: '11111111-2222-4333-8444-555555555555',
  } as Session;
  const huge = 'auto-prune-payload '.repeat(5000);
  session.history = [
    { role: 'model', parts: [{ functionCall: { id: 'auto-call', name: 'read', args: { untouched: huge } } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'auto-call', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } },
    ...Array.from({ length: 8 }, (_, index): Message => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: `tail-${index}` }], __meta: { seq: index + 3, timestamp: index + 3 } })),
  ];
  const { archive } = await loadDeps();
  const archiveAuthority = { ...session, history: [], nextMessageSeq: 1 } as Session;
  await archive.appendMessagesToArchive(archiveAuthority, session.history);
  const saves = { count: 0 };
  const originalChat = llm.chat; let providerCalls = 0;
  (llm as any).chat = async () => { providerCalls += 1; throw new Error('layered planner must not run'); };
  try {
    await sessionHistory.checkAndCompactIfNeeded(makeDepsForSession(session, saves), session.id, { inputTokens: 200000 });
    assert.equal(providerCalls, 0);
    assert.equal(saves.count, 1);
    assert.equal(session.historyVersion, 3);
    assert.equal(session.promptCacheKey, '11111111-2222-4333-8444-555555555555');
    assert.match(String(session.history[1].parts[0].functionResponse?.response.output), /historical tool response pruned/);
  } finally { (llm as any).chat = originalChat; }
});

test('automatic pruning above 50% leaves byte-exact history and runs layered planning', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session: Session = {
    id: makeSessionId('auto_tool_prune_fallback'), agent: 'main', history: [], persistentMemorySnapshot: 'S'.repeat(300000),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, busy: false, queue: [],
    meta: { lastMessageTime: Date.now() }, historyVersion: 4, promptCacheKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  } as Session;
  const huge = 'fallback-tool '.repeat(4000);
  const messages: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'fallback-call', name: 'read', args: { unchanged: true } } }], __meta: { timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'fallback-call', name: 'read', response: { output: huge } } }], __meta: { timestamp: 2 } },
    { role: 'user', parts: [{ text: 'recent' }], __meta: { timestamp: 3 } },
  ];
  await archive.appendMessagesToArchive(session, messages);
  session.history = messages;
  const before = structuredClone(session.history);
  const saves = { count: 0 };
  const originalChat = llm.chat; let sawOriginal = false;
  (llm as any).chat = async (_parts: MessagePart[] | null, active: Session): Promise<ChatResult> => {
    sawOriginal = JSON.stringify(active.history).includes(huge);
    throw new Error('expected planner probe');
  };
  try {
    await sessionHistory.checkAndCompactIfNeeded(makeDepsForSession(session, saves), session.id, { inputTokens: 200000 });
    for (let index = 0; index < 100 && !sawOriginal; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sawOriginal, true);
    assert.deepEqual(session.history, before);
    assert.equal(session.historyVersion, 4);
    assert.equal(session.promptCacheKey, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(saves.count, 0);
  } finally { sessionHistory.discardPendingCompactWork(session.id); (llm as any).chat = originalChat; }
});

test('prune commit accepts an appended suffix and rejects a changed prefix', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const huge = 'compatible-prefix '.repeat(2000);
  const base: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'compat-call', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'compat-call', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'protected tail' }], __meta: { seq: 3, timestamp: 3 } },
  ];
  const session = { id: makeSessionId('prune_compat'), agent: 'main', history: structuredClone(base), persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, busy: false, queue: [], meta: { lastMessageTime: 1 }, historyVersion: 0 } as Session;
  await archive.appendMessagesToArchive({ ...session, history: [], nextMessageSeq: 1 } as Session, session.history);
  const plan = await sessionHistory.buildToolResponsePrunePlan(session.id, session, 1 / 3);
  session.history.push({ role: 'user', parts: [{ text: 'appended' }], __meta: { seq: 4 } });
  const saves = { count: 0 };
  assert.equal((await sessionHistory.commitToolResponsePrunePlan(makeDepsForSession(session, saves), session.id, plan)).committed, true);
  assert.equal(session.history.at(-1)?.parts[0].text, 'appended');
  const incompatible = { ...session, id: makeSessionId('prune_incompat'), history: structuredClone(base), historyVersion: 0 } as Session;
  await archive.appendMessagesToArchive({ ...incompatible, history: [], nextMessageSeq: 1 } as Session, incompatible.history);
  const incompatiblePlan = await sessionHistory.buildToolResponsePrunePlan(incompatible.id, incompatible, 1 / 3);
  incompatible.history[0].parts[0].functionCall!.args = { edited: true };
  const incompatibleSaves = { count: 0 };
  assert.equal((await sessionHistory.commitToolResponsePrunePlan(makeDepsForSession(incompatible, incompatibleSaves), incompatible.id, incompatiblePlan)).committed, false);
  assert.equal(incompatibleSaves.count, 0);
  assert.match(String(incompatible.history[1].parts[0].functionResponse?.response.output), /compatible-prefix/);
});

test('prune persistence failure restores exact semantic history while post-authority failure keeps the committed rewrite', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const huge = 'failure-boundary '.repeat(2500);
  const make = (id: string): Session => ({ id, agent: 'main', history: [
    { role: 'model', parts: [{ functionCall: { id: 'failure-call', name: 'read', args: {} } }], __meta: { seq: 1, timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'failure-call', name: 'read', response: { output: huge } } }], __meta: { seq: 2, timestamp: 2 } },
    { role: 'user', parts: [{ text: 'tail' }], __meta: { seq: 3, timestamp: 3 } },
  ], persistentMemorySnapshot: '', stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
  busy: false, queue: [], meta: { lastMessageTime: 1 }, historyVersion: 5, promptCacheKey: 'dddddddd-eeee-4fff-8aaa-222222222222' } as Session);

  const beforeAuthority = make(makeSessionId('prune_before_authority'));
  const beforeSnapshot = structuredClone(beforeAuthority.history);
  await archive.appendMessagesToArchive({ ...beforeAuthority, history: [], nextMessageSeq: 1 } as Session, beforeAuthority.history);
  await assert.rejects(() => sessionHistory.compactToolMessages({
    ...makeDepsForSession(beforeAuthority, { count: 0 }), saveSession: async () => { throw new Error('before authority'); },
  }, beforeAuthority.id, 1 / 3), /before authority/);
  assert.deepEqual(beforeAuthority.history, beforeSnapshot);
  assert.equal(beforeAuthority.historyVersion, 5);

  const postAuthority = make(makeSessionId('prune_post_authority'));
  await archive.appendMessagesToArchive({ ...postAuthority, history: [], nextMessageSeq: 1 } as Session, postAuthority.history);
  const postError = Object.assign(new Error('post authority'), { code: 'SESSION_AUTHORITY_POSTCOMMIT_FAILED' });
  await assert.rejects(() => sessionHistory.compactToolMessages({
    ...makeDepsForSession(postAuthority, { count: 0 }), saveSession: async () => { throw postError; },
  }, postAuthority.id, 1 / 3), error => error === postError);
  assert.match(String(postAuthority.history[1].parts[0].functionResponse?.response.output), /historical tool response pruned/);
  assert.equal(postAuthority.historyVersion, 6);
  assert.equal(postAuthority.promptCacheKey, 'dddddddd-eeee-4fff-8aaa-222222222222');
});

test('manual pruning rewrites only active history while exact archive recall keeps the full original', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const session: Session = {
    id: makeSessionId('tool_prune_archive'), agent: 'main', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, busy: false, queue: [],
    meta: { lastMessageTime: Date.now() }, historyVersion: 1, promptCacheKey: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', nextMessageSeq: 1,
  } as Session;
  const originalOutput = 'ARCHIVE-FULL '.repeat(3000);
  const messages: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'archive-call', name: 'read', args: {} } }], __meta: { timestamp: 1 } },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'archive-call', name: 'read', response: { output: originalOutput } } }], __meta: { timestamp: 2 } },
    { role: 'user', parts: [{ text: 'tail' }], __meta: { timestamp: 3 } },
  ];
  await archive.appendMessagesToArchive(session, messages); session.history = messages;
  const saves = { count: 0 };
  const result = await sessionHistory.compactToolMessages(makeDepsForSession(session, saves), session.id, 1 / 3);
  assert.equal(result.replacedFunctionResponses, 1);
  assert.equal(session.promptCacheKey, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
  const activeOutput = String(session.history[1].parts[0].functionResponse?.response.output);
  assert.match(activeOutput, /historical tool response pruned/);
  assert.ok(activeOutput.length < originalOutput.length / 10);
  const recalled = await sessionHistory.getArchivedMessages(session.id, { startSeq: 2, endSeq: 2 });
  assert.equal(recalled.records.length, 1);
  assert.equal(recalled.records[0].message.parts[0].functionResponse?.response.output, originalOutput);
});


test('clear, reload and later compact keep block identities and new fork caps without rebuilding history', async () => {
  const { llm, layeredContext } = await loadDeps();
  const manager = await import('../sessionManager');
  const store = await import('./archiveStore');
  const { getSessionHistoryFilePath, serializeSessionHistoryPayload } = await import('./metadataStore');
  const id = makeSessionId('compact_clear_reload');
  const originalChat = llm.chat;
  const createdIds = [id];
  const messages = (): Message[] => [
    { role: 'user', parts: [{ text: `older user ${'alpha '.repeat(3000)}` }] },
    { role: 'model', parts: [{ text: `older model ${'bravo '.repeat(3000)}` }] },
    { role: 'user', parts: [{ text: 'recent user' }] },
    { role: 'model', parts: [{ text: 'recent model' }] },
  ];
  (llm as any).chat = async (_parts: MessagePart[] | null, planner: Session, _iteration: number, options: any): Promise<ChatResult> => {
    const raw = planner.history.filter(message => typeof message.__meta?.seq === 'number');
    assert.equal(raw.length, 2);
    const toolCall = { id: 'clear-counter-plan', name: 'submit_compact_plan', args: { replaceAsBlocks: [{
      level: 1, sourceKind: 'message', sourceStart: raw[0].__meta!.seq, sourceEnd: raw[1].__meta!.seq,
      summary: `Summary for ${raw[0].__meta!.seq}-${raw[1].__meta!.seq}.`,
    }] } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
  };
  const compact = (sessionId: string) => manager.processSessionCompactionRequest(sessionId, { keepPercent: 0.5 }, 'await');
  const reloadWithCounter = async (counter: number): Promise<Session> => {
    // This is the valid persisted payload written by older clear operations.
    const statePath = getSessionHistoryFilePath(id);
    const state = await fs.readJson(statePath);
    state.nextBlockId = counter;
    await fs.writeJson(statePath, state);
    await manager.loadSessions();
    return manager.getSession(id);
  };
  try {
    await manager.createEmptySession(id);
    await manager.appendSessionMessages(id, messages());
    await compact(id);
    let owner = await manager.getSession(id);
    const firstBlocks = await store.readLocalArchiveBlocks(id);
    const firstRows = await store.readLocalArchiveMessages(id);
    assert.deepEqual(firstBlocks.map(block => block.id), [1]);

    const beforeClearFork = await manager.forkSession(id, 'before-clear');
    createdIds.push(beforeClearFork);
    const originalCap = await store.getSessionBranch(beforeClearFork);
    await manager.clearSession(beforeClearFork);
    await manager.appendSessionMessages(beforeClearFork, messages());
    await compact(beforeClearFork);
    assert.deepEqual((await store.readEffectiveArchiveBlocks(beforeClearFork)).map(block => block.id), [1, 2]);
    assert.deepEqual(await store.getSessionBranch(beforeClearFork), originalCap, 'clear does not widen an existing fork cap');

    const nextMessageSeq = owner.nextMessageSeq;
    const cacheKey = owner.promptCacheKey;
    await manager.startSessionWait(id, { waitForInput: true });
    await manager.clearSession(id);
    await manager.loadSessions();
    owner = await manager.getSession(id);
    assert.deepEqual(owner.history, []);
    assert.equal(owner.meta.wait, undefined);
    assert.equal(owner.nextMessageSeq, nextMessageSeq);
    assert.equal(owner.nextBlockId, 2);
    assert.notEqual(owner.promptCacheKey, cacheKey);
    assert.deepEqual(await store.readLocalArchiveBlocks(id), firstBlocks);
    assert.deepEqual(await store.readLocalArchiveMessages(id), firstRows);

    owner = await reloadWithCounter(1);
    assert.equal(owner.nextBlockId, 1, 'hydration is not a counter migration');
    const sourceBefore = structuredClone(serializeSessionHistoryPayload(owner));
    const bytesBefore = await fs.readFile(getSessionHistoryFilePath(id));
    const afterClearFork = await manager.forkSession(id, 'legacy-after-clear');
    createdIds.push(afterClearFork);
    const forked = await manager.getSession(afterClearFork);
    assert.equal(forked.nextBlockId, 2);
    assert.equal((await store.getSessionBranch(afterClearFork))?.forkBlockId, 1);
    assert.equal(forked.history.some(message => !!message.__meta?.contextBlock), false);
    assert.deepEqual(await fs.readFile(getSessionHistoryFilePath(id)), bytesBefore);
    assert.deepEqual(serializeSessionHistoryPayload(owner), sourceBefore, 'the pure source resolver does not mutate local authority');

    await manager.clearSession(id);
    assert.equal(owner.nextBlockId, 2, 'clear recovers an already persisted low counter');
    owner = await reloadWithCounter(1);
    const lowBefore = structuredClone(serializeSessionHistoryPayload(owner));
    assert.deepEqual(await layeredContext.appendBlocksToArchive(owner, []), []);
    assert.deepEqual(serializeSessionHistoryPayload(owner), lowBefore, 'empty block appends stay a true no-op');
    await manager.appendSessionMessages(id, messages());
    await compact(id);
    assert.deepEqual((await store.readLocalArchiveBlocks(id)).map(block => block.id), [1, 2]);
    assert.deepEqual((await store.readLocalArchiveBlocks(id))[0], firstBlocks[0]);
    assert.deepEqual((await store.readLocalArchiveMessages(id)).slice(0, firstRows.length), firstRows);
    assert.equal(owner.nextBlockId, 3);
    assert.equal(owner.history[0].__meta?.contextBlock?.id, 2);
    assert.deepEqual((await store.readEffectiveArchiveBlocks(afterClearFork)).map(block => block.id), [1], 'the new fork cannot see later parent blocks');

    owner = await reloadWithCounter(50);
    await manager.clearSession(id);
    assert.equal(owner.nextBlockId, 50, 'a higher persisted counter never goes backwards');
  } finally {
    (llm as any).chat = originalChat;
    for (const sessionId of createdIds.reverse()) await manager.deleteSession(sessionId).catch(() => {});
  }
});

function repairPathFromFeedback(parts: MessagePart[] | null): string {
  const match = flattenPrompt(parts).match(/Repair the JSON arguments in ("(?:[^"\\]|\\.)*")/);
  assert(match, 'feedback identifies the operation repair file');
  return JSON.parse(match[1]);
}

test('malformed raw compact arguments retain one file through JSON and range retries, exact edits and blocked tools', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const { parseFunctionCallArgs } = await import('../toolCallArgs');
  const session = await makeCompactableSession(archive, makeSessionId('compact_file_repair'));
  const before = structuredClone(session.history);
  const originalChat = llm.chat;
  const invalidArgs = { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 999, summary: 'repaired raw résumé 🦊' }] };
  const validJson = JSON.stringify(invalidArgs, null, 2) + '\n';
  const raw = validJson.slice(0, -2);
  let filePath = '';
  let round = 0;
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, active: Session, _iteration: number, options: any) => {
      round += 1;
      assert.deepEqual(session.history, before);
      if (round > 1) {
        const currentPath = repairPathFromFeedback(parts);
        if (filePath) assert.equal(currentPath, filePath);
        filePath = currentPath;
        assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['plan.json']);
        const expected = round <= 3 ? raw : round <= 5 ? validJson : validJson.replace('999', '2');
        assert.deepEqual(await fs.readFile(filePath), Buffer.from(expected));
        const responses = active.history.flatMap(message => message.parts).filter(part => part.functionResponse?.name === 'submit_compact_plan');
        assert(responses.length > 0);
        assert(!JSON.stringify(responses).includes(raw), 'tool feedback does not duplicate malformed raw JSON');
      }
      let toolCall: any;
      switch (round) {
        case 1: toolCall = { name: 'submit_compact_plan', ...parseFunctionCallArgs(raw) }; break;
        case 2: toolCall = { name: 'submit_compact_plan', args: { argsFilePath: filePath } }; break;
        case 3: toolCall = { name: 'edit', args: { filePath, oldText: '\n  ]\n', newText: '\n  ]\n}\n' } }; break;
        case 4: toolCall = { name: 'submit_compact_plan', args: { argsFilePath: filePath } }; break;
        case 5: toolCall = { name: 'apply_patch', args: { input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-      "sourceEnd": 999,\n+      "sourceEnd": 2,\n*** End Patch` } }; break;
        case 6: toolCall = { name: 'exec', args: { command: 'must never execute' } }; break;
        case 7: toolCall = { name: 'write_memory', args: { filePath: 'must-not-exist.md', content: 'must not write' } }; break;
        case 8: toolCall = { name: 'submit_compact_plan', args: { argsFilePath: path.join(path.dirname(filePath), 'other.json') } }; break;
        case 9: toolCall = { name: 'submit_compact_plan', args: { argsFilePath: filePath, replaceAsBlocks: [] } }; break;
        default: toolCall = { name: 'submit_compact_plan', args: { argsFilePath: filePath } };
      }
      toolCall.id = `file-round-${round}`;
      const toolCalls = round === 6
        ? [toolCall, { id: 'file-round-6-extra', name: 'read', args: { filePath: 'must-not-read.txt' } }]
        : [toolCall];
      if (parts) await options.appendMessage({ role: 'user', parts });
      const allParts = toolCalls.map(functionCall => ({ functionCall }));
      await options.appendMessage({ role: 'model', parts: allParts });
      return { text: '', toolCalls, allParts };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'await');
    assert.equal(round, 10);
    assert.equal(await fs.pathExists(filePath), false);
    assert.equal(await fs.pathExists(path.dirname(filePath)), false);
    assert(session.history.some(message => message.parts.some(part => (part.text || '').includes('repaired raw résumé 🦊'))));
    const planner = session.history.at(-1)!.compaction?.planner;
    assert(planner);
    assert.equal(planner.steps, 10);
    assert.deepEqual(planner.toolCalls.map(call => call.id), [
      ...Array.from({ length: 6 }, (_, index) => `file-round-${index + 1}`), 'file-round-6-extra',
      ...Array.from({ length: 4 }, (_, index) => `file-round-${index + 7}`),
    ]);
    assert.equal(planner.usage, undefined, 'missing provider usage is not fabricated');
    assert.equal(planner.messages.filter(message => message.role === 'model').length, 10);
    assert.equal(planner.messages.filter(message => message.role === 'user').length, 10);
    assert.equal(planner.messages.filter(message => message.role === 'tool').length, 7);
    assert.equal(planner.messages[1].parts[0].functionCall?.rawArgsText, raw);
    assert(JSON.stringify(planner).includes(filePath));
    const modelContext = session.history.map(({ compaction: _compaction, ...message }) => message);
    assert(!JSON.stringify(modelContext).includes(filePath));
    assert(!JSON.stringify(modelContext).includes('must never execute'));
    assert.equal(await fs.pathExists(path.join(path.dirname(path.dirname(path.dirname(filePath))), 'memory', 'must-not-exist.md')), false);
    const records = await archive.readArchiveMessagesBySeqRange(session.id, 1, session.nextMessageSeq);
    assert.deepEqual(records.at(-1)!.message.compaction?.planner, planner, 'repair diagnostics persist only on the completion record');
    assert(!JSON.stringify(records.slice(0, -1)).includes(filePath));
  } finally { (llm as any).chat = originalChat; }
});

test('valid raw compact JSON with invalid endpoints is saved without reserialization and repaired with edit', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const { parseFunctionCallArgs } = await import('../toolCallArgs');
  const session = await makeCompactableSession(archive, makeSessionId('compact_valid_raw_repair'));
  const originalChat = llm.chat;
  const raw = ' { "replaceAsBlocks" : [{"level":1,"sourceKind":"message","sourceStart":1,"sourceEnd":99,"summary":"exact raw repair"}] }\r\n';
  let filePath = '';
  let round = 0;
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      round += 1;
      let toolCall: any;
      if (round === 1) toolCall = { name: 'submit_compact_plan', ...parseFunctionCallArgs(raw) };
      else {
        const currentPath = repairPathFromFeedback(parts);
        if (filePath) assert.equal(currentPath, filePath);
        filePath = currentPath;
        if (round <= 4) {
          assert.deepEqual(await fs.readFile(filePath), Buffer.from(raw));
          toolCall = { name: 'edit', args: { filePath, oldText: '"sourceEnd":99', newText: '"sourceEnd":2', ...(round === 2 ? { __cancelTool: true } : round === 3 ? { __cancelTool: false } : {}) } };
        } else toolCall = { name: 'submit_compact_plan', args: { argsFilePath: filePath } };
      }
      toolCall.id = `valid-raw-${round}`;
      await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'await');
    assert.equal(round, 5);
    assert.equal(await fs.pathExists(filePath), false);
    assert(session.history.some(message => message.parts.some(part => (part.text || '').includes('exact raw repair'))));
  } finally { (llm as any).chat = originalChat; }
});

test('pending repair files are cleaned after planner error or round exhaustion without changing live history', async () => {
  const { sessionHistory, archive, llm, compactPlan } = await loadDeps();
  const originalChat = llm.chat;
  try {
    for (const outcome of ['provider-error', 'round-exhaustion'] as const) {
      const session = await makeCompactableSession(archive, makeSessionId(`compact_repair_${outcome}`));
      const before = structuredClone(session.history);
      let filePath = '';
      let round = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
        round += 1;
        if (round > 1) {
          const currentPath = repairPathFromFeedback(parts);
          if (filePath) assert.equal(currentPath, filePath);
          filePath = currentPath;
          if (outcome === 'provider-error') throw new Error('held planner failure');
        }
        const toolCall = { id: `exhaust-${round}`, name: 'submit_compact_plan', args: {}, rawArgsText: '{', argsParseError: 'bad JSON' };
        await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
        return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
      };
      await assert.rejects(sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'await'), outcome === 'provider-error' ? /held planner failure/ : /Compaction skipped after 15/);
      assert.equal(round, outcome === 'provider-error' ? 2 : compactPlan.COMPACT_FLOW_MAX_ROUNDS);
      assert.deepEqual(session.history, before);
      assert.equal(await fs.pathExists(filePath), false);
      assert.equal(await fs.pathExists(path.dirname(filePath)), false);
    }
  } finally { (llm as any).chat = originalChat; }
});

test('cancelling a compact planner with a pending repair file cleans it and preserves live history', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_repair_cancel'));
  const before = structuredClone(session.history);
  const deps = makeDepsForSession(session, { count: 0 });
  const originalChat = llm.chat;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let round = 0;
  let filePath = '';
  try {
    (llm as any).chat = async (parts: MessagePart[] | null, _active: Session, _iteration: number, options: any) => {
      round += 1;
      if (round === 1) {
        const toolCall = { id: 'cancel-invalid', name: 'submit_compact_plan', args: {}, rawArgsText: '{', argsParseError: 'bad JSON' };
        await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
        return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
      }
      filePath = repairPathFromFeedback(parts);
      assert.equal(await fs.readFile(filePath, 'utf8'), '{');
      started();
      await new Promise<void>((_resolve, reject) => options.abortSignal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }, { once: true }));
      throw new Error('unreachable');
    };
    const running = sessionHistory.processSessionCompactionRequest(deps, session.id, { keepPercent: 0.5 }, 'await');
    await entered;
    assert.deepEqual(await sessionHistory.cancelSessionCompaction(deps, session.id), { outcome: 'cancelled', phase: 'planning' });
    await running;
    assert.equal(round, 2);
    assert.deepEqual(session.history, before);
    assert.equal(await fs.pathExists(filePath), false);
    assert.equal(await fs.pathExists(path.dirname(filePath)), false);
  } finally { (llm as any).chat = originalChat; }
});
