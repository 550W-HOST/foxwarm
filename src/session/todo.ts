import { Message, Session, SessionTodoState } from '../types';

const TODO_REMINDER_META_KEY = 'todoReminder';
const TODO_REMINDER_SYSTEM_PREFIX = 'TODO reminder for this session:';
const CHECKLIST_ITEM_REGEX = /(?:^|\n)\s*-\s*\[\s\]\s+\S/;

export function normalizeRemindEvery(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new Error('remindEvery must be a positive integer.');
  }

  const normalized = Math.trunc(num);
  if (normalized < 1) {
    throw new Error('remindEvery must be at least 1.');
  }

  return normalized;
}

export function normalizeTodoText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('todo must be a string.');
  }

  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  if (!CHECKLIST_ITEM_REGEX.test(normalized)) {
    throw new Error('todo must include at least one markdown checklist item like `- [ ] task`.');
  }

  return normalized;
}

export function getLatestSessionMessageSeq(session: Session): number {
  if (typeof session.nextMessageSeq === 'number' && session.nextMessageSeq > 0) {
    return session.nextMessageSeq - 1;
  }

  let maxSeq = 0;
  for (const message of session.history) {
    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  return maxSeq;
}

export function isTodoReminderMessage(message: Message): boolean {
  return message.__meta?.[TODO_REMINDER_META_KEY] === true;
}

export function getLatestCountedMessageSeq(session: Session): number {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (isTodoReminderMessage(message)) {
      continue;
    }

    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > 0) {
      return seq;
    }
  }

  return getLatestSessionMessageSeq(session);
}

export function countNonReminderMessagesAfterSeq(session: Session, anchorSeq: number): number {
  let count = 0;

  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    const seq = message.__meta?.seq;

    if (typeof seq !== 'number' || seq <= anchorSeq) {
      break;
    }

    if (!isTodoReminderMessage(message)) {
      count++;
    }
  }

  return count;
}

export function setSessionTodo(session: Session, todo: string, remindEvery: number): SessionTodoState {
  const normalizedTodo = normalizeTodoText(todo);
  const normalizedRemindEvery = normalizeRemindEvery(remindEvery);

  const state: SessionTodoState = {
    todo: normalizedTodo,
    remindEvery: normalizedRemindEvery,
    anchorSeq: getLatestSessionMessageSeq(session),
    updatedAt: Date.now(),
  };

  session.todoState = state;
  return state;
}

export function clearSessionTodo(session: Session): boolean {
  if (!session.todoState) {
    return false;
  }

  delete session.todoState;
  return true;
}

export function maybeBuildTodoReminderMessage(session: Session): Message | null {
  const state = session.todoState;
  if (!state) {
    return null;
  }

  const countedMessagesSinceAnchor = countNonReminderMessagesAfterSeq(session, state.anchorSeq);
  if (countedMessagesSinceAnchor < state.remindEvery) {
    return null;
  }

  const currentSeq = getLatestCountedMessageSeq(session);

  state.anchorSeq = currentSeq;

  return {
    role: 'user',
    parts: [{ system: `${TODO_REMINDER_SYSTEM_PREFIX}\n${state.todo}` }],
    __meta: {
      timestamp: Date.now(),
      [TODO_REMINDER_META_KEY]: true,
      todoAnchorSeq: currentSeq,
    },
  };
}
