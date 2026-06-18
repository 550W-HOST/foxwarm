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
  archiveRecall: typeof import('./archiveRecall');
  archive: typeof import('../session/archive');
  layeredContext: typeof import('../session/layeredContext');
  httpServerModule: typeof import('../httpServer');
  webuiChannel: typeof import('../channels/webuiChannel');
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

      const [sessionManager, toolsSessionAgent, archiveRecall, archive, layeredContext, httpServerModule, webuiChannel] = await Promise.all([
        import('../sessionManager'),
        import('../toolsSessionAgent'),
        import('./archiveRecall'),
        import('../session/archive'),
        import('../session/layeredContext'),
        import('../httpServer'),
        import('../channels/webuiChannel'),
      ]);

      await sessionManager.loadSessions();
      return { tempRoot, sessionManager, toolsSessionAgent, archiveRecall, archive, layeredContext, httpServerModule, webuiChannel };
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

test('get_session_messages treats previewLength as a clamped total preview budget', async () => {
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

    const belowMin = await toolsSessionAgent.tool_get_session_messages({
      sessionId,
      count: 3,
      previewLength: 500,
    }, {});
    assert.match(String(belowMin), /previewLength 500 is below the minimum; using 1000/i);
    assert.match(String(belowMin), /showing 3 of 3 message\(s\)/i);

    const aboveMax = await toolsSessionAgent.tool_get_session_messages({
      sessionId,
      count: 3,
      previewLength: 50_000,
    }, {});
    assert.match(String(aboveMax), /previewLength 50000 exceeds the maximum; using 20000/i);

    const singleResult = await toolsSessionAgent.tool_get_session_messages({
      sessionId,
      count: 1,
      previewLength: 50_000,
    }, {});
    assert.match(String(singleResult), /showing 1 of 3 message\(s\)/i);
    assert.match(String(singleResult), /using 20000/i);
  } finally {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failure in tests
    }
  }
});

test('archived message/block tools use the clamped total preview budget', async () => {
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

  const smallMessages = await deps.toolsSessionAgent.tool_get_archived_messages({
    sessionId,
    startSeq: 1,
    endSeq: 3,
    previewLength: 700,
  });
  assert.match(String(smallMessages), /previewLength 700 is below the minimum; using 1000/i);
  assert.match(String(smallMessages), /showing 3 of 3 matched message\(s\)/i);

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

  const largeBlocks = await deps.toolsSessionAgent.tool_get_archived_blocks({
    sessionId,
    startId: 1,
    endId: 3,
    previewLength: 50_000,
  });
  assert.match(String(largeBlocks), /previewLength 50000 exceeds the maximum; using 20000/i);
  assert.match(String(largeBlocks), /showing 3 of 3 matched block\(s\)/i);

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

test('renderContextBlockExpansion returns structured child block/raw message items without mutating session state', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('ctx_block_expand');
  await createArchivedSession(deps, sessionId);
  const session = await ensureSession(deps.sessionManager, sessionId);
  session.contextFrontier = [
    { kind: 'block', id: 4, level: 2, rawStartSeq: 1, rawEndSeq: 2 },
    { kind: 'block', id: 3, level: 1, rawStartSeq: 3, rawEndSeq: 3 },
  ];
  session.history = [
    deps.layeredContext.renderBlockMessage({
      v: 1,
      kind: 'block',
      sessionId,
      agent: 'main',
      id: 4,
      level: 2,
      sourceKind: 'block',
      sourceStart: 1,
      sourceEnd: 2,
      rawStartSeq: 1,
      rawEndSeq: 2,
      summary: 'parent alpha beta block',
      createdAt: 5000,
    }),
  ];
  await deps.sessionManager.saveSession(sessionId);

  const before = await deps.sessionManager.getExistingSession(sessionId);
  const beforeHistory = JSON.stringify(before?.history || []);
  const beforeFrontier = JSON.stringify(before?.contextFrontier || []);

  const detail = await deps.archiveRecall.renderContextBlockExpansion({ sessionId, blockId: 4, previewLength: 2000 });
  assert.equal(detail.expansionKind, 'child-blocks');
  assert.equal(detail.target, 'B#4');
  assert.equal(detail.block.id, 4);
  assert.equal(detail.totalItems, 2);
  assert.equal(detail.items.length, 2);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.items[0].kind, 'block');
  assert.equal(detail.items[0].block?.id, 1);
  assert.equal(detail.items[0].message.role, 'model');
  assert.equal(detail.items[0].message.__meta?.contextBlock?.id, 1);
  assert.equal(detail.items[1].message.__meta?.contextBlock?.id, 2);
  assert.match(detail.items[0].message.parts[0].text || '', /block alpha/);
  assert.match(detail.items[1].message.parts[0].text || '', /block beta/);
  assert.doesNotMatch(detail.items[0].message.parts[0].text || '', /archived alpha/);
  assert.match(detail.text, /Immediate child blocks/);
  assert.match(detail.text, /block alpha/);
  assert.match(detail.text, /block beta/);
  assert.doesNotMatch(detail.text, /archived alpha/);
  assert.doesNotMatch(detail.text, /Suggestions/);

  const raw = await deps.archiveRecall.renderContextBlockExpansion({ sessionId, blockId: 1, previewLength: 2000 });
  assert.equal(raw.expansionKind, 'messages');
  assert.equal(raw.target, 'B#1');
  assert.equal(raw.totalItems, 1);
  assert.equal(raw.items[0].kind, 'message');
  assert.equal(raw.items[0].seq, 1);
  assert.equal(raw.messages[0].role, 'user');
  assert.equal(raw.messages[0].__meta?.seq, 1);
  assert.match(raw.messages[0].parts[0].text || '', /archived alpha/);
  assert.equal(raw.messages[0].__meta?.contextBlock, undefined);
  assert.match(raw.text, /Source messages/);
  assert.match(raw.text, /archived alpha/);
  assert.doesNotMatch(raw.text, /archived beta/);
  assert.doesNotMatch(raw.text, /Suggestions/);

  const after = await deps.sessionManager.getExistingSession(sessionId);
  assert.equal(JSON.stringify(after?.history || []), beforeHistory);
  assert.equal(JSON.stringify(after?.contextFrontier || []), beforeFrontier);
});

