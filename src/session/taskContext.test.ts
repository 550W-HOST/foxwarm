import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message, Session } from '../types';
import * as sessionManager from '../sessionManager';
import * as metadataStore from './metadataStore';
import { taskService } from '../tools/taskTools';
import { createTaskRequestContext, ordinaryVisibleSequences } from './taskContext';
import { writeAuthoritativeSessionState } from './stateFile';
import { shutdownMainManagementTools, resetMainManagementToolsForTests } from '../mainManagementTools';
import { definitions } from '../tools/definitions';
import * as tools from '../tools';

const message = (seq: number): Message => ({ role: 'model', parts: [{ text: `Progress ${seq}` }], __meta: { seq } });

test('ordinary task progress counts visible content but not hidden/control/context-block messages', () => {
  const session = { history: [message(1), { ...message(2), modelVisible: false },
    { role: 'user', parts: [{ system: '<foxwarm-system kind="session-boundary" />' }], __meta: { seq: 3 } },
    { ...message(4), __meta: { seq: 4, goalReminder: true } },
    { ...message(5), __meta: { seq: 5, contextBlock: { blockId: 1 } } as any },
    { role: 'tool', parts: [{ functionResponse: { name: 'fixture', response: { output: 'ok' } } }], __meta: { seq: 6 } },
    ...Array.from({ length: 40 }, (_, i) => message(i + 7))] } as Session;
  assert.deepEqual(ordinaryVisibleSequences({ ...session, history: session.history.slice(0, 6) }), [1, 6]);
  assert.equal(ordinaryVisibleSequences(session).length, 30);
  assert.equal(ordinaryVisibleSequences(session)[0], 17);
});

test('legacy Goal is cleared only on a successful authority save; task context is request-only and fixed30', async () => {
  const id = `task_migration_${Date.now()}`;
  const owner = await sessionManager.getSession(id);
  const oldGoal = { goal: 'Keep this work active', remindEvery: 2, anchorSeq: 0, updatedAt: 1 };
  owner.goalState = oldGoal;
  const originalWrite = metadataStore.writeSessionHistoryAtomically;
  let captured: any;
  (metadataStore as any).writeSessionHistoryAtomically = async (_id: string, payload: any) => { captured = payload; throw new Error('synthetic authority failure'); };
  try {
    await assert.rejects(() => writeAuthoritativeSessionState(owner), /synthetic authority failure/);
    assert.strictEqual(owner.goalState, oldGoal);
    assert.equal(captured.goalState, undefined);
    const migrated = taskService.store.migrateLegacyGoal(id, oldGoal.goal, 0);
    (metadataStore as any).writeSessionHistoryAtomically = originalWrite;
    await writeAuthoritativeSessionState(owner);
    assert.equal(owner.goalState, undefined);
    assert.equal((await metadataStore.readSessionHistorySnapshot(id)).goalState, undefined);
    assert.equal(taskService.store.migrateLegacyGoal(id, oldGoal.goal, 0).id, migrated.id);
    owner.history = Array.from({ length: 29 }, (_, i) => message(i + 1));
    owner.nextMessageSeq = 30;
    const before = JSON.stringify(owner);
    assert.deepEqual(await createTaskRequestContext(owner)(), []);
    assert.equal(JSON.stringify(owner), before);
    owner.history.push(message(30));
    owner.nextMessageSeq = 31;
    const beforeDue = JSON.stringify(owner);
    const request = createTaskRequestContext(owner);
    const context = await request();
    assert.match(context[0].parts[0].system, /task-reminder/);
    assert.match(context[0].parts[0].system, new RegExp(`${migrated.id}.*Keep this work active.*active`));
    assert.equal(JSON.stringify(owner), beforeDue, 'no history/queue/Goal mutation and no idle wake');
    assert.deepEqual(await createTaskRequestContext(owner)(), [], 'a later request with no progress does not repeat');
    assert.deepEqual(await request(), context, 'the same request retry keeps its context without another reminder event');
    await taskService.execute({ action: 'complete', taskId: migrated.id }, id);
    assert.deepEqual(await request(), [], 'completion removes stale context even on retry');
    assert.equal(taskService.store.migrateLegacyGoal(id, oldGoal.goal, 0).status, 'completed');
    assert.equal(definitions.some(definition => definition.name === 'set_goal'), false);
    assert.equal((tools as any).set_goal, undefined);
    assert.equal((definitions.find(definition => definition.name === 'task')!.parameters as any).properties.reminderEvery, undefined);
  } finally {
    (metadataStore as any).writeSessionHistoryAtomically = originalWrite;
    await shutdownMainManagementTools();
    resetMainManagementToolsForTests();
    await sessionManager.deleteSession(id);
  }
});
