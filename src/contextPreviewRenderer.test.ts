import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from './types';
import { formatLocalTimestamp } from './utils/localTime';
import { containsLoneSurrogate } from './utils/unicode';
import { createMessageContextPreviewItem, formatMessageHeading, renderContextPreviewItems, type ContextPreviewItem } from './contextPreviewRenderer';

function item(key: string, text: string): ContextPreviewItem {
  return { key, heading: `[${key}]`, body: text, searchText: text };
}

test('context preview renderer reports staged literal/include/exclude filter counts', () => {
  const result = renderContextPreviewItems({
    items: [
      item('kept', 'topic include safe'),
      item('literal', 'other include safe'),
      item('include', 'topic other safe'),
      item('exclude', 'topic include ban'),
    ],
    title: 'Filtered preview',
    emptyMessage: 'empty',
    options: {
      contentFilter: 'topic',
      includeRegex: 'include',
      excludeRegex: 'ban',
      previewLength: 1000,
    },
  });

  assert.equal(result.matchedCount, 1);
  assert.deepEqual(result.filterStats, {
    contentFilterExcludedCount: 1,
    includeRegexExcludedCount: 1,
    excludeRegexExcludedCount: 1,
  });
  assert.match(result.text, /contentFilter excluded 1 item\(s\)/);
  assert.match(result.text, /includeRegex excluded 1 additional item\(s\)/);
  assert.match(result.text, /excludeRegex excluded 1 additional item\(s\)/);
  assert.match(result.text, /topic include safe/);
});

test('contentFilter exclusion notice and omit hint survive an empty, truncated result', () => {
  const result = renderContextPreviewItems({
    items: [item('one', 'alpha'), item('two', 'beta')],
    title: 'CTX-BLOCK source messages',
    emptyMessage: 'No source messages matched.',
    options: {
      contentFilter: 'missing',
      contentFilterOmitHint: 'Omit contentFilter to inspect the complete target.',
      previewLength: 1,
    },
  });

  assert.equal(result.matchedCount, 0);
  assert.equal(result.filterStats.contentFilterExcludedCount, 2);
  assert.match(result.text, /previewLength 1 is below the minimum; using 1000/);
  assert.match(result.text, /contentFilter excluded 2 item\(s\)/);
  assert.match(result.text, /Omit contentFilter to inspect the complete target/);
  assert.match(result.text, /No source messages matched/);
});

test('context preview without filters emits no filter notice', () => {
  const result = renderContextPreviewItems({
    items: [item('one', 'alpha')],
    title: 'Unfiltered preview',
    emptyMessage: 'empty',
  });

  assert.deepEqual(result.filterStats, {
    contentFilterExcludedCount: 0,
    includeRegexExcludedCount: 0,
    excludeRegexExcludedCount: 0,
  });
  assert.doesNotMatch(result.text, /\[filter\]|\[hint\]/);
});

function timedItem(key: string, timestamp: unknown, body = key): ContextPreviewItem {
  const message: Message = { role: 'user', parts: [{ text: body }], __meta: { timestamp: timestamp as number } };
  return createMessageContextPreviewItem({ key, heading: formatMessageHeading({ label: `[${key}]`, message }), message });
}

function preview(items: ContextPreviewItem[], options = {}): string {
  return renderContextPreviewItems({ items, title: 'Messages', emptyMessage: 'empty', options }).text;
}

const morning = new Date(2026, 9, 1, 8, 9, 10).getTime();
const later = new Date(2026, 9, 1, 9, 10, 11).getTime();
const tomorrow = new Date(2026, 9, 2, 1, 2, 3).getTime();

function shortTime(timestamp: number): string {
  return formatLocalTimestamp(timestamp).slice(11);
}

