import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { RpcTransport } from './rpc';
import { logger } from './common';
import { VectorServiceManager } from './vectorServiceManager';

const originalWarn = logger.warn;
const originalError = logger.error;
test.before(() => {
  logger.warn = (() => {}) as typeof logger.warn;
  logger.error = (() => {}) as typeof logger.error;
});
test.after(() => {
  logger.warn = originalWarn;
  logger.error = originalError;
});

class FakeChild extends EventEmitter {
  readonly pid = 424242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  confirmExit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

function makeTransport(options: { drainError?: Error } = {}): RpcTransport & { closed: number; drained: number } {
  return {
    closed: 0,
    drained: 0,
    async call() { throw new Error('not used'); },
    subscribe() { return () => {}; },
    async drain() {
      this.drained += 1;
      if (options.drainError) throw options.drainError;
    },
    close() { this.closed = 1; },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for fake lifecycle transition.');
}

test('worker shutdown survives drain failure and retains ownership through SIGTERM/SIGKILL exit confirmation', async () => {
  const manager = new VectorServiceManager({ useWorker: true }) as any;
  const child = new FakeChild();
  const transport = makeTransport({ drainError: new Error('injected drain timeout') });
  manager.mode = 'worker';
  manager.child = child as unknown as ChildProcess;
  manager.transport = transport;
  manager.client = {};
  manager.startPromise = Promise.resolve();
  child.once('exit', (code, signal) => manager.handleWorkerExit(child, transport, code, signal));

  const shuttingDown = manager.shutdown(200);
  await waitUntil(() => child.signals.includes('SIGTERM'));
  assert.equal(manager.getStatus().pid, child.pid, 'ownership must remain through SIGTERM wait');
  await waitUntil(() => child.signals.includes('SIGKILL'));
  assert.equal(manager.getStatus().pid, child.pid, 'ownership must remain until SIGKILL exit confirmation');
  child.confirmExit('SIGKILL');
  await shuttingDown;

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(transport.drained, 1);
  assert.equal(transport.closed, 1);
  assert.equal(manager.getStatus().pid, undefined);
});

test('worker IPC disconnect marks unavailable but replacement scheduling waits for exit', () => {
  const manager = new VectorServiceManager({ useWorker: true }) as any;
  const child = new FakeChild();
  const transport = makeTransport();
  let restartSchedules = 0;
  manager.mode = 'worker';
  manager.child = child as unknown as ChildProcess;
  manager.transport = transport;
  manager.client = {};
  manager.startPromise = Promise.resolve();
  manager.scheduleRestart = () => { restartSchedules += 1; };

  manager.handleWorkerDisconnect(child, transport);
  assert.equal(manager.getStatus().ready, false);
  assert.equal(manager.getStatus().pid, child.pid);
  assert.equal(restartSchedules, 0);

  manager.handleWorkerExit(child, transport, 1, null);
  assert.equal(manager.getStatus().pid, undefined);
  assert.equal(restartSchedules, 1);
});

test('worker shutdown reports unconfirmed exit without releasing ownership', async () => {
  const manager = new VectorServiceManager({ useWorker: true }) as any;
  const child = new FakeChild();
  const transport = makeTransport({ drainError: new Error('injected drain timeout') });
  manager.mode = 'worker';
  manager.child = child as unknown as ChildProcess;
  manager.transport = transport;
  manager.client = {};
  manager.startPromise = Promise.resolve();

  await assert.rejects(
    manager.shutdown(20),
    (error: any) => error?.code === 'VECTOR_WORKER_EXIT_UNCONFIRMED',
  );
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(manager.getStatus().pid, child.pid, 'failed exit confirmation must preserve ownership');
});
