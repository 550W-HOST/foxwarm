import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { COMMANDS } from '../commands';
import {
  createNodeRegistryStore,
  createPendingPairing,
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
    assert.match(output, /\/node approve <pending-id>/);
    assert.doesNotMatch(output, /\/node pair approve/);
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
