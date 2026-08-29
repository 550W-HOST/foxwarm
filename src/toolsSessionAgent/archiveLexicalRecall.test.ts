import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStrongArchiveLocators, fuseDenseAndLexicalHits } from './archiveLexicalRecall';

test('strong Archive locator extraction is deterministic, bounded, and rejects generic prose', () => {
  assert.deepEqual(extractStrongArchiveLocators('find commit c34dbbad05c12be4e445b2f57f8ca0a44d81ec79').map(item => item.value), [
    'c34dbbad05c12be4e445b2f57f8ca0a44d81ec79',
  ]);
  assert.ok(extractStrongArchiveLocators('inspect agent/session-42 and src/tools/foo_bar.ts').some(item => item.value === 'agent/session-42'));
  assert.ok(extractStrongArchiveLocators('inspect agent/session-42 and src/tools/foo_bar.ts').some(item => item.value === 'src/tools/foo_bar.ts'));
  assert.ok(extractStrongArchiveLocators('inspect isolated-docker:node-42').some(item => item.value === 'isolated-docker:node-42'));
  assert.ok(extractStrongArchiveLocators('run /compact tools').some(item => item.value === '/compact tools'));
  assert.ok(extractStrongArchiveLocators('find AlphaNode_42 and threshold 16384').some(item => item.value === 'AlphaNode_42'));
  assert.ok(extractStrongArchiveLocators('find AlphaNode_42 and threshold 16384').some(item => item.value === '16384'));
  assert.deepEqual(extractStrongArchiveLocators('please show the current session details and search messages'), []);
  assert.deepEqual(extractStrongArchiveLocators('abc 123 x_y'), []);
  for (const proseToken of ['current-session', 'source-backed', 'recent-window', 'error-handling', 'phase-2', 'context-compaction-and-recall']) {
    assert.deepEqual(extractStrongArchiveLocators(proseToken), [], proseToken);
  }
  assert.ok(extractStrongArchiveLocators('render-vm').some(item => item.value === 'render-vm'));
  assert.ok(extractStrongArchiveLocators('Node ID: current-session').some(item => item.value === 'current-session'));
  assert.ok(extractStrongArchiveLocators('use `recent-window` exactly').some(item => item.value === 'recent-window'));

  const bounded = extractStrongArchiveLocators('AlphaNode_42 BetaNode_43 GammaNode_44 DeltaNode_45 EpsilonNode_46');
  assert.equal(bounded.length, 4);
  assert.ok(bounded.every(item => item.value.length <= 160));
});

test('source-family fusion rescues lexical misses, boosts shared sources, and preserves dense-only order', () => {
  const dense = [
    { id: 'dense-a', source_family: 's:raw:1-1' },
    { id: 'dense-b', source_family: 's:raw:2-2' },
  ];
  assert.deepEqual(fuseDenseAndLexicalHits(dense, [], 5), dense);
  assert.equal(fuseDenseAndLexicalHits(dense, [], 1)[0].id, 'dense-a', 'ambiguous prose with no locator cannot outrank dense rank 1');

  const lexical: any[] = [
    { id: 'lex-c', source_family: 's:block:3', lexical_score: 500, lexical_locators: ['AlphaNode_42'] },
    { id: 'lex-a', source_family: 's:raw:1-1', lexical_score: 400, lexical_locators: ['AlphaNode_42'] },
    { id: 'lex-c-duplicate', source_family: 's:block:3', lexical_score: 300, lexical_locators: ['AlphaNode_42'] },
  ];
  const fused = fuseDenseAndLexicalHits(dense, lexical, 5);
  assert.equal(fused[0].source_family, 's:raw:1-1', 'a source present in both receives the bounded shared boost');
  assert.ok(fused.some(hit => hit.source_family === 's:block:3'), 'a dense miss is rescued by the lexical side-channel');
  assert.equal(fused.filter(hit => hit.source_family === 's:block:3').length, 1);
  assert.equal(fuseDenseAndLexicalHits([], lexical, 1)[0].source_family, 's:block:3');

  const overlapping = fuseDenseAndLexicalHits([
    { id: 'dense-range', kind: 'raw', session_id: 's', source_family: 's:raw:1-5', raw_start_seq: 1, raw_end_seq: 5 },
  ], [{
    id: 'lex-inside', kind: 'raw', session_id: 's', source_family: 's:raw:3-3', raw_start_seq: 3, raw_end_seq: 3,
    lexical_score: 500, lexical_locators: ['AlphaNode_42'],
  } as any], 5);
  assert.equal(overlapping.length, 1, 'a lexical message inside a dense raw family collapses into that source');
  assert.equal(overlapping[0].source_family, 's:raw:1-5');
});
