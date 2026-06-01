import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import type { Session } from '../types';

type LoadedDeps = {
  tempRoot: string;
  sessionManager: typeof import('../sessionManager');
  toolsSessionAgent: typeof import('../toolsSessionAgent');
  archive: typeof import('../session/archive');
  layeredContext: typeof import('../session/layeredContext');
};

let depsPromise: Promise<LoadedDeps> | null = null;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

async function loadDeps(): Promise<LoadedDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-guard-'));
      process.env.FOXWARM_DATA_DIR = tempRoot;

      const [sessionManager, toolsSessionAgent, archive, layeredContext] = await Promise.all([
        import('../sessionManager'),
        import('../toolsSessionAgent'),
        import('../session/archive'),
        import('../session/layeredContext'),
      ]);

      await sessionManager.loadSessions();
      return { tempRoot, sessionManager, toolsSessionAgent, archive, layeredContext };
    })();
  }

  return depsPromise;
}

async function ensureSession(sessionManager: typeof import('../sessionManager'), id: string): Promise<Session> {
  const session = await sessionManager.getSession(id);
  Object.assign(session, createBaseSession(id));
  await sessionManager.saveSession(id);
  return session;
}

async function appendTextMessages(sessionManager: typeof import('../sessionManager'), session: Session, texts: string[]): Promise<void> {
  for (const text of texts) {
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts: [{ text }],
    });
  }
}

async function createArchivedSession(deps: LoadedDeps, sessionId: string): Promise<void> {
  const session: Session = {
    ...createBaseSession(sessionId),
    nextMessageSeq: 1,
    nextBlockId: 1,
    contextFrontier: [],
  } as Session;

  await deps.archive.appendMessagesToArchive(session, [
    { role: 'user', parts: [{ text: 'archived alpha' }], __meta: { timestamp: 1000 } },
    { role: 'model', parts: [{ text: 'archived beta' }], __meta: { timestamp: 2000 } },
    { role: 'user', parts: [{ text: 'archived gamma' }], __meta: { timestamp: 3000 } },
    { role: 'model', parts: [{ text: 'archived delta' }], __meta: { timestamp: 4000 } },
  ]);

  await deps.layeredContext.appendBlocksToArchive(session, [
    { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1, summary: 'block alpha' },
    { level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2, rawStartSeq: 2, rawEndSeq: 2, summary: 'block beta' },
    { level: 1, sourceKind: 'message', sourceStart: 3, sourceEnd: 3, rawStartSeq: 3, rawEndSeq: 3, summary: 'block gamma' },
    { level: 2, sourceKind: 'block', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2, summary: 'parent alpha beta block' },
  ]);
}

test('get_session_messages enforces preview-budget guard but exempts single-message requests', async () => {
  const { sessionManager, toolsSessionAgent } = await loadDeps();
  const sessionId = makeId('archive_guard_session_messages');

  try {
    const session = await ensureSession(sessionManager, sessionId);
    await appendTextMessages(sessionManager, session, ['one', 'two', 'three']);

    const okResult = await toolsSessionAgent.tool_get_session_messages({
      sessionId,
      count: 2,
      previewLength: 10_000,
    }, {});
    assert.match(String(okResult), /showing 2 of 3 message\(s\)/i);

    await assert.rejects(
      () => toolsSessionAgent.tool_get_session_messages({
        sessionId,
        count: 3,
        previewLength: 7_000,
      }, {}),
      /Request too large for get_session_messages: requested preview budget is 21000 characters, exceeding the 20000-character limit/i,
    );

    const singleResult = await toolsSessionAgent.tool_get_session_messages({
      sessionId,
      count: 1,
      previewLength: 50_000,
    }, {});
    assert.match(String(singleResult), /showing 1 of 3 message\(s\)/i);
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failure in tests
    }
  }
});

