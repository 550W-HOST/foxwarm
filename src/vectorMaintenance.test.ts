import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FairTableOperationGate,
  VectorMaintenanceCoordinator,
} from './vectorMaintenance';

function controllable<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for maintenance test transition.');
}

test('fair table gate drains existing operations and prevents later operations from bypassing maintenance', async () => {
  const gate = new FairTableOperationGate();
  const firstRelease = controllable();
  const secondRelease = controllable();
  const exclusiveRelease = controllable();
  const order: string[] = [];

  const first = gate.runRegular(async () => {
    order.push('regular-1-start');
    await firstRelease.promise;
    order.push('regular-1-end');
  });
  const second = gate.runRegular(async () => {
    order.push('regular-2-start');
    await secondRelease.promise;
    order.push('regular-2-end');
  });
  await waitUntil(() => order.length === 2);

  const exclusive = gate.runExclusive(async () => {
    order.push('exclusive-start');
    await exclusiveRelease.promise;
    order.push('exclusive-end');
  });
  const later = gate.runRegular(async () => {
    order.push('regular-later');
  });

  firstRelease.resolve();
  await first;
  assert.equal(order.includes('exclusive-start'), false, 'maintenance must wait for every existing operation');
  secondRelease.resolve();
  await waitUntil(() => order.includes('exclusive-start'));
  assert.equal(order.includes('regular-later'), false, 'later operations must not jump over pending maintenance');

  exclusiveRelease.resolve();
  await Promise.all([second, exclusive, later]);
  assert.deepEqual(order, [
    'regular-1-start',
    'regular-2-start',
    'regular-1-end',
    'regular-2-end',
    'exclusive-start',
    'exclusive-end',
    'regular-later',
  ]);
});

test('maintenance coordinator keeps the first mutation deadline fixed while later work coalesces', async () => {
  let now = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimeoutFn = ((callback: () => void, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + delay, callback });
    return { id, unref() {} };
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((handle: { id?: number }) => {
    if (handle?.id !== undefined) timers.delete(handle.id);
  }) as unknown as typeof clearTimeout;
  const advanceTo = async (target: number) => {
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    now = target;
  };
  const calls: string[][] = [];
  const coordinator = new VectorMaintenanceCoordinator({
    enabled: true,
    mutationCheckEvery: 1,
    delayMs: 60,
    periodicMs: 10_000,
    retryMs: 20,
    runCheck: async triggers => { calls.push(triggers); },
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
  });

  coordinator.recordMutation();
  assert.deepEqual([...timers.values()].map(timer => timer.at), [1_060]);
  await advanceTo(1_059);
  coordinator.recordMutation();
  coordinator.request('periodic');
  assert.deepEqual([...timers.values()].map(timer => timer.at), [1_060]);
  assert.equal(calls.length, 0);
  await advanceTo(1_060);
  assert.deepEqual(calls, [['mutation-threshold', 'periodic']]);
  await coordinator.shutdown();
});

test('maintenance coordinator retries failure and shutdown awaits an active check without starting timers afterward', async () => {
  const active = controllable();
  let attempts = 0;
  let errors = 0;
  const coordinator = new VectorMaintenanceCoordinator({
    enabled: true,
    mutationCheckEvery: 1,
    delayMs: 0,
    periodicMs: 10_000,
    retryMs: 10,
    runCheck: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('injected maintenance failure');
      await active.promise;
    },
    onError: () => { errors += 1; },
  });

  await coordinator.runStartupCheck();
  assert.equal(errors, 1);
  await waitUntil(() => attempts === 2);
  let shutdownDone = false;
  const shuttingDown = coordinator.shutdown().then(() => { shutdownDone = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(shutdownDone, false, 'shutdown must await the in-flight retry');
  active.resolve();
  await shuttingDown;
  assert.equal(attempts, 2);
});

test('installed Lance optimize compacts a temporary fragmented table without changing rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-maintenance-'));
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(root);
  let table: any;
  try {
    table = await db.createTable('maintenance', [{ id: 0, vector: [0, 1], text: 'seed' }]);
    for (let id = 1; id <= 32; id += 1) {
      await table.add([{ id, vector: [id, id + 1], text: `row-${id}` }]);
    }
    const beforeRows = await table.countRows();
    const before = await table.stats();
    const result = await table.optimize({
      cleanupOlderThan: new Date(Date.now() - (24 * 60 * 60_000)),
    });
    const afterRows = await table.countRows();
    const after = await table.stats();

    assert.equal(afterRows, beforeRows);
    assert.ok(result.compaction.fragmentsRemoved > 0);
    assert.ok(after.fragmentStats.numFragments < before.fragmentStats.numFragments);
  } finally {
    table?.close?.();
    db.close?.();
    await fs.remove(root);
  }
});
