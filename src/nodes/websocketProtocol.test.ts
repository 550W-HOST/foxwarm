import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HttpServer } from '../httpServer';
import { logger } from '../common';
import { NodeClient } from '../../packages/cli-node/dist/client';
import { nodesManager } from './manager';
import {
  approvePendingPairing,
  createApprovedNode,
  createNodeRegistryStore,
  createPendingPairing,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from './registry';
import { registerNodeWebSocket } from './websocket';
import { sessionCatalogStore } from '../session/catalogStore';

function messageQueue(ws: WebSocket) {
  const queued: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  ws.on('message', raw => {
    const value = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise<any>(resolve => waiters.push(resolve));
}

test('authenticated unversioned legacy client registers ready and can dispatch application messages', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-protocol-ws-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(tempDir, 'nodes.json')));
  resetNodeRegistryForTests();
  await sessionCatalogStore.initialize();
  const pending = await createPendingPairing({
    requestedName: 'legacy-wire-node',
    nodeType: 'cli-node',
    capabilities: { tools: [{ name: 'exec', description: 'exec' }] },
  });
  const approved = await approvePendingPairing(pending.id, 'legacy-wire-node');
  const server = new HttpServer(0, 'api-token');
  registerNodeWebSocket(server, 'pair-token');
  await server.start();
  const address = (server as any).httpServer.address();
  assert.equal(typeof address === 'object' && typeof address?.port === 'number', true);
  const port = address.port as number;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node_ws?id=legacy-wire-node&auth=${approved.authToken}`);
  const nextMessage = messageQueue(ws);
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'session_list_request', requestId: 'before-register' }));
    assert.deepEqual(await nextMessage(), {
      type: 'error',
      code: 'NODE_PROTOCOL_NEGOTIATION_REQUIRED',
      requestId: 'before-register',
      error: 'Authenticated Node must complete core protocol registration before application messages.',
    });

    ws.send(JSON.stringify({
      type: 'node_register',
      nodeType: 'cli-node',
      capabilities: { tools: [{ name: 'exec', description: 'exec' }] },
      // Deliberately omitted: old clients had no nodeProtocol field.
    }));
    const registered = await nextMessage();
    assert.equal(registered.type, 'registered');
    assert.deepEqual(registered.nodeProtocol, { negotiated: 1, master: { min: 1, max: 3 } });
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(nodesManager.getNode('legacy-wire-node')?.protocolCompatibility.status, 'compatible');

    ws.send(JSON.stringify({ type: 'session_list_request', requestId: 'after-register' }));
    const dispatched = await nextMessage();
    assert.equal(dispatched.type, 'cli_response');
    assert.equal(dispatched.requestId, 'after-register');
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    ws.close();
    if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close').catch((): undefined => undefined);
    nodesManager.unregisterNode('legacy-wire-node');
    await server.stop().catch((): undefined => undefined);
    // Message activity persistence is intentionally best-effort/fire-and-forget.
    await new Promise(resolve => setTimeout(resolve, 50));
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(tempDir);
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('created Node authenticates and persists credentials only after registration; file-only restart and pairing still work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-direct-ws-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dir, 'nodes.json')));
  resetNodeRegistryForTests();
  await sessionCatalogStore.initialize();
  const created = await createApprovedNode('direct-node');
  const credentialsFile = path.join(dir, 'credentials.json');
  await fs.writeJson(credentialsFile, { nodeId: 'stale-node', authToken: 'stale-token' });
  const server = new HttpServer(0, 'api-token');
  registerNodeWebSocket(server, 'fixture-global-pairing');
  await server.start();
  const port = ((server as any).httpServer.address() as any).port;
  const statuses: Array<{ event: string; detail: any }> = [];
  const newClient = (params: ConstructorParameters<typeof NodeClient>[0]) => new NodeClient({
    ...params, localTrigger: false,
    onStatus: (event, detail) => statuses.push({ event, detail }),
  });
  let direct: NodeClient | undefined;
  let restarted: NodeClient | undefined;
  let pairing: NodeClient | undefined;
  try {
    const host = `http://127.0.0.1:${port}`;
    direct = newClient({ host, nodeId: created.nodeId, authToken: created.authToken, credentialsFile });
    await direct.connect();
    await waitFor(() => statuses.some(s => s.event === 'registered' && s.detail?.nodeId === 'direct-node'), 'direct registration');
    assert.deepEqual((await fs.readJson(credentialsFile)).nodeId, 'direct-node');
    assert.equal((await fs.readJson(credentialsFile)).authToken, created.authToken);
    if (process.platform !== 'win32') assert.equal((await fs.stat(credentialsFile)).mode & 0o077, 0);
    const record = (await fs.readJson(path.join(dir, 'nodes.json'))).approvedNodes['direct-node'];
    assert.equal(record.nodeProtocol.max, 3);
    assert.equal(JSON.stringify(record).includes(created.authToken), false);
    await direct.disconnect();
    await waitFor(() => !nodesManager.getNode('direct-node'), 'direct disconnect');

    statuses.length = 0;
    restarted = newClient({ host, credentialsFile });
    await restarted.connect();
    await waitFor(() => statuses.some(s => s.event === 'registered' && s.detail?.nodeId === 'direct-node'), 'file-only reconnect');
    assert.equal(nodesManager.getNode('direct-node')?.protocolCompatibility.status, 'compatible');

    pairing = newClient({ host, nodeId: 'pair-flow', token: 'fixture-global-pairing', credentialsFile: path.join(dir, 'pair-credentials.json') });
    (pairing as any).reconnectDelay = 250;
    await pairing.connect();
    await waitFor(() => statuses.some(s => s.event === 'pair_pending'), 'pair request');
    const pending = statuses.find(s => s.event === 'pair_pending')?.detail;
    assert.match(pending.approvalCommand, new RegExp(`^/node approve ${pending.pendingId}$`));
    assert.equal('pairCode' in pending, false);
    await approvePendingPairing(pending.pendingId, 'pair-flow');
    await waitFor(() => statuses.some(s => s.event === 'registered' && s.detail?.nodeId === 'pair-flow'), 'pair approval registration');
    assert.equal((await fs.readJson(path.join(dir, 'pair-credentials.json'))).nodeId, 'pair-flow');
  } finally {
    await Promise.all([direct, restarted, pairing].map(client => client?.disconnect()));
    await waitFor(() => !nodesManager.getNode('direct-node') && !nodesManager.getNode('pair-flow'), 'test client disconnect');
    await server.stop();
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(dir);
  }
});

test('rejected Node websocket logs do not contain the pairing or auth query credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-ws-logging-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dir, 'nodes.json')));
  resetNodeRegistryForTests();
  const server = new HttpServer(0, 'api-token');
  registerNodeWebSocket(server, 'fixture-global-pairing');
  await server.start();
  const port = ((server as any).httpServer.address() as any).port;
  const warned: any[] = [];
  const previousWarn = logger.warn;
  (logger as any).warn = (...args: any[]) => { warned.push(args); };
  try {
    for (const query of ['token=secret-pair', 'id=missing&auth=secret-auth']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/node_ws?${query}`);
      await once(ws, 'close');
    }
    assert.equal(warned.length, 2);
    assert.equal(JSON.stringify(warned).includes('secret-pair'), false);
    assert.equal(JSON.stringify(warned).includes('secret-auth'), false);
  } finally {
    (logger as any).warn = previousWarn;
    await server.stop();
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(dir);
  }
});