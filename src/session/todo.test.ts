import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../types';
import { DEFAULT_TODO_REMIND_EVERY, maybeBuildTodoEndTurnReminderMessage, maybeBuildTodoReminderMessage, resolveSessionTodoRemindEvery, resolveSessionTodoRemindOnTurnEnd, setSessionTodo } from './todo';

test('todo reminder uses a system header part plus a plain text payload part', () => {
  const session = {
    history: [{ role: 'model', parts: [{ text: 'progress update' }], __meta: { seq: 1, timestamp: 1 } }],
    nextMessageSeq: 2,
    todoState: {
      todo: '- [ ] ship feature',
      remindEvery: 1,
      anchorSeq: 0,
      updatedAt: 1,
    },
  } as Session;

  const reminder = maybeBuildTodoReminderMessage(session);
  assert.ok(reminder);
  assert.deepEqual(reminder.parts, [
    { system: 'TODO reminder for this session:' },
    {
      text: 'Update it: mark done items [x], reorder/edit remaining work, and clear it if finished.\n- [ ] ship feature',
      systemPayload: true,
    },
  ]);
  assert.equal(session.todoState?.anchorSeq, 1);
});

test('setSessionTodo stores remindOnTurnEnd and end-turn reminders honor disabled setting', () => {
  const session = {
    history: [{ role: 'model', parts: [{ text: 'progress update' }], __meta: { seq: 1, timestamp: 1 } }],
    nextMessageSeq: 2,
  } as Session;

  setSessionTodo(session, '- [ ] ship feature', 3, false);
  assert.equal(session.todoState?.remindOnTurnEnd, false);
  assert.equal(maybeBuildTodoEndTurnReminderMessage(session), null);
});

test('todo remindEvery defaults to current value or 10 when omitted', () => {
  const withExisting = {
    history: [],
    todoState: {
      todo: '- [ ] existing',
      remindEvery: 4,
      remindOnTurnEnd: true,
      anchorSeq: 0,
      updatedAt: 1,
    },
  } as Session;

  const withoutExisting = { history: [] } as Session;

  assert.equal(resolveSessionTodoRemindEvery(withExisting, undefined), 4);
  assert.equal(resolveSessionTodoRemindEvery(withoutExisting, undefined), DEFAULT_TODO_REMIND_EVERY);
  assert.equal(resolveSessionTodoRemindOnTurnEnd(withExisting, undefined), true);
  assert.equal(resolveSessionTodoRemindOnTurnEnd(withoutExisting, undefined), true);
});