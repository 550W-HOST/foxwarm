import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyUpdatePatch,
  buildAddedFileContent,
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

const update = (input: string, lines: string[]) => applyUpdatePatch(input, lines, 'sample.cs');
const failure = (input: string, lines: string[], filePath = 'sample.cs'): string => {
  let message = '';
  assert.throws(() => applyUpdatePatch(input, lines, filePath), (error: unknown) => {
    assert.ok(error instanceof Error);
    message = error.message;
    return true;
  });
  assert.ok(message.length <= 1600);
  assert.ok(message.split('\n').every(line => line.length <= 240));
  return message;
};

test('Codex punctuation and space mappings work in both directions without rewriting context or insertions', () => {
  const unicode = 'a‐‑‒–—―−b‘’‚‛c“”„‟d\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000e';
  const ascii = `a-------b''''c""""d${' '.repeat(13)}e`;
  assert.equal(update(`${unicode}\nold`, [` ${ascii}`, '-old', '+new “verbatim”']), `${unicode}\nnew “verbatim”`);
  assert.equal(update(`${ascii}\nold`, [` ${unicode}`, '-old', '+new']), `${ascii}\nnew`);
  assert.equal(update(unicode, [`-${ascii}`, '+replacement']), 'replacement');
});

test('exact, trimEnd, and trim matches take precedence over Unicode fallback', () => {
  const candidates = ['key–', '  key-   ', 'key-  ', 'key-'];
  for (let length = candidates.length; length > 0; length -= 1) {
    const input = candidates.slice(0, length);
    assert.equal(update(input.join('\n'), ['-key-', '+chosen']), [...input.slice(0, -1), 'chosen'].join('\n'));
  }
});

test('Unicode anchors disambiguate repeated contexts', () => {
  const input = ['section “first”', 'old', 'section “second”', 'old'].join('\n');
  assert.equal(update(input, ['@@ section "second"', '-old', '+new']),
    ['section “first”', 'old', 'section “second”', 'new'].join('\n'));
});

test('Unicode EOF matching preserves CRLF and final newline semantics', () => {
  const input = 'heading\r\ntail “quoted”\r\n';
  assert.equal(update(input, ['-tail "quoted"', '+tail “new”', ' ', '*** End of File']),
    'heading\r\ntail “new”\r\n');
  assert.equal(update('heading\r\ntail “quoted”', ['-tail "quoted"', '+tail “new”', '*** End of File']),
    'heading\r\ntail “new”');
});

test('missing ASCII punctuation in a long C# interpolation fails with a local mismatch', () => {
  const actual = `    Log($"${'x'.repeat(4000)}{Render(value)}");`;
  const expected = actual.replace('Render(value)', 'Render(value');
  const trailing = Array.from({ length: 100 }, (_, i) => `context ${i}`);
  const input = ['void Report() {', actual, ...trailing, '}'].join('\n');
  const message = failure(input, [' void Report() {', `-${expected}`, '+replacement', ...trailing.map(line => ` ${line}`), ' }']);
  assert.match(message, /file line 2 \(context line 2\)/);
  assert.ok(message.includes('Render(value)'));
  assert.ok(message.includes('Render(value}'));
  assert.ok(!message.includes('context 99'));
});

test('omitted intervening method lines remain a mismatch rather than a patch match', () => {
  const input = ['void Finish() {', '    Start();', '    Save();', '    Notify();', '    Stop();', '}'].join('\n');
  const message = failure(input, [' void Finish() {', '-    Start();', '+    Begin();', ' }']);
  assert.match(message, /file line 3 \(context line 3\)/);
  assert.ok(message.includes('Save();'));
  assert.ok(message.includes('"}"'));
});

test('unlocated and ambiguous failures show bounded previews and context sizes', () => {
  const context = Array.from({ length: 200 }, (_, i) => `expected ${i} ${'z'.repeat(2000)}`);
  const input = Array.from({ length: 200 }, (_, i) => `actual ${i} ${'a'.repeat(2000)}`).join('\n');
  const message = failure(input, [`-${context[0]}`, '+replacement', ...context.slice(1).map(line => ` ${line}`), '*** End of File'], 'p'.repeat(3000));
  assert.ok(message.includes('200 lines'));
  assert.ok(!message.includes('expected 199'));
  assert.ok(!message.includes('actual 199'));
  const ambiguous = failure('header\na\nheader\nb', [' header', '-missing', '+replacement']);
  assert.ok(!ambiguous.includes('Candidate starts'));
  assert.ok(ambiguous.includes('2 lines'));
  const escaped = failure('a\n'.repeat(20), [`-${'\t'.repeat(1000)}unknown`, '+new']);
  assert.ok(!escaped.includes('\t'));
});

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

test('bare patch without envelope is accepted when it starts with a file action header', () => {
  const patch = ['*** Add File: created.txt', '+alpha', '+', '+omega'].join('\n');
  const operations = parseApplyPatchInput(patch);
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].action, 'add');
  assert.strictEqual(buildAddedFileContent(operations[0].lines), ['alpha', '', 'omega'].join('\n'));
});

test('obviously invalid input still fails clearly', () => {
  assert.throws(
    () => parseApplyPatchInput('hello world'),
    /missing \*\*\* Begin Patch \/ \*\*\* End Patch envelope, or bare patch must start with \*\*\* Update File: \/ \*\*\* Add File: \/ \*\*\* Delete File:/,
  );
});

test('partial envelope still fails as malformed input', () => {
  assert.throws(
    () => parseApplyPatchInput(['*** Begin Patch', '*** Add File: created.txt', '+alpha'].join('\n')),
    /malformed patch envelope/,
  );
});
