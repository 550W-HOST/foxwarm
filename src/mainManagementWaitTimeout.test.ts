import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import * as timers from './timers';
import {
  MAIN_MANAGEMENT_TOOL_OPERATIONS,
} from './mainManagementToolService';
import {
  executeMainManagementTool,
  getMainManagementToolServiceStatus,
  initializeMainManagementTools,
  resetMainManagementToolsForTests,
  scheduleMainWaitTimeout,
  shutdownMainManagementTools,
} from './mainManagementTools';
import type { Session } from './types';

function session(id: string): Session {
  return { id, agent: 'main' } as Session;
}

async function resetService(): Promise<void> {
  await shutdownMainManagementTools().catch(() => {});
  resetMainManagementToolsForTests();
}

test('named wait-timeout method validates exact DTO and does not expand model operations', async () => {
  await resetService();
  const sourceId = `main_wait_schedule_${Date.now()}`;
  const source = session(sourceId);
  const originals = {
    getExisting: sessionManager.getExistingSession,
    create: timers.createWaitTimeoutTimer,
  };
  const calls: any[] = [];
  (sessionManager as any).getExistingSession = async (id: string) => id === sourceId ? source : null;
  (timers as any).createWaitTimeoutTimer = async (args: any) => { calls.push(structuredClone(args)); return { id: 'timer' }; };

  try {
    assert.equal(MAIN_MANAGEMENT_TOOL_OPERATIONS.length, 7);
    assert.equal((MAIN_MANAGEMENT_TOOL_OPERATIONS as readonly string[]).includes('scheduleWaitTimeout'), false);
    const response = await scheduleMainWaitTimeout({ sourceSessionId: ` ${sourceId} `, waitId: ' wait-1 ', timeoutSeconds: 2.5 });
    assert.deepEqual(response, { scheduled: true, waitId: 'wait-1' });
    assert.deepEqual(calls, [{ sessionId: sourceId, waitId: 'wait-1', timeoutSeconds: 2.5 }]);

    await assert.rejects(() => scheduleMainWaitTimeout({ sourceSessionId: sourceId, waitId: 'wait', timeoutSeconds: 1, extra: true } as any),
      { code: 'MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT' });
    await assert.rejects(() => scheduleMainWaitTimeout({ sourceSessionId: sourceId, waitId: ' ', timeoutSeconds: 1 }),
      { code: 'MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT' });
    await assert.rejects(() => scheduleMainWaitTimeout({ sourceSessionId: sourceId, waitId: 'wait', timeoutSeconds: Number.NaN }),
      { code: 'MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT' });
    await assert.rejects(() => scheduleMainWaitTimeout({ sourceSessionId: 'stale-source', waitId: 'wait', timeoutSeconds: 1 }),
      { code: 'MAIN_MANAGEMENT_SOURCE_NOT_FOUND' });
    await assert.rejects(() => executeMainManagementTool('scheduleWaitTimeout' as any, {}, { sessionId: sourceId }),
      { code: 'MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED' });
    assert.equal(calls.length, 1);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (timers as any).createWaitTimeoutTimer = originals.create;
    await resetService();
  }
});

test('accepted wait-timeout schedule drains and terminal fence rejects new calls', async () => {
  await resetService();
  const sourceId = `main_wait_drain_${Date.now()}`;
  const originals = {
    getExisting: sessionManager.getExistingSession,
    create: timers.createWaitTimeoutTimer,
  };
  (sessionManager as any).getExistingSession = async () => session(sourceId);
  let enteredResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>(resolve => { releaseResolve = resolve; });
  (timers as any).createWaitTimeoutTimer = async () => {
    enteredResolve();
    await release;
    return { id: 'timer' };
  };

  try {
    await initializeMainManagementTools();
    const accepted = scheduleMainWaitTimeout({ sourceSessionId: sourceId, waitId: 'wait-drain', timeoutSeconds: 1 });
    await entered;
    let drained = false;
    const shutdown = shutdownMainManagementTools().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(drained, false);
    await assert.rejects(() => scheduleMainWaitTimeout({ sourceSessionId: sourceId, waitId: 'later', timeoutSeconds: 1 }),
      { code: 'MAIN_MANAGEMENT_SHUTDOWN' });
    releaseResolve();
    assert.deepEqual(await accepted, { scheduled: true, waitId: 'wait-drain' });
    await shutdown;
    assert.deepEqual(getMainManagementToolServiceStatus(), { placement: 'local', ready: false });
  } finally {
    releaseResolve();
    (sessionManager as any).getExistingSession = originals.getExisting;
    (timers as any).createWaitTimeoutTimer = originals.create;
    if (getMainManagementToolServiceStatus().ready) await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
  }
});
