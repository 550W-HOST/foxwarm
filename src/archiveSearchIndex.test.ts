import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_SEARCH_MAX_QUERY_LENGTH,
  ArchiveSearchIndex,
  ArchiveSearchRebuildRequiredError,
  buildArchiveSearchIndexText,
  compileArchiveSearchQuery,
  normalizeArchiveSearchText,
  prepareArchiveSearchDocument,
  type ArchiveSearchDocumentInput,
} from './archiveSearchIndex';

function raw(sessionId: string, seq: number, text: string, agent = 'main'): ArchiveSearchDocumentInput {
  return {
    sessionId,
    agent,
    memoryKind: 'raw',
    sourceKey: String(seq),
    sourceFamily: `${sessionId}:raw:${seq}-${seq}`,
    text,
    seq,
    startSeq: seq,
    endSeq: seq,
    rawStartSeq: seq,
    rawEndSeq: seq,
    timestamp: seq * 1000,
  };
}

function block(sessionId: string, blockId: number, text: string, agent = 'main'): ArchiveSearchDocumentInput {
  return {
    sessionId,
    agent,
    memoryKind: 'block',
    sourceKey: String(blockId),
    sourceFamily: `${sessionId}:block:${blockId}`,
    text,
    startSeq: blockId * 10,
    endSeq: blockId * 10 + 2,
    rawStartSeq: blockId * 10,
    rawEndSeq: blockId * 10 + 2,
    timestamp: blockId * 10_000,
    blockId,
    blockLevel: 1,
  };
}

function fact(sessionId: string, blockId: number, key: string, text: string, agent = 'main'): ArchiveSearchDocumentInput {
  return {
    sessionId,
    agent,
    memoryKind: 'fact',
    sourceKey: `${blockId}:${key}`,
    sourceFamily: `${sessionId}:block:${blockId}`,
    text,
    rawStartSeq: blockId * 10,
    rawEndSeq: blockId * 10 + 2,
    timestamp: blockId * 10_000,
    blockId,
    blockLevel: 1,
  };
}

async function withTempIndex(
  callback: (index: ArchiveSearchIndex, dbPath: string, dir: string) => Promise<void> | void,
  options: Parameters<typeof ArchiveSearchIndex.open>[1] = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-search-'));
  const dbPath = path.join(dir, 'archive-search.sqlite');
  const index = ArchiveSearchIndex.open(dbPath, options);
  try {
    await callback(index, dbPath, dir);
  } finally {
    index.close();
    await fs.remove(dir);
  }
}

test('schema, triggers, normalization, and identifier/prose/CJK queries are source-backed', async () => {
  await withTempIndex((index, dbPath) => {
    index.upsertRawDocuments('scope-a', [
      raw('scope-a', 1, 'English prose describes distributed archive recovery.', 'agent-a'),
      raw('scope-a', 2, 'Identifiers abc1234 src/tools/foo_bar.ts /compact tools AlphaNode_42.', 'agent-a'),
      raw('scope-a', 3, '中文路由与恢复。', 'agent-a'),
      raw('scope-a', 4, 'Unicode äöüß_名 and fullwidth ＡＢＣ１２３４.', 'agent-a'),
      raw('scope-a', 5, 'Supplementary Han 𠀀𠀁 authority.', 'agent-a'),
    ], 5);

    const sqlite = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const objects = sqlite.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'archive_search_%' ORDER BY name`).all() as any[];
      assert.ok(objects.some(row => row.name === 'archive_search_fts'));
      assert.ok(objects.some(row => row.name === 'archive_search_documents_ai'));
      assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM archive_search_fts`).get().n, 5);
      assert.equal(String(sqlite.prepare(`PRAGMA journal_mode`).get().journal_mode).toLowerCase(), 'wal');
    } finally {
      sqlite.close();
    }

    for (const query of ['abc1234', 'src/tools/foo_bar.ts', '/compact tools', 'AlphaNode_42']) {
      const result = index.query(query, { sessionIds: ['scope-a'] }, 10);
      assert.ok(result.identifier.some(hit => hit.seq === 2), query);
    }
    assert.ok(index.query('distributed archive recovery', { sessionIds: ['scope-a'] }, 10).prose.some(hit => hit.seq === 1));
    assert.ok(index.query('中文路', { sessionIds: ['scope-a'] }, 10).prose.some(hit => hit.seq === 3));
    assert.ok(index.query('中文', { sessionIds: ['scope-a'] }, 10).prose.some(hit => hit.seq === 3));
    assert.ok(index.query('𠀀𠀁', { sessionIds: ['scope-a'] }, 10).prose.some(hit => hit.seq === 5));
    assert.ok(index.query('ÄÖÜSS_名', { sessionIds: ['scope-a'] }, 10).identifier.length === 0);
    assert.ok(index.query('ÄÖÜß_名', { sessionIds: ['scope-a'] }, 10).identifier.some(hit => hit.seq === 4));
    assert.ok(index.query('abc1234', { sessionIds: ['scope-a'] }, 10).identifier.some(hit => hit.seq === 4));

    assert.equal(normalizeArchiveSearchText('ＡＢＣ１２３４'), 'abc1234');
    assert.match(buildArchiveSearchIndexText('中文'), /␟中文␟/);
    assert.equal(index.getCheckpoint('scope-a').rawLastIndexedSeq, 5);
    assert.deepEqual(index.getStatus(), {
      schemaVersion: 1,
      normalizerVersion: 1,
      documentCount: 5,
      rawCount: 5,
      blockCount: 0,
      factCount: 0,
    });
  });
});

