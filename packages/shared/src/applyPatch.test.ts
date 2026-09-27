import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countApplyPatchOperationLines,
  formatApplyPatchOperationSummary,
  parseApplyPatchInput,
} from './applyPatch';

test('apply patch line counts aggregate changed content lines across hunks', () => {
  const [operation] = parseApplyPatchInput([
    '*** Begin Patch',
    '*** Update File: note.txt',
    '@@ first',
    ' context',
    '-removed one',
    '+added one',
    '+added two',
    '@@ second',
    '-removed two',
    ' context',
    '*** End Patch',
  ].join('\n'));

  assert.deepEqual(countApplyPatchOperationLines(operation), { added: 2, deleted: 2 });
  assert.equal(formatApplyPatchOperationSummary(operation), 'Updated note.txt (+2 -2)');
});

test('apply patch line counts exclude headers, anchors, and context', () => {
  const operations = parseApplyPatchInput([
    '*** Begin Patch',
    '*** Add File: added.txt',
    '+alpha',
    '+',
    '+omega',
    '*** Update File: updated.txt',
    '@@ anchor',
    ' unchanged',
    '+inserted',
    '*** Delete File: deleted.txt',
    '*** End Patch',
  ].join('\n'));

  assert.deepEqual(operations.map(countApplyPatchOperationLines), [
    { added: 3, deleted: 0 },
    { added: 1, deleted: 0 },
    { added: 0, deleted: 0 },
  ]);
  assert.deepEqual(operations.map(operation => formatApplyPatchOperationSummary(operation)), [
    'Added added.txt (+3)',
    'Updated updated.txt (+1 -0)',
    'Deleted deleted.txt',
  ]);
});

test('empty added files report zero added lines', () => {
  const [operation] = parseApplyPatchInput([
    '*** Begin Patch',
    '*** Add File: empty.txt',
    '*** End Patch',
  ].join('\n'));

  assert.deepEqual(countApplyPatchOperationLines(operation), { added: 0, deleted: 0 });
  assert.equal(formatApplyPatchOperationSummary(operation), 'Added empty.txt (+0)');
});
