import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { formatLocalTimestamp } from '../utils/localTime';

export type SessionIdentityHintVariant = 'inherited' | 'compact' | 'new-child';

export function formatSessionIdentityHint(options: {
  parentSessionId?: string;
  sessionId: string;
  variant?: SessionIdentityHintVariant;
  timestamp?: Date | number;
}): string {
  const parentSessionId = typeof options.parentSessionId === 'string' && options.parentSessionId.trim()
    ? options.parentSessionId.trim()
    : '(none)';
  const sessionId = options.sessionId;
  const variant = options.variant || 'inherited';

  const event = variant === 'compact'
    ? 'compact-completed'
    : variant === 'new-child'
      ? 'new-child'
      : 'history-inherited';

  return formatFoxwarmSystemTag({
    kind: 'session-boundary',
    event,
    parentSessionId,
    currentSessionId: sessionId,
    time: options.timestamp === undefined ? undefined : formatLocalTimestamp(options.timestamp),
  });
}