test('query compilation is bounded and does not expose raw MATCH syntax', () => {
  const compiled = compileArchiveSearchQuery(`${'x'.repeat(ARCHIVE_SEARCH_MAX_QUERY_LENGTH + 200)} AlphaNode_42" OR archive_search_fts:*`);
  assert.equal(compiled.normalizedQuery.length, ARCHIVE_SEARCH_MAX_QUERY_LENGTH);
  assert.ok((compiled.identifierMatch?.length || 0) <= 4096);
  assert.ok((compiled.proseMatch?.length || 0) <= 4096);
  assert.doesNotMatch(compiled.identifierMatch || '', /archive_search_fts:\*/);

  const injected = compileArchiveSearchQuery('src/tools/foo_bar.ts" OR "anything');
  assert.match(injected.identifierMatch || '', /"src\/tools\/foo_bar\.ts"/);
  assert.deepEqual(compileArchiveSearchQuery('SessionManager NodeDescriptor generic prose').identifiers.sort(), [
    'nodedescriptor', 'sessionmanager',
  ]);
  assert.deepEqual(compileArchiveSearchQuery('generic prose remains ordinary words').identifiers, []);
});

test('session, agent, and fork-capped lineage scopes are enforced in the query API', async () => {
  await withTempIndex(index => {
    index.upsertRawDocuments('parent', [raw('parent', 1, 'ScopeToken_42 old', 'agent-a'), raw('parent', 9, 'ScopeToken_42 future', 'agent-a')], 9);
    index.replaceBlockDocuments('parent', block('parent', 1, 'ScopeToken_42 parent block', 'agent-a'), [], 1);
    index.replaceBlockDocuments('parent', block('parent', 5, 'ScopeToken_42 future block', 'agent-a'), [], 5);
    index.upsertRawDocuments('child', [raw('child', 10, 'ScopeToken_42 child', 'agent-a')], 10);
    index.upsertRawDocuments('other', [raw('other', 1, 'ScopeToken_42 other', 'agent-b')], 1);

    const lineage = index.query('ScopeToken_42', {
      lineageSessions: [
        { sessionId: 'child' },
        { sessionId: 'parent', maxMessageSeq: 8, maxBlockId: 2 },
        { sessionId: 'parent', maxMessageSeq: 3 },
        { sessionId: 'parent', maxBlockId: 1 },
        { sessionId: 'child', maxMessageSeq: 20, maxBlockId: 20 },
      ],
    }, 20).identifier;
    assert.deepEqual(new Set(lineage.map(hit => `${hit.sessionId}:${hit.memoryKind}:${hit.seq ?? hit.blockId}`)), new Set([
      'child:raw:10', 'parent:raw:1', 'parent:block:1',
    ]));
    assert.equal(lineage.length, new Set(lineage.map(hit => hit.rowid)).size, 'duplicate lineage entries cannot duplicate hits');

    const agent = index.query('ScopeToken_42', { agent: 'agent-b' }, 20).identifier;
    assert.equal(agent.length, 1);
    assert.equal(agent[0].sessionId, 'other');
    const sessions = index.query('ScopeToken_42', { sessionIds: ['child'] }, 20).identifier;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'child');
  });
});