test('message previews elide dates only after the preceding displayed valid message on the same local day', () => {
  const output = preview([
    timedItem('first', morning), timedItem('same', later), timedItem('next', tomorrow),
    timedItem('missing', undefined, '<foxwarm-system kind="time" time="2026-10-02 04:05:06 +0000" />'),
    timedItem('after-missing', tomorrow), timedItem('invalid', NaN), timedItem('after-invalid', tomorrow),
    timedItem('out-of-range', 9e20), timedItem('after-range', tomorrow), timedItem('string', String(tomorrow)),
  ]);
  assert.ok(output.includes(`[first time ${formatLocalTimestamp(morning)}]`));
  assert.ok(output.includes(`[same time ${shortTime(later)}]`));
  for (const key of ['next', 'after-missing', 'after-invalid', 'after-range']) {
    assert.ok(output.includes(`[${key} time ${formatLocalTimestamp(tomorrow)}]`));
  }
  for (const key of ['missing', 'invalid', 'out-of-range', 'string']) assert.ok(output.includes(`[${key}]`));
  assert.doesNotMatch(output, /NaN|Invalid Date/);
});

test('filtered pages start with a date and reused preview items do not retain time state', () => {
  const items = [timedItem('hidden', morning, 'omit'), timedItem('first', later, 'keep'), timedItem('second', later, 'keep')];
  for (const options of [{ contentFilter: 'keep' }, { includeRegex: 'keep' }, { excludeRegex: 'omit' }]) {
    const output = preview(items, options);
    assert.ok(output.includes(`[first time ${formatLocalTimestamp(later)}]`));
    assert.ok(output.includes(`[second time ${shortTime(later)}]`));
    assert.doesNotMatch(output, /\[hidden/);
  }
  assert.ok(preview(items.slice(2)).includes(`[second time ${formatLocalTimestamp(later)}]`));
});

test('vector-style grouped messages elide dates after clipping and leave identical body headings untouched', () => {
  const children = [timedItem('clipped', morning, 'filler '.repeat(250)), timedItem('visible', later, 'needle'), timedItem('tail', later, 'end')];
  const body = children.map(item => `${item.heading}\n${item.body}`).join('\n\n');
  const group: ContextPreviewItem = { key: 'group', heading: '[vector source]', body, searchText: body, messageItems: children };
  const output = preview([group], { contentFilter: 'needle', previewLength: 1000 });
  assert.doesNotMatch(output, /\[clipped/);
  assert.ok(output.includes(`[visible time ${formatLocalTimestamp(later)}]`));
  assert.ok(output.includes(`[tail time ${shortTime(later)}]`));
  assert.ok(output.length <= 1000);

  const fakeHeading = `[copy time ${formatLocalTimestamp(later)}] 👤 user:`;
  const untouched = preview([timedItem('first', morning), timedItem('second', later, fakeHeading)]);
  assert.ok(untouched.includes(fakeHeading), 'body text that looks like a heading is not timestamp metadata');
});

test('timestamp headings preserve folded tools, visibility and Unicode under tight budgets', () => {
  const message: Message = { role: 'model', modelVisible: false, __meta: { timestamp: morning }, parts: [
    { text: '😀e\u0301'.repeat(100) },
    { functionCall: { name: 'lookup', id: 'a', args: { key: 'tool-needle' } } },
  ] };
  const item = createMessageContextPreviewItem({ key: 'tools', heading: formatMessageHeading({ label: '[7]', message }), message });
  const output = preview([item], { previewLength: 1000, contentFilter: 'tool-needle' });
  assert.ok(output.includes(`[7 time ${formatLocalTimestamp(morning)}]`));
  assert.match(output, /model \[non-context\]:/);
  assert.match(output, /lookup|Matched in omitted tool/);
  assert.equal(containsLoneSurrogate(output), false);
  assert.ok(output.length <= 1000);
  const unicode = preview([timedItem('unicode', morning, '😀e\u0301'.repeat(1500))], { previewLength: 1000 });
  assert.equal(containsLoneSurrogate(unicode), false);
  assert.ok(unicode.length <= 1000);
});
