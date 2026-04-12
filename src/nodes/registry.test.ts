import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createNodeRegistryStore,
  createPendingPairing,
  listPendingPairings,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from './registry';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-registry-'));
  try {
    await run(dirPath);
  } finally {
    resetNodeRegistryForTests();
    setNodeRegistryStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

function capabilities(label: string) {
  return {
    tools: [{ name: `tool_${label}`, description: `tool ${label}` }],
  };
}

test('node registry writes through DiskJsonData-backed persistence', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'alpha node',
      nodeType: 'worker',
      capabilities: capabilities('alpha'),
    });

    const written = await fs.readJson(filePath);
    assert(written.pendingPairings[pending.id]);
    assert.equal(Object.keys(written.pendingPairings).length, 1);
  });
});

test('node registry falls back to backup candidate after primary corruption', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const firstPending = await createPendingPairing({
      requestedName: 'alpha node',
      nodeType: 'worker',
      capabilities: capabilities('alpha'),
    });
    await createPendingPairing({
      requestedName: 'beta node',
      nodeType: 'worker',
      capabilities: capabilities('beta'),
    });

    await fs.writeFile(filePath, '{broken-json');
    resetNodeRegistryForTests();

    const recovered = await listPendingPairings();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, firstPending.id);

    const rewritten = await fs.readJson(filePath);
    assert(rewritten.pendingPairings[firstPending.id]);
  });
});
