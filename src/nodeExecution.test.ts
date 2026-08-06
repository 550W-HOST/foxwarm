import test from 'node:test';
import assert from 'node:assert/strict';

import { executeTools } from './llm';
import * as nodeExecution from './nodeExecution';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
import { call_tool } from './tools';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function fakeNode(nodeId: string, tools: string[]): any {
  return { id: nodeId, ws: {}, tools: new Set(tools) };
}

async function cleanup(...sessionIds: string[]): Promise<void> {
  await nodeExecution.shutdownNodeExecution().catch(() => {});
  nodeExecution.resetNodeExecutionForTests();
  for (const sessionId of sessionIds) {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
}

test('bound reverse Node handler rejects wrong source before lookup or effect', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: 'owned' }));
  const transport = new LocalRpcTransport(registry);
  const originalLookup = sessionManager.getExistingSession;
  let lookups = 0;
  (sessionManager as any).getExistingSession = async (): Promise<null> => { lookups += 1; return null; };
  try {
    await assert.rejects(() => new RpcClient(nodeExecutionServiceDescriptor, transport).call('execute', {
      sourceSessionId: 'wrong', nodeId: 'remote', toolName: 'read', args: {},
    }), { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    assert.equal(lookups, 0);
  } finally { (sessionManager as any).getExistingSession = originalLookup; await transport.drain(); transport.close(); }
});

