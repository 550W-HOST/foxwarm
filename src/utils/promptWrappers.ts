import {
  escapeFoxwarmAttributeValue,
  escapeFoxwarmTextContent,
  formatFoxwarmAttributes,
  unescapeFoxwarmAttributeValue,
  type FoxwarmAttributeValue,
} from '../../packages/shared/dist/foxwarmMarkup';

export {
  escapeFoxwarmAttributeValue,
  escapeFoxwarmTextContent,
  formatFoxwarmAttributes,
  unescapeFoxwarmAttributeValue,
  type FoxwarmAttributeValue,
};

const FOXWARM_METADATA_LINE_RE = /^\s*<\/?foxwarm-(?:system|metadata|message)\b/i;
const FOXWARM_TAG_LINE_RE = /^\s*<\/?foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)\/?\s*>\s*$/i;
const FOXWARM_OPENING_TAG_RE = /^\s*<foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)>\s*/i;
const FOXWARM_MESSAGE_CLOSE_RE = /^\s*<\/foxwarm-message\s*>\s*$/i;

export function formatFoxwarmSystemTag(attrs: Record<string, FoxwarmAttributeValue>): string {
  const attrText = formatFoxwarmAttributes(attrs);
  return attrText ? `<foxwarm-system ${attrText} />` : '<foxwarm-system />';
}

export function formatFoxwarmSystemOpen(attrs: Record<string, FoxwarmAttributeValue>): string {
  const attrText = formatFoxwarmAttributes(attrs);
  return attrText ? `<foxwarm-system ${attrText}>` : '<foxwarm-system>';
}

export function formatFoxwarmSystemClose(): string {
  return '</foxwarm-system>';
}

export function formatFoxwarmSystem(attrs: Record<string, FoxwarmAttributeValue>, content?: string): string {
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  return normalizedContent
    ? `${formatFoxwarmSystemOpen(attrs)}\n${normalizedContent}\n${formatFoxwarmSystemClose()}`
    : formatFoxwarmSystemTag(attrs);
}

export function formatFoxwarmSystemHint(hint: string, attrs: Record<string, FoxwarmAttributeValue> = {}): string {
  return formatFoxwarmSystemTag({ ...attrs, hint });
}

export function formatFoxwarmMessageOpen(attrs: Record<string, FoxwarmAttributeValue>): string {
  const attrText = formatFoxwarmAttributes(attrs);
  return attrText ? `<foxwarm-message ${attrText}>` : '<foxwarm-message>';
}

export function formatFoxwarmMessageClose(): string {
  return '</foxwarm-message>';
}

export function formatFoxwarmMessage(attrs: Record<string, FoxwarmAttributeValue>, content: string): string {
  return `${formatFoxwarmMessageOpen(attrs)}\n${content}\n${formatFoxwarmMessageClose()}`;
}

export function isFoxwarmMetadataLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_METADATA_LINE_RE.test(text);
}

export function isFoxwarmMessageCloseLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_MESSAGE_CLOSE_RE.test(text);
}

export function isFoxwarmTagLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_TAG_LINE_RE.test(text);
}

function parseFoxwarmAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
    attrs[attrMatch[1]] = unescapeFoxwarmAttributeValue(attrMatch[2]);
  }
  return attrs;
}

export function parseFoxwarmTagLine(text: string | undefined | null): { tagName: string; closing: boolean; attrs: Record<string, string> } | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = text.match(FOXWARM_TAG_LINE_RE);
  if (!match) {
    return undefined;
  }
  const closing = /^\s*<\//.test(text);
  const tagName = `foxwarm-${match[1].toLowerCase()}`;
  const attrs = parseFoxwarmAttrs(match[2] || '');
  return { tagName, closing, attrs };
}

export function parseFoxwarmOpeningTag(text: string | undefined | null): { tagName: string; closing: false; attrs: Record<string, string> } | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = text.match(FOXWARM_OPENING_TAG_RE);
  if (!match) {
    return undefined;
  }
  return {
    tagName: `foxwarm-${match[1].toLowerCase()}`,
    closing: false,
    attrs: parseFoxwarmAttrs(match[2] || ''),
  };
}

export function parseFoxwarmWrappedContent(text: string | undefined | null): { tagName: string; attrs: Record<string, string>; content: string } | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = text.match(/^\s*<foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)>\s*\n?([\s\S]*)\n?\s*<\/foxwarm-\1\s*>\s*$/i);
  if (!match) {
    return undefined;
  }
  return {
    tagName: `foxwarm-${match[1].toLowerCase()}`,
    attrs: parseFoxwarmAttrs(match[2] || ''),
    content: match[3] || '',
  };
}

function normalizeSelfClosingSystemTagWithPayload(system: string): string | undefined {
  const firstNewlineIndex = system.indexOf('\n');
  if (firstNewlineIndex === -1) {
    return undefined;
  }
  const firstLine = system.slice(0, firstNewlineIndex).trim();
  if (!/\/\>\s*$/.test(firstLine)) {
    return undefined;
  }
  const tag = parseFoxwarmTagLine(firstLine);
  if (tag?.tagName !== 'foxwarm-system' || tag.closing) {
    return undefined;
  }
  return formatFoxwarmSystem(tag.attrs, system.slice(firstNewlineIndex + 1));
}

