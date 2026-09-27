import type { SessionMeta } from '../types';

export const MAX_ACCEPTED_EXTERNAL_EVENT_IDS = 32;
const MAX_EXTERNAL_EVENT_ID_BYTES = 512;

export type AcceptedExternalEventReceiptPlan = {
  acceptedIds: string[];
  duplicate: boolean;
  changed: boolean;
};

function isValidStoredExternalEventId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_EXTERNAL_EVENT_ID_BYTES;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

/**
 * Normalize read-old receipt data and plan one idempotent admission. Session
 * authority retains only the newest 32 distinct IDs. Eviction from this field
 * does not promise re-admission: an exact durable mailbox row may independently
 * suppress an older retry for as long as that row remains retained.
 */
export function planAcceptedExternalEventReceipt(
  stored: unknown,
  externalEventId: string,
): AcceptedExternalEventReceiptPlan {
  if (!isValidStoredExternalEventId(externalEventId)) {
    throw new Error('External event ID must be a non-empty string of at most 512 UTF-8 bytes.');
  }

  const newestFirst: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(stored)) {
    for (let index = stored.length - 1; index >= 0 && newestFirst.length < MAX_ACCEPTED_EXTERNAL_EVENT_IDS; index -= 1) {
      const value = stored[index];
      if (!isValidStoredExternalEventId(value) || seen.has(value)) continue;
      seen.add(value);
      newestFirst.push(value);
    }
  }
  const normalized = newestFirst.reverse();
  const duplicate = seen.has(externalEventId);
  const acceptedIds = duplicate
    ? normalized
    : [...normalized, externalEventId].slice(-MAX_ACCEPTED_EXTERNAL_EVENT_IDS);
  return {
    acceptedIds,
    duplicate,
    changed: !sameStringArray(stored, acceptedIds),
  };
}

export function applyAcceptedExternalEventReceiptPlan(
  meta: SessionMeta,
  plan: AcceptedExternalEventReceiptPlan,
): void {
  meta.acceptedExternalEventIds = plan.acceptedIds;
}