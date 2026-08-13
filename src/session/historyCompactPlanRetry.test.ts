import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import type { ChatResult, Message, MessagePart, Session } from '../types';

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

function makeDepsForSession(session: Session, saveCounter: { count: number }) {
  return {
    getSessionById: (sessionId: string) => sessionId === session.id ? session : undefined,
    getExistingSession: async (sessionId: string) => sessionId === session.id ? session : null,
    saveSession: async (_sessionId: string) => { saveCounter.count += 1; },
    enqueueSessionItem: async (_sessionId: string) => {},
    notifyHistoryUpdate: (_sessionId: string, _message: Message) => {},
  };
}

async function waitForCompactReady(sessionHistory: LoadedDeps['sessionHistory'], sessionId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (sessionHistory.hasPendingCompactWork(sessionId)) {
      await new Promise(resolve => setTimeout(resolve, 5));
      continue;
    }
    throw new Error('compact job disappeared before commit');
  }
}

test('compact planning retries plain-text/no-tool response and succeeds on a later submit_compact_plan call', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_retry_plain_text_success'));
  const saveCounter = { count: 0 };
  const prompts: string[] = [];
  const purposes: Array<string | undefined> = [];
  const originalChat = llm.chat;
  session.effort = 'none';
  session.childEffortDefault = 'max';

  try {
    (llm as any).chat = async (
      parts: MessagePart[] | null,
      activeSession: Session,
      _iteration: number,
      options?: { appendMessage?: (message: Message) => Promise<void> | void; purpose?: string },
    ): Promise<ChatResult> => {
      assert.equal((activeSession as any).__compactJob, true);
      assert.equal(activeSession.effort, 'none');
      assert.equal(activeSession.childEffortDefault, 'max');
      prompts.push(flattenPrompt(parts));
      purposes.push(options?.purpose);

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
    assert.deepEqual(purposes, ['compact-plan', 'compact-plan']);
    assert.match(prompts[0], /COMPACTION STARTED/);
    assert.match(prompts[1], /COMPACT TOOL CALL INVALID/);
    assert.match(prompts[1], /plain text\/no tool call cannot complete compaction/i);
    assert.match(prompts[1], /submit_compact_plan/);
    assert(session.history.some(message => message.parts.some(part => /summary after retrying a missing compact tool call/.test(part.text || ''))));
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"'))));
    assert.equal(session.history[0]?.__meta?.contextBlock?.level, 1);
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
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.id, session.history);
  const firstTwo = built.candidateEntries.filter(entry => entry.item.kind === 'block').slice(0, 2);
  assert.notEqual(firstTwo[0]?.item.segmentId, firstTwo[1]?.item.segmentId);
  assert.deepEqual(session.history[1], before);
});

test('missing or conflicting active/archive provenance becomes a compact barrier without editing history', async () => {
  const { sessionHistory, archive } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_provenance_barriers'));
  const original = structuredClone(session.history);
  session.history[0].parts = [{ text: 'offline same-seq wording edit' }];
  session.history.splice(1, 0, structuredClone(session.history[0]));
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.id, session.history);
  assert.equal(built.candidateEntries.some(entry => entry.item.kind === 'message' && entry.item.startSeq === 1), false);
  assert.deepEqual(session.history[0].parts, [{ text: 'offline same-seq wording edit' }]);
  assert.deepEqual(original[2], session.history[3]);
});

