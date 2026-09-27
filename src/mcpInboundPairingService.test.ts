import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NodeClient } from '../packages/cli-node/dist/client';
import { HttpServer } from './httpServer';
import { normalizeMcpInboundConfig } from './mcpInboundConfig';
import { McpInboundMcpCatalog } from './mcpInboundCatalog';
import { McpInboundHttpService } from './mcpInboundHttp';
import { nodesManager } from './nodes/manager';
import { createNodeRegistryStore, listApprovedNodes, listPendingPairings, resetNodeRegistryForTests, setNodeRegistryStoreForTests } from './nodes/registry';
import { registerNodeWebSocket } from './nodes/websocket';
import { sessionCatalogStore } from './session/catalogStore';
import { definitions } from './tools/definitions';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';

const pairingToken = 'synthetic-admin-provided-pairing-token';
const nodeId = 'headless-external-node';
const credentials = normalizeMcpInboundConfig({ enabled: true, identities: {
  alpha: { token: 'synthetic-headless-operator-token' }, beta: { token: 'synthetic-headless-observer-token' },
} });
function pairingPolicy(approveExtras = '') {
  return parseToolAuthorizationPolicyBytes(`version: 1
defaultAction: allow
rules:
  - id: operator-list
    match: { externalId: alpha, tool: { source: builtin, name: node_pair_list } }
    action: allow
  - id: operator-approve
    match: { externalId: alpha, tool: { source: builtin, name: node_pair_approve }${approveExtras} }
    action: allow
  - id: operator-select
    match: { externalId: alpha, tool: { source: builtin, name: node }, targetNode: ${nodeId}, args: { action: select, nodeId: ${nodeId} } }
    action: allow
  - id: operator-node-files
    match: { externalId: alpha, tool: { source: node, name: [read, write] }, targetNode: ${nodeId} }
    action: allow
`);
}
async function connect(port: number, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'synthetic-headless-operator', version: '1' });
  await client.connect(transport);
  return client;
}
async function call(client: Client, toolId: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'foxwarm_call', arguments: { toolId, args } });
}
async function waitFor<T>(value: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} was not observed.`)), 8000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('headless Node pairs from an offline-admin token via exact policy-authorized external builtin list/approve', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-headless-pair-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dir, 'nodes.json')));
  resetNodeRegistryForTests();
  setToolAuthorizationPolicyForTests(pairingPolicy());
  await sessionCatalogStore.initialize();
  const beforeSessions = sessionCatalogStore.count();
  // No WebUI channel exists. An offline administrator supplies this token to
  // the first-party Node; inbound MCP must neither issue nor reveal it.
  const server = new HttpServer(0, 'synthetic-instance-token');
  registerNodeWebSocket(server, pairingToken);
  const inbound = new McpInboundHttpService(credentials, new McpInboundMcpCatalog(), 60_000);
  inbound.register(server);
  await server.start();
  const port = ((server as any).httpServer.address() as { port: number }).port;
  let alpha: Client | undefined; let beta: Client | undefined; let node: NodeClient | undefined;
  try {
    alpha = await connect(port, 'synthetic-headless-operator-token');
    beta = await connect(port, 'synthetic-headless-observer-token');
    let pendingReady!: (id: string) => void; let registeredReady!: () => void;
    const pending = new Promise<string>(resolve => { pendingReady = resolve; });
    const registered = new Promise<void>(resolve => { registeredReady = resolve; });
    const credentialsFile = path.join(dir, 'client-credentials.json');
    node = new NodeClient({ host: `http://127.0.0.1:${port}`, nodeId, token: pairingToken,
      credentialsFile, localTrigger: false, onStatus: (event, detail) => {
        if (event === 'pair_pending') pendingReady(String(detail?.pendingId));
        if (event === 'registered') registeredReady();
      } });
    await node.connect();
    const pendingId = await waitFor(pending, 'pending first-party Node pairing');
    assert.equal((await listPendingPairings()).some(item => item.id === pendingId), true);
    assert.equal((await listApprovedNodes()).length, 0);

    setToolAuthorizationPolicyForTests(pairingPolicy(', targetNode: master'));
    assert.equal((await call(alpha, 'builtin:node_pair_approve', { pendingId, nodeId })).isError, true,
      'a master-targeted rule cannot authorize owner-neutral pairing');
    assert.equal((await listApprovedNodes()).length, 0);
    setToolAuthorizationPolicyForTests(pairingPolicy());
    const visible = await alpha.callTool({ name: 'foxwarm_discover', arguments: { sources: ['builtin'], limit: 50 } });
    const found = (visible.structuredContent as any)?.tools;
    assert.deepEqual(new Set(found.map((item: any) => item.toolId)),
      new Set(['builtin:node_pair_list', 'builtin:node_pair_approve']));
    for (const entry of found) {
      const source = definitions.find(item => item.name === entry.name);
      assert.equal(entry.description, source?.description);
      assert.deepEqual(entry.inputSchema, source?.parameters);
    }
    assert.equal((await beta.callTool({ name: 'foxwarm_discover', arguments: { sources: ['builtin'], limit: 50 } }).then(
      result => (result.structuredContent as any)?.total)), 0, 'external default allow must not expose another identity');
    assert.equal((await call(beta, 'builtin:node_pair_approve', { pendingId, nodeId })).isError, true);
    assert.equal((await call(alpha, 'builtin:node_bootstrap_info')).isError, true,
      'pairing token and arbitrary builtins remain outside the inbound catalog');
    const listed = await call(alpha, 'builtin:node_pair_list');
    assert.match(String((listed.content as any)[0]?.text), new RegExp(pendingId));
    assert.ok(!JSON.stringify(listed).includes(pairingToken));
    assert.equal((await listApprovedNodes()).length, 0);
    const missing = await call(alpha, 'builtin:node_pair_approve', { pendingId: 'pair_0_00000000', nodeId: 'unknown-node' });
    assert.equal(missing.isError, true, 'unknown pending request cannot create an approved Node');
    assert.equal((await listApprovedNodes()).length, 0);
    assert.equal((await listPendingPairings()).some(item => item.id === pendingId), true);
    setToolAuthorizationPolicyForTests(pairingPolicy(`, args: { pendingId: ${pendingId} }`));
    assert.equal((await call(alpha, 'builtin:node_pair_approve', { pendingId: 'pair_0_00000000' })).isError, true);
    const approved = await call(alpha, 'builtin:node_pair_approve', { pendingId, nodeId });
    assert.equal(approved.isError, undefined, JSON.stringify(approved));
    assert.match(String((approved.content as any)[0]?.text), /Approved node/);
    await waitFor(registered, 'authenticated Node reconnect');
    const nodeCredentials = await fs.readJson(credentialsFile);
    assert.ok(!JSON.stringify(approved).includes(nodeCredentials.authToken), 'operator never receives Node credentials');
    assert.ok(!JSON.stringify(approved).includes(pairingToken));
    assert.equal(nodesManager.supportsExternalOwner(nodeId), true);
    assert.equal(sessionCatalogStore.count(), beforeSessions, 'pairing does not invent an internal Session');

    const selection = await alpha.callTool({ name: 'foxwarm_node', arguments: { action: 'select', nodeId } });
    assert.equal((selection.structuredContent as any)?.currentNode, nodeId);
    const filePath = path.join(dir, 'paired-node.txt');
    const write = await call(alpha, `node:${nodeId}/write`, { filePath, content: 'real paired CLI Node', createDirs: true });
    assert.equal(write.isError, undefined);
    const read = await call(alpha, `node:${nodeId}/read`, { filePath });
    assert.equal(read.isError, undefined);
    assert.match(JSON.stringify(read), /real paired CLI Node/);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'real paired CLI Node');
    assert.equal(sessionCatalogStore.count(), beforeSessions, 'external pairing and Node calls never create a Session');
  } finally {
    await alpha?.close().catch(() => {});
    await beta?.close().catch(() => {});
    await inbound.stop();
    await node?.disconnect();
    await server.stop().catch(() => {});
    nodesManager.unregisterNode(nodeId);
    await new Promise(resolve => setTimeout(resolve, 150)); // Best-effort disconnected-node activity write must settle before removing its fixture.
    setToolAuthorizationPolicyForTests(undefined);
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(dir);
  }
});
