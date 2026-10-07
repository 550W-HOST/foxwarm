import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUpdatePatch as applyMainUpdatePatch } from './applyPatch';
import { applyUpdatePatch as applySharedUpdatePatch } from '../packages/shared/dist/applyPatch';

for (const [engine, applyUpdatePatch] of [
  ['Main', applyMainUpdatePatch],
  ['shared Node', applySharedUpdatePatch],
] as const) {
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

  test(`${engine}: Codex punctuation and space mappings work in both directions without rewriting context or insertions`, () => {
    const unicode = 'a‐‑‒–—―−b‘’‚‛c“”„‟d\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000e';
    const ascii = `a-------b''''c""""d${' '.repeat(13)}e`;
    assert.equal(update(`${unicode}\nold`, [` ${ascii}`, '-old', '+new “verbatim”']), `${unicode}\nnew “verbatim”`);
    assert.equal(update(`${ascii}\nold`, [` ${unicode}`, '-old', '+new']), `${ascii}\nnew`);
    assert.equal(update(unicode, [`-${ascii}`, '+replacement']), 'replacement');
  });

  test(`${engine}: exact, trimEnd, and trim matches take precedence over Unicode fallback`, () => {
    const candidates = ['key–', '  key-   ', 'key-  ', 'key-'];
    for (let length = candidates.length; length > 0; length -= 1) {
      const input = candidates.slice(0, length);
      assert.equal(update(input.join('\n'), ['-key-', '+chosen']), [...input.slice(0, -1), 'chosen'].join('\n'));
    }
  });

  test(`${engine}: Unicode anchors disambiguate repeated contexts`, () => {
    const input = ['section “first”', 'old', 'section “second”', 'old'].join('\n');
    assert.equal(update(input, ['@@ section "second"', '-old', '+new']),
      ['section “first”', 'old', 'section “second”', 'new'].join('\n'));
  });

  test(`${engine}: Unicode EOF matching preserves CRLF and final newline semantics`, () => {
    const input = 'heading\r\ntail “quoted”\r\n';
    assert.equal(update(input, ['-tail "quoted"', '+tail “new”', ' ', '*** End of File']),
      'heading\r\ntail “new”\r\n');
    assert.equal(update('heading\r\ntail “quoted”', ['-tail "quoted"', '+tail “new”', '*** End of File']),
      'heading\r\ntail “new”');
  });

  test(`${engine}: missing ASCII punctuation in a long C# interpolation fails with a local mismatch`, () => {
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

  test(`${engine}: omitted intervening method lines remain a mismatch rather than a patch match`, () => {
    const input = ['void Finish() {', '    Start();', '    Save();', '    Notify();', '    Stop();', '}'].join('\n');
    const message = failure(input, [' void Finish() {', '-    Start();', '+    Begin();', ' }']);
    assert.match(message, /file line 3 \(context line 3\)/);
    assert.ok(message.includes('Save();'));
    assert.ok(message.includes('"}"'));
  });

  test(`${engine}: unlocated and ambiguous failures show bounded previews and context sizes`, () => {
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
}
