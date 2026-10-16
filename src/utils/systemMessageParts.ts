import { MessagePart } from '../types';
import { formatFoxwarmMessageClose, formatFoxwarmMessageOpen, formatFoxwarmSystemOpen, formatFoxwarmSystemTag, formatSystemPartForModel, parseFoxwarmOpeningTag, parseFoxwarmTagLine } from './promptWrappers';
import { formatLocalTimestamp } from './localTime';

function addInputTimeToSystemWrapper(message: string, timestamp: Date | number): string {
  const normalized = formatSystemPartForModel(message);
  const opening = parseFoxwarmOpeningTag(normalized);
  const time = formatLocalTimestamp(timestamp);
  if (!opening || opening.attrs.time !== undefined) {
    return normalized;
  }

  const attrs = { ...opening.attrs, time };
  const openingMatch = normalized.match(/^\s*<foxwarm-(system|message)\b[^>]*>/i);
  if (!openingMatch) return normalized;
  const isSelfClosing = /\/\>\s*$/.test(openingMatch[0]);
  const replacement = opening.tagName === 'foxwarm-system'
    ? isSelfClosing ? formatFoxwarmSystemTag(attrs) : formatFoxwarmSystemOpen(attrs)
    : formatFoxwarmMessageOpen(attrs);
  return `${replacement}${normalized.slice(openingMatch[0].length)}`;
}

/**
 * Timestamp ordinary system/event input at its source boundary. The supplied
 * timestamp makes this deterministic for timers, tests, and persisted work.
 */
export function buildTimestampedSystemMessageParts(message: string, timestamp: Date | number = Date.now()): MessagePart[] {
  return [{ system: addInputTimeToSystemWrapper(message, timestamp) }];
}

/**
 * Clone inbound structured input and wrap raw multipart input once at its
 * source boundary. A pre-existing single XML wrapper is decorated in place.
 */
export function withInputTimePart(parts: MessagePart[], timestamp: Date | number = Date.now()): MessagePart[] {
  if (parts.length === 1 && typeof parts[0].system === 'string') {
    return buildTimestampedSystemMessageParts(parts[0].system, timestamp);
  }
  return [
    {
      system: formatFoxwarmMessageOpen({
        type: 'event',
        time: formatLocalTimestamp(timestamp),
        hint: 'structured session input',
      }),
    },
    ...parts.map(part => ({ ...part })),
    { system: formatFoxwarmMessageClose() },
  ];
}

/** Copy an existing outer source wrapper to set queueInputHint, preserving its body and other attributes. */
export function withQueueInputHint(parts: MessagePart[], queueInputHint: string): MessagePart[] {
  for (let index = 0; index < parts.length; index++) {
    const system = parts[index].system;
    const opening = parseFoxwarmOpeningTag(system);
    if (!opening || typeof system !== 'string') return parts;
    const isSource = (opening.tagName === 'foxwarm-message' && opening.attrs.type === 'channel')
      || (opening.tagName === 'foxwarm-system' && opening.attrs.kind === 'external-input');
    if (isSource) {
      const match = system.match(/^(\s*)<foxwarm-(?:message|system)\b[^>]*>/i)!;
      const attrs = { ...opening.attrs, queueInputHint };
      const replacement = opening.tagName === 'foxwarm-message'
        ? formatFoxwarmMessageOpen(attrs)
        : formatFoxwarmSystemOpen(attrs);
      return parts.map((part, partIndex) => partIndex === index
        ? { ...part, system: `${match[1]}${replacement}${system.slice(match[0].length)}` }
        : part);
    }
    // Only framework metadata can precede the source wrapper. Do not search
    // arbitrary user parts or nested XML for something that resembles one.
    const metadata = parseFoxwarmTagLine(system);
    if (metadata?.tagName !== 'foxwarm-system'
      || !['session', 'channel-mode'].includes(metadata.attrs.kind)
      || !/\/\s*>\s*$/.test(system)) return parts;
  }
  return parts;
}

export function buildSystemMessageParts(message: string): MessagePart[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  return [{ system: formatSystemPartForModel(normalized) }];
}

export function isSystemPayloadTextPart(part: MessagePart | null | undefined): boolean {
  return !!part && part.systemPayload === true && typeof part.text === 'string';
}