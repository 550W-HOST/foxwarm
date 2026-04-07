import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEmbeddingInput } from './vector';

test('sanitizeEmbeddingInput preserves normal text', () => {
  const input = 'hello 🦊 world';
  assert.equal(sanitizeEmbeddingInput(input), input);
});

test('sanitizeEmbeddingInput preserves valid surrogate pairs', () => {
  const input = 'emoji 😀 ok';
  assert.equal(sanitizeEmbeddingInput(input), input);
});

test('sanitizeEmbeddingInput replaces lone high surrogates', () => {
  const input = `bad ${String.fromCharCode(0xD83D)} text`;
  assert.equal(sanitizeEmbeddingInput(input), 'bad � text');
});

test('sanitizeEmbeddingInput replaces lone low surrogates', () => {
  const input = `bad ${String.fromCharCode(0xDE00)} text`;
  assert.equal(sanitizeEmbeddingInput(input), 'bad � text');
});

test('sanitizeEmbeddingInput repairs mixed malformed surrogate spans', () => {
  const input = `${String.fromCharCode(0xD83D)}A${String.fromCharCode(0xDE00)}B😀C`;
  assert.equal(sanitizeEmbeddingInput(input), '�A�B😀C');
});
