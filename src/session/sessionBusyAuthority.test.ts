import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runChild(dataDir: string, script: string): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, FOXWARM_DATA_DIR: dataDir },
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const resultLine = stdout.trim().split('\n').find(line => line.startsWith('RESULT_JSON '));
  assert.ok(resultLine, `child process did not report result JSON. stdout:\n${stdout}`);
  return JSON.parse(resultLine.slice('RESULT_JSON '.length));
}

function childModulePaths(): { sessionManager: string; sessionHistory: string; catalogStore: string; config: string } {
  return {
    sessionManager: path.join(__dirname, '..', 'sessionManager.js'),
    sessionHistory: path.join(__dirname, 'history.js'),
    catalogStore: path.join(__dirname, 'catalogStore.js'),
    config: path.join(__dirname, '..', 'config.js'),
  };
}

function finishChildScript(body: string): string {
  return `
    (async () => {
      try {
        ${body}
      } catch (error) {
        console.error(error?.stack || error);
        process.removeAllListeners('exit');
        process.exit(1);
      }
    })();
  `;
}

test('standalone compact durably releases authoritative busy state across success, failure, cancellation, queueing, and restart hydration', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-busy-authority-'));
  const modules = childModulePaths();
  const queuedSessionId = 'standalone_compact_success_queue';

  try {
    const first = await runChild(dataDir, finishChildScript(`
      const fs = require('fs-extra');
      const sm = require(${JSON.stringify(modules.sessionManager)});
      const history = require(${JSON.stringify(modules.sessionHistory)});
      const config = require(${JSON.stringify(modules.config)});
      await sm.loadSessions();

      let triggerCount = 0;
      let stateUpdateCount = 0;
      const unhandledRejections = [];
      process.on('unhandledRejection', error => { unhandledRejections.push(String(error?.message || error)); });
      sm.setSessionTriggerCallback(() => { triggerCount += 1; });
      sm.setOnSessionStateUpdated(() => { stateUpdateCount += 1; });

      const originalIsAsync = history.isAsyncCompactEnabled;
      const originalProcess = history.processSessionCompactionRequest;
      const originalCancel = history.cancelSessionCompaction;

      const readAuthority = id => fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const waitFor = async (predicate, label) => {
        for (let index = 0; index < 200; index += 1) {
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('timed out waiting for ' + label);
      };

      const runScenario = async (id, outcome, queueDuringCompact, releaseFault) => {
        const session = await sm.getSession(id);
        Object.assign(session, {
          agent: 'main', history: [], nextMessageSeq: 1, nextBlockId: 1,
          persistentMemorySnapshot: 'snapshot',
          stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
          busy: false, busyStartedAt: undefined, stopping: false, queue: [],
          meta: { lastMessageTime: Date.now() }, currentNode: 'master',
        });
        await sm.saveSession(id);

        let enteredResolve;
        let releaseResolve;
        const entered = new Promise(resolve => { enteredResolve = resolve; });
        const release = new Promise(resolve => { releaseResolve = resolve; });
        history.isAsyncCompactEnabled = () => false;
        history.processSessionCompactionRequest = async () => {
          // Reproduce the original bug boundary: compact commit saves the full
          // authority while the standalone owner still holds busy=true.
          await sm.saveSession(id);
          enteredResolve();
          await release;
          if (outcome === 'failure') throw new Error('injected compact failure');
        };
        history.cancelSessionCompaction = async () => {
          releaseResolve();
          return { outcome: 'cancelled', phase: 'planning' };
        };

        const request = await sm.requestSessionCompaction(id, { keepPercent: 0.5 });
        await entered;
        const during = await readAuthority(id);
        const stop = await sm.requestSessionStop(id);
        const afterStop = await readAuthority(id);

        if (queueDuringCompact) {
          await sm.enqueueSessionItem(id, { type: 'user', parts: [{ text: 'queued after compact release' }] });
        }
        const triggerBeforeRelease = triggerCount;
        const stateUpdatesBeforeRelease = stateUpdateCount;
        let releaseFaultCount = 0;
        if (releaseFault) {
          sm.setSessionPersistenceFaultInjectorForTests(phase => {
            if (phase === releaseFault && releaseFaultCount === 0) {
              releaseFaultCount += 1;
              throw new Error('injected standalone release ' + releaseFault + ' failure');
            }
          });
        }
        let cancellation;
        if (outcome === 'cancel') cancellation = await sm.cancelSessionCompaction(id);
        else releaseResolve();

        if (releaseFault === 'history') {
          await waitFor(() => releaseFaultCount === 1, id + ' pre-authority release failure');
          await new Promise(resolve => setTimeout(resolve, 25));
        } else {
          await waitFor(async () => (await readAuthority(id)).busy === false, id + ' authoritative idle release');
        }
        if (queueDuringCompact && releaseFault !== 'history') {
          await waitFor(() => triggerCount === triggerBeforeRelease + 1, id + ' queued trigger');
        }
        sm.setSessionPersistenceFaultInjectorForTests(null);
        const after = await readAuthority(id);
        const catalogBusyAfterRelease = sm.listSessions().find(item => item.id === id)?.busy;
        const stateUpdateDelta = stateUpdateCount - stateUpdatesBeforeRelease;
        let stopAfterCleanup;
        if (releaseFault) {
          stopAfterCleanup = await sm.requestSessionStop(id);
          session.stopping = false;
          await sm.saveSession(id);
        }
        return {
          request,
          duringBusy: during.busy,
          duringBusyStartedAt: typeof during.busyStartedAt === 'number',
          stop,
          stoppingAfterStop: afterStop.stopping === true,
          cancellation,
          afterBusy: after.busy,
          afterBusyStartedAtPresent: Object.prototype.hasOwnProperty.call(after, 'busyStartedAt'),
          afterStopping: after.stopping === true,
          queueLength: after.queue.length,
          triggerDelta: triggerCount - triggerBeforeRelease,
          releaseFaultCount,
          catalogBusyAfterRelease,
          stateUpdateDelta,
          stopAfterCleanup,
          liveBusy: session.busy,
          liveBusyStartedAtPresent: Object.prototype.hasOwnProperty.call(session, 'busyStartedAt') && session.busyStartedAt !== undefined,
          liveStopping: session.stopping === true,
        };
      };

      const success = await runScenario('standalone_compact_success', 'success', false);
      const failure = await runScenario('standalone_compact_failure', 'failure', false);
      const cancel = await runScenario('standalone_compact_cancel', 'cancel', false);
      const releasePostcommit = await runScenario(${JSON.stringify(queuedSessionId)}, 'success', true, 'metadata');
      const releasePostcommitNoQueue = await runScenario('standalone_compact_release_postcommit_notify', 'success', false, 'metadata');
      const releasePrecommit = await runScenario('standalone_compact_release_precommit', 'success', true, 'history');
      await new Promise(resolve => setTimeout(resolve, 25));

      history.isAsyncCompactEnabled = originalIsAsync;
      history.processSessionCompactionRequest = originalProcess;
      history.cancelSessionCompaction = originalCancel;

      const result = { success, failure, cancel, releasePostcommit, releasePostcommitNoQueue, releasePrecommit, unhandledRejections };
      process.stdout.write('RESULT_JSON ' + JSON.stringify(result) + '\\n', () => {
        process.removeAllListeners('exit');
        process.exit(0);
      });
    `));

    for (const scenario of [first.success, first.failure, first.cancel]) {
      assert.equal(scenario.request.startedImmediately, true);
      assert.equal(scenario.request.runsInBackground, false);
      assert.equal(scenario.duringBusy, true, 'compact commit fixture must save authority while busy');
      assert.equal(scenario.duringBusyStartedAt, true);
      assert.deepEqual(scenario.stop, { abortedInFlight: false, stoppedCurrent: false });
      assert.equal(scenario.stoppingAfterStop, false, 'ordinary Stop must not poison a standalone compact');
      assert.equal(scenario.afterBusy, false);
      assert.equal(scenario.afterBusyStartedAtPresent, false);
      assert.equal(scenario.afterStopping, false);
      assert.equal(scenario.liveBusy, false);
      assert.equal(scenario.liveBusyStartedAtPresent, false);
      assert.equal(scenario.liveStopping, false);
    }
    assert.deepEqual(first.cancel.cancellation, { outcome: 'cancelled', phase: 'planning' });
    assert.equal(first.success.queueLength, 0);
    assert.equal(first.failure.queueLength, 0);
    assert.equal(first.cancel.queueLength, 0);
    assert.equal(first.releasePostcommit.releaseFaultCount, 1);
    assert.equal(first.releasePostcommit.afterBusy, false);
    assert.equal(first.releasePostcommit.afterBusyStartedAtPresent, false);
    assert.equal(first.releasePostcommit.catalogBusyAfterRelease, false, 'bounded catalog retry must reconcile the idle authority projection');
    assert.equal(first.releasePostcommit.queueLength, 1);
    assert.equal(first.releasePostcommit.triggerDelta, 1, 'postcommit idle release must trigger queued input exactly once');
    assert.deepEqual(first.releasePostcommit.stopAfterCleanup, { abortedInFlight: false, stoppedCurrent: true }, 'standalone cleanup guard must always be removed');
    assert.equal(first.releasePostcommitNoQueue.stateUpdateDelta, 1, 'successful projection retry must publish the missed idle state update exactly once');
    assert.equal(first.releasePostcommitNoQueue.triggerDelta, 0);
    assert.equal(first.releasePrecommit.releaseFaultCount, 1);
    assert.equal(first.releasePrecommit.afterBusy, true, 'pre-authority release failure must retain busy ownership');
    assert.equal(first.releasePrecommit.afterBusyStartedAtPresent, true);
    assert.equal(first.releasePrecommit.catalogBusyAfterRelease, true);
    assert.equal(first.releasePrecommit.queueLength, 1);
    assert.equal(first.releasePrecommit.triggerDelta, 0, 'failed pre-authority release must not trigger queued input');
    assert.deepEqual(first.releasePrecommit.stopAfterCleanup, { abortedInFlight: false, stoppedCurrent: true }, 'standalone cleanup guard must be removed even when release fails');
    assert.deepEqual(first.unhandledRejections, []);

    const second = await runChild(dataDir, finishChildScript(`
      const sm = require(${JSON.stringify(modules.sessionManager)});
      await sm.loadSessions();
      let triggerCount = 0;
      sm.setSessionTriggerCallback(id => { if (id === ${JSON.stringify(queuedSessionId)}) triggerCount += 1; });
      await sm.resumeBusySessions();
      const session = await sm.getSession(${JSON.stringify(queuedSessionId)});
      const result = {
        busy: session.busy,
        busyStartedAtPresent: Object.prototype.hasOwnProperty.call(session, 'busyStartedAt') && session.busyStartedAt !== undefined,
        stopping: session.stopping === true,
        queueLength: session.queue.length,
        triggerCount,
      };
      process.stdout.write('RESULT_JSON ' + JSON.stringify(result) + '\\n', () => {
        process.removeAllListeners('exit');
        process.exit(0);
      });
    `));

    assert.deepEqual(second, {
      busy: false,
      busyStartedAtPresent: false,
      stopping: false,
      queueLength: 1,
      triggerCount: 1,
    });
  } finally {
    await fs.remove(dataDir).catch(() => {});
  }
});

