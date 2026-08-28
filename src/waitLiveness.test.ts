import assert from 'node:assert/strict';
import test from 'node:test';
import * as sessionManager from './sessionManager';
import { armWaitLivenessDiagnostic, initializeWaitLivenessDiagnostics, MAX_CONCURRENT_LIVENESS_WAKES } from './waitLiveness';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function cleanup(ids: string[]): Promise<void> {
  for (const sessionId of ids) await sessionManager.deleteSession(sessionId).catch(() => false);
}

test('wait liveness reconstructs already-declared waits when Main diagnostics initialize', async () => {
  const parent = id('wait_liveness_startup_parent');
  const child = id('wait_liveness_startup_child');
  try {
    await sessionManager.getSession(parent);
    await sessionManager.getSession(child);
    await sessionManager.startSessionWait(parent, { waitAnySessions: [child], declarationVersion: 1 });
    initializeWaitLivenessDiagnostics();
    await sleep(500);
    const source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait, undefined);
    assert.match(JSON.stringify(source.queue[0]), /wait-sources-quiescent/);
  } finally { await cleanup([parent, child]); }
});

test('wait liveness nudges an unchanged closed idle dependency graph only once', async () => {
  const parent = id('wait_liveness_parent');
  const child = id('wait_liveness_child');
  try {
    await sessionManager.getSession(parent);
    await sessionManager.getSession(child);
    const first = await sessionManager.startSessionWait(parent, { waitAnySessions: [child], declarationVersion: 1 });
    armWaitLivenessDiagnostic(parent, first.id);
    await sleep(500);
    let source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait, undefined);
    assert.equal(source.queue.length, 1);
    assert.match(JSON.stringify(source.queue[0]), /wait-sources-quiescent/);

    source.queue = [];
    await sessionManager.saveSession(source);
    for (let index = 0; index < 40; index++) {
      await sessionManager.queueSessionSystemEvent(parent, `unrelated ${index}`, 'background', `unrelated-receipt-${index}`);
    }
    source = await sessionManager.getSession(parent);
    source.queue = [];
    await sessionManager.saveSession(source);
    const second = await sessionManager.startSessionWait(parent, { waitAnySessions: [child], declarationVersion: 1 });
    armWaitLivenessDiagnostic(parent, second.id);
    await sleep(500);
    source = await sessionManager.getSession(parent);
    assert.equal(source.queue.length, 0);
    assert.equal(source.meta.wait?.id, second.id);
  } finally {
    await cleanup([parent, child]);
  }
});

test('wait liveness observes queued progress and changed dependency graphs permit a later nudge', async () => {
  const parent = id('wait_liveness_change_parent');
  const childA = id('wait_liveness_change_a');
  const childB = id('wait_liveness_change_b');
  try {
    await sessionManager.getSession(parent);
    const a = await sessionManager.getSession(childA);
    await sessionManager.getSession(childB);
    a.queue.push({ type: 'background', parts: [{ system: 'queued work' }] });
    await sessionManager.saveSession(a);
    const active = await sessionManager.startSessionWait(parent, { waitAnySessions: [childA], declarationVersion: 1 });
    armWaitLivenessDiagnostic(parent, active.id);
    await sleep(500);
    let source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait?.id, active.id);
    assert.equal(source.queue.length, 0);

    delete source.meta.wait;
    await sessionManager.saveSession(source);
    const changed = await sessionManager.startSessionWait(parent, { waitAnySessions: [childB], declarationVersion: 1 });
    armWaitLivenessDiagnostic(parent, changed.id);
    await sleep(500);
    source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait, undefined);
    assert.equal(source.queue.length, 1);
  } finally {
    await cleanup([parent, childA, childB]);
  }
});

test('wait liveness re-evaluates dependency transitions and nudges after initially active work becomes idle', async () => {
  const parent = id('wait_liveness_event_parent');
  const child = id('wait_liveness_event_child');
  try {
    await sessionManager.getSession(parent);
    await sessionManager.getSession(child);
    sessionManager.setActiveSessionRuntimeState(child, { state: 'requesting-model', since: Date.now(), active: { phase: 'normal-turn' } });
    const wait = await sessionManager.startSessionWait(parent, { waitAnySessions: [child], declarationVersion: 1 });
    armWaitLivenessDiagnostic(parent, wait.id);
    await sleep(500);
    let source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait?.id, wait.id);
    assert.equal(source.queue.length, 0);
    sessionManager.clearActiveSessionRuntimeState(child);
    await sleep(500);
    source = await sessionManager.getSession(parent);
    assert.equal(source.meta.wait, undefined);
    assert.equal(source.queue.length, 1);
    assert.match(JSON.stringify(source.queue[0]), /wait-sources-quiescent/);
  } finally {
    sessionManager.clearActiveSessionRuntimeState(child);
    await cleanup([parent, child]);
  }
});

test('wait liveness bounds simultaneous model-wake admissions across one idle dependency fan-out', async () => {
  const dependency = id('wait_liveness_fanout_dependency');
  const waiters = Array.from({ length: MAX_CONCURRENT_LIVENESS_WAKES + 4 }, (_, index) => id(`wait_liveness_fanout_${index}`));
  try {
    await sessionManager.getSession(dependency);
    for (const waiterId of waiters) {
      await sessionManager.getSession(waiterId);
      const wait = await sessionManager.startSessionWait(waiterId, { waitAnySessions: [dependency], declarationVersion: 1 });
      armWaitLivenessDiagnostic(waiterId, wait.id);
    }
    await sleep(600);
    const states = await Promise.all(waiters.map(waiterId => sessionManager.getSession(waiterId)));
    const admitted = states.filter(session => session.meta.wait === undefined
      && JSON.stringify(session.queue).includes('wait-sources-quiescent'));
    const stillWaiting = states.filter(session => session.meta.wait?.waitAnySessions?.includes(dependency));
    assert.equal(admitted.length, MAX_CONCURRENT_LIVENESS_WAKES);
    assert.equal(stillWaiting.length, 4);

    admitted[0].queue = [];
    await sessionManager.saveSession(admitted[0]);
    await sleep(100);
    const afterOneSettles = await Promise.all(waiters.map(waiterId => sessionManager.getSession(waiterId)));
    assert.equal(afterOneSettles.filter(session => session.meta.wait === undefined).length, MAX_CONCURRENT_LIVENESS_WAKES + 1);
  } finally {
    await cleanup([...waiters, dependency]);
  }
});
