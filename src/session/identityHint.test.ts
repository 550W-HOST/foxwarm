import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionIdentityHint } from './identityHint';

test('formatSessionIdentityHint renders inherited-history parent/current session ids in the required bold format', () => {
  assert.equal(
    formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-1', variant: 'inherited' }),
    '**HISTORY ABOVE IS INHERITED FROM PARENT SESSION `parent-1`. CURRENT SESSION ID IS `child-1`.**',
  );
});

test('formatSessionIdentityHint renders compact and new-child variants with bold parent/current ids', () => {
  const compact = formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-1', variant: 'compact' });
  assert.match(compact, /^\*\*/);
  assert.match(compact, /PARENT SESSION `parent-1`/);
  assert.match(compact, /CURRENT SESSION ID IS `child-1`/);
  assert.match(compact, /\*\*$/);

  const newChild = formatSessionIdentityHint({ parentSessionId: 'parent-1', sessionId: 'child-2', variant: 'new-child' });
  assert.match(newChild, /^\*\*/);
  assert.match(newChild, /PARENT SESSION `parent-1`/);
  assert.match(newChild, /CURRENT SESSION ID IS `child-2`/);
  assert.match(newChild, /\*\*$/);
});
