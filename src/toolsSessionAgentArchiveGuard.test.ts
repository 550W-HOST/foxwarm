import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import type { Session } from './types';

type LoadedDeps = {
  tempRoot: string;
  sessionManager: typeof import('./sessionManager');
  toolsSessionAgent: typeof import('./toolsSessionAgent');
  archive: typeof import('./session/archive');
  layeredContext: typeof import('./session/layeredContext');
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
        import('./sessionManager'),
        import('./toolsSessionAgent'),
        import('./session/archive'),
        import('./session/layeredContext'),
      ]);

      await sessionManager.loadSessions();
      return { tempRoot, sessionManager, toolsSessionAgent, archive, layeredContext };
    })();
  }

  return depsPromise;
}

async function ensureSession(sessionManager: typeof import('./sessionManager'), id: string): Promise<Session> {
  const session = await sessionManager.getSession(id);
  Object.assign(session, createBaseSession(id));
  await sessionManager.saveSession(id);
  return session;
}

async function appendTextMessages(sessionManager: typeof import('./sessionManager'), session: Session, texts: string[]): Promise<void> {
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
  ]);

  await deps.layeredContext.appendBlocksToArchive(session, [
    { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1, summary: 'block alpha' },
    { level: 1, sourceKind: 'message', sourceStart: 2, sourceEnd: 2, rawStartSeq: 2, rawEndSeq: 2, summary: 'block beta' },
    { level: 1, sourceKind: 'message', sourceStart: 3, sourceEnd: 3, rawStartSeq: 3, rawEndSeq: 3, summary: 'block gamma' },
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

test('get_context_archive sums message and block preview budgets while exempting single-item sections', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('archive_guard_context_archive');
  await createArchivedSession(deps, sessionId);

  const okCombined = await deps.toolsSessionAgent.tool_get_context_archive({
    sessionId,
    startSeq: 1,
    endSeq: 2,
    startId: 1,
    endId: 1,
    includeMessages: true,
    includeBlocks: true,
    previewLength: 7_000,
  });
  assert.match(String(okCombined), /archived alpha/);
  assert.match(String(okCombined), /block alpha/);

  await assert.rejects(
    () => deps.toolsSessionAgent.tool_get_context_archive({
      sessionId,
      startSeq: 1,
      endSeq: 2,
      startId: 1,
      endId: 2,
      includeMessages: true,
      includeBlocks: true,
      previewLength: 6_000,
    }),
    /Request too large for get_context_archive: requested preview budget is 24000 characters/i,
  );

  const singlePerSection = await deps.toolsSessionAgent.tool_get_context_archive({
    sessionId,
    startSeq: 1,
    endSeq: 1,
    startId: 1,
    endId: 1,
    includeMessages: true,
    includeBlocks: true,
    previewLength: 50_000,
  });
  assert.match(String(singlePerSection), /archived alpha/);
  assert.match(String(singlePerSection), /block alpha/);
});

test('get_context_archive lets previewLength control archived tool response previews', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('archive_tool_preview');
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

  const shortPreview = String(await deps.toolsSessionAgent.tool_get_context_archive({
    sessionId,
    startSeq: 1,
    endSeq: 1,
    includeMessages: true,
    includeBlocks: false,
    previewLength: 120,
  }));
  assert.doesNotMatch(shortPreview, /TOOL_OUTPUT_END/);

  const longPreview = String(await deps.toolsSessionAgent.tool_get_context_archive({
    sessionId,
    startSeq: 1,
    endSeq: 1,
    includeMessages: true,
    includeBlocks: false,
    previewLength: 1000,
  }));
  assert.match(longPreview, /\[tool:demo_tool\]/);
  assert.match(longPreview, /TOOL_OUTPUT_BEGIN/);
  assert.match(longPreview, /TOOL_OUTPUT_END/);
  assert.ok(longPreview.length > shortPreview.length + 500);
});
