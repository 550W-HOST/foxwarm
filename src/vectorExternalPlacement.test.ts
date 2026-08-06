import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcError, type RpcTransport } from './rpc';
import * as vector from './vector';

test('borrowed vector placement never falls back to a local owner when service is missing', async () => {
  let drainCalls = 0; let closeCalls = 0; let callCount = 0;
  const transport: RpcTransport = {
    async call() { callCount += 1; throw new RpcError('RPC_SERVICE_UNAVAILABLE', 'vector service missing', true); },
    subscribe: () => () => {},
    async drain() { drainCalls += 1; },
    close() { closeCalls += 1; },
  };
  const localOwnerLoaded = () => Object.keys(require.cache).some(file => /vector(Runtime|ServiceManager)\.js$/.test(file));
  assert.equal(localOwnerLoaded(), false);
  await vector.init({ transport, placement: 'child-reverse' });
  await assert.rejects(() => vector.search('missing service'), { code: 'VECTOR_UNAVAILABLE' });
  assert.equal(callCount, 1);
  assert.equal(localOwnerLoaded(), false);
  await vector.shutdown();
  assert.equal(drainCalls, 0);
  assert.equal(closeCalls, 0);
  await assert.rejects(() => vector.init({ useWorker: false }), { code: 'VECTOR_SHUTTING_DOWN' });
});
