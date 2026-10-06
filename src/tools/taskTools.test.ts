import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_ACTIONS, TASK_STATUSES } from '../taskStore';
import { definitions } from './definitions';
import { BUILTIN_TOOL_PLACEMENTS } from './placement';
import * as sessionManager from '../sessionManager';
import { task, callTool, call_tool, modelFacingDefinitions, create_child_session } from '../tools';
import { resetMainManagementToolsForTests, shutdownMainManagementTools } from '../mainManagementTools';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';

const readResult = (result: { output: string }): any => JSON.parse(result.output);

test('one task builtin has the action enum, no caller-supplied identity, and Main ownership', () => {
  const matches = definitions.filter(def => def.name === 'task');
  assert.equal(matches.length, 1);
  const schema: any = matches[0].parameters;
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.action.enum, [...TASK_ACTIONS]);
  assert.deepEqual(schema.properties.status.enum, [...TASK_STATUSES]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.sessionId, undefined);
  assert.deepEqual(schema.properties.ownerSessionId.type, ['string', 'null']);
  assert.equal(schema.properties.createdBySessionId, undefined);
  assert.equal(modelFacingDefinitions.filter(def => def.name === 'task').length, 1);
  assert.equal(BUILTIN_TOOL_PLACEMENTS.task.owner, 'main-management');
});

test('direct, unified and Worker task calls use exact context identity through Main and do not modify Session state', async () => {
  const prefix = `task_tool_${Date.now()}`;
  const creator = await sessionManager.getSession(`${prefix}_creator`);
  const owner = await sessionManager.getSession(`${prefix}_owner`);
  const creatorBefore = JSON.stringify(creator);
  const ownerBefore = JSON.stringify(owner);
  const creatorCtx = { sessionId: creator.id };
  const ownerCtx: any = { sessionId: owner.id, session: owner, sessionPlacement: 'session-worker', persistCurrentSession: async () => { throw new Error('Task must not persist Session state'); } };
  let taskId: string;
  try {
    await assert.rejects(() => task({ action: 'list' }, undefined), /active source session/);
    const created = readResult(await callTool('task', { action: 'create', title: 'Exercise shared task' }, creatorCtx)).task;
    taskId = created.id;
    assert.equal(created.createdBySessionId, creator.id);
    const claimed = readResult(await call_tool({ source: 'builtin', name: 'task', args: { action: 'claim', taskId } }, ownerCtx)).task;
    assert.equal(claimed.ownerSessionId, owner.id);
    await assert.rejects(() => task({ action: 'update', taskId, note: 'Creator cannot change ownership' }, creatorCtx), /owner required/);
    await task({ action: 'update', taskId, note: 'Working' }, ownerCtx);
    assert.equal(JSON.stringify(creator), creatorBefore);
    const result = readResult(await task({ action: 'complete', taskId, result: 'Done' }, ownerCtx)).task;
    assert.equal(result.status, 'completed');
    const inspected = readResult(await task({ action: 'get', taskId }, creatorCtx));
    assert.equal(inspected.task.result, 'Done');
    assert.equal(inspected.notes[0].sessionId, owner.id);
    assert.equal(JSON.stringify(creator.history), '[]');
    assert.equal(creator.queue.length, 1);
    assert.equal(result.completionNotificationStatus, 'sent');
    assert.equal(JSON.stringify(owner), ownerBefore);
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-tasks
  match:
    tool: { source: builtin, name: task }
  action: deny
`));
    await assert.rejects(() => callTool('task', { action: 'get', taskId }, creatorCtx), /denies/i);
    await assert.rejects(() => task({ action: 'get', taskId }, ownerCtx), /denies/i);
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    await sessionManager.deleteSession(creator.id);
    await sessionManager.deleteSession(owner.id);
  }
});


test('create_child_session taskId binds the real child before delivery and rejects owned or missing tasks before creation', async () => {
  const prefix = `task_child_${Date.now()}`;
  const parent = await sessionManager.getSession(`${prefix}_parent`);
  const ctx: any = { sessionId: parent.id, session: parent, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const children: string[] = [];
  try {
    const taskId = readResult(await task({ action: 'create', title: 'Child work' }, ctx)).task.id;
    const result = await create_child_session({ suffix: 'executor', taskId }, ctx);
    const childId = String(result).match(/`([^`]+)`/)![1];
    children.push(childId);
    assert.ok(sessionManager.getSessionCatalog(childId));
    const child = await sessionManager.getExistingSession(childId);
    assert.match(child.history[0].parts[0].system, /This Session is linked to task task_/);
    assert.match(child.history[0].parts[0].system, /Do not send a separate routine completion message/);
    assert.equal(child.queue.length, 0);
    assert.equal(readResult(await task({ action: 'get', taskId }, ctx)).task.ownerSessionId, childId);
    assert.match(readResult(await task({ action: 'get', taskId }, ctx)).notes[0].text, new RegExp(childId));
    const count = sessionManager.getAllSessions().size;
    await assert.rejects(() => create_child_session({ suffix: 'duplicate', taskId }, ctx), /already owned/);
    await assert.rejects(() => create_child_session({ suffix: 'missing', taskId: 'missing' }, ctx), /not found/);
    assert.equal(sessionManager.getAllSessions().size, count);
  } finally {
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    for (const id of children) await sessionManager.deleteSession(id);
    await sessionManager.deleteSession(parent.id);
  }
});
