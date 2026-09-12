import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrentModelSnapshot,
  filterConditionalMemorySource,
  readCurrentModelSnapshotId,
} from './conditionalMemory';

test('conditional memory keeps matching bodies and removes nonmatching pairs', () => {
  const source = [
    'before',
    '<foxwarm-if model-id="provider/astra">',
    'exact',
    '</foxwarm-if>',
    '<foxwarm-if model-id="*-astra">',
    'wildcard',
    '</foxwarm-if>',
    '<foxwarm-if model-id="other/*">',
    'removed',
    '</foxwarm-if>',
    'after',
  ].join('\n');

  assert.equal(
    filterConditionalMemorySource(source, 'provider/astra'),
    ['before', 'exact', 'after'].join('\n'),
  );
  assert.equal(
    filterConditionalMemorySource(source, 'local-astra'),
    ['before', 'wildcard', 'after'].join('\n'),
  );
});

test('literal star is the only wildcard and matching is whole-value case-sensitive', () => {
  const source = '<foxwarm-if model-id="A?/*-astra">\nbody\n</foxwarm-if>\n';
  assert.equal(filterConditionalMemorySource(source, 'A?/x/y-astra'), 'body\n');
  assert.equal(filterConditionalMemorySource(source, 'a?/x/y-astra'), '');
  assert.equal(filterConditionalMemorySource(source, 'prefix-A?/x/y-astra'), '');
});

test('wrapper lines allow horizontal whitespace while inline examples remain literal', () => {
  const source = [
    'Inline <foxwarm-if model-id="leaf"> example.',
    '\t <foxwarm-if model-id="leaf"> \t',
    'kept',
    '  </foxwarm-if>\t',
    'Tail.',
  ].join('\n');

  assert.equal(
    filterConditionalMemorySource(source, 'leaf'),
    ['Inline <foxwarm-if model-id="leaf"> example.', 'kept', 'Tail.'].join('\n'),
  );
});

test('tag-first prose does not block a later standalone condition', () => {
  const source = [
    '<foxwarm-if model-id="leaf"> is an opening example',
    '</foxwarm-if> is a closing example',
    '<foxwarm-if model-id="other">',
    'removed',
    '</foxwarm-if>',
    'tail',
  ].join('\n');

  assert.equal(
    filterConditionalMemorySource(source, 'leaf'),
    [
      '<foxwarm-if model-id="leaf"> is an opening example',
      '</foxwarm-if> is a closing example',
      'tail',
    ].join('\n'),
  );
});

test('tag-first prose inside a valid block does not affect its pairing', () => {
  const source = [
    '<foxwarm-if model-id="leaf">',
    '<foxwarm-if model-id="other"> is an opening example',
    '</foxwarm-if> is a closing example',
    'kept',
    '</foxwarm-if>',
  ].join('\n');

  assert.equal(
    filterConditionalMemorySource(source, 'leaf'),
    [
      '<foxwarm-if model-id="other"> is an opening example',
      '</foxwarm-if> is a closing example',
      'kept',
    ].join('\n') + '\n',
  );
  assert.equal(filterConditionalMemorySource(source, 'other'), '');
});

test('multiple and empty conditional pairs preserve surrounding line structure', () => {
  const source = 'a\n<foxwarm-if model-id="x">\n</foxwarm-if>\n<foxwarm-if model-id="x">\nb\n</foxwarm-if>\nc\n';
  assert.equal(filterConditionalMemorySource(source, 'x'), 'a\nb\nc\n');
  assert.equal(filterConditionalMemorySource(source, 'y'), 'a\nc\n');
});

test('fenced Markdown examples are literal and do not close an outer condition', () => {
  const source = [
    '```xml',
    '<foxwarm-if model-id="other">',
    'fenced',
    '</foxwarm-if>',
    '```',
    '<foxwarm-if model-id="leaf">',
    '~~~text',
    '</foxwarm-if>',
    '~~~',
    'kept',
    '</foxwarm-if>',
  ].join('\n');

  assert.equal(
    filterConditionalMemorySource(source, 'leaf'),
    [
      '```xml',
      '<foxwarm-if model-id="other">',
      'fenced',
      '</foxwarm-if>',
      '```',
      '~~~text',
      '</foxwarm-if>',
      '~~~',
      'kept',
    ].join('\n') + '\n',
  );
});

