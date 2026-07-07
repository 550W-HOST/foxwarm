import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../types';
import { DEFAULT_GOAL_REMIND_EVERY, maybeBuildGoalEndTurnReminderMessage, maybeBuildGoalReminderMessage, resolveSessionGoalRemindEvery, resolveSessionGoalRemindOnTurnEnd, setSessionGoal } from './goal';

test('goal reminder uses one foxwarm-system part wrapping the reminder payload', () => {
  const session = {
    history: [{ role: 'model', parts: [{ text: 'progress update' }], __meta: { seq: 1, timestamp: 1 } }],
    nextMessageSeq: 2,
    goalState: {
      goal: 'Ship feature without losing compacted context',
      remindEvery: 1,
      anchorSeq: 0,
      updatedAt: 1,
    },
  } as Session;

  const reminder = maybeBuildGoalReminderMessage(session);
  assert.ok(reminder);
  assert.deepEqual(reminder.parts, [
    { system: '<foxwarm-system kind="goal-reminder">\nShip feature without losing compacted context\nKeep this long-term goal in mind when deciding what to do next.\n</foxwarm-system>' },
  ]);
  assert.equal(session.goalState?.anchorSeq, 1);
});

test('setSessionGoal stores remindOnTurnEnd and end-turn reminders honor disabled setting', () => {
  const session = {
    history: [{ role: 'model', parts: [{ text: 'progress update' }], __meta: { seq: 1, timestamp: 1 } }],
    nextMessageSeq: 2,
  } as Session;

  setSessionGoal(session, 'Ship feature safely', 3, false);
  assert.equal(session.goalState?.remindOnTurnEnd, false);
  assert.equal(maybeBuildGoalEndTurnReminderMessage(session), null);
});

test('goal remindEvery defaults to current value or 10 when omitted', () => {
  const withExisting = {
    history: [],
    goalState: {
      goal: 'Existing goal',
      remindEvery: 4,
      remindOnTurnEnd: true,
      anchorSeq: 0,
      updatedAt: 1,
    },
  } as Session;

  const withoutExisting = { history: [] } as Session;

  assert.equal(resolveSessionGoalRemindEvery(withExisting, undefined), 4);
  assert.equal(resolveSessionGoalRemindEvery(withoutExisting, undefined), DEFAULT_GOAL_REMIND_EVERY);
  assert.equal(resolveSessionGoalRemindOnTurnEnd(withExisting, undefined), true);
  assert.equal(resolveSessionGoalRemindOnTurnEnd(withoutExisting, undefined), true);
});