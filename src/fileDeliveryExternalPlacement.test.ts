import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_RPC_BUILD_ID, ProcessRpcClientTransport, RPC_PROTOCOL_VERSION } from './rpc';
import * as fileDelivery from './fileDelivery';
import * as sessionManager from './sessionManager';

class Peer extends EventEmitter { connected = true; send(_message: unknown, callback?: (error: Error | null) => void) { callback?.(null); } }

test('borrowed file delivery missing service never falls back to child SessionManager', async () => {
  const peer = new Peer(); const transport = new ProcessRpcClientTransport(peer as any, { generation: 1, direction: 'reverse' });
  peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: RPC_PROTOCOL_VERSION, buildId: DEFAULT_RPC_BUILD_ID, generation: 1, services: [] });
  await transport.waitUntilReady();
  const original = sessionManager.sendFileToSession;
  (sessionManager as any).sendFileToSession = async () => { throw new Error('child delivery fallback'); };
  try {
    await fileDelivery.initializeFileDelivery({ transport, placement: 'child-reverse' });
    await assert.rejects(() => fileDelivery.deliverFile({ sourceSessionId: 'source', intent: { filePath: 'x' },
      routing: { runtimeNodeId: 'master', currentNode: 'master' } }), { code: 'FILE_DELIVERY_UNAVAILABLE', retryable: true });
    await fileDelivery.shutdownFileDelivery();
  } finally { (sessionManager as any).sendFileToSession = original; transport.close(); }
});