test('standalone compact release admission keeps live busy until commit and serializes late ingress', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-busy-release-admission-'));
  const modules = childModulePaths();

  try {
    const result = await runChild(dataDir, finishChildScript(`
      const fs = require('fs-extra');
      const sm = require(${JSON.stringify(modules.sessionManager)});
      const history = require(${JSON.stringify(modules.sessionHistory)});
      const config = require(${JSON.stringify(modules.config)});
      await sm.loadSessions();

      let triggerCount = 0;
      const unhandledRejections = [];
      process.on('unhandledRejection', error => { unhandledRejections.push(String(error?.message || error)); });
      sm.setSessionTriggerCallback(() => { triggerCount += 1; });

      const originalIsAsync = history.isAsyncCompactEnabled;
      const originalProcess = history.processSessionCompactionRequest;
      history.isAsyncCompactEnabled = () => false;

      const readAuthority = id => fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const waitFor = async (predicate, label) => {
        for (let index = 0; index < 200; index += 1) {
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('timed out waiting for ' + label);
      };
      const makeSession = async id => {
        const session = await sm.getSession(id);
        Object.assign(session, {
          agent: 'main', history: [], nextMessageSeq: 1, nextBlockId: 1,
          persistentMemorySnapshot: 'snapshot',
          stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
          busy: false, busyStartedAt: undefined, stopping: false, queue: [],
          meta: { lastMessageTime: Date.now() }, currentNode: 'master',
        });
        await sm.saveSession(id);
        return session;
      };
      const startDeferredCompact = async id => {
        let processEnteredResolve;
        let finishProcessResolve;
        const processEntered = new Promise(resolve => { processEnteredResolve = resolve; });
        const finishProcess = new Promise(resolve => { finishProcessResolve = resolve; });
        history.processSessionCompactionRequest = async () => {
          await sm.saveSession(id);
          processEnteredResolve();
          await finishProcess;
        };
        await sm.requestSessionCompaction(id, { keepPercent: 0.5 });
        await processEntered;
        return finishProcessResolve;
      };
      const blockReleaseAuthorityWrite = (id, fail) => {
        let enteredResolve;
        let continueResolve;
        const entered = new Promise(resolve => { enteredResolve = resolve; });
        const continuation = new Promise(resolve => { continueResolve = resolve; });
        let intercepted = false;
        sm.setSessionPersistenceFaultInjectorForTests(async (phase, sessionId, staged) => {
          if (!intercepted && phase === 'history' && sessionId === id && staged?.busy === false) {
            intercepted = true;
            enteredResolve();
            await continuation;
            if (fail) throw new Error('injected standalone release authority failure');
          }
        });
        return { entered, continueRelease: continueResolve };
      };

      const runIngressRace = async (id, failRelease) => {
        const session = await makeSession(id);
        const finishProcess = await startDeferredCompact(id);
        const block = blockReleaseAuthorityWrite(id, failRelease);
        const triggerBefore = triggerCount;
        finishProcess();
        await block.entered;
        const authorityDuringRelease = await readAuthority(id);
        const liveBusyDuringRelease = session.busy;
        const listedBusyDuringRelease = sm.listSessions().find(item => item.id === id)?.busy;
        let enqueueSettled = false;
        const enqueue = sm.enqueueSessionItem(id, { type: 'user', parts: [{ text: 'late release-window input' }] })
          .finally(() => { enqueueSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 25));
        const queueLengthWhileBlocked = session.queue.length;
        const enqueueSettledWhileBlocked = enqueueSettled;
        block.continueRelease();
        await enqueue;
        await waitFor(async () => (await readAuthority(id)).queue.length === 1, id + ' durable queued input');
        await new Promise(resolve => setTimeout(resolve, 25));
        const authorityAfter = await readAuthority(id);
        sm.setSessionPersistenceFaultInjectorForTests(null);
        return {
          authorityBusyDuringRelease: authorityDuringRelease.busy,
          liveBusyDuringRelease,
          listedBusyDuringRelease,
          queueLengthWhileBlocked,
          enqueueSettledWhileBlocked,
          authorityBusyAfter: authorityAfter.busy,
          liveBusyAfter: session.busy,
          queueLengthAfter: authorityAfter.queue.length,
          triggerDelta: triggerCount - triggerBefore,
        };
      };

      const successIngress = await runIngressRace('standalone_release_ingress_success', false);
      const failedIngress = await runIngressRace('standalone_release_ingress_precommit_failure', true);

      history.isAsyncCompactEnabled = originalIsAsync;
      history.processSessionCompactionRequest = originalProcess;
      await new Promise(resolve => setTimeout(resolve, 25));

      const output = {
        successIngress,
        failedIngress,
        unhandledRejections,
      };
      process.stdout.write('RESULT_JSON ' + JSON.stringify(output) + '\\n', () => {
        process.removeAllListeners('exit');
        process.exit(0);
      });
    `));

    assert.deepEqual(result.successIngress, {
      authorityBusyDuringRelease: true,
      liveBusyDuringRelease: true,
      listedBusyDuringRelease: true,
      queueLengthWhileBlocked: 0,
      enqueueSettledWhileBlocked: false,
      authorityBusyAfter: false,
      liveBusyAfter: false,
      queueLengthAfter: 1,
      triggerDelta: 1,
    });
    assert.deepEqual(result.failedIngress, {
      authorityBusyDuringRelease: true,
      liveBusyDuringRelease: true,
      listedBusyDuringRelease: true,
      queueLengthWhileBlocked: 0,
      enqueueSettledWhileBlocked: false,
      authorityBusyAfter: true,
      liveBusyAfter: true,
      queueLengthAfter: 1,
      triggerDelta: 0,
    });
    assert.deepEqual(result.unhandledRejections, []);
  } finally {
    await fs.remove(dataDir).catch(() => {});
  }
});

