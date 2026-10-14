import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { HttpServer, setHttpServer } from '../httpServer';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { sessionCatalogStore } from '../session/catalogStore';
import { initializeNodeExecution, shutdownNodeExecution } from '../nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from '../nodeExecutionService';
import { LocalRpcTransport, RpcServiceRegistry } from '../rpc';
import { MasterNodeProvider, NodeProviderRegistry, type NodeDescriptor } from '../nodes/providerRegistry';
import { createApprovedNode, createNodeRegistryStore, resetNodeRegistryForTests, setNodeRegistryStoreForTests } from '../nodes/registry';

test('Session node routes use canonical selection, preserve cwd, and reject unavailable or agent-bound selections', async () => {
  if (!sessionCatalogStore.exists()) sessionCatalogStore.initializeEmpty();
  else sessionCatalogStore.open();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-nodes-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(tempDir, 'nodes.json')));
  resetNodeRegistryForTests();
  const sessionId = `session_nodes_${Date.now()}`;
  const otherId = `${sessionId}_other`;
  const cwd = 'fixture://kept-cwd';
  const descriptors: NodeDescriptor[] = [
    { id: 'exec-only', kind: 'remote', provider: 'fixture', type: 'shell', availability: 'ready', tools: [{ name: 'exec', description: 'private-tool-schema' }], defaultCwd: 'fixture://remote' },
    { id: 'read-only-sandbox', kind: 'sandbox', provider: 'fixture', type: 'sandbox', availability: 'ready', tools: [{ name: 'read' }] },
    { id: 'upgrade-required', kind: 'remote', provider: 'fixture', type: 'cli', availability: 'error', tools: [], protocolCompatibility: { status: 'upgrade-required', client: { min: 4, max: 4 }, master: { min: 1, max: 3 }, legacyClient: false } },
  ];
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), {
      id: 'fixture', listNodes: () => descriptors, getNode: id => descriptors.find(node => node.id === id),
      async invokeTool() { throw new Error('Fixture selection does not need tool execution'); },
    }]),
  }));
  const token = 'fixture-admin';
  const server = new HttpServer(0, token);
  setHttpServer(server);
  const originalIsolationNode = sessionManager.getAgentIsolationNode;
  try {
    await sessionManager.createEmptySession(sessionId);
    await sessionManager.createEmptySession(otherId);
    await sessionRuntime.initializeSessionRuntime();
    await sessionRuntime.updateSettings(sessionId, { cwd });
    await createApprovedNode('offline-node');
    await initializeNodeExecution({ transport: new LocalRpcTransport(registry) });
    new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
    await server.start();
    const port = (server as any).httpServer.address().port;
    const base = `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`;
    const request = (suffix: string, body?: unknown) => fetch(`${base}/${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await fetch(`${base}/nodes`)).status, 401);
    assert.equal((await fetch(`${base}/node`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"nodeId":"master"}' })).status, 401);
    const listResponse = await request('nodes');
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as any;
    assert.deepEqual(list.nodes.map((node: any) => [node.id, node.selectable]), [
      ['master', true], ['exec-only', true], ['read-only-sandbox', true], ['upgrade-required', false], ['offline-node', false],
    ]);
    assert.equal(JSON.stringify(list).includes('private-tool-schema'), false);
    assert.equal(JSON.stringify(list).includes('token'), false);
    for (const nodeId of ['exec-only', 'master']) {
      const response = await request('node', { nodeId });
      assert.equal(response.status, 200);
      const payload = await response.json() as any;
      assert.equal(payload.session.currentNode, nodeId);
      assert.equal(payload.session.cwd, cwd);
      assert.equal((await sessionRuntime.getSession(sessionId)).currentNode, nodeId);
      assert.equal((await sessionRuntime.getSession(otherId)).currentNode || 'master', 'master');
    }
    for (const nodeId of ['offline-node', 'upgrade-required', 'missing-node']) {
      const response = await request('node', { nodeId });
      assert.equal(response.status, 400);
      assert.ok((await response.json() as any).error);
      assert.equal((await sessionRuntime.getSession(sessionId)).currentNode, 'master');
      assert.equal((await sessionRuntime.getSession(sessionId)).cwd, cwd);
    }
    assert.equal((await request('node', { nodeId: 42 })).status, 400);
    (sessionManager as any).getAgentIsolationNode = () => 'read-only-sandbox';
    const locked = await (await request('nodes')).json() as any;
    assert.ok(locked.lockedReason.includes('read-only-sandbox'));
    assert.ok(locked.nodes.every((node: any) => !node.selectable));
    assert.equal((await request('node', { nodeId: 'exec-only' })).status, 400);
    assert.equal((await sessionRuntime.getSession(sessionId)).currentNode, 'master');
  } finally {
    (sessionManager as any).getAgentIsolationNode = originalIsolationNode;
    await server.stop().catch(() => {});
    setHttpServer(null);
    await shutdownNodeExecution();
    await sessionRuntime.shutdownSessionRuntime();
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await sessionManager.deleteSession(otherId).catch(() => {});
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(tempDir);
  }
});
