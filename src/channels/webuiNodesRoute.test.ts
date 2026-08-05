import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { HttpServer, setHttpServer } from '../httpServer';
import { WebUIChannel } from './webuiChannel';
import { nodesManager } from '../nodes/manager';
import {
  approvePendingPairing,
  createNodeRegistryStore,
  createPendingPairing,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from '../nodes/registry';

const TEST_TOKEN = 'nodes-route-token';

function bearerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

async function approveNode(nodeId: string, services: Record<string, number>): Promise<void> {
  const pending = await createPendingPairing({
    requestedName: nodeId,
    nodeType: 'cli-node',
    capabilities: {
      tools: [{ name: 'private-tool', description: 'must not leave the backend' }],
      services,
    },
  });
  await approvePendingPairing(pending.id, nodeId);
}

test('WebUI nodes route exposes only public launcher capability summaries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-nodes-route-'));
  const registryPath = path.join(tempDir, 'nodes.json');
  const onlineNodeIds = ['capable-node', 'incompatible-node'];
  setNodeRegistryStoreForTests(createNodeRegistryStore(registryPath));
  resetNodeRegistryForTests();

  const port = 35100 + Math.floor(Math.random() * 400);
  const server = new HttpServer(port, TEST_TOKEN);
  setHttpServer(server);

  try {
    await approveNode('capable-node', { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1, 'private-service': 9 });
    await approveNode('incompatible-node', { 'vscode-fs': 1 });
    await approveNode('offline-node', { 'vscode-fs': 1, 'vscode-pty': 1 });

    nodesManager.registerNodeWithTools({ send() {}, close() {} } as any, {} as any, 'cli-node', {
      tools: [{ name: 'private-tool', description: 'must not leave the backend' }],
      services: { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1, 'private-service': 9 },
    }, 'capable-node');
    nodesManager.registerNodeWithTools({ send() {}, close() {} } as any, {} as any, 'cli-node', {
      tools: [{ name: 'private-tool', description: 'must not leave the backend' }],
      services: { 'vscode-fs': 1 },
    }, 'incompatible-node');

    new WebUIChannel({ router: {} as any, token: TEST_TOKEN, enableTrigger: false, enableWebUI: true });
    await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const unauthorized = await fetch(`${baseUrl}/api/nodes`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/api/nodes`, { headers: bearerHeaders() });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.deepEqual(payload.nodes.map((node: any) => node.id), ['master', 'capable-node', 'incompatible-node', 'offline-node']);

    const master = payload.nodes.find((node: any) => node.id === 'master');
    assert.deepEqual(master, { id: 'master', type: 'master', displayName: 'master', online: true, services: {} });
    assert.equal(payload.nodes.find((node: any) => node.id === 'capable-node').online, true);
    assert.deepEqual(payload.nodes.find((node: any) => node.id === 'capable-node').services, {
      'vscode-fs': 1,
      'vscode-git': 2,
      'vscode-pty': 1,
    });
    assert.equal(payload.nodes.find((node: any) => node.id === 'incompatible-node').services['vscode-pty'], undefined);
    assert.equal(payload.nodes.find((node: any) => node.id === 'offline-node').online, false);
    assert.deepEqual(payload.nodes.find((node: any) => node.id === 'offline-node').services, {
      'vscode-fs': 1,
      'vscode-pty': 1,
    });

    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes('tokenHash'), false);
    assert.equal(encoded.includes('private-tool'), false);
    assert.equal(encoded.includes('capabilities'), false);
    assert.equal(encoded.includes('requestedName'), false);
    assert.equal(encoded.includes('private-service'), false);
  } finally {
    for (const nodeId of onlineNodeIds) nodesManager.unregisterNode(nodeId);
    await server.stop().catch((): void => undefined);
    setHttpServer(null);
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(tempDir).catch((): void => undefined);
  }
});