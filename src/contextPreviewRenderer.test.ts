import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContextPreviewItems, type ContextPreviewItem } from './contextPreviewRenderer';

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
