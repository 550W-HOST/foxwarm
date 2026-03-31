import { Message, Session, SessionTodoState } from '../types';
import { partsContainNoActionSignal } from './childSessionReminder';

const TODO_REMINDER_META_KEY = 'todoReminder';
const TODO_REMINDER_SYSTEM_PREFIX = 'TODO reminder for this session:';
const CHECKLIST_ITEM_REGEX = /(?:^|\n)\s*-\s*\[\s\]\s+\S/;

type TodoReminderKind = 'interval' | 'end-turn';

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

function getLatestNonReminderMessage(session: Session): Message | null {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (!isTodoReminderMessage(message)) {
      return message;
    }
  }

  return null;
}

function getLatestUserMessage(session: Session): Message | null {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (message.role === 'user') {
      return message;
    }
  }

  return null;
}

function latestMessageSuppressesTodoReminder(session: Session): boolean {
  const latestMessage = getLatestNonReminderMessage(session);
  return latestMessage?.role === 'model' && partsContainNoActionSignal(latestMessage.parts);
}

function hasTodoReminderForAnchorSeq(session: Session, anchorSeq: number): boolean {
  if (anchorSeq <= 0) {
    return false;
  }

  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (isTodoReminderMessage(message) && message.__meta?.todoAnchorSeq === anchorSeq) {
      return true;
    }
  }

  return false;
}

function buildTodoReminderMessage(state: SessionTodoState, anchorSeq: number, kind: TodoReminderKind): Message {
  return {
    role: 'user',
    parts: [{ system: `${TODO_REMINDER_SYSTEM_PREFIX}\n${state.todo}` }],
    __meta: {
      timestamp: Date.now(),
      [TODO_REMINDER_META_KEY]: true,
      todoAnchorSeq: anchorSeq,
      todoReminderKind: kind,
    },
  };
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

  if (latestMessageSuppressesTodoReminder(session)) {
    return null;
  }

  const latestUserMessage = getLatestUserMessage(session);
  if (latestUserMessage && isTodoReminderMessage(latestUserMessage)) {
    return null;
  }

  const countedMessagesSinceAnchor = countNonReminderMessagesAfterSeq(session, state.anchorSeq);
  if (countedMessagesSinceAnchor < state.remindEvery) {
    return null;
  }

  const currentSeq = getLatestCountedMessageSeq(session);
  if (hasTodoReminderForAnchorSeq(session, currentSeq)) {
    return null;
  }

  state.anchorSeq = currentSeq;

  return buildTodoReminderMessage(state, currentSeq, 'interval');
}

export function maybeBuildTodoEndTurnReminderMessage(session: Session): Message | null {
  const state = session.todoState;
  if (!state) {
    return null;
  }

  if (latestMessageSuppressesTodoReminder(session)) {
    return null;
  }

  const latestUserMessage = getLatestUserMessage(session);
  if (latestUserMessage && isTodoReminderMessage(latestUserMessage)) {
    return null;
  }

  const currentSeq = getLatestCountedMessageSeq(session);
  if (currentSeq <= state.anchorSeq) {
    return null;
  }

  if (hasTodoReminderForAnchorSeq(session, currentSeq)) {
    return null;
  }

  state.anchorSeq = currentSeq;
  return buildTodoReminderMessage(state, currentSeq, 'end-turn');
}