test('raw/block/fact families replace idempotently and stale facts are deleted', async () => {
  await withTempIndex(index => {
    index.upsertRawDocuments('family', [raw('family', 1, 'RawFamily_42 first')], 1);
    index.upsertRawDocuments('family', [raw('family', 1, 'RawFamily_42 replaced')], 1);
    assert.equal(index.getStatus().rawCount, 1);

    index.replaceBlockDocuments('family', block('family', 7, 'BlockFamily_42 summary'), [
      fact('family', 7, 'a', 'FactFamily_42 alpha'),
      fact('family', 7, 'b', 'FactFamily_42 beta'),
    ], 7);
    let factHits = index.query('FactFamily_42', { sessionIds: ['family'] }, 10).identifier;
    assert.equal(factHits.length, 2);
    assert.ok(factHits.every(hit => hit.sourceFamily === 'family:block:7'));

    index.replaceBlockDocuments('family', block('family', 7, 'BlockFamily_42 updated'), [
      fact('family', 7, 'b', 'FactFamily_42 beta updated'),
    ], 7);
    factHits = index.query('FactFamily_42', { sessionIds: ['family'] }, 10).identifier;
    assert.equal(factHits.length, 1);
    assert.equal(factHits[0].sourceKey, '7:b');
    assert.equal(index.getStatus().blockCount, 1);
    assert.equal(index.getStatus().factCount, 1);
    assert.equal(index.getCheckpoint('family').lastIndexedBlockId, 7);
    assert.equal(index.getCheckpoint('family').rawLastIndexedSeq, 1);
    assert.equal(index.deleteDocuments('family', 'fact'), 1);
    assert.equal(index.getStatus().factCount, 0);
  });
});

test('document, trigger, and checkpoint changes roll back together on injected failure', async () => {
  let fail = true;
  await withTempIndex(index => {
    assert.throws(() => index.upsertRawDocuments('rollback', [raw('rollback', 1, 'RollbackToken_42')], 1), /injected checkpoint failure/);
    assert.equal(index.getStatus().documentCount, 0);
    assert.equal(index.getCheckpoint('rollback').rawLastIndexedSeq, 0);
    assert.equal(index.query('RollbackToken_42', { sessionIds: ['rollback'] }).identifier.length, 0);

    fail = false;
    index.upsertRawDocuments('rollback', [raw('rollback', 1, 'RollbackToken_42')], 1);
    assert.equal(index.getStatus().documentCount, 1);
    assert.equal(index.getCheckpoint('rollback').rawLastIndexedSeq, 1);
  }, { beforeCheckpointWrite: () => { if (fail) throw new Error('injected checkpoint failure'); } });
});

