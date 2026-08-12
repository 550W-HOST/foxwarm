import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import * as timers from './timers';
import {
  MAIN_MANAGEMENT_TOOL_OPERATIONS,
  createMainManagementToolServiceHandler,
  mainManagementToolServiceDescriptor,
} from './mainManagementToolService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry, type RpcTransport } from './rpc';
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
    create: timers.createWaitTimeoutTimer,
  };
  const calls: any[] = [];
  sessionManager.getAllSessions().set(sourceId, source);
  (timers as any).createWaitTimeoutTimer = async (args: any) => { calls.push(structuredClone(args)); return { id: 'timer' }; };

  try {
    assert.equal(MAIN_MANAGEMENT_TOOL_OPERATIONS.length, 20);
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
    sessionManager.getAllSessions().delete(sourceId);
    (timers as any).createWaitTimeoutTimer = originals.create;
    await resetService();
  }
});

test('bound reverse handler rejects wrong source before lookup or mutation', async () => {
  const registry = new RpcServiceRegistry();
  registry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({ expectedSourceSessionId: 'owned' }));
  const transport = new LocalRpcTransport(registry);
  const client = new RpcClient(mainManagementToolServiceDescriptor, transport);
  const originalCreate = timers.createWaitTimeoutTimer;
  let timerWrites = 0;
  sessionManager.getAllSessions().set('owned', session('owned'));
  (timers as any).createWaitTimeoutTimer = async () => { timerWrites += 1; return { id: 'timer' }; };
  try {
    await assert.rejects(() => client.call('execute', { sourceSessionId: 'wrong', operation: 'list_agents', args: {} }),
      { code: 'MAIN_MANAGEMENT_SOURCE_MISMATCH' });
    await assert.rejects(() => client.call('scheduleWaitTimeout', { sourceSessionId: 'wrong', waitId: 'w', timeoutSeconds: 1 }),
      { code: 'MAIN_MANAGEMENT_SOURCE_MISMATCH' });
    assert.equal(timerWrites, 0);
    assert.deepEqual(await client.call('scheduleWaitTimeout', { sourceSessionId: 'owned', waitId: 'w', timeoutSeconds: 1 }),
      { scheduled: true, waitId: 'w' });
    assert.equal(timerWrites, 1);
  } finally {
    sessionManager.getAllSessions().delete('owned');
    (timers as any).createWaitTimeoutTimer = originalCreate;
    await transport.drain(); transport.close();
  }
});

test('concurrent Main Management initialization locks exact placement transport', async () => {
  await resetService();
  const fake = (): RpcTransport => ({
    call: async () => ({}), subscribe: () => () => {}, drain: async () => {}, close: () => {},
  });
  const firstTransport = fake();
  const otherTransport = fake();
  try {
    const first = initializeMainManagementTools({ transport: firstTransport, placement: 'child-reverse' });
    const identical = initializeMainManagementTools({ transport: firstTransport, placement: 'child-reverse' });
    await assert.rejects(() => initializeMainManagementTools({ transport: otherTransport, placement: 'child-reverse' }),
      { code: 'MAIN_MANAGEMENT_PLACEMENT_LOCKED' });
    await Promise.all([first, identical]);
    await assert.rejects(() => initializeMainManagementTools(), { code: 'MAIN_MANAGEMENT_PLACEMENT_LOCKED' });
  } finally { await resetService(); }

  const local = initializeMainManagementTools();
  await assert.rejects(() => initializeMainManagementTools({ transport: fake(), placement: 'child-reverse' }),
    { code: 'MAIN_MANAGEMENT_PLACEMENT_LOCKED' });
  await local;
  await resetService();
});

test('accepted wait-timeout schedule drains and terminal fence rejects new calls', async () => {
  await resetService();
  const sourceId = `main_wait_drain_${Date.now()}`;
  const originals = {
    create: timers.createWaitTimeoutTimer,
  };
  sessionManager.getAllSessions().set(sourceId, session(sourceId));
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
    sessionManager.getAllSessions().delete(sourceId);
    (timers as any).createWaitTimeoutTimer = originals.create;
    if (getMainManagementToolServiceStatus().ready) await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
  }
});