test('standalone compact release save lane preserves concurrent semantic setters across release outcomes', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-busy-release-lane-'));
  const modules = childModulePaths();

  try {
    const result = await runChild(dataDir, finishChildScript(`
      const fs = require('fs-extra');
      const sm = require(${JSON.stringify(modules.sessionManager)});
      const history = require(${JSON.stringify(modules.sessionHistory)});
      const catalog = require(${JSON.stringify(modules.catalogStore)});
      const config = require(${JSON.stringify(modules.config)});
      await sm.loadSessions();

      const unhandledRejections = [];
      process.on('unhandledRejection', error => { unhandledRejections.push(String(error?.message || error)); });
      sm.setSessionTriggerCallback(() => {});
      const originalIsAsync = history.isAsyncCompactEnabled;
      const originalProcess = history.processSessionCompactionRequest;
      history.isAsyncCompactEnabled = () => false;

      const readAuthority = id => fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const makeSession = async id => {
        const session = await sm.getSession(id);
        Object.assign(session, {
          agent: 'main', history: [], nextMessageSeq: 1, nextBlockId: 1,
          persistentMemorySnapshot: 'snapshot',
          stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
          busy: false, busyStartedAt: undefined, stopping: false, queue: [], cwd: undefined,
          meta: { lastMessageTime: Date.now() }, currentNode: 'master',
        });
        await sm.saveSession(id);
        return session;
      };

      const runScenario = async (id, failurePhase) => {
        const session = await makeSession(id);
        let processEnteredResolve;
        let finishProcessResolve;
        const processEntered = new Promise(resolve => { processEnteredResolve = resolve; });
        const finishProcess = new Promise(resolve => { finishProcessResolve = resolve; });
        history.processSessionCompactionRequest = async () => {
          await sm.saveSession(id);
          processEnteredResolve();
          await finishProcess;
        };
        await sm.requestSessionCompaction(id, { keepPercent: 0.5 });
        await processEntered;

        let releaseEnteredResolve;
        let continueReleaseResolve;
        const releaseEntered = new Promise(resolve => { releaseEnteredResolve = resolve; });
        const continueRelease = new Promise(resolve => { continueReleaseResolve = resolve; });
        let releaseHistorySeen = false;
        let releaseMetadataFailed = false;
        sm.setSessionPersistenceFaultInjectorForTests(async (phase, sessionId, staged) => {
          if (sessionId !== id || staged?.busy !== false) return;
          if (phase === 'history' && !releaseHistorySeen) {
            releaseHistorySeen = true;
            releaseEnteredResolve();
            await continueRelease;
            if (failurePhase === 'history') throw new Error('injected staged authority failure');
          }
          if (phase === 'metadata' && failurePhase === 'metadata' && !releaseMetadataFailed) {
            releaseMetadataFailed = true;
            throw new Error('injected staged catalog failure');
          }
        });

        finishProcessResolve();
        await releaseEntered;
        const archiveResult = await sm.archiveSessions([id], true);
        let setterSettled = false;
        const setter = sm.setSessionCwd(id, '/during-release').finally(() => { setterSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 25));
        const authorityWhileBlocked = await readAuthority(id);
        const during = {
          setterSettled,
          liveBusy: session.busy,
          liveCwd: session.cwd,
          liveArchived: session.archived,
          authorityBusy: authorityWhileBlocked.busy,
          authorityCwd: authorityWhileBlocked.cwd,
        };

        continueReleaseResolve();
        const setterResult = await setter;
        sm.setSessionPersistenceFaultInjectorForTests(null);
        const authorityAfterSetter = await readAuthority(id);
        const catalogAfterSetter = catalog.sessionCatalogStore.get(id);
        const thresholdResult = await sm.setSessionCompactThreshold(id, 1234);
        const authorityAfterThreshold = await readAuthority(id);
        return {
          id,
          during,
          archiveResult,
          setterResult,
          afterSetter: {
            liveBusy: session.busy,
            liveCwd: session.cwd,
            liveArchived: session.archived,
            authorityBusy: authorityAfterSetter.busy,
            authorityCwd: authorityAfterSetter.cwd,
            catalogBusy: catalogAfterSetter.busy,
            catalogCwd: catalogAfterSetter.cwd,
            catalogArchived: catalogAfterSetter.archived,
          },
          thresholdResult,
          authorityThreshold: authorityAfterThreshold.compactThresholdTokens,
        };
      };

      const success = await runScenario('standalone_release_lane_success', 'none');
      const precommit = await runScenario('standalone_release_lane_precommit', 'history');
      const postcommit = await runScenario('standalone_release_lane_postcommit', 'metadata');
      history.isAsyncCompactEnabled = originalIsAsync;
      history.processSessionCompactionRequest = originalProcess;
      await new Promise(resolve => setTimeout(resolve, 25));

      process.stdout.write('RESULT_JSON ' + JSON.stringify({ success, precommit, postcommit, unhandledRejections }) + '\\n', () => {
        process.removeAllListeners('exit');
        process.exit(0);
      });
    `));

    for (const scenario of [result.success, result.precommit, result.postcommit]) {
      assert.deepEqual(scenario.during, {
        setterSettled: false,
        liveBusy: true,
        liveCwd: '/during-release',
        liveArchived: true,
        authorityBusy: true,
      });
      assert.deepEqual(scenario.archiveResult, {
        matchedSessionIds: [scenario.id],
        changedSessionIds: [scenario.id],
      });
      assert.deepEqual(scenario.setterResult, {
        changed: true,
        current: '/during-release',
      });
      assert.equal(scenario.afterSetter.liveCwd, '/during-release');
      assert.equal(scenario.afterSetter.liveArchived, true);
      assert.equal(scenario.afterSetter.authorityCwd, '/during-release');
      assert.equal(scenario.afterSetter.catalogCwd, '/during-release');
      assert.equal(scenario.afterSetter.catalogArchived, true);
      assert.equal(scenario.thresholdResult.thresholdTokens, 1234);
      assert.equal(scenario.authorityThreshold, 1234, 'save lane must clean up after every release outcome');
    }
    for (const scenario of [result.success, result.postcommit]) {
      assert.equal(scenario.afterSetter.liveBusy, false);
      assert.equal(scenario.afterSetter.authorityBusy, false);
      assert.equal(scenario.afterSetter.catalogBusy, false);
    }
    assert.equal(result.precommit.afterSetter.liveBusy, true);
    assert.equal(result.precommit.afterSetter.authorityBusy, true);
    assert.equal(result.precommit.afterSetter.catalogBusy, true);
    assert.deepEqual(result.unhandledRejections, []);
  } finally {
    await fs.remove(dataDir).catch(() => {});
  }
});

