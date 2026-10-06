import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from './taskStore';
import { TaskService } from './taskService';

function fixture(t: any, send: (target: string, message: string, source: string) => Promise<unknown> = async () => {}): TaskService {
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
  const service = fixture(t, async (target, message, source) => {
    sends.push({ target, message, source });
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

test('optional assignment notification is bounded, after commit, deduplicated and never rolls assignment back', async t => {
  const sends: any[] = [];
  let fail = false;
  const service = fixture(t, async (target, message, source) => {
    sends.push({ target, message, source });
    assert.equal(service.get(taskId).task.ownerSessionId, target);
    if (fail) throw new Error('synthetic assignment delivery failure');
  });
  const taskId = (await service.execute({ action: 'create', title: 'Notify', description: 'x'.repeat(4000) }, 'creator')).task.id;
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first' }, 'creator');
  assert.equal(sends.length, 0);
  const notified = await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(notified.task.assignmentNotificationStatus, 'sent');
  assert.match(sends[0].message, /You have been assigned a task.*task_.*Notify\nStatus: active/);
  assert.ok(sends[0].message.length < 1400);
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(sends.length, 1);
  service.store.close();
  await service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: true }, 'creator');
  assert.equal(sends.length, 1, 'persisted successful assignment does not resend after restart');
  await assert.rejects(() => service.execute({ action: 'assign', taskId, ownerSessionId: null, notifySession: true }, 'creator'), /non-null ownerSessionId/);
  await assert.rejects(() => service.execute({ action: 'assign', taskId, ownerSessionId: 'first', notifySession: 'yes' }, 'creator'), /boolean/);
  fail = true;
  const failed = await service.execute({ action: 'assign', taskId, ownerSessionId: 'second', notifySession: true }, 'creator');
  assert.equal(failed.task.ownerSessionId, 'second');
  assert.equal(failed.task.assignmentNotificationStatus, 'failed');
  assert.match(failed.warning, /assigned.*notification could not be delivered/);
  const self = await service.execute({ action: 'assign', taskId, ownerSessionId: 'creator', notifySession: true }, 'creator');
  assert.equal(self.task.assignmentNotificationStatus, 'skipped');
  assert.equal(self.warning, undefined);
  assert.equal(sends.length, 2);
});
