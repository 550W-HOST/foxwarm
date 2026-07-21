import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import type { ChatResult, Message, MessagePart, Session } from '../types';

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
    contextFrontier: [],
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
  session.contextFrontier = messages.map(message => ({
    kind: 'message' as const,
    seq: message.__meta!.seq!,
  }));

  return session;
}

function makeDepsForSession(session: Session, saveCounter: { count: number }) {
  return {
    getSessionById: (sessionId: string) => sessionId === session.id ? session : undefined,
    getExistingSession: async (sessionId: string) => sessionId === session.id ? session : null,
    saveSession: async (_sessionId: string) => { saveCounter.count += 1; },
    enqueueSessionItem: async (_sessionId: string) => {},
    notifyHistoryUpdate: (_sessionId: string, _message: Message) => {},
  };
}

test('compact planning retries plain-text/no-tool response and succeeds on a later submit_compact_plan call', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_plain_text_success'));
  const saveCounter = { count: 0 };
  const prompts: string[] = [];
  const originalChat = llm.chat;

  try {
    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
      prompts.push(flattenPrompt(parts));

      if (prompts.length === 1) {
        const text = 'I can summarize this in plain text, but I forgot the tool call.';
        await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ text }] }));
        return { text, toolCalls: [], allParts: [{ text }] };
      }

      const toolCall = {
        id: 'compact-plan-after-plain-text',
        name: 'submit_compact_plan',
        args: {
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary after retrying a missing compact tool call',
          }]),
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(
      makeDepsForSession(session, saveCounter),
      session.id,
      { keepPercent: 0.5 },
      'await',
    );

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /COMPACTION STARTED/);
    assert.match(prompts[1], /COMPACT TOOL CALL INVALID/);
    assert.match(prompts[1], /plain text\/no tool call cannot complete compaction/i);
    assert.match(prompts[1], /submit_compact_plan/);
    assert(session.history.some(message => message.parts.some(part => /summary after retrying a missing compact tool call/.test(part.text || ''))));
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))));
    assert.equal(session.contextFrontier?.[0]?.kind, 'block');
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('compact planning rejects a block-only plan when raw messages and L1 blocks are both eligible, then repairs it', async () => {
  const { sessionHistory, archive, layeredContext, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_raw_quota'));
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const prompts: string[] = [];

  try {
    // Keep the archived source messages but replace the active frontier with
    // five large L1 blocks followed by two large raw messages.
    const blocks = await layeredContext.appendBlocksToArchive(session, Array.from({ length: 5 }, (_, index) => ({
      level: 1,
      sourceKind: 'message' as const,
      sourceStart: 1,
      sourceEnd: 1,
      rawStartSeq: 1,
      rawEndSeq: 1,
      summary: `L1 backlog ${index + 1} ${'block-summary '.repeat(1800)}`,
    })));
    session.contextFrontier = [
      ...blocks.map(block => ({ kind: 'block' as const, id: block.id, level: block.level, rawStartSeq: block.rawStartSeq, rawEndSeq: block.rawEndSeq })),
      { kind: 'message' as const, seq: 1 },
      { kind: 'message' as const, seq: 2 },
    ];
    session.history = await layeredContext.renderHistoryFromFrontier(session, session.contextFrontier);

    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
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
        args: { createBlocksJson: JSON.stringify(createBlocks) },
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
    assert.match(prompts[0], /Raw messages: .*message-source createBlocks must actually replace at least/i);
    assert.match(prompts[0], /Source L1 blocks: 5 block\(s\).*newest 3 are force-kept.*oldest 2 may be listed/is);
    assert.match(prompts[1], /RAW-MESSAGE HARD QUOTA REQUIRES/i);
    assert.equal(session.contextFrontier?.filter(item => item.kind === 'block').length, 5);
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});

test('ignored lifecycle messages are hard compact segment barriers and survive neighboring range replacement', async () => {
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
    contextFrontier: [],
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
  session.contextFrontier = messages.map(message => ({ kind: 'message' as const, seq: message.__meta!.seq! }));
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
        id: 'compact-before-lifecycle-boundary',
        name: 'submit_compact_plan',
        args: {
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 1,
            summary: 'summary before protected lifecycle boundary',
          }]),
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

    assert.match(firstPrompt, /Segment 1: raw message candidates.*M#1/s);
    assert.match(firstPrompt, /Segment 2: raw message candidates.*M#3/s);
    assert.equal(session.contextFrontier?.[0]?.kind, 'block');
    assert.deepEqual(session.contextFrontier?.[1], { kind: 'message', seq: 2 });
    assert(session.history.some(message => message.parts.some(part => part.system === lifecycleText)));
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
  const originalFrontier = structuredClone(session.contextFrontier);
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
    assert.deepEqual(session.contextFrontier, originalFrontier);
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
  const saveCounter = { count: 0 };
  const originalChat = llm.chat;
  const originalHistory = structuredClone(session.history);
  const originalFrontier = structuredClone(session.contextFrontier);
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
    assert.deepEqual(session.contextFrontier, originalFrontier);
    assert.equal(session.nextBlockId, originalNextBlockId);
    assert.equal(session.promptCacheKey, originalPromptCacheKey);
    assert.equal(session.historyVersion, 0);
    assert.equal(sessionHistory.hasPendingCompactWork(session.id), false);
  } finally {
    (llm as any).chat = originalChat;
    if (!SAVE_GENERATED_SESSION_LOGS) {
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.jsonl`)).catch(() => {});
      await fs.remove(path.join((await loadDeps()).tempRoot, 'logs', 'sessions', `${session.id}.blocks.jsonl`)).catch(() => {});
    }
  }
});
