import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HttpServer } from '../httpServer';
import { nodesManager } from './manager';
import {
  approvePendingPairing,
  createNodeRegistryStore,
  createPendingPairing,
  resetNodeRegistryForTests,
  setNodeRegistryStoreForTests,
} from './registry';
import { registerNodeWebSocket } from './websocket';

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

test('authenticated legacy client stays connected but is quarantined before application messages', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-protocol-ws-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(tempDir, 'nodes.json')));
  resetNodeRegistryForTests();
  const pending = await createPendingPairing({
    requestedName: 'legacy-wire-node',
    nodeType: 'cli-node',
    capabilities: { tools: [{ name: 'exec', description: 'exec' }] },
  });
  const approved = await approvePendingPairing(pending.id, 'legacy-wire-node');
  const port = 35600 + Math.floor(Math.random() * 300);
  const server = new HttpServer(port, 'api-token');
  registerNodeWebSocket(server, 'pair-token');
  await server.start();
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
    const incompatible = await nextMessage();
    const legacyError = await nextMessage();
    assert.equal(incompatible.type, 'node_incompatible');
    assert.equal(incompatible.code, 'NODE_PROTOCOL_INCOMPATIBLE');
    assert.deepEqual(incompatible.clientProtocol, { min: 1, max: 1 });
    assert.equal(legacyError.code, 'NODE_PROTOCOL_INCOMPATIBLE');
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(nodesManager.getNode('legacy-wire-node')?.protocolCompatibility.status, 'upgrade-required');

    ws.send(JSON.stringify({ type: 'session_list_request', requestId: 'after-register' }));
    const rejected = await nextMessage();
    assert.equal(rejected.code, 'NODE_PROTOCOL_INCOMPATIBLE');
    assert.equal(rejected.requestId, 'after-register');
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