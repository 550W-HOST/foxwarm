import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpServer } from '../httpServer';
import { TaskService } from '../taskService';
import { TaskStore } from '../taskStore';
import { registerWebUiTaskRoutes } from './webuiTasks';

test('authenticated task REST separates user actions from Session-targeted tool operations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-webui-tasks-'));
  const store = new TaskStore(path.join(root, 'tasks.sqlite'));
  const sessions = new Set(['creator', 'worker', 'other']);
  const sessionAgents = new Map([['creator', 'coordinator'], ['worker', 'executor'], ['other', 'reviewer']]);
  const notices: any[] = [];
  const service = new TaskService(store, { resolveSessionId: id => sessions.has(id) ? id : undefined,
    resolveSessionAgent: id => sessionAgents.get(id),
    sendToSession: async (target, message, source, options) => { notices.push({ target, message, source, taskNotification: options?.taskNotification }); } });
  const server = new HttpServer(0, 'synthetic-task-auth');
  registerWebUiTaskRoutes(server, service);
  await server.start();
  t.after(async () => { await server.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${((server as any).httpServer.address() as any).port}`;
  const request = (url: string, method = 'GET', body?: any, authorized = true) => fetch(origin + url, {
    method, headers: { ...(authorized ? { Authorization: 'Bearer synthetic-task-auth' } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await request('/api/tasks', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/api/tasks', 'POST', { sessionId: 'creator', title: 'Denied' }, false)).status, 401);
  assert.equal((await request('/api/tasks', 'POST', { sessionId: 'creator', title: 'Forged actor' })).status, 400);
  const createdResponse = await request('/api/tasks', 'POST', { title: 'UI task', description: 'A scope' });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as any;
  const id = created.task.id;
  assert.equal(created.task.createdByKind, 'user');
  assert.equal(created.task.createdBySessionId, null);
  assert.equal((await request(`/api/tasks/${id}/claim`, 'POST', { sessionId: 'worker' })).status, 200);
  assert.equal((await request(`/api/tasks/${id}/comments`, 'POST', { note: 'Silent user comment' })).status, 200);
  assert.equal(notices.length, 0, 'omitting notifySession saves a WebUI comment without notifying');
  assert.equal((await request(`/api/tasks/${id}/comments`, 'POST', { note: 'Opted-out user comment', notifySession: false })).status, 200);
  assert.equal(notices.length, 0, 'false saves a WebUI comment without notifying');
  assert.equal((await request(`/api/tasks/${id}/comments`, 'POST', { note: 'Notified user comment', notifySession: true })).status, 200);
  assert.equal(notices.length, 1, 'the existing WebUI notification setting reaches the owner');
  assert.deepEqual(notices[0].taskNotification, { taskId: id, event: 'note', sourceKind: 'user' });
  assert.equal((await request(`/api/tasks/${id}`, 'PATCH', { sessionId: 'other', note: 'Reviewer note', notifySession: true })).status, 200);
  assert.equal((await request(`/api/tasks/${id}`, 'PATCH', { note: 'Owner-targeted update' })).status, 200);
  assert.equal((await request(`/api/tasks/${id}/assign`, 'POST', { ownerSessionId: 'missing' })).status, 404);
  const transferred = await (await request(`/api/tasks/${id}/assign`, 'POST', { ownerSessionId: 'other', notifySession: true })).json() as any;
  assert.equal(transferred.task.ownerSessionId, 'other');
  assert.equal((await request(`/api/tasks/${id}/assign`, 'POST', { ownerSessionId: null })).status, 200);
  assert.equal((await request(`/api/tasks/${id}/claim`, 'POST', { sessionId: 'worker' })).status, 200);
  const finished = await (await request(`/api/tasks/${id}/complete`, 'POST', { result: 'Completed from UI' })).json() as any;
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.sessionId, 'worker');
  assert.equal(notices.length, 5);
  assert.deepEqual(notices.map(notice => [notice.target, notice.source]), [
    ['worker', undefined], ['worker', 'other'], ['worker', undefined], ['other', undefined], ['other', undefined],
  ]);
  assert.equal((await request(`/api/tasks/${id}/cancel`, 'POST', {})).status, 409);
  const details = await (await request(`/api/tasks/${id}`)).json() as any;
  assert.equal(details.task.result, 'Completed from UI');
  assert.ok(details.notes.length > 0);
  const listed = await (await request('/api/tasks?status=completed')).json() as any;
  assert.deepEqual(listed.tasks[0], { id, title: 'UI task', status: 'completed', parentTaskId: null,
    ownerSessionId: 'worker', createdByKind: 'user', createdBySessionId: null, updatedAt: listed.tasks[0].updatedAt,
    createdByAgent: null, ownerAgent: 'executor' });
  assert.equal((await (await request('/api/tasks')).json() as any).tasks.length, 0);
  assert.equal((await (await request('/api/tasks?status=completed&limit=1')).json() as any).tasks.length, 1);
  for (const query of ['limit=0', 'limit=100', 'status=claimed', 'unknown=1', 'status=open&status=active']) {
    assert.equal((await request(`/api/tasks?${query}`)).status, 400);
  }
  assert.equal((await request('/api/tasks', 'POST', { title: 'Missing owner', ownerSessionId: 'missing' })).status, 404);
  const ownedResponse = await request('/api/tasks', 'POST', { title: 'Owned UI create', ownerSessionId: 'worker', notifySession: true });
  assert.equal(ownedResponse.status, 201);
  const owned = await ownedResponse.json() as any;
  assert.equal(owned.task.ownerSessionId, 'worker');
  assert.equal(owned.task.status, 'active');
  assert.equal(owned.task.assignmentNotificationStatus, 'sent');
  assert.equal(notices[5].target, 'worker');
  const unassignedResponse = await request('/api/tasks', 'POST', { title: 'Unassigned global task' });
  const unassigned = await unassignedResponse.json() as any;
  assert.equal(unassignedResponse.status, 201);
  assert.ok(((await (await request('/api/tasks')).json() as any).tasks).some((task: any) => task.id === unassigned.task.id),
    'the WebUI list keeps its global behavior and includes unassigned user tasks');
  assert.equal((await request('/api/tasks?scope=current-session')).status, 400, 'the model list scope does not narrow the WebUI route');
  const missing = await request('/api/tasks/missing');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as any).code, 'TASK_NOT_FOUND');
});