test('direct remote builtin and dynamic node calls share the Node execution service', async () => {
  const sourceId = makeId('node_execution_source');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const calls: any[] = [];

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read', 'dynamic_probe']);
    (nodesManager as any).executeTool = async (...args: any[]) => {
      calls.push(args);
      return { ok: true, tool: args[1] };
    };

    const direct = await executeTools(
      [{ id: 'remote-read', name: 'read', args: { filePath: 'README.md' } }],
      { sessionId: sourceId, session },
      session,
    );
    assert.deepEqual(direct.parts.find(part => part.functionResponse)?.functionResponse?.response, { ok: true, tool: 'read' });

    const dynamic = await call_tool({
      source: 'node',
      nodeId: 'remote-a',
      name: 'dynamic_probe',
      args: { value: 1 },
    }, { sessionId: sourceId, session });
    assert.deepEqual(dynamic, { ok: true, tool: 'dynamic_probe' });
    assert.deepEqual(calls.map(call => call.slice(0, 4)), [
      ['remote-a', 'read', { filePath: 'README.md' }, sourceId],
      ['remote-a', 'dynamic_probe', { value: 1 }, sourceId],
    ]);
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('master-currentNode node tools bypass Node execution RPC', async () => {
  const sourceId = makeId('node_execution_master');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'master';
  await sessionManager.saveSession(sourceId);
  const originalRemoteExecute = (nodeExecution as any).executeRemoteNodeTool;
  let remoteCalls = 0;
  (nodeExecution as any).executeRemoteNodeTool = async () => {
    remoteCalls += 1;
    throw new Error('remote service must not be called');
  };

  try {
    const result = await executeTools(
      [{ id: 'local-read', name: 'read', args: { filePath: 'package.json', startLine: 1, endLine: 1 } }],
      { sessionId: sourceId, session },
      session,
    );
    assert.equal(result.parts.find(part => part.functionResponse)?.functionResponse?.response.error, undefined);
    assert.equal(remoteCalls, 0);
  } finally {
    (nodeExecution as any).executeRemoteNodeTool = originalRemoteExecute;
    await cleanup(sourceId);
  }
});

test('routing snapshots preserve parallel exec cwd and dynamic other-node calls carry no cwd snapshot', async () => {
  const sourceId = makeId('node_execution_snapshot');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  session.cwd = '/remote/work';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const snapshots: any[] = [];

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['exec', 'dynamic_probe']);
    (nodesManager as any).executeTool = async (_nodeId: string, toolName: string, _args: any, _sessionId: string, snapshot?: any) => {
      snapshots.push({ toolName, snapshot });
      return { output: 'ok' };
    };

    await executeTools([
      { id: 'exec-a', name: 'exec', args: { command: 'echo a' } },
      { id: 'exec-b', name: 'exec', args: { command: 'echo b' } },
    ], { sessionId: sourceId, session }, session);
    assert.deepEqual(snapshots.slice(0, 2), [
      { toolName: 'exec', snapshot: { currentNode: 'remote-a', cwd: '/remote/work' } },
      { toolName: 'exec', snapshot: { currentNode: 'remote-a', cwd: '/remote/work' } },
    ]);

    session.currentNode = 'master';
    session.cwd = '/master/local';
    await sessionManager.saveSession(sourceId);
    await call_tool({ source: 'node', nodeId: 'remote-b', name: 'dynamic_probe', args: {} }, { sessionId: sourceId, session });
    assert.deepEqual(snapshots[2], { toolName: 'dynamic_probe', snapshot: undefined });
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('Node execution rejects master, stale, offline, unadvertised, and isolated-denied targets', async () => {
  const sourceId = makeId('node_execution_guard');
  const agentName = makeId('node_execution_agent');
  const session = await sessionManager.getSession(sourceId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;

  try {
    (nodesManager as any).executeTool = async () => ({ ok: true });
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(sourceId, 'master', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_MASTER_FORBIDDEN',
    );
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(makeId('missing'), 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_SOURCE_NOT_FOUND',
    );
    (nodesManager as any).getNode = (): any => undefined;
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_NODE_UNAVAILABLE',
    );
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['other_tool']);
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_TOOL_UNAVAILABLE',
    );

    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node' });
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    assert.deepEqual(await nodeExecution.executeRemoteNodeTool(sourceId, 'bound-node', 'read', {}), { ok: true });
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(sourceId, 'other-node', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_ISOLATED_NODE_DENIED',
    );
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('Node execution clones results and preserves remote image/error handling', async () => {
  const sourceId = makeId('node_execution_result');
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = 'remote-a';
  await sessionManager.saveSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const shared = { nested: { value: 1 } };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    (nodesManager as any).executeTool = async () => shared;
    const cloned = await nodeExecution.executeRemoteNodeTool(sourceId, 'remote-a', 'read', {});
    cloned.nested.value = 9;
    assert.equal(shared.nested.value, 1);

    (nodesManager as any).executeTool = async () => ({ inlineData: { data: png, mimeType: 'image/png' } });
    const imageResult = await executeTools(
      [{ id: 'remote-image', name: 'read', args: { filePath: 'image.png' } }],
      { sessionId: sourceId, session }, session,
    );
    assert.equal(imageResult.parts.some(part => part.inlineData?.mimeType === 'image/png'), true);

    (nodesManager as any).executeTool = async () => { throw new Error('remote execution failed'); };
    const errorResult = await executeTools(
      [{ id: 'remote-error', name: 'read', args: { filePath: 'missing' } }],
      { sessionId: sourceId, session }, session,
    );
    assert.match(String(errorResult.parts.find(part => part.functionResponse)?.functionResponse?.response.error), /remote execution failed/);
  } finally {
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});

test('terminal shutdown drains accepted Node execution and fences new calls', async () => {
  const sourceId = makeId('node_execution_drain');
  await sessionManager.getSession(sourceId);
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  let markStarted!: () => void;
  let releaseHandler!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseHandler = resolve; });

  try {
    (nodesManager as any).getNode = (nodeId: string) => fakeNode(nodeId, ['read']);
    (nodesManager as any).executeTool = async () => {
      markStarted();
      await release;
      return 'done';
    };
    const accepted = nodeExecution.executeRemoteNodeTool(sourceId, 'remote-a', 'read', {});
    await started;
    let settled = false;
    const shutdown = nodeExecution.shutdownNodeExecution().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(
      () => nodeExecution.executeRemoteNodeTool(sourceId, 'remote-a', 'read', {}),
      (error: any) => error?.code === 'NODE_EXECUTION_SHUTDOWN',
    );
    releaseHandler();
    assert.equal(await accepted, 'done');
    await shutdown;
    assert.deepEqual(nodeExecution.getNodeExecutionStatus(), { placement: 'local', ready: false });
  } finally {
    releaseHandler?.();
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await cleanup(sourceId);
  }
});
