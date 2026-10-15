import * as llm from './llm';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { Message, Session } from './types';
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

for (const later of ['user', 'selection', 'managed-user']) {
  test(`failed selection save preserves a later supported ${later} operation`, { timeout: 15_000 }, async () => {
    const session = await sessionManager.getSession(id(`concurrent_${later}`));
    const owner = later === 'managed-user' ? await sessionManager.getSession(id('concurrent_owner')) : undefined;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let failOnce = true;
    let resumed = 0;
    const originalResume = toolscript.resumeBackgroundToolScriptRunForManagedSession;
    (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = async () => { resumed++; return true; };
    sessionManager.setSessionTriggerCallback(() => {});
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      if (owner) await managedSessions.openManagedSession({
        sessionId: session.id, ownerSessionId: owner.id, controllerRunId: 'fixture-controller',
      });
      sessionManager.setSessionPersistenceFaultInjectorForTests(async (phase, target) => {
        if (phase === 'history' && target === session.id && failOnce) {
          failOnce = false;
          entered(); await held;
          throw new Error('one transient selection write failure');
        }
      });
      first = sessionRuntime.updateSettings(session.id, { model: 'fixture/a', effort: 'low', currentNode: 'node-a' });
      const rejected = assert.rejects(first, /one transient selection write failure/);
      await writing;
      let secondSettled = false;
      second = (later === 'selection'
        ? sessionRuntime.updateSettings(session.id, { model: 'fixture/b', effort: 'low', currentNode: 'node-b' })
        : sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'later accepted input' }] }))
        .then(result => { secondSettled = true; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(secondSettled, false);
      assert.equal(session.model, 'fixture/a', 'the later settings mutation waits for the current save owner');
      release();
      await rejected;
      await second;
      sessionManager.setSessionPersistenceFaultInjectorForTests(null);
      const durable = await metadataStore.readSessionHistorySnapshot(session.id);
      const queued = owner ? (await managedSessions.getManagedSessionStateForTests(session.id)).pendingInbox : session.queue;
      const durableQueued = owner ? durable.meta.managedSession.pendingInbox : durable.queue;
      assert.equal(queued.length, 1);
      assert.deepEqual(durableQueued, queued);
      if (later === 'selection') {
        assert.equal(session.model, 'fixture/b'); assert.equal(session.effort, 'low');
        assert.equal(durable.model, 'fixture/b'); assert.equal(durable.effort, 'low');
        assert.equal(session.currentNode, 'node-b'); assert.equal(durable.currentNode, 'node-b');
        const tag = parseFoxwarmOpeningTag(queued[0].parts![0].system)!;
        assert.equal(tag.attrs.oldModel, 'default'); assert.equal(tag.attrs.newModel, 'fixture/b');
        assert.equal(tag.attrs.oldNode, 'master'); assert.equal(tag.attrs.newNode, 'node-b');
        assert.equal(tag.attrs.newEffort, 'low', 'the later normalized pair is not partially undone by the failed write');
      } else {
        assert.equal(queued[0].parts![0].text, 'later accepted input');
        assert.equal(session.model, undefined); assert.equal(session.effort, undefined);
        assert.equal(durable.model, undefined); assert.equal(durable.effort, undefined);
        assert.equal(session.currentNode, 'master'); assert.equal(durable.currentNode, 'master');
      }
      assert.equal(JSON.stringify(durableQueued).includes('node-a'), false, 'a failed operation cannot leave a success notice');
      assert.equal(resumed, owner ? 1 : 0, 'managed wake occurs only for the later triggering input');
    } finally {
      release(); await first?.catch(() => {}); await second?.catch(() => {});
      sessionManager.setSessionPersistenceFaultInjectorForTests(null);
      (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = originalResume;
      sessionManager.setSessionTriggerCallback(() => {});
      await sessionManager.deleteSession(session.id);
      if (owner) await sessionManager.deleteSession(owner.id);
    }
  });
}

test('a delayed managed-controller wake cannot overwrite a later admitted inbox item', async () => {
  const owner = await sessionManager.getSession(id('wake_owner'));
  const session = await sessionManager.getSession(id('wake_inbox'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const waking = new Promise<void>(resolve => { entered = resolve; });
  const originalResume = toolscript.resumeBackgroundToolScriptRunForManagedSession;
  let calls = 0;
  (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = async () => {
    if (++calls > 1) return true;
    entered(); await held; return false;
  };
  let first: Promise<void> | undefined;
  try {
    await managedSessions.openManagedSession({ sessionId: session.id, ownerSessionId: owner.id, controllerRunId: 'fixture-controller' });
    first = sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'first input' }] });
    await waking;
    await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'later input' }] });
    release(); await first;
    const inbox = (await managedSessions.getManagedSessionStateForTests(session.id)).pendingInbox;
    assert.deepEqual(inbox.map(item => item.parts[0].text), ['first input', 'later input']);
    const durable = await metadataStore.readSessionHistorySnapshot(session.id);
    assert.deepEqual(durable.meta.managedSession.pendingInbox, inbox);
  } finally {
    release(); await first?.catch(() => {});
    (toolscript as any).resumeBackgroundToolScriptRunForManagedSession = originalResume;
    await sessionManager.deleteSession(session.id);
    await sessionManager.deleteSession(owner.id);
  }
});

