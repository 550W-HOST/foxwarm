import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_RPC_BUILD_ID, ProcessRpcClientTransport, ProcessRpcServer, RPC_PROTOCOL_VERSION, RpcClient, RpcError, RpcServiceRegistry } from './index';
import { rpcTestHandler, rpcTestService } from './rpcTestService';

function waitForMessage(child: ChildProcess, predicate: (message: any) => boolean, timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for reverse RPC test child.')); }, timeoutMs);
    const onMessage = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onExit = () => { cleanup(); reject(new Error('Reverse RPC test child exited.')); };
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage); child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

test('reverse process RPC preserves unary contract, bounds, cancellation, drain, and errors', async () => {
  let activeStarted!: () => void;
  let activeStartedPromise = new Promise<void>(resolve => { activeStarted = resolve; });
  const registry = new RpcServiceRegistry();
  registry.register(rpcTestService, {
    ...rpcTestHandler,
    async wait(input, context) { activeStarted(); return rpcTestHandler.wait(input, context); },
  });
  const child = fork(path.join(__dirname, 'rpcReverseTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_GENERATION: '7', FOXWARM_RPC_MAX_PENDING: '1' }, serialization: 'advanced',
  });
  const server = new ProcessRpcServer(registry, { generation: 7, peer: child, direction: 'reverse', exitOnDisconnect: false });
  server.start();
  let nextId = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const id = String(++nextId);
    const result = waitForMessage(child, message => message?.kind === 'reverse-test-result' && message.id === id);
    child.send({ kind: 'reverse-test-command', id, name, ...args });
    return result;
  };
  try {
    await waitForMessage(child, message => message?.kind === 'reverse-test-ready');
    const echo = await call('echo', { value: 4 });
    assert.deepEqual(echo.result, { nested: { value: 5 }, handlerSaw: 4 });
    const failed = await call('fail', { code: 'EXPECTED_REVERSE' });
    assert.deepEqual(failed.error, { code: 'EXPECTED_REVERSE', message: 'expected failure', retryable: true, details: { safe: { value: 1 } } });
    failed.error.details.safe.value = 99;
    assert.equal((await call('fail', { code: 'EXPECTED_REVERSE' })).error.details.safe.value, 1);
    assert.equal((await call('deadline', { delayMs: 100, timeoutMs: 10 })).error.code, 'RPC_DEADLINE_EXCEEDED');
    assert.equal((await call('cancel', { delayMs: 100, cancelAfterMs: 10 })).error.code, 'TEST_CANCEL');
    const pressure = await call('backpressure', { delayMs: 30 });
    assert.equal(pressure.result.second.code, 'RPC_BACKPRESSURE');
    assert.deepEqual(pressure.result.first, { completed: true });
    assert.equal((await call('event')).error.code, 'RPC_EVENTS_UNSUPPORTED');

    activeStartedPromise = new Promise<void>(resolve => { activeStarted = resolve; });
    const accepted = call('wait', { delayMs: 40 });
    await activeStartedPromise;
    await server.drain(1_000);
    assert.deepEqual((await accepted).result, { completed: true });
    assert.equal((await call('echo', { value: 1 })).error.code, 'RPC_DRAINING');
  } finally { server.close(); await stopChild(child); }
});

test('reverse readiness retries until a late Main listener starts and then stops announcing', async () => {
  const child = fork(path.join(__dirname, 'rpcReverseTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_GENERATION: '12', FOXWARM_RPC_READY_TIMEOUT_MS: '2000' }, serialization: 'advanced',
  });
  let initCount = 0;
  let firstInitResolve!: () => void;
  const firstInit = new Promise<void>(resolve => { firstInitResolve = resolve; });
  child.on('message', message => {
    if ((message as any)?.kind === 'rpc-reverse-init') { initCount += 1; if (initCount === 1) firstInitResolve(); }
  });
  const ready = waitForMessage(child, message => message?.kind === 'reverse-test-ready');
  void ready.catch(() => {});
  let server: ProcessRpcServer | undefined;
  try {
    await firstInit;
    await new Promise(resolve => setTimeout(resolve, 300));
    const registry = new RpcServiceRegistry(); registry.register(rpcTestService, rpcTestHandler);
    server = new ProcessRpcServer(registry, { generation: 12, peer: child, direction: 'reverse', exitOnDisconnect: false });
    server.start();
    await ready;
    await new Promise(resolve => setTimeout(resolve, 100));
    const settledCount = initCount;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(initCount, settledCount);
  } finally { server?.close(); await stopChild(child); }
});

