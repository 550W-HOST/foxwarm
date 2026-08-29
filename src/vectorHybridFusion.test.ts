import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseDenseAndLexicalHits } from './vectorHybridFusion';

function dense(family: string, start: number) {
  return { id: `d:${family}`, kind: 'raw', session_id: 's', source_family: family, raw_start_seq: start, raw_end_seq: start + 4 };
}

test('hybrid fusion preserves dense-only bytes and gives identifier/prose lanes bounded influence', () => {
  const denseHits = [dense('dense-best', 1), dense('dense-second', 10), dense('dense-third', 20)];
  assert.deepEqual(fuseDenseAndLexicalHits(denseHits, [], 3), denseHits);
  const prose = fuseDenseAndLexicalHits(denseHits, [{
    id: 'p', kind: 'raw', session_id: 's', agent: 'main', source_family: 'prose-only', lexical_lane: 'prose', raw_start_seq: 40,
  }], 4);
  assert.equal(prose[0].source_family, 'dense-best', 'generic prose cannot displace the clearest semantic source');
  const identifier = fuseDenseAndLexicalHits(denseHits, [{
    id: 'i', kind: 'raw', session_id: 's', agent: 'main', source_family: 'identifier-only', lexical_lane: 'identifier', raw_start_seq: 50,
  }], 4);
  assert.equal(identifier[0].source_family, 'identifier-only', 'high-confidence identifier can rescue a dense miss');
});

test('hybrid fusion collapses shared families and raw hits contained by dense ranges', () => {
  const denseHits = [dense('range-family', 10), dense('other', 30)];
  const result = fuseDenseAndLexicalHits(denseHits, [
    { id: 'contained', kind: 'raw', session_id: 's', agent: 'main', source_family: 'raw-single', lexical_lane: 'identifier', raw_start_seq: 12 },
    { id: 'duplicate', kind: 'raw', session_id: 's', agent: 'main', source_family: 'range-family', lexical_lane: 'prose', raw_start_seq: 10 },
  ], 5);
  assert.equal(result.filter(hit => hit.source_family === 'range-family').length, 1);
  assert.equal(result.some(hit => hit.source_family === 'raw-single'), false);
});
