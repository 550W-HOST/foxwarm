import { MessagePart } from '../types';

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

  return [
    { system: header },
    { text: payload, systemPayload: true },
  ];
}

export function isSystemPayloadTextPart(part: MessagePart | null | undefined): boolean {
  return !!part && part.systemPayload === true && typeof part.text === 'string';
}