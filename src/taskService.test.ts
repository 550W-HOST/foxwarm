import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from './taskStore';
import type { SessionDeliveryOptions } from './types';
import { TaskService } from './taskService';

function fixture(t: any, send: (target: string, message: string, source: string, options?: SessionDeliveryOptions) => Promise<unknown> = async () => {}): TaskService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-task-service-'));
  const store = new TaskStore(path.join(root, 'tasks.sqlite'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return new TaskService(store, { resolveSessionId: id => ['creator', 'first', 'second', 'child'].includes(id) ? id : undefined, sendToSession: send });
}

test('assign transfer and release use creator/owner authority and existing Session targets', async t => {
  const service = fixture(t);
  const taskId = (await service.execute({ action: 'create', title: 'Delegate' }, 'creator')).task.id;
  await assert.rejects(() => service.execute({ action: 'assign', taskId, ownerSessionId: 'missing' }, 'creator'), /Target Session was not found/);
  await assert.rejects(() => service.execute({ action: 'assign', taskId, ownerSessionId: 'first' }, 'second'), /creator or owner required/);
  assert.equal((await service.execute({ action: 'assign', taskId, ownerSessionId: 'first' }, 'creator')).task.ownerSessionId, 'first');
  assert.equal((await service.execute({ action: 'assign', taskId, ownerSessionId: 'second' }, 'first')).task.ownerSessionId, 'second');
  await assert.rejects(() => service.execute({ action: 'update', taskId, note: 'Lost ownership' }, 'first'), /owner required/);
  const released = (await service.execute({ action: 'assign', taskId, ownerSessionId: null }, 'creator')).task;
  assert.equal(released.ownerSessionId, null);
  assert.equal(released.status, 'open');
  assert.equal(service.get(taskId).notes.length, 3);
  await assert.rejects(() => service.execute({ action: 'assign', taskId }, 'creator'), /ownerSessionId or null/);
});

test('completion sends once after commit; delivery failure is a warning and survives store reopen', async t => {
  const sends: any[] = [];
  const service = fixture(t, async (target, message, source, options) => {
    sends.push({ target, message, source, taskNotification: options?.taskNotification });
    assert.equal(service.get(taskId).task.status, 'completed');
    if (fail) throw new Error('synthetic failure');
  });
  let fail = false;
  let taskId = (await service.execute({ action: 'create', title: 'Finish', description: 'Scope' }, 'creator')).task.id;
  await service.execute({ action: 'claim', taskId }, 'first');
  const completed = await service.execute({ action: 'complete', taskId, result: 'Delivered' }, 'first');
  assert.equal(completed.task.completionNotificationStatus, 'sent');
  assert.equal(sends[0].target, 'creator');
  assert.equal(sends[0].source, 'first');
  assert.deepEqual(sends[0].taskNotification, { taskId, event: 'completed' });
  assert.match(sends[0].message, /Task completed: task_.*Finish\nDelivered/);
  await assert.rejects(() => service.execute({ action: 'complete', taskId }, 'first'), /terminal/);
  assert.equal(sends.length, 1);
  fail = true;
  taskId = (await service.execute({ action: 'create', title: 'Notify failure' }, 'creator')).task.id;
  await service.execute({ action: 'claim', taskId }, 'first');
  const failed = await service.execute({ action: 'complete', taskId }, 'first');
  assert.match(failed.warning, /completed.*notification could not be delivered/);
  assert.equal(failed.task.status, 'completed');
  assert.equal(failed.task.completionNotificationStatus, 'failed');
  service.store.close();
  assert.equal(service.get(taskId).task.completionNotificationStatus, 'failed');
  assert.equal(sends.length, 2, 'reopen does not resend completed notifications');
  taskId = (await service.execute({ action: 'create', title: 'Self work' }, 'creator')).task.id;
  const self = await service.execute({ action: 'complete', taskId }, 'creator');
  assert.equal(self.warning, undefined);
  assert.equal(self.task.completionNotificationStatus, 'skipped');
  assert.equal(sends.length, 2, 'self completion does not send to self');
  service.store.close();
  assert.equal(service.get(taskId).task.completionNotificationStatus, 'skipped');
});

test('child attachment rejects missing or owned tasks before creation and serializes claim against creation', async t => {
  const service = fixture(t);
  let effects = 0;
  await assert.rejects(() => service.createAttachedChild('missing', 'creator', async () => { effects++; return 'child'; }), /not found/);
  assert.equal(effects, 0);
  const taskId = (await service.execute({ action: 'create', title: 'Attach' }, 'creator')).task.id;
  let entered: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let finish: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const creating = service.createAttachedChild(taskId, 'creator', async () => { effects++; entered(); await gate; return 'child'; });
  await enteredPromise;
  const competingClaim = service.execute({ action: 'claim', taskId }, 'first');
  finish();
  assert.equal(await creating, 'child');
  await assert.rejects(() => competingClaim, /already claimed/);
  assert.equal(service.get(taskId).task.ownerSessionId, 'child');
  assert.match(service.get(taskId).notes[0].text, /Attached new Session child/);
  await assert.rejects(() => service.createAttachedChild(taskId, 'creator', async () => { effects++; return 'second'; }), /already owned/);
  assert.equal(effects, 1);
});

test('assignment notices commit before previous/new delivery, preserve independent status and skip successful repeats', async t => {
  const sends: any[] = [];
  let failTarget: string | undefined;
  const service = fixture(t, async (target, message, source, options) => {
    sends.push({ target, message, source, trigger: options?.trigger !== false, taskNotification: options?.taskNotification });
    if (options?.trigger !== false) assert.equal(service.get(taskId).task.ownerSessionId, target);
    else assert.equal(service.get(taskId).task.previousOwnerSessionId, target);
    if (target === failTarget) throw new Error('synthetic assignment delivery failure');
  });
  const taskId = (await service.execute({ action: 'create', title: 'Notify', description: 'x'.repeat(4000) }, 'creator')).task.id;
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first' }, 'creator');
  assert.equal(sends.length, 0);
  const notified = await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(notified.task.assignmentNotificationStatus, 'sent');
  assert.deepEqual(sends[0].taskNotification, { taskId, event: 'assigned', recipient: 'new' });
  assert.match(sends[0].message, /You have been assigned a task.*task_.*Notify\nStatus: active/);
  assert.ok(sends[0].message.length > 4000);
  assert.ok(sends[0].message.endsWith('x'.repeat(4000)));
  service.store.close();
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(sends.length, 1, 'successful notification survives restart without resending');
  failTarget = 'first';
  const transferred = await service.execute({ action: 'assign', taskId, ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.deepEqual(sends.slice(1).map(send => [send.target, send.trigger]), [['first', false], ['second', true]]);
  assert.equal(transferred.task.ownerSessionId, 'second');
  assert.deepEqual(sends.slice(1).map(send => send.taskNotification), [
    { taskId, event: 'transferred', recipient: 'previous' },
    { taskId, event: 'transferred', recipient: 'new' },
  ]);
  assert.equal(transferred.task.previousOwnerNotificationStatus, 'failed');
  assert.equal(transferred.task.assignmentNotificationStatus, 'sent');
  assert.match(transferred.warning, /previous owner notification/);
  failTarget = undefined;
  const retried = await service.execute({ action: 'assign', taskId, ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.equal(retried.task.previousOwnerNotificationStatus, 'sent');
  assert.equal(sends.length, 4, 'only the failed previous recipient is retried');
  const released = await service.execute({ action: 'assign', taskId, ownerSessionId: null, notifySession: true }, 'creator');
  assert.equal(released.task.ownerSessionId, null);
  assert.equal(released.task.previousOwnerNotificationStatus, 'sent');
  assert.equal(released.task.assignmentNotificationStatus, null);
  assert.deepEqual([sends[4].target, sends[4].trigger], ['second', false]);
  assert.match(sends[4].message, /ownership released/);
  assert.deepEqual(sends[4].taskNotification, { taskId, event: 'released', recipient: 'previous' });
  await service.execute({ action: 'assign', taskId, ownerSessionId: null, notifySession: true }, 'creator');
  assert.equal(sends.length, 5);
  const self = await service.execute({ action: 'assign', taskId, ownerSessionId: 'creator', notifySession: true }, 'creator');
  assert.equal(self.task.assignmentNotificationStatus, 'skipped');
  assert.equal(sends.length, 5);
  await assert.rejects(() => service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: 'yes' }, 'creator'), /boolean/);
});

test('Session-targeted callers seed self-task progress from authority without counting older history', async t => {
  const service = fixture(t);
  const withSequence = new TaskService(service.store, {
    resolveSessionId: id => id,
    sendToSession: async () => {},
    readSessionMessageSeq: async () => 40,
  });
  const taskId = (await withSequence.execute({ action: 'create', title: 'New self task' }, 'creator')).task.id;
  await withSequence.execute({ action: 'claim', taskId }, 'creator');
  assert.deepEqual(service.store.taskContext('creator', Array.from({ length: 30 }, (_, i) => i + 12), true), []);
  assert.equal(service.store.taskContext('creator', Array.from({ length: 30 }, (_, i) => i + 41), true)[0].id, taskId);
});

test('new-owner failure and previous-owner self skip preserve committed assignment without a duplicate self send', async t => {
  let sends = 0;
  const service = fixture(t, async () => { sends++; throw new Error('new recipient unreachable'); });
  const taskId = (await service.execute({ action: 'create', title: 'Self transfer' }, 'creator')).task.id;
  await service.execute({ action: 'claim', taskId }, 'creator');
  const result = await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(result.task.ownerSessionId, 'first');
  assert.equal(result.task.previousOwnerNotificationStatus, 'skipped');
  assert.equal(result.task.assignmentNotificationStatus, 'failed');
  assert.match(result.warning, /new owner notification/);
  assert.equal(sends, 1);
});

test('an older delayed notification cannot mark a newer assignment to the same owner delivered', async t => {
  const entered: (() => void)[] = [];
  const release: (() => void)[] = [];
  const gates = [0, 1].map(i => ({
    started: new Promise<void>(resolve => { entered[i] = resolve; }),
    finish: new Promise<void>(resolve => { release[i] = resolve; }),
  }));
  let delayed = 0;
  const service = fixture(t, async (target, message) => {
    if (target === 'first' && message.startsWith('You have been assigned')) {
      const gate = gates[delayed++];
      entered[delayed - 1]();
      await gate.finish;
    }
  });
  const taskId = (await service.execute({ action: 'create', title: 'Reassignment' }, 'creator')).task.id;
  const original = service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  await gates[0].started;
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'second', notifySession: true }, 'creator');
  const reassigned = service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  await gates[1].started;
  release[0](); await original;
  assert.equal(service.get(taskId).task.assignmentNotificationStatus, 'pending');
  release[1](); await reassigned;
  assert.equal(service.get(taskId).task.assignmentNotificationStatus, 'sent');
});

test('opting in for an unchanged owner does not retroactively notify a previous owner from an opt-out transfer', async t => {
  const targets: string[] = [];
  const service = fixture(t, async target => { targets.push(target); });
  const taskId = (await service.execute({ action: 'create', title: 'No deferred old notice' }, 'creator')).task.id;
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first' }, 'creator');
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'second' }, 'creator');
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.deepEqual(targets, ['second']);
  assert.equal(service.get(taskId).task.previousOwnerNotificationStatus, null);
});

