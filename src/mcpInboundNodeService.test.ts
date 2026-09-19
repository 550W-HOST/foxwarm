import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { NodeClient } from '../packages/cli-node/dist/client';
import { CLI_NODE_CAPABILITIES } from '../packages/shared/dist/nodeCapabilities';
import { HttpServer } from './httpServer';
import { normalizeMcpInboundConfig, authenticateMcpInboundBearer } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { callExternalNodeTool, externalNodeAction, listExternalNodeTools } from './mcpInboundNodeService';
import { nodesManager } from './nodes/manager';
import {
  approvePendingPairing, createNodeRegistryStore, createPendingPairing, resetNodeRegistryForTests, setNodeRegistryStoreForTests,
} from './nodes/registry';
import { registerNodeWebSocket } from './nodes/websocket';
import { sessionCatalogStore } from './session/catalogStore';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';

const credentials = normalizeMcpInboundConfig({ enabled: true, identities: { alpha: { token: 'synthetic-alpha-token' }, beta: { token: 'synthetic-beta-token' } } });
const policy = parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
  - id: allow-node-control
    match: { externalId: alpha, tool: { source: builtin, name: node } }
    action: allow
  - id: allow-node-files
    match: { externalId: alpha, tool: { source: node, name: [read, write, edit, apply_patch] }, targetNode: paired-external-node }
    action: allow
`);

// A real paired CLI Node receives every call over the authenticated WebSocket.
test('an external context discovers, selects, and uses paired CLI file capabilities without a Session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-external-node-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dir, 'nodes.json')));
  resetNodeRegistryForTests();
  setToolAuthorizationPolicyForTests(policy);
  await sessionCatalogStore.initialize();
  const pending = await createPendingPairing({
    requestedName: 'paired-external-node', nodeType: 'cli-node',
    capabilities: { ...CLI_NODE_CAPABILITIES, tools: [...CLI_NODE_CAPABILITIES.tools], features: { externalToolOwner: 1, remoteExecBackgroundRegistration: true } },
  });
  const approved = await approvePendingPairing(pending.id, 'paired-external-node');
  const server = new HttpServer(0, 'instance-token');
  registerNodeWebSocket(server, 'pair-token');
  await server.start();
  const port = ((server as any).httpServer.address() as { port: number }).port;
  let registered!: () => void;
  const ready = new Promise<void>(resolve => { registered = resolve; });
  const client = new NodeClient({ host: `http://127.0.0.1:${port}`, nodeId: approved.nodeId, authToken: approved.authToken,
    credentialsFile: path.join(dir, 'client.json'), localTrigger: false,
    onStatus: event => { if (event === 'registered') registered(); } });
  try {
    await client.connect();
    await Promise.race([ready, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('CLI Node did not register.')), 5_000))]);
    assert.equal(nodesManager.supportsExternalOwner('paired-external-node'), true);
    const alpha = authenticateMcpInboundBearer(credentials, 'Bearer synthetic-alpha-token')!;
    const beta = authenticateMcpInboundBearer(credentials, 'Bearer synthetic-beta-token')!;
    const a: ExternalExecutionContext = { id: '11111111-2222-4333-8444-555555555555', externalId: 'alpha', currentNode: 'master', cwd: null };
    const b: ExternalExecutionContext = { id: '11111111-2222-4333-8444-666666666666', externalId: 'beta', currentNode: 'master', cwd: null };
    assert.deepEqual(await listExternalNodeTools(beta, b), []);
    const tools = await listExternalNodeTools(alpha, a);
    assert.deepEqual(new Set(tools.map(tool => tool.name)), new Set(['read', 'write', 'edit', 'apply_patch']));
    assert.equal((await externalNodeAction(alpha, a, 'status')).available, false); // master not yet supported externally.
    assert.equal((await externalNodeAction(alpha, a, 'select', 'paired-external-node')).currentNode, 'paired-external-node');
    assert.equal((await externalNodeAction(alpha, a, 'status')).available, true);
    const filePath = path.join(dir, 'test.txt');
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'write', { filePath, content: 'one', createDirs: true });
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'edit', { filePath, oldText: 'one', newText: 'two' });
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'apply_patch', { input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-two\n+three\n*** End Patch` });
    const read = await callExternalNodeTool(alpha, a, 'paired-external-node', 'read', { filePath });
    assert.match(String((read as any).output), /three/);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'three');
    await assert.rejects(() => callExternalNodeTool(beta, b, 'paired-external-node', 'read', { filePath }), /not permitted/);
    await assert.rejects(() => externalNodeAction(beta, b, 'select', 'paired-external-node'), /not permitted/);
  } finally {
    await client.disconnect();
    await server.stop().catch((): undefined => undefined);
    nodesManager.unregisterNode('paired-external-node');
    setToolAuthorizationPolicyForTests(undefined);
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(dir);
  }
});
