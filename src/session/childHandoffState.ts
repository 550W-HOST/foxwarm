import type { QueueItem, Session } from '../types';

export type ChildHandoffState = NonNullable<Session['childHandoffState']>;

export function getChildHandoffBoundaryForQueueItem(
  item: Pick<QueueItem, 'type' | 'sourceSessionRelation'>,
): ChildHandoffState | undefined {
  if (item.type === 'user') {
    return { boundary: 'direct-user', resolved: true };
  }
  if (item.type === 'intersession'
    && (item.sourceSessionRelation === 'parent' || item.sourceSessionRelation === 'other')) {
    return { boundary: 'report-required', resolved: false };
  }
  return undefined;
}

export function applyChildHandoffQueueItem(session: Session, item: QueueItem): boolean {
  const boundary = getChildHandoffBoundaryForQueueItem(item);
  if (!boundary) return false;
  session.childHandoffState = boundary;
  return true;
}

export function resolveChildHandoffBoundary(session: Session): boolean {
  const state = session.childHandoffState;
  if (!state || state.boundary !== 'report-required' || state.resolved) return false;
  state.resolved = true;
  return true;
}

export function shouldQueueChildHandoffReminder(session: Session): boolean | undefined {
  const state = session.childHandoffState;
  if (!state) return undefined;
  return state.boundary === 'report-required' && !state.resolved;
}