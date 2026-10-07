import { MessagePart } from '../types';
import { formatFoxwarmSystem } from '../utils/promptWrappers';
import { HANDOFF_CONFIRMATION_ENABLED } from '../config';
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

export function buildChildCompletionInstruction(parentSessionId: string): string {
  return buildChildCompletionInstructionForMode(parentSessionId, HANDOFF_CONFIRMATION_ENABLED);
}

export function buildChildReminder(parentSessionId: string): string {
  return buildChildReminderForMode(parentSessionId, HANDOFF_CONFIRMATION_ENABLED);
}

function confirmationArgument(): string {
  return `, confirmation: "${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\\n${INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER}\\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}"`;
}

export function buildChildCompletionInstructionForMode(parentSessionId: string, enabled: boolean): string {
  const confirmation = enabled ? confirmationArgument() : '';
  const confirmationGuidance = enabled ? ' The confirmation must be the final argument property, and you must replace the placeholder with your own review rather than copying it.' : '';
  return `If your current work is tracked by a task, complete the task with the task tool. Completion notifies a Session creator automatically; do not send a separate routine completion report. For work not tracked by a task, when you finish, explicitly call send_to_session({sessionId: \`${parentSessionId}\`, message: "...", afterSend: "finish"${confirmation}}).${confirmationGuidance} This sends the report and ends the turn idle without creating a wait. Use afterSend: "wait" only when you genuinely require a later reply from the parent; do not add a separate wait call. If no separate report or parent action is needed, end your final message with \`${NO_ACTION_MARKER}\`.`;
}

export function buildChildReminderForMode(parentSessionId: string, enabled: boolean): string {
  const confirmation = enabled ? confirmationArgument() : '';
  const confirmationGuidance = enabled ? ' The confirmation must be the final argument property, and you must replace the placeholder with your own review rather than copying it.' : '';
  return formatFoxwarmSystem({ kind: 'child-reminder', event: 'missing-handoff', parentSessionId }, `Reminder: check whether your work still needs a completion report. If your current work is tracked by a task, complete it with the task tool unless it is already complete; do not send a duplicate routine completion report. Otherwise, if you need to report completion to the parent session, call send_to_session({sessionId: \`${parentSessionId}\`, message: "...", afterSend: "finish"${confirmation}}) now.${confirmationGuidance} This reports so the Session becomes idle without a wait. Use afterSend: "wait" only when you genuinely require a later reply; do not add a separate wait call. If no separate report or parent action is needed, say \`${NO_ACTION_MARKER}\`.`);
}
