import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  approvePendingPairing,
  authenticateApprovedNode,
  cleanupExpiredPendingPairings,
  createNodeRegistryStore,
  createPendingPairing,
  listApprovedNodes,
  listPendingPairings,
  moveApprovedNode,
  PENDING_PAIRING_TTL_MS,
  removeApprovedNode,
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

test('expired pending pairings older than 1 hour are removed from registry', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'stale node',
      nodeType: 'worker',
      capabilities: capabilities('stale'),
    });

    const raw = await fs.readJson(filePath);
    raw.pendingPairings[pending.id].requestedAt = Date.now() - PENDING_PAIRING_TTL_MS - 1000;
    raw.pendingPairings[pending.id].updatedAt = raw.pendingPairings[pending.id].requestedAt;
    await fs.writeJson(filePath, raw, { spaces: 2 });

    resetNodeRegistryForTests();
    const removed = await cleanupExpiredPendingPairings();
    assert.equal(removed, 1);

    const remaining = await listPendingPairings();
    assert.equal(remaining.length, 0);
  });
});

test('expired approved-but-undelivered pending pairings remove their temporary approved node too', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'offline node',
      nodeType: 'worker',
      capabilities: capabilities('offline'),
    });

    const approved = await approvePendingPairing(pending.id, 'offline-node');
    const raw = await fs.readJson(filePath);
    raw.pendingPairings[pending.id].approvedAt = Date.now() - PENDING_PAIRING_TTL_MS - 1000;
    raw.pendingPairings[pending.id].updatedAt = raw.pendingPairings[pending.id].approvedAt;
    await fs.writeJson(filePath, raw, { spaces: 2 });

    resetNodeRegistryForTests();
    const removed = await cleanupExpiredPendingPairings();
    assert.equal(removed, 1);

    const remainingPending = await listPendingPairings();
    const approvedNodes = await listApprovedNodes();
    assert.equal(remainingPending.length, 0);
    assert.equal(approvedNodes.some(node => node.nodeId === approved.nodeId), false);
  });
});

test('removeApprovedNode removes approved credentials and rejects missing or reserved ids', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'remove node',
      nodeType: 'worker',
      capabilities: capabilities('remove'),
    });
    const approved = await approvePendingPairing(pending.id, 'remove-node');

    const before = await authenticateApprovedNode(approved.nodeId, approved.authToken);
    assert.equal(before?.nodeId, approved.nodeId);

    const removed = await removeApprovedNode(approved.nodeId);
    assert.equal(removed.nodeId, approved.nodeId);

    const after = await authenticateApprovedNode(approved.nodeId, approved.authToken);
    assert.equal(after, null);
    assert.equal((await listApprovedNodes()).length, 0);

    await assert.rejects(() => removeApprovedNode('remove-node'), /Approved node `remove-node` not found/);
    await assert.rejects(() => removeApprovedNode('master'), /reserved/);
  });
});

test('moveApprovedNode renames approved node and preserves auth hash', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'move node',
      nodeType: 'worker',
      capabilities: capabilities('move'),
    });
    const approved = await approvePendingPairing(pending.id, 'move-node');

    const moved = await moveApprovedNode('move-node', 'moved-node');
    assert.equal(moved.oldNodeId, 'move-node');
    assert.equal(moved.newNodeId, 'moved-node');

    assert.equal(await authenticateApprovedNode('move-node', approved.authToken), null);
    const authenticated = await authenticateApprovedNode('moved-node', approved.authToken);
    assert.equal(authenticated?.nodeId, 'moved-node');
    assert.equal(authenticated?.nodeType, 'worker');
    assert.equal(authenticated?.capabilities?.tools[0]?.name, 'tool_move');
  });
});

test('moveApprovedNode rejects conflicts, invalid new ids, missing old ids, and reserved ids', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const first = await createPendingPairing({
      requestedName: 'first node',
      nodeType: 'worker',
      capabilities: capabilities('first'),
    });
    await approvePendingPairing(first.id, 'first-node');

    const second = await createPendingPairing({
      requestedName: 'second node',
      nodeType: 'worker',
      capabilities: capabilities('second'),
    });
    await approvePendingPairing(second.id, 'second-node');

    await assert.rejects(() => moveApprovedNode('first-node', 'second-node'), /already exists/);
    await assert.rejects(() => moveApprovedNode('first-node', 'Bad Node'), /sanitized form/);
    await assert.rejects(() => moveApprovedNode('first-node', 'master'), /reserved/);
    await assert.rejects(() => moveApprovedNode('missing-node', 'new-node'), /Approved node `missing-node` not found/);
    await assert.rejects(() => moveApprovedNode('master', 'new-node'), /reserved/);
  });
});