test('invalid preserved raw provenance is retained and never offered for removal', async () => {
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
    const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.id, session.history);
    assert.equal(built.preservedMessageCandidates.length, 0, scenario);
    assert.throws(() => compactPlan.validateCompactPlanArgs(
      { createBlocksJson: '[]', removePreservedMessages: [preserved.__meta!.seq] },
      built.candidateEntries.map(entry => entry.item),
      { removablePreservedMessages: built.preservedMessageCandidates },
    ), /removePreservedMessages/i, scenario);
    assert.deepEqual(session.history, before, `${scenario} preserved rows remain byte-semantic exact`);
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
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.id, session.history);
  assert.deepEqual(built.candidateEntries.filter(entry => entry.item.kind === 'message').map(entry => (entry.item as any).startSeq), [1, 3]);
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
  const built = await sessionHistory.buildLayeredCompactCandidateEntries(session.id, session.history);
  const firstTwo = built.candidateEntries.filter(entry => entry.item.kind === 'block').slice(0, 2);
  assert.notEqual(firstTwo[0]?.item.segmentId, firstTwo[1]?.item.segmentId);
  const originalChat = llm.chat;
  (llm as any).chat = async (_parts: any, _activeSession: Session, _iteration: number, options: any) => {
    const toolCall = { id: 'bad-reordered-range', name: 'submit_compact_plan', args: { createBlocksJson: JSON.stringify([{
      level: 2, sourceKind: 'block', sourceStart: blocks[1].id, sourceEnd: blocks[0].id, summary: 'must be rejected',
    }]) } };
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
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 3,
            summary: 'summary across a prior compact completion marker',
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
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary replacing the older raw pair',
          }]),
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, saveCounter), session.id, { keepPercent: 0.6 }, 'await');

    const compactCompletions = session.history.filter(message => message.parts.some(part => (part.system || '').includes('event="compact-completed"')));
    assert.equal(compactCompletions.length, 1, 'only the current compact completion remains active');
    assert(compactCompletions[0].parts.some(part => (part.system || '').includes('goal-reminder')), 'current completion retains the current goal reminder');
    assert.equal(session.history.some(message => message.__meta?.seq === 3), false, 'old completion is removed even from the force-kept tail');
    assert.equal(session.history.some(message => message.parts.some(part => part.system === inheritedBoundary)), true, 'unrelated session boundary remains active');
    assert.equal(session.history.some(message => message.parts.some(part => part.text === 'recent real user content')), true, 'real content remains active');
    const archived = await archive.readArchiveMessagesBySeqRange(session.id, 3, 3);
    assert.equal(archived[0]?.message.parts[0]?.system, oldCompletion, 'old completion remains in durable archive');
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
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary whose durable facts are framework-rendered',
            memoryFacts: [{ kind: 'decision', text: 'Keep compact facts attached to their creating block.', attributedTo: 'user' }],
          }]),
        },
      };
      await Promise.resolve(options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] }));
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    (vector as any).indexMemoryFactsFromCompaction = async () => { throw new Error('embedding unavailable'); };

    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, saveCounter), session.id, { keepPercent: 0.5 }, 'await');

    const [block] = await layeredContext.readArchiveBlocksByIdRange(session.id, 1, 1);
    assert.deepEqual(block.memoryFacts, [{ kind: 'decision', text: 'Keep compact facts attached to their creating block.', attributedTo: 'user' }]);
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
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      const toolCall = { id: 'authority-failure', name: 'submit_compact_plan', args: { createBlocksJson: JSON.stringify([{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must be rolled back',
      }]) } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await assert.rejects(() => sessionHistory.processSessionCompactionRequest({
      ...makeDepsForSession(session, { count: 0 }),
      saveSession: async () => { throw new Error('injected compact authority persistence failure'); },
    }, session.id, { keepPercent: 0.5 }, 'await'), /injected compact authority persistence failure/);
    assert.deepEqual(session.history, originalHistory);
    assert.equal(session.nextBlockId, originalNextBlockId);
    assert.equal(session.historyVersion, originalHistoryVersion);
    assert.equal((await layeredContext.readLocalArchiveBlocks(session.id)).length, 0);
    assert.equal((await archive.readArchiveMessages(session.id)).length, originalHistory.length);
  } finally { (llm as any).chat = originalChat; }
});

test('background compact validates exact snapshot content and rejects same-metadata offline edits', async () => {
  const { sessionHistory, archive, llm } = await loadDeps();
  const session = await makeCompactableSession(archive, makeSessionId('compact_exact_snapshot_edit'));
  const originalChat = llm.chat;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      await gate;
      const toolCall = { id: 'exact-edit', name: 'submit_compact_plan', args: { createBlocksJson: JSON.stringify([{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'must not commit over edited history',
      }]) } };
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
  const originalChat = llm.chat;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    (llm as any).chat = async (_parts: MessagePart[] | null, _session: Session, _iteration: number, options?: any): Promise<ChatResult> => {
      await gate;
      const toolCall = { id: 'suffix', name: 'submit_compact_plan', args: { createBlocksJson: JSON.stringify([{
        level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, summary: 'compacted before appended suffix',
      }]) } };
      await options?.appendMessage?.({ role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };
    await sessionHistory.processSessionCompactionRequest(makeDepsForSession(session, { count: 0 }), session.id, { keepPercent: 0.5 }, 'background');
    const suffix: Message = { role: 'user', parts: [{ text: 'compatible appended suffix survives' }], __meta: { seq: 5, timestamp: 5000 } };
    session.history.push(suffix);
    release();
    for (let index = 0; index < 200; index += 1) {
      const applied = await sessionHistory.applyCompletedCompactJob(makeDepsForSession(session, { count: 0 }), session.id);
      if (!sessionHistory.hasPendingCompactWork(session.id)) {
        assert.equal(applied, true);
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
    const output = String(plan.rewrittenHistory[1].parts[0].functionResponse?.response.output);
    assert.match(output, /historical tool response pruned/);
    if (index === 1) assert.match(output, /small error sibling/);
    if (index === 2) assert.match(output, /small content sibling/);
    if (index === 3) assert.match(output, /small/);
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
