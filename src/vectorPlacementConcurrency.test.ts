import test from 'node:test';
import assert from 'node:assert/strict';
import type { RpcTransport } from './rpc';
import * as vector from './vector';

test('vector initialization serializes exact owned and borrowed placement identities', async () => {
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
  let factoryCalls = 0; let startCalls = 0; let shutdownCalls = 0;
  vector.setVectorServiceManagerFactoryForTests(async () => {
    factoryCalls += 1;
    await factoryGate;
    return {
      async start() { startCalls += 1; },
      async shutdown() { shutdownCalls += 1; },
      getStatus() { return { mode: 'local', ready: true }; },
      getClient() { throw new Error('not used'); },
    } as any;
  });
  try {
    const first = vector.init({ useWorker: false });
    const same = vector.init({ useWorker: false });
    await assert.rejects(() => vector.init({ useWorker: true }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    const borrowed = { call: async () => ({}), subscribe: () => () => {}, drain: async () => {}, close: () => {} } as RpcTransport;
    await assert.rejects(() => vector.init({ transport: borrowed, placement: 'child-reverse' }),
      { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    assert.equal(factoryCalls, 1);
    releaseFactory();
    await Promise.all([first, same]);
    assert.equal(factoryCalls, 1);
    assert.equal(startCalls, 1);
    await assert.rejects(() => vector.init({ useWorker: true }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await vector.shutdown();
    assert.equal(shutdownCalls, 1);

    const otherBorrowed = { ...borrowed } as RpcTransport;
    await vector.init({ transport: borrowed, placement: 'child-reverse' });
    await vector.init({ transport: borrowed, placement: 'child-reverse' });
    await assert.rejects(() => vector.init({ transport: otherBorrowed, placement: 'child-reverse' }),
      { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await assert.rejects(() => vector.init({ useWorker: false }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await vector.shutdown();
  } finally {
    vector.setVectorServiceManagerFactoryForTests();
  }
});
