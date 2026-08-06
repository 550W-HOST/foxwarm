import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_RPC_BUILD_ID, ProcessRpcClientTransport, RPC_PROTOCOL_VERSION } from './rpc';
import * as vector from './vector';

class ReversePeer extends EventEmitter {
  connected = true;
  sends: unknown[] = [];
  send(message: unknown, callback?: (error: Error | null) => void) { this.sends.push(message); callback?.(null); }
}

test('borrowed vector placement never falls back when real reverse ready omits vector service', async () => {
  const peer = new ReversePeer();
  const transport = new ProcessRpcClientTransport(peer as any, { generation: 1, direction: 'reverse' });
  peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: RPC_PROTOCOL_VERSION, buildId: DEFAULT_RPC_BUILD_ID,
    generation: 1, services: [] });
  await transport.waitUntilReady();
  const localOwnerLoaded = () => Object.keys(require.cache).some(file => /vector(Runtime|ServiceManager)\.js$/.test(file));
  assert.equal(localOwnerLoaded(), false);
  await vector.init({ transport, placement: 'child-reverse' });
  await assert.rejects(() => vector.search('missing service'), { code: 'VECTOR_UNAVAILABLE' });
  assert.equal(localOwnerLoaded(), false);
  const sendsBeforeShutdown = peer.sends.length;
  await vector.shutdown();
  assert.equal(peer.sends.length, sendsBeforeShutdown);
  transport.close();
  assert.equal(localOwnerLoaded(), false);
});
