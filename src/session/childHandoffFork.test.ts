import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('forked and new child Sessions do not inherit an existing handoff boundary', async () => {
  const sourceId = id('child_handoff_fork_source');
  const source = await sessionManager.getSession(sourceId);
  source.childHandoffState = { boundary: 'report-required', resolved: false };
  await sessionManager.saveSession(sourceId);
  let forkId: string | undefined;
  let childId: string | undefined;
  try {
    forkId = await sessionManager.forkSession(sourceId, 'fork');
    childId = await sessionManager.createChildSession(sourceId, 'new-child', false);
    assert.equal((await sessionManager.getSession(forkId)).childHandoffState, undefined);
    assert.equal((await sessionManager.getSession(childId)).childHandoffState, undefined);
    assert.deepEqual((await sessionManager.getSession(sourceId)).childHandoffState, {
      boundary: 'report-required', resolved: false,
    });
  } finally {
    if (forkId) await sessionManager.deleteSession(forkId).catch(() => false);
    if (childId) await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});
