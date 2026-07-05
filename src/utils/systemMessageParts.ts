import { MessagePart } from '../types';
import { isFoxwarmMessageCloseLine } from './promptWrappers';

export function buildSystemMessageParts(message: string): MessagePart[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  const firstNewlineIndex = normalized.indexOf('\n');
  if (firstNewlineIndex === -1) {
    return [{ system: normalized }];
  }

  const header = normalized.slice(0, firstNewlineIndex);
  const payload = normalized.slice(firstNewlineIndex + 1);
  if (!payload) {
    return [{ system: header }];
  }

  const payloadLines = payload.split('\n');
  const lastPayloadLine = payloadLines[payloadLines.length - 1] || '';
  if (isFoxwarmMessageCloseLine(lastPayloadLine)) {
    const body = payloadLines.slice(0, -1).join('\n');
    return [
      { system: header },
      ...(body ? [{ text: body, systemPayload: true }] : []),
      { system: lastPayloadLine },
    ];
  }

  return [
    { system: header },
    { text: payload, systemPayload: true },
  ];
}

export function isSystemPayloadTextPart(part: MessagePart | null | undefined): boolean {
  return !!part && part.systemPayload === true && typeof part.text === 'string';
}