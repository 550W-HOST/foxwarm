import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, TASK_CHILD_LIMIT, TASK_LIST_LIMIT, TASK_NOTE_LIMIT } from './taskStore';

function fixture(t: any): TaskStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-task-test-'));
  const store = new TaskStore(path.join(root, 'tasks.sqlite'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('coordinator creates, executor claims and updates, coordinator cannot update or complete the owned task', t => {
  const store = fixture(t);
  const created = store.execute({ action: 'create', title: 'Implement parser', description: 'Parse one format.' }, 'coordinator').task;
  assert.match(created.id, /^task_[0-9a-f]{12}$/);
  assert.equal(created.createdBySessionId, 'coordinator');
  assert.equal(created.ownerSessionId, null);
  assert.equal(created.status, 'open');
  assert.throws(() => store.execute({ action: 'update', taskId: created.id, note: 'Not mine yet' }, 'executor'), /creator required/);
  const claimed = store.execute({ action: 'claim', taskId: created.id }, 'executor').task;
  assert.equal(claimed.ownerSessionId, 'executor');
  assert.equal(claimed.status, 'active');
  assert.deepEqual(store.execute({ action: 'claim', taskId: created.id }, 'executor').task, claimed);
  assert.throws(() => store.execute({ action: 'claim', taskId: created.id }, 'other'), /already claimed.*owner=executor/);
  assert.throws(() => store.execute({ action: 'update', taskId: created.id, description: 'Changed' }, 'coordinator'), /status=active, owner=executor.*owner required/);
  assert.throws(() => store.execute({ action: 'complete', taskId: created.id }, 'coordinator'), /owner required/);
  store.execute({ action: 'update', taskId: created.id, description: '', note: 'Parser passes', status: 'open' }, 'executor');
  assert.equal(store.execute({ action: 'get', taskId: created.id }, 'coordinator').task.ownerSessionId, 'executor');
  store.execute({ action: 'update', taskId: created.id, status: 'active' }, 'executor');
  const completed = store.execute({ action: 'complete', taskId: created.id, result: 'Parser implemented.' }, 'executor').task;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'Parser implemented.');
  assert.ok(completed.completedAt >= created.createdAt);
  const inspected = store.execute({ action: 'get', taskId: created.id }, 'coordinator');
  assert.equal(inspected.task.description, '');
  assert.deepEqual(inspected.notes.map((note: any) => [note.sessionId, note.text]), [['executor', 'Parser passes']]);
  assert.equal(store.execute({ action: 'list' }, 'coordinator').total, 0);
  assert.equal(store.execute({ action: 'list', status: 'completed' }, 'coordinator').total, 1);
  for (const action of ['claim', 'update', 'complete', 'cancel']) {
    assert.throws(() => store.execute({ action, taskId: created.id, ...(action === 'update' ? { status: 'open' } : {}) }, 'executor'), /terminal.*status=completed/);
  }
  store.close();
  const restored = JSON.parse(execFileSync(process.execPath, ['-e', `
    const { TaskStore } = require(${JSON.stringify(require.resolve('./taskStore'))});
    const store = new TaskStore(${JSON.stringify(store.filePath)});
    console.log(JSON.stringify(store.execute({action:'get', taskId:${JSON.stringify(created.id)}}, 'coordinator')));
    store.close();
  `], { encoding: 'utf8' }));
  assert.deepEqual(restored, JSON.parse(JSON.stringify(inspected)), 'task and notes survive a fresh process');
});

test('simultaneous independent SQLite connections have one claim winner', async t => {
  const store = fixture(t);
  const taskId = store.execute({ action: 'create', title: 'One owner' }, 'coordinator').task.id;
  const workers = ['first', 'second'].map(sessionId => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { TaskStore } = require(workerData.modulePath);
    const store = new TaskStore(workerData.filePath);
    store.execute({action:'get', taskId:workerData.taskId}, workerData.sessionId);
    parentPort.once('message', () => {
      try { parentPort.postMessage({ task: store.execute({action:'claim', taskId:workerData.taskId}, workerData.sessionId).task }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { store.close(); }
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { modulePath: require.resolve('./taskStore'), filePath: store.filePath, taskId, sessionId } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', message => { assert.equal(message, 'ready'); resolve(); });
  })));
  const results = workers.map(worker => new Promise<any>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', resolve);
  }));
  workers.forEach(worker => worker.postMessage('claim'));
  const claims = await Promise.all(results);
  assert.equal(claims.filter(result => result.task).length, 1);
  assert.equal(claims.filter(result => /already claimed by another Session/.test(result.error)).length, 1);
  assert.equal(store.execute({ action: 'get', taskId }, 'coordinator').task.ownerSessionId, claims.find(result => result.task).task.ownerSessionId);
});

