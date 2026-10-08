import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../types';
import { formatMessagePreviewLine, formatSessionMessagesPreview, getMessagePreview } from './messagePreview';
import { formatLocalTimestamp } from './localTime';

function message(timestamp?: number): Message {
  return { role: 'user', parts: [{ text: 'unchanged body' }], __meta: { timestamp } };
}

test('command session previews share local date elision and restart for every page', () => {
  const first = new Date(2026, 9, 1, 8, 9, 10).getTime();
  const sameDay = new Date(2026, 9, 1, 9, 10, 11).getTime();
  const nextDay = new Date(2026, 9, 2, 1, 2, 3).getTime();
  const output = formatSessionMessagesPreview('example', [message(first), message(sameDay), message(nextDay), message(), message(nextDay)], 5, 10);
  assert.ok(output.includes(`[5 time ${formatLocalTimestamp(first)}]`));
  assert.ok(output.includes(`[6 time ${formatLocalTimestamp(sameDay).slice(11)}]`));
  assert.ok(output.includes(`[7 time ${formatLocalTimestamp(nextDay)}]`));
  assert.ok(output.includes('[8]'));
  assert.ok(output.includes(`[9 time ${formatLocalTimestamp(nextDay)}]`));
  assert.ok(formatMessagePreviewLine(message(sameDay), 6).includes(formatLocalTimestamp(sameDay)));
  assert.equal(getMessagePreview(message(first)), 'unchanged body', 'plain body formatting does not add time');
});

test('missing and invalid command timestamps are untimed and break date elision', () => {
  const time = new Date(2026, 9, 1, 8, 9, 10).getTime();
  for (const invalid of [undefined, NaN, Infinity, 9e20]) {
    const output = formatSessionMessagesPreview('example', [message(time), message(invalid), message(time)], 0, 3);
    assert.ok(output.includes('[1]'));
    assert.ok(output.includes(`[2 time ${formatLocalTimestamp(time)}]`));
  }
});
