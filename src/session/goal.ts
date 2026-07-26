import { Message, Session, SessionGoalState } from '../types';
import { partsContainNoActionSignal } from './childSessionReminder';
import { buildSystemMessageParts } from '../utils/systemMessageParts';
import { formatFoxwarmSystem } from '../utils/promptWrappers';

const GOAL_REMINDER_META_KEY = 'goalReminder';
const GOAL_REMINDER_SYSTEM_KIND = 'goal-reminder';
const GOAL_REMINDER_GUIDANCE = 'Keep this long-term goal in mind when deciding what to do next.';
export const DEFAULT_GOAL_REMIND_EVERY = 10;

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

export function normalizeGoalText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('goal must be a string.');
  }

  const normalized = value.trim();
  return normalized;
}

function getLatestSessionMessageSeq(session: Session): number {
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

export function isGoalReminderMessage(message: Message): boolean {
  return message.__meta?.[GOAL_REMINDER_META_KEY] === true;
}

function getLatestCountedMessageSeq(session: Session): number {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (isGoalReminderMessage(message)) {
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
    if (!isGoalReminderMessage(message)) {
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

function latestMessageSuppressesGoalReminder(session: Session): boolean {
  const latestMessage = getLatestNonReminderMessage(session);
  return latestMessage?.role === 'model' && partsContainNoActionSignal(latestMessage.parts);
}

function hasGoalReminderForAnchorSeq(session: Session, anchorSeq: number): boolean {
  if (anchorSeq <= 0) {
    return false;
  }

  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (isGoalReminderMessage(message) && message.__meta?.goalAnchorSeq === anchorSeq) {
      return true;
    }
  }

  return false;
}

function buildGoalReminderMessage(state: SessionGoalState, anchorSeq: number): Message {
  return {
    role: 'user',
    parts: buildSystemMessageParts(formatSessionGoalReminderText(state.goal)),
    __meta: {
      timestamp: Date.now(),
      [GOAL_REMINDER_META_KEY]: true,
      goalAnchorSeq: anchorSeq,
      goalReminderKind: 'interval',
    },
  };
}

export function formatSessionGoalReminderText(goal: string): string {
  return formatFoxwarmSystem({ kind: GOAL_REMINDER_SYSTEM_KIND }, `${goal.trim()}\n${GOAL_REMINDER_GUIDANCE}`);
}

export function countNonReminderMessagesAfterSeq(session: Session, anchorSeq: number): number {
  let count = 0;

  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    const seq = message.__meta?.seq;

    if (typeof seq !== 'number' || seq <= anchorSeq) {
      break;
    }

    if (!isGoalReminderMessage(message)) {
      count++;
    }
  }

  return count;
}

export function resolveSessionGoalRemindEvery(session: Session, value: unknown): number {
  if (value !== undefined) {
    return normalizeRemindEvery(value);
  }

  if (typeof session.goalState?.remindEvery === 'number') {
    return normalizeRemindEvery(session.goalState.remindEvery);
  }

  return DEFAULT_GOAL_REMIND_EVERY;
}

export function setSessionGoal(session: Session, goal: string, remindEvery: number): SessionGoalState {
  const normalizedGoal = normalizeGoalText(goal);
  const normalizedRemindEvery = normalizeRemindEvery(remindEvery);

  const state: SessionGoalState = {
    goal: normalizedGoal,
    remindEvery: normalizedRemindEvery,
    anchorSeq: getLatestSessionMessageSeq(session),
    updatedAt: Date.now(),
  };

  session.goalState = state;
  return state;
}

export function clearSessionGoal(session: Session): boolean {
  if (!session.goalState) {
    return false;
  }

  delete session.goalState;
  return true;
}

export function maybeBuildGoalReminderMessage(session: Session): Message | null {
  const state = session.goalState;
  if (!state) {
    return null;
  }

  if (latestMessageSuppressesGoalReminder(session)) {
    return null;
  }

  const latestUserMessage = getLatestUserMessage(session);
  if (latestUserMessage && isGoalReminderMessage(latestUserMessage)) {
    return null;
  }

  const countedMessagesSinceAnchor = countNonReminderMessagesAfterSeq(session, state.anchorSeq);
  if (countedMessagesSinceAnchor < state.remindEvery) {
    return null;
  }

  const currentSeq = getLatestCountedMessageSeq(session);
  if (hasGoalReminderForAnchorSeq(session, currentSeq)) {
    return null;
  }

  state.anchorSeq = currentSeq;

  return buildGoalReminderMessage(state, currentSeq);
}
