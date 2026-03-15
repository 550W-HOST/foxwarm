import { Message, MessagePart } from '../types';

export const NO_ACTION_MARKER = '[NO_ACTION]';
const LEGACY_NO_ACTION_MARKER = 'NO_ACTION';

export function isNoActionSignalText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === LEGACY_NO_ACTION_MARKER
    || trimmed === NO_ACTION_MARKER
    || trimmed.endsWith(NO_ACTION_MARKER);
}

export function partsContainNoActionSignal(parts?: MessagePart[]): boolean {
  return !!parts?.some(part => typeof part.text === 'string' && isNoActionSignalText(part.text));
}

export function isModelNoActionSignal(message?: Pick<Message, 'role' | 'parts'> | null): boolean {
  return message?.role === 'model' && partsContainNoActionSignal(message.parts);
}

export function buildChildCompletionInstruction(parentSessionId: string): string {
  return `When you finish, explicitly call send_to_session({sessionId: \`${parentSessionId}\`, message: "..."}). If that handoff message is your final step, prefer send_to_session({sessionId: \`${parentSessionId}\`, message: "...", noFurtherAssistantReply: true}) so the turn stops right after the handoff. If no parent reply is needed and you are not sending a handoff message, end your final message with \`${NO_ACTION_MARKER}\`.`;
}

export function buildChildReminder(parentSessionId: string): string {
  return `message ended without send_to_session call. If you need to report back to the parent session, call send_to_session({sessionId: \`${parentSessionId}\`, message: "..."}). If that handoff is your final step, prefer send_to_session({sessionId: \`${parentSessionId}\`, message: "...", noFurtherAssistantReply: true}) so the turn stops immediately after the handoff. If no parent reply is needed and you are not sending a handoff message, end your final message with \`${NO_ACTION_MARKER}\`.`;
}