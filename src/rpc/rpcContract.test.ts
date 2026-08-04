import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
  LocalRpcTransport,
  ProcessRpcClientTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
  RpcTransport,
} from './index';
import { rpcTestHandler, rpcTestService } from './rpcTestService';

async function runContract(name: string, createTransport: () => Promise<RpcTransport>): Promise<void> {
  await test(`${name}: DTO cloning, errors, events, cancellation, and drain`, async () => {
    const transport = await createTransport();
    const client = new RpcClient(rpcTestService, transport);
    try {
      const request = { nested: { value: 7 } };
      const response = await client.call('echo', request);
      assert.deepEqual(request, { nested: { value: 7 } });
      assert.deepEqual(response, { nested: { value: 8 }, handlerSaw: 7 });

      await assert.rejects(client.call('echo', { nested: { value: (() => 1) as any } }), (error: any) => {
        assert.equal(error.code, 'RPC_INVALID_DTO');
        return true;
      });

      await assert.rejects(client.call('fail', { code: 'EXPECTED' }), (error: any) => {
        assert.equal(error.code, 'EXPECTED');
        assert.equal(error.retryable, true);
        assert.deepEqual(error.details, { safe: true });
        return true;
      });

      const event = new Promise<{ value: string }>((resolve) => {
        const unsubscribe = client.subscribe((eventName, payload) => {
          if (eventName === 'progress') {
            unsubscribe();
            resolve(payload);
          }
        });
      });
      assert.deepEqual(await client.call('publish', { value: 'hello' }), { accepted: true });
      assert.deepEqual(await event, { value: 'hello' });

      const controller = new AbortController();
      const waiting = client.call('wait', { delayMs: 5_000 }, { signal: controller.signal });
      controller.abort(new RpcError('TEST_ABORT', 'test abort', true));
      await assert.rejects(waiting, (error: any) => error.code === 'TEST_ABORT');

      await transport.drain();
      await assert.rejects(client.call('echo', { nested: { value: 1 } }), (error: any) => error.code === 'RPC_DRAINING');
    } finally {
      await transport.close();
    }
  });
}

void runContract('local transport', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(rpcTestService, rpcTestHandler);
  return new LocalRpcTransport(registry, { processGeneration: 11 });
});

void runContract('child-process transport', async () => {
  const generation = 12;
  const child = fork(path.join(__dirname, 'rpcTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_TEST_GENERATION: String(generation) },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, { generation });
  await transport.waitUntilReady();
  return transport;
});
