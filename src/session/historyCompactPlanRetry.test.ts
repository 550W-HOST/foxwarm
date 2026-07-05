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

      const [sessionHistory, archive, compactPlan, llm] = await Promise.all([
        import('./history'),
        import('./archive'),
        import('./compactPlan'),
        import('../llm'),
      ]);

      return { tempRoot, sessionHistory, archive, compactPlan, llm };
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
    assert(session.history.some(message => message.parts.some(part => /COMPACTION COMPLETED/i.test(part.system || ''))));
    assert.equal(session.contextFrontier?.[0]?.kind, 'block');
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
