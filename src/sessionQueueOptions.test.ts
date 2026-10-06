import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import * as metadataStore from './session/metadataStore';
import * as managedSessions from './managedSessions';
import * as toolscript from './toolscript';

const id = (suffix: string) => `passive_queue_${Date.now()}_${suffix}`;
const notice = { type: 'intersession' as const, sourceSessionId: 'fixture-sender', parts: [{ system: 'Task ownership changed.' }] };

test('passive local ingress persists while idle/stopped/active, does not trigger, and ordinary ingress cannot supply its flag', async () => {
  const session = await sessionManager.getSession(id('local'));
  const triggers: string[] = [];
  sessionManager.setSessionTriggerCallback(target => { triggers.push(target); });
  try {
    session.stopping = true;
    await sessionManager.enqueueSessionItem(session.id, notice, { trigger: false });
    assert.equal(triggers.length, 0);
    assert.equal(session.queue[0].trigger, false);
    assert.equal((await metadataStore.readSessionHistorySnapshot(session.id)).queue[0].trigger, false);
    session.busy = true;
    await sessionManager.enqueueSessionItem(session.id, notice, { trigger: false });
    assert.equal(triggers.length, 0);
    session.busy = false;
    session.stopping = false;
    await sessionManager.resumeBusySessions();
    assert.equal(triggers.length, 0, 'passive-only queue does not become restart work');
    await sessionManager.enqueueSessionItem(session.id, { ...notice, trigger: false });
    assert.deepEqual(triggers, [session.id], 'default ingress starts processing and strips an untrusted passive flag');
    assert.equal(session.queue[2].trigger, undefined);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(session.id);
  }
});

test('passive managed ingress uses the same inbox and save without controller/owner wake, including restart', async () => {
  const owner = await sessionManager.getSession(id('manager'));
  const session = await sessionManager.getSession(id('managed'));
  const triggers: string[] = [];
  let resumes = 0;
  const originalResume = toolscript.resumeBackgroundToolScriptRunForManagedSession;
  (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = async () => { resumes++; return true; };
  sessionManager.setSessionTriggerCallback(target => { triggers.push(target); });
  try {
    await managedSessions.openManagedSession({ sessionId: session.id, ownerSessionId: owner.id, controllerRunId: 'fixture-controller' });
    await sessionManager.enqueueSessionItem(session.id, notice, { trigger: false });
    const state = await managedSessions.getManagedSessionStateForTests(session.id);
    assert.equal(state.pendingInbox.length, 1);
    assert.equal(state.pendingInbox[0].trigger, false);
    assert.equal((await metadataStore.readSessionHistorySnapshot(session.id)).meta.managedSession.pendingInbox[0].trigger, false);
    assert.equal(session.queue.length, 0);
    assert.equal(owner.queue.length, 0);
    await sessionManager.resumeBusySessions();
    assert.equal(resumes, 0);
    assert.equal(triggers.length, 0);
    await sessionManager.enqueueSessionItem(session.id, notice);
    assert.equal(resumes, 1, 'normal ingress retains managed-controller wake behavior');
  } finally {
    (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = originalResume;
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(session.id);
    await sessionManager.deleteSession(owner.id);
  }
});

test('passive admission keeps Worker sink ownership and rolls local queue back on precommit failure', async () => {
  const session = await sessionManager.getSession(id('fence'));
  const before = JSON.stringify(session);
  const calls: any[] = [];
  sessionManager.setSessionWorkerEnqueueSink(async (target, item, options) => { calls.push({ target, item, options }); });
  try {
    await sessionManager.enqueueSessionItem(session.id, notice, { trigger: false });
    assert.deepEqual(calls[0].options, { trigger: false });
    assert.equal(calls[0].item.trigger, false);
    assert.equal(JSON.stringify(session), before, 'Main does not hydrate/mutate Worker-owned queue');
  } finally { sessionManager.setSessionWorkerEnqueueSink(undefined); }
  const originalWrite = metadataStore.writeSessionHistoryAtomically;
  (metadataStore as any).writeSessionHistoryAtomically = async () => { throw new Error('passive precommit failure'); };
  try {
    await assert.rejects(() => sessionManager.enqueueSessionItem(session.id, notice, { trigger: false }), /passive precommit failure/);
    assert.equal(JSON.stringify(session), before);
  } finally {
    (metadataStore as any).writeSessionHistoryAtomically = originalWrite;
    await sessionManager.deleteSession(session.id);
  }
});