test('malformed, unsupported, orphan, unclosed, and nested markup stays literal', () => {
  const cases = [
    '</foxwarm-if>\ntext',
    '<foxwarm-if model-id=\'leaf\'>\ntext\n</foxwarm-if>',
    '<foxwarm-if model-id="leaf" extra="x">\ntext\n</foxwarm-if>',
    '<foxwarm-if model-id="leaf">\ntext',
    [
      '<foxwarm-if model-id="leaf">',
      'outer',
      '<foxwarm-if model-id="leaf">',
      'inner',
      '</foxwarm-if>',
      '</foxwarm-if>',
    ].join('\n'),
  ];

  for (const source of cases) {
    assert.equal(filterConditionalMemorySource(source, 'leaf'), source);
  }
});

test('unclosed outer markup prevents partial filtering of later supported openers', () => {
  const source = [
    '<foxwarm-if model-id="leaf">',
    'outer',
    '<foxwarm-if model-id="leaf">',
    'inner',
    '</foxwarm-if>',
    'tail',
  ].join('\n');
  assert.equal(filterConditionalMemorySource(source, 'leaf'), source);
});

test('unsupported outer or nested condition-like markup prevents partial evaluation', () => {
  const unsupportedOuter = [
    '<foxwarm-if model-id=\'leaf\'>',
    '<foxwarm-if model-id="leaf">',
    'inner',
    '</foxwarm-if>',
    '</foxwarm-if>',
  ].join('\n');
  const unsupportedNested = [
    '<foxwarm-if model-id="leaf">',
    '<foxwarm-if model-id=\'leaf\'>',
    'inner',
    '</foxwarm-if>',
    '</foxwarm-if>',
  ].join('\n');

  assert.equal(filterConditionalMemorySource(unsupportedOuter, 'leaf'), unsupportedOuter);
  assert.equal(filterConditionalMemorySource(unsupportedNested, 'leaf'), unsupportedNested);
});

test('conditional filtering preserves LF and CRLF body bytes and trailing newline state', () => {
  const lf = 'head\n<foxwarm-if model-id="leaf">\none\ntwo\n</foxwarm-if>\ntail\n';
  const crlf = 'head\r\n<foxwarm-if model-id="leaf">\r\none\r\ntwo\r\n</foxwarm-if>\r\ntail\r\n';
  const noTrailing = '<foxwarm-if model-id="leaf">\r\nbody\r\n</foxwarm-if>';

  assert.equal(filterConditionalMemorySource(lf, 'leaf'), 'head\none\ntwo\ntail\n');
  assert.equal(filterConditionalMemorySource(crlf, 'leaf'), 'head\r\none\r\ntwo\r\ntail\r\n');
  assert.equal(filterConditionalMemorySource(noTrailing, 'leaf'), 'body\r\n');
  assert.equal(filterConditionalMemorySource(noTrailing, 'other'), '');
});

test('conditional model patterns decode Foxwarm attribute entities', () => {
  const source = '<foxwarm-if model-id="provider/a&amp;b/*">\nbody\n</foxwarm-if>';
  assert.equal(filterConditionalMemorySource(source, 'provider/a&b/model'), 'body\n');
});

test('current-model snapshot header escapes and round-trips the concrete identity', () => {
  const modelId = 'provider/a&<"\'model';
  const body = 'line 1\r\nline 2\r\n';
  const snapshot = buildCurrentModelSnapshot(modelId, body);

  assert.equal(
    snapshot,
    '<foxwarm-current-model model-id="provider/a&amp;&lt;&quot;&apos;model" />\n\nline 1\r\nline 2\r\n',
  );
  assert.equal(readCurrentModelSnapshotId(snapshot), modelId);
});

test('current-model reader accepts only the exact generated first-line header', () => {
  const bodyTag = 'intro\n<foxwarm-current-model model-id="provider/astra" />\n\nbody';
  assert.equal(readCurrentModelSnapshotId(bodyTag), undefined);
  assert.equal(readCurrentModelSnapshotId('<foxwarm-current-model model-id="provider/astra" />'), undefined);
  assert.equal(readCurrentModelSnapshotId(' <foxwarm-current-model model-id="provider/astra" />\n\nbody'), undefined);
  assert.equal(readCurrentModelSnapshotId('<foxwarm-current-model model-id="provider/astra"/>\n\nbody'), undefined);
  assert.equal(readCurrentModelSnapshotId('<foxwarm-current-model model-id="provider/&bogus;" />\n\nbody'), undefined);
  assert.equal(readCurrentModelSnapshotId('<foxwarm-current-model model-id="provider/astra" />\r\n\r\nbody'), undefined);
});

test('current-model builder uses a stable separator without normalizing body bytes', () => {
  assert.equal(
    buildCurrentModelSnapshot('provider/astra', ''),
    '<foxwarm-current-model model-id="provider/astra" />\n\n',
  );
  assert.equal(
    buildCurrentModelSnapshot('provider/astra', '\r\nbody'),
    '<foxwarm-current-model model-id="provider/astra" />\n\n\r\nbody',
  );
});
