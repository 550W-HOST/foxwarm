import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { collectSessionHistoryFiles, createSessionHistoryStore, createSessionsMetadataStore, prepareSessionSemanticStateForHydration, replaceSessionSemanticState, serializeSessionHistoryPayload, stripSessionMetadataForSave } from './metadataStore';
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

test('real state-file reader preserves strict v1 shapes while normalizing only unversioned legacy', async () => {
  await withTempDir(async dirPath => {
    const currentPath = path.join(dirPath, 'current.json');
    const malformedCurrent = { sessionStateVersion: 1, history: 'NOT-ARRAY', contextFrontier: { stale: true } };
    await fs.writeFile(currentPath, JSON.stringify(malformedCurrent));
    const currentRaw = await createSessionHistoryStore(currentPath).readFromPath();
    assert.equal(currentRaw?.history, 'NOT-ARRAY');
    assert.deepEqual(currentRaw?.contextFrontier, { stale: true });
    const target: any = { id: 'current', history: [{ role: 'user', parts: [{ text: 'keep' }] }],
      persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 0 } };
    assert.throws(() => replaceAuthoritativeSessionState(target, currentRaw!),
      (error: any) => error?.code === 'SESSION_WORKER_STATE_INVALID');
    assert.equal(target.history[0].parts[0].text, 'keep');
    assert.deepEqual(JSON.parse(await fs.readFile(currentPath, 'utf8')), malformedCurrent);

    const frontierPath = path.join(dirPath, 'frontier.json');
    await fs.writeJson(frontierPath, { sessionStateVersion: 1, history: [], contextFrontier: { invalid: true } });
    const frontierRaw = await createSessionHistoryStore(frontierPath).readFromPath();
    assert.throws(() => replaceAuthoritativeSessionState(target, frontierRaw!),
      (error: any) => error?.code === 'SESSION_WORKER_STATE_INVALID');

    const unknownPath = path.join(dirPath, 'unknown.json');
    await fs.writeJson(unknownPath, { sessionStateVersion: 99, history: [] });
    const unknownRaw = await createSessionHistoryStore(unknownPath).readFromPath();
    assert.throws(() => replaceAuthoritativeSessionState(target, unknownRaw!),
      (error: any) => error?.code === 'SESSION_WORKER_STATE_VERSION');

    const legacyPath = path.join(dirPath, 'legacy.json');
    await fs.writeJson(legacyPath, { history: 'legacy-not-array', contextFrontier: { tolerated: true } });
    const legacyRaw = await createSessionHistoryStore(legacyPath).readFromPath();
    assert.deepEqual(legacyRaw?.history, []);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyRaw, 'contextFrontier'), false);
    assert.equal(replaceAuthoritativeSessionState(target, legacyRaw!).upgradedLegacy, true);
    assert.deepEqual(target.history, []);
  });
});

test('session history payload embeds context frontier and recovery ignores legacy frontier files', async () => {
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
    };
    const payload = serializeSessionHistoryPayload(session);
    assert.equal(payload.sessionStateVersion, 1);
    assert.deepEqual(payload.contextFrontier, [{ kind: 'message', seq: 1 }]);
    assert.equal(payload.lastAppliedMailboxId, 7);
    assert.equal(payload.meta.wait.id, 'wait-1');

    const target: any = { history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 } };
    replaceSessionSemanticState(target, prepareSessionSemanticStateForHydration(target, payload).snapshot);
    assert.deepEqual(target.contextFrontier, [{ kind: 'message', seq: 1 }]);
    assert.equal(target.lastAppliedMailboxId, 7);
    assert.equal(target.meta.managedSession.leaseId, 'lease');
  });
});

test('legacy goal end-turn setting loads but is omitted from current writes', () => {
  const target: any = { history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 } };
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
  assert.equal((stripSessionMetadataForSave(target).goalState as any).remindOnTurnEnd, undefined);
});