test('reverse process RPC rejects generation mismatch and aborts accepted calls on close', async () => {
  const protocolMismatch = fork(path.join(__dirname, 'rpcReverseTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_GENERATION: '15', FOXWARM_RPC_READY_TIMEOUT_MS: '2000' }, serialization: 'advanced',
  });
  let protocolInitCount = 0;
  protocolMismatch.on('message', message => { if ((message as any)?.kind === 'rpc-reverse-init') protocolInitCount += 1; });
  const protocolRegistry = new RpcServiceRegistry(); protocolRegistry.register(rpcTestService, rpcTestHandler);
  const protocolServer = new ProcessRpcServer(protocolRegistry, {
    generation: 15, buildId: 'mismatched-build', peer: protocolMismatch, direction: 'reverse', exitOnDisconnect: false,
  });
  protocolServer.start();
  try {
    const result = await waitForMessage(protocolMismatch, message => message?.kind === 'reverse-test-start-error');
    assert.equal(result.error.code, 'RPC_PROTOCOL_MISMATCH');
    const settledCount = protocolInitCount;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(protocolInitCount, settledCount);
  } finally { protocolServer.close(); await stopChild(protocolMismatch); }

  const mismatch = fork(path.join(__dirname, 'rpcReverseTestChild.js'), [], {
    env: { ...process.env, FOXWARM_RPC_GENERATION: '2', FOXWARM_RPC_READY_TIMEOUT_MS: '50' }, serialization: 'advanced',
  });
  const mismatchRegistry = new RpcServiceRegistry(); mismatchRegistry.register(rpcTestService, rpcTestHandler);
  const mismatchServer = new ProcessRpcServer(mismatchRegistry, { generation: 1, peer: mismatch, direction: 'reverse', exitOnDisconnect: false });
  mismatchServer.start();
  let mismatchInitCount = 0;
  mismatch.on('message', message => { if ((message as any)?.kind === 'rpc-reverse-init') mismatchInitCount += 1; });
  try {
    const result = await waitForMessage(mismatch, message => message?.kind === 'reverse-test-start-error');
    assert.equal(result.error.code, 'RPC_READY_TIMEOUT');
    const settledCount = mismatchInitCount;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(mismatchInitCount, settledCount);
  } finally { mismatchServer.close(); await stopChild(mismatch); }

  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const registry = new RpcServiceRegistry();
  registry.register(rpcTestService, { ...rpcTestHandler, async wait(input, context) { started(); return rpcTestHandler.wait(input, context); } });
  const child = fork(path.join(__dirname, 'rpcReverseTestChild.js'), [], { env: { ...process.env, FOXWARM_RPC_GENERATION: '3' }, serialization: 'advanced' });
  const server = new ProcessRpcServer(registry, { generation: 3, peer: child, direction: 'reverse', exitOnDisconnect: false }); server.start();
  try {
    await waitForMessage(child, message => message?.kind === 'reverse-test-ready');
    const resultPromise = waitForMessage(child, message => message?.kind === 'reverse-test-result' && message.id === 'wait');
    child.send({ kind: 'reverse-test-command', id: 'wait', name: 'wait', delayMs: 1_000 });
    await startedPromise;
    server.close(new RpcError('TEST_REVERSE_CLOSED', 'reverse server closed', true));
    const result = await resultPromise;
    assert.equal(result.error.code, 'TEST_REVERSE_CLOSED');
  } finally { server.close(); await stopChild(child); }
});

test('reverse client rejects outstanding calls on IPC disconnect and exit', async () => {
  for (const terminal of ['disconnect', 'exit'] as const) {
    class FakePeer extends EventEmitter {
      connected = true;
      send(_message: unknown, callback?: (error: Error | null) => void) { callback?.(null); }
    }
    const peer = new FakePeer();
    const transport = new ProcessRpcClientTransport(peer as any, { generation: 9, direction: 'reverse' });
    peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: 1, buildId: 'foxwarm-1.0.0', generation: 9,
      services: [{ name: rpcTestService.name, version: rpcTestService.version }] });
    const pending = new RpcClient(rpcTestService, transport).call('wait', { delayMs: 1_000 });
    if (terminal === 'disconnect') peer.emit('disconnect');
    else peer.emit('exit', 1, null);
    await assert.rejects(() => pending, (error: any) => error?.code === 'RPC_UNAVAILABLE');
    transport.close();
    assert.equal(peer.listenerCount('message'), 0);
  }

  class ClosingPeer extends EventEmitter {
    connected = true; sends = 0;
    send(_message: unknown, callback?: (error: Error | null) => void) { this.sends += 1; callback?.(null); }
  }
  const closingPeer = new ClosingPeer();
  const closingTransport = new ProcessRpcClientTransport(closingPeer as any, { generation: 10, direction: 'reverse' });
  const closingReady = closingTransport.waitUntilReady();
  closingTransport.close();
  await assert.rejects(() => closingReady, { code: 'RPC_CLOSED' });
  const sendsAtClose = closingPeer.sends;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(closingPeer.sends, sendsAtClose);
  assert.equal(closingPeer.listenerCount('message'), 0);
});

test('ready protocol mismatch is terminal and cannot be rehabilitated', async () => {
  class FakePeer extends EventEmitter {
    connected = true; sends = 0;
    send(_message: unknown, callback?: (error: Error | null) => void) { this.sends += 1; callback?.(null); }
  }
  const peer = new FakePeer();
  const transport = new ProcessRpcClientTransport(peer as any, { generation: 20, direction: 'reverse', readyTimeoutMs: 1_000 });
  const firstReady = transport.waitUntilReady();
  peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: RPC_PROTOCOL_VERSION, buildId: 'wrong-build',
    generation: 20, services: [{ name: rpcTestService.name, version: rpcTestService.version }] });
  await assert.rejects(() => firstReady, { code: 'RPC_PROTOCOL_MISMATCH' });
  const sendsAfterMismatch = peer.sends;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(peer.sends, sendsAfterMismatch);
  assert.equal(peer.listenerCount('message'), 0);

  peer.emit('message', { kind: 'rpc-reverse-ready', protocolVersion: RPC_PROTOCOL_VERSION, buildId: DEFAULT_RPC_BUILD_ID,
    generation: 20, services: [{ name: rpcTestService.name, version: rpcTestService.version }] });
  await assert.rejects(() => transport.waitUntilReady(), { code: 'RPC_PROTOCOL_MISMATCH' });
  await assert.rejects(() => new RpcClient(rpcTestService, transport).call('echo', { nested: { value: 1 } }),
    { code: 'RPC_PROTOCOL_MISMATCH' });
  await assert.rejects(() => transport.drain(), { code: 'RPC_PROTOCOL_MISMATCH' });
  transport.close(); transport.close();
  assert.equal(peer.listenerCount('message'), 0);
});
