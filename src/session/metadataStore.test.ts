import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { collectSessionHistoryFiles, createSessionHistoryStore, createSessionsMetadataStore, prepareSessionSemanticStateForHydration, replaceSessionSemanticState, serializeSessionHistoryPayload } from './metadataStore';
import { buildSessionCatalogProjection } from './catalogStore';
import { replaceAuthoritativeSessionState } from './stateHydration';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-metadata-store-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('sessions metadata store normalizes legacy payload shape and lists backup candidates', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'sessions.json');
    const store = createSessionsMetadataStore(filePath);

    await fs.writeJson(filePath, {
      alpha: { id: 'alpha', currentNode: 'master' },
    }, { spaces: 2 });

    const loaded = await store.readFromPath();
    assert.deepEqual(loaded, {
      sessions: {
        alpha: { id: 'alpha', currentNode: 'master' },
      },
    });

    assert.deepEqual(store.listCandidatePaths(), [
      filePath,
      `${filePath}.1.bak`,
      `${filePath}.2.bak`,
      `${filePath}.3.bak`,
      `${filePath}.4.bak`,
      `${filePath}.5.bak`,
      `${filePath}.bak`,
    ]);
  });
});

test('sessions metadata store recovers from backup candidate after primary corruption', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'sessions.json');
    const store = createSessionsMetadataStore(filePath);

    await store.write({
      sessions: {
        alpha: { id: 'alpha', displayName: 'first' },
      },
    });
    await store.write({
      sessions: {
        alpha: { id: 'alpha', displayName: 'second' },
      },
    });

    await fs.writeFile(filePath, '{broken-json');

    const loaded = await store.loadFirstAvailable();
    assert(loaded);
    assert.equal(loaded?.source, `${filePath}.1.bak`);
    assert.deepEqual(loaded?.data, {
      sessions: {
        alpha: { id: 'alpha', displayName: 'first' },
      },
    });
  });
});

test('session history store uses lightweight no-backup config and still round-trips payloads', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'sessions', 'alpha.json');
    const store = createSessionHistoryStore(filePath);

    assert.deepEqual(store.listCandidatePaths(), [filePath]);

    await store.write({
      history: [{
        role: 'model',
        parts: [{ text: 'hello' }],
        __meta: { modelId: 'anthropic/claude', virtualModelKey: 'fallback' },
      }],
      queue: [{ type: 'trigger', parts: [{ text: 'queued' }] }],
      persistentMemorySnapshot: 'snapshot',
    });

    const loaded = await store.readFromPath();
    assert.deepEqual(loaded, {
      history: [{
        role: 'model',
        parts: [{ text: 'hello' }],
        __meta: { modelId: 'anthropic/claude', virtualModelKey: 'fallback' },
      }],
      queue: [{ type: 'trigger', parts: [{ text: 'queued' }] }],
      persistentMemorySnapshot: 'snapshot',
    });

    const siblingFiles = await fs.readdir(path.dirname(filePath));
    assert.deepEqual(siblingFiles, ['alpha.json']);
  });
});

test('real state-file reader rejects malformed v1 shapes while normalizing only unversioned legacy', async () => {
  await withTempDir(async dirPath => {
    const currentPath = path.join(dirPath, 'current.json');
    const malformedCurrent = { sessionStateVersion: 1, history: 'NOT-ARRAY', contextFrontier: { stale: true } };
    await fs.writeFile(currentPath, JSON.stringify(malformedCurrent));
    const target: any = { id: 'current', history: [{ role: 'user', parts: [{ text: 'keep' }] }],
      persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 0 } };
    await assert.rejects(() => createSessionHistoryStore(currentPath).readFromPath(), /history must be an array/);
    assert.equal(target.history[0].parts[0].text, 'keep');
    assert.deepEqual(JSON.parse(await fs.readFile(currentPath, 'utf8')), malformedCurrent);

    const frontierPath = path.join(dirPath, 'frontier.json');
    await fs.writeJson(frontierPath, { sessionStateVersion: 1, history: [], contextFrontier: { invalid: true } });
    const frontierRaw = await createSessionHistoryStore(frontierPath).readFromPath();
    assert.equal(Object.prototype.hasOwnProperty.call(frontierRaw!, 'contextFrontier'), false);

    const unknownPath = path.join(dirPath, 'unknown.json');
    await fs.writeJson(unknownPath, { sessionStateVersion: 99, history: [] });
    await assert.rejects(() => createSessionHistoryStore(unknownPath).readFromPath(), /Unsupported per-session state format version 99/);

    const legacyPath = path.join(dirPath, 'legacy.json');
    await fs.writeJson(legacyPath, { history: 'legacy-not-array', contextFrontier: { tolerated: true } });
    const legacyRaw = await createSessionHistoryStore(legacyPath).readFromPath();
    assert.deepEqual(legacyRaw?.history, []);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyRaw, 'contextFrontier'), false);
    assert.equal(replaceAuthoritativeSessionState(target, legacyRaw!).upgradedLegacy, true);
    assert.deepEqual(target.history, []);
  });
});

