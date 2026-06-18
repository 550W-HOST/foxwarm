export type SessionIdentityHintVariant = 'inherited' | 'compact' | 'new-child';

export function formatSessionIdentityHint(options: {
  parentSessionId?: string;
  sessionId: string;
  variant?: SessionIdentityHintVariant;
}): string {
  const parentSessionId = typeof options.parentSessionId === 'string' && options.parentSessionId.trim()
    ? options.parentSessionId.trim()
    : '(none)';
  const sessionId = options.sessionId;
  const variant = options.variant || 'inherited';

  if (variant === 'compact') {
    return `**COMPACTION COMPLETED. PARENT SESSION \`${parentSessionId}\`. CURRENT SESSION ID IS \`${sessionId}\`.**`;
  }

  if (variant === 'new-child') {
    return `**NEW CHILD SESSION WITH PARENT SESSION \`${parentSessionId}\`. CURRENT SESSION ID IS \`${sessionId}\`.**`;
  }

  return `**HISTORY ABOVE IS INHERITED FROM PARENT SESSION \`${parentSessionId}\`. CURRENT SESSION ID IS \`${sessionId}\`.**`;
}
