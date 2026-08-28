import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type http from 'node:http';
import { WebSocket } from 'ws';
import { CURRENT_NODE_PROTOCOL_RANGE, LEGACY_NODE_PROTOCOL_RANGE, negotiateNodeProtocol } from '../../packages/shared/dist/nodeProtocol';
import { NodesManager } from './manager';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: any[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; }
}

const capabilities = {
  tools: [{ name: 'exec', description: 'execute', parameters: { type: 'object' } }],
  services: { 'vscode-fs': 1 },
};

test('compatible Node registration advertises negotiated protocol and remains executable', () => {
  const manager = new NodesManager();
  const ws = new FakeSocket();
  const compatibility = negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE);
  manager.registerNodeWithTools(ws as any, {} as http.IncomingMessage, 'cli-node', capabilities, 'current-client', compatibility);
  assert.equal(ws.sent[0]?.type, 'registered');
  assert.deepEqual(ws.sent[0]?.nodeProtocol, { negotiated: 2, master: { min: 2, max: 2 } });
  assert.equal(manager.listNodesWithTools().some(node => node.id === 'current-client'), true);
  manager.setCurrentNode('source', 'current-client');
  manager.unregisterNode('current-client');
});

test('legacy Node stays connected in quarantine but cannot be selected or dispatched', async () => {
  const manager = new NodesManager();
  const ws = new FakeSocket();
  const compatibility = negotiateNodeProtocol(LEGACY_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE, true);
  manager.registerIncompatibleNodeWithTools(ws as any, {} as http.IncomingMessage, 'cli-node', capabilities, compatibility, 'legacy-client');

  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(ws.sent[0]?.type, 'node_incompatible');
  assert.equal(ws.sent[0]?.code, 'NODE_PROTOCOL_INCOMPATIBLE');
  assert.equal(manager.listNodes().find(node => node.id === 'legacy-client')?.protocolCompatibility.status, 'upgrade-required');
  assert.equal(manager.listNodesWithTools().some(node => node.id === 'legacy-client'), false);
  assert.throws(() => manager.setCurrentNode('source', 'legacy-client'), (error: any) => error?.code === 'NODE_PROTOCOL_INCOMPATIBLE');
  await assert.rejects(
    () => manager.executeTool('legacy-client', 'exec', {}, 'source'),
    (error: any) => error?.code === 'NODE_PROTOCOL_INCOMPATIBLE' && /Update and restart/.test(error.message),
  );
  manager.unregisterNode('legacy-client');
});