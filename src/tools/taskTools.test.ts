import { DatabaseSync } from 'node:sqlite';
import { taskService } from './taskTools';
import { executeTools } from '../llm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_ACTIONS, TASK_STATUSES } from '../taskStore';
import { definitions } from './definitions';
import { BUILTIN_TOOL_PLACEMENTS } from './placement';
import * as sessionManager from '../sessionManager';
import { task, callTool, call_tool, modelFacingDefinitions, create_child_session } from '../tools';
import { resetMainManagementToolsForTests, shutdownMainManagementTools } from '../mainManagementTools';
import { tool_create_child_session as directCreateChildSession } from '../toolsSessionAgent/interSession';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';
import { parseFoxwarmWrappedContent } from '../utils/promptWrappers';

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
    const created = readResult(await callTool('task', { action: 'create', title: 'Exercise shared task' }, creatorCtx));
    taskId = created.taskId;
    assert.equal(created.status, 'open');
    assert.equal(created.ownerSessionId, null);
    assert.equal(readResult(await task({ action: 'get', taskId }, creatorCtx)).task.createdBySessionId, creator.id);
    const claimed = readResult(await call_tool({ source: 'builtin', name: 'task', args: { action: 'claim', taskId } }, ownerCtx));
    assert.equal(claimed.ownerSessionId, owner.id);
    assert.equal(claimed.status, 'active');
    await assert.rejects(() => task({ action: 'update', taskId, note: 'Creator cannot change ownership' }, creatorCtx), /owner required/);
    await task({ action: 'update', taskId, note: 'Working' }, ownerCtx);
    assert.equal(JSON.stringify(creator), creatorBefore);
    const result = readResult(await task({ action: 'complete', taskId, result: 'Done' }, ownerCtx));
    assert.equal(result.status, 'completed');
    const inspected = readResult(await task({ action: 'get', taskId }, creatorCtx));
    assert.equal(inspected.task.result, 'Done');
    assert.equal(inspected.notes[0].sessionId, owner.id);
    assert.equal(JSON.stringify(creator.history), '[]');
    assert.equal(creator.queue.length, 1);
    assert.equal(readResult(await task({ action: 'get', taskId }, ownerCtx)).task.completionNotificationStatus, 'sent');
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


