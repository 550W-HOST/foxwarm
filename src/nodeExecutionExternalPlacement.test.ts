import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_RPC_BUILD_ID, ProcessRpcClientTransport, RPC_PROTOCOL_VERSION } from './rpc';
import * as nodeExecution from './nodeExecution';
import { nodesManager } from './nodes/manager';

class Peer extends EventEmitter { connected = true; send(_message: unknown, callback?: (error: Error | null) => void) { callback?.(null); } }

test('borrowed Node topology missing service never falls back to child nodesManager', async () => {
  const peer = new Peer();
  const transport = new ProcessRpcClientTransport(peer as any, { generation: 1, direction: 'reverse' });
  peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: RPC_PROTOCOL_VERSION, buildId: DEFAULT_RPC_BUILD_ID, generation: 1, services: [] });
  await transport.waitUntilReady();
  const original = nodesManager.listNodesWithTools;
  (nodesManager as any).listNodesWithTools = () => { throw new Error('child node fallback'); };
  try {
    await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
    await assert.rejects(() => nodeExecution.listNodeTopology('source'), { code: 'RPC_SERVICE_NOT_FOUND' });
    await nodeExecution.shutdownNodeExecution();
  } finally { (nodesManager as any).listNodesWithTools = original; transport.close(); }
});
