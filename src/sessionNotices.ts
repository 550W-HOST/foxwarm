import { randomUUID } from 'node:crypto';
import type { SessionNotice } from '../packages/shared/dist/sessionNotice';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import type { Message } from './types';

const publishedFailures = new WeakMap<object, Set<string>>();

export function createSessionNoticeMessage(notice: Omit<SessionNotice, 'version' | 'id'> & { id?: string }): Message {
  const metadata: SessionNotice = {
    ...notice, version: 1, id: notice.id || randomUUID(),
    title: notice.title.slice(0, 100), summary: notice.summary.slice(0, 300),
    ...(notice.details ? { details: notice.details.length > 32768 ? `${notice.details.slice(0, 32740)}\n[Details truncated]` : notice.details } : {}),
  };
  return createDisplayOnlyModelMessage(notice.details || notice.summary, { noticeType: 'system-event', sessionNotice: metadata });
}

export function markSystemFailurePublished(sessionId: string, error: unknown): void {
  if (error && typeof error === 'object') {
    const sessions = publishedFailures.get(error) || new Set<string>();
    sessions.add(sessionId); publishedFailures.set(error, sessions);
  }
}

export function isSystemFailurePublished(sessionId: string, error: unknown): boolean {
  return !!error && typeof error === 'object' && publishedFailures.get(error)?.has(sessionId) === true;
}
