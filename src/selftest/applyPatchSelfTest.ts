import assert from 'assert';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from '../applyPatch';

function applySingleUpdate(input: string, diffBody: string): string {
  const patch = [
    '*** Begin Patch',
    '*** Update File: sample.txt',
    diffBody,
    '*** End Patch',
  ].join('\n');

  const operations = parseApplyPatchInput(patch);
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].action, 'update');
  return applyUpdatePatch(input, operations[0].lines, 'sample.txt');
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('single hunk basic replacement', () => {
  const input = ['alpha', 'beta', 'gamma'].join('\n');
  const output = applySingleUpdate(input, [' beta', '-gamma', '+delta'].join('\n'));
  assert.strictEqual(output, ['alpha', 'beta', 'delta'].join('\n'));
});

test('multiple hunk sequential application', () => {
  const input = ['start', 'one', 'two', 'three', 'four', 'end'].join('\n');
  const output = applySingleUpdate(input, [
    '@@ start',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ three',
    ' four',
    '-end',
    '+finish',
  ].join('\n'));

  assert.strictEqual(output, ['start', 'one', 'TWO', 'three', 'four', 'finish'].join('\n'));
});

test('repeated fragments use context to disambiguate', () => {
  const input = [
    'function first() {',
    '  value();',
    '}',
    '',
    'function second() {',
    '  value();',
    '}',
  ].join('\n');

  const output = applySingleUpdate(input, [
    '@@ function second() {',
    '-  value();',
    '+  updated();',
    ' }',
  ].join('\n'));

  assert.strictEqual(output, [
    'function first() {',
    '  value();',
    '}',
    '',
    'function second() {',
    '  updated();',
    '}',
  ].join('\n'));
});

test('blank line context is supported', () => {
  const input = ['top', '', 'middle', '', 'bottom'].join('\n');
  const output = applySingleUpdate(input, [' top', '', '-middle', '+center', ''].join('\n'));
  assert.strictEqual(output, ['top', '', 'center', '', 'bottom'].join('\n'));
});

test('context lines beginning with plus or minus are treated as normal content', () => {
  const input = ['header', '+keep me', '-keep me too', 'tail'].join('\n');
  const output = applySingleUpdate(input, [
    '@@ header',
    ' +keep me',
    ' -keep me too',
    '+inserted',
    ' tail',
  ].join('\n'));

  assert.strictEqual(output, ['header', '+keep me', '-keep me too', 'inserted', 'tail'].join('\n'));
});

test('EOF marker applies section at end of file', () => {
  const input = ['alpha', 'beta', 'omega'].join('\n');
  const output = applySingleUpdate(input, ['-omega', '+last', '*** End of File'].join('\n'));
  assert.strictEqual(output, ['alpha', 'beta', 'last'].join('\n'));
});

test('missing anchor can still succeed when context matches', () => {
  const input = ['alpha', 'beta', 'gamma'].join('\n');
  const output = applySingleUpdate(input, ['@@ not-present-anchor', ' beta', '-gamma', '+delta'].join('\n'));
  assert.strictEqual(output, ['alpha', 'beta', 'delta'].join('\n'));
});

test('whitespace fuzz matches trailing spaces', () => {
  const input = ['alpha', 'beta   ', 'gamma'].join('\n');
  const output = applySingleUpdate(input, [' beta', '-gamma', '+delta'].join('\n'));
  assert.strictEqual(output, ['alpha', 'beta   ', 'delta'].join('\n'));
});

test('add file syntax requires leading plus and preserves blank lines via +', () => {
  const patch = ['*** Begin Patch', '*** Add File: created.txt', '+alpha', '+', '+omega', '*** End Patch'].join('\n');
  const operations = parseApplyPatchInput(patch);
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].action, 'add');
  assert.strictEqual(buildAddedFileContent(operations[0].lines), ['alpha', '', 'omega'].join('\n'));
});

console.log('apply_patch selftest passed');
