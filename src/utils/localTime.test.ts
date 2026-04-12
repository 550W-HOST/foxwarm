import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalTimeRange, formatLocalTimestamp } from './localTime';

function expectedOffset(date: Date): string {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutes);
  return `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')}${String(absoluteMinutes % 60).padStart(2, '0')}`;
}

test('formatLocalTimestamp uses local time with numeric offset and no hard-coded timezone name', () => {
  const date = new Date(1_700_000_000_000);
  const text = formatLocalTimestamp(date);

  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
  assert.match(text, new RegExp(`${expectedOffset(date).replace('+', '\\+')}$`));
  assert.doesNotMatch(text, /Asia\/Shanghai/);
});

test('formatLocalTimeRange collapses identical timestamps and formats differing ranges', () => {
  const start = new Date(1_700_000_000_000);
  const end = new Date(1_700_000_060_000);

  assert.equal(formatLocalTimeRange(start, start), formatLocalTimestamp(start));
  assert.equal(formatLocalTimeRange(start, end), `${formatLocalTimestamp(start)} -> ${formatLocalTimestamp(end)}`);
});