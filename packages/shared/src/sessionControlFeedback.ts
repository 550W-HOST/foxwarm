export type SessionControlAction = 'stop' | 'continue' | 'dequeue' | 'cancel-compaction' | 'compact';
export interface SessionControlFeedback {
  action: SessionControlAction;
  status: 'accepted' | 'noop' | 'error';
  message: string;
  details?: string;
}

export function parseSessionControlFeedback(value: unknown): SessionControlFeedback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const feedback = value as Record<string, unknown>;
  if ((typeof feedback.action !== 'string' || !['stop','continue','dequeue','cancel-compaction','compact'].includes(feedback.action))
    || (typeof feedback.status !== 'string' || !['accepted','noop','error'].includes(feedback.status))
    || typeof feedback.message !== 'string' || !feedback.message || feedback.message.length > 512
    || (feedback.details !== undefined && (typeof feedback.details !== 'string' || feedback.details.length > 4096))) return null;
  return { action: feedback.action as SessionControlAction, status: feedback.status as SessionControlFeedback['status'], message: feedback.message, ...(feedback.details ? { details: feedback.details as string } : {}) };
}

export function getSessionControlAction(command: string): SessionControlAction | null {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (/^\/compact(?: |$)/.test(normalized)) return 'compact';
  if (/^\/continue(?: |$)/.test(normalized)) return 'continue';
  if (/^\/dequeue(?: |$)/.test(normalized)) return 'dequeue';
  return normalized === '/stop' ? 'stop' : normalized === '/stop compact' ? 'cancel-compaction' : null;
}