test('archived message/block tools enforce preview-budget guard and exempt single-item requests', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('archive_guard_archived_items');
  await createArchivedSession(deps, sessionId);

  const okMessages = await deps.toolsSessionAgent.tool_get_archived_messages({
    sessionId,
    startSeq: 1,
    endSeq: 2,
    previewLength: 10_000,
  });
  assert.match(String(okMessages), /showing 2 of 2 matched message\(s\)/i);

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_get_archived_messages({
      sessionId,
      startSeq: 1,
      endSeq: 3,
      previewLength: 7_000,
    }),
    /Request too large for get_archived_messages: requested preview budget is 21000 characters/i,
  );

  const singleMessage = await deps.toolsSessionAgent.tool_get_archived_messages({
    sessionId,
    startSeq: 1,
    endSeq: 1,
    previewLength: 50_000,
  });
  assert.match(String(singleMessage), /archived alpha/);

  const okBlocks = await deps.toolsSessionAgent.tool_get_archived_blocks({
    sessionId,
    startId: 1,
    endId: 2,
    previewLength: 10_000,
  });
  assert.match(String(okBlocks), /showing 2 of 2 matched block\(s\)/i);

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_get_archived_blocks({
      sessionId,
      startId: 1,
      endId: 3,
      previewLength: 7_000,
    }),
    /Request too large for get_archived_blocks: requested preview budget is 21000 characters/i,
  );

  const singleBlock = await deps.toolsSessionAgent.tool_get_archived_blocks({
    sessionId,
    startId: 2,
    endId: 2,
    previewLength: 50_000,
  });
  assert.match(String(singleBlock), /block beta/);
});

