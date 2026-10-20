import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import * as timers from './timers';
import * as tools from './tools';
import { DATA_ROOT_DIR, STATE_DIR } from './config';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import { SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import type { Session } from './types';
import { getSessionHistoryFilePath } from './session/metadataStore';
import { INTER_AGENT_HANDOFF_RECALL_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX } from './toolCallControls';

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${label}`);
}

test('registered Worker timers use exact process owner, cooperative busy safe points and reverse self-delivery', { timeout: 45000 }, async () => {
  const id = `timer-worker-${Date.now()}`;
  const owner = await sessionManager.getSession(id);
  await sessionManager.saveSession(owner);
  const stub: Session = { ...owner, history: [], queue: [], persistentMemorySnapshot: '' };
  sessionManager.getAllSessions().set(id, stub);
  const store = new SessionWorkerStore(path.join(STATE_DIR, 'timer-worker.sqlite')); store.open();
  const supervisor = new SessionWorkerSupervisor({
    store, idleMs: 60000,
    workerScriptPath: path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'),
    workerEnv: { FOXWARM_DATA_DIR: DATA_ROOT_DIR, FOXWARM_TEST_TIMER_SAFEPOINT: '1' },
  });
  await supervisor.reconcileStartupOwnerships();
  const ingress = new SessionWorkerIngressCoordinator(store, supervisor, key => key,
    key => !!sessionManager.getSessionCatalog(key));
  await sessionRuntime.initializeSessionRuntime({ worker: { store, registry: supervisor.projectionRegistry, ingress, supervisor } });
  sessionManager.setSessionWorkerEnqueueSink(async (key, item, options, assertAdmission) => {
    await ingress.enqueueEnsuringWorker(key, item, options, assertAdmission);
  });
  sessionManager.setSessionWorkerFenceChecker(key => {
    const ownership = store.findOwnership(key); return !!ownership && ownership.state !== 'inactive';
  });
  timers.setTimersStoreForTests(timers.createTimersStore(path.join(STATE_DIR, 'test-timers.json')));
  const ctx = { sessionId: id, session: stub };
  const quietOutput = path.join(STATE_DIR, 'quiet-worker-check');
  let busy: Promise<unknown> | undefined;
  let tick: Promise<void> | undefined;
  try {
    await tools.callTool('create_timer', { action: 'toolscript', afterSeconds: 3600,
      script: { code: 'return call_tool("write", args)', args: { filePath: quietOutput, content: 'worker checked' } } }, ctx);
    const quiet = timers.listTimers(id)[0];
    await timers.fireTimerForTests(quiet.id);
    assert.equal(await fs.readFile(quietOutput, 'utf8'), 'worker checked');
    assert.equal((await fs.readJson(getSessionHistoryFilePath(id))).history.length, 0);
    assert.equal(stub.history.length, 0);
    assert.ok(supervisor.getStatus(id)?.ready, 'inactive owner was spawned, not hydrated in Main');

    busy = ingress.submitEnsuringWorker(id, { type: 'user', parts: [{ text: 'hold a multistep owner turn' }] });
    await waitFor(() => fs.pathExists(path.join(STATE_DIR, 'timer-provider-1-started')), 'first provider');
    const send = {
      sessionId: id,
      handoffRecall: `${INTER_AGENT_HANDOFF_RECALL_PREFIX}\nThe monitor reports its requested actionable condition to the owning Session.`,
      message: 'WORKER_TIMER_ALERT',
      afterSend: 'finish',
      handoffConfirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\nThe condition merits one owner notification; this is not an acknowledgement or duplicate.\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`,
    };
    const busyOutput = path.join(STATE_DIR, 'busy-worker-check');
    await tools.callTool('create_timer', { action: 'toolscript', afterSeconds: 3600,
      script: { code: 'call_tool("write", args["write"])\nreturn call_tool("send_to_session", args["send"])',
        args: { write: { filePath: busyOutput, content: 'busy check' }, send } } }, ctx);
    let tickSettled = false;
    tick = timers.fireTimerForTests(timers.listTimers(id)[0].id).then(() => { tickSettled = true; });
    // The current provider await has no owner mutation safe point yet.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(tickSettled, false);
    await fs.writeFile(path.join(STATE_DIR, 'timer-provider-1-release'), '1');
    await tick;
    assert.equal(await fs.readFile(busyOutput, 'utf8'), 'busy check');
    await waitFor(() => fs.pathExists(path.join(STATE_DIR, 'timer-provider-2-started')), 'second provider while timer already completed');
    const current = await fs.readJson(getSessionHistoryFilePath(id));
    assert.equal(current.busy, true, 'script afterSend finish did not finish the model lifecycle');
    assert.ok(JSON.stringify(current).includes('WORKER_TIMER_ALERT'));
    assert.doesNotMatch(JSON.stringify(current), /replyTargetSessionId.*WORKER_TIMER_ALERT/);
    assert.equal(stub.history.length, 0, 'Main remained catalog-only');
    await fs.writeFile(path.join(STATE_DIR, 'timer-provider-2-release'), '1');
    await busy;
    const final = await fs.readJson(getSessionHistoryFilePath(id));
    assert.equal(final.busy, false);
    assert.equal(JSON.stringify(final.history).split('WORKER_TIMER_ALERT').length - 1, 1);
    assert.equal(final.history.some((row: any) => row.parts?.some((part: any) => part.functionCall?.name === 'run_script')), false);
  } finally {
    await fs.writeFile(path.join(STATE_DIR, 'timer-provider-1-release'), '1');
    await fs.writeFile(path.join(STATE_DIR, 'timer-provider-2-release'), '1');
    await Promise.allSettled([busy, tick]);
    await timers.shutdownTimers();
    timers.resetTimersForTests();
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    sessionManager.setSessionWorkerFenceChecker(undefined);
    await supervisor.shutdown(5000);
    await sessionRuntime.shutdownSessionRuntime();
    store.close();
    sessionManager.getAllSessions().delete(id);
  }
});
