import test from 'node:test';
import assert from 'node:assert/strict';
import type { RpcTransport } from './rpc';
import * as vector from './vector';

test('disabled vector placement loads no owner and gives cheap best-effort no-ops', async () => {
  let factoryCalls = 0;
  vector.setVectorServiceManagerFactoryForTests(async () => {
    factoryCalls += 1;
    throw new Error('disabled vector must not create a manager');
  });
  try {
    await vector.init({ enabled: false, useWorker: true });
    assert.deepEqual(vector.getVectorServiceStatus(), { mode: 'disabled', ready: false });
    assert.equal(factoryCalls, 0);
    assert.equal(await vector.scheduleSessionArchiveIndex('disabled-session', 10, 100, 2), 0);
    assert.equal(await vector.indexMemoryFactsFromCompaction({
      sessionId: 'disabled-session', facts: [], sourceStartSeq: 1, sourceEndSeq: 1, blockId: 1, blockLevel: 1,
    }), 0);
    await vector.renameSessionArchiveIndex('old', 'new');
    await vector.copySessionArchiveIndexCheckpoint('old', 'new');
    await assert.rejects(() => vector.search('disabled'), (error: any) =>
      error?.code === 'VECTOR_DISABLED' && error?.retryable === false && /disabled by configuration/i.test(error.message));
    await assert.rejects(() => vector.indexSessionArchive('disabled-session'), { code: 'VECTOR_DISABLED' });
    assert.equal(Object.keys(require.cache).some(file => /vector(ServiceManager|Runtime)\.js$/.test(file)), false);
    await vector.shutdown();
  } finally {
    vector.setVectorServiceManagerFactoryForTests();
  }
});

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
    const first = vector.init({ enabled: true, useWorker: false });
    const same = vector.init({ enabled: true, useWorker: false });
    await assert.rejects(() => vector.init({ enabled: true, useWorker: true }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    const borrowed = { call: async () => ({}), subscribe: () => () => {}, drain: async () => {}, close: () => {} } as RpcTransport;
    await assert.rejects(() => vector.init({ transport: borrowed, placement: 'child-reverse' }),
      { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    assert.equal(factoryCalls, 1);
    releaseFactory();
    await Promise.all([first, same]);
    assert.equal(factoryCalls, 1);
    assert.equal(startCalls, 1);
    await assert.rejects(() => vector.init({ enabled: true, useWorker: true }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await vector.shutdown();
    assert.equal(shutdownCalls, 1);

    const otherBorrowed = { ...borrowed } as RpcTransport;
    await vector.init({ transport: borrowed, placement: 'child-reverse' });
    await vector.init({ transport: borrowed, placement: 'child-reverse' });
    await assert.rejects(() => vector.init({ transport: otherBorrowed, placement: 'child-reverse' }),
      { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await assert.rejects(() => vector.init({ enabled: true, useWorker: false }), { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
    await vector.shutdown();
  } finally {
    vector.setVectorServiceManagerFactoryForTests();
  }
});
