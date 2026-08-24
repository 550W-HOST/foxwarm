import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ACCEPTED_EXTERNAL_EVENT_IDS,
  planAcceptedExternalEventReceipt,
} from './externalEventReceipts';

test('external event receipts retain only the newest 32 valid distinct IDs', () => {
  const stored: unknown[] = [null, '', 'legacy-duplicate', 'legacy-duplicate', 'x'.repeat(513)];
  stored.push(...Array.from({ length: MAX_ACCEPTED_EXTERNAL_EVENT_IDS + 4 }, (_, index) => `event-${index}`));

  const plan = planAcceptedExternalEventReceipt(stored, 'event-new');
  assert.equal(plan.duplicate, false);
  assert.equal(plan.changed, true);
  assert.equal(plan.acceptedIds.length, MAX_ACCEPTED_EXTERNAL_EVENT_IDS);
  assert.deepEqual(plan.acceptedIds, [
    ...Array.from({ length: MAX_ACCEPTED_EXTERNAL_EVENT_IDS - 1 }, (_, index) => `event-${index + 5}`),
    'event-new',
  ]);

  const duplicate = planAcceptedExternalEventReceipt(plan.acceptedIds, 'event-new');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.acceptedIds, plan.acceptedIds);
});

test('external event receipt validation rejects invalid new IDs without trusting malformed stored data', () => {
  assert.throws(() => planAcceptedExternalEventReceipt(['valid'], ''), /non-empty string/);
  assert.throws(() => planAcceptedExternalEventReceipt(['valid'], '界'.repeat(200)), /512 UTF-8 bytes/);
});