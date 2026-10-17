/** Trusted, display-only operational events. Ordinary assistant prose is never inferred to be an event. */
export interface SessionNotice {
  version: 1;
  id: string;
  source: 'compaction' | 'model-request' | 'session';
  severity: 'info' | 'warning' | 'error';
  title: string;
  summary: string;
  details?: string;
}

export function parseSessionNotice(value: unknown): SessionNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const notice = value as Record<string, unknown>;
  const bounded = (input: unknown, max: number) => typeof input === 'string' && input.length > 0 && input.length <= max;
  if (notice.version !== 1 || !bounded(notice.id, 128)
    || (typeof notice.source !== 'string' || !['compaction', 'model-request', 'session'].includes(notice.source))
    || (typeof notice.severity !== 'string' || !['info', 'warning', 'error'].includes(notice.severity))
    || !bounded(notice.title, 100) || !bounded(notice.summary, 300)
    || (notice.details !== undefined && !bounded(notice.details, 32768))) return null;
  return {
    version: 1, id: notice.id as string, source: notice.source as SessionNotice['source'],
    severity: notice.severity as SessionNotice['severity'], title: notice.title as string,
    summary: notice.summary as string, ...(notice.details ? { details: notice.details as string } : {}),
  };
}
