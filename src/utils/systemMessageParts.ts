import { MessagePart } from '../types';
import { formatFoxwarmSystemTag, formatSystemPartForModel } from './promptWrappers';
import { formatLocalTimestamp } from './localTime';

/** Build the canonical timestamp marker for model-visible inbound input. */
export function buildInputTimePart(timestamp: Date | number = Date.now()): MessagePart {
  return {
    system: formatFoxwarmSystemTag({ kind: 'time', time: formatLocalTimestamp(timestamp) }),
  };
}

/**
 * Timestamp ordinary system/event input at its source boundary. The supplied
 * timestamp makes this deterministic for timers, tests, and persisted work.
 */
export function buildTimestampedSystemMessageParts(message: string, timestamp: Date | number = Date.now()): MessagePart[] {
  return [buildInputTimePart(timestamp), ...buildSystemMessageParts(message)];
}

/** Clone inbound structured input and place one timestamp marker before it. */
export function withInputTimePart(parts: MessagePart[], timestamp: Date | number = Date.now()): MessagePart[] {
  return [buildInputTimePart(timestamp), ...parts.map(part => ({ ...part }))];
}

export function buildSystemMessageParts(message: string): MessagePart[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  return [{ system: formatSystemPartForModel(normalized) }];
}

export function isSystemPayloadTextPart(part: MessagePart | null | undefined): boolean {
  return !!part && part.systemPayload === true && typeof part.text === 'string';
}