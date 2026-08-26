import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChildHandoffQueueItem,
  getChildHandoffBoundaryForQueueItem,
  resolveChildHandoffBoundary,
  shouldQueueChildHandoffReminder,
} from './childHandoffState';
import type { QueueItem, Session } from '../types';

function session(): Session {
  return {
    id: 'child', history: [], persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: 0 },
  };
}

test('child handoff boundary classification is narrow and legacy-safe', () => {
  assert.deepEqual(getChildHandoffBoundaryForQueueItem({ type: 'user' }), {
    boundary: 'direct-user', resolved: true,
  });
  assert.deepEqual(getChildHandoffBoundaryForQueueItem({ type: 'intersession', sourceSessionRelation: 'parent' }), {
    boundary: 'report-required', resolved: false,
  });
  assert.deepEqual(getChildHandoffBoundaryForQueueItem({ type: 'intersession', sourceSessionRelation: 'other' }), {
    boundary: 'report-required', resolved: false,
  });
  for (const item of [
    { type: 'intersession', sourceSessionRelation: 'direct-child' },
    { type: 'intersession' },
    { type: 'background' }, { type: 'trigger' }, { type: 'onboot' },
  ] as QueueItem[]) {
    assert.equal(getChildHandoffBoundaryForQueueItem(item), undefined);
  }
});

test('child handoff state transitions supersede meaningful boundaries and ignore transparent input', () => {
  const current = session();
  assert.equal(shouldQueueChildHandoffReminder(current), undefined);

  assert.equal(applyChildHandoffQueueItem(current, {
    type: 'intersession', sourceSessionRelation: 'parent', parts: [{ text: 'work' }],
  }), true);
  assert.deepEqual(current.childHandoffState, { boundary: 'report-required', resolved: false });
  assert.equal(shouldQueueChildHandoffReminder(current), true);

  assert.equal(applyChildHandoffQueueItem(current, {
    type: 'intersession', sourceSessionRelation: 'direct-child', parts: [{ text: 'child report' }],
  }), false);
  assert.deepEqual(current.childHandoffState, { boundary: 'report-required', resolved: false });

  assert.equal(resolveChildHandoffBoundary(current), true);
  assert.equal(resolveChildHandoffBoundary(current), false);
  assert.equal(shouldQueueChildHandoffReminder(current), false);

  assert.equal(applyChildHandoffQueueItem(current, { type: 'user', parts: [{ text: 'direct user' }] }), true);
  assert.deepEqual(current.childHandoffState, { boundary: 'direct-user', resolved: true });
  assert.equal(shouldQueueChildHandoffReminder(current), false);

  assert.equal(applyChildHandoffQueueItem(current, {
    type: 'intersession', sourceSessionRelation: 'other', parts: [{ text: 'new assignment' }],
  }), true);
  assert.deepEqual(current.childHandoffState, { boundary: 'report-required', resolved: false });
});