test('failed passive selection admission preserves a real wait created by executeTools during its save', { timeout: 15_000 }, async () => {
  const session = await sessionManager.getSession(id('real_wait_overlap'));
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(accept => { resolve = accept; });
    return { promise, resolve };
  };
  const toolsReady = gate(); const toolsRelease = gate();
  const writing = gate(); const writeRelease = gate(); const waitEntered = gate();
  const originalChat = llm.chat;
  const originalTools = llm.executeTools;
  const originalWait = sessionManager.startSessionWaitForSession;
  let calls = 0;
  (llm as any).chat = async (_parts: unknown, _owner: Session, _iteration: number, options: any) => {
    calls++;
    const call = { id: 'real-wait', name: 'wait', args: { waitForInput: true, reason: 'real wait after selection' } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: call }] });
    return { toolCalls: [call] };
  };
  (llm as any).executeTools = async (...args: Parameters<typeof llm.executeTools>) => {
    toolsReady.resolve(); await toolsRelease.promise;
    return originalTools(...args);
  };
  (sessionManager as any).startSessionWaitForSession = (...args: Parameters<typeof originalWait>) => {
    const result = originalWait(...args); waitEntered.resolve(); return result;
  };
  const runner = new SessionTurnRunner(new LocalSessionTurnHost());
  let activeTurn: Promise<void> | undefined;
  let selection: Promise<unknown> | undefined;
  sessionManager.setSessionTriggerCallback(target => { activeTurn = runner.processSessionQueue(target); return activeTurn; });
  try {
    await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text: 'please wait for input' }] });
    await toolsReady.promise;
    let once = true;
    sessionManager.setSessionPersistenceFaultInjectorForTests(async (phase, target) => {
      if (phase === 'history' && target === session.id && once) {
        once = false; writing.resolve(); await writeRelease.promise;
        throw new Error('one passive selection write failure');
      }
    });
    selection = sessionRuntime.updateSettings(session.id, { currentNode: 'node-a' });
    const rejected = assert.rejects(selection, /one passive selection write failure/);
    await writing.promise;
    toolsRelease.resolve(); await waitEntered.promise;
    const waitId = session.meta.wait.id;
    writeRelease.resolve(); await rejected; await activeTurn;
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    const durable = await metadataStore.readSessionHistorySnapshot(session.id);
    assert.equal(calls, 1);
    assert.equal(session.busy, false);
    assert.equal(session.meta.wait.id, waitId);
    assert.equal(durable.meta.wait.id, waitId);
    assert.equal(durable.meta.wait.reason, 'real wait after selection');
    assert.deepEqual(durable.history.map((message: Message) => message.role), ['user', 'model', 'tool']);
    assert.equal(durable.history[2].parts[0].functionResponse.response.output, 'ok');
    assert.deepEqual(durable.queue, []);
    assert.equal(durable.currentNode, 'master');
  } finally {
    toolsRelease.resolve(); writeRelease.resolve();
    await selection?.catch(() => {}); await activeTurn?.catch(() => {});
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    sessionManager.setSessionTriggerCallback(() => {});
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalTools;
    (sessionManager as any).startSessionWaitForSession = originalWait;
    await sessionManager.deleteSession(session.id);
  }
});

test('managed selection admission does not acquire identity while a parent move waits for its save lane', { timeout: 15_000 }, async () => {
  const parent = await sessionManager.getSession(id('move_parent'));
  const parentId = parent.id;
  const movedId = id('moved_parent');
  const childId = await sessionManager.createChildSession(parentId, 'child');
  const child = await sessionManager.getSession(childId);
  const owner = await sessionManager.getSession(id('move_owner'));
  const lease = await managedSessions.openManagedSession({ sessionId: child.id, ownerSessionId: owner.id });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let once = true;
  let earlier: Promise<void> | undefined;
  let selection: Promise<unknown> | undefined;
  let moving: Promise<unknown> | undefined;
  try {
    sessionManager.setSessionPersistenceFaultInjectorForTests(async (phase, target) => {
      if (phase === 'history' && target === child.id && once) {
        once = false; entered(); await held;
      }
    });
    earlier = sessionManager.saveSession(child.id);
    await writing;
    selection = sessionRuntime.updateSettings(child.id, { currentNode: 'node-a' });
    await new Promise<void>(resolve => setImmediate(resolve));
    moving = sessionManager.moveSessionToTarget({ sourceSessionId: parentId, newSessionId: movedId });
    for (let checks = 0; checks < 100 && child.parentSessionId !== movedId; checks++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(child.parentSessionId, movedId, 'the real move reached child persistence while holding identity');
    release(); await earlier;
    const read = sessionManager.getExistingSession(owner.id);
    await Promise.all([selection, moving, read]);
    assert.equal((await read).id, owner.id);
    const managed = await managedSessions.getManagedSessionStateForTests(child.id);
    assert.equal(managed.leaseId, lease.leaseId, 'catalog existence prevents reclaiming the live owner');
    assert.equal(managed.ownerSessionId, owner.id);
    const durable = await metadataStore.readSessionHistorySnapshot(child.id);
    assert.equal(durable.parentSessionId, movedId);
    assert.equal(durable.currentNode, 'node-a');
    assert.equal(durable.meta.managedSession.leaseId, lease.leaseId);
  } finally {
    release(); await earlier?.catch(() => {}); await selection?.catch(() => {}); await moving?.catch(() => {});
    sessionManager.setSessionPersistenceFaultInjectorForTests(null);
    await sessionManager.deleteSession(child.id);
    await sessionManager.deleteSession(movedId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await sessionManager.deleteSession(owner.id);
  }
});
