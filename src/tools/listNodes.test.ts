import test from 'node:test';
import assert from 'node:assert/strict';

import { nodesManager } from '../nodes/manager';
import { list_nodes } from '../tools';

test('list_nodes marks the current session node', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;

  try {
    (nodesManager as any).listNodes = () => ([
      { id: 'master', lastActivity: 1700000000000 },
      { id: 'remote-a', lastActivity: 1700000001000 },
    ]);
    (nodesManager as any).getCurrentNode = async () => 'remote-a';

    const result = await list_nodes({}, { sessionId: 'test-session' } as any);

    assert.match(result, /Current node: `remote-a`/);
    assert.match(result, /- `remote-a` \(remote\) ✅ current - Last activity:/);
    assert.doesNotMatch(result, /- `master` \(local\) ✅ current/);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
  }
});

test('list_nodes uses current node from provided session context', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  let getCurrentNodeCalled = false;

  try {
    (nodesManager as any).listNodes = () => ([
      { id: 'master', lastActivity: 1700000000000 },
    ]);
    (nodesManager as any).getCurrentNode = async () => {
      getCurrentNodeCalled = true;
      return 'remote-a';
    };

    const result = await list_nodes({}, { sessionId: 'test-session', session: { currentNode: 'master' } } as any);

    assert.match(result, /Current node: `master`/);
    assert.match(result, /- `master` \(local\) ✅ current - Last activity:/);
    assert.equal(getCurrentNodeCalled, false);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
  }
});

test('list_nodes reports when current node is not registered', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;

  try {
    (nodesManager as any).listNodes = () => ([
      { id: 'master', lastActivity: 1700000000000 },
    ]);
    (nodesManager as any).getCurrentNode = async () => 'offline-node';

    const result = await list_nodes({}, { sessionId: 'test-session' } as any);

    assert.match(result, /Current node: `offline-node`/);
    assert.match(result, /Current node `offline-node` is not currently registered\/connected\./);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
  }
});
