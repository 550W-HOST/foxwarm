import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function makeMessageRecord(sessionId: string, seq: number, role: 'user' | 'model' | 'tool', text: string, timestamp: number) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp,
    role,
    message: {
      role,
      parts: [{ text }],
      __meta: { seq, timestamp },
    },
  };
}

function makeBlockRecord(sessionId: string, id: number, rawStartSeq: number, rawEndSeq: number, summary: string, createdAt: number) {
  return {
    v: 1,
    kind: 'block' as const,
    sessionId,
    agent: 'test-agent',
    id,
    level: 1,
    sourceKind: 'message' as const,
    sourceStart: rawStartSeq,
    sourceEnd: rawEndSeq,
    rawStartSeq,
    rawEndSeq,
    summary,
    createdAt,
  };
}

test('archive store bootstraps/imports legacy jsonl archives and infers fork lineage on fresh DB', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-bootstrap-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;

  const config = await import('../config');
  const archiveStore = await import('./archiveStore');
  const sessionHistory = await import('./history');
  const layeredContext = await import('./layeredContext');
  const toolsSessionAgent = await import('../toolsSessionAgent');

  const parentMessages = [
    makeMessageRecord('parent', 1, 'user', 'alpha parent one', 1000),
    makeMessageRecord('parent', 2, 'model', 'beta parent two', 2000),
  ];
  const childMessages = [
    ...parentMessages,
    makeMessageRecord('child', 4, 'user', 'gamma child local', 4000),
  ];

  const parentBlocks = [
    makeBlockRecord('parent', 1, 1, 2, 'alpha summary block', 2500),
  ];
  const childBlocks = [
    ...parentBlocks,
    makeBlockRecord('child', 2, 4, 4, 'gamma child local block', 4500),
  ];

  await fs.outputFile(config.getSessionArchiveLogPath('parent'), `${parentMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
  await fs.outputFile(config.getSessionArchiveLogPath('child'), `${childMessages.map(record => JSON.stringify(record)).join('\n')}\n`);
  await fs.outputFile(config.getSessionBlockArchiveLogPath('parent'), `${parentBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
  await fs.outputFile(config.getSessionBlockArchiveLogPath('child'), `${childBlocks.map(record => JSON.stringify(record)).join('\n')}\n`);
  await fs.outputJson(config.SESSIONS_FILE, {
    sessions: {
      parent: { id: 'parent', agent: 'test-agent', meta: { lastMessageTime: 2000 } },
      child: { id: 'child', agent: 'test-agent', parentSessionId: 'parent', meta: { lastMessageTime: 4000 } },
    },
  }, { spaces: 2 });

  assert.equal(await fs.pathExists(config.ARCHIVE_DB_PATH), false, 'bootstrap test must start without archive DB');

  await archiveStore.initArchiveStore();

  assert.equal(await fs.pathExists(config.ARCHIVE_DB_PATH), true, 'archive DB should be created during bootstrap import');

  const branch = await archiveStore.getSessionBranch('child');
  assert.equal(branch?.parentSessionId, 'parent');
  assert.equal(branch?.forkMessageSeq, 2);
  assert.equal(branch?.forkBlockId, 1);

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
    archivedBlocks.map(record => ({ id: record.id, inherited: !!record.inherited, source: record.sourceSessionId, summary: record.summary })),
    [
      { id: 1, inherited: true, source: 'parent', summary: 'alpha summary block' },
      { id: 2, inherited: false, source: 'child', summary: 'gamma child local block' },
    ],
  );

  const archivedMessagesPreview = await toolsSessionAgent.tool_get_archived_messages({ sessionId: 'child', previewLength: 120 });
  assert.match(String(archivedMessagesPreview), /\[inherited from parent\]/);
  assert.match(String(archivedMessagesPreview), /\[local\]/);
  assert.match(String(archivedMessagesPreview), /gamma child local/);

  const archivedBlocksPreview = await toolsSessionAgent.tool_get_archived_blocks({ sessionId: 'child', previewLength: 120 });
  assert.match(String(archivedBlocksPreview), /alpha summary block/);
  assert.match(String(archivedBlocksPreview), /gamma child local block/);

  const combinedPreview = await toolsSessionAgent.tool_recall({
    sessionId: 'child',
    target: 'blocks',
    previewLength: 120,
  });
  assert.match(String(combinedPreview), /alpha summary block/);
  assert.match(String(combinedPreview), /gamma child local/);
});
