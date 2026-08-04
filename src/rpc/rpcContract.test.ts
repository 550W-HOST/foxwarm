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
        assert.deepEqual(error.details, { safe: { value: 1 } });
        error.details.safe.value = 99;
        return true;
      });
      await assert.rejects(client.call('fail', { code: 'EXPECTED_AGAIN' }), (error: any) => {
        assert.deepEqual(error.details, { safe: { value: 1 } });
        return true;
      });
      await assert.rejects(client.call('plainFail', {}), (error: any) => {
        assert.equal(error.name, 'RpcError');
        assert.equal(error.code, 'RPC_HANDLER_ERROR');
        assert.equal(error.message, 'plain handler failure');
        assert.equal(error.retryable, false);
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
      const abortReason = new RpcError('TEST_ABORT', 'test abort', true);
      controller.abort(abortReason);
      await assert.rejects(waiting, (error: any) => error === abortReason);

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

test('child-process transport rejects an incompatible build before readiness', async () => {
  const generation = 77;
  const child = fork(path.join(__dirname, 'rpcTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_TEST_GENERATION: String(generation) },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, {
    generation,
    buildId: 'intentionally-incompatible-build',
    readyTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(
      transport.waitUntilReady(),
      (error: any) => error?.code === 'RPC_PROTOCOL_MISMATCH',
    );
  } finally {
    await transport.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

test('process invalid DTO attempts do not consume bounded pending capacity', async () => {
  const generation = 78;
  const child = fork(path.join(__dirname, 'rpcTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_TEST_GENERATION: String(generation) },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, { generation, maxPendingRequests: 1 });
  const client = new RpcClient(rpcTestService, transport);
  try {
    await transport.waitUntilReady();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        client.call('echo', { nested: { value: (() => attempt) as any } }),
        (error: any) => error?.code === 'RPC_INVALID_DTO',
      );
    }
    assert.deepEqual(await client.call('echo', { nested: { value: 2 } }), {
      nested: { value: 3 },
      handlerSaw: 2,
    });
    await transport.drain();
  } finally {
    await transport.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

test('local transport enforces the same bounded request cap', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(rpcTestService, rpcTestHandler);
  const transport = new LocalRpcTransport(registry, { maxPendingRequests: 1 });
  const client = new RpcClient(rpcTestService, transport);
  const controller = new AbortController();
  const waiting = client.call('wait', { delayMs: 5_000 }, { signal: controller.signal });
  await assert.rejects(
    client.call('echo', { nested: { value: 1 } }),
    (error: any) => error?.code === 'RPC_BACKPRESSURE',
  );
  controller.abort(new RpcError('TEST_DONE', 'test complete', true));
  await assert.rejects(waiting, (error: any) => error?.code === 'TEST_DONE');
  await transport.drain();
  await transport.close();
});

test('parent IPC disconnect aborts acceptance and bounds child cleanup before exit', async () => {
  const generation = 79;
  const child = fork(path.join(__dirname, 'rpcTestChild.js'), [], {
    env: {
      ...process.env,
      FOXWARM_RPC_TEST_GENERATION: String(generation),
      FOXWARM_RPC_TEST_HANG_CLEANUP: '1',
    },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, { generation });
  const client = new RpcClient(rpcTestService, transport);
  try {
    await transport.waitUntilReady();
    const disconnected = new Promise<void>(resolve => child.once('disconnect', () => resolve()));
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not exit after parent disconnect.')), 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.disconnect();
    await disconnected;
    await assert.rejects(
      client.call('echo', { nested: { value: 1 } }),
      (error: any) => error?.code === 'RPC_UNAVAILABLE',
    );
    await exited;
  } finally {
    await transport.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