test('local busy transition retains committed authority when catalog projection fails postcommit', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-busy-postcommit-'));
  const modules = childModulePaths();

  try {
    const result = await runChild(dataDir, finishChildScript(`
      const fs = require('fs-extra');
      const sm = require(${JSON.stringify(modules.sessionManager)});
      const config = require(${JSON.stringify(modules.config)});
      await sm.loadSessions();
      const id = 'busy_postcommit_retention';
      const session = await sm.getSession(id);
      Object.assign(session, {
        agent: 'main', history: [], persistentMemorySnapshot: 'snapshot',
        stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
        busy: false, busyStartedAt: undefined, stopping: false, queue: [],
        meta: { lastMessageTime: Date.now() }, currentNode: 'master',
      });
      await sm.saveSession(id);

      sm.setSessionPersistenceFaultInjectorForTests(phase => {
        if (phase === 'history') throw new Error('injected authority failure');
      });
      let precommitError;
      try { await sm.updateSessionBusyState(session, true); }
      catch (error) { precommitError = error?.message; }
      const afterPrecommitFailure = await fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const liveBusyAfterPrecommitFailure = session.busy;

      sm.setSessionPersistenceFaultInjectorForTests(phase => {
        if (phase === 'metadata') throw new Error('injected catalog failure');
      });
      let errorCode;
      try { await sm.updateSessionBusyState(session, true); }
      catch (error) { errorCode = error?.code; }
      const committed = await fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const liveBusyAfterError = session.busy;

      sm.setSessionPersistenceFaultInjectorForTests(null);
      await sm.updateSessionBusyState(session, false);
      const released = await fs.readJson(config.SESSIONS_DIR + '/' + id + '.json');
      const result = {
        precommitError,
        authorityBusyAfterPrecommitFailure: afterPrecommitFailure.busy,
        liveBusyAfterPrecommitFailure,
        errorCode,
        committedBusy: committed.busy,
        committedBusyStartedAt: typeof committed.busyStartedAt === 'number',
        liveBusyAfterError,
        releasedBusy: released.busy,
        releasedBusyStartedAtPresent: Object.prototype.hasOwnProperty.call(released, 'busyStartedAt'),
      };
      process.stdout.write('RESULT_JSON ' + JSON.stringify(result) + '\\n', () => {
        process.removeAllListeners('exit');
        process.exit(0);
      });
    `));

    assert.match(result.precommitError, /injected authority failure/);
    assert.equal(result.authorityBusyAfterPrecommitFailure, false);
    assert.equal(result.liveBusyAfterPrecommitFailure, false, 'precommit failure must restore the prior live busy fields');
    assert.equal(result.errorCode, 'SESSION_AUTHORITY_POSTCOMMIT_FAILED');
    assert.equal(result.committedBusy, true);
    assert.equal(result.committedBusyStartedAt, true);
    assert.equal(result.liveBusyAfterError, true, 'postcommit failure must not roll the live owner behind authority');
    assert.equal(result.releasedBusy, false);
    assert.equal(result.releasedBusyStartedAtPresent, false);
  } finally {
    await fs.remove(dataDir).catch(() => {});
  }
});
