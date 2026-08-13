import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionCatalogStore } from './catalogStore';

function metadata(id: string, values: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    agent: values.agent || 'main',
    aliases: values.aliases || [],
    busy: values.busy || false,
    queue: values.queue || [],
    meta: { lastMessageTime: values.lastMessageTime || 0, messageCount: values.messageCount || 0 },
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    currentNode: 'master',
    ...values,
  };
}

async function makeStore(): Promise<{ root: string; dbPath: string; store: SessionCatalogStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-store-'));
  const dbPath = path.join(root, 'catalog.sqlite');
  const store = new SessionCatalogStore(dbPath);
  store.initializeEmpty();
  return { root, dbPath, store };
}

function runMigration(dataRoot: string): { status: number | null; stdout: string; stderr: string } {
  const script = `
    const s=require('./lib/session/catalogStore');
    s.sessionCatalogStore.initialize()
      .then(result=>{console.log(JSON.stringify({ok:true,result,rows:s.sessionCatalogStore.list(),alias:s.sessionCatalogStore.resolveId('shared'),pragmas:s.sessionCatalogStore.getConnectionPragmas()}));s.sessionCatalogStore.close()})
      .catch(error=>{console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=3});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, FOXWARM_DATA_DIR: dataRoot },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeAuthority(dataRoot: string, id: string): Promise<void> {
  await fs.outputJson(path.join(dataRoot, 'state', 'sessions', `${id}.json`), { id, history: [] });
}

function readRawCatalogMetadata(dbPath: string, sessionId: string): Record<string, any> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT metadata_json FROM session_catalog WHERE session_id=?').get(sessionId) as { metadata_json: string };
    return JSON.parse(row.metadata_json);
  } finally { db.close(); }
}

function assertNoSemanticBodies(metadataJson: Record<string, any>): void {
  for (const field of ['queue', 'history', 'contextFrontier', 'promptCacheKey', 'lastAppliedMailboxId', 'goalState', 'systemPromptFiles', 'indexingState']) {
    assert.equal(Object.prototype.hasOwnProperty.call(metadataJson, field), false, `${field} must not enter metadata_json`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(metadataJson.meta || {}, 'managedSession'), false);
  const serializedWait = JSON.stringify(metadataJson.meta?.wait || {});
  assert.equal(serializedWait.includes('deferredQueue'), false);
  assert.equal(serializedWait.includes('pendingInbox'), false);
  assert.equal(serializedWait.includes('"parts"'), false);
  assert.equal(serializedWait.includes('"message"'), false);
}

test('catalog row/batch writes preserve exact aliases, counts, keyset pages, and scoped queries', async t => {
  const fixture = await makeStore();
  t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  fixture.store.upsertMany([
    metadata('a', { aliases: ['shared'], agent: 'alpha', lastMessageTime: 30, parentSessionId: 'dangling', busy: true, effort: 'none', childEffortDefault: 'max' }),
    metadata('b', { aliases: ['shared'], agent: 'alpha', lastMessageTime: 20, parentSessionId: 'a', queue: [{ type: 'background' }] }),
    metadata('c', { aliases: ['only-c'], agent: 'beta', lastMessageTime: 10 }),
  ]);
  assert.equal(fixture.store.count(), 3);
  assert.equal(fixture.store.count({ agent: 'alpha' }), 2);
  assert.equal(fixture.store.count({ parentSessionId: 'a' }), 1);
  assert.equal(fixture.store.count({ parentSessionId: null }), 2);
  assert.deepEqual(fixture.store.resolveId('a'), { kind: 'exact', sessionId: 'a' });
  assert.deepEqual(fixture.store.resolveId('only-c'), { kind: 'alias', sessionId: 'c' });
  assert.deepEqual(fixture.store.resolveId('shared'), { kind: 'ambiguous', sessionIds: ['a', 'b'] });
  assert.deepEqual(fixture.store.list({ limit: 2 }).map(row => row.id), ['a', 'b']);
  assert.deepEqual(fixture.store.list({ limit: 2, after: { lastMessageTime: 20, sessionId: 'b' } }).map(row => row.id), ['c']);
  assert.deepEqual(fixture.store.listByAgent('alpha').map(row => row.id), ['a', 'b']);
  assert.deepEqual(fixture.store.listChildren('a').map(row => row.id), ['b']);
  assert.deepEqual(fixture.store.listRecoveryCandidates().map(row => row.id), ['a', 'b']);
  assert.equal(fixture.store.get('a')?.effort, 'none');
  assert.equal(fixture.store.get('a')?.childEffortDefault, 'max');
  const rawEffort = readRawCatalogMetadata(fixture.dbPath, 'a');
  assert.equal(rawEffort.effort, 'none');
  assert.equal(rawEffort.childEffortDefault, 'max');

  fixture.store.upsertMany([
    metadata('alias-child', { parentSessionId: 'only-c', lastMessageTime: 5 }),
    metadata('ambiguous-child', { parentSessionId: 'shared', lastMessageTime: 4 }),
  ]);
  assert.deepEqual(fixture.store.listChildren('c').map(row => row.id), ['alias-child']);
  assert.ok(fixture.store.listRoots().some(row => row.id === 'ambiguous-child'), 'ambiguous parent aliases remain unresolved roots');

  fixture.store.upsertMany([metadata('b', { aliases: ['renamed'], agent: 'beta', lastMessageTime: 40 })], ['a']);
  assert.equal(fixture.store.count(), 4);
  assert.equal(fixture.store.count({ agent: 'alpha' }), 0);
  assert.equal(fixture.store.count({ agent: 'beta' }), 2);
  assert.equal(fixture.store.resolveId('shared').kind, 'missing');
  assert.equal(fixture.store.resolveId('renamed').sessionId, 'b');
});

test('catalog query plans use PK/alias/scoped/order indexes without temp full sorts', async t => {
  const fixture = await makeStore();
  t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  fixture.store.upsertMany(Array.from({ length: 200 }, (_, index) => metadata(`s${String(index).padStart(3, '0')}`, {
    aliases: [`alias-${index}`],
    agent: index % 2 ? 'odd' : 'even',
    parentSessionId: index < 100 ? 'root' : undefined,
    lastMessageTime: 1000 - index,
    busy: index === 3,
    queue: index === 4 ? [{ type: 'background' }] : [],
  })));
  fixture.store.close();
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  t.after(() => db.close());
  const plan = (sql: string, ...args: any[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail).join('\n');
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE session_id=?', 's001'), /SEARCH session_catalog USING INDEX sqlite_autoindex_session_catalog_1/);
  assert.match(plan('SELECT session_id FROM session_alias WHERE alias=? ORDER BY session_id', 'alias-1'), /SEARCH session_alias USING COVERING INDEX sqlite_autoindex_session_alias_1/);
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE (recent_rank,session_id)>(?,?) ORDER BY recent_rank,session_id LIMIT 20', -900, 's100'), /SEARCH session_catalog USING INDEX idx_session_catalog_recent/);
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE agent=? ORDER BY recent_rank,session_id LIMIT 20', 'odd'), /SEARCH session_catalog USING INDEX idx_session_catalog_agent_recent/);
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE parent_session_id=? ORDER BY recent_rank,session_id LIMIT 20', 'root'), /SEARCH session_catalog USING INDEX idx_session_catalog_parent_recent/);
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE parent_session_id IS NULL ORDER BY recent_rank,session_id LIMIT 20'), /SEARCH session_catalog USING INDEX idx_session_catalog_parent_recent/);
  assert.match(plan('SELECT metadata_json FROM session_catalog WHERE current_node=? ORDER BY recent_rank,session_id LIMIT 20', 'master'), /SEARCH session_catalog USING INDEX idx_session_catalog_current_node_recent/);
  const recoveryPlan = plan(`WITH recovery AS (
    SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE busy=1
    UNION
    SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE queue_length>0
    UNION
    SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE managed_pending_count>0
  ) SELECT metadata_json,busy,queue_length,managed_pending_count FROM recovery ORDER BY recent_rank,session_id LIMIT 20`);
  assert.match(recoveryPlan, /idx_session_catalog_recovery_busy/);
  assert.match(recoveryPlan, /idx_session_catalog_recovery_queued/);
  assert.match(recoveryPlan, /idx_session_catalog_recovery_managed/);
  const firstPagePlan = plan('SELECT metadata_json FROM session_catalog WHERE recent_rank>=? ORDER BY recent_rank,session_id LIMIT 20', -Number.MAX_VALUE);
  assert.match(firstPagePlan, /SEARCH session_catalog USING INDEX idx_session_catalog_recent/);
  assert.doesNotMatch(firstPagePlan, /USE TEMP B-TREE/);
  assert.match(plan('SELECT session_count FROM catalog_count WHERE singleton=1'), /SEARCH catalog_count USING INTEGER PRIMARY KEY/);
});

test('row writes never rewrite a legacy sessions.json sentinel and online backup is consistent', async t => {
  const fixture = await makeStore();
  t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  const sentinel = path.join(fixture.root, 'sessions.json');
  await fs.writeFile(sentinel, 'do-not-rewrite');
  fixture.store.upsertMany([metadata('one', { lastMessageTime: 1 })]);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'do-not-rewrite');
  const backupPath = path.join(fixture.root, 'backup', 'catalog.sqlite');
  await fixture.store.backupTo(backupPath);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal((backup.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  assert.equal((backup.prepare('SELECT count(*) count FROM session_catalog').get() as any).count, 1);
  backup.close();
});

test('normal writes persist only the narrow catalog projection, never semantic bodies', async t => {
  const fixture = await makeStore();
  t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  fixture.store.upsertMany([metadata('narrow', {
    queue: [{ type: 'background', parts: [{ text: 'queued' }] }],
    history: [{ role: 'user', parts: [{ text: 'history' }] }],
    promptCacheKey: 'secret-routing-key', lastAppliedMailboxId: 7,
    goalState: { goal: 'body' }, systemPromptFiles: ['MEMORY.md'], indexingState: { inProgress: true },
    meta: {
      lastMessageTime: 3, messageCount: 1,
      managedSession: { pendingInbox: [{ type: 'background', parts: [{ text: 'managed' }] }] },
      wait: {
        id: 'wait', startedAt: 10, reason: 'display reason', timeoutSeconds: 20, waitExecIds: ['exec-a'],
        waitAll: {
          sessions: ['child-a'], satisfiedSessions: ['child-a'],
          deferredQueue: [{ type: 'background', parts: [{ text: 'deferred body' }] }],
        },
      },
    },
  })]);
  const raw = readRawCatalogMetadata(fixture.dbPath, 'narrow');
  assertNoSemanticBodies(raw);
  assert.equal(raw.queueLength, 1);
  assert.equal(raw.managedPendingCount, 1);
  assert.deepEqual(raw.meta.wait, {
    id: 'wait', startedAt: 10, reason: 'display reason', timeoutSeconds: 20, waitExecIds: ['exec-a'],
    waitAll: { sessions: ['child-a'], satisfiedSessions: ['child-a'] },
  });
  fixture.store.upsertMany([metadata('bounded-wait', { meta: {
    lastMessageTime: 1,
    wait: {
      id: 'w'.repeat(200), reason: 'r'.repeat(600),
      waitExecIds: Array.from({ length: 80 }, (_, index) => `exec-${index}`),
      waitAll: { sessions: Array.from({ length: 80 }, (_, index) => `child-${index}`), satisfiedSessions: [] },
    },
  } })]);
  const bounded = readRawCatalogMetadata(fixture.dbPath, 'bounded-wait').meta.wait;
  assert.equal(bounded.id.length, 128); assert.equal(bounded.reason.length, 500);
  assert.equal(bounded.waitExecIds.length, 64); assert.equal(bounded.waitAll.sessions.length, 64);
});

test('strict migration publishes SQLite atomically, keeps one evidence copy, tolerates dangling parents, and ignores orphans', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-migrate-'));
  t.after(() => fs.remove(dataRoot));
  const state = path.join(dataRoot, 'state');
  const source = { sessions: {
    first: metadata('first', {
      aliases: ['shared'], parentSessionId: 'missing-parent', lastMessageTime: 2,
      queue: [{ type: 'background', parts: [{ text: 'legacy queue' }] }],
      history: [{ role: 'user', parts: [{ text: 'legacy catalog history' }] }],
      promptCacheKey: 'legacy-key', lastAppliedMailboxId: 4,
      goalState: { goal: 'legacy goal' }, systemPromptFiles: ['MEMORY.md'], indexingState: { inProgress: true },
      vectorIndexPosition: 1,
      meta: { lastMessageTime: 2, messageCount: 1, managedSession: { pendingInbox: [{ type: 'background', parts: [{ text: 'managed' }] }] } },
    }),
    second: metadata('second', { aliases: ['shared'], lastMessageTime: 1,
      meta: { lastMessageTime: 1, messageCount: 0, lastChannel: { platform: 'telegram', channelUserId: 'legacy-chat' } } }),
  } };
  await fs.outputJson(path.join(state, 'sessions.json'), source, { spaces: 2 });
  await fs.outputJson(path.join(state, 'sessions.json.1.bak'), source, { spaces: 2 });
  await fs.outputJson(path.join(state, 'sessions', 'first.json'), { id: 'first' });
  await fs.outputJson(path.join(state, 'sessions', 'second.json'), {
    id: 'second', sessionStateVersion: 1, history: [], queue: [],     stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    meta: { lastMessageTime: 1 }, lastAppliedMailboxId: 0,
  });
  await writeAuthority(dataRoot, 'orphan');
  const before = await fs.readFile(path.join(state, 'sessions.json'));
  const result = runMigration(dataRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.result.rowCount, 2);
  assert.equal(payload.rows.some((row: any) => row.id === 'orphan'), false);
  assert.deepEqual(payload.alias, { kind: 'ambiguous', sessionIds: ['first', 'second'] });
  assert.equal(await fs.pathExists(path.join(state, 'sessions.json')), false);
  assert.equal(await fs.pathExists(path.join(state, 'sessions.json.1.bak')), false);
  assert.deepEqual(await fs.readFile(path.join(state, 'sessions.json.pre-catalog-sqlite-v1.bak')), before);
  assert.deepEqual(payload.pragmas, { journalMode: 'wal', synchronous: 2, busyTimeout: 5000, foreignKeys: 1 });
  const rawCatalog = readRawCatalogMetadata(path.join(state, 'catalog.sqlite'), 'first');
  assertNoSemanticBodies(rawCatalog);
  const upgradedAuthority = await fs.readJson(path.join(state, 'sessions', 'first.json'));
  assert.equal(upgradedAuthority.sessionStateVersion, 1);
  assert.equal(upgradedAuthority.queue[0].parts[0].text, 'legacy queue');
  assert.equal(upgradedAuthority.history[0].parts[0].text, 'legacy catalog history');
  assert.equal(upgradedAuthority.meta.managedSession.pendingInbox.length, 1);
  assert.equal(upgradedAuthority.promptCacheKey, 'legacy-key');
  assert.equal(upgradedAuthority.lastAppliedMailboxId, 4);
  assert.deepEqual(readRawCatalogMetadata(path.join(state, 'catalog.sqlite'), 'second').meta.lastChannel,
    { channelId: 'telegram', channelUserId: 'legacy-chat', channelType: 'telegram' });
});

test('migration projects reconciled authority semantics, catalog ownership, and monotonic legacy upgrades', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-reconcile-'));
  const retryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-reconcile-retry-'));
  t.after(async () => { await fs.remove(dataRoot); await fs.remove(retryRoot); });
  const state = path.join(dataRoot, 'state');
  const catalogConflict = (id: string): Record<string, any> => metadata(id, {
    agent: 'catalog-agent', aliases: [`${id}-alias`], parentSessionId: 'catalog-parent',
    displayName: 'Catalog name', archived: true, pinned: true, sidebarOrder: 7,
    model: 'catalog-model', childModelDefault: 'catalog-child', currentNode: 'catalog-node', cwd: '/catalog',
    verbose: false, compactThresholdTokens: 999, busy: false,
    queue: [1, 2, 3].map(index => ({ type: 'background', parts: [{ text: `catalog queue ${index}` }] })),
    stats: { totalCachedTokens: 90, totalInputTokens: 91, totalOutputTokens: 92, lastUsage: null },
    vectorIndexPosition: 99,
    meta: {
      lastMessageTime: 900, messageCount: 90,
      lastChannel: { channelId: 'catalog-channel', channelUserId: 'catalog-chat' },
      wait: { id: 'catalog-wait', startedAt: 900, timeoutSeconds: 900 },
      managedSession: { pendingInbox: [{ type: 'background', parts: [{ text: 'catalog managed body' }] }] },
    },
  });
  const authoritySemantics = (id: string, versioned: boolean): Record<string, any> => ({
    id, ...(versioned ? { sessionStateVersion: 1 } : {}), history: [],
    agent: 'authority-agent', aliases: [`${id}-authority-alias`], parentSessionId: 'authority-parent', displayName: 'Authority name',
    model: `authority-${id}-model`, childModelDefault: `authority-${id}-child`, currentNode: `authority-${id}-node`, cwd: `/authority/${id}`,
    verbose: true, compactThresholdTokens: 321, busy: true,
    queue: [{ type: 'background', parts: [{ text: `authority ${id} queue` }] }],
    stats: { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null },
    vectorIndexPosition: 4,
    meta: {
      lastMessageTime: 123, messageCount: 12,
      lastChannel: { channelId: 'authority-channel', channelUserId: 'authority-chat' },
      wait: {
        id: `authority-${id}-wait`, startedAt: 100, reason: 'authority reason', timeoutSeconds: 30,
        waitExecIds: ['exec-1'],
        waitAll: {
          sessions: ['child-a', 'child-b'], satisfiedSessions: ['child-a'],
          deferredQueue: [{ type: 'background', parts: [{ text: 'must never enter catalog' }] }],
        },
      },
      managedSession: { pendingInbox: [1, 2].map(index => ({ type: 'background', parts: [{ text: `managed ${index}` }] })) },
    },
  });
  const source = { sessions: { current: catalogConflict('current'), legacy: catalogConflict('legacy') } };
  await fs.outputJson(path.join(state, 'sessions.json'), source);
  await fs.outputJson(path.join(state, 'sessions', 'current.json'), authoritySemantics('current', true));
  await fs.outputJson(path.join(state, 'sessions', 'legacy.json'), authoritySemantics('legacy', false));
  const currentBefore = await fs.readFile(path.join(state, 'sessions', 'current.json'));
  const result = runMigration(dataRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const id of ['current', 'legacy']) {
    const row = readRawCatalogMetadata(path.join(state, 'catalog.sqlite'), id);
    assert.equal(row.agent, 'catalog-agent'); assert.deepEqual(row.aliases, [`${id}-alias`]);
    assert.equal(row.parentSessionId, 'catalog-parent'); assert.equal(row.displayName, 'Catalog name');
    assert.equal(row.archived, true); assert.equal(row.pinned, true); assert.equal(row.sidebarOrder, 7);
    assert.equal(row.model, `authority-${id}-model`); assert.equal(row.childModelDefault, `authority-${id}-child`);
    assert.equal(row.currentNode, `authority-${id}-node`); assert.equal(row.cwd, `/authority/${id}`);
    assert.equal(row.verbose, true); assert.equal(row.compactThresholdTokens, 321);
    assert.equal(row.busy, true); assert.equal(row.queueLength, 1); assert.equal(row.managedPendingCount, 2);
    assert.deepEqual(row.stats, { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null });
    assert.equal(row.vectorIndexPosition, 4); assert.equal(row.meta.lastMessageTime, 123); assert.equal(row.meta.messageCount, 12);
    assert.deepEqual(row.meta.lastChannel, { channelId: 'catalog-channel', channelUserId: 'catalog-chat' });
    assert.deepEqual(row.meta.wait, {
      id: `authority-${id}-wait`, startedAt: 100, reason: 'authority reason', timeoutSeconds: 30,
      waitExecIds: ['exec-1'], waitAll: { sessions: ['child-a', 'child-b'], satisfiedSessions: ['child-a'] },
    });
    assertNoSemanticBodies(row);
  }
  assert.deepEqual(await fs.readFile(path.join(state, 'sessions', 'current.json')), currentBefore, 'current v1 authority is never rewritten');
  const upgradedLegacy = await fs.readJson(path.join(state, 'sessions', 'legacy.json'));
  assert.equal(upgradedLegacy.sessionStateVersion, 1);
  assert.equal(upgradedLegacy.model, 'authority-legacy-model');
  assert.equal(upgradedLegacy.meta.wait.waitAll.deferredQueue[0].parts[0].text, 'must never enter catalog');

  await fs.outputFile(path.join(retryRoot, 'state', 'sessions.json'), await fs.readFile(path.join(state, 'sessions.json.pre-catalog-sqlite-v1.bak')));
  await fs.copy(path.join(state, 'sessions'), path.join(retryRoot, 'state', 'sessions'));
  const retryAuthorityBefore = await fs.readFile(path.join(retryRoot, 'state', 'sessions', 'legacy.json'));
  const retry = runMigration(retryRoot);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.deepEqual(readRawCatalogMetadata(path.join(retryRoot, 'state', 'catalog.sqlite'), 'current'),
    readRawCatalogMetadata(path.join(state, 'catalog.sqlite'), 'current'));
  assert.deepEqual(readRawCatalogMetadata(path.join(retryRoot, 'state', 'catalog.sqlite'), 'legacy'),
    readRawCatalogMetadata(path.join(state, 'catalog.sqlite'), 'legacy'));
  assert.deepEqual(await fs.readFile(path.join(retryRoot, 'state', 'sessions', 'legacy.json')), retryAuthorityBefore,
    'retry after authority upgrade does not rewrite or regress v1 authority');
});

test('migration tries numbered backup after corrupt primary', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-backup-'));
  t.after(() => fs.remove(dataRoot));
  const state = path.join(dataRoot, 'state');
  await fs.outputFile(path.join(state, 'sessions.json'), '{broken');
  await fs.outputJson(path.join(state, 'sessions.json.1.bak'), { sessions: { recovered: metadata('recovered') } });
  await writeAuthority(dataRoot, 'recovered');
  const result = runMigration(dataRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.result.source, path.join(state, 'sessions.json.1.bak'));
  assert.deepEqual(payload.rows.map((row: any) => row.id), ['recovered']);
});

test('migration fails closed for missing authority and for orphan-only state', async t => {
  for (const orphanOnly of [false, true]) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-fail-'));
    t.after(() => fs.remove(dataRoot));
    const state = path.join(dataRoot, 'state');
    if (orphanOnly) await writeAuthority(dataRoot, 'orphan');
    else await fs.outputJson(path.join(state, 'sessions.json'), { sessions: { missing: metadata('missing') } });
    const result = runMigration(dataRoot);
    assert.equal(result.status, 3, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, false);
    assert.match(payload.error, orphanOnly ? /No valid sessions\.json migration candidate/ : /missing its authority file/);
    assert.equal(await fs.pathExists(path.join(state, 'catalog.sqlite')), false);
    assert.equal(await fs.pathExists(path.join(state, 'sessions.json.pre-catalog-sqlite-v1.bak')), false);
  }
});

test('migration fails closed when a cataloged authority file is corrupt', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-catalog-authority-corrupt-'));
  t.after(() => fs.remove(dataRoot));
  const state = path.join(dataRoot, 'state');
  await fs.outputJson(path.join(state, 'sessions.json'), { sessions: { broken: metadata('broken') } });
  await fs.outputFile(path.join(state, 'sessions', 'broken.json'), '{not-json');
  const result = runMigration(dataRoot);
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(JSON.parse(result.stdout.trim()).error, /Authority file for "broken" is unreadable/);
  assert.equal(await fs.pathExists(path.join(state, 'catalog.sqlite')), false);
});

test('malformed current authority is fatal and never falls through to a stale catalog backup', async t => {
  const cases: Array<[string, Record<string, any>, RegExp]> = [
    ['history', { sessionStateVersion: 1, history: [{}] }, /history\[0\]/],
    ['queue', { sessionStateVersion: 1, history: [], queue: [{}] }, /invalid current QueueItem/],
    ['version', { sessionStateVersion: 99, history: [] }, /Unsupported per-session state format version 99/],
  ];
  for (const [name, authority, expected] of cases) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-catalog-current-${name}-`));
    t.after(() => fs.remove(dataRoot));
    const state = path.join(dataRoot, 'state');
    await fs.outputJson(path.join(state, 'sessions.json'), { sessions: { broken: metadata('broken') } });
    await fs.outputJson(path.join(state, 'sessions.json.1.bak'), { sessions: { stale: metadata('stale') } });
    await fs.outputJson(path.join(state, 'sessions', 'broken.json'), { id: 'broken', ...authority });
    await fs.outputJson(path.join(state, 'sessions', 'stale.json'), { id: 'stale', sessionStateVersion: 1, history: [] });
    const result = runMigration(dataRoot);
    assert.equal(result.status, 3, `${name}: ${result.stderr || result.stdout}`);
    assert.match(JSON.parse(result.stdout.trim()).error, expected);
    assert.equal(await fs.pathExists(path.join(state, 'catalog.sqlite')), false);
    assert.equal(await fs.pathExists(path.join(state, 'sessions.json')), true);
    assert.equal(await fs.pathExists(path.join(state, 'sessions.json.1.bak')), true);
    assert.equal(await fs.pathExists(path.join(state, 'sessions.json.pre-catalog-sqlite-v1.bak')), false);
  }
});