test('selective deletion resets repair checkpoints and keeps block families consistent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-search-delete-'));
  const dbPath = path.join(dir, 'archive-search.sqlite');
  let index = ArchiveSearchIndex.open(dbPath);
  try {
    index.upsertRawDocuments('delete', [raw('delete', 1, 'DeleteRaw_42')], 1);
    index.replaceBlockDocuments('delete', block('delete', 7, 'DeleteBlock_42'), [fact('delete', 7, 'a', 'DeleteFact_42')], 7);

    assert.equal(index.deleteDocuments('delete', 'block'), 2);
    assert.deepEqual(index.getCheckpoint('delete'), { rawLastIndexedSeq: 1, lastIndexedBlockId: 0, updatedAt: index.getCheckpoint('delete').updatedAt });
    assert.equal(index.getStatus().blockCount, 0);
    assert.equal(index.getStatus().factCount, 0);
    assert.equal(index.query('DeleteFact_42', { sessionIds: ['delete'] }).identifier.length, 0);

    index.replaceBlockDocuments('delete', block('delete', 7, 'DeleteBlock_42'), [fact('delete', 7, 'a', 'DeleteFact_42')], 7);
    assert.equal(index.deleteDocuments('delete', 'fact'), 1);
    assert.equal(index.getCheckpoint('delete').lastIndexedBlockId, 0);
    assert.equal(index.getStatus().blockCount, 1);
    assert.equal(index.getStatus().factCount, 0);
    index.replaceBlockDocuments('delete', block('delete', 7, 'DeleteBlock_42'), [fact('delete', 7, 'a', 'DeleteFact_42')], 7);

    assert.equal(index.deleteDocuments('delete', 'raw'), 1);
    assert.equal(index.getCheckpoint('delete').rawLastIndexedSeq, 0);
    assert.equal(index.getCheckpoint('delete').lastIndexedBlockId, 7);
    index.upsertRawDocuments('delete', [raw('delete', 1, 'DeleteRaw_42')], 1);
    index.close();

    index = ArchiveSearchIndex.open(dbPath);
    assert.equal(index.query('DeleteRaw_42', { sessionIds: ['delete'] }).identifier.length, 1);
    assert.equal(index.query('DeleteFact_42', { sessionIds: ['delete'] }).identifier.length, 1);
    assert.equal(index.deleteDocuments('delete'), 3);
    assert.deepEqual(index.getCheckpoint('delete'), { rawLastIndexedSeq: 0, lastIndexedBlockId: 0, updatedAt: 0 });
    assert.equal(index.getStatus().documentCount, 0);
  } finally {
    try { index.close(); } catch {}
    await fs.remove(dir);
  }
});

test('FTS can rebuild from canonical documents and incompatible versions fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-search-rebuild-'));
  const dbPath = path.join(dir, 'archive-search.sqlite');
  let index = ArchiveSearchIndex.open(dbPath);
  try {
    index.upsertRawDocuments('rebuild', [raw('rebuild', 1, 'RebuildToken_42')], 1);
    assert.equal(index.query('RebuildToken_42', { sessionIds: ['rebuild'] }).identifier.length, 1);
    index.close();

    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(`DELETE FROM archive_search_fts`);
    sqlite.close();

    index = ArchiveSearchIndex.open(dbPath);
    assert.equal(index.query('RebuildToken_42', { sessionIds: ['rebuild'] }).identifier.length, 0);
    index.rebuildFtsFromDocuments();
    assert.equal(index.query('RebuildToken_42', { sessionIds: ['rebuild'] }).identifier.length, 1);
    index.optimize();
    index.close();

    const incompatible = new DatabaseSync(dbPath);
    incompatible.prepare(`UPDATE archive_search_metadata SET value = '2' WHERE key = 'normalizer_version'`).run();
    incompatible.close();
    assert.throws(
      () => ArchiveSearchIndex.open(dbPath),
      (error: any) => error instanceof ArchiveSearchRebuildRequiredError && error.code === 'ARCHIVE_SEARCH_REBUILD_REQUIRED',
    );

    const repairedMetadata = new DatabaseSync(dbPath);
    repairedMetadata.prepare(`UPDATE archive_search_metadata SET value = '1' WHERE key = 'normalizer_version'`).run();
    repairedMetadata.close();

    const reopened = ArchiveSearchIndex.open(dbPath);
    assert.equal(reopened.getStatus().documentCount, 1);
    reopened.close();
  } finally {
    try { index.close(); } catch {}
    await fs.remove(dir);
  }
});

