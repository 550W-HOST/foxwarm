import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExactReplacement } from './exactReplacement';

test('exact replacement treats regex characters and whitespace as literal search text', () => {
  assert.equal(applyExactReplacement('before\r\n[.*+?^${}()|\\]\t\r\nafter', '[.*+?^${}()|\\]\t', 'changed', 'oldText'), 'before\r\nchanged\r\nafter');
  assert.throws(() => applyExactReplacement('a b', 'a\tb', 'changed', 'oldText'), {
    message: 'Could not find oldText in file. Make sure whitespace matches exactly.',
  });
});

test('exact replacement rejects multiple non-overlapping matches with the caller label', () => {
  assert.throws(() => applyExactReplacement('same same', 'same', 'changed', 'searchText'), {
    message: 'Found 2 occurrences of searchText in file. Edit tool only replaces once. Please make searchText more specific to match exactly one location.',
  });
  assert.equal(applyExactReplacement('aaa', 'aa', 'b', 'oldText'), 'ba');
});

test('exact replacement preserves JavaScript replacement-string substitutions', () => {
  assert.equal(applyExactReplacement('before MATCH after', 'MATCH', "$$|$&|$`|$'|$1", 'oldText'),
    'before $|MATCH|before | after|$1 after');
});

test('empty exact search retains the existing regex occurrence behavior', () => {
  assert.equal(applyExactReplacement('', '', 'inserted', 'oldText'), 'inserted');
  assert.throws(() => applyExactReplacement('a', '', 'inserted', 'oldText'), {
    message: 'Found 2 occurrences of oldText in file. Edit tool only replaces once. Please make oldText more specific to match exactly one location.',
  });
});
