import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

test('archive store reads inherited and local messages/blocks without copying parent archives', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-lineage-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

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
    contextFrontier: [],
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
    contextFrontier: [],
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
  const parentBlockLog = await fs.readFile(config.getSessionBlockArchiveLogPath('parent'), 'utf8');
  assert.deepEqual(JSON.parse(parentBlockLog.trim()).memoryFacts, [{ kind: 'convention', text: 'Archive block facts stay with their block.', attributedTo: 'assistant' }]);

  const childArchiveLog = await fs.readFile(config.getSessionArchiveLogPath('child'), 'utf8');
  assert.equal(childArchiveLog.trim().split('\n').length, 1, 'child raw archive should contain only local messages');
  assert.match(childArchiveLog, /gamma child local/);
  assert.doesNotMatch(childArchiveLog, /alpha parent one/);

  const childBlockLog = await fs.readFile(config.getSessionBlockArchiveLogPath('child'), 'utf8');
  assert.equal(childBlockLog.trim().split('\n').length, 1, 'child block archive should contain only local blocks');
  assert.match(childBlockLog, /gamma child local block/);
  assert.doesNotMatch(childBlockLog, /alpha summary block/);
});