test('immutable parent links require existing tasks and cannot be changed into cycles', t => {
  const store = fixture(t);
  assert.throws(() => store.execute({ action: 'create', title: 'Orphan', parentTaskId: 'missing' }, 'coordinator'), /Parent task missing not found/);
  const parent = store.execute({ action: 'create', title: 'Parent' }, 'coordinator').task;
  const child = store.execute({ action: 'create', title: 'Child', parentTaskId: parent.id }, 'executor').task;
  assert.equal(child.parentTaskId, parent.id);
  assert.equal(store.execute({ action: 'get', taskId: parent.id }, 'coordinator').children[0].id, child.id);
  assert.throws(() => store.execute({ action: 'update', taskId: parent.id, parentTaskId: child.id }, 'coordinator'), /parentTaskId is not allowed/);
  assert.throws(() => store.execute({ action: 'update', taskId: child.id, parentTaskId: child.id }, 'executor'), /parentTaskId is not allowed/);
});

test('creator can finish an unclaimed task; only creator or owner can cancel, and terminal states cannot reopen', t => {
  const store = fixture(t);
  const unclaimed = store.execute({ action: 'create', title: 'No claim needed' }, 'coordinator').task;
  assert.throws(() => store.execute({ action: 'complete', taskId: unclaimed.id }, 'other'), /creator required/);
  assert.equal(store.execute({ action: 'complete', taskId: unclaimed.id }, 'coordinator').task.status, 'completed');
  for (const canceller of ['coordinator', 'executor']) {
    const taskId = store.execute({ action: 'create', title: 'Cancel me' }, 'coordinator').task.id;
    store.execute({ action: 'claim', taskId }, 'executor');
    assert.throws(() => store.execute({ action: 'cancel', taskId }, 'other'), /creator or owner required/);
    assert.equal(store.execute({ action: 'cancel', taskId, reason: 'Scope removed' }, canceller).task.status, 'cancelled');
    assert.equal(store.execute({ action: 'get', taskId }, 'coordinator').notes[0].text, 'Scope removed');
    for (const action of ['claim', 'complete', 'cancel', 'update']) {
      assert.throws(() => store.execute({ action, taskId, ...(action === 'update' ? { status: 'open' } : {}) }, canceller), /terminal.*status=cancelled/);
    }
  }
});

