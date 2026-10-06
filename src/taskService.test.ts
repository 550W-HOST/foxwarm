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
  const failed = await service.execute({ action: 'complete', taskId }, 'creator');
  assert.match(failed.warning, /completed.*notification could not be delivered/);
  assert.equal(failed.task.status, 'completed');
  assert.equal(failed.task.completionNotificationStatus, 'failed');
  service.store.close();
  assert.equal(service.get(taskId).task.completionNotificationStatus, 'failed');
  assert.equal(sends.length, 2, 'reopen does not resend completed notifications');
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
