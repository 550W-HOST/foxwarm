import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { applySessionHistoryState, collectSessionHistoryFiles, createSessionHistoryStore, createSessionsMetadataStore, serializeSessionHistoryPayload } from './metadataStore';

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
      meta: { lastMessageTime: 1 },
      contextFrontier: [{ kind: 'message', seq: 1 }],
    };
    const payload = serializeSessionHistoryPayload(session);
    assert.deepEqual(payload.contextFrontier, [{ kind: 'message', seq: 1 }]);

    const target: any = { history: [], persistentMemorySnapshot: '', stats: {}, busy: false, queue: [], meta: { lastMessageTime: 1 } };
    applySessionHistoryState(target, payload);
    assert.deepEqual(target.contextFrontier, [{ kind: 'message', seq: 1 }]);
  });
});