test('bounded presentation queries preserve modes, pinned roots, canonical paths, summaries, and concrete indexes', async t => {
  const fixture = await makeStore(); t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  fixture.store.replaceAll([
    metadata('root', { aliases: ['root-alias'], sidebarOrder: 2, lastMessageTime: 50,
      stats: { totalCachedTokens: 1, totalInputTokens: 2, totalOutputTokens: 3, lastUsage: null } }),
    metadata('ordered', { sidebarOrder: 1, lastMessageTime: 10 }),
    metadata('child-a', { parentSessionId: 'root', sidebarOrder: 1, lastMessageTime: 40 }),
    metadata('child-b', { parentSessionId: 'root', sidebarOrder: 2, lastMessageTime: 30, busy: true }),
    metadata('deep', { parentSessionId: 'child-a', lastMessageTime: 20 }),
    metadata('pinned-child', { parentSessionId: 'root', pinned: true, lastMessageTime: 1 }),
    metadata('dangling', { parentSessionId: 'missing', lastMessageTime: 5 }),
    metadata('alias-owner-1', { aliases: ['duplicate'] }), metadata('alias-owner-2', { aliases: ['duplicate'] }),
  ]);
  const versionDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
  assert.equal(Number((versionDb.prepare('PRAGMA user_version').get() as any).user_version), 2); versionDb.close();
  assert.deepEqual(fixture.store.listPresentationPage({ mode: 'default', roots: true, limit: 20 }).rows.slice(0, 3).map(row => row.id),
    ['pinned-child', 'ordered', 'root']);
  assert.equal(fixture.store.listPresentationPage({ mode: 'time', roots: true, limit: 20 }).rows.some(row => row.id === 'dangling'), true);
  const previews = fixture.store.listChildrenPreviews(['root'], 'default', 1)[0];
  assert.equal(previews.total, 2); assert.deepEqual(previews.rows.map(row => row.id), ['child-a']); assert.ok(previews.nextKey);
  const continuation = fixture.store.listChildrenContinuations([{ parentSessionId: 'root', after: previews.nextKey }], 'default', 10)[0];
  assert.deepEqual(continuation.rows.map(row => row.id), ['child-b']);
  const childB = fixture.store.get('child-b')!; childB.pinned = true; fixture.store.upsertMany([childB]);
  assert.equal(fixture.store.listChildrenPreviews(['root'], 'default', 10)[0].total, 1);
  childB.pinned = false; fixture.store.upsertMany([childB]);
  assert.equal(fixture.store.listChildrenPreviews(['root'], 'default', 10)[0].total, 2);
  assert.deepEqual(fixture.store.getPresentationPaths(['deep']).deep, ['root', 'child-a', 'deep']);
  assert.equal(fixture.store.resolveMany(['root', 'root-alias', 'duplicate', 'missing']).duplicate.kind, 'ambiguous');
  const descendants = fixture.store.getDescendantSummary('root', 20);
  assert.equal(descendants.total, 4); assert.equal(descendants.busy, 1);
  const summary = fixture.store.getArchitectureSummary(); assert.equal(summary.total, 9);
  assert.equal(summary.cachedTokens, 1); assert.equal(summary.inputTokens, 2); assert.equal(summary.outputTokens, 3);

  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const plans = [
      db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE presentation_root=1
        ORDER BY pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id LIMIT 50`).all(),
      db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE parent_session_id=? AND pinned=0
        ORDER BY archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id LIMIT 10`).all('root'),
      db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE agent=? AND presentation_root=1
        ORDER BY pinned_rank,archived,recent_rank,session_id LIMIT 50`).all('main'),
      db.prepare(`EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE presentation_root=1
        AND (pinned_rank,archived,recent_rank,session_id)>(?,?,?,?)
        ORDER BY pinned_rank,archived,recent_rank,session_id LIMIT 50`).all(0, 0, -50, 'root'),
    ].map(rows => JSON.stringify(rows));
    assert.match(plans[0], /idx_session_catalog_root_default/);
    assert.match(plans[1], /idx_session_catalog_parent_default/);
    assert.match(plans[2], /idx_session_catalog_agent_root_time/);
    assert.match(plans[3], /idx_session_catalog_root_time/); assert.doesNotMatch(plans[3], /TEMP B-TREE/);
  } finally { db.close(); }
});

test('compound child seeks stay bounded on high fanout and SQLite BINARY ties are canonical', async t => {
  const fixture = await makeStore(); t.after(async () => { fixture.store.close(); await fs.remove(fixture.root); });
  const binaryIds = ['tie_A','tie_a','tie_\uE000','tie_😀'];
  fixture.store.replaceAll([
    metadata('p1', { lastMessageTime: 10 }), metadata('p2', { lastMessageTime: 10 }),
    metadata('forest-a-root', { agent: 'agent-a' }),
    metadata('forest-b-child', { agent: 'agent-b', parentSessionId: 'forest-a-root' }),
    metadata('forest-a-deep', { agent: 'agent-a', parentSessionId: 'forest-b-child' }),
    ...binaryIds.map(id => metadata(id, { pinned: true, lastMessageTime: 100 })),
    ...Array.from({ length: 1500 }, (_, index) => metadata(`p1_${String(index).padStart(4, '0')}`, { parentSessionId: 'p1', lastMessageTime: 1500 - index })),
    ...Array.from({ length: 1500 }, (_, index) => metadata(`p2_${String(index).padStart(4, '0')}`, { parentSessionId: 'p2', lastMessageTime: 1500 - index })),
  ]);
  assert.deepEqual(fixture.store.listPresentationPage({ mode: 'time', roots: true, limit: 4 }).rows.map(row => row.id), binaryIds);
  assert.deepEqual(fixture.store.listAgentForestPage({ agent: 'agent-a', limit: 10 }).rows.map(row => row.id), ['forest-a-deep','forest-a-root']);
  assert.equal(fixture.store.listChildrenPreviews(['forest-a-root'], 'time', 5, 'agent-a')[0].total, 0);
  const previews = fixture.store.listChildrenPreviews(['p1','p2'], 'time', 5);
  assert.deepEqual(previews.map(group => group.rows.length), [5,5]); assert.deepEqual(previews.map(group => group.total), [1500,1500]);
  const continued = fixture.store.listChildrenContinuations(previews.map(group => ({ parentSessionId: group.parentSessionId, after: group.nextKey })), 'time', 5);
  assert.deepEqual(continued.map(group => group.rows[0].id), ['p1_0005','p2_0005']);

  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM (SELECT metadata_json,busy,queue_length,managed_pending_count,parent_session_id,archived,recent_rank,session_id
        FROM session_catalog INDEXED BY idx_session_catalog_parent_time
        WHERE parent_session_id=? AND pinned=0 ORDER BY archived,recent_rank,session_id LIMIT 6)
      UNION ALL
      SELECT * FROM (SELECT metadata_json,busy,queue_length,managed_pending_count,parent_session_id,archived,recent_rank,session_id
        FROM session_catalog INDEXED BY idx_session_catalog_parent_time
        WHERE parent_session_id=? AND pinned=0 AND (archived,recent_rank,session_id)>(?,?,?)
        ORDER BY archived,recent_rank,session_id LIMIT 6)`).all('p1','p2',0,-1496,'p2_0004'));
    assert.match(plan, /idx_session_catalog_parent_time/); assert.doesNotMatch(plan, /TEMP B-TREE|ranked|row_number/i);
    const forestPlan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT c.session_id FROM session_catalog c
      LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id
      WHERE c.agent=? AND (c.parent_session_id IS NULL OR parent.session_id IS NULL OR parent.agent<>c.agent)
      ORDER BY c.pinned_rank,c.archived,c.recent_rank,c.session_id LIMIT 50`).all('agent-a'));
    assert.match(forestPlan, /idx_session_catalog_agent_time/); assert.match(forestPlan, /sqlite_autoindex_session_catalog_1/);
  } finally { db.close(); }
});
