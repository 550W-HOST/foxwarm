import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { COMMANDS } from '../commands';
import { nodesManager } from '../nodes/manager';
import {
  approvePendingPairing,
  attachPendingPairingSocket,
  authenticateApprovedNode,
  createNodeRegistryStore,
  createPendingPairing,
  listApprovedNodes,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from '../nodes/registry';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-command-'));
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

async function approveTestNode(nodeId: string, label = nodeId) {
  const pending = await createPendingPairing({
    requestedName: label,
    nodeType: 'worker',
    capabilities: capabilities(label),
  });
  return approvePendingPairing(pending.id, nodeId);
}

function registerRuntimeNode(nodeId: string) {
  const sentMessages: string[] = [];
  const closeEvents: Array<{ code?: number; reason?: string | Buffer }> = [];
  const ws = {
    send: (text: string) => { sentMessages.push(String(text)); },
    close: (code?: number, reason?: string | Buffer) => { closeEvents.push({ code, reason }); },
    terminate: () => { closeEvents.push({ reason: 'terminated' }); },
  };
  nodesManager.registerNodeWithTools(ws as any, {} as any, 'worker', capabilities(nodeId), nodeId);
  return { ws, sentMessages, closeEvents };
}

test('/node default list includes pending approval info and flat approve command', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'pending node',
      nodeType: 'worker',
      capabilities: capabilities('pending'),
    });
    attachPendingPairingSocket(pending.id, {} as any);

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      [],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );

    const output = replies.pop() || '';
    assert.match(output, /Pending Approvals/);
    assert.match(output, new RegExp(pending.id));
    assert.match(output, /requested=`pending node` ✅ online/);
    assert.match(output, /\/node approve <pending-id>/);
    assert.match(output, /\/node remove <node-id>/);
    assert.match(output, /\/node move <old-id> <new-id>/);
    assert.doesNotMatch(output, /\/node pair approve/);
  });
});

test('/node list marks online rows and suppresses requested names equal to assigned node ids', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const nodeId = 'matching-requested-id';
    const approved = await approveTestNode(nodeId, nodeId);
    const runtime = registerRuntimeNode(approved.nodeId);
    const replies: string[] = [];
    try {
      await COMMANDS['/node'].handler(
        { reply: (text: string) => { replies.push(String(text)); } } as any,
        [],
        'test/session',
        { agent: 'main', currentNode: 'master' } as any,
      );
      const output = replies.pop() || '';
      assert.match(output, new RegExp('`' + nodeId + '` \\[worker\\] ✅ online'));
      assert.doesNotMatch(output, new RegExp('requested=`' + nodeId + '`'));
      assert.match(output, /offline approved→/);
      assert.match(output, new RegExp('approved→`' + nodeId + '`'));
    } finally {
      nodesManager.disconnectNode(approved.nodeId, 'test cleanup');
      assert.equal(runtime.closeEvents.length, 1);
    }
  });
});

test('/node approve uses flat command surface', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const pending = await createPendingPairing({
      requestedName: 'approve node',
      nodeType: 'worker',
      capabilities: capabilities('approve'),
    });

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['approve', pending.id],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );

    const output = replies.pop() || '';
    assert.match(output, /Approved pending pairing/);
    assert.match(output, /Node id:/);
  });
});

test('/node remove removes approved node credentials and closes online runtime state', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const approved = await approveTestNode('remove-command-node', 'remove command node');
    const runtime = registerRuntimeNode(approved.nodeId);

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['remove', approved.nodeId],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );

    const output = replies.pop() || '';
    assert.match(output, /Removed approved node `remove-command-node`/);
    assert.match(output, /Runtime connection: `closed`/);
    assert.match(output, /must be paired again/);
    assert.equal(await authenticateApprovedNode(approved.nodeId, approved.authToken), null);
    assert.equal(nodesManager.getNode(approved.nodeId), undefined);
    assert.equal(runtime.closeEvents.length, 1);
  });
});

test('/node remove reports clear errors for missing and master nodes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['remove', 'missing-node'],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );
    assert.match(replies.pop() || '', /Failed to remove node: Approved node `missing-node` not found/);

    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['remove', 'master'],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );
    assert.match(replies.pop() || '', /Failed to remove node: Node id `master` is reserved/);
  });
});

test('/node move renames approved node, preserves credentials, and closes old runtime state', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    const approved = await approveTestNode('move-command-old', 'move command node');
    const runtime = registerRuntimeNode(approved.nodeId);

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['move', approved.nodeId, 'move-command-new'],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );

    const output = replies.pop() || '';
    assert.match(output, /Moved approved node `move-command-old` → `move-command-new`/);
    assert.match(output, /Auth token hash and metadata were preserved/);
    assert.match(output, /Runtime connection: `old connection closed`/);
    assert.match(output, /Update the node credentials file/);

    assert.equal(await authenticateApprovedNode(approved.nodeId, approved.authToken), null);
    const movedAuth = await authenticateApprovedNode('move-command-new', approved.authToken);
    assert.equal(movedAuth?.nodeId, 'move-command-new');
    assert.equal(nodesManager.getNode(approved.nodeId), undefined);
    assert.equal(runtime.closeEvents.length, 1);
  });
});

test('/node move rejects approved and online new-id conflicts', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'nodes.json');
    setNodeRegistryStoreForTests(createNodeRegistryStore(filePath));
    resetNodeRegistryForTests();

    await approveTestNode('move-conflict-old', 'move conflict old');
    await approveTestNode('move-conflict-approved', 'move conflict approved');
    const runtime = registerRuntimeNode('move-conflict-online');

    const replies: string[] = [];
    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['move', 'move-conflict-old', 'move-conflict-approved'],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );
    assert.match(replies.pop() || '', /Failed to move node: Node id `move-conflict-approved` already exists/);

    await COMMANDS['/node'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['move', 'move-conflict-old', 'move-conflict-online'],
      'test/session',
      { agent: 'main', currentNode: 'master' } as any,
    );
    assert.match(replies.pop() || '', /Failed to move node: Node id `move-conflict-online` is currently online\/registered/);

    nodesManager.disconnectNode('move-conflict-online', 'test cleanup');
    assert.equal(runtime.closeEvents.length, 1);
    assert.equal((await listApprovedNodes()).some(node => node.nodeId === 'move-conflict-old'), true);
  });
});
