import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DiskJsonData, shouldIgnoreDirectorySyncError } from './diskJsonData';

test('directory sync ignores only unsupported filesystem errors', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EISDIR']) {
    assert.equal(shouldIgnoreDirectorySyncError({ code }), true);
  }
  assert.equal(shouldIgnoreDirectorySyncError({ code: 'EIO' }), false);
});

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-disk-json-data-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('DiskJsonData serializes writes, coalesces pending latest data, and uses unique temp files', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'state.json');
    const seenTempPaths: string[] = [];
    let renameCount = 0;
    let releaseFirstRename: (() => void) | null = null;
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let markFirstRenameReached: (() => void) | null = null;
    const firstRenameReached = new Promise<void>((resolve) => {
      markFirstRenameReached = resolve;
    });

    const store = new DiskJsonData<{ value: number }>(filePath, {
      hooks: {
        beforeRename: async ({ tempPath }) => {
          seenTempPaths.push(tempPath);
          renameCount += 1;
          if (renameCount === 1) {
            markFirstRenameReached?.();
            await firstRenameGate;
          }
        },
      },
    });

    const firstWrite = store.write({ value: 1 });
    const secondWrite = store.write({ value: 2 });
    const thirdWrite = store.write({ value: 3 });

    await firstRenameReached;
    releaseFirstRename?.();

    await Promise.all([firstWrite, secondWrite, thirdWrite]);

    assert.equal(renameCount, 2);
    assert.equal(seenTempPaths.length, 2);
    assert.notEqual(seenTempPaths[0], seenTempPaths[1]);

    const written = await fs.readJson(filePath);
    assert.deepEqual(written, { value: 3 });
  });
});

test('DiskJsonData can write and read JSON through durable replace flow', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'state.json');
    const store = new DiskJsonData<{ nested: { ok: boolean } }>(filePath);

    await store.write({ nested: { ok: true } });

    const loaded = await store.readFromPath();
    assert.deepEqual(loaded, { nested: { ok: true } });
  });
});

test('DiskJsonData exposes backup candidates and falls back to backup data when primary is corrupt', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'state.json');
    const store = new DiskJsonData<{ value: number }>(filePath, {
      backup: {
        rotate: 2,
        includeLegacyBak: true,
      },
    });

    await store.write({ value: 1 });
    await store.write({ value: 2 });

    assert.deepEqual(store.listCandidatePaths(), [
      filePath,
      `${filePath}.1.bak`,
      `${filePath}.2.bak`,
      `${filePath}.bak`,
    ]);

    await fs.writeFile(filePath, '{broken-json');

    const loaded = await store.loadFirstAvailable();
    assert(loaded);
    assert.equal(loaded?.source, `${filePath}.1.bak`);
    assert.deepEqual(loaded?.data, { value: 1 });
  });
});
