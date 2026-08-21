import test from 'node:test';
import assert from 'node:assert/strict';

import { nodesManager } from '../nodes/manager';
import * as nodeExecution from '../nodeExecution';
import { node } from '../tools';

test('node list marks the current session node', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalListTopology = nodeExecution.listNodeTopology;
  const originalListLifecycleProviders = nodeExecution.listNodeLifecycleProviders;

  try {
    (nodeExecution as any).listNodeTopology = async () => ([
      { id: 'master', kind: 'master', provider: 'master', type: 'master', availability: 'ready', tools: [] as any[], lastActivity: 1700000000000 },
      { id: 'remote-a', kind: 'remote', provider: 'authenticated-remote', type: 'worker', availability: 'ready', tools: [] as any[], lastActivity: 1700000001000 },
    ]);
    (nodeExecution as any).listNodeLifecycleProviders = async (): Promise<any[]> => [];
    (nodesManager as any).getCurrentNode = async () => 'remote-a';

    const result = await node({ action: 'list' }, { sessionId: 'test-session' } as any);

    assert.match(result, /Current node: `remote-a`/);
    assert.match(result, /- `remote-a` \(remote\) ✅ current - Last activity:/);
    assert.doesNotMatch(result, /- `master` \(local\) ✅ current/);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodeExecution as any).listNodeTopology = originalListTopology;
    (nodeExecution as any).listNodeLifecycleProviders = originalListLifecycleProviders;
  }
});

test('node list uses current node from provided session context', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalListTopology = nodeExecution.listNodeTopology;
  const originalListLifecycleProviders = nodeExecution.listNodeLifecycleProviders;
  let getCurrentNodeCalled = false;

  try {
    (nodeExecution as any).listNodeTopology = async () => ([
      { id: 'master', kind: 'master', provider: 'master', type: 'master', availability: 'ready', tools: [] as any[], lastActivity: 1700000000000 },
    ]);
    (nodeExecution as any).listNodeLifecycleProviders = async (): Promise<any[]> => [];
    (nodesManager as any).getCurrentNode = async () => {
      getCurrentNodeCalled = true;
      return 'remote-a';
    };

    const result = await node({ action: 'list' }, { sessionId: 'test-session', session: { currentNode: 'master' } } as any);

    assert.match(result, /Current node: `master`/);
    assert.match(result, /- `master` \(local\) ✅ current - Last activity:/);
    assert.equal(getCurrentNodeCalled, false);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodeExecution as any).listNodeTopology = originalListTopology;
    (nodeExecution as any).listNodeLifecycleProviders = originalListLifecycleProviders;
  }
});

test('node list reports when current node is not registered', async () => {
  const originalListNodes = nodesManager.listNodes;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalListTopology = nodeExecution.listNodeTopology;
  const originalListLifecycleProviders = nodeExecution.listNodeLifecycleProviders;

  try {
    (nodeExecution as any).listNodeTopology = async () => ([
      { id: 'master', kind: 'master', provider: 'master', type: 'master', availability: 'ready', tools: [] as any[], lastActivity: 1700000000000 },
    ]);
    (nodeExecution as any).listNodeLifecycleProviders = async (): Promise<any[]> => [];
    (nodesManager as any).getCurrentNode = async () => 'offline-node';

    const result = await node({ action: 'list' }, { sessionId: 'test-session' } as any);

    assert.match(result, /Current node: `offline-node`/);
    assert.match(result, /Current node `offline-node` is not currently available\./);
  } finally {
    (nodesManager as any).listNodes = originalListNodes;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodeExecution as any).listNodeTopology = originalListTopology;
    (nodeExecution as any).listNodeLifecycleProviders = originalListLifecycleProviders;
  }
});
