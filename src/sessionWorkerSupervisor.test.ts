import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for condition.');
}

async function createFixture(idleMs: number, shouldRestart?: (sessionId: string) => boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-session-worker-supervisor-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite'));
  store.open();
  const supervisor = new SessionWorkerSupervisor({
    store,
    idleMs,
    restartBaseDelayMs: 20,
    restartMaxDelayMs: 50,
    shouldRestart,
  });
  supervisor.recoverStartupOwnerships();
  return {
    root,
    store,
    supervisor,
    async close() {
      await supervisor.shutdown(2_000).catch(() => {});
      store.close();
      await fs.remove(root);
    },
  };
}

test('session worker supervisor starts one process generation and confirms idle exit before replacement', async () => {
  const fixture = await createFixture(120);
  try {
    const [first, duplicate] = await Promise.all([
      fixture.supervisor.ensureWorker('idle-session'),
      fixture.supervisor.ensureWorker('idle-session'),
    ]);
    assert.equal(first.generation, 1);
    assert.equal(duplicate.pid, first.pid);
    const identity = await fixture.supervisor.callStatus('idle-session');
    assert.equal(identity.sessionId, 'idle-session');
    assert.equal(identity.generation, 1);
    assert.equal(identity.pid, first.pid);
    assert.equal(fixture.store.getOwnership('idle-session').state, 'ready');

    await waitFor(() => fixture.supervisor.getStatus('idle-session') === undefined, 4_000);
    const released = fixture.store.getOwnership('idle-session');
    assert.equal(released.state, 'inactive');
    assert.match(released.lastExitReason || '', /^stopped:/);

    const replacement = await fixture.supervisor.ensureWorker('idle-session');
    assert.equal(replacement.generation, 2);
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(await fixture.supervisor.stopWorker('idle-session', 2_000), true);
    assert.equal(fixture.store.getOwnership('idle-session').state, 'inactive');
  } finally {
    await fixture.close();
  }
});

test('session worker supervisor restarts only after an unexpected child exit is observed', async () => {
  const fixture = await createFixture(5_000, sessionId => sessionId === 'restart-session');
  try {
    const first = await fixture.supervisor.ensureWorker('restart-session');
    assert.ok(first.pid);
    process.kill(first.pid!, 'SIGKILL');

    await waitFor(() => {
      const status = fixture.supervisor.getStatus('restart-session');
      return !!status?.ready && status.generation === 2 && status.pid !== first.pid;
    }, 5_000);
    const replacement = fixture.supervisor.getStatus('restart-session')!;
    assert.equal(replacement.generation, 2);
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(fixture.store.getOwnership('restart-session').workerPid, replacement.pid);
    assert.equal(await fixture.supervisor.stopWorker('restart-session', 2_000), true);
  } finally {
    await fixture.close();
  }
});
