import { Message, MessagePart } from '../types';
import { formatFoxwarmSystem } from '../utils/promptWrappers';
import {
  INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX,
  INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER,
  INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX,
} from '../toolCallControls';

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
  return `When you finish, explicitly call send_to_session({sessionId: \`${parentSessionId}\`, message: "...", afterSend: "finish", confirmation: "${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\\n${INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER}\\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}"}). The confirmation must be the final argument property, and you must replace the placeholder with your own review rather than copying it. This sends the final report and ends the turn idle without creating a wait. Use afterSend: "wait" only when you genuinely require a later reply from the parent; do not add a separate wait call. If no report or parent action is needed, end your final message with \`${NO_ACTION_MARKER}\`.`;
}

export function buildChildReminder(parentSessionId: string): string {
  return formatFoxwarmSystem({ kind: 'child-reminder', event: 'missing-handoff', parentSessionId }, `Reminder: message ended without send_to_session call. If you need to report completion to the parent session, call send_to_session({sessionId: \`${parentSessionId}\`, message: "...", afterSend: "finish", confirmation: "${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\\n${INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER}\\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}"}) now. The confirmation must be the final argument property, and you must replace the placeholder with your own review rather than copying it. This reports so the Session becomes idle without a wait. Use afterSend: "wait" only when you genuinely require a later reply; do not add a separate wait call. If no action is needed, say \`${NO_ACTION_MARKER}\`. Next time, you can end your final message with \`${NO_ACTION_MARKER}\` to prevent this reminder.`);
}
