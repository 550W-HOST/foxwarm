import * as sessionRuntime from './sessionRuntime';
import { parseFoxwarmOpeningTag } from './utils/promptWrappers';
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


test('selection settings create one durable passive notice, preserve waits, and exclude no-op, effort-only and failed updates', async () => {
  const session = await sessionManager.getSession(id('selection'));
  const triggers: string[] = [];
  sessionManager.setSessionTriggerCallback(target => { triggers.push(target); });
  try {
    const wait = await sessionManager.startSessionWait(session.id, { waitForInput: true });
    await sessionRuntime.updateSettings(session.id, { model: 'fixture/a', effort: 'none', currentNode: 'node-a' },
      { kind: 'channel', channelType: 'fixture', channelId: 'fixture-channel', senderId: 'user-"<one>', username: 'Example & User' });
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].trigger, false);
    const tag = parseFoxwarmOpeningTag(session.queue[0].parts![0].system)!;
    assert.equal(tag.attrs.kind, 'session-settings-changed');
    assert.equal(tag.attrs.oldModel, 'default'); assert.equal(tag.attrs.newModel, 'fixture/a');
    assert.equal(tag.attrs.oldNode, 'master'); assert.equal(tag.attrs.newNode, 'node-a');
    assert.equal(tag.attrs.newEffort, 'none');
    assert.equal(tag.attrs.actorSenderId, 'user-"<one>');
    assert.equal(tag.attrs.actorUsername, 'Example & User');
    assert.equal(session.meta.wait.id, wait.id);
    assert.equal((await metadataStore.readSessionHistorySnapshot(session.id)).queue.length, 1);
    await sessionRuntime.updateSettings(session.id, { model: 'fixture/a', currentNode: 'node-a' });
    await sessionRuntime.updateSettings(session.id, { effort: 'low', childModelDefault: 'fixture/child' });
    assert.equal(session.queue.length, 1);
    await assert.rejects(() => sessionRuntime.updateSettings(session.id, { model: 'fixture/b', effort: 'invalid' as any }));
    assert.equal(session.model, 'fixture/a');
    assert.equal(session.queue.length, 1);
    sessionManager.setSessionPersistenceFaultInjectorForTests((phase, target) => {
      if (phase === 'history' && target === session.id) throw new Error('selection precommit failure');
    });
    await assert.rejects(() => sessionRuntime.updateSettings(session.id, { currentNode: 'node-b' }), /selection precommit failure/);
    assert.equal(session.currentNode, 'node-a');
    assert.equal(session.queue.length, 1);
    assert.equal(session.meta.wait.id, wait.id);
    assert.deepEqual(triggers, []);
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    await sessionManager.queueSessionWaitTimeoutEvent(session.id, wait.id, 'matching timeout');
    assert.equal(session.meta.wait, undefined, 'the original timeout remains valid after a passive notice');
    assert.deepEqual(triggers, [session.id]);
    assert.equal(session.queue.length, 2);
    assert.equal(session.queue[1].waitTimeoutId, wait.id);
  } finally {
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(session.id);
  }
});

test('selection notices use managed passive admission without waking the controller or its owner', async () => {
  const owner = await sessionManager.getSession(id('selection_owner'));
  const session = await sessionManager.getSession(id('selection_managed'));
  const originalResume = toolscript.resumeBackgroundToolScriptRunForManagedSession;
  let resumes = 0;
  (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = async () => { resumes++; return true; };
  try {
    await managedSessions.openManagedSession({ sessionId: session.id, ownerSessionId: owner.id, controllerRunId: 'fixture-controller' });
    await sessionRuntime.updateSettings(session.id, { currentNode: 'fixture-node' });
    const managed = await managedSessions.getManagedSessionStateForTests(session.id);
    assert.equal(managed.pendingInbox.length, 1);
    assert.equal(managed.pendingInbox[0].trigger, false);
    assert.equal(session.queue.length, 0);
    assert.equal(owner.queue.length, 0);
    const persisted = await metadataStore.readSessionHistorySnapshot(session.id);
    assert.equal(persisted.currentNode, 'fixture-node');
    assert.equal(persisted.meta.managedSession.pendingInbox[0].trigger, false);
    await sessionManager.resumeBusySessions();
    assert.equal(resumes, 0);
  } finally {
    (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = originalResume;
    await sessionManager.deleteSession(session.id);
    await sessionManager.deleteSession(owner.id);
  }
});


test('passive input cannot satisfy waitAll, while the ordinary completion from the same source still does', async () => {
  const session = await sessionManager.getSession(id('passive_wait_all'));
  const triggers: string[] = [];
  sessionManager.setSessionTriggerCallback(target => { triggers.push(target); });
  try {
    const wait = await sessionManager.startSessionWait(session.id, { waitAllSessions: ['fixture-sender'] });
    await sessionManager.enqueueSessionItem(session.id, notice, { trigger: false });
    assert.equal(session.meta.wait.id, wait.id);
    assert.deepEqual(session.meta.wait.waitAll.satisfiedSessions, []);
    assert.deepEqual(session.meta.wait.waitAll.deferredQueue, []);
    assert.deepEqual(triggers, []);
    await sessionManager.enqueueSessionItem(session.id, notice);
    assert.equal(session.meta.wait, undefined);
    assert.deepEqual(triggers, [session.id]);
    assert.equal(session.queue.length, 2);
    assert.equal(session.queue[0].trigger, false);
    assert.equal(session.queue[1].trigger, undefined);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(session.id);
  }
});


test('explicit local Run queued clears wait before processing a passive-only selection notice', async () => {
  const session = await sessionManager.getSession(id('selection_run_queued'));
  let processed = 0;
  sessionManager.setSessionTriggerCallback(target => {
    assert.equal(target, session.id);
    assert.equal(session.meta.wait, undefined);
    processed++;
  });
  try {
    await sessionManager.startSessionWait(session.id, { waitForInput: true });
    await sessionRuntime.updateSettings(session.id, { currentNode: 'fixture-node' });
    await sessionManager.requestSessionDequeue(session.id);
    assert.equal(processed, 1);
    assert.equal((await metadataStore.readSessionHistorySnapshot(session.id)).meta.wait, undefined);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    await sessionManager.deleteSession(session.id);
  }
});
