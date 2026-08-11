import { isQueueItem } from '../types';
import { MODEL_EFFORTS, type ModelEffort } from '../config';

export const CURRENT_SESSION_STATE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function validateCurrentHistory(history: unknown[], label: string): void {
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!isRecord(message) || !['user', 'model', 'tool'].includes(message.role) || !Array.isArray(message.parts)
      || message.parts.some(part => !isRecord(part))) {
      throw new Error(`${label} history[${index}] is not a current Message shape.`);
    }
  }
}

function validateCurrentFrontier(frontier: unknown[], label: string): void {
  for (let index = 0; index < frontier.length; index += 1) {
    const item = frontier[index];
    if (!isRecord(item)) throw new Error(`${label} contextFrontier[${index}] must be an object.`);
    if (item.kind === 'message') {
      if (!Number.isSafeInteger(item.seq) || item.seq < 1
        || (item.preservedFromBlockId !== undefined && (!Number.isSafeInteger(item.preservedFromBlockId) || item.preservedFromBlockId < 1))) {
        throw new Error(`${label} contextFrontier[${index}] has an invalid message boundary.`);
      }
      continue;
    }
    if (item.kind === 'block') {
      if (!Number.isSafeInteger(item.id) || item.id < 1 || !Number.isSafeInteger(item.level) || item.level < 1
        || !Number.isSafeInteger(item.rawStartSeq) || item.rawStartSeq < 1
        || !Number.isSafeInteger(item.rawEndSeq) || item.rawEndSeq < item.rawStartSeq) {
        throw new Error(`${label} contextFrontier[${index}] has an invalid block boundary.`);
      }
      continue;
    }
    throw new Error(`${label} contextFrontier[${index}] has an unknown kind.`);
  }
}

/**
 * Side-effect-free authority reader shared by startup hydration and catalog
 * migration preflight. Unversioned files retain the existing tolerant
 * history/frontier normalization; v1 files must satisfy current shapes.
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
    if (value.contextFrontier !== undefined && !Array.isArray(value.contextFrontier)) delete value.contextFrontier;
  }
  if (value.history !== undefined && !Array.isArray(value.history)) throw new Error(`${label} history must be an array.`);
  if (current) validateCurrentHistory(value.history || [], label);
  if (value.persistentMemorySnapshot !== undefined && typeof value.persistentMemorySnapshot !== 'string') {
    throw new Error(`${label} persistentMemorySnapshot must be a string.`);
  }
  if (value.queue !== undefined && !Array.isArray(value.queue)) throw new Error(`${label} queue must be an array.`);
  if (current && value.queue?.some((item: unknown) => !isQueueItem(item))) throw new Error(`${label} queue contains an invalid current QueueItem.`);
  if (value.contextFrontier !== undefined && !Array.isArray(value.contextFrontier)) throw new Error(`${label} contextFrontier must be an array.`);
  if (current && value.contextFrontier) validateCurrentFrontier(value.contextFrontier, label);
  if (value.stats !== undefined) validateStats(value.stats, label);
  if (value.meta !== undefined) validateMeta(value.meta, label);
  if (value.lastAppliedMailboxId !== undefined
    && (!Number.isSafeInteger(value.lastAppliedMailboxId) || value.lastAppliedMailboxId < 0)) {
    throw new Error(`${label} mailbox cursor must be a non-negative safe integer.`);
  }
  for (const field of ['effort', 'childEffortDefault'] as const) {
    if (value[field] !== undefined
      && (typeof value[field] !== 'string' || !MODEL_EFFORTS.includes(value[field] as ModelEffort))) {
      throw new Error(`${label} ${field} must be one of: ${MODEL_EFFORTS.join(', ')}.`);
    }
  }
  return value;
}
