import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionIdentityHint } from './identityHint';

test('formatSessionIdentityHint renders inherited-history parent/current session ids as foxwarm metadata', () => {
  assert.equal(
    formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-1', variant: 'inherited' }),
    '<foxwarm-system kind="session-boundary" event="history-inherited" parentSessionId="parent-1" currentSessionId="child-1" />',
  );
});

test('formatSessionIdentityHint renders compact and new-child variants as foxwarm metadata', () => {
  const compact = formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-1', variant: 'compact' });
  assert.equal(compact, '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-1" currentSessionId="child-1" />');

  const newChild = formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-2', variant: 'new-child' });
  assert.equal(newChild, '<foxwarm-system kind="session-boundary" event="new-child" parentSessionId="parent-1" currentSessionId="child-2" />');
});