test('list summaries and get child/note output are bounded without dropping persisted notes', t => {
  const store = fixture(t);
  const taskId = store.execute({ action: 'create', title: 'Parent' }, 'coordinator').task.id;
  for (let i = 0; i < TASK_LIST_LIMIT + 5; i++) {
    store.execute({ action: 'create', title: `Child ${i}`, parentTaskId: taskId, description: 'x'.repeat(4000) }, 'coordinator');
  }
  for (let i = 0; i < TASK_NOTE_LIMIT + 5; i++) store.execute({ action: 'update', taskId, note: `Progress ${i}` }, 'coordinator');
  const list = store.execute({ action: 'list' }, 'coordinator');
  assert.equal(list.tasks.length, TASK_LIST_LIMIT);
  assert.equal(list.total, TASK_LIST_LIMIT + 6);
  assert.equal(list.omitted, 6);
  assert.ok(list.tasks.every((row: any) => !Object.prototype.hasOwnProperty.call(row, 'description')));
  const get = store.execute({ action: 'get', taskId }, 'coordinator');
  assert.equal(get.children.length, TASK_CHILD_LIMIT);
  assert.equal(get.childrenOmitted, TASK_LIST_LIMIT + 5 - TASK_CHILD_LIMIT);
  assert.equal(get.notes.length, TASK_NOTE_LIMIT);
  assert.equal(get.notesOmitted, 5);
  assert.equal(get.notes[0].text, 'Progress 5');
  assert.equal(get.notes[get.notes.length - 1].text, `Progress ${TASK_NOTE_LIMIT + 4}`);
});

test('runtime validates action-specific fields, types, required fields, sizes and terminal update status', t => {
  const store = fixture(t);
  const invalid = [undefined, [], {}, { action: 'invented' }, { action: 'create' },
    { action: 'create', title: ' ' }, { action: 'create', title: 'x'.repeat(201) },
    { action: 'create', title: 'Bad', createdBySessionId: 'other' },
    { action: 'create', title: 'Bad', description: null }, { action: 'get' },
    { action: 'get', taskId: 'id', title: 'Unused' }, { action: 'claim', taskId: 'id', ownerSessionId: 'other' },
    { action: 'update', taskId: 'id' }, { action: 'update', taskId: 'id', status: 'completed' },
    { action: 'update', taskId: 'id', note: '' }, { action: 'list', status: 'claimed' },
    { action: 'complete', taskId: 'id', note: 'Wrong field' }, { action: 'cancel', taskId: 'id', reason: 12 }];
  for (const args of invalid) assert.throws(() => store.execute(args as any, 'coordinator'));
  assert.throws(() => store.execute({ action: 'create', title: 'No actor' }, ''), /current Session/);
  assert.throws(() => store.execute({ action: 'get', taskId: 'missing' }, 'coordinator'), /Task missing not found/);
  assert.equal(store.execute({ action: 'list' }, 'coordinator').total, 0);
});

test('completion results allow 20000 characters but reject 20001 before changing the task', t => {
  const store = fixture(t);
  const task = store.execute({ action: 'create', title: 'Long result' }, 'owner').task;
  store.execute({ action: 'claim', taskId: task.id }, 'owner');
  const tooLong = 'x'.repeat(20001);
  assert.throws(() => store.execute({ action: 'complete', taskId: task.id, result: tooLong }, 'owner'), /result must be a string of at most 20000 characters/);
  const pending = store.execute({ action: 'get', taskId: task.id }, 'owner').task;
  assert.equal(pending.status, 'active');
  assert.equal(pending.result, null);
  const accepted = 'y'.repeat(20000);
  store.execute({ action: 'complete', taskId: task.id, result: accepted }, 'owner');
  const completed = store.execute({ action: 'get', taskId: task.id }, 'owner').task;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, accepted);
});

test('legacy Goal migration is idempotent, preserves full text and never revives a terminal task', t => {
  const store = fixture(t);
  const goal = 'Preserve the work\n' + 'x'.repeat(8000);
  const first = store.migrateLegacyGoal('legacy-owner', goal, 0);
  assert.match(first.id, /^task_[0-9a-f]{12}$/);
  assert.equal(first.ownerSessionId, 'legacy-owner');
  assert.equal(first.createdBySessionId, 'legacy-owner');
  assert.equal(first.status, 'active');
  assert.equal(first.description, goal);
  assert.equal(store.execute({ action: 'get', taskId: first.id }).task.description.length, 4000);
  store.execute({ action: 'update', taskId: first.id, note: 'Progress' }, 'legacy-owner');
  assert.equal(store.migrateLegacyGoal('legacy-owner', goal, 0).description, goal, 'note updates do not overwrite full legacy text');
  store.close();
  assert.equal(store.migrateLegacyGoal('legacy-owner', goal, 0).id, first.id);
  assert.equal(store.execute({ action: 'list' }).total, 1);
  store.execute({ action: 'cancel', taskId: first.id }, 'legacy-owner');
  const retried = store.migrateLegacyGoal('legacy-owner', goal, 0);
  assert.equal(retried.id, first.id);
  assert.equal(retried.status, 'cancelled');
  assert.deepEqual(store.taskContext('legacy-owner', Array.from({ length: 30 }, (_, i) => i + 1), true), []);
});