test('schema validation rejects corrupt object types and trigger bodies before writes', async () => {
  const makeDb = async (suffix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-archive-search-schema-${suffix}-`));
    const dbPath = path.join(dir, 'archive-search.sqlite');
    ArchiveSearchIndex.open(dbPath).close();
    return dbPath;
  };

  const wrongTypePath = await makeDb('type');
  const wrongTypeDb = new DatabaseSync(wrongTypePath);
  wrongTypeDb.exec(`DROP TRIGGER archive_search_documents_ai; CREATE TABLE archive_search_documents_ai(value TEXT)`);
  wrongTypeDb.close();
  assert.throws(() => ArchiveSearchIndex.open(wrongTypePath), /must be exactly one trigger/);
  await fs.remove(path.dirname(wrongTypePath));

  const wrongBodyPath = await makeDb('body');
  const wrongBodyDb = new DatabaseSync(wrongBodyPath);
  wrongBodyDb.exec(`
    DROP TRIGGER archive_search_documents_ai;
    CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN SELECT 1; END;
  `);
  wrongBodyDb.close();
  assert.throws(() => ArchiveSearchIndex.open(wrongBodyPath), /incompatible canonical definition/);
  await fs.remove(path.dirname(wrongBodyPath));

  const extraSideEffectPath = await makeDb('extra-side-effect');
  const extraSideEffectDb = new DatabaseSync(extraSideEffectPath);
  extraSideEffectDb.exec(`
    DROP TRIGGER archive_search_documents_ai;
    CREATE TRIGGER archive_search_documents_ai AFTER INSERT ON archive_search_documents BEGIN
      INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
      DELETE FROM archive_search_checkpoints WHERE session_id = new.session_id;
    END;
  `);
  extraSideEffectDb.close();
  assert.throws(() => ArchiveSearchIndex.open(extraSideEffectPath), /incompatible canonical definition/);
  await fs.remove(path.dirname(extraSideEffectPath));

  const reorderedPath = await makeDb('reordered');
  const reorderedDb = new DatabaseSync(reorderedPath);
  reorderedDb.exec(`
    DROP TRIGGER archive_search_documents_au;
    CREATE TRIGGER archive_search_documents_au AFTER UPDATE ON archive_search_documents BEGIN
      INSERT INTO archive_search_fts(rowid, index_text) VALUES (new.rowid, new.index_text);
      INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
        VALUES ('delete', old.rowid, old.index_text);
    END;
  `);
  reorderedDb.close();
  assert.throws(() => ArchiveSearchIndex.open(reorderedPath), /incompatible canonical definition/);
  await fs.remove(path.dirname(reorderedPath));

  const harmlessFormattingPath = await makeDb('formatting');
  const harmlessFormattingDb = new DatabaseSync(harmlessFormattingPath);
  harmlessFormattingDb.exec(`
    DROP TRIGGER archive_search_documents_ad;
    CREATE   TRIGGER archive_search_documents_ad AFTER DELETE ON archive_search_documents BEGIN
      INSERT INTO archive_search_fts(archive_search_fts, rowid, index_text)
      VALUES ('delete', old.rowid, old.index_text);
    END;
  `);
  harmlessFormattingDb.close();
  ArchiveSearchIndex.open(harmlessFormattingPath).close();
  await fs.remove(path.dirname(harmlessFormattingPath));
});

test('prepared documents retain no source presentation text and hashes are stable', () => {
  const first = prepareArchiveSearchDocument(raw('hash', 1, 'Stable HashToken_42'));
  const second = prepareArchiveSearchDocument(raw('hash', 1, 'Stable HashToken_42'));
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.indexText, second.indexText);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'text'), false);
});

test('MATCH injection-like input remains data and cannot escape bounded compilation', async () => {
  await withTempIndex(index => {
    index.upsertRawDocuments('safe', [raw('safe', 1, 'src/tools/foo_bar.ts safe authority')], 1);
    assert.doesNotThrow(() => index.query('src/tools/foo_bar.ts" OR archive_search_fts:*', { sessionIds: ['safe'] }, 5));
    assert.throws(() => index.query('safe', {
      sessionIds: Array.from({ length: 65 }, (_, index) => `scope-${index}`),
    }), /scope exceeds 64 Sessions/);
  });
});

test('an ordinary SQLite file beside Lance tables is ignored by Lance discovery and maintenance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-lance-sqlite-coexist-'));
  const sqlitePath = path.join(dir, 'archive-search.sqlite');
  const index = ArchiveSearchIndex.open(sqlitePath);
  let connection: any;
  let table: any;
  try {
    const lancedb = await import('@lancedb/lancedb');
    connection = await lancedb.connect(dir);
    table = await connection.createTable('coexist_table', [{ id: 'one', vector: [1, 0], text: 'coexist' }]);
    assert.deepEqual(await connection.tableNames(), ['coexist_table']);
    await table.optimize({ cleanupOlderThan: new Date(0), deleteUnverified: false });
    assert.deepEqual(await connection.tableNames(), ['coexist_table']);
    assert.ok(await fs.pathExists(sqlitePath));
    assert.equal(index.getStatus().documentCount, 0);
  } finally {
    table?.close?.();
    connection?.close?.();
    index.close();
    await fs.remove(dir);
  }
});