function formatLegacySessionIdentityForModel(system: string): string | undefined {
  const patterns: Array<{ event: string; re: RegExp }> = [
    {
      event: 'compact-completed',
      re: /^\*\*COMPACTION COMPLETED\. PARENT SESSION `([^`]*)`\. CURRENT SESSION ID IS `([^`]*)`\.\*\*([\s\S]*)$/i,
    },
    {
      event: 'new-child',
      re: /^\*\*NEW CHILD SESSION WITH PARENT SESSION `([^`]*)`\. CURRENT SESSION ID IS `([^`]*)`\.\*\*([\s\S]*)$/i,
    },
    {
      event: 'history-inherited',
      re: /^\*\*HISTORY ABOVE IS INHERITED FROM PARENT SESSION `([^`]*)`\. CURRENT SESSION ID IS `([^`]*)`\.\*\*([\s\S]*)$/i,
    },
  ];

  for (const pattern of patterns) {
    const match = system.match(pattern.re);
    if (match) {
      const attrs = {
        kind: 'session-boundary',
        event: pattern.event,
        parentSessionId: match[1],
        currentSessionId: match[2],
      };
      const payload = match[3]?.trim();
      return pattern.event === 'compact-completed'
        ? formatFoxwarmSystemTag({ ...attrs, hint: payload || undefined })
        : formatFoxwarmSystem(attrs, payload);
    }
  }

  return undefined;
}

function formatLegacySystemTextForModel(system: string): string | undefined {
  const normalizedSelfClosingWithPayload = normalizeSelfClosingSystemTagWithPayload(system);
  if (normalizedSelfClosingWithPayload) {
    return normalizedSelfClosingWithPayload;
  }

  const legacyIdentity = formatLegacySessionIdentityForModel(system);
  if (legacyIdentity) {
    return legacyIdentity;
  }

  const currentTimeMatch = system.match(/^current time\s*=\s*(.+)$/i);
  if (currentTimeMatch) {
    return formatFoxwarmSystemTag({ kind: 'time', localTime: currentTimeMatch[1].trim() });
  }

  const currentSessionMatch = system.match(/^current session ID\s*=\s*(.+)$/i);
  if (currentSessionMatch) {
    return formatFoxwarmSystemTag({ kind: 'session', currentSessionId: currentSessionMatch[1].trim() });
  }

  const goalReminderMatch = system.match(/^Session goal reminder:\s*\n?([\s\S]*)$/i);
  if (goalReminderMatch) {
    return formatFoxwarmSystem({ kind: 'goal-reminder' }, goalReminderMatch[1]);
  }

  if (/^Reminder: message ended without send_to_session call\./i.test(system)) {
    const parentSessionMatch = system.match(/send_to_session\(\{sessionId:\s*`([^`]*)`/);
    return formatFoxwarmSystem({
      kind: 'child-reminder',
      event: 'missing-handoff',
      parentSessionId: parentSessionMatch?.[1],
    }, system);
  }

  const backgroundFinishedMatch = system.match(/^Background Process Finished\s*\n?([\s\S]*)$/i);
  if (backgroundFinishedMatch) {
    return formatFoxwarmSystem({ kind: 'event', type: 'background-process-finished' }, backgroundFinishedMatch[1]);
  }

  if (/^session resumed after process restart$/i.test(system)) {
    return formatFoxwarmSystem({ kind: 'event', type: 'session-resumed' }, system);
  }

  if (/^retrying last request$/i.test(system)) {
    return formatFoxwarmSystem({ kind: 'event', type: 'retrying-last-request' }, system);
  }

  const managedWakeMatch = system.match(/^Managed session `([^`]*)` has (\d+) pending inbox item\(s\)\.([\s\S]*)$/i);
  if (managedWakeMatch) {
    return formatFoxwarmSystem({
      kind: 'managed-session',
      event: 'pending-inbox',
      managedSessionId: managedWakeMatch[1],
      pendingCount: managedWakeMatch[2],
    }, system);
  }

  const compactionCompletedMatch = system.match(/^Compaction completed\.?\s*([\s\S]*)$/i);
  if (compactionCompletedMatch) {
    const payload = compactionCompletedMatch[1]?.trim();
    return formatFoxwarmSystemTag({ kind: 'session-boundary', event: 'compact-completed', hint: payload || undefined });
  }

  return undefined;
}

export function formatSystemPartForModel(system: string): string {
  const trimmed = system.trim();
  const legacyText = formatLegacySystemTextForModel(trimmed);
  if (legacyText) {
    return legacyText;
  }
  if (isFoxwarmMetadataLine(trimmed)) {
    const tag = parseFoxwarmTagLine(trimmed);
    if (tag?.tagName === 'foxwarm-system' && !tag.attrs.kind && typeof tag.attrs.hint === 'string') {
      const legacyHint = formatLegacySystemTextForModel(tag.attrs.hint.trim());
      if (legacyHint) {
        return legacyHint;
      }
      return formatFoxwarmSystem({ kind: 'system' }, tag.attrs.hint);
    }
    return trimmed;
  }
  return formatFoxwarmSystem({ kind: 'system' }, system);
}
