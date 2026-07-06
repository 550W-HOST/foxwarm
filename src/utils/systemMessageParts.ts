import { MessagePart } from '../types';
import { formatSystemPartForModel } from './promptWrappers';

export function buildSystemMessageParts(message: string): MessagePart[] {
  const normalized = message.replace(/\r\n?/g, '\n');
  return [{ system: formatSystemPartForModel(normalized) }];
}

export function isSystemPayloadTextPart(part: MessagePart | null | undefined): boolean {
  return !!part && part.systemPayload === true && typeof part.text === 'string';
}