test('create_child_session taskId assigns or transfers the real child before delivery and rejects unauthorized or terminal tasks before creation', async () => {
  const prefix = `task_child_${Date.now()}`;
  const parent = await sessionManager.getSession(`${prefix}_parent`);
  const outsider = await sessionManager.getSession(`${prefix}_outsider`);
  const ctx: any = { sessionId: parent.id, session: parent, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const children: string[] = [];
  try {
    const taskId = readResult(await task({ action: 'create', title: 'Child work', description: 'Complete the full child task description.' }, ctx)).taskId;
    const result: any = await create_child_session({ suffix: 'executor', taskId, message: 'Use the approved implementation path.', afterSend: 'wait' }, ctx);
    const childId = String(result.output ?? result).match(/`([^`]+)`/)![1];
    assert.deepEqual(result.__toolPostAction, { waitForReply: true, successfulSendToSessionTarget: childId });
    children.push(childId);
    assert.ok(sessionManager.getSessionCatalog(childId));
    const child = await sessionManager.getExistingSession(childId);
    assert.match(child.history[0].parts[0].system, /This Session is linked to task task_/);
    assert.match(child.history[0].parts[0].system, /do not send a separate routine completion report/);
    assert.equal(child.queue.length, 1);
    const assignment = parseFoxwarmWrappedContent(child.queue[0].parts?.[0].system || '');
    assert.equal(assignment.attrs.type, 'task');
    assert.equal(assignment.attrs.taskId, taskId);
    assert.match(assignment.content, /Complete the full child task description\./);
    assert.match(assignment.content, /Use the approved implementation path\./);
    assert.doesNotMatch(assignment.content, /inter-agent/);
    assert.equal(readResult(await task({ action: 'get', taskId }, ctx)).task.ownerSessionId, childId);
    assert.match(readResult(await task({ action: 'get', taskId }, ctx)).notes[0].text, new RegExp(childId));
    const transferredResult: any = await create_child_session({ suffix: 'replacement', taskId, message: 'Continue the transferred task.' }, ctx);
    const transferredId = String(transferredResult).match(/`([^`]+)`/)![1];
    children.push(transferredId);
    const oldChild = await sessionManager.getExistingSession(childId);
    const replacement = await sessionManager.getExistingSession(transferredId);
    assert.equal(oldChild.queue.length, 2);
    assert.equal(oldChild.queue[1].trigger, false, 'transferred old owner receives passive ingress');
    assert.equal(replacement.queue.length, 1);
    assert.match(replacement.queue[0].parts?.[0].system || '', new RegExp(`taskId="${taskId}"`));
    assert.equal(readResult(await task({ action: 'get', taskId }, ctx)).task.ownerSessionId, transferredId);
    const count = sessionManager.getAllSessions().size;
    await assert.rejects(() => create_child_session({ suffix: 'forbidden', taskId }, { sessionId: outsider.id, session: outsider }), /creator or owner required/);
    await assert.rejects(() => create_child_session({ suffix: 'missing', taskId: 'missing' }, ctx), /not found/);
    assert.equal(sessionManager.getAllSessions().size, count);
    const completion = await executeTools([{ id: 'child-task-complete', name: 'task', args: { action: 'complete', taskId, result: 'Finished delegated work' } }],
      { sessionId: replacement.id, session: replacement }, replacement);
    assert.deepEqual((completion as any).__toolPostAction, { successfulSendToSessionTargets: [parent.id], completedLinkedTask: { taskId, attachedSessionId: transferredId } });
    assert.equal(readResult(await task({ action: 'get', taskId }, ctx)).task.status, 'completed');
    await assert.rejects(() => create_child_session({ suffix: 'terminal', taskId }, ctx), /terminal/);
    assert.equal(sessionManager.getAllSessions().size, count);
  } finally {
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    for (const id of children) await sessionManager.deleteSession(id);
    await sessionManager.deleteSession(parent.id);
    await sessionManager.deleteSession(outsider.id);
  }
});

test('create_child_session does not enter wait when task assignment delivery fails', async () => {
  const parent = await sessionManager.getSession(`task_delivery_failure_${Date.now()}_parent`);
  const service = taskService as any;
  const original = service.createAttachedChild;
  service.createAttachedChild = async () => ({
    childSessionId: 'delivery-failure-child',
    assignmentDelivered: false,
    warning: 'Task assigned, but the new owner notification could not be delivered.',
  });
  try {
    const result: any = await directCreateChildSession({ suffix: 'executor', taskId: 'task_delivery_failure', afterSend: 'wait' }, { sessionId: parent.id, session: parent });
    const output = typeof result === 'string' ? result : result.output;
    assert.match(output, /task assignment delivery failed/);
    assert.match(output, /new owner notification could not be delivered/);
    assert.equal(typeof result === 'string' ? undefined : result.__toolPostAction, undefined);
  } finally {
    service.createAttachedChild = original;
    await sessionManager.deleteSession(parent.id);
  }
});

test('real Session moves preserve task owner/creator/attached identities, notification and self-owned reminder progress', async () => {
  const prefix = `task_move_${Date.now()}`;
  const creator = await sessionManager.getSession(`${prefix}_creator`);
  const parent = await sessionManager.getSession(`${prefix}_parent`);
  let child: Awaited<ReturnType<typeof sessionManager.getExistingSession>>;
  let raw: DatabaseSync;
  try {
    const taskId = readResult(await task({ action: 'create', title: 'Linked work across Session moves' }, { sessionId: creator.id })).taskId;
    await task({ action: 'assign', taskId, ownerSessionId: parent.id }, { sessionId: creator.id });
    const created = await create_child_session({ suffix: 'executor', taskId }, { sessionId: parent.id, session: parent });
    child = await sessionManager.getExistingSession(String(created).match(/`([^`]+)`/)![1]);
    const ctx = { sessionId: child.id, session: child };
    const selfId = readResult(await task({ action: 'create', title: 'Self-owned work across rename' }, ctx)).taskId;
    await task({ action: 'claim', taskId: selfId }, ctx);
    const legacy = taskService.store.migrateLegacyGoal(child.id, 'Full legacy Goal across rename', 1);
    raw = new DatabaseSync(taskService.store.filePath, { readOnly: true });
    const refs = (id: string): any => raw.prepare('SELECT createdBySessionId,ownerSessionId,attachedSessionId,reminderLastSeq FROM tasks WHERE id=?').get(id);
    const anchor = refs(selfId).reminderLastSeq;
    taskService.store.taskContext(child.id, Array.from({ length: 29 }, (_, i) => anchor + i + 1), false);
    const transferId = readResult(await task({ action: 'create', title: 'Transfer across aliases' }, { sessionId: creator.id })).taskId;
    await task({ action: 'assign', taskId: transferId, ownerSessionId: child.id }, { sessionId: creator.id });
    const oldCreator = creator.id;
    const oldChild = child.id;
    await sessionManager.moveSessionToTarget({ sourceSessionId: oldCreator, newSessionId: `${prefix}_creator_moved` });
    await sessionManager.moveSessionToTarget({ sourceSessionId: oldChild, newSessionId: `${prefix}_owner_moved` });
    child = await sessionManager.getExistingSession(`${prefix}_owner_moved`);
    const currentCreator = await sessionManager.getExistingSession(`${prefix}_creator_moved`);
    assert.equal(sessionManager.getSessionCatalog(oldChild)?.id, child.id, 'real old ID remains an alias');
    const currentCtx = { sessionId: child.id, session: child };
    const projected = readResult(await task({ action: 'get', taskId }, currentCtx));
    assert.equal(projected.task.createdBySessionId, currentCreator.id);
    assert.equal(projected.task.ownerSessionId, child.id);
    assert.equal(projected.task.attachedSessionId, child.id);
    assert(projected.notes.some((note: any) => note.sessionId === child.id));
    assert.equal(taskService.list().tasks.find((entry: any) => entry.id === taskId).ownerSessionId, child.id);
    assert.equal(refs(taskId).ownerSessionId, oldChild, 'ordinary bounded reads do not rewrite persisted references');
    await task({ action: 'assign', taskId: selfId, ownerSessionId: oldChild, notifySession: true }, currentCtx);
    assert.equal(child.queue.length, 1, 'same canonical owner notification is skipped without a self-send');
    const reminders = taskService.store.taskContext(child.id, [anchor + 30], true);
    assert(reminders.some(entry => entry.id === selfId), 'canonical owner query finds old IDs and retained progress');
    assert.equal(refs(selfId).createdBySessionId, child.id);
    assert.equal(refs(selfId).ownerSessionId, child.id);
    assert.equal(taskService.store.migrateLegacyGoal(child.id, 'Full legacy Goal across rename', 1).id, legacy.id, 'legacy map is retry-safe across aliases');
    await task({ action: 'assign', taskId: transferId, ownerSessionId: oldCreator, notifySession: true }, { sessionId: currentCreator.id });
    const transfer = readResult(await task({ action: 'get', taskId: transferId }, { sessionId: currentCreator.id })).task;
    assert.equal(transfer.ownerSessionId, currentCreator.id, 'creator actor and new owner aliases resolve before permission checks');
    assert.equal(transfer.previousOwnerSessionId, child.id);
    assert.equal(transfer.assignmentNotificationStatus, 'skipped');
    assert.equal(transfer.previousOwnerNotificationStatus, 'sent');
    assert.equal(child.queue.length, 2);
    assert.equal((child.queue[1] as any).trigger, false, 'previous moved owner receives only passive ingress');
    const completed = await executeTools([{ id: 'complete-renamed-child', name: 'call_tool', args: {
      toolId: 'builtin:task', args: { action: 'complete', taskId, result: 'Done after rename' },
    } }], currentCtx, child);
    assert.deepEqual((completed as any).__toolPostAction.completedLinkedTask, { taskId, attachedSessionId: child.id });
    assert.deepEqual((completed as any).__toolPostAction.successfulSendToSessionTargets, [currentCreator.id]);
    assert.equal(currentCreator.queue.length, 1, 'notification reaches the real moved creator');
    assert.equal(currentCreator.queue[0].sourceSessionId, child.id);
    assert.equal(parent.queue.length, 0, 'no fabricated routine report to actual parent');
    assert.equal(refs(taskId).createdBySessionId, currentCreator.id);
    assert.equal(refs(taskId).ownerSessionId, child.id);
    assert.equal(refs(taskId).attachedSessionId, child.id);
  } finally {
    raw?.close();
    if (child) await sessionManager.deleteSession(child.id);
    await sessionManager.deleteSession(sessionManager.getSessionCatalog(creator.id)?.id || creator.id);
    await sessionManager.deleteSession(parent.id);
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
  }
});

test('actual Task notices classify assignment/transfer/release/completion separately while passive recipients remain idle', async () => {
  const prefix = `task_notifications_${Date.now()}`;
  const creator = await sessionManager.getSession(`${prefix}_creator`);
  const first = await sessionManager.getSession(`${prefix}_first`);
  const second = await sessionManager.getSession(`${prefix}_second`);
  const triggered: string[] = [];
  sessionManager.setSessionTriggerCallback(id => { triggered.push(id); });
  try {
    const taskId = readResult(await task({ action: 'create', title: 'Task notifications', ownerSessionId: first.id, notifySession: true }, { sessionId: creator.id })).taskId;
    const notice = (session: typeof creator, index: number, event: string, assignment = false): void => {
      const text = session.queue[index].parts[0].system;
      assert.match(text, /^<foxwarm-message type="task"/);
      assert.match(text, new RegExp(`taskId="${taskId}" event="${event}"`));
      if (assignment) assert.match(text, /Task assignment from Foxwarm/);
      else assert.match(text, /hint="task notification from Foxwarm; not direct user input"/);
      assert.doesNotMatch(text, /replyTargetSessionId|replyVia|type="inter-agent"/);
    };
    notice(first, 0, 'assigned', true);
    assert.deepEqual(triggered, [first.id]);
    await task({ action: 'assign', taskId, ownerSessionId: second.id, notifySession: true }, { sessionId: creator.id });
    notice(first, 1, 'transferred');
    notice(second, 0, 'transferred', true);
    assert.equal(first.queue[1].trigger, false);
    assert.deepEqual(triggered, [first.id, second.id], 'previous recipient admission does not wake it');
    await task({ action: 'assign', taskId, ownerSessionId: null, notifySession: true }, { sessionId: creator.id });
    notice(second, 1, 'released');
    assert.equal(second.queue[1].trigger, false);
    assert.deepEqual(triggered, [first.id, second.id], 'release does not wake the released owner');
    await task({ action: 'claim', taskId }, { sessionId: first.id });
    await task({ action: 'complete', taskId }, { sessionId: first.id });
    notice(creator, 0, 'completed');
    assert.deepEqual(triggered, [first.id, second.id, creator.id]);
    assert.equal(taskService.get(taskId).task.completionNotificationStatus, 'sent');
    await sessionManager.sendToSession(creator.id, 'Ordinary peer message', second.id);
    assert.match(creator.queue[1].parts[0].system, /^<foxwarm-message type="inter-agent"/);
    assert.match(creator.queue[1].parts[0].system, /replyTargetSessionId=.*replyVia="send_to_session"/);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    for (const session of [creator, first, second]) await sessionManager.deleteSession(session.id);
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
  }
});

test('model task mutation receipts stay minimal across direct, unified, Worker and preserve warning while get stays detailed', async () => {
  const prefix = `task_receipt_${Date.now()}`;
  const creator = await sessionManager.getSession(`${prefix}_creator`);
  const owner = await sessionManager.getSession(`${prefix}_owner`);
  const directCtx: any = { sessionId: creator.id, session: creator };
  const workerCtx: any = { sessionId: owner.id, session: owner, sessionPlacement: 'session-worker', persistCurrentSession: async () => { throw new Error('Task must not persist Session state'); } };
  const assertReceipt = (value: any, expectedStatus: string, expectedOwner: string | null) => {
    assert.deepEqual(Object.keys(value).sort(), ['ownerSessionId', 'status', 'taskId']);
    assert.match(value.taskId, /^task_/);
    assert.equal(value.status, expectedStatus);
    assert.equal(value.ownerSessionId, expectedOwner);
    assert.equal(value.title, undefined);
    assert.equal(value.description, undefined);
    assert.equal(value.result, undefined);
    assert.equal(value.note, undefined);
    assert.equal(value.updatedAt, undefined);
    return value.taskId as string;
  };
  try {
    const created = readResult(await task({ action: 'create', title: 'Hidden detail', description: 'Private detail' }, directCtx));
    const taskId = assertReceipt(created, 'open', null);
    const claimed = readResult(await call_tool({ source: 'builtin', name: 'task', args: { action: 'claim', taskId } }, workerCtx));
    assertReceipt(claimed, 'active', owner.id);
    const updated = readResult(await task({ action: 'update', taskId, note: 'Private note' }, workerCtx));
    assertReceipt(updated, 'active', owner.id);
    const details = readResult(await task({ action: 'get', taskId }, directCtx));
    assert.equal(details.task.title, 'Hidden detail');
    assert.equal(details.task.description, 'Private detail');
    assert.equal(details.notes[0].text, 'Private note');
    await sessionManager.deleteSession(creator.id);
    const completed = readResult(await task({ action: 'complete', taskId, result: 'Private result' }, workerCtx));
    assert.equal(completed.taskId, taskId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.ownerSessionId, owner.id);
    assert.match(completed.warning, /completion notification could not be delivered/);
    assert.equal(completed.title, undefined);
    const completedDetails = readResult(await task({ action: 'get', taskId }, workerCtx));
    assert.equal(completedDetails.task.result, 'Private result');
    assert.equal(completedDetails.task.completionNotificationStatus, 'failed');
  } finally {
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    await sessionManager.deleteSession(creator.id).catch(() => false);
    await sessionManager.deleteSession(owner.id).catch(() => false);
  }
});
