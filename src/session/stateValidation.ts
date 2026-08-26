import { isQueueItem, type Message } from '../types';
import { MODEL_EFFORTS, type ModelEffort } from '../config';

export const CURRENT_SESSION_STATE_VERSION = 1;

export type SessionAuthorityMailboxCursor = {
  cursor: number;
  defaulted: boolean;
};

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read-old/write-new compatibility for the retired per-message Frontier marker. */
export function omitObsoleteContextFrontierItem(message: Message): Message {
  const meta = message?.__meta;
  if (!isRecord(meta) || !Object.prototype.hasOwnProperty.call(meta, 'contextFrontierItem')) return message;
  const { contextFrontierItem: _obsolete, ...currentMeta } = meta as Record<string, unknown>;
  return { ...message, __meta: currentMeta } as Message;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateStats(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} stats must be an object.`);
  for (const field of ['totalCachedTokens', 'totalInputTokens', 'totalOutputTokens'] as const) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) throw new Error(`${label} stats.${field} must be a finite number.`);
  }
  if (value.lastUsage !== undefined && value.lastUsage !== null) {
    if (!isRecord(value.lastUsage)) throw new Error(`${label} stats.lastUsage must be an object or null.`);
    for (const field of ['cachedTokens', 'inputTokens', 'reasoningTokens', 'outputTokens'] as const) {
      if (value.lastUsage[field] !== undefined && !isFiniteNumber(value.lastUsage[field])) {
        throw new Error(`${label} stats.lastUsage.${field} must be a finite number.`);
      }
    }
  }
}

function validateMeta(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} meta must be an object.`);
  for (const field of ['lastMessageTime', 'messageCount'] as const) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) throw new Error(`${label} meta.${field} must be a finite number.`);
  }
}

function validateChildHandoffState(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} childHandoffState must be an object.`);
  if (value.boundary !== 'direct-user' && value.boundary !== 'report-required') {
    throw new Error(`${label} childHandoffState.boundary is invalid.`);
  }
  if (typeof value.resolved !== 'boolean') {
    throw new Error(`${label} childHandoffState.resolved must be boolean.`);
  }
}

function validateCurrentHistory(history: unknown[], label: string): void {
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!isRecord(message) || !['user', 'model', 'tool'].includes(message.role) || !Array.isArray(message.parts)
      || message.parts.some(part => !isRecord(part))) {
      throw new Error(`${label} history[${index}] is not a current Message shape.`);
    }
  }
}

/** Strict authority cursor reader. Only a missing legacy value defaults to zero. */
export function readSessionAuthorityMailboxCursor(
  value: Record<string, any>,
  label = 'Per-session state',
): SessionAuthorityMailboxCursor {
  const cursor = value.lastAppliedMailboxId;
  if (cursor === undefined) return { cursor: 0, defaulted: true };
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error(`${label} mailbox cursor must be a non-negative safe integer.`);
  }
  return { cursor, defaulted: false };
}

/**
 * Side-effect-free authority reader shared by startup hydration and catalog
 * migration preflight. Unversioned files retain the existing tolerant
 * history normalization; v1 files must satisfy current shapes. Historical
 * contextFrontier is deliberately ignored for every version: history is the
 * sole active authority and the obsolete field is dropped on the next save.
 */
export function normalizeAndValidateSessionAuthorityPayload(raw: unknown, label = 'Per-session state'): Record<string, any> {
  if (!isRecord(raw)) throw new Error(`${label} must be an object.`);
  const version = raw.sessionStateVersion;
  if (version !== undefined && version !== CURRENT_SESSION_STATE_VERSION) {
    throw new Error(`Unsupported per-session state format version ${String(version)} in ${label}.`);
  }
  const current = version === CURRENT_SESSION_STATE_VERSION;
  const value: Record<string, any> = structuredClone(raw);
  if (!current) {
    value.history = Array.isArray(value.history) ? value.history : [];
  }
  delete value.contextFrontier;
  if (Array.isArray(value.history)) value.history = value.history.map(message => isRecord(message)
    ? omitObsoleteContextFrontierItem(message as Message) : message);
  if (value.history !== undefined && !Array.isArray(value.history)) throw new Error(`${label} history must be an array.`);
  if (current) validateCurrentHistory(value.history || [], label);
  if (value.persistentMemorySnapshot !== undefined && typeof value.persistentMemorySnapshot !== 'string') {
    throw new Error(`${label} persistentMemorySnapshot must be a string.`);
  }
  if (value.queue !== undefined && !Array.isArray(value.queue)) throw new Error(`${label} queue must be an array.`);
  if (current && value.queue?.some((item: unknown) => !isQueueItem(item))) throw new Error(`${label} queue contains an invalid current QueueItem.`);
  if (value.stats !== undefined) validateStats(value.stats, label);
  if (value.meta !== undefined) validateMeta(value.meta, label);
  if (value.childHandoffState !== undefined) validateChildHandoffState(value.childHandoffState, label);
  readSessionAuthorityMailboxCursor(value, label);
  for (const field of ['effort', 'childEffortDefault'] as const) {
    if (value[field] !== undefined
      && (typeof value[field] !== 'string' || !MODEL_EFFORTS.includes(value[field] as ModelEffort))) {
      throw new Error(`${label} ${field} must be one of: ${MODEL_EFFORTS.join(', ')}.`);
    }
  }
  return value;
}
