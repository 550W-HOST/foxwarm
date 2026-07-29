import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateOutputForDisplay } from './outputTruncation';

test('truncateOutputForDisplay leaves non-overflowing output unchanged', () => {
  const input = 'short line\nsecond line';
  const result = truncateOutputForDisplay(input, { maxChars: 1000 });
  assert.equal(result.text, input);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.placeholderKinds, []);
  assert.deepEqual(result.footerNotes, []);
});

test('truncateOutputForDisplay shortens overlong lines only when overall output overflows', () => {
  const longLine = `prefix-${'x'.repeat(700)}-suffix`;
  const result = truncateOutputForDisplay(`alpha\n${longLine}\nomega`, { maxChars: 900, force: true });
  assert.equal(result.truncated, true);
  assert.equal(result.lineTruncatedCount, 1);
  assert.match(result.text, /alpha/);
  assert.match(result.text, /omega/);
  assert.match(result.text, /\.\.\.\[foxwarm: line too long \(714 chars at line 2\)\]\.\.\./);
  assert.doesNotMatch(result.text, /--- \[foxwarm: line too long/);
  assert.ok(result.text.length < longLine.length + 20);
  assert.match(result.footerNotes.join('\n'), /line-too-long placeholders/);
  assert.doesNotMatch(result.footerNotes.join('\n'), /^Omitted \d+ line/m);
  assert.match(result.footerNotes.join('\n'), /Original output: 3 line\(s\), 726 character\(s\)/);
});

test('truncateOutputForDisplay omits whole middle lines instead of splitting lines', () => {
  const input = Array.from({ length: 20 }, (_, index) => `line-${index + 1}-${'x'.repeat(20)}`).join('\n');
  const result = truncateOutputForDisplay(input, { maxChars: 220, force: true });
  assert.equal(result.truncated, true);
  assert.ok(result.omittedLineCount > 0);
  assert.match(result.text, /line-1-/);
  assert.match(result.text, /line-20-/);
  const omission = result.text.match(/^--- \[foxwarm: (\d+) lines \(line range (\d+)-(\d+)\) omitted because (.+)\] ---$/m);
  assert.ok(omission);
  assert.equal(Number(omission[1]), result.omittedLineCount);
  assert.deepEqual(result.omittedLineRange, { begin: Number(omission[2]), end: Number(omission[3]) });
  assert.equal(result.omittedLineReason, omission[4]);
  assert.ok(result.text.length <= 220, 'decorated omission marker must count toward the max-character budget');
  assert.doesNotMatch(result.text, /\.\.\.TRUNCATED/);
  assert.match(result.footerNotes.join('\n'), /line-range omission placeholders/);
  assert.ok(result.footerNotes.includes(`Omitted ${omission[1]} line(s) from original line range ${omission[2]}-${omission[3]} because ${omission[4]}.`));
});

test('truncateOutputForDisplay handles unicode and CRLF boundaries', () => {
  const input = `😀${'界'.repeat(700)}\r\nlast`;
  const result = truncateOutputForDisplay(input, { maxChars: 700, force: true });
  assert.equal(result.truncated, true);
  assert.equal(result.originalLineCount, 2);
  assert.equal(result.lineTruncatedCount, 1);
  assert.match(result.text, /^😀界/);
  assert.match(result.text, /last$/);
  assert.doesNotMatch(result.text, /\ud800|\udc00/);
});
