import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('archive store reads inherited and local messages/blocks without copying parent archives', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-lineage-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_SYNC_FILE_LOG = '1';

  const archive = await import('./archive');
  const layeredContext = await import('./layeredContext');
  const archiveStore = await import('./archiveStore');
  const sessionHistory = await import('./history');
  const toolsSessionAgent = await import('../toolsSessionAgent');
  const config = await import('../config');

  const parent: any = {
    id: 'parent',
    agent: 'test-agent',
    history: [],
    nextMessageSeq: 1,
    nextBlockId: 1,
      };

  await archive.appendMessagesToArchive(parent, [
    { role: 'user', parts: [{ text: 'alpha parent one' }], __meta: { timestamp: 1000 } },
    { role: 'model', parts: [{ text: 'beta parent two' }], __meta: { timestamp: 2000 } },
  ]);
  await layeredContext.appendBlocksToArchive(parent, [{
    level: 1,
    sourceKind: 'message',
    sourceStart: 1,
    sourceEnd: 2,
    rawStartSeq: 1,
    rawEndSeq: 2,
    summary: 'alpha summary block',
    memoryFacts: [{ kind: 'convention', text: 'Archive block facts stay with their block.', attributedTo: 'assistant' }],
  }]);

  await archiveStore.ensureSessionBranch('child', {
    parentSessionId: 'parent',
    forkMessageSeq: parent.nextMessageSeq - 1,
    forkBlockId: parent.nextBlockId - 1,
  });

  await archive.appendMessagesToArchive(parent, [
    { role: 'user', parts: [{ text: 'alpha forbidden future' }], __meta: { timestamp: 3000 } },
  ]);

  const child: any = {
    id: 'child',
    agent: 'test-agent',
    history: [],
    nextMessageSeq: parent.nextMessageSeq,
    nextBlockId: parent.nextBlockId,
      };

  await archive.appendMessagesToArchive(child, [
    { role: 'user', parts: [{ text: 'gamma child local' }], __meta: { timestamp: 4000 } },
  ]);
  await layeredContext.appendBlocksToArchive(child, [{
    level: 1,
    sourceKind: 'message',
    sourceStart: child.nextMessageSeq - 1,
    sourceEnd: child.nextMessageSeq - 1,
    rawStartSeq: child.nextMessageSeq - 1,
    rawEndSeq: child.nextMessageSeq - 1,
    summary: 'gamma child local block',
  }]);

  const archivedMessages = await sessionHistory.getArchivedMessages('child');
  assert.deepEqual(
    archivedMessages.records.map(record => ({ seq: record.seq, inherited: !!record.inherited, source: record.sourceSessionId, text: record.message.parts[0]?.text })),
    [
      { seq: 1, inherited: true, source: 'parent', text: 'alpha parent one' },
      { seq: 2, inherited: true, source: 'parent', text: 'beta parent two' },
      { seq: 4, inherited: false, source: 'child', text: 'gamma child local' },
    ],
  );

  const archivedBlocks = await layeredContext.readArchiveBlocksByIdRange('child');
  assert.deepEqual(
    archivedBlocks.map(record => ({
      id: record.id,
      inherited: !!record.inherited,
      source: record.sourceSessionId,
      summary: record.summary,
      rawStartTimestamp: record.rawStartTimestamp,
      rawEndTimestamp: record.rawEndTimestamp,
    })),
    [
      { id: 1, inherited: true, source: 'parent', summary: 'alpha summary block\n\n### Memory facts\n- **convention:** Archive block facts stay with their block. _(attributed to: assistant)_', rawStartTimestamp: 1000, rawEndTimestamp: 2000 },
      { id: 2, inherited: false, source: 'child', summary: 'gamma child local block', rawStartTimestamp: 4000, rawEndTimestamp: 4000 },
    ],
  );

  const combinedPreview = await toolsSessionAgent.tool_recall({
    sessionId: 'child',
    target: 'B#1',
    previewLength: 120,
  });
  assert.match(String(combinedPreview), /\[inherited from parent\]/);
  assert.match(String(combinedPreview), /- Covers: msg#1-2/);
  assert.match(String(combinedPreview), /- Source: messages msg#1-2/);
  assert.match(String(combinedPreview), /alpha summary block/);
  assert.match(String(combinedPreview), /### Memory facts/);
  assert.match(String(combinedPreview), /alpha parent one/);

  const frontierPreview = await toolsSessionAgent.tool_recall({
    sessionId: 'child',
    target: 'blocks',
    previewLength: 120,
  });
  assert.match(String(frontierPreview), /\[inherited from parent\]/);
  assert.match(String(frontierPreview), /\[local\]/);
  assert.match(String(frontierPreview), /gamma child local block/);

  assert.deepEqual(archivedBlocks[0].memoryFacts, [{ kind: 'convention', text: 'Archive block facts stay with their block.', attributedTo: 'assistant' }]);
  assert.equal(await fs.pathExists(config.getSessionArchiveLogPath('child')), false, 'normal runtime should not create active archive JSONL');
  assert.equal(await fs.pathExists(config.getSessionBlockArchiveLogPath('parent')), false, 'normal runtime should not create active block JSONL');

  const exportRoot = path.join(tempRoot, 'export');
  await archiveStore.exportSessionArchivesJsonl(exportRoot);
  const parentBlockLog = await fs.readFile(path.join(exportRoot, 'parent.blocks.jsonl'), 'utf8');
  assert.deepEqual(JSON.parse(parentBlockLog.trim()).memoryFacts, [{ kind: 'convention', text: 'Archive block facts stay with their block.', attributedTo: 'assistant' }]);

  const childArchiveLog = await fs.readFile(path.join(exportRoot, 'child.jsonl'), 'utf8');
  assert.equal(childArchiveLog.trim().split('\n').length, 1, 'child raw archive should contain only local messages');
  assert.match(childArchiveLog, /gamma child local/);
  assert.doesNotMatch(childArchiveLog, /alpha parent one/);

  const childBlockLog = await fs.readFile(path.join(exportRoot, 'child.blocks.jsonl'), 'utf8');
  assert.equal(childBlockLog.trim().split('\n').length, 1, 'child block archive should contain only local blocks');
  assert.match(childBlockLog, /gamma child local block/);
  assert.doesNotMatch(childBlockLog, /alpha summary block/);
});

test('archive message and block identities allow identical replay but reject conflicting overwrite', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-immutable-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_SYNC_FILE_LOG = '1';
  const archiveStore = await import('./archiveStore');
  const message: any = {
    v: 1, kind: 'message', sessionId: 'immutable', agent: 'main', seq: 1,
    timestamp: 1000, role: 'user', message: { role: 'user', parts: [{ text: 'original' }], __meta: { seq: 1, timestamp: 1000 } },
  };
  const block: any = {
    v: 1, kind: 'block', sessionId: 'immutable', agent: 'main', id: 1, level: 1,
    sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1,
    summary: 'original summary', createdAt: 2000,
  };
  await archiveStore.writeArchiveMessages([message]);
  await archiveStore.writeArchiveMessages([structuredClone(message)]);
  await assert.rejects(() => archiveStore.writeArchiveMessages([{ ...message, message: { ...message.message, parts: [{ text: 'conflict' }] } }]), /Immutable archive message conflict/);
  await archiveStore.writeArchiveBlocks([block]);
  await archiveStore.writeArchiveBlocks([structuredClone(block)]);
  await assert.rejects(() => archiveStore.writeArchiveBlocks([{ ...block, summary: 'conflict' }]), /Immutable archive block conflict/);
  assert.equal((await archiveStore.readLocalArchiveMessages('immutable'))[0].message.parts[0].text, 'original');
  assert.equal((await archiveStore.readLocalArchiveBlocks('immutable'))[0].summary, 'original summary');
  await fs.remove(tempRoot);
});

test('required archive append failure restores active Session state and skips authority persistence', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-fail-closed-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_SYNC_FILE_LOG = '1';
  const archive = await import('./archive');
  const sessionManager = await import('../sessionManager');
  const session: any = {
    id: 'fail-closed', agent: 'main', history: [{ role: 'user', parts: [{ text: 'committed' }], __meta: { seq: 1, timestamp: 1 } }],
    persistentMemorySnapshot: '', stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: true, queue: [], meta: { lastMessageTime: 1 }, nextMessageSeq: 2, nextBlockId: 1,
  };
  let persisted = 0;
  archive.setArchiveWriteFaultInjectorForTests(() => { throw new Error('injected required archive failure'); });
  try {
    await assert.rejects(() => sessionManager.appendSessionMessagesForSession(
      session,
      [{ role: 'model', parts: [{ text: 'must not become active' }] }],
      async () => { persisted += 1; },
    ), /injected required archive failure/);
    assert.equal(persisted, 0);
    assert.equal(session.history.length, 1);
    assert.equal(session.history[0].parts[0].text, 'committed');
    assert.equal(session.nextMessageSeq, 2);
    assert.equal(session.busy, true);
  } finally {
    archive.setArchiveWriteFaultInjectorForTests(null);
    await fs.remove(tempRoot);
  }
});

test('authority persistence failure rolls back newly inserted archive rows before retry', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-authority-rollback-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  process.env.FOXWARM_SYNC_FILE_LOG = '1';
  const archiveStore = await import('./archiveStore');
  const sessionManager = await import('../sessionManager');
  const session: any = {
    id: 'authority-rollback', agent: 'main', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: true, queue: [], meta: { lastMessageTime: 1 }, nextMessageSeq: 1, nextBlockId: 1,
  };
  const message: any = { role: 'user', parts: [{ text: 'retryable exact wording' }], __meta: { timestamp: 1000 } };
  await assert.rejects(() => sessionManager.appendSessionMessagesForSession(
    session, [message], async () => { throw new Error('injected authority persistence failure'); },
  ), /injected authority persistence failure/);
  assert.equal((await archiveStore.readLocalArchiveMessages(session.id)).length, 0);
  assert.equal(session.history.length, 0);
  assert.equal(session.nextMessageSeq, 1);
  await sessionManager.appendSessionMessagesForSession(session, [message], async () => {});
  assert.equal(session.history.length, 1);
  assert.equal((await archiveStore.readLocalArchiveMessages(session.id)).length, 1);
  await fs.remove(tempRoot);
});