test('recall rejects legacy context archive parameters with target-selector guidance', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_legacy_args');
  await createArchivedSession(deps, sessionId);

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_recall({
      sessionId,
      startSeq: 1,
      includeMessages: true,
    }),
    /legacy get_context_archive parameters: startSeq, includeMessages[\s\S]*recall\(\{"target":"msg#10637-10680"\}\)/i,
  );

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_recall({
      sessionId,
      target: 'raw#1-2',
    }),
    /old raw syntax[\s\S]*Use `msg#/i,
  );
});

test('recall overview is short and advertises message/block ranges with examples', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_overview');
  await createArchivedSession(deps, sessionId);

  const overview = String(await deps.toolsSessionAgent.tool_recall({ sessionId }));
  assert.match(overview, /Recall overview/);
  assert.match(overview, /Available message log: msg#1-4/);
  assert.match(overview, /Layered CTX-BLOCK archive: B#1-B#4/);
  assert.match(overview, /L1: 3/);
  assert.match(overview, /L2: 1/);
  assert.match(overview, /working context may already contain active CTX-BLOCK summaries/i);
  assert.match(overview, /recall\(\{"sessionId":"[^"}]+","target":"blocks"\}\)/);
  assert.match(overview, /recall\(\{"sessionId":"[^"}]+","target":"B#4"\}\)/);
  assert.match(overview, /message targets can return lots of irrelevant content/i);
  assert.match(overview, /msg:B#11/);
  assert.match(overview, /msg#3907-4329/);
  assert.doesNotMatch(overview, /latest:/);
  assert.doesNotMatch(overview, /archived alpha/);
  assert.doesNotMatch(overview, /block alpha/);
});

test('recall blocks target lists only parentless frontier blocks sorted by message range', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_frontier_blocks');
  await createArchivedSession(deps, sessionId);

  const directory = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'blocks', previewLength: 200 }));
  assert.match(directory, /Current CTX-BLOCK frontier/);
  assert.match(directory, /\[CTX-BLOCK L2 B#4 raw#1-#2/);
  assert.match(directory, /\[CTX-BLOCK L2 B#4 raw#1-#2 time 1970-01-01 08:00:01 \+0800 -> 1970-01-01 08:00:02 \+0800\]/);
  assert.match(directory, /parent alpha beta block/);
  assert.match(directory, /\[CTX-BLOCK L1 B#3 raw#3/);
  assert.match(directory, /\[CTX-BLOCK L1 B#3 raw#3 time 1970-01-01 08:00:03 \+0800\]/);
  assert.match(directory, /block gamma/);
  assert.doesNotMatch(directory, /\[CTX-BLOCK L1 B#1/);
  assert.doesNotMatch(directory, /\[CTX-BLOCK L1 B#2/);
  assert.doesNotMatch(directory, / from (?:messages|blocks) /);
  assert.ok(directory.indexOf('B#4') < directory.indexOf('B#3'), 'frontier should be sorted by message range, not latest block id');
});

test('recall target selectors read block details and message ranges', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_targets');
  await createArchivedSession(deps, sessionId);

  const messageBackedBlock = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'B#1', previewLength: 200 }));
  assert.match(messageBackedBlock, /CTX-BLOCK B#1/);
  assert.match(messageBackedBlock, /Block: \[CTX-BLOCK L1 B#1 raw#1 time 1970-01-01 08:00:01 \+0800\] block alpha/);
  assert.match(messageBackedBlock, /Covers: msg#1/);
  assert.match(messageBackedBlock, /Source: messages msg#1/);
  assert.match(messageBackedBlock, /Source messages/);
  assert.match(messageBackedBlock, /\[#1 time 1970-01-01 08:00:01 \+0800\]/);
  assert.match(messageBackedBlock, /archived alpha/);
  assert.doesNotMatch(messageBackedBlock, /recall\(\{"sessionId":"[^"}]+","target":"B#1"\}\)/);
  assert.doesNotMatch(messageBackedBlock, /target":"msg:B#1"/);
  assert.doesNotMatch(messageBackedBlock, /\n\nNext:/);

  const parentBlock = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'block#4', previewLength: 200 }));
  assert.match(parentBlock, /CTX-BLOCK B#4/);
  assert.match(parentBlock, /Block: \[CTX-BLOCK L2 B#4 raw#1-#2 time 1970-01-01 08:00:01 \+0800 -> 1970-01-01 08:00:02 \+0800\] parent alpha beta block/);
  assert.match(parentBlock, /Covers: msg#1-2/);
  assert.match(parentBlock, /Source: blocks B#1-B#2/);
  assert.match(parentBlock, /Immediate child blocks \(B#1-B#2\)/);
  assert.match(parentBlock, /\[CTX-BLOCK L1 B#1 raw#1 time 1970-01-01 08:00:01 \+0800\] block alpha/);
  assert.match(parentBlock, /block alpha/);
  assert.match(parentBlock, /block beta/);
  assert.doesNotMatch(parentBlock, / from messages msg#/);
  assert.doesNotMatch(parentBlock, / from blocks B#/);
  assert.doesNotMatch(parentBlock, /Archived messages for session/);
  assert.doesNotMatch(parentBlock, /target":"B#4"/);

  const messagesForBlock = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'msg:B#4', previewLength: 200 }));
  assert.match(messagesForBlock, /Messages covered by CTX-BLOCK B#4 \(msg#1-2 time 1970-01-01 08:00:01 \+0800 -> 1970-01-01 08:00:02 \+0800\)/);
  assert.match(messagesForBlock, /\[#1 time 1970-01-01 08:00:01 \+0800\]/);
  assert.match(messagesForBlock, /\[#2 time 1970-01-01 08:00:02 \+0800\]/);
  assert.match(messagesForBlock, /archived alpha/);
  assert.match(messagesForBlock, /archived beta/);
  assert.doesNotMatch(messagesForBlock, /archived gamma/);
  assert.doesNotMatch(messagesForBlock, /\n\nSuggestions/);

  const messageRange = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'msg#2-3', previewLength: 200 }));
  assert.match(messageRange, /\[#2 time 1970-01-01 08:00:02 \+0800\]/);
  assert.match(messageRange, /\[#3 time 1970-01-01 08:00:03 \+0800\]/);
  assert.match(messageRange, /archived beta/);
  assert.match(messageRange, /archived gamma/);
  assert.doesNotMatch(messageRange, /archived alpha/);
  assert.doesNotMatch(messageRange, /\n\nSuggestions/);
  assert.doesNotMatch(messageRange, /\n\nNext:/);

  const singleMessage = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'msg#2', previewLength: 200 }));
  assert.match(singleMessage, /\[#2 time 1970-01-01 08:00:02 \+0800\]/);
  assert.match(singleMessage, /archived beta/);
  assert.doesNotMatch(singleMessage, /archived alpha/);
  assert.doesNotMatch(singleMessage, /archived gamma/);
  assert.doesNotMatch(singleMessage, /\n\nSuggestions/);
});

test('recall rejects unsupported targets with examples', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_unsupported');
  await createArchivedSession(deps, sessionId);

  for (const target of ['latest:blocks:10', 'raw:B#1', 'blocks#1-2']) {
    await assert.rejects(
      () => deps.toolsSessionAgent.tool_recall({ sessionId, target }),
      /Supported recall target selectors:[\s\S]*recall\(\{"target":"blocks"\}\)[\s\S]*recall\(\{"target":"B#126"\}\)/i,
    );
  }
});

test('recall enforces preview-budget guard for broad ranges but exempts single items', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_preview_guard');
  await createArchivedSession(deps, sessionId);
  const session: Session = {
    ...createBaseSession(sessionId),
    nextMessageSeq: 5,
    nextBlockId: 5,
    contextFrontier: [],
  } as Session;
  await deps.layeredContext.appendBlocksToArchive(session, [
    { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 4, rawStartSeq: 1, rawEndSeq: 4, summary: 'wide message-backed block' },
  ]);

  const singleMessage = await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 50_000,
  });
  assert.match(String(singleMessage), /archived alpha/);

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_recall({
      sessionId,
      target: 'msg#1-4',
      previewLength: 6_000,
    }),
    /Target msg#1-4 matches 4 message\(s\).*4 × 6000 = 24000.*exceeding the 20000-character limit[\s\S]*Prefer `B#N` CTX-BLOCK drill-down first/i,
  );

  const overBudgetBlock = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'B#5',
    previewLength: 6_000,
  }));
  assert.match(overBudgetBlock, /CTX-BLOCK B#5/);
  assert.match(overBudgetBlock, /B#5 covers msg#1-4 time 1970-01-01 08:00:01 \+0800 -> 1970-01-01 08:00:04 \+0800 \(4 message\(s\)\)/);
  assert.match(overBudgetBlock, /4 × 6000 = 24000/);
  assert.match(overBudgetBlock, /msg#1-3/);
  assert.doesNotMatch(overBudgetBlock, /target":"B#5"/);
  assert.doesNotMatch(overBudgetBlock, /Archived messages for session/);
});

test('recall blocks target caps large frontier output while suggesting B# drill-down', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_frontier_cap');
  const session: Session = {
    ...createBaseSession(sessionId),
    nextMessageSeq: 1,
    nextBlockId: 1,
    contextFrontier: [],
  } as Session;

  await deps.archive.appendMessagesToArchive(session, Array.from({ length: 25 }, (_, index) => ({
    role: 'user' as const,
    parts: [{ text: `frontier message ${index + 1}` }],
    __meta: { timestamp: 10_000 + index },
  })));
  await deps.layeredContext.appendBlocksToArchive(session, Array.from({ length: 25 }, (_, index) => ({
    level: 1,
    sourceKind: 'message' as const,
    sourceStart: index + 1,
    sourceEnd: index + 1,
    rawStartSeq: index + 1,
    rawEndSeq: index + 1,
    summary: `frontier block ${index + 1}`,
  })));

  const directory = String(await deps.toolsSessionAgent.tool_recall({ sessionId, target: 'blocks', previewLength: 1000 }));
  assert.match(directory, /Current CTX-BLOCK frontier/);
  assert.match(directory, /Frontier has 25 block\(s\); showing 20/);
  assert.match(directory, /Pick a specific `B#N`/);
  assert.match(directory, /\[CTX-BLOCK L1 B#20 raw#20/);
  assert.doesNotMatch(directory, /\[CTX-BLOCK L1 B#21/);
});

test('recall lets previewLength control archived tool response previews and treats zero as default', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_tool_preview');
  const longOutput = `TOOL_OUTPUT_BEGIN_${'x'.repeat(700)}_TOOL_OUTPUT_END`;
  const session: Session = {
    ...createBaseSession(sessionId),
    nextMessageSeq: 1,
    nextBlockId: 1,
    contextFrontier: [],
  } as Session;

  await deps.archive.appendMessagesToArchive(session, [
    {
      role: 'tool',
      parts: [
        {
          functionResponse: {
            tool_use_id: 'call_long_tool_output',
            name: 'demo_tool',
            response: { output: longOutput },
          },
        },
      ],
      __meta: { timestamp: 4000 },
    },
  ]);

  const stored = await deps.sessionManager.getArchivedMessages(sessionId, { startSeq: 1, endSeq: 1 });
  assert.equal(stored.records[0]?.message.parts[0]?.functionResponse?.response?.output, longOutput);

  const shortPreview = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 120,
  }));
  assert.doesNotMatch(shortPreview, /TOOL_OUTPUT_END/);

  const longPreview = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 1000,
  }));
  assert.match(longPreview, /\[tool:demo_tool\]/);
  assert.match(longPreview, /TOOL_OUTPUT_BEGIN/);
  assert.match(longPreview, /TOOL_OUTPUT_END/);
  assert.ok(longPreview.length > shortPreview.length + 500);

  const defaultPreview = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 0,
  }));
  assert.match(defaultPreview, /TOOL_OUTPUT_END/);
});