test('renderContextBlockExpansion reports invalid session/block', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('ctx_block_invalid');
  await createArchivedSession(deps, sessionId);
  await ensureSession(deps.sessionManager, sessionId);

  await assert.rejects(
    () => deps.archiveRecall.renderContextBlockExpansion({ sessionId: `${sessionId}_missing`, blockId: 1 }),
    /Session `.*_missing` not found/,
  );
  await assert.rejects(
    () => deps.archiveRecall.renderContextBlockExpansion({ sessionId, blockId: 999 }),
    /CTX-BLOCK B#999 not found/,
  );
  await assert.rejects(
    () => deps.archiveRecall.renderContextBlockExpansion({ sessionId, blockId: 1.5 }),
    /blockId must be a positive integer/,
  );
});

test('WebUI context block expansion route is admin-authenticated and read-only', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('ctx_block_route');
  await createArchivedSession(deps, sessionId);
  const session = await ensureSession(deps.sessionManager, sessionId);
  session.contextFrontier = [{ kind: 'block', id: 4, level: 2, rawStartSeq: 1, rawEndSeq: 2 }];
  session.history = [];
  await deps.sessionManager.saveSession(sessionId);
  const before = await deps.sessionManager.getExistingSession(sessionId);
  const beforeHistory = JSON.stringify(before?.history || []);
  const beforeFrontier = JSON.stringify(before?.contextFrontier || []);

  const port = 33180 + Math.floor(Math.random() * 1000);
  const server = new deps.httpServerModule.HttpServer(port, 'secret-token');
  deps.httpServerModule.setHttpServer(server);
  new deps.webuiChannel.WebUIChannel({ router: {} as any, token: 'secret-token', enableTrigger: false, enableWebUI: true });
  await server.start();
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/context-blocks/4/expand?previewLength=2000`;

    const unauthorized = await fetch(`${baseUrl}${path}`);
    assert.equal(unauthorized.status, 401);

    const ok = await fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(ok.status, 200);
    const payload = await ok.json() as any;
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.blockId, 4);
    assert.equal(payload.expansionKind, 'child-blocks');
    assert.equal(payload.totalItems, 2);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.items[0].kind, 'block');
    assert.equal(payload.items[0].message.__meta.contextBlock.id, 1);
    assert.match(payload.items[0].message.parts[0].text, /block alpha/);
    assert.doesNotMatch(payload.items[0].message.parts[0].text, /archived alpha/);

    const rawOk = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/context-blocks/1/expand?previewLength=2000`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(rawOk.status, 200);
    const rawPayload = await rawOk.json() as any;
    assert.equal(rawPayload.expansionKind, 'messages');
    assert.equal(rawPayload.totalItems, 1);
    assert.equal(rawPayload.items[0].kind, 'message');
    assert.equal(rawPayload.messages[0].__meta.seq, 1);
    assert.match(rawPayload.messages[0].parts[0].text, /archived alpha/);

    const invalidBlock = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/context-blocks/999/expand`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(invalidBlock.status, 404);

    const invalidBlockId = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/context-blocks/4.5/expand`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(invalidBlockId.status, 400);

    const invalidSession = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}_missing/context-blocks/4/expand`, { headers: { Authorization: 'Bearer secret-token' } });
    assert.equal(invalidSession.status, 404);
  } finally {
    await server.stop();
    deps.httpServerModule.setHttpServer(null);
  }

  const after = await deps.sessionManager.getExistingSession(sessionId);
  assert.equal(JSON.stringify(after?.history || []), beforeHistory);
  assert.equal(JSON.stringify(after?.contextFrontier || []), beforeFrontier);
});

test('recall renderer filters messages and centers previews around matches', async () => {
  const deps = await loadDeps();
  const sessionId = makeId('recall_renderer_filters');
  const session: Session = {
    ...createBaseSession(sessionId),
    nextMessageSeq: 1,
    nextBlockId: 1,
    contextFrontier: [],
  } as Session;

  await deps.archive.appendMessagesToArchive(session, [
    {
      role: 'user',
      parts: [{ text: `alpha start ${'x'.repeat(900)} UNIQUE_NEEDLE ${'y'.repeat(900)} alpha end` }],
      __meta: { timestamp: 1000 },
    },
    {
      role: 'model',
      parts: [{ text: 'boring beta message that should be excluded by literal query' }],
      __meta: { timestamp: 2000 },
    },
    {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call_secret', name: 'read', response: { output: `tool prefix ${'z'.repeat(600)} TOOL_SECRET_MATCH ${'q'.repeat(600)}` } } }],
      __meta: { timestamp: 3000 },
    },
  ]);

  const literal = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1-3',
    query: 'UNIQUE_NEEDLE',
    previewLength: 1000,
  }));
  assert.match(literal, /UNIQUE_NEEDLE/);
  assert.match(literal, /showing 1 of 3 matched message\(s\)/);
  assert.doesNotMatch(literal, /boring beta message/);
  assert.ok(literal.length < 1500, 'literal filtered preview should respect total budget');

  const regexFiltered = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1-3',
    includeRegex: 'UNIQUE|TOOL_SECRET',
    excludeRegex: 'TOOL_SECRET',
    previewLength: 1000,
  }));
  assert.match(regexFiltered, /UNIQUE_NEEDLE/);
  assert.doesNotMatch(regexFiltered, /TOOL_SECRET_MATCH/);

  const foldedToolMatch = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1-3',
    query: 'TOOL_SECRET_MATCH',
    previewLength: 1000,
  }));
  assert.match(foldedToolMatch, /Tool results: read\(call_secret\): ok \(content omitted\)/);
  assert.match(foldedToolMatch, /Matched in omitted tool call\/result content/);
  assert.doesNotMatch(foldedToolMatch, /TOOL_SECRET_MATCH/);

  const snippetToolMatch = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1-3',
    query: 'TOOL_SECRET_MATCH',
    toolDetail: 'snippets',
    previewLength: 1000,
  }));
  assert.match(snippetToolMatch, /\[tool:read\(call_secret\)\]/);
  assert.match(snippetToolMatch, /TOOL_SECRET_MATCH/);
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

test('recall uses clamped total preview budgets for broad ranges', async () => {
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

  const broadRange = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1-4',
    previewLength: 500,
  }));
  assert.match(broadRange, /previewLength 500 is below the minimum; using 1000/i);
  assert.match(broadRange, /showing 4 of 4 matched message\(s\)/i);
  assert.match(broadRange, /archived alpha/);

  const overBudgetBlock = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'B#5',
    previewLength: 6_000,
  }));
  assert.match(overBudgetBlock, /CTX-BLOCK B#5/);
  assert.match(overBudgetBlock, /Source messages/);
  assert.match(overBudgetBlock, /showing 4 of 4 matched message\(s\)/);
  assert.doesNotMatch(overBudgetBlock, /target":"B#5"/);
  assert.match(overBudgetBlock, /Archived messages for session/);
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
  assert.match(directory, /item\(s\) omitted due to previewLength budget 1000/);
  assert.match(directory, /Suggestions \(optional; not exhaustive\)/);
  assert.match(directory, /\[CTX-BLOCK L1 B#1 raw#1/);
  assert.doesNotMatch(directory, /\[CTX-BLOCK L1 B#25/);
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
  assert.match(shortPreview, /previewLength 120 is below the minimum; using 1000/i);
  assert.match(shortPreview, /Tool results: demo_tool\(call_long_tool_output\): ok \(content omitted\)/);
  assert.doesNotMatch(shortPreview, /TOOL_OUTPUT_END/);

  const longPreview = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 1000,
    toolDetail: 'full',
  }));
  assert.match(longPreview, /\[tool:demo_tool\(call_long_tool_output\)\]/);
  assert.match(longPreview, /TOOL_OUTPUT_BEGIN/);
  assert.match(longPreview, /TOOL_OUTPUT_END/);
  assert.ok(longPreview.length > shortPreview.length + 500);

  const defaultPreview = String(await deps.toolsSessionAgent.tool_recall({
    sessionId,
    target: 'msg#1',
    previewLength: 0,
    toolDetail: 'full',
  }));
  assert.match(defaultPreview, /TOOL_OUTPUT_END/);
});