test('fixed 30-message reminders are persisted, deduplicated and preserve progress before compact removal', t => {
  const store = fixture(t);
  const self = store.execute({ action: 'create', title: 'Self work' }, 'owner').task;
  store.execute({ action: 'claim', taskId: self.id }, 'owner', undefined, 0);
  const delegated = store.execute({ action: 'create', title: 'Delegated' }, 'coordinator').task;
  store.execute({ action: 'claim', taskId: delegated.id }, 'owner', undefined, 0);
  const seqs = (count: number, start = 1) => Array.from({ length: count }, (_, i) => start + i);
  assert.deepEqual(store.taskContext('owner', seqs(29), true), []);
  store.close();
  const due = store.taskContext('owner', seqs(30), true);
  assert.deepEqual(due, [{ id: self.id, title: 'Self work', status: 'active' }]);
  assert.deepEqual(store.taskContext('owner', seqs(30), true), []);
  assert.deepEqual(store.taskContext('owner', seqs(30), true, [self.id]), due, 'a request retry refreshes only its active retained reminder');
  store.taskContext('owner', seqs(20, 31), false);
  store.close();
  assert.deepEqual(store.taskContext('owner', seqs(9, 51), true), []);
  assert.deepEqual(store.taskContext('owner', seqs(10, 51), true), due, 'compacted-away messages were counted before removal');
  store.execute({ action: 'complete', taskId: self.id }, 'owner');
  assert.deepEqual(store.taskContext('owner', seqs(30, 61), true, [self.id]), []);
  assert.throws(() => store.execute({ action: 'update', taskId: delegated.id, reminderEvery: 30 }, 'owner'), /not allowed/);
});

test('persisted UUID task IDs remain usable with new short-ID child references', t => {
  const store = fixture(t);
  // Open the current schema, then seed a record in the historical persisted format.
  store.execute({ action: 'list' });
  const historicalId = 'task_550e8400-e29b-41d4-a716-446655440000';
  const db = new DatabaseSync(store.filePath);
  try {
    db.prepare(`INSERT INTO tasks (id,title,description,status,createdBySessionId,createdAt,updatedAt)
      VALUES (?,?,?,'open',?,?,?)`).run(historicalId, 'Historical task', 'Full persisted description', 'owner', 1, 1);
  } finally { db.close(); }
  store.close();
  assert.equal(store.execute({ action: 'get', taskId: historicalId }).task.description, 'Full persisted description');
  store.execute({ action: 'update', taskId: historicalId, note: 'Progress with the old ID' }, 'owner');
  const child = store.execute({ action: 'create', title: 'New short child', parentTaskId: historicalId }, 'owner').task;
  assert.match(child.id, /^task_[0-9a-f]{12}$/);
  assert.equal(child.parentTaskId, historicalId);
  const parent = store.execute({ action: 'get', taskId: historicalId });
  assert.equal(parent.task.id, historicalId);
  assert.equal(parent.notes[0].text, 'Progress with the old ID');
  assert.equal(parent.children[0].id, child.id);
  store.execute({ action: 'complete', taskId: historicalId }, 'owner');
  assert.equal(store.execute({ action: 'get', taskId: child.id }).task.parentTaskId, historicalId);
});