test('session history payload drops obsolete context frontier and recovery ignores legacy frontier files', async () => {
  await withTempDir(async (dirPath) => {
    const sessionsDir = path.join(dirPath, 'sessions');
    await fs.ensureDir(sessionsDir);
    const historyFilePath = path.join(sessionsDir, 'alpha.json');
    const frontierFilePath = path.join(sessionsDir, 'alpha.frontier.json');
    await fs.writeJson(historyFilePath, { history: [] });
    await fs.writeJson(frontierFilePath, { v: 1, frontier: [{ kind: 'message', seq: 1 }] });

    assert.deepEqual(await collectSessionHistoryFiles(sessionsDir), [historyFilePath]);

    const session: any = {
      id: 'alpha',
      history: [{ role: 'user', parts: [{ text: 'hello' }], __meta: { seq: 1 } }],
      persistentMemorySnapshot: 'snapshot',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: 1, wait: { id: 'wait-1' }, managedSession: { ownerSessionId: 'owner', leaseId: 'lease', revision: 1, pendingInbox: [] } },
      contextFrontier: [{ kind: 'message', seq: 1 }],
      lastAppliedMailboxId: 7,
      effort: 'none',
      childEffortDefault: 'max',
    };
    const payload = serializeSessionHistoryPayload(session);
    assert.equal(payload.sessionStateVersion, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'contextFrontier'), false);
    assert.equal(payload.lastAppliedMailboxId, 7);
    assert.equal(payload.meta.wait.id, 'wait-1');
    assert.equal(payload.effort, 'none');
    assert.equal(payload.childEffortDefault, 'max');

    const target: any = { history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 } };
    replaceSessionSemanticState(target, prepareSessionSemanticStateForHydration(target, payload).snapshot);
    assert.equal(Object.prototype.hasOwnProperty.call(target, 'contextFrontier'), false);
    assert.equal(target.lastAppliedMailboxId, 7);
    assert.equal(target.meta.managedSession.leaseId, 'lease');
    assert.equal(target.effort, 'none');
    assert.equal(target.childEffortDefault, 'max');
  });
});

test('legacy per-message contextFrontierItem is stripped on hydrate and write while contextBlock survives', () => {
  const contextBlock = {
    id: 7, level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 1, rawStartSeq: 1, rawEndSeq: 1,
  };
  const raw: any = {
    sessionStateVersion: 1,
    history: [{
      role: 'user', parts: [{ text: 'legacy frontier metadata' }],
      __meta: { seq: 1, timestamp: 1, contextFrontierItem: { kind: 'message', seq: 1 }, contextBlock },
    }],
    persistentMemorySnapshot: '', queue: [],
  };
  const target: any = {
    id: 'legacy-message-frontier', history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [],
    meta: { lastMessageTime: 0 },
  };
  replaceSessionSemanticState(target, prepareSessionSemanticStateForHydration(target, raw).snapshot);
  assert.equal(Object.prototype.hasOwnProperty.call(target.history[0].__meta, 'contextFrontierItem'), false);
  assert.deepEqual(target.history[0].__meta.contextBlock, contextBlock);
  const written = serializeSessionHistoryPayload({ ...target, history: raw.history } as any);
  assert.equal(Object.prototype.hasOwnProperty.call(written.history[0].__meta, 'contextFrontierItem'), false);
  assert.deepEqual(written.history[0].__meta.contextBlock, contextBlock);
});

test('legacy goal end-turn setting loads but is omitted from current writes', () => {
  const target: any = { id: 'legacy-goal', history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 } };
  const legacy = {
    goalState: {
      goal: 'Preserve the long-running task',
      remindEvery: 5,
      remindOnTurnEnd: false,
      anchorSeq: 3,
      updatedAt: 1,
    },
  };
  replaceSessionSemanticState(target, prepareSessionSemanticStateForHydration(target, legacy).snapshot);

  assert.equal(target.goalState.goal, 'Preserve the long-running task');
  assert.equal(target.goalState.remindOnTurnEnd, false);
  assert.equal((serializeSessionHistoryPayload(target).goalState as any).remindOnTurnEnd, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(buildSessionCatalogProjection(target), 'goalState'), false);
});

test('Main hydration preserves catalog-owned identity and topology while authority semantics win', () => {
  const target: any = {
    id: 'catalog-id', agent: 'catalog-agent', aliases: ['catalog-alias'], parentSessionId: 'catalog-parent', displayName: 'Catalog name',
    history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 }, model: 'catalog-model',
  };
  const authority: Record<string, any> = {
    sessionStateVersion: 1, history: [], queue: [], agent: 'authority-agent', aliases: ['authority-alias'],
    parentSessionId: 'authority-parent', displayName: 'Authority name', model: 'authority-model', effort: 'xhigh',
    stats: {}, meta: { lastMessageTime: 2 },
  };
  replaceAuthoritativeSessionState(target, authority, { preserveCatalogFields: true });
  assert.equal(target.agent, 'catalog-agent'); assert.deepEqual(target.aliases, ['catalog-alias']);
  assert.equal(target.parentSessionId, 'catalog-parent'); assert.equal(target.displayName, 'Catalog name');
  assert.equal(target.model, 'authority-model'); assert.equal(target.effort, 'xhigh'); assert.equal(target.meta.lastMessageTime, 2);
});

test('current authorities without effort fields hydrate as canonical unset', () => {
  const target: any = {
    id: 'old-current', history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [],
    meta: { lastMessageTime: 0 }, effort: 'max', childEffortDefault: 'low',
  };
  replaceSessionSemanticState(target, prepareSessionSemanticStateForHydration(target, {
    sessionStateVersion: 1, history: [], persistentMemorySnapshot: '', queue: [],
  }).snapshot);
  assert.equal(Object.prototype.hasOwnProperty.call(target, 'effort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(target, 'childEffortDefault'), false);
});
