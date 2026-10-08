import type { Message, Session } from '../types';
import { isModelVisibleMessage } from './messageVisibility';
import { getMainTaskContext, migrateMainLegacyGoal } from '../mainManagementTools';
import { formatFoxwarmSystem } from '../utils/promptWrappers';

export function ordinaryVisibleSequences(session: Session): number[] {
  return [...new Set(session.history.filter(message => isModelVisibleMessage(message)
    && !message.__meta?.goalReminder && !message.__meta?.contextBlock
    && message.parts.some(part => !!part.text || !!part.functionCall || !!part.functionResponse || !!part.inlineData || !!part.inlineDataRef))
    .map(message => message.__meta?.seq)
    .filter((seq): seq is number => Number.isSafeInteger(seq) && seq > 0))].sort((a, b) => a - b).slice(-30);
}

/** The caller owns the exact Session and clears legacy state only at a successful authority save. */
export async function migrateLegacySessionGoal(session: Session): Promise<void> {
  const legacy = session.goalState;
  if (!legacy) return;
  if (typeof legacy.goal !== 'string') throw new Error('Legacy Session goal cannot be migrated without its text.');
  if (legacy.goal.trim()) await migrateMainLegacyGoal({ sourceSessionId: session.id, goal: legacy.goal,
    anchorSeq: Number.isSafeInteger(legacy.anchorSeq) && legacy.anchorSeq >= 0 ? legacy.anchorSeq : Math.max(0, (session.nextMessageSeq ?? 1) - 1) });
  delete session.goalState;
}

export async function checkpointTaskProgress(session: Session): Promise<void> {
  await getMainTaskContext({ sourceSessionId: session.id, sequences: ordinaryVisibleSequences(session), consume: false });
}

/** One normal provider request (including its retries) keeps a bounded ephemeral context. */
export function createTaskRequestContext(session: Session): () => Promise<Message[]> {
  let retainedTaskIds: string[] = [];
  return async () => {
    const result = await getMainTaskContext({ sourceSessionId: session.id, sequences: ordinaryVisibleSequences(session), consume: true, retainedTaskIds });
    retainedTaskIds = result.tasks.map(task => task.id);
    if (!result.tasks.length) return [];
    const lines = result.tasks.map(task => `${task.id} — ${task.title} (${task.status})`);
    if (result.omitted) lines.push(`${result.omitted} more tasks.`);
    return [{ role: 'user', parts: [{ system: formatFoxwarmSystem({ kind: 'task-reminder' }, `Continue the active tasks:\n${lines.join('\n')}`) }] }];
  };
}
