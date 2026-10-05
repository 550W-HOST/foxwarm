import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type http from 'node:http';
import { WebSocket } from 'ws';
import { CURRENT_NODE_PROTOCOL_RANGE, LEGACY_NODE_PROTOCOL_RANGE, negotiateNodeProtocol } from '../../packages/shared/dist/nodeProtocol';
import { NodesManager } from './manager';
import * as sessionManager from '../sessionManager';

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
  assert.deepEqual(ws.sent[0]?.nodeProtocol, { negotiated: 3, master: { min: 1, max: 3 } });
  assert.equal(manager.listNodesWithTools().some(node => node.id === 'current-client'), true);
  manager.setCurrentNode('source', 'current-client');
  manager.unregisterNode('current-client');
});

test('legacy Node negotiates v1, remains selectable, and keeps tool, file, service, and session-event gates executable', async () => {
  const manager = new NodesManager();
  const ws = new FakeSocket();
  const sessionId = `legacy-compatible-${Date.now()}`;
  const compatibility = negotiateNodeProtocol(LEGACY_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE, true);
  manager.registerNodeWithTools(ws as any, {} as http.IncomingMessage, 'cli-node', capabilities, 'legacy-client', compatibility);
  try {
    const session = await sessionManager.getSession(sessionId);
    session.currentNode = 'legacy-client';
    await sessionManager.saveSession(sessionId);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.deepEqual(ws.sent[0]?.nodeProtocol, { negotiated: 1, master: { min: 1, max: 3 } });
    assert.equal(manager.listNodes().find(node => node.id === 'legacy-client')?.protocolCompatibility.status, 'compatible');
    assert.equal(manager.listNodesWithTools().some(node => node.id === 'legacy-client'), true);
    assert.deepEqual(manager.listNodeServiceSummaries().find(node => node.id === 'legacy-client')?.services, { 'vscode-fs': 1 });
    manager.setCurrentNode(sessionId, 'legacy-client');

    const filePromise = manager.readFileFromNode('legacy-client', '/tmp/example', sessionId);
    const fileRequest = ws.sent.at(-1);
    assert.equal(fileRequest.type, 'file_read_request');
    manager.handleFileReadResponse(fileRequest.transferId, {
      filePath: '/tmp/example', name: 'example', sizeBytes: 0, mimeType: 'application/octet-stream', isImage: false,
      dataBase64: '', sha256: '0'.repeat(64),
    });
    assert.equal((await filePromise).sizeBytes, 0);

    await manager.handleSessionEvent('legacy-client', sessionId, 'legacy event', 'trigger');
    assert.match(JSON.stringify((await sessionManager.getSession(sessionId)).queue), /legacy event/);
  } finally {
    manager.unregisterNode('legacy-client');
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('explicit disjoint Node range stays connected in quarantine and all execution gates remain blocked', async () => {
  const manager = new NodesManager();
  const ws = new FakeSocket();
  const compatibility = negotiateNodeProtocol({ min: 4, max: 4 }, CURRENT_NODE_PROTOCOL_RANGE);
  manager.registerIncompatibleNodeWithTools(ws as any, {} as http.IncomingMessage, 'cli-node', capabilities, compatibility, 'future-client');
  assert.equal(ws.sent[0]?.type, 'node_incompatible');
  assert.equal(manager.listNodesWithTools().some(node => node.id === 'future-client'), false);
  assert.deepEqual(manager.listNodeServiceSummaries().find(node => node.id === 'future-client')?.services, {});
  assert.throws(() => manager.setCurrentNode('source', 'future-client'), (error: any) => error?.code === 'NODE_PROTOCOL_INCOMPATIBLE');
  await assert.rejects(() => manager.requestNodeService('future-client', 'vscode-fs', 'stat', {}), (error: any) => error?.code === 'NODE_PROTOCOL_INCOMPATIBLE');
  await assert.rejects(() => manager.handleSessionEvent('future-client', 'source', 'blocked', 'trigger'), (error: any) => error?.code === 'NODE_PROTOCOL_INCOMPATIBLE');
  manager.unregisterNode('future-client');
});
test('programmatic hint reaches advertising CLI peers while old peers retain their native response', async () => {
  const manager = new NodesManager();
  const sessionId = `programmatic-node-${Date.now()}`;
  await sessionManager.getSession(sessionId);
  const current = new FakeSocket(); const older = new FakeSocket();
  const readCapability = { tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }] };
  manager.registerNodeWithTools(current as any, {} as http.IncomingMessage, 'cli-node', { ...readCapability, features: { programmaticToolData: true } }, 'current-script-peer');
  manager.registerNodeWithTools(older as any, {} as http.IncomingMessage, 'cli-node', readCapability, 'old-script-peer');
  try {
    const currentPromise = manager.executeTool('current-script-peer', 'read', { filePath: 'data' }, sessionId, undefined, true);
    const currentCall = current.sent.find(message => message.type === 'tool_call');
    assert.equal(currentCall.programmatic, true); assert.equal(currentCall.args.programmatic, undefined);
    manager.handleToolResponse(currentCall.callId, { output: 'display', content: 'data', truncated: false }, 'current-script-peer');
    assert.deepEqual(await currentPromise, { output: 'display', content: 'data', truncated: false });
    const olderPromise = manager.executeTool('old-script-peer', 'read', { filePath: 'data' }, sessionId, undefined, true);
    const olderCall = older.sent.find(message => message.type === 'tool_call');
    assert.equal(Object.prototype.hasOwnProperty.call(olderCall, 'programmatic'), false);
    manager.handleToolResponse(olderCall.callId, { output: 'legacy display' }, 'old-script-peer');
    assert.deepEqual(await olderPromise, { output: 'legacy display' });
    const direct = manager.executeTool('current-script-peer', 'read', { filePath: 'data', programmatic: true }, sessionId);
    const directCall = current.sent.filter(message => message.type === 'tool_call').at(-1);
    assert.equal(directCall.programmatic, undefined);
    manager.handleToolResponse(directCall.callId, 'native direct', 'current-script-peer'); assert.equal(await direct, 'native direct');
  } finally { manager.unregisterNode('current-script-peer'); manager.unregisterNode('old-script-peer'); await sessionManager.deleteSession(sessionId).catch(() => false); }
});