test('create can commit an existing owner and optional assignment notification without a separate assign action', async t => {
  const sends: any[] = [];
  const service = fixture(t, async (target, message, source, options) => {
    const id = options.taskNotification.taskId;
    assert.equal(service.get(id).task.ownerSessionId, target, 'ownership is committed before delivery');
    sends.push({ target, message, source, options });
    if (fail) throw new Error('synthetic recipient unavailable');
  });
  let fail = false;
  const emptyCount = service.list().total;
  await assert.rejects(() => service.execute({ action: 'create', title: 'Invalid owner', ownerSessionId: 'missing' }, 'creator'), /Target Session was not found/);
  assert.equal(service.list().total, emptyCount, 'invalid real target has no task effect');
  await assert.rejects(() => service.execute({ action: 'create', title: 'Bad owner value', ownerSessionId: 7 }, 'creator'), /ownerSessionId/);
  await assert.rejects(() => service.execute({ action: 'create', title: 'Bad notification', notifySession: 'yes' }, 'creator'), /boolean/);
  const quiet = await service.execute({ action: 'create', title: 'Own immediately', ownerSessionId: 'first' }, 'creator');
  assert.equal(quiet.task.status, 'active');
  assert.equal(quiet.task.ownerSessionId, 'first');
  assert.equal(sends.length, 0);
  await assert.rejects(() => service.execute({ action: 'claim', taskId: quiet.task.id }, 'second'), /already claimed/);
  const notified = await service.execute({ action: 'create', title: 'Notify on create', description: 'y'.repeat(4000), ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(notified.task.assignmentNotificationStatus, 'sent');
  assert.deepEqual(sends[0].options.taskNotification, { taskId: notified.task.id, event: 'assigned', recipient: 'new' });
  assert.equal(sends[0].options.trigger, undefined);
  assert.ok(sends[0].message.endsWith('y'.repeat(4000)));
  fail = true;
  const failed = await service.execute({ action: 'create', title: 'Failed delivery', ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.equal(failed.task.status, 'active');
  assert.equal(failed.task.ownerSessionId, 'second');
  assert.equal(failed.task.assignmentNotificationStatus, 'failed');
  assert.match(failed.warning, /new owner notification/);
  fail = false;
  const self = await service.execute({ action: 'create', title: 'Self create', ownerSessionId: 'creator', notifySession: true }, 'creator', 40);
  assert.equal(self.task.assignmentNotificationStatus, 'skipped');
  assert.equal(sends.length, 2, 'self target does not produce a redundant send');
  assert.deepEqual(service.store.taskContext('creator', Array.from({ length: 30 }, (_, i) => i + 12), true), [], 'self creation starts a fresh progress anchor');
  assert.equal(service.store.taskContext('creator', Array.from({ length: 30 }, (_, i) => i + 41), true)[0].id, self.task.id);
  const legacyGoal = 'legacy goal '.repeat(400);
  const legacy = service.store.migrateLegacyGoal('creator', legacyGoal, 0);
  await service.execute({ action: 'assign', taskId: legacy.id, ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.ok(sends[2].message.endsWith(legacyGoal));
  const open = await service.execute({ action: 'create', title: 'Explicitly unowned', ownerSessionId: null, notifySession: true }, 'creator');
  assert.equal(open.task.status, 'open');
  assert.equal(open.task.ownerSessionId, null);
  assert.equal(sends.length, 3, 'unowned creation has no notification recipient');
});
