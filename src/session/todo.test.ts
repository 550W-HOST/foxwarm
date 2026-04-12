import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../types';
import { maybeBuildTodoReminderMessage } from './todo';

